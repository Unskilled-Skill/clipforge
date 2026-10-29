import { useEffect, useMemo, useState } from "react";
import { MatchView, type MatchRun } from "./MatchView";
import { convertFileSrc, invoke } from "./tauri-shim";
import { sessionPlaybackClips } from "./session-playback";
import { recordingMatchLabel } from "./match-presentation";
import type { ClipInfo, RecordingMetadata, ThumbInfo } from "./types";

/** Recent sessions use the same player and highlight browser as match rows. */
export function SessionView({ clip, game, metadata, clips, thumbnails, allMetadata, markerCounts, durationHint, starred, onStar, onBack, onEdit }: {
  clip: ClipInfo; game: string; metadata?: RecordingMetadata;
  clips: ClipInfo[]; thumbnails: Record<string, ThumbInfo>; allMetadata: Record<string, RecordingMetadata>; markerCounts: Record<string, number>;
  durationHint: number; starred: (path: string) => boolean;
  onStar: (clip: ClipInfo) => void; onBack: () => void; onEdit: (clip: ClipInfo, range?: [number, number]) => void;
}) {
  const [markers, setMarkers] = useState<number[]>([]);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [duration, setDuration] = useState(durationHint);
  useEffect(() => { if (durationHint > 0) setDuration(durationHint); }, [durationHint]);
  useEffect(() => {
    let cancelled = false;
    setError(false);
    invoke<number[]>("load_markers", { input: clip.path })
      .then((times) => { if (!cancelled) setMarkers(times ?? []); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [clip.path, retry]);
  const runs = useMemo<MatchRun[]>(() => [{
    key: clip.path, label: `${game} · ${recordingMatchLabel(metadata) || "Full match"}`, meta: "",
    result: metadata?.matches.length === 1 ? metadata.matches[0].info.result ?? undefined : undefined,
    playerStats: metadata?.matches.length === 1 ? metadata.matches[0].info.player_stats : undefined,
    clockStart: metadata?.matches.length === 1 ? (metadata.matches[0].info.clock_start ?? 0) * 1000 || undefined : undefined,
    clips: sessionPlaybackClips(clip, clips, thumbnails, allMetadata, markerCounts, duration, markers),
  }], [clip, clips, thumbnails, allMetadata, markerCounts, duration, markers, game, metadata]);
  if (duration <= 0) return <section className="st-session-view">
    <button className="st-ghost" onClick={onBack}>Library</button>
    <p className="st-session-note" role="status">Loading recording…</p>
    <video hidden preload="metadata" src={convertFileSrc(clip.path)} onLoadedMetadata={(e) => { if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration); }} onError={() => setError(true)} />
    {error && <p role="alert">Could not load this recording. <button className="st-ghost" onClick={() => onEdit(clip)}>Open editor</button></p>}
  </section>;
  return <>
    {error && <p className="st-session-note" role="alert">Could not load kill markers. <button className="st-ghost" onClick={() => setRetry((value) => value + 1)}>Retry</button></p>}
    <MatchView runs={runs} initialRun={0} game={game}
      starred={starred}
      onStar={onStar} onBack={onBack} onEdit={onEdit} />
  </>;
}
