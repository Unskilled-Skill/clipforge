import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Scissors, Warning } from "@phosphor-icons/react";
import { convertFileSrc, invoke } from "./tauri-shim";
import { sessionEntries, type SessionMoment } from "./studio-data";
import { recordingMatchLabel } from "./match-presentation";
import type { ClipInfo, RecordingMetadata } from "./types";

const time = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
export function SessionView({ clip, game, metadata, durationHint, starred, onStar, onBack, onEdit }: {
  clip: ClipInfo; game: string; metadata?: RecordingMetadata; durationHint: number; starred: boolean;
  onStar: () => void; onBack: () => void; onEdit: (range?: [number, number]) => void;
}) {
  const [duration, setDuration] = useState(durationHint);
  const [markers, setMarkers] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState(false);
  const [picked, setPicked] = useState(0);
  const [now, setNow] = useState(0);
  const [retry, setRetry] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const container = useRef<HTMLElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const moments = useMemo(() => sessionEntries(markers, duration, metadata), [markers, duration,metadata]);
  const hasRounds=!!metadata?.rounds.length;
  const currentMatch=metadata?.matches.length===1 ? metadata.matches[0].info : null;
  const active = moments[Math.min(picked, moments.length - 1)];
  useEffect(() => { container.current?.focus(); }, []);
  useEffect(() => { setPicked(index => Math.min(index, Math.max(0, moments.length - 1))); }, [moments.length]);
  useEffect(() => { if (duration <= 0 && durationHint > 0) setDuration(durationHint); }, [duration, durationHint]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    invoke<number[]>("load_markers", { input: clip.path })
      .then(m => { if (!cancelled) setMarkers(m ?? []); })
      .catch(e => { if (!cancelled) setError(`Could not load saved kill markers: ${String(e)}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [clip.path, retry]);
  function choose(index: number) {
    const next = moments[index];
    if (!next) return;
    setPicked(index);
    const v = video.current;
    if (v && v.readyState >= 1) v.currentTime = next.start;
    else { pendingSeek.current = next.start; v?.load(); }
  }
  function editMoment(moment: SessionMoment) { onEdit([moment.start, moment.end]); }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (document.querySelector('[aria-modal="true"]') || target.closest("input, textarea, select, video, [contenteditable=true]")) return;
      if (e.key === " " && target.closest("button, a, summary")) return;
      if (e.key === "Escape") { e.preventDefault(); onBack(); }
      else if (e.key === " ") { e.preventDefault(); if (video.current?.paused) void video.current.play().catch(() => {}); else video.current?.pause(); }
      else if (e.key === "[" || e.key === "]") { e.preventDefault(); choose(Math.max(0, Math.min(moments.length - 1, picked + (e.key === "]" ? 1 : -1)))); }
      else if (e.key.toLowerCase() === "c" && !e.ctrlKey && !e.metaKey && active) { e.preventDefault(); editMoment(active); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const kills = new Set(markers.filter(t => Number.isFinite(t) && t >= 0 && (duration <= 0 || t < duration))).size;
  return <section className="st-session-view" aria-label="Full session" ref={container} tabIndex={-1}>
    <header className="st-session-header">
      <button className="st-ghost" onClick={onBack}><ArrowLeft size={14} /> Library</button>
      <div><h1>{game} · Full session</h1>{metadata?.matches.length ? <span className="st-match-context">{recordingMatchLabel(metadata)}</span> : null}<span>{new Date(clip.modified_ms).toLocaleString()} · {clip.name}</span></div>
      <button className="st-ghost" onClick={onStar}>{starred ? "Starred" : "Star session"}</button>
      <button className="st-ghost" onClick={() => onEdit()}><Scissors size={14} /> Edit session</button>
    </header>
    <div className="st-session-content">
      <dl className="st-session-facts"><div><dt>Length</dt><dd>{duration ? time(duration) : "Loading…"}</dd></div><div><dt>Kills marked</dt><dd>{loading ? "Loading…" : error ? "Unavailable" : kills}</dd></div><div><dt>{hasRounds?"Rounds captured":"Moments"}</dt><dd>{loading ? "Loading…" : error ? "Unavailable" : moments.length}</dd></div><div><dt>File size</dt><dd>{(clip.size_bytes / 1024 ** 3).toFixed(2)} GB</dd></div><div><dt>Result</dt><dd>{currentMatch?.result ? {won:"Won",lost:"Lost",draw:"Draw"}[currentMatch.result] : "Not reported"}</dd></div></dl>
      <div className="st-session-player">
        <video ref={video} src={convertFileSrc(clip.path)} controls preload="metadata" aria-label={`Preview full session: ${game}`} onError={() => setMediaError(true)}
          onLoadedMetadata={e => {
            if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
            setMediaError(e.currentTarget.videoWidth === 0);
            if (pendingSeek.current !== null) { e.currentTarget.currentTime = pendingSeek.current; pendingSeek.current = null; }
          }} onTimeUpdate={e => setNow(e.currentTarget.currentTime)} />
        {mediaError && <div className="st-session-media-error"><Warning size={18} /><span>This player can’t preview the recording. Open the editor to convert it for preview; your kill markers are still available.</span><button className="st-ghost" onClick={() => onEdit()}>Open editor</button></div>}
      </div>
      <div className="st-session-moment-bar" aria-label="Session moments">
        <span>{time(now)} / {time(duration)}</span>
        <div>{moments.map((moment, i) => <button key={`${moment.match_id??"moment"}-${moment.start}`} className={`${i === picked ? "active" : ""} ${moment.result??""}`} aria-label={`Jump to ${moment.label.toLowerCase()}, ${moment.times.length} kills at ${time(moment.start)}`} aria-pressed={i === picked} onClick={() => choose(i)}>{moment.round ?? i+1}<small>{moment.result ? {won:"W",lost:"L",draw:"D"}[moment.result] : ""} {moment.times.length}K</small></button>)}</div>
        <button className="st-ghost" disabled={!moments.length || picked <= 0} onClick={() => choose(picked - 1)} aria-label="Previous moment"><ArrowLeft size={14} /></button>
        <button className="st-ghost" disabled={!moments.length || picked >= moments.length - 1} onClick={() => choose(picked + 1)} aria-label="Next moment"><ArrowRight size={14} /></button>
      </div>
      <div className="st-session-moments-head"><h2>{hasRounds?"Rounds":"Moments"}</h2><span>{hasRounds ? "Source-reported rounds. Select one to jump or make a clip of its recorded portion." : "Kills close together form one moment. Clips include 10 seconds before and 3 seconds after."}</span></div>
      {loading ? <p className="st-session-note" role="status">Loading saved kill markers…</p> : error ? <div className="st-session-note" role="alert">{error} <button className="st-ghost" onClick={() => setRetry(n => n + 1)}>Retry</button></div> : duration <= 0 ? <p className="st-session-note">The recording’s length is unavailable. Open the editor to inspect it before making a clip.</p> : moments.length === 0 ? <p className="st-session-note">No kills were marked in this recording. Use Edit session to select any moment yourself.</p> : <table className="st-moment-table"><thead><tr><th>{hasRounds?"Round":"Moment"}</th><th>Kills</th><th>Result</th><th>Selection</th><th>Action</th></tr></thead><tbody>{moments.map((moment, i) => <tr key={`${moment.match_id??"moment"}-${moment.start}`} className={i === picked ? "active" : ""}><td><button onClick={() => choose(i)}>{moment.label}</button></td><td>{moment.times.length}K</td><td className={`st-result-${moment.result??"unknown"}`}>{moment.result ? {won:"Won",lost:"Lost",draw:"Draw"}[moment.result] : "—"}</td><td>{time(moment.start)} → {time(moment.end)}</td><td><button className="st-ghost" onClick={() => editMoment(moment)}><Scissors size={13} /> Make clip</button></td></tr>)}</tbody></table>}
      {!metadata?.matches.length && <p className="st-session-note">Map, round and result data weren’t recorded for this file. Match data comes from CS2’s Game State Integration.</p>}
      <p className="st-session-note">Full sessions count toward your storage cap. Star this one to protect it from automatic cleanup.</p>
    </div>
    <footer className="st-session-footer"><span><kbd>Space</kbd> play</span><span><kbd>[ ]</kbd> previous/next moment</span><span><kbd>C</kbd> clip selected moment</span></footer>
  </section>;
}
