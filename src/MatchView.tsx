// One game at a glance: an overview of the match, a player, and one
// continuous timeline of the whole game on real time, with the clips as
// blocks where they happened and each kill marked at its moment. With a
// full match recording, that recording is what plays, so the whole game is
// one video; otherwise the player runs straight through the clips. Tabs
// switch to the other matches that day.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Pause, Play, Scissors, SkipBack, SkipForward, Star } from "@phosphor-icons/react";
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
  const [laneW, setLaneW] = useState(0);
  // Filmstrip and waveform for each piece of footage, as the editor draws them.
  const [media, setMedia] = useState<Record<string, { reel?: string; frames?: number; wave?: string }>>({});
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

  // Width of the lanes, for laying out filmstrip frames.
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLaneW(el.clientWidth));
    ro.observe(el);
    setLaneW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Footage shown in the Video and Audio lanes: the full recording when
  // there is one, otherwise each clip in its spot. Both come from the same
  // cached files the editor uses.
  const footage = full ? [full] : clips;
  useEffect(() => {
    let cancelled = false;
    for (const { clip } of footage) {
      if (media[clip.path]) continue;
      const set = (part: { reel?: string; frames?: number; wave?: string }) => {
        if (!cancelled) setMedia((all) => ({ ...all, [clip.path]: { ...all[clip.path], ...part } }));
      };
      set({});
      invoke<string>("gen_filmstrip", { input: clip.path })
        .then((reel) => set({ reel, frames: Number(reel.match(/\.reel(\d+)\.jpg/)?.[1] ?? 10) }))
        .catch(() => {});
      invoke<{ track: number; waveform: string }[]>("gen_waveforms", { input: clip.path })
        .then((waves) => set({ wave: (waves.find((w) => w.track === 0) ?? waves[0])?.waveform }))
        .catch(() => {});
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.key]);

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
  const px = (ms: number) => ((ms - span.start) / span.total) * laneW;
  // Clips that aren't the full recording: the blocks in the Clips lane.
  const parts = clips.map((c, i) => ({ c, i })).filter(({ c }) => c !== full);

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

      {/* Same toolbar as the editor: clock, what's playing, transport, actions. */}
      <div className="tx-bar st-mv-bar">
        <span className="tx-clock mono">{run.clockStart ? gameClock(nowAt) : mmss((nowAt - span.start) / 1000)}</span>
        <span className="tx-total mono">/ {run.clockStart ? gameClock(span.end) : mmss(span.total / 1000)}</span>
        <span className="st-mv-now">
          <strong>{active === full ? "Full match" : active.title}</strong>
          {!full && <> · clip {picked + 1} of {clips.length}</>}
        </span>
        <div className="tx-controls">
          <button type="button" className="tx-btn" aria-label="Previous clip" title="Previous clip ([)" disabled={!full && picked <= 0} onClick={() => jump(-1)}><SkipBack size={14} weight="fill" /></button>
          <button type="button" className="tx-btn tx-play" aria-label={playing ? "Pause" : "Play"} title="Play / pause (Space)" onClick={togglePlay}>
            {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
          </button>
          <button type="button" className="tx-btn" aria-label="Next clip" title="Next clip (])" disabled={!full && picked >= clips.length - 1} onClick={() => jump(1)}><SkipForward size={14} weight="fill" /></button>
        </div>
        <button type="button" className="tx-toggle" aria-pressed={starred(active.clip.path)} onClick={() => onStar(active.clip)}>
          <Star size={13} weight={starred(active.clip.path) ? "fill" : "regular"} /> {starred(active.clip.path) ? "Starred" : "Star"}
        </button>
        <button type="button" className="tx-toggle" onClick={() => onEdit(active.clip)}><Scissors size={13} /> {active === full ? "Edit match" : "Edit clip"}</button>
      </div>

      <div className="mvt" aria-label="Game timeline">
        <div className="mvt-labels">
          <div className="mvt-ruler-spacer" />
          {rounds.length > 0 && <div className="mvt-label mvt-rounds-row"><span className="mt-id">R</span>Rounds</div>}
          <div className="mvt-label mvt-clips-row"><span className="mt-id">C</span>Clips</div>
          <div className="mvt-label mvt-video-row"><span className="mt-id">V1</span>{full ? "Full match" : "Video"}</div>
          <div className="mvt-label mvt-audio-row"><span className="mt-id">A1</span>Audio</div>
          <div className="mvt-label mvt-kills-row"><span className="mt-id">E</span>Kills</div>
        </div>
        <div
          ref={track}
          className="mvt-lanes"
          role="slider"
          tabIndex={0}
          aria-label="Game timeline"
          aria-valuemin={0}
          aria-valuemax={Math.round(span.total / 1000)}
          aria-valuenow={Math.round((nowAt - span.start) / 1000)}
          aria-valuetext={`${mmss((nowAt - span.start) / 1000)} into the game`}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("button")) return;
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
          <div className="mvt-ruler" aria-hidden="true">
            {minuteMarks((span.start - zero) / 60_000, (span.end - zero) / 60_000)
              .filter((m) => zero + m * 60_000 - span.start < span.total * 0.94)
              .map((m) => (
                <span key={m} className="mvt-tick" style={{ left: pct(zero + m * 60_000) }}>
                  <small>{run.clockStart ? `${m}:00` : `${m}m`}</small>
                </span>
              ))}
            <span className="mvt-end">{run.clockStart ? gameClock(span.end) : clock(span.end)}</span>
          </div>

          {rounds.length > 0 && (
            <div className="mvt-lane mvt-rounds-row">
              {rounds.map((r) => (
                <span key={r.number} className={`mvt-round ${r.result ?? ""}`} style={{ left: pct(r.start), width: `${((r.end - r.start) / span.total) * 100}%` }} title={`Round ${r.number}${r.result ? ` · ${RESULT[r.result]}` : ""}`}>
                  R{r.number}
                </span>
              ))}
            </div>
          )}

          <div className="mvt-lane mvt-clips-row">
            {parts.map(({ c, i }) => (
              <button
                key={c.clip.path}
                type="button"
                className={`mvt-clip ${i === activeIdx ? "active" : ""}`}
                style={{ left: pct(c.start), width: `${((c.end - c.start) / span.total) * 100}%` }}
                title={`${c.title} · ${run.clockStart ? `${gameClock(c.start)} in game` : clock(c.start)} — click to edit`}
                aria-label={`Edit ${c.title}`}
                onClick={() => onEdit(c.clip)}
              >
                <Scissors size={10} weight="bold" />
                <span>{c.title.split(" · ").slice(1).join(" · ") || c.title}</span>
              </button>
            ))}
          </div>

          <div className="mvt-lane mvt-video-row">
            {footage.map((c) => {
              const m = media[c.clip.path];
              const left = px(c.start);
              const width = Math.max(2, px(c.end) - left);
              const frames = m?.frames ?? 10;
              const tiles = Math.max(1, Math.round(width / (60 * 16 / 9)));
              const tileW = width / tiles;
              return (
                <div key={c.clip.path} className="mvt-footage" style={{ left, width }}>
                  {m?.reel &&
                    Array.from({ length: tiles }, (_, k) => (
                      <span
                        key={k}
                        className="mvt-frame"
                        style={{
                          width: tileW,
                          backgroundImage: `url("${convertFileSrc(m.reel!)}")`,
                          backgroundSize: `${frames * tileW}px 100%`,
                          backgroundPositionX: `${-Math.min(frames - 1, Math.floor(((k + 0.5) / tiles) * frames)) * tileW}px`,
                        }}
                      />
                    ))}
                </div>
              );
            })}
          </div>

          <div className="mvt-lane mvt-audio-row">
            {footage.map((c) => {
              const wave = media[c.clip.path]?.wave;
              return (
                <div key={c.clip.path} className="mvt-footage" style={{ left: pct(c.start), width: `${((c.end - c.start) / span.total) * 100}%` }}>
                  {wave && <img src={convertFileSrc(wave)} alt="" draggable={false} />}
                </div>
              );
            })}
          </div>

          <div className="mvt-lane mvt-kills-row">
            {kills.map((k, n) => (
              <button
                key={`${k.i}-${k.t}`}
                type="button"
                className="mvt-kill"
                style={{ left: pct(k.at) }}
                aria-label={`Kill ${n + 1} at ${run.clockStart ? gameClock(k.at) : clock(k.at)}. Jump there`}
                title={`Kill · ${run.clockStart ? `${gameClock(k.at)} in game` : clock(k.at)}`}
                onClick={() => choose(k.i, Math.max(0, k.t - 2), true)}
              >
                K{n + 1}
              </button>
            ))}
          </div>

          <div className="mvt-playhead" style={{ left: pct(nowAt) }}>
            <span />
          </div>
        </div>
      </div>
    </section>
  );
}
