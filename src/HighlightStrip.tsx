import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CaretLeft, CaretRight, FilmStrip, Play } from "@phosphor-icons/react";
import { convertFileSrc, invoke } from "./tauri-shim";
import type { MatchClip } from "./MatchView";
import { matchesHighlightSearch } from "./clip-presentation";

const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** A sequence of highlights, rather than a compressed map of match time. */
export function HighlightStrip({ clips, activeIndex, nowAt, markers, timeLabel, onChoose, search, multikillsOnly, onSearchChange, onMultikillsOnlyChange }: {
  clips: { c: MatchClip; i: number }[];
  activeIndex: number;
  nowAt: number;
  markers: Record<string, number[]>;
  timeLabel: (ms: number) => string;
  onChoose: (index: number, seconds?: number) => void;
  search: string;
  multikillsOnly: boolean;
  onSearchChange: (value: string) => void;
  onMultikillsOnlyChange: (value: boolean) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(208);
  const [reels, setReels] = useState<Record<string, string>>({});
  const visible = clips.filter(({ c }) => matchesHighlightSearch(c.clip.name, c.title, (c.markerTimes ?? markers[c.clip.path])?.length ?? 0, search, multikillsOnly, timeLabel(c.start)));
  const filtering = search.trim().length > 0 || multikillsOnly;
  const visiblePaths = JSON.stringify(visible.map(({ c }) => c.id ?? c.clip.path));
  const missingThumbs = JSON.stringify([...new Set(clips.filter(({ c }) => !c.thumb).map(({ c }) => c.clip.path))]);
  useEffect(() => {
    let cancelled = false;
    for (const path of JSON.parse(missingThumbs) as string[]) {
      invoke<string>("gen_filmstrip", { input: path }).then((reel) => {
        if (!cancelled) setReels((all) => ({ ...all, [path]: reel }));
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [missingThumbs]);
  useEffect(() => {
    const el = strip.current;
    const current = el?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!el || !current) return;
    const left = current.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
    if (left < el.scrollLeft || left + current.offsetWidth > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = Math.max(0, left - (el.clientWidth - current.offsetWidth) / 2);
    }
  }, [activeIndex, size, visiblePaths]);
  const move = (direction: number) => {
    const el = strip.current;
    if (el) el.scrollBy({ left: direction * Math.max(size + 12, el.clientWidth * 0.8) });
  };
  const position = visible.findIndex(({ i }) => i === activeIndex);
  return (
    <section className="mv-highlights" aria-label="Highlights">
      <div className="mv-highlights-head">
        <h2>Highlights <span role="status">{filtering ? `${visible.length} of ${clips.length}` : position >= 0 ? `${position + 1} / ${clips.length}` : clips.length}</span></h2>
        <div className="mv-highlight-filters">
          <input type="search" aria-label="Search match highlights" placeholder="Find a highlight…" value={search} onChange={(e) => onSearchChange(e.target.value)} />
          <button type="button" aria-pressed={multikillsOnly} onClick={() => onMultikillsOnlyChange(!multikillsOnly)}>Multikills only</button>
        </div>
        <div className="mv-highlights-tools">
          <label>Thumbnail size <input aria-label="Thumbnail size" type="range" min={160} max={280} step={24} value={size} onChange={(e) => setSize(Number(e.target.value))} /></label>
          <button type="button" className="tx-btn" aria-label="Scroll highlights left" onClick={() => move(-1)}><CaretLeft size={15} /></button>
          <button type="button" className="tx-btn" aria-label="Scroll highlights right" onClick={() => move(1)}><CaretRight size={15} /></button>
        </div>
      </div>
      <div className="mv-highlight-strip" ref={strip} style={{ "--mv-thumb": `${size}px` } as CSSProperties}>
        {visible.map(({ c, i }) => {
          const ordinal = clips.findIndex((entry) => entry.i === i);
          const selected = activeIndex === i;
          const seconds = Math.max(0.1, (c.end - c.start) / 1000);
          const progress = Math.max(0, Math.min(100, (nowAt - c.start) / (seconds * 1000) * 100));
          const times = (c.markerTimes ?? markers[c.clip.path] ?? []).filter((t) => t >= 0 && t <= seconds);
          const reel = reels[c.clip.path];
          const frameCount = Number(reel?.match(/\.reel(\d+)\.jpg/)?.[1] ?? 10);
          const title = c.full ? "Full match" : c.title.split(" · ").slice(1).join(" · ") || c.title;
          return (
            <article className={`mv-highlight ${selected ? "active" : ""}`} key={c.id ?? c.clip.path} style={{ width: size }}>
              <button type="button" className="mv-highlight-select" aria-label={`Play ${c.full ? "full match" : `highlight ${ordinal + 1}`}: ${title}`} aria-current={selected ? "true" : undefined} onClick={() => onChoose(i)}>
                <span className="mv-highlight-image">
                  {c.thumb ? <img src={convertFileSrc(c.thumb)} alt="" draggable={false} /> : reel ? <span className="mv-highlight-reel" style={{ backgroundImage: `url("${convertFileSrc(reel)}")`, backgroundSize: `${frameCount * 100}% 100%`, backgroundPositionX: `${Math.min(frameCount - 1, Math.floor((c.posterAt ?? 0) * frameCount)) / Math.max(1, frameCount - 1) * 100}%` }} /> : <FilmStrip size={26} className="mv-highlight-placeholder" />}
                  <span className="mv-highlight-play"><Play size={20} weight="fill" /></span>
                  <span className="mv-highlight-duration">{duration(seconds)}</span>
                  {selected && <span className="mv-highlight-progress" style={{ width: `${progress}%` }} />}
                </span>
                <span className="mv-highlight-caption"><strong>{title}</strong><small>{timeLabel(c.start)}</small></span>
              </button>
              <div className="mv-highlight-events" aria-label={`Kill moments in ${title}`}>
                {times.map((t, n) => <button type="button" key={`${t}-${n}`} style={{ left: `${Math.max(3, Math.min(97, t / seconds * 100))}%` }} aria-label={`Play from kill ${n + 1} at ${duration(t)}`} title={`Kill at ${duration(t)}`} onClick={() => onChoose(i, Math.max(0, t - 2))} />)}
              </div>
            </article>
          );
        })}
      </div>
      {visible.length === 0 && <div className="mv-highlight-empty"><span>No highlights match these filters.</span><button type="button" onClick={() => { onSearchChange(""); onMultikillsOnlyChange(false); }}>Clear filters</button></div>}
    </section>
  );
}
