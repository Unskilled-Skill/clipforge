// Pure timeline math: time <-> pixels, ruler ticks, snapping. No DOM.

export function toX(t: number, duration: number, width: number): number {
  return duration > 0 ? (t / duration) * Math.max(width, 1) : 0;
}

export function toTime(x: number, duration: number, width: number): number {
  if (duration <= 0 || width <= 0) return 0;
  return Math.min(Math.max(x / width, 0), 1) * duration;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** "m:ss" for ruler labels. */
export function fmtTime(t: number): string {
  const s = Math.round(t);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// [major step (s), minor divisions]: the smallest step whose majors sit at
// least MIN_MAJOR_PX apart wins, so labels never collide at any zoom.
const STEPS: [number, number][] = [
  [1, 10], [2, 4], [5, 5], [10, 5], [15, 3], [30, 6], [60, 6], [120, 4], [300, 5], [600, 5], [1800, 6],
];
const MIN_MAJOR_PX = 90;

export interface Tick {
  x: number;
  major: boolean;
  label: string;
}

/** Ticks for a ruler `width` px wide, only those within [from, to] px. */
export function rulerTicks(duration: number, width: number, from = 0, to = width): Tick[] {
  if (duration <= 0 || width <= 0) return [];
  const pps = width / duration;
  const [step, minors] = STEPS.find(([s]) => s * pps >= MIN_MAJOR_PX) ?? [3600, 6];
  const majorPx = step * pps;
  const minorPx = majorPx / minors;
  const out: Tick[] = [];
  const first = Math.max(0, Math.floor(from / minorPx));
  const last = Math.min(Math.ceil(to / minorPx), Math.floor(width / minorPx));
  for (let i = first; i <= last; i++) {
    const x = i * minorPx;
    const major = i % minors === 0;
    // A label right at the end would be clipped; the clip length shows elsewhere.
    const label = major && x < width - 24 ? fmtTime(i * (step / minors)) : "";
    out.push({ x, major, label });
  }
  return out;
}

/**
 * Magnetic snap with hysteresis: within `inPx` of a target the value sticks
 * to it, and stays stuck until it moves `outPx` away (no jitter at the edge).
 * Returns the snapped time and the target it's latched to (or null).
 */
export function snapTime(
  t: number,
  targets: number[],
  latched: number | null,
  pxPerSec: number,
  inPx = 10,
  outPx = 18,
): { t: number; latched: number | null } {
  if (latched != null && Math.abs(t - latched) * pxPerSec <= outPx) return { t: latched, latched };
  let best: number | null = null;
  for (const target of targets) {
    const d = Math.abs(t - target) * pxPerSec;
    if (d <= inPx && (best == null || d < Math.abs(t - best) * pxPerSec)) best = target;
  }
  return best == null ? { t, latched: null } : { t: best, latched: best };
}
