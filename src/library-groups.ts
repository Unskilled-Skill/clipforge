// How the library groups clips by time. Recent clips get fine groups
// (days), older ones coarser (weeks, then months, then years), so the list
// stays short however long you've been clipping. Sessions split on gaps in
// play instead of on the calendar.

export type Bucket = {
  key: string;
  label: string;
  /** Within the last week: shown open by default. Older groups start folded. */
  recent: boolean;
};

const DAY_MS = 86_400_000;
/** A pause in clipping longer than this starts a new play session. */
export const SESSION_GAP_MS = 2 * 60 * 60 * 1000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole calendar days from `ms` to `now` (0 = today). */
function daysAgo(ms: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
}

function dayLabel(ms: number, now: number): string {
  const ago = daysAgo(ms, now);
  if (ago === 0) return "Today";
  if (ago === 1) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

/** The time group a clip saved at `ms` falls in, seen from `now`: days for
 * the last week, weeks for the rest of this month, months for the rest of
 * this year, then years. */
export function dateBucket(ms: number, now: number): Bucket {
  const d = new Date(ms);
  const today = new Date(now);
  const ago = daysAgo(ms, now);
  if (ago < 7) return { key: `d:${d.toDateString()}`, label: dayLabel(ms, now), recent: true };
  if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth()) {
    // Weeks start on Monday.
    const monday = new Date(startOfDay(ms));
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return {
      key: `w:${monday.toDateString()}`,
      label: `Week of ${monday.toLocaleDateString(undefined, { month: "long", day: "numeric" })}`,
      recent: false,
    };
  }
  if (d.getFullYear() === today.getFullYear()) {
    return { key: `m:${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString(undefined, { month: "long" }), recent: false };
  }
  return { key: `y:${d.getFullYear()}`, label: String(d.getFullYear()), recent: false };
}

function partOfDay(hour: number): string {
  if (hour < 5) return "night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 22) return "evening";
  return "night";
}

/** "This evening", "Last night", "Yesterday afternoon", "Tuesday night", "October 12, morning". */
export function sessionLabel(startMs: number, now: number): string {
  const ago = daysAgo(startMs, now);
  const part = partOfDay(new Date(startMs).getHours());
  if (ago === 0) {
    // Before 5 a.m. is the night that just ended; after 10 p.m., this one.
    if (part === "night") return new Date(startMs).getHours() < 5 ? "Last night" : "Tonight";
    return `This ${part}`;
  }
  if (ago === 1) return `Yesterday ${part}`;
  const d = new Date(startMs);
  if (ago < 7) return `${d.toLocaleDateString(undefined, { weekday: "long" })} ${part}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const date = d.toLocaleDateString(undefined, sameYear ? { month: "long", day: "numeric" } : { year: "numeric", month: "long", day: "numeric" });
  return `${date}, ${part}`;
}

/** Split clip save times (newest first) into play sessions: a new one
 * starts after a gap longer than `gapMs`. Returns each clip's session index. */
export function sessionIndices(timesNewestFirst: number[], gapMs = SESSION_GAP_MS): number[] {
  let session = 0;
  return timesNewestFirst.map((t, i) => {
    if (i > 0 && timesNewestFirst[i - 1] - t > gapMs) session++;
    return session;
  });
}
