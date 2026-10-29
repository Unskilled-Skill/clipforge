import type { ClipInfo, RecordingMetadata, ThumbInfo } from "./types";
import type { MatchClip } from "./MatchView";
import { recordingSessionKey } from "./library-groups.ts";
import { momentTitle } from "./clip-presentation.ts";
import { sessionMoments } from "./studio-data.ts";

/** One session's playback entries, shared by the sidebar and match browser. */
export function sessionPlaybackClips(source: ClipInfo, clips: ClipInfo[], thumbnails: Record<string, ThumbInfo>, metadata: Record<string, RecordingMetadata>, markerCounts: Record<string, number>, duration: number, markers: number[]): MatchClip[] {
  const family = recordingSessionKey(source.name);
  const stamp = family?.split("|")[1];
  const stampedStart = stamp ? new Date(`${stamp.slice(0, 10)}T${stamp.slice(11).replace(/-/g, ":")}`).getTime() : NaN;
  const stampFits = Number.isFinite(stampedStart) && Math.abs(stampedStart + duration * 1000 - source.modified_ms) <= 120_000;
  const start = stampFits ? stampedStart : source.modified_ms - duration * 1000;
  const full: MatchClip = { clip: source, title: "Full match", start, end: start + duration * 1000, thumb: thumbnails[source.path]?.thumb ?? null, full: true, rounds: metadata[source.path]?.rounds };
  const ids = new Set(metadata[source.path]?.matches.map((match) => match.info.id) ?? []);
  const folder = source.path.replace(/\\/g, "/").replace(/\/[^/]+$/, "").toLowerCase();
  const related = clips.filter((clip) => {
    if (clip.path === source.path || metadata[clip.path]?.is_session || / Session \d{4}-/.test(clip.name)) return false;
    if (metadata[clip.path]?.matches.some((match) => ids.has(match.info.id))) return true;
    return !!family && recordingSessionKey(clip.name) === family && clip.path.replace(/\\/g, "/").replace(/\/[^/]+$/, "").toLowerCase() === folder;
  }).sort((a, b) => a.modified_ms - b.modified_ms);
  if (related.length) return [full, ...related.map((clip): MatchClip => ({ clip, title: momentTitle(clip.name, markerCounts[clip.path] ?? 0), start: clip.modified_ms - (thumbnails[clip.path]?.duration ?? 30) * 1000, end: clip.modified_ms, thumb: thumbnails[clip.path]?.thumb ?? null, rounds: metadata[clip.path]?.rounds }))];
  // Markers still provide a watchable sequence when no clips were cut.
  return [full, ...sessionMoments(markers, duration).map((moment, index): MatchClip => ({
    id: `${source.path}#moment-${index}`, clip: source,
    title: `${moment.times.length} kill${moment.times.length === 1 ? "" : "s"}`,
    start: start + moment.start * 1000, end: start + moment.end * 1000,
    thumb: null, posterAt: moment.times[0] / duration,
    range: [moment.start, moment.end], markerTimes: moment.times.map((time) => time - moment.start),
  }))];
}
