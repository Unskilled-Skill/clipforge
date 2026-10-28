// One match (or one stretch of play in a game) as a single timeline: its
// clips side by side in play order with their kills marked, a player that
// runs straight through them, and tabs for the other matches that day.
// The gaps between clips are squeezed to a thin divider, so a 30-minute
// match with ten short clips still reads at a glance.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Crosshair, FilmStrip, Pause, Play, Scissors, SkipBack, SkipForward, Star } from "@phosphor-icons/react";
import { convertFileSrc, invoke } from "./tauri-shim";
import type { ClipInfo } from "./types";

export type MatchClip = {
  clip: ClipInfo;
  title: string;
  /** Wall-clock span (ms): the clip was saved at `end`. */
  start: number;
  end: number;
  thumb: string | null;
};

export type MatchRun = {
  key: string;
  label: string;
  meta: string;
  clips: MatchClip[];
};

/** Width (px) of the divider standing in for the time between two clips. */
const GAP_PX = 18;

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const gapText = (ms: number) => (ms < 60_000 ? "" : ms < 3_600_000 ? `+${Math.round(ms / 60_000)} min` : `+${(ms / 3_600_000).toFixed(1)} h`);

export function MatchView({ runs, initialRun, game, starred, onStar, onEdit, onBack }: {
  runs: MatchRun[];
  initialRun: number;
  game: string;
  starred: (path: string) => boolean;
  onStar: (clip: ClipInfo) => void;
  onEdit: (clip: ClipInfo) => void;
  onBack: () => void;
}) {
  const [runIndex, setRunIndex] = useState(Math.min(Math.max(0, initialRun), runs.length - 1));
  const run = runs[runIndex];
  const clips = run?.clips ?? [];
  const [picked, setPicked] = useState(0);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [markers, setMarkers] = useState<Record<string, number[]>>({});
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  const pendingSeek = useRef<number | null>(null);
  const keepPlaying = useRef(false);
  const current = clips[Math.min(picked, clips.length - 1)];

  useEffect(() => {
    setPicked(0);
    setNow(0);
  }, [runIndex]);

  // Kill markers for every clip in the match (seconds into each clip).
  useEffect(() => {
    let cancelled = false;
    for (const { clip } of clips) {
      if (markers[clip.path]) continue;
      invoke<number[]>("load_markers", { input: clip.path })
        .then((m) => { if (!cancelled) setMarkers((all) => ({ ...all, [clip.path]: m ?? [] })); })
        .catch(() => { if (!cancelled) setMarkers((all) => ({ ...all, [clip.path]: [] })); });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.key]);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackWidth(el.clientWidth));
    ro.observe(el);
    setTrackWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Clip segments laid out end to end, sized by length, with a fixed
  // divider for each gap in play.
  const layout = useMemo(() => {
    const lengths = clips.map((c) => Math.max(1, (c.end - c.start) / 1000));
    const total = lengths.reduce((a, b) => a + b, 0);
    const room = Math.max(1, trackWidth - GAP_PX * Math.max(0, clips.length - 1));
    let x = 0;
    return clips.map((c, i) => {
      const width = (lengths[i] / total) * room;
      const seg = { x, width, length: lengths[i], gap: i > 0 ? c.start - clips[i - 1].end : 0 };
      x += width + GAP_PX;
      return seg;
    });
  }, [clips, trackWidth]);

  function choose(index: number, at = 0, play = false) {
    if (!clips[index]) return;
    keepPlaying.current = play;
    if (index === picked && video.current && video.current.readyState >= 1) {
      video.current.currentTime = at;
      if (play) void video.current.play().catch(() => {});
      return;
    }
    pendingSeek.current = at;
    setPicked(index);
    setNow(at);
  }

  function seekFromTrack(clientX: number) {
    const el = track.current;
    if (!el) return;
    const x = clientX - el.getBoundingClientRect().left;
    const i = layout.findIndex((s) => x < s.x + s.width + GAP_PX / 2);
    const index = i < 0 ? layout.length - 1 : i;
    const s = layout[index];
    if (!s) return;
    const at = Math.min(s.length, Math.max(0, ((x - s.x) / s.width) * s.length));
    choose(index, at, !video.current?.paused);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : document.body;
      if (document.querySelector('[aria-modal="true"]') || target.closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === " " && target.closest("button, a, summary, video")) return;
      if (e.key === "Escape") { e.preventDefault(); onBack(); }
      else if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if (e.key === "[" || e.key === "]") { e.preventDefault(); choose(Math.max(0, Math.min(clips.length - 1, picked + (e.key === "]" ? 1 : -1))), 0, !video.current?.paused); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function togglePlay() {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      keepPlaying.current = true;
      void v.play().catch(() => {});
    } else v.pause();
  }

  if (!run || !current) {
    return (
      <section className="st-session-view st-mv">
        <header className="st-session-header"><button className="st-ghost" onClick={onBack}><ArrowLeft size={14} /> Library</button></header>
        <p className="st-session-note st-mv-empty">These clips are no longer in the library.</p>
      </section>
    );
  }

  const seg = layout[picked];
  const playheadX = seg ? seg.x + (Math.min(now, seg.length) / seg.length) * seg.width : 0;
  const totalKills = clips.reduce((a, c) => a + (markers[c.clip.path]?.length ?? 0), 0);

  return (
    <section className="st-session-view st-mv" aria-label={`${game} match`}>
      <header className="st-session-header">
        <button className="st-ghost" onClick={onBack}><ArrowLeft size={14} /> Library</button>
        <div>
          <h1>{run.label}</h1>
          <span>{run.meta}</span>
        </div>
        <button className="st-ghost" onClick={() => onStar(current.clip)}>
          <Star size={14} weight={starred(current.clip.path) ? "fill" : "regular"} /> {starred(current.clip.path) ? "Starred" : "Star clip"}
        </button>
        <button className="st-ghost" onClick={() => onEdit(current.clip)}><Scissors size={14} /> Edit clip</button>
      </header>

      {runs.length > 1 && (
        <nav className="st-mv-tabs" aria-label={`${game} matches`}>
          {runs.map((r, i) => (
            <button key={r.key} className={i === runIndex ? "active" : ""} aria-current={i === runIndex ? "true" : undefined} onClick={() => setRunIndex(i)}>
              {r.clips[0]?.thumb ? <img src={convertFileSrc(r.clips[0].thumb)} alt="" draggable={false} /> : <span className="st-mv-tab-blank"><FilmStrip size={16} /></span>}
              <span><strong>{r.label.split(" · ").slice(1).join(" · ") || r.label}</strong><small>{r.meta}</small></span>
            </button>
          ))}
        </nav>
      )}

      <div className="st-mv-main">
        <div className="st-mv-stage">
          <div className="st-mv-player">
            <video
              ref={video}
              key={current.clip.path}
              src={convertFileSrc(current.clip.path)}
              preload="auto"
              aria-label={`Playing ${current.title}`}
              onClick={togglePlay}
              onLoadedMetadata={(e) => {
                if (pendingSeek.current !== null) {
                  e.currentTarget.currentTime = pendingSeek.current;
                  pendingSeek.current = null;
                }
                if (keepPlaying.current) void e.currentTarget.play().catch(() => {});
              }}
              onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => {
                // Straight on into the next clip of the match.
                if (picked < clips.length - 1) choose(picked + 1, 0, true);
              }}
            />
          </div>
          <div className="st-mv-transport">
            <span className="mono">{mmss(now)} / {mmss(seg?.length ?? 0)}</span>
            <div>
              <button className="tx-btn" aria-label="Previous clip" title="Previous clip ([)" disabled={picked <= 0} onClick={() => choose(picked - 1, 0, playing)}><SkipBack size={14} weight="fill" /></button>
              <button className="tx-btn tx-play" aria-label={playing ? "Pause" : "Play"} title="Play / pause (Space)" onClick={togglePlay}>
                {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
              </button>
              <button className="tx-btn" aria-label="Next clip" title="Next clip (])" disabled={picked >= clips.length - 1} onClick={() => choose(picked + 1, 0, playing)}><SkipForward size={14} weight="fill" /></button>
            </div>
            <span className="st-mv-transport-meta">Clip {picked + 1} of {clips.length} · {clock(current.start)}</span>
          </div>
        </div>

        <aside className="st-mv-list" aria-label="Clips in this match">
          <div className="st-mv-list-head">{clips.length} clips{totalKills ? ` · ${totalKills} kills` : ""}</div>
          {clips.map((c, i) => (
            <button key={c.clip.path} className={i === picked ? "active" : ""} aria-current={i === picked ? "true" : undefined} onClick={() => choose(i, 0, playing)}>
              {c.thumb ? <img src={convertFileSrc(c.thumb)} alt="" draggable={false} /> : <span className="st-mv-tab-blank"><FilmStrip size={14} /></span>}
              <span>
                <strong>{c.title}</strong>
                <small>{clock(c.start)} · {mmss((c.end - c.start) / 1000)}</small>
              </span>
              {(markers[c.clip.path]?.length ?? 0) > 0 && <span className="st-mv-kills">{markers[c.clip.path].length}K</span>}
            </button>
          ))}
        </aside>
      </div>

      <div className="st-mv-timeline">
        <div className="st-mv-times" aria-hidden="true">
          {layout.map((s, i) => (
            <span key={clips[i].clip.path} style={{ left: s.x }}>{clock(clips[i].start)}</span>
          ))}
        </div>
        <div
          ref={track}
          className="st-mv-track"
          role="slider"
          tabIndex={0}
          aria-label="Match timeline"
          aria-valuemin={0}
          aria-valuemax={clips.length}
          aria-valuenow={picked + 1}
          aria-valuetext={`Clip ${picked + 1} of ${clips.length}, ${mmss(now)}`}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("button")) return;
            seekFromTrack(e.clientX);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              e.stopPropagation();
              choose(Math.max(0, Math.min(clips.length - 1, picked + (e.key === "ArrowRight" ? 1 : -1))), 0, playing);
            }
          }}
        >
          {layout.map((s, i) => (
            <div
              key={clips[i].clip.path}
              className={`st-mv-seg ${i === picked ? "active" : ""}`}
              style={{ left: s.x, width: s.width, backgroundImage: clips[i].thumb ? `url("${convertFileSrc(clips[i].thumb!)}")` : undefined }}
              title={`${clips[i].title} · ${clock(clips[i].start)}`}
            >
              {(markers[clips[i].clip.path] ?? []).map((t) => (
                <button
                  key={t}
                  type="button"
                  className="st-mv-kill"
                  style={{ left: `${(Math.min(t, s.length) / s.length) * 100}%` }}
                  aria-label={`Kill at ${mmss(t)} in clip ${i + 1}. Jump there`}
                  title={`Kill · ${clock(clips[i].start + t * 1000)}`}
                  onClick={() => choose(i, Math.max(0, t - 2), true)}
                >
                  <Crosshair size={10} weight="bold" />
                </button>
              ))}
            </div>
          ))}
          {layout.slice(1).map((s, i) => (
            <span key={`gap-${i}`} className="st-mv-gap" style={{ left: s.x - GAP_PX, width: GAP_PX }} title={gapText(s.gap) ? `${gapText(s.gap)} between clips` : undefined}>
              {gapText(s.gap) && <small>{gapText(s.gap)}</small>}
            </span>
          ))}
          <div className="st-mv-playhead" style={{ transform: `translateX(${playheadX}px)` }} />
        </div>
      </div>

      <footer className="st-session-footer"><span><kbd>Space</kbd> play</span><span><kbd>[ ]</kbd> previous/next clip</span><span>Plays straight through the match</span><span><kbd>Esc</kbd> back</span></footer>
    </section>
  );
}
