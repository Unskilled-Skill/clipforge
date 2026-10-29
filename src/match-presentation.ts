import type { MatchInfo, RecordingMetadata, PlayerStats } from "./types";
const MAPS: Record<string,string> = { de_dust2:"Dust II", de_nuke:"Nuke", de_mirage:"Mirage", de_inferno:"Inferno", de_ancient:"Ancient", de_anubis:"Anubis", de_train:"Train", de_overpass:"Overpass", de_vertigo:"Vertigo" };
/** League modes saved under their internal names before ClipForge named them. */
const MODES: Record<string, string> = { Kiwi: "ARAM: Mayhem", Cherry: "Arena", Strawberry: "Swarm", Ultbook: "Ultimate Spellbook", Oneforall: "One for All", Doombotsteemo: "Doom Bots" };

/** The player's line for the match band. The champion is shown with its
 * portrait, not here. Modes without lanes or wards (ARAM, Arena) report
 * CS and vision as 0, so a 0 there means "not tracked" and is left out. */
export function matchPlayerFacts(stats: PlayerStats | null | undefined): { label: string; value: string }[] {
  if (!stats) return [];
  const facts: { label: string; value: string }[] = [];
  if ([stats.kills,stats.deaths,stats.assists].every(value => value != null && Number.isFinite(value))) {
    facts.push({label:"K / D / A",value:`${stats.kills} / ${stats.deaths} / ${stats.assists}`});
  }
  for (const [label,value,zeroMeansUntracked] of [["CS",stats.cs,true],["Gold",stats.gold,false],["Damage",stats.champion_damage,false],["Vision",stats.vision_score,true]] as const) {
    if (value != null && Number.isFinite(value) && !(zeroMeansUntracked && value === 0)) facts.push({label,value:value.toLocaleString()});
  }
  return facts;
}

/** A match label without its result, for places that show the result apart. */
export function withoutResult(label: string): string {
  return label.split(" · ").map(part => part.replace(/^(?:Won|Lost|Draw)(?: |$)/, "")).filter(Boolean).join(" · ");
}

export function matchLabel(info: MatchInfo): string {
  const result=info.result ? {won:"Won",lost:"Lost",draw:"Draw"}[info.result] : "";
  const score=info.score ? `${info.score.won}–${info.score.lost}` : "";
  return [info.map ? MAPS[info.map] ?? info.map : "", info.mode ? MODES[info.mode] ?? info.mode : null, [result,score].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
}
export function roundLabel(metadata: RecordingMetadata | undefined, at=0): string {
  const round=metadata?.rounds.find(r=>r.start<=at && r.end>at);
  return round ? `Round ${round.number}` : "";
}
export function recordingMatchLabel(metadata: RecordingMetadata | undefined): string {
  if (!metadata?.matches.length) return "";
  return metadata.matches.length === 1 ? matchLabel(metadata.matches[0].info) : `${metadata.matches.length} matches`;
}
