import type { MatchClip } from "./MatchView";
import { recordingSessionKey } from "./library-groups.ts";

/** Older generated clips were stamped at save time. Recover their source
 * positions only when the complete ordered bookmark sequence agrees. */
export function alignGeneratedHighlights(clips: MatchClip[], markers: Record<string, number[]>): MatchClip[] {
  const full = clips.find(c => c.full);
  if (!full) return clips;
  const family = recordingSessionKey(full.clip.name);
  const times = [...new Set((markers[full.clip.path] ?? []).filter(t => Number.isFinite(t) && t >= 0 && t * 1000 <= full.end - full.start))].sort((a, b) => a - b);
  if (!family || !times.length) return clips;
  const folder = (path: string) => path.replace(/\\/g, "/").replace(/\/[^/]+$/, "").toLowerCase();
  const generated = clips.map((c, i) => ({ c, i, order: Number(c.clip.name.match(/ \((\d+)\)\.(?:mp4|mkv)$/i)?.[1]) }))
    .filter(({ c }) => !c.full && !c.range && recordingSessionKey(c.clip.name) === family && folder(c.clip.path) === folder(full.clip.path))
    .sort((a, b) => a.order - b.order);
  if (!generated.length || generated.some((g, i) => g.order !== i + 1)) return clips;
  let offset = 0;
  const replacements = new Map<number, MatchClip>();
  for (const { c, i } of generated) {
    const local = [...new Set((markers[c.clip.path] ?? []).filter(t => Number.isFinite(t) && t >= 0 && t * 1000 <= c.end - c.start))].sort((a, b) => a - b);
    if (!local.length || offset + local.length > times.length) return clips;
    const from = times[offset];
    if (local.some((t, n) => Math.abs((t - local[0]) - (times[offset + n] - from)) > 0.1)) return clips;
    const start = full.start + (from - local[0]) * 1000;
    if (start < full.start - 100 || start + c.end - c.start > full.end + 2000) return clips;
    replacements.set(i, { ...c, start, end: start + c.end - c.start });
    offset += local.length;
  }
  if (offset !== times.length) return clips;
  return clips.map((c, i) => replacements.get(i) ?? c);
}

export type KillEvent = { at: number; i: number; t: number; number: number; highlightIndex: number | null };
export function killEvents(clips: MatchClip[], markers: Record<string, number[]>): KillEvent[] {
  const full = clips.findIndex(c => c.full);
  const valid = (c: MatchClip, times: number[]) => times.filter(t => Number.isFinite(t) && t >= 0 && t * 1000 <= c.end - c.start);
  const fullTimes = full >= 0 ? valid(clips[full], markers[clips[full].clip.path] ?? []) : [];
  const sources = fullTimes.length ? [{ c: clips[full], i: full, times: fullTimes }] : clips.map((c, i) => ({ c, i, times: c.full ? [] : valid(c, c.markerTimes ?? markers[c.clip.path] ?? []) }));
  const seen = new Set<number>();
  return sources.flatMap(({ c, i, times }) => times.map(t => ({ at: c.start + t * 1000, i, t })))
    .sort((a, b) => a.at - b.at).filter(k => {
      const key = Math.round(k.at / 10);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).map((k, index) => ({ ...k, number: index + 1, highlightIndex: (() => {
      const found = !clips[k.i].full ? k.i : clips.findIndex(c => !c.full && k.at >= c.start && k.at <= c.end);
      return found < 0 ? null : found;
    })() }));
}

export function playingHighlightIndex(clips: MatchClip[], preferred: number, at: number): number {
  const full = clips.findIndex(c => c.full);
  if (full < 0) return preferred;
  const picked = clips[preferred];
  if (picked && !picked.full && at >= picked.start - 3000 && at <= picked.end) return preferred;
  const inside = clips.findIndex(c => !c.full && at >= c.start && at <= c.end);
  return inside < 0 ? full : inside;
}

export function clusterKills<T extends { at: number }>(events: T[], start: number, end: number, width: number): { events: T[]; x: number }[] {
  if (width <= 0 || end <= start) return [];
  const groups: { events: T[]; x: number }[] = [];
  for (const event of events.filter(k => k.at >= start && k.at <= end).sort((a, b) => a.at - b.at)) {
    const x = (event.at - start) / (end - start) * width;
    const prior = groups[groups.length - 1];
    if (prior && x - prior.x < 52) prior.events.push(event);
    else groups.push({ events: [event], x });
  }
  return groups;
}

export function adjacentKill<T extends { at: number; number: number }>(events: T[], at: number, direction: 1 | -1, selected?: number | null): T | null {
  const index = events.findIndex(k => k.number === selected && Math.abs(k.at - at) <= 5000);
  if (index >= 0) return events[index + direction] ?? null;
  return direction === 1 ? events.find(k => k.at > at + 250) ?? null : [...events].reverse().find(k => k.at < at - 1000) ?? null;
}

export function zoomWindow(min: number, max: number, start: number, end: number, anchor: number, factor: number): { start: number; end: number } {
  const length = Math.min(max - min, Math.max(Math.min(30_000, max - min), (end - start) / factor));
  const left = Math.max(min, Math.min(max - length, anchor - length / 2));
  return { start: left, end: left + length };
}

/** Clock ticks for the visible stretch: whole minutes (or finer, zoomed in)
 * counted from `zero`, spaced at least `minGap` px apart. */
export function clockTicks(start: number, end: number, zero: number, width: number, minGap = 64): number[] {
  if (width <= 0 || end <= start) return [];
  const steps = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map(s => s * 1000);
  const step = steps.find(s => s / (end - start) * width >= minGap) ?? steps[steps.length - 1];
  const ticks: number[] = [];
  for (let at = zero + Math.ceil((start - zero) / step) * step; at <= end; at += step) ticks.push(at);
  return ticks;
}
