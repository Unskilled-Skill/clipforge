// One game at a glance: an overview of the match, a player, and one
// continuous timeline of the whole game on real time, with the clips as
// blocks where they happened and each kill marked at its moment. With a
// full match recording, that recording is what plays, so the whole game is
// one video; otherwise the player runs straight through the clips. Tabs
// switch to the other matches that day.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, CaretLeft, CaretRight, Crosshair, FilmStrip, Pause, Play, Scissors, SkipBack, SkipForward, Star } from "@phosphor-icons/react";
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
  const side = useRef<HTMLElement>(null);
  const sideKey = useRef("");
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
  // A full recording already holds every kill; the clips repeat them.
  const kills = clips.flatMap((c, i) => (full && c !== full ? [] : (markers[c.clip.path] ?? []).map((t) => ({ i, t, at: c.start + t * 1000 }))));
  // Rounds on the game's clock: each round's earliest start and latest end
  // across the clips that show it.
  const rounds = useMemo(() => {
    const byNumber = new Map<number, { number: number; start: number; end: number; result: "won" | "lost" | "draw" | null }>();
    // A full recording knows every round; otherwise piece them together
    // from the clips.
    const sources = clips.some((c) => c.full && c.rounds?.length) ? clips.filter((c) => c.full) : clips;
    for (const c of sources) {
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

  /** Round games (Valorant, CS2): jump to the start of a round, in the full
   * recording or in the first clip that shows it. */
  function goToRound(r: { start: number; end: number }) {
    const play = !video.current?.paused;
    if (full && r.start >= full.start && r.start <= full.end) return choose(clips.indexOf(full), (r.start - full.start) / 1000, play);
    const covering = clips.findIndex((c) => c !== full && c.start <= r.start && c.end > r.start);
    if (covering >= 0) return choose(covering, (r.start - clips[covering].start) / 1000, play);
    const inside = clips.findIndex((c) => c !== full && c.start >= r.start && c.start < r.end);
    if (inside >= 0) choose(inside, 0, play);
  }

  function stepRound(dir: 1 | -1) {
    if (!rounds.length) return;
    const at = source.start + (video.current?.currentTime ?? now) * 1000;
    // The round the playhead is in, or the last one that started before it.
    let here = -1;
    rounds.forEach((r, i) => { if (r.start <= at) here = i; });
    goToRound(rounds[Math.max(0, Math.min(rounds.length - 1, here + dir))]);
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
      // Round games step by round; one-game titles by clip.
      else if (e.key === "[" || e.key === "]") { e.preventDefault(); if (rounds.length) stepRound(e.key === "]" ? 1 : -1); else jump(e.key === "]" ? 1 : -1); }
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
  const currentRound = rounds.find((r) => nowAt >= r.start && nowAt < r.end) ?? [...rounds].reverse().find((r) => r.start <= nowAt);
  // Keep the playing round (or clip) in view in the sidebar as play moves on.
  const sideNow = `${runIndex}:${rounds.length ? currentRound?.number : activeIdx}`;
  if (sideKey.current !== sideNow) {
    sideKey.current = sideNow;
    requestAnimationFrame(() => side.current?.querySelector<HTMLElement>(".current")?.scrollIntoView({ block: "nearest" }));
  }
  // Without a full recording there's nothing to see between clips, so the
  // clips sit side by side, sized by length, with the dead time squeezed to
  // a thin gap. With one, the timeline is the game on real time.
  const GAP_PX = 4;
  const squeeze = !full && laneW > 0 && clips.length > 1;
  const segs = (() => {
    if (!squeeze) return [];
    const out: { s: number; e: number; x: number; scale: number }[] = [];
    for (const c of [...clips].sort((a, b) => a.start - b.start)) {
      const last = out[out.length - 1];
      if (last && c.start <= last.e + 1000) last.e = Math.max(last.e, c.end);
      else out.push({ s: c.start, e: c.end, x: 0, scale: 0 });
    }
    const length = out.reduce((a, g) => a + g.e - g.s, 0);
    const scale = Math.max(0, laneW - GAP_PX * (out.length - 1)) / Math.max(1, length);
    let x = 0;
    for (const g of out) {
      g.x = x;
      g.scale = scale;
      x += (g.e - g.s) * scale + GAP_PX;
    }
    return out;
  })();
  const xAt = (ms: number) => {
    if (!squeeze) return ((ms - span.start) / span.total) * laneW;
    for (let i = 0; i < segs.length; i++) {
      const g = segs[i];
      if (ms < g.s) return i === 0 ? 0 : g.x - GAP_PX / 2;
      if (ms <= g.e) return g.x + (ms - g.s) * g.scale;
    }
    const g = segs[segs.length - 1];
    return g.x + (g.e - g.s) * g.scale;
  };
  const msAt = (x: number) => {
    if (!squeeze) return span.start + (x / Math.max(1, laneW)) * span.total;
    for (const g of segs) {
      const w = (g.e - g.s) * g.scale;
      if (x <= g.x + w + GAP_PX / 2) return g.s + Math.max(0, Math.min(w, x - g.x)) / g.scale;
    }
    return segs[segs.length - 1].e;
  };
  const L = (ms: number) => `${xAt(ms)}px`;
  const W = (from: number, to: number) => `${Math.max(1, xAt(to) - xAt(from))}px`;
  // Kills close enough to collide share a tag ("K2–4"), as in the editor.
  // A tag is about 6.5px a character plus padding; it absorbs the next kill
  // until there's room for that kill's own tag.
  const tagWidth = (from: number, to: number) => (from === to ? `K${from}` : `K${from}–${to}`).length * 6.5 + 14;
  const killTags: { x: number; first: (typeof kills)[number]; from: number; to: number }[] = [];
  [...kills].sort((a, b) => a.at - b.at).forEach((k, n) => {
    const x = xAt(k.at);
    const last = killTags[killTags.length - 1];
    if (last && x - last.x < tagWidth(last.from, n + 1) / 2 + tagWidth(n + 1, n + 1) / 2 + 3) last.to = n + 1;
    else killTags.push({ x, first: k, from: n + 1, to: n + 1 });
  });
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
          {rounds.length > 0 && (
            <div>
              <dt>Rounds</dt>
              <dd>
                {rounds.some((r) => r.result)
                  ? `${rounds.filter((r) => r.result === "won").length}–${rounds.filter((r) => r.result === "lost").length}`
                  : rounds.length}
              </dd>
            </div>
          )}
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

      <div className="st-mv-stage">
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

      {/* Round games list their rounds, like Valorant's own match timeline;
          one-game titles list their clips. */}
      <aside className="mv-side" ref={side} aria-label={rounds.length ? "Rounds" : "Clips"}>
        {rounds.length > 0 ? (
          <>
            <div className="mv-side-head">
              <span>Rounds</span>
              <span className="mono">{rounds.length}</span>
            </div>
            {rounds.map((r) => {
              const k = kills.filter((x) => x.at >= r.start && x.at < r.end).length;
              const clipped = parts.some(({ c }) => c.start < r.end && c.end > r.start);
              const isCurrent = currentRound?.number === r.number;
              return (
                <button key={r.number} type="button" className={`mv-round-row ${r.result ?? ""} ${isCurrent ? "current" : ""}`} aria-current={isCurrent ? "true" : undefined} onClick={() => goToRound(r)}>
                  <span className="mono mv-round-num">{r.number}</span>
                  <span className="mv-round-result">{r.result ? RESULT[r.result] : "—"}</span>
                  <span className="mv-round-kills">{k > 0 && <><Crosshair size={11} weight="bold" />{k}</>}</span>
                  <span className="mv-round-clip" title={clipped ? "Has a clip" : undefined}>{clipped && <FilmStrip size={12} />}</span>
                </button>
              );
            })}
          </>
        ) : (
          <>
            <div className="mv-side-head">
              <span>Clips</span>
              <span className="mono">{parts.length}</span>
            </div>
            {clips.map((c, i) => ({ c, i })).sort((a, b) => Number(b.c === full) - Number(a.c === full)).map(({ c, i }) => (
              <button key={c.clip.path} type="button" className={`mv-clip-row ${i === activeIdx ? "current" : ""}`} aria-current={i === activeIdx ? "true" : undefined} onClick={() => choose(i, 0, playing)}>
                {c.thumb ? <img src={convertFileSrc(c.thumb)} alt="" draggable={false} /> : <span className="mv-clip-blank" />}
                <span className="mv-clip-text">
                  <strong>{c === full ? "Full match" : c.title}</strong>
                  <small>{run.clockStart ? `${gameClock(c.start)} in game` : clock(c.start)} · {mmss((c.end - c.start) / 1000)}</small>
                </span>
                {(markers[c.clip.path]?.length ?? 0) > 0 && c !== full && <span className="mv-clip-kills mono">{markers[c.clip.path].length}K</span>}
              </button>
            ))}
          </>
        )}
      </aside>
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
        {rounds.length > 0 && (
          <div className="mv-round-step" role="group" aria-label="Rounds">
            <button type="button" className="tx-btn" aria-label="Previous round" title="Previous round ([)" onClick={() => stepRound(-1)}><CaretLeft size={13} weight="bold" /></button>
            <span className="mono">{currentRound ? `Round ${currentRound.number}` : "Round –"}<small> of {rounds[rounds.length - 1].number}</small></span>
            <button type="button" className="tx-btn" aria-label="Next round" title="Next round (])" onClick={() => stepRound(1)}><CaretRight size={13} weight="bold" /></button>
          </div>
        )}
        <button type="button" className="tx-toggle" aria-pressed={starred(active.clip.path)} onClick={() => onStar(active.clip)}>
          <Star size={13} weight={starred(active.clip.path) ? "fill" : "regular"} /> {starred(active.clip.path) ? "Starred" : "Star"}
        </button>
        <button type="button" className="tx-toggle" onClick={() => onEdit(active.clip)}><Scissors size={13} /> {active === full ? "Edit match" : "Edit clip"}</button>
      </div>

      <div className="mvt" aria-label="Game timeline">
        <div className="mvt-labels">
          <div className="mvt-ruler-spacer" />
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
            seekToTime(msAt(e.clientX - r.left));
          }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            e.stopPropagation();
            jump(e.key === "ArrowRight" ? 1 : -1);
          }}
        >
          <div className="mvt-ruler" aria-hidden="true">
            {rounds.length > 0
              ? rounds.map((r, n) => {
                  // Number every round that has room; with dozens of rounds,
                  // every fifth (and the current one).
                  const w = ((r.end - r.start) / span.total) * laneW;
                  const show = w >= 20 || r.number % 5 === 0 || n === 0 || currentRound?.number === r.number;
                  return (
                    <span key={r.number} className={`mvt-rnum ${r.result ?? ""} ${currentRound?.number === r.number ? "current" : ""}`} style={{ left: L(r.start), width: W(r.start, r.end) }}>
                      {show && <small>{r.number}</small>}
                    </span>
                  );
                })
              : squeeze
                ? (() => {
                    let lastLabel = -Infinity;
                    return segs.map((g) => {
                      const label = g.x - lastLabel >= 64 && g.x < laneW - 70;
                      if (label) lastLabel = g.x;
                      return (
                        <span key={g.s} className="mvt-tick" style={{ left: g.x }}>
                          {label && <small>{run.clockStart ? gameClock(g.s) : clock(g.s)}</small>}
                        </span>
                      );
                    });
                  })()
                : minuteMarks((span.start - zero) / 60_000, (span.end - zero) / 60_000)
                    .filter((m) => zero + m * 60_000 - span.start < span.total * 0.94)
                    .map((m) => (
                      <span key={m} className="mvt-tick" style={{ left: L(zero + m * 60_000) }}>
                        <small>{run.clockStart ? `${m}:00` : `${m}m`}</small>
                      </span>
                    ))}
            {rounds.length === 0 && <span className="mvt-end">{run.clockStart ? gameClock(span.end) : clock(span.end)}</span>}
          </div>

          {segs.slice(1).map((g, i) => {
            const gap = g.s - segs[i].e;
            return (
              <span key={`gap-${g.s}`} className="mvt-gap" style={{ left: g.x - GAP_PX, width: GAP_PX }} title={`${Math.max(1, Math.round(gap / 60_000))} min between clips`} aria-hidden="true" />
            );
          })}

          {/* Rounds as alternating sections behind all lanes (Riot's replay
              viewer does the same); a click on a section is a seek. */}
          {rounds.map((r, n) => (
            <span
              key={`col-${r.number}`}
              className={`mvt-rcol ${n % 2 ? "odd" : ""} ${currentRound?.number === r.number ? "current" : ""}`}
              style={{ left: L(r.start), width: W(r.start, r.end) }}
              aria-hidden="true"
            />
          ))}

          <div className="mvt-lane mvt-clips-row">
            {parts.map(({ c, i }) => (
              <button
                key={c.clip.path}
                type="button"
                className={`mvt-clip ${i === activeIdx ? "active" : ""}`}
                style={{ left: L(c.start), width: W(c.start, c.end) }}
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
              const left = xAt(c.start);
              const width = Math.max(2, xAt(c.end) - left);
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
                <div key={c.clip.path} className="mvt-footage" style={{ left: L(c.start), width: W(c.start, c.end) }}>
                  {wave && <img src={convertFileSrc(wave)} alt="" draggable={false} />}
                </div>
              );
            })}
          </div>

          <div className="mvt-lane mvt-kills-row">
            {killTags.map(({ x, first: k, from, to }) => (
              <button
                key={`${k.i}-${k.t}`}
                type="button"
                className="mvt-kill"
                style={{ left: x }}
                aria-label={`${from === to ? `Kill ${from}` : `Kills ${from} to ${to}`} at ${run.clockStart ? gameClock(k.at) : clock(k.at)}. Jump there`}
                title={`${from === to ? "Kill" : `${to - from + 1} kills`} · ${run.clockStart ? `${gameClock(k.at)} in game` : clock(k.at)}`}
                onClick={() => choose(k.i, Math.max(0, k.t - 2), true)}
              >
                {from === to ? `K${from}` : `K${from}–${to}`}
              </button>
            ))}
          </div>

          <div className="mvt-playhead" style={{ left: L(nowAt) }}>
            <span />
          </div>
        </div>
      </div>
    </section>
  );
}
