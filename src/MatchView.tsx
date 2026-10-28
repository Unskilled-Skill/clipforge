// One game at a glance: an overview of the match, a player, and one
// continuous timeline of the whole game on real time, with the clips as
// blocks where they happened and each kill marked at its moment. With a
// full match recording, that recording is what plays, so the whole game is
// one video; otherwise the player runs straight through the clips. Tabs
// switch to the other matches that day.

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
  /** A full match recording (the whole game, not a clip of it). */
  full?: boolean;
};

export type MatchRun = {
  key: string;
  label: string;
  meta: string;
  result?: "won" | "lost" | "draw";
  /** When the game's own clock read 0:00 (ms), for games with one (League). */
  clockStart?: number;
  clips: MatchClip[];
};

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const RESULT = { won: "Won", lost: "Lost", draw: "Draw" } as const;

/** Minute marks between `from` and `to` (minutes on some clock), on a
 * round step that gives about six to ten across. */
function minuteMarks(from: number, to: number): number[] {
  const step = [1, 2, 5, 10, 15, 30, 60].find((s) => (to - from) / s <= 10) ?? 120;
  const marks: number[] = [];
  for (let m = Math.ceil(from / step) * step; m <= to + 1e-6; m += step) marks.push(m);
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
  // A full match recording, when there is one, is what plays.
  const full = clips.find((c) => c.full);
  const source = full ?? current;

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
  const activeKey = useRef("");

  // The game on real time: from the first clip's start to the last one's end.
  const span = useMemo(() => {
    if (!clips.length) return { start: 0, end: 1, total: 1 };
    const start = Math.min(...clips.map((c) => c.start));
    const end = Math.max(...clips.map((c) => c.end));
    return { start, end, total: Math.max(1000, end - start) };
  }, [clips]);
  const pct = (ms: number) => `${((ms - span.start) / span.total) * 100}%`;
  // A full recording already holds every kill; the clips repeat them.
  const kills = clips.flatMap((c, i) => (full && c !== full ? [] : (markers[c.clip.path] ?? []).map((t) => ({ i, t, at: c.start + t * 1000 }))));
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
  // Games with their own clock (League) are read on it: "14:32" into the
  // game. Others count minutes from the first clip.
  const zero = run?.clockStart ?? span.start;
  const gameClock = (ms: number) => mmss(Math.max(0, (ms - zero) / 1000));

  function choose(index: number, at = 0, play = false) {
    if (!clips[index]) return;
    keepPlaying.current = play;
    if (full) {
      // One video for the whole game: seek it to that clip's moment.
      const t = Math.max(0, (clips[index].start - full.start) / 1000 + at);
      setPicked(index);
      setNow(t);
      const v = video.current;
      if (v && v.readyState >= 1) {
        v.currentTime = t;
        if (play) void v.play().catch(() => {});
      } else pendingSeek.current = t;
      return;
    }
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
    if (full && ms >= full.start && ms <= full.end) return choose(clips.indexOf(full), (ms - full.start) / 1000, !video.current?.paused);
    const inside = clips.findIndex((c) => ms >= c.start && ms <= c.end);
    if (inside >= 0) return choose(inside, (ms - clips[inside].start) / 1000, !video.current?.paused);
    const next = clips.findIndex((c) => c.start > ms);
    choose(next < 0 ? clips.length - 1 : next, 0, !video.current?.paused);
  }

  /** Step to the previous or next clip; over a full recording, to the
   * clip before or after the playhead. */
  function jump(dir: 1 | -1) {
    if (!full) return choose(Math.max(0, Math.min(clips.length - 1, picked + dir)), 0, !video.current?.paused);
    const at = full.start + (video.current?.currentTime ?? now) * 1000;
    const parts = clips.map((c, i) => ({ c, i })).filter(({ c }) => c !== full);
    const target = dir > 0 ? parts.find(({ c }) => c.start > at + 500) : [...parts].reverse().find(({ c }) => c.start < at - 2000);
    if (target) choose(target.i, 0, !video.current?.paused);
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
      else if (e.key === "[" || e.key === "]") { e.preventDefault(); jump(e.key === "]" ? 1 : -1); }
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

  const nowAt = source.start + now * 1000;
  const title = run.label.split(" · ").slice(1).join(" · ") || run.label;
  // What's on screen: over a full recording, the clip the playhead is in
  // (or the recording itself between clips).
  const activeIdx = full
    ? (() => {
        const inside = clips.findIndex((c) => c !== full && nowAt >= c.start && nowAt <= c.end);
        return inside >= 0 ? inside : clips.indexOf(full);
      })()
    : picked;
  const active = clips[activeIdx] ?? current;
  const partCount = clips.filter((c) => c !== full).length;
  // Keep the card on screen in view as playback moves through the match.
  if (activeKey.current !== `${runIndex}:${activeIdx}`) {
    activeKey.current = `${runIndex}:${activeIdx}`;
    requestAnimationFrame(() => cards.current?.querySelector<HTMLElement>(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }

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
          <div><dt>Clips</dt><dd>{partCount}{full ? " + full match" : ""}</dd></div>
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
          key={source.clip.path}
          src={convertFileSrc(source.clip.path)}
          preload="auto"
          aria-label={`Playing ${full ? "the full match" : current.title}`}
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
            if (!full && picked < clips.length - 1) choose(picked + 1, 0, true);
          }}
        />
      </div>

      <div className="st-mv-bar">
        <div className="st-mv-transport">
          <button className="tx-btn" aria-label="Previous clip" title="Previous clip ([)" disabled={!full && picked <= 0} onClick={() => jump(-1)}><SkipBack size={14} weight="fill" /></button>
          <button className="tx-btn tx-play" aria-label={playing ? "Pause" : "Play"} title="Play / pause (Space)" onClick={togglePlay}>
            {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
          </button>
          <button className="tx-btn" aria-label="Next clip" title="Next clip (])" disabled={!full && picked >= clips.length - 1} onClick={() => jump(1)}><SkipForward size={14} weight="fill" /></button>
        </div>
        <span className="st-mv-now">
          {full ? (
            <><strong>{active === full ? "Full match" : active.title}</strong> · <span className="mono">{run.clockStart ? gameClock(nowAt) : mmss(now)} / {run.clockStart ? gameClock(full.end) : mmss((full.end - full.start) / 1000)}</span></>
          ) : (
            <><strong>{current.title}</strong> · clip {picked + 1} of {clips.length} · <span className="mono">{mmss(now)} / {mmss((current.end - current.start) / 1000)}</span></>
          )}
        </span>
        <button className="st-ghost" onClick={() => onStar(active.clip)}>
          <Star size={14} weight={starred(active.clip.path) ? "fill" : "regular"} /> {starred(active.clip.path) ? "Starred" : "Star"}
        </button>
        <button className="st-ghost" onClick={() => onEdit(active.clip)}><Scissors size={14} /> {active === full ? "Edit match" : "Edit clip"}</button>
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
              aria-label={`Kill at ${run.clockStart ? gameClock(k.at) : clock(k.at)}. Jump there`}
              title={`Kill · ${run.clockStart ? `${gameClock(k.at)} in game` : clock(k.at)}`}
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
          aria-valuetext={`${mmss((nowAt - span.start) / 1000)} into the game`}
          onPointerDown={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            seekToTime(span.start + ((e.clientX - r.left) / r.width) * span.total);
          }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            e.stopPropagation();
            jump(e.key === "ArrowRight" ? 1 : -1);
          }}
        >
          {clips.map((c, i) => (
            <div
              key={c.clip.path}
              className={`st-mv-block ${c === full ? "full" : ""} ${i === activeIdx ? "active" : ""}`}
              style={{ left: pct(c.start), width: `${((c.end - c.start) / span.total) * 100}%` }}
              title={`${c.title} · ${clock(c.start)}`}
            />
          ))}
          <div className="st-mv-playhead" style={{ left: pct(nowAt) }} />
        </div>
        <div className="st-mv-ruler" aria-hidden="true">
          {/* Marks too close to the end would run into its clock time. */}
          {minuteMarks((span.start - zero) / 60_000, (span.end - zero) / 60_000)
            .filter((m) => zero + m * 60_000 - span.start < span.total * 0.92)
            .map((m) => (
              <span key={m} className={zero + m * 60_000 - span.start < span.total * 0.02 ? "first" : ""} style={{ left: pct(zero + m * 60_000) }}>
                {run.clockStart ? `${m}:00` : `${m}m`}
              </span>
            ))}
          <span className="end">{run.clockStart ? gameClock(span.end) : clock(span.end)}</span>
        </div>
      </div>

      <div className="st-mv-cards" ref={cards} aria-label="Clips in this match">
        {/* The full match recording leads; then the clips in play order. */}
        {clips.map((c, i) => ({ c, i })).sort((a, b) => Number(b.c === full) - Number(a.c === full)).map(({ c, i }) => (
          <button key={c.clip.path} className={i === activeIdx ? "active" : ""} aria-current={i === activeIdx ? "true" : undefined} onClick={() => choose(i, 0, playing)}>
            {c.thumb ? <img src={convertFileSrc(c.thumb)} alt="" draggable={false} /> : <span className="st-mv-blank"><FilmStrip size={16} /></span>}
            <span className="st-mv-card-text">
              <strong>{c === full ? "Full match" : c.title}</strong>
              <small>{roundOf(c) !== undefined ? `Round ${roundOf(c)} · ` : ""}{run.clockStart ? `${gameClock(c.start)} in game` : clock(c.start)} · {mmss((c.end - c.start) / 1000)}</small>
            </span>
            {(markers[c.clip.path]?.length ?? 0) > 0 && <span className="st-mv-kills">{markers[c.clip.path].length}K</span>}
          </button>
        ))}
      </div>
    </section>
  );
}
