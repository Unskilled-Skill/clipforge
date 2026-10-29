import { useEffect, useRef, useState } from "react";
import { CaretLeft, CaretRight, Crosshair, FilmStrip, Handshake, Minus, Plus, Skull } from "@phosphor-icons/react";
import type { MatchClip } from "./MatchView";
import { adjacentKill, clockTicks, clusterKills, zoomWindow, type KillEvent } from "./kill-overview";
import { convertFileSrc, invoke } from "./tauri-shim";

const time = (ms: number) => (ms = Math.max(0, ms), `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`);
const reels = new Map<string, Promise<{ path: string; frames: number }>>();

function PreviewFrame({ clip, at }: { clip: MatchClip; at: number }) {
  const [reel, setReel] = useState<{ path: string; frames: number } | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setReel(null); setBroken(false);
    if (clip.thumb) return;
    let alive = true;
    let request = reels.get(clip.clip.path);
    if (!request) {
      request = invoke<string>("gen_filmstrip", { input: clip.clip.path }).then(path => ({ path, frames: Number(path.match(/\.reel(\d+)\.jpg/)?.[1] ?? 10) }));
      reels.set(clip.clip.path, request);
    }
    request.then(value => { if (alive) setReel(value); }).catch(() => { reels.delete(clip.clip.path); });
    return () => { alive = false; };
  }, [clip.clip.path, clip.thumb]);
  if (clip.thumb && !broken) return <img src={convertFileSrc(clip.thumb)} alt="" onError={() => setBroken(true)} />;
  if (reel) {
    const fraction = Math.max(0, Math.min(1, (at - clip.start) / Math.max(1, clip.end - clip.start)));
    const frame = Math.min(reel.frames - 1, Math.floor(fraction * reel.frames));
    return <span className="ko-preview-frame" style={{ backgroundImage: `url("${convertFileSrc(reel.path)}")`, backgroundSize: `${reel.frames * 100}% 100%`, backgroundPositionX: `${frame / Math.max(1, reel.frames - 1) * 100}%` }} />;
  }
  return <span className="ko-preview-empty"><FilmStrip size={24} /></span>;
}

export function KillOverview({ clips, events, allCount, start, end, zero = start, moments = [], nowAt, activeIndex, visibleIndices, rounds, onChoose, onSeek }: {
  clips: MatchClip[]; events: KillEvent[]; allCount: number; start: number; end: number;
  /** When the game's clock read 0:00; times and ticks count from here. */
  zero?: number;
  /** Our deaths and assists, where the game reports them (League). */
  moments?: { at: number; kind: "death" | "assist" }[];
  nowAt: number; activeIndex: number;
  visibleIndices: Set<number>; rounds: { start: number; end: number; number: number }[];
  onChoose: (event: KillEvent) => void; onSeek: (at: number) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const chooser = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [width, setWidth] = useState(1);
  const [view, setView] = useState({ start, end });
  const [selected, setSelected] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [opened, setOpened] = useState<number | null>(null);
  const groups = clusterKills(events, view.start, view.end, width);
  const preview = groups.find(g => g.events[0].number === hovered);
  const openGroup = groups.find(g => g.events[0].number === opened);
  const previous = adjacentKill(events, nowAt, -1, selected);
  const next = adjacentKill(events, nowAt, 1, selected);
  const length = view.end - view.start;
  const zoomed = length < end - start - 1;
  const pct = (at: number) => (at - view.start) / Math.max(1, length) * 100;
  const ticks = clockTicks(view.start, view.end, zero, width);
  const deaths = moments.filter(m => m.kind === "death").length;
  const assists = moments.length - deaths;

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el); setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setView(current => nowAt < current.start || nowAt > current.end
      ? zoomWindow(start, end, current.start, current.end, nowAt, 1) : current);
    // Follow explicit clip changes; continuous playback should not undo manual panning.
  }, [activeIndex, start, end]);
  useEffect(() => {
    if (opened != null) chooser.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [opened]);
  useEffect(() => {
    if (opened == null) return;
    const dismiss = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpened(null); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [opened]);

  function choose(event: KillEvent) {
    setSelected(event.number); setOpened(null); setHovered(null);
    if (event.at < view.start || event.at > view.end) setView(zoomWindow(start, end, view.start, view.end, event.at, 1));
    onChoose(event);
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : document.body;
      if (!e.altKey || !["ArrowLeft", "ArrowRight"].includes(e.key) || target.closest("input, textarea, select, [contenteditable=true]") || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      const event = adjacentKill(events, nowAt, e.key === "ArrowRight" ? 1 : -1, selected);
      if (event) choose(event);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  function zoom(factor: number, anchor = nowAt >= view.start && nowAt <= view.end ? nowAt : (view.start + view.end) / 2) {
    setOpened(null); setHovered(null); setView(zoomWindow(start, end, view.start, view.end, anchor, factor));
  }
  function pan(direction: number) {
    setOpened(null); setHovered(null);
    setView(zoomWindow(start, end, view.start, view.end, (view.start + view.end) / 2 + direction * length * 0.75, 1));
  }
  const previewClip = (event: KillEvent) => clips[event.highlightIndex ?? event.i];
  const roundFor = (at: number) => rounds.find(r => at >= r.start && at < r.end);
  let lastRoundLabel = -Infinity;

  return <section className="ko" ref={root} aria-label="Match kill overview" onBlur={e => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpened(null);
  }} onKeyDown={e => {
    if (e.key === "Escape" && opened != null) { e.preventDefault(); e.stopPropagation(); setOpened(null); trigger.current?.focus(); }
  }}>
    <div className="ko-toolbar">
      <span className="ko-label"><Crosshair size={13} /> Kills <small>{events.length === allCount ? allCount : `${events.length} of ${allCount}`}</small></span>
      <div className="ko-kill-nav">
        <button type="button" disabled={!previous} onClick={() => previous && choose(previous)} title="Previous kill (Alt+Left)" aria-label="Previous kill"><CaretLeft size={13} /> Previous</button>
        <button type="button" disabled={!next} onClick={() => next && choose(next)} title="Next kill (Alt+Right)" aria-label="Next kill">Next <CaretRight size={13} /></button>
      </div>
      {moments.length > 0 && <span className="ko-legend"><span className="death"><Skull size={12} weight="bold" /> Deaths <small>{deaths}</small></span><span className="assist"><Handshake size={12} weight="bold" /> Assists <small>{assists}</small></span></span>}
      <small className="ko-hint">{allCount === 0 ? "No kill markers recorded" : events.length === 0 ? "No kills match the filters" : "Click a kill to jump · shaded ranges are saved highlights"}</small>
      <div className="ko-zoom">
        {zoomed && <><button type="button" onClick={() => pan(-1)} disabled={view.start <= start} aria-label="Earlier in match"><CaretLeft size={13} /></button><button type="button" onClick={() => pan(1)} disabled={view.end >= end} aria-label="Later in match"><CaretRight size={13} /></button></>}
        <button type="button" disabled={!zoomed} onClick={() => zoom(0.5)} aria-label="Zoom out timeline"><Minus size={13} /></button>
        <button type="button" disabled={length <= Math.min(30_000, end - start)} onClick={() => zoom(2)} aria-label="Zoom in timeline"><Plus size={13} /></button>
        <button type="button" disabled={!zoomed} onClick={() => { setView({ start, end }); setOpened(null); setHovered(null); }}>Fit match</button>
      </div>
    </div>
    <div className="ko-track" ref={track}>
      {rounds.filter(r => r.start >= view.start && r.start <= view.end).map(r => {
        const x = pct(r.start) / 100 * width;
        const show = x - lastRoundLabel > 64;
        if (show) lastRoundLabel = x;
        return <span key={r.number} className="ko-round" style={{ left: `${pct(r.start)}%` }} aria-hidden="true">{show && <small>R{r.number}</small>}</span>;
      })}
      <div className="ko-ticks" aria-hidden="true">{ticks.map(at => <span key={at} style={{ left: `${pct(at)}%` }} />)}</div>
      <div className="ko-ranges" aria-hidden="true">{clips.map((clip, i) => {
        if (clip.full || !visibleIndices.has(i) || clip.end < view.start || clip.start > view.end) return null;
        const left = Math.max(0, pct(clip.start)); const right = Math.min(100, pct(clip.end));
        return <span key={clip.id ?? clip.clip.path} className={i === activeIndex ? "active" : ""} style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }} />;
      })}</div>
      <input className="ko-seek" type="range" min={0} max={Math.max(0.001, length / 1000)} step={0.1} value={Math.max(0, Math.min(length / 1000, (nowAt - view.start) / 1000))}
        aria-label="Seek match" aria-valuetext={`${time(nowAt - zero)} into the match`}
        onChange={e => { setSelected(null); onSeek(view.start + Number(e.target.value) * 1000); }} />
      {groups.map(group => {
        const first = group.events[0]; const count = group.events.length;
        const active = group.events.some(k => k.highlightIndex === activeIndex || k.number === selected);
        return <button key={first.number} type="button" className={`ko-pin ${count > 1 ? "cluster" : ""} ${active ? "active" : ""}`}
          style={{ left: Math.max(14, Math.min(width - 14, group.x)) }} aria-label={count > 1 ? `${count} kills near ${time(first.at - zero)}. Choose a kill` : `Jump to kill ${first.number} at ${time(first.at - zero)}`}
          aria-expanded={count > 1 ? opened === first.number : undefined}
          onPointerEnter={() => setHovered(first.number)} onPointerLeave={() => setHovered(null)} onFocus={() => setHovered(first.number)} onBlur={() => setHovered(null)}
          onClick={e => { if (count === 1) choose(first); else { trigger.current = e.currentTarget; setOpened(opened === first.number ? null : first.number); } }}>
          <Crosshair size={12} weight="bold" />{count > 1 && <span>{count}</span>}
        </button>;
      })}
      {moments.filter(m => m.at >= view.start && m.at <= view.end).map((m, n) => {
        const label = `${m.kind === "death" ? "Death" : "Assist"} at ${time(m.at - zero)}`;
        return <button key={`${m.kind}-${m.at}-${n}`} type="button" className={`ko-moment ${m.kind}`} style={{ left: pct(m.at) / 100 * width }}
          title={label} aria-label={`Jump to ${label.toLowerCase()}`} onClick={() => { setSelected(null); onSeek(Math.max(start, m.at - 3000)); }}>
          {m.kind === "death" ? <Skull size={11} weight="bold" /> : <Handshake size={11} weight="bold" />}
        </button>;
      })}
      {preview && !openGroup && <div className="ko-preview" role="tooltip" style={{ left: Math.max(104, Math.min(width - 104, preview.x)) }}>
        <PreviewFrame clip={previewClip(preview.events[0])} at={preview.events[0].at} />
        <strong>{preview.events.length > 1 ? `${preview.events.length} kills` : `Kill ${preview.events[0].number}`} · {time(preview.events[0].at - zero)}</strong>
        <small>{roundFor(preview.events[0].at) ? `Round ${roundFor(preview.events[0].at)!.number} · ` : ""}{preview.events[0].highlightIndex != null ? previewClip(preview.events[0]).title : "Full recording"}</small>
      </div>}
      {openGroup && <div className="ko-chooser" ref={chooser} role="group" aria-label="Choose a kill" style={{ left: Math.max(120, Math.min(width - 120, openGroup.x)) }}>
        <strong>{openGroup.events.length} kills · {time(openGroup.events[0].at - zero)}–{time(openGroup.events[openGroup.events.length - 1].at - zero)}</strong>
        {openGroup.events.map(event => <button key={event.number} type="button" onClick={() => choose(event)}><span className="ko-choice-image"><PreviewFrame clip={previewClip(event)} at={event.at} /></span><span>Kill {event.number}<small>{time(event.at - zero)}{roundFor(event.at) ? ` · Round ${roundFor(event.at)!.number}` : ""}</small></span></button>)}
        <button type="button" onClick={() => zoom(Math.max(1, length / Math.max(30_000, (openGroup.events[openGroup.events.length - 1].at - openGroup.events[0].at) * 1.5)), (openGroup.events[0].at + openGroup.events[openGroup.events.length - 1].at) / 2)}>Zoom into these kills</button>
      </div>}
    </div>
    <div className="ko-times">
      <span>{time(view.start - zero)}</span>
      {ticks.filter(at => { const x = pct(at) / 100 * width; return x > 36 && x < width - 36; }).map(at => <small key={at} style={{ left: `${pct(at)}%` }}>{time(at - zero)}</small>)}
      <span>{time(view.end - zero)}</span>
    </div>
  </section>;
}
