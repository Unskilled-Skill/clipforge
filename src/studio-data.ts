import type { ClipInfo, RecordingMetadata } from "./types";

export function isSessionRecording(name: string): boolean {
  return /^\S+ Session \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}(?: \(\d+\))?\.(?:mp4|mkv)$/i.test(name);
}

export function recentSessions(clips: ClipInfo[], limit = 3, metadata: Record<string,RecordingMetadata> = {}): ClipInfo[] {
  return clips.filter(c => metadata[c.path]?.is_session || isSessionRecording(c.name))
    .sort((a, b) => b.modified_ms - a.modified_ms || a.path.localeCompare(b.path))
    .slice(0, Math.max(0, limit));
}

/** Latest short recording, rather than a just-created export or full session. */
export function latestClipForExport(clips: ClipInfo[], metadata: Record<string,RecordingMetadata> = {}): ClipInfo | undefined {
  return clips.filter(c => !metadata[c.path]?.is_session && !isSessionRecording(c.name) && !/_discord\.|_trim_|_gif\.gif$|_frame_|^Montage_/i.test(c.name))
    .sort((a, b) => b.modified_ms - a.modified_ms)[0];
}

export interface SessionMoment { times: number[]; start: number; end: number }
export interface SessionEntry extends SessionMoment { label: string; result: string | null; match_id?: string; round?: number }
export function sessionEntries(markers: number[], duration: number, metadata?: RecordingMetadata): SessionEntry[] {
  const rounds=metadata?.rounds.filter(r=>Number.isFinite(r.start) && Number.isFinite(r.end) && r.end>r.start && r.start<duration && r.end>0) ?? [];
  if (!rounds.length) return sessionMoments(markers,duration).map((m,i)=>({...m,label:`Moment ${i+1}`,result:null}));
  return rounds.map(r=>({start:Math.max(0,r.start),end:Math.min(duration,r.end),times:[...new Set(markers.filter(t=>Number.isFinite(t) && t>=Math.max(0,r.start) && t<Math.min(duration,r.end)))].sort((a,b)=>a-b),label:`Round ${r.number}`,result:r.result,round:r.number,match_id:r.match_id}));
}

/** A moment covers nearby kills, with ten seconds of lead-in and three after. */
export function sessionMoments(markers: number[], duration: number): SessionMoment[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const times = [...new Set(markers.filter(t => Number.isFinite(t) && t >= 0 && t < duration))].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const t of times) {
    const last = groups[groups.length - 1];
    if (last && t - last[last.length - 1] <= 10 && t - last[0] <= 107) last.push(t);
    else groups.push([t]);
  }
  return groups.map(times => ({ times, start: Math.max(0, times[0] - 10), end: Math.min(duration, times[times.length - 1] + 3) }));
}

export function filterCommands<T extends { label: string; keywords?: string }>(items: T[], query: string): T[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return items.filter(item => words.every(word => `${item.label} ${item.keywords ?? ""}`.toLocaleLowerCase().includes(word)));
}
