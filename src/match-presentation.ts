import type { MatchInfo, RecordingMetadata } from "./types";
const MAPS: Record<string,string> = { de_dust2:"Dust II", de_nuke:"Nuke", de_mirage:"Mirage", de_inferno:"Inferno", de_ancient:"Ancient", de_anubis:"Anubis", de_train:"Train", de_overpass:"Overpass", de_vertigo:"Vertigo" };
export function matchLabel(info: MatchInfo): string {
  const result=info.result ? {won:"Won",lost:"Lost",draw:"Draw"}[info.result] : "";
  const score=info.score ? `${info.score.won}–${info.score.lost}` : "";
  return [info.map ? MAPS[info.map] ?? info.map : "", info.mode, [result,score].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
}
export function roundLabel(metadata: RecordingMetadata | undefined, at=0): string {
  const round=metadata?.rounds.find(r=>r.start<=at && r.end>at);
  return round ? `Round ${round.number}` : "";
}
export function recordingMatchLabel(metadata: RecordingMetadata | undefined): string {
  if (!metadata?.matches.length) return "";
  return metadata.matches.length === 1 ? matchLabel(metadata.matches[0].info) : `${metadata.matches.length} matches`;
}
