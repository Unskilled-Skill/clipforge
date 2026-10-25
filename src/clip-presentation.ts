const GAMES: Record<string, string> = {
  cs2: "Counter-Strike 2", rainbowsix: "Rainbow Six Siege", r6: "Rainbow Six Siege",
  apex: "Apex Legends", r5apex: "Apex Legends", rocketleague: "Rocket League",
  valorant: "Valorant", overwatch: "Overwatch", marathon: "Marathon",
  arenabreakout: "Arena Breakout", fortnite: "Fortnite", hunt: "Hunt: Showdown",
  lol: "League of Legends", deeprock: "Deep Rock Galactic",
};
export function gameName(raw: string) { return GAMES[raw.toLowerCase()] ?? raw; }
// Only names written by the recorder establish highlight labels. A custom
// title containing "ACE" does not, and five markers alone are not an ace.
function recording(name: string) {
  return name.match(/^(\S+) (?:(Session|ACE|[2-9]\d*K) )?\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}(?: \(\d+\))?\.(?:mp4|mkv)$/i);
}
export function clipKillCount(name: string, markers = 0) {
  const label = recording(name)?.[2];
  const labelled = label && /^\d+K$/i.test(label) ? Number.parseInt(label, 10) : 0;
  // An ACE recording can contain only the finishing kills of a round.
  return Math.max(markers, labelled);
}
export function killBadge(count: number, name = "") {
  if (recording(name)?.[2]?.toUpperCase() === "ACE") return "ACE";
  const kills = clipKillCount(name, count);
  return kills > 1 ? `${kills}K` : kills === 1 ? "1 kill" : null;
}
export function momentTitle(name: string, kills: number) {
  const match = recording(name);
  if (!match) return name.replace(/\.[^.]+$/, "");
  const label = match[2]?.toUpperCase();
  const count = clipKillCount(name, kills);
  const moment = label === "SESSION" ? "Full session" : label === "ACE" ? "Ace finish" : count ? `${count} kill${count === 1 ? "" : "s"}` : "Saved clip";
  return `${gameName(match[1])} · ${moment}`;
}
export function matchesClipSearch(name: string, game: string, markers: number, search: string) {
  const text = `${name} ${gameName(game)} ${momentTitle(name, markers)} ${killBadge(markers, name) ?? ""}`;
  return text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
}
