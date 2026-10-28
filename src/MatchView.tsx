// One game at a glance: an overview of the match, a player that runs
// straight through its clips, and one continuous timeline of the whole
// game on real time, with the clips as blocks where they happened and each
// kill marked at its moment. Tabs switch to the other matches that day.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  /** Rounds this clip covers, as the game reported them (seconds into the clip). */
  rounds?: { number: number; start: number; end: number; result: "won" | "lost" | "draw" | null }[];
};

export type MatchRun = {
  key: string;
  label: string;
  meta: string;
  result?: "won" | "lost" | "draw";
  clips: MatchClip[];
};

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const RESULT = { won: "Won", lost: "Lost", draw: "Draw" } as const;

/** Minute marks for a game `total` ms long: about six to ten across. */
function minuteMarks(total: number): number[] {
  const minutes = total / 60_000;
  const step = [1, 2, 5, 10, 15, 30, 60].find((s) => minutes / s <= 10) ?? 120;
  const marks: number[] = [];
  for (let m = 0; m <= minutes + 1e-6; m += step) marks.push(m);
  return marks;
}

export function MatchView({ runs, initialRun, game, icon, starred, onStar, onEdit, onBack }: {
  runs: MatchRun[];
  initialRun: number;
  game: string;
  icon?: ReactNode;
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
  const cards = useRef<HTMLDivElement>(null);
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

  // Keep the playing clip's card in view.
  useEffect(() => {
    cards.current?.querySelector<HTMLElement>(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [picked, runIndex]);

  // The game on real time: from the first clip's start to the last one's end.
  const span = useMemo(() => {
    if (!clips.length) return { start: 0, end: 1, total: 1 };
    const start = Math.min(...clips.map((c) => c.start));
    const end = Math.max(...clips.map((c) => c.end));
    return { start, end, total: Math.max(1000, end - start) };
  }, [clips]);
  const pct = (ms: number) => `${((ms - span.start) / span.total) * 100}%`;
  const kills = clips.flatMap((c, i) => (markers[c.clip.path] ?? []).map((t) => ({ i, t, at: c.start + t * 1000 })));
  // Rounds on the game's clock: each round's earliest start and latest end
  // across the clips that show it.
  const rounds = useMemo(() => {
    const byNumber = new Map<number, { number: number; start: number; end: number; result: "won" | "lost" | "draw" | null }>();
    for (const c of clips) {
      for (const r of c.rounds ?? []) {
        const start = c.start + r.start * 1000;
        const end = c.start + r.end * 1000;
        const seen = byNumber.get(r.number);
        byNumber.set(r.number, seen ? { ...seen, start: Math.min(seen.start, start), end: Math.max(seen.end, end), result: seen.result ?? r.result } : { number: r.number, start, end, result: r.result });
      }
    }
    return [...byNumber.values()].sort((a, b) => a.start - b.start);
  }, [clips]);
  const roundOf = (c: MatchClip) => c.rounds?.[0]?.number;

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

  /** A point on the game timeline: inside a clip plays from there; between
   * clips, the next clip from its start. */
  function seekToTime(ms: number) {
    const inside = clips.findIndex((c) => ms >= c.start && ms <= c.end);
    if (inside >= 0) return choose(inside, (ms - clips[inside].start) / 1000, !video.current?.paused);
    const next = clips.findIndex((c) => c.start > ms);
    choose(next < 0 ? clips.length - 1 : next, 0, !video.current?.paused);
  }

  function togglePlay() {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      keepPlaying.current = true;
      void v.play().catch(() => {});
    } else v.pause();
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

  if (!run || !current) {
    return (
      <section className="st-session-view st-mv">
        <header className="st-mv-head"><button className="st-ghost" onClick={onBack}><ArrowLeft size={14} /> Library</button></header>
        <p className="st-session-note st-mv-empty">These clips are no longer in the library.</p>
      </section>
    );
  }

  const nowAt = current.start + now * 1000;
  const title = run.label.split(" · ").slice(1).join(" · ") || run.label;

  return (
    <section className="st-session-view st-mv" aria-label={`${game} match`}>
      <header className="st-mv-head">
        <button className="st-ghost" onClick={onBack}><ArrowLeft size={14} /> Library</button>
        <div className="st-mv-title">
          {icon}
          <h1>{game}<span>{title}</span></h1>
        </div>
        <dl className="st-mv-stats">
          {run.result && <div className={`st-mv-result ${run.result}`}><dt>Result</dt><dd>{RESULT[run.result]}</dd></div>}
          <div><dt>Length</dt><dd>{span.total >= 3_600_000 ? `${(span.total / 3_600_000).toFixed(1)} h` : `${Math.max(1, Math.round(span.total / 60_000))} min`}</dd></div>
          <div><dt>Clips</dt><dd>{clips.length}</dd></div>
          <div><dt>Kills</dt><dd>{kills.length}</dd></div>
          <div><dt>Played</dt><dd>{new Date(span.start).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, {clock(span.start)}</dd></div>
        </dl>
      </header>

      {runs.length > 1 && (
        <nav className="st-mv-tabs" aria-label={`${game} matches`}>
          {runs.map((r, i) => (
            <button key={r.key} className={i === runIndex ? "active" : ""} aria-current={i === runIndex ? "true" : undefined} onClick={() => setRunIndex(i)}>
              <strong>{r.label.split(" · ").slice(1).join(" · ") || r.label}</strong>
              <small>{r.meta}</small>
            </button>
          ))}
        </nav>
      )}

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

      <div className="st-mv-bar">
        <div className="st-mv-transport">
          <button className="tx-btn" aria-label="Previous clip" title="Previous clip ([)" disabled={picked <= 0} onClick={() => choose(picked - 1, 0, playing)}><SkipBack size={14} weight="fill" /></button>
          <button className="tx-btn tx-play" aria-label={playing ? "Pause" : "Play"} title="Play / pause (Space)" onClick={togglePlay}>
            {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
          </button>
          <button className="tx-btn" aria-label="Next clip" title="Next clip (])" disabled={picked >= clips.length - 1} onClick={() => choose(picked + 1, 0, playing)}><SkipForward size={14} weight="fill" /></button>
        </div>
        <span className="st-mv-now"><strong>{current.title}</strong> · clip {picked + 1} of {clips.length} · <span className="mono">{mmss(now)} / {mmss((current.end - current.start) / 1000)}</span></span>
        <button className="st-ghost" onClick={() => onStar(current.clip)}>
          <Star size={14} weight={starred(current.clip.path) ? "fill" : "regular"} /> {starred(current.clip.path) ? "Starred" : "Star"}
        </button>
        <button className="st-ghost" onClick={() => onEdit(current.clip)}><Scissors size={14} /> Edit clip</button>
      </div>

      <div className="st-mv-timeline">
        {rounds.length > 0 && (
          <div className="st-mv-round-lane" aria-label="Rounds">
            {rounds.map((r) => (
              <span key={r.number} className={`st-mv-round ${r.result ?? ""}`} style={{ left: pct(r.start) }} title={`Round ${r.number}${r.result ? ` · ${RESULT[r.result]}` : ""}`}>
                R{r.number}
              </span>
            ))}
          </div>
        )}
        <div className="st-mv-kill-lane" aria-label="Kills">
          {kills.map((k) => (
            <button
              key={`${k.i}-${k.t}`}
              type="button"
              className="st-mv-kill"
              style={{ left: pct(k.at) }}
              aria-label={`Kill at ${clock(k.at)}. Jump there`}
              title={`Kill · ${clock(k.at)}`}
              onClick={() => choose(k.i, Math.max(0, k.t - 2), true)}
            >
              <Crosshair size={10} weight="bold" />
            </button>
          ))}
        </div>
        <div
          ref={track}
          className="st-mv-track"
          role="slider"
          tabIndex={0}
          aria-label="Game timeline"
          aria-valuemin={0}
          aria-valuemax={Math.round(span.total / 1000)}
          aria-valuenow={Math.round((nowAt - span.start) / 1000)}
          aria-valuetext={`${mmss((nowAt - span.start) / 1000)} into the game, clip ${picked + 1} of ${clips.length}`}
          onPointerDown={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            seekToTime(span.start + ((e.clientX - r.left) / r.width) * span.total);
          }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            e.stopPropagation();
            choose(Math.max(0, Math.min(clips.length - 1, picked + (e.key === "ArrowRight" ? 1 : -1))), 0, playing);
          }}
        >
          {clips.map((c, i) => (
            <div
              key={c.clip.path}
              className={`st-mv-block ${i === picked ? "active" : ""}`}
              style={{ left: pct(c.start), width: `${((c.end - c.start) / span.total) * 100}%` }}
              title={`${c.title} · ${clock(c.start)}`}
            />
          ))}
          <div className="st-mv-playhead" style={{ left: pct(nowAt) }} />
        </div>
        <div className="st-mv-ruler" aria-hidden="true">
          {/* Marks too close to the end would run into its clock time. */}
          {minuteMarks(span.total)
            .filter((m) => m === 0 || span.total - m * 60_000 > span.total * 0.08)
            .map((m) => (
              <span key={m} style={{ left: pct(span.start + m * 60_000) }}>{m}m</span>
            ))}
          <span className="end">{clock(span.end)}</span>
        </div>
      </div>

      <div className="st-mv-cards" ref={cards} aria-label="Clips in this match">
        {clips.map((c, i) => (
          <button key={c.clip.path} className={i === picked ? "active" : ""} aria-current={i === picked ? "true" : undefined} onClick={() => choose(i, 0, playing)}>
            {c.thumb ? <img src={convertFileSrc(c.thumb)} alt="" draggable={false} /> : <span className="st-mv-blank"><FilmStrip size={16} /></span>}
            <span className="st-mv-card-text">
              <strong>{c.title}</strong>
              <small>{roundOf(c) !== undefined ? `Round ${roundOf(c)} · ` : ""}{clock(c.start)} · {mmss((c.end - c.start) / 1000)}</small>
            </span>
            {(markers[c.clip.path]?.length ?? 0) > 0 && <span className="st-mv-kills">{markers[c.clip.path].length}K</span>}
          </button>
        ))}
      </div>
    </section>
  );
}
