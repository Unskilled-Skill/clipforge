// Watch a match or browse its highlights. Editing stays in the editor.
// A full recording remains the playback source when available; otherwise
// the player runs through the saved clips in sequence.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatDate } from "./format-date";
import { ArrowLeft, CaretLeft, CaretRight, Crosshair, FilmStrip, Pause, Play, Scissors, SkipBack, SkipForward, Star } from "@phosphor-icons/react";
import { convertFileSrc, invoke } from "./tauri-shim";
import { HighlightStrip } from "./HighlightStrip";
import { matchPlayerFacts, withoutResult } from "./match-presentation";
import { ChampionIcon } from "./champion-icon";
import { matchesHighlightSearch } from "./clip-presentation";
import { killEvents, playingHighlightIndex, alignGeneratedHighlights } from "./kill-overview";
import { KillOverview } from "./KillOverview";
import type { ClipInfo, PlayerStats } from "./types";

export type MatchClip = {
  id?: string;
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
  /** Virtual highlights seek the full source and edit only this range. */
  range?: [number, number];
  markerTimes?: number[];
  posterAt?: number;
};

export type MatchRun = {
  key: string;
  label: string;
  meta: string;
  result?: "won" | "lost" | "draw";
  playerStats?: PlayerStats | null;
  /** When the game's own clock read 0:00 (ms), for games with one (League). */
  clockStart?: number;
  clips: MatchClip[];
};

const clock = (ms: number) => formatDate(ms, { hour: "numeric", minute: "2-digit" });
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const RESULT = { won: "Won", lost: "Lost", draw: "Draw" } as const;

export function MatchView({ runs, initialRun, game, icon, starred, onStar, onEdit, onBack }: {
  runs: MatchRun[];
  initialRun: number;
  game: string;
  icon?: ReactNode;
  starred: (path: string) => boolean;
  onStar: (clip: ClipInfo) => void;
  onEdit: (clip: ClipInfo, range?: [number, number]) => void;
  onBack: () => void;
}) {
  const [runIndex, setRunIndex] = useState(Math.min(Math.max(0, initialRun), runs.length - 1));
  const run = runs[runIndex];
  const rawClips = run?.clips ?? [];
  const [picked, setPicked] = useState(0);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [highlightSearch, setHighlightSearch] = useState("");
  const [multikillsOnly, setMultikillsOnly] = useState(false);
  const [markers, setMarkers] = useState<Record<string, number[]>>({});
  const clips = useMemo(() => alignGeneratedHighlights(rawClips, markers), [rawClips, markers]);
  const video = useRef<HTMLVideoElement>(null);
  const side = useRef<HTMLElement>(null);
  const sideKey = useRef("");
  const pendingSeek = useRef<number | null>(null);
  const keepPlaying = useRef(false);
  const current = clips[Math.min(picked, clips.length - 1)];
  // A full match recording, when there is one, is what plays.
  const full = clips.find((c) => c.full);
  const source = full ?? current;

  useEffect(() => {
    setPicked(0);
    setNow(0);
    setHighlightSearch(""); setMultikillsOnly(false);
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

  // The game on real time: from the first clip's start to the last one's end.
  const span = useMemo(() => {
    if (!clips.length) return { start: 0, end: 1, total: 1 };
    const start = Math.min(...clips.map((c) => c.start));
    const end = Math.max(...clips.map((c) => c.end));
    return { start, end, total: Math.max(1000, end - start) };
  }, [clips]);
  // A full recording already holds every kill; the clips repeat them.
  const kills = killEvents(clips, markers);
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
  // Deaths and assists come on the game's clock; without one they can't be placed.
  const moments = run?.clockStart == null ? [] : [
    ...(run.playerStats?.deaths_at ?? []).map((t) => ({ at: zero + t * 1000, kind: "death" as const })),
    ...(run.playerStats?.assists_at ?? []).map((t) => ({ at: zero + t * 1000, kind: "assist" as const })),
  ].sort((a, b) => a.at - b.at);

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

  /** Step to the previous or next clip; over a full recording, to the
   * clip before or after the playhead. */
  function jump(dir: 1 | -1) {
    if (!full) return choose(Math.max(0, Math.min(clips.length - 1, picked + dir)), 0, !video.current?.paused);
    const at = full.start + (video.current?.currentTime ?? now) * 1000;
    const parts = clips.map((c, i) => ({ c, i })).filter(({ c }) => c !== full);
    const target = dir > 0 ? parts.find(({ c }) => c.start > at + 500) : [...parts].reverse().find(({ c }) => c.start < at - 2000);
    if (target) choose(target.i, 0, !video.current?.paused);
  }

  function seekMatch(at: number) {
    if (full) return choose(clips.indexOf(full), Math.max(0, Math.min((full.end - full.start) / 1000, (at - full.start) / 1000)), playing);
    const inside = clips.findIndex(c => at >= c.start && at <= c.end);
    const index = inside >= 0 ? inside : clips.findIndex(c => c.start > at);
    const target = index >= 0 ? index : clips.length - 1;
    choose(target, inside >= 0 ? (at - clips[target].start) / 1000 : 0, playing);
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
  const title = withoutResult(run.label.split(" · ").slice(1).join(" · ") || run.label);
  const champion = run.playerStats?.champion ?? undefined;
  const playerFacts = matchPlayerFacts(run.playerStats);
  // What's on screen: over a full recording, the clip the playhead is in
  // (or the recording itself between clips).
  const activeIdx = playingHighlightIndex(clips, picked, nowAt);
  const active = clips[activeIdx] ?? current;
  const currentRound = rounds.find((r) => nowAt >= r.start && nowAt < r.end) ?? [...rounds].reverse().find((r) => r.start <= nowAt);
  // Keep the playing round (or clip) in view in the sidebar as play moves on.
  // The kill playing now: from 3 s before it until 3 s before the next.
  const currentKill = kills.findIndex((k, n) => nowAt >= k.at - 3000 && nowAt < (kills[n + 1]?.at ?? k.at + 8000) - 3000);
  const sideNow = `${runIndex}:${rounds.length ? currentRound?.number : kills.length ? currentKill : activeIdx}`;
  if (sideKey.current !== sideNow) {
    sideKey.current = sideNow;
    requestAnimationFrame(() => side.current?.querySelector<HTMLElement>(".current")?.scrollIntoView({ block: "nearest" }));
  }
  // Highlight entries retain their original playback indices.
  const parts = clips.map((c, i) => ({ c, i })).filter(({ c }) => c !== full);
  const browsable = parts.length ? parts : clips.map((c, i) => ({ c, i }));
  const visibleIndices = new Set(browsable.filter(({ c }) => matchesHighlightSearch(c.clip.name, c.title, (c.markerTimes ?? markers[c.clip.path])?.length ?? 0, highlightSearch, multikillsOnly, run.clockStart ? `${gameClock(c.start)} in game` : clock(c.start))).map(({ i }) => i));
  const filtering = highlightSearch.trim().length > 0 || multikillsOnly;
  const overviewKills = kills.filter(k => !filtering || (k.highlightIndex != null ? visibleIndices.has(k.highlightIndex) : !parts.length && visibleIndices.has(k.i)));

  return (
    <section className="st-session-view st-mv" aria-label={`${game} match`}>
      {/* One band: who you played, how it went, and the match facts. */}
      <header className="st-mv-head">
        <button className="st-ghost" onClick={onBack}><ArrowLeft size={14} /> Library</button>
        <div className="st-mv-title">
          {champion ? <ChampionIcon name={champion} size={36} fallback={icon} /> : icon}
          <h1>{champion ?? game}<span>{champion ? `${game} · ${title}` : title}</span></h1>
          {run.result && <span className={`mv-result-chip ${run.result}`}>{RESULT[run.result]}</span>}
        </div>
        <dl className="st-mv-stats">
          {playerFacts.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
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
          {/* K / D / A already counts the kills. */}
          {!playerFacts.some((f) => f.label === "K / D / A") && <div><dt>Kills</dt><dd>{kills.length}</dd></div>}
          <div><dt>Length</dt><dd>{span.total >= 3_600_000 ? `${(span.total / 3_600_000).toFixed(1)} h` : `${Math.max(1, Math.round(span.total / 60_000))} min`}</dd></div>
          <div className="st-mv-played"><dt>{run.playerStats && !run.playerStats.finalized ? "Last live snapshot" : "Played"}</dt><dd>{formatDate(span.start, { month: "short", day: "numeric" })}, {clock(span.start)}</dd></div>
        </dl>
      </header>

      {runs.length > 1 && (
        <nav className="st-mv-tabs" aria-label={`${game} matches`}>
          {runs.map((r, i) => {
            // Matches of one mode read alike; lead with what differs.
            const p = r.playerStats;
            const kda = p && p.kills != null && p.deaths != null && p.assists != null ? `${p.kills} / ${p.deaths} / ${p.assists}` : null;
            const started = r.clips.length ? clock(Math.min(...r.clips.map((c) => c.start))) : "";
            return (
              <button key={r.key} className={i === runIndex ? "active" : ""} aria-current={i === runIndex ? "true" : undefined} onClick={() => setRunIndex(i)}>
                {p?.champion && <ChampionIcon name={p.champion} size={28} />}
                <span>
                  <strong>{p?.champion ?? withoutResult(r.label.split(" · ").slice(1).join(" · ") || r.label)}{r.result && <em className={r.result}>{RESULT[r.result]}</em>}</strong>
                  <small>{[kda, started, kda ? null : r.meta].filter(Boolean).join(" · ")}</small>
                </span>
              </button>
            );
          })}
        </nav>
      )}

      <div className="st-mv-stage">
      <div className="st-mv-player">
        <video
          ref={video}
          key={source.clip.path}
          src={convertFileSrc(source.clip.path)}
          poster={source.thumb ? convertFileSrc(source.thumb) : undefined}
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

      {/* Beside the video: rounds for round games, otherwise the kill feed
          (or the clips, when no kills were marked). */}
      <aside className="mv-side" ref={side} aria-label={rounds.length ? "Rounds" : kills.length ? "Kills" : "Clips"}>
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
        ) : kills.length > 0 ? (
          <>
            <div className="mv-side-head">
              <span>Kill feed</span>
              <span className="mono">{kills.length}</span>
            </div>
            {kills.map((k, n) => {
              const index = k.highlightIndex ?? k.i;
              const owner = clips[index];
              const isCurrent = n === currentKill;
              return (
                <button key={`${k.at}-${n}`} type="button" className={`mv-kill-row ${isCurrent ? "current" : ""}`} aria-current={isCurrent ? "true" : undefined}
                  onClick={() => { const offset = (k.at - owner.start) / 1000 - 3; choose(index, full ? offset : Math.max(0, offset), playing); }}>
                  <span className="mono mv-kill-time">{gameClock(k.at)}</span>
                  <Crosshair size={12} weight="bold" className="mv-kill-mark" />
                  <span className="mv-kill-text">Kill {n + 1}</span>
                  {k.highlightIndex != null && owner !== full && <span className="mv-kill-clip"><FilmStrip size={12} />{owner.title.split(" · ").slice(1).join(" · ") || owner.title}</span>}
                </button>
              );
            })}
          </>
        ) : (
          <>
            <div className="mv-side-head">
              <span>Clips</span>
              <span className="mono">{browsable.length}</span>
            </div>
            {browsable.map(({ c, i }) => (
              <button key={c.id ?? c.clip.path} type="button" className={`mv-clip-row ${i === activeIdx ? "current" : ""}`} aria-current={i === activeIdx ? "true" : undefined} onClick={() => choose(i, 0, true)}>
                {c.thumb ? <img src={convertFileSrc(c.thumb)} alt="" draggable={false} /> : <span className="mv-clip-blank" />}
                <span className="mv-clip-text"><strong>{c.full ? "Full match" : c.title}</strong><small>{run.clockStart ? `${gameClock(c.start)} in game` : clock(c.start)}</small></span>
              </button>
            ))}
          </>
        )}
      </aside>
      </div>

      {/* Same toolbar as the editor: clock, what's playing, transport, actions. */}
      <div className="tx-bar st-mv-bar">
        <span className="tx-clock mono">{mmss(now)}</span>
        <span className="tx-total mono">/ {mmss((source.end - source.start) / 1000)}</span>
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
        <button type="button" className="tx-toggle" onClick={() => onEdit(active.clip, active.range)}><Scissors size={13} /> {active === full ? "Edit match" : "Edit clip"}</button>
      </div>

      <KillOverview key={`overview-${run.key}`} clips={clips} events={overviewKills} allCount={kills.length}
        start={span.start} end={span.end} zero={zero} moments={moments} nowAt={nowAt} activeIndex={activeIdx} visibleIndices={visibleIndices} rounds={rounds}
        onChoose={event => {
          const index = event.highlightIndex ?? event.i;
          const offset = (event.at - clips[index].start) / 1000 - 3;
          choose(index, full ? offset : Math.max(0, offset), playing);
        }} onSeek={seekMatch} />
      <HighlightStrip key={run.key} clips={browsable}
        activeIndex={activeIdx} nowAt={nowAt} markers={markers}
        search={highlightSearch} multikillsOnly={multikillsOnly} onSearchChange={setHighlightSearch} onMultikillsOnlyChange={setMultikillsOnly}
        timeLabel={(ms) => run.clockStart ? `${gameClock(ms)} in game` : clock(ms)}
        onChoose={(index, at = 0) => choose(index, at, true)} />
    </section>
  );
}
