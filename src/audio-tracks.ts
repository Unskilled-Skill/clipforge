// Audio tracks in a recording: what each stream holds, and which tracks
// can play together without doubling a sound. Shared by the editor and the
// match view.
import { GameController, Headset, Microphone, Monitor, MusicNotes, SpeakerHigh, Waveform } from "@phosphor-icons/react";

export type TrackMeta = { i: number; role?: string; label: string; Icon: typeof SpeakerHigh };

/// What each audio stream of a clip holds, in stream order. Clips skip
/// tracks that were switched off or had nothing to record, so a stream's
/// position alone doesn't say what it is.
export type TrackRole = "mix" | "game" | "voice" | "desktop" | "mic" | "other" | "track";

/// Track ids used by settings (export_tracks, record_tracks) → role.
export const ROLE_OF_ID: TrackRole[] = ["mix", "game", "voice", "desktop", "mic", "other"];

export const ROLE_META: Record<TrackRole, { label: string; Icon: typeof SpeakerHigh }> = {
  mix: { label: "mix", Icon: SpeakerHigh },
  game: { label: "game", Icon: GameController },
  voice: { label: "voice", Icon: Headset },
  desktop: { label: "desktop", Icon: Monitor },
  mic: { label: "mic", Icon: Microphone },
  other: { label: "other apps", Icon: MusicNotes },
  track: { label: "track", Icon: Waveform },
};

/// Roles whose sound another role also holds: the mix holds everything,
/// desktop holds the game, voice chat and other apps.
export function roleOverlaps(role: TrackRole): TrackRole[] {
  if (role === "mix") return ["game", "voice", "desktop", "mic", "other", "track"];
  if (role === "desktop") return ["mix", "game", "voice", "other"];
  if (role === "game" || role === "voice" || role === "other") return ["mix", "desktop"];
  return ["mix"];
}

/// Check stream `track` and uncheck everything that would double its sound.
export function keepTrack(prev: Set<number>, track: number, roles: TrackRole[]): Set<number> {
  const clash = roleOverlaps(roles[track] ?? "track");
  const next = new Set([...prev].filter((t) => !clash.includes(roles[t] ?? "track")));
  next.add(track);
  return next;
}

/// Drop broad tracks (mix, then desktop) that overlap a kept specific one.
export function withoutOverlaps(keep: Set<number>, roles: TrackRole[]): Set<number> {
  const next = new Set([...keep].filter((t) => t < Math.max(roles.length, 1)));
  if (next.size > 1) for (const t of [...next]) if (roles[t] === "mix") next.delete(t);
  if ([...next].some((t) => ["game", "voice", "other"].includes(roles[t]))) for (const t of [...next]) if (roles[t] === "desktop") next.delete(t);
  return next.size ? next : new Set([0]);
}

/// Settings track ids → this clip's stream indices (ids it lacks drop out).
export function streamsForIds(ids: number[], roles: TrackRole[]): number[] {
  const streams = ids.map((id) => roles.indexOf(ROLE_OF_ID[id])).filter((i) => i >= 0);
  return streams.length ? streams : [0];
}

export function trackLabels(roles: TrackRole[]): TrackMeta[] {
  if (roles.length <= 1) return [{ i: 0, label: "audio", Icon: SpeakerHigh }];
  return roles.map((role, i) => ({ i, role, ...ROLE_META[role], label: role === "track" ? `track ${i + 1}` : ROLE_META[role].label }));
}
