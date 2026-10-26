const GAMES: Record<string, string> = {
  cs2: "Counter-Strike 2", rainbowsix: "Rainbow Six Siege", r6: "Rainbow Six Siege",
  apex: "Apex Legends", r5apex: "Apex Legends", rocketleague: "Rocket League",
  valorant: "Valorant", overwatch: "Overwatch", marathon: "Marathon",
  arenabreakout: "Arena Breakout", fortnite: "Fortnite", hunt: "Hunt: Showdown",
  lol: "League of Legends", "league of legends": "League of Legends", deeprock: "Deep Rock Galactic",
  hunger: "Hunger", r5apex_dx12: "Apex Legends", fortniteclient: "Fortnite",
  rainbowsix_dx11: "Rainbow Six Siege", rainbowsix_be: "Rainbow Six Siege",
};
export function gameName(raw: string) {
  const name = raw.replace(/\.exe$/i, "").replace(/-win(?:32|64)-shipping$/i, "");
  return GAMES[name.toLowerCase()] ?? name;
}
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
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// Edits are named after their source plus a suffix per step
// ("…_trim_12-30_discord.mp4"): title them by source and what was done.
function editTitle(name: string, kills: number): string | null {
  let stem = name.replace(/\.[^.]+$/, "");
  if (/^Montage_/.test(stem)) return "Montage";
  const steps: string[] = [];
  for (;;) {
    let m: RegExpMatchArray | null;
    if ((m = stem.match(/^(.*)_discord$/))) steps.unshift("Discord export");
    else if ((m = stem.match(/^(.*)_trim_(\d+)-(\d+)$/))) steps.unshift(`Trim ${clock(+m[2])}–${clock(+m[3])}`);
    else if ((m = stem.match(/^(.*)_gif$/))) steps.unshift("GIF");
    else if ((m = stem.match(/^(.*)_frame_(\d+)$/))) steps.unshift(`Frame at ${clock(+m[2])}`);
    else break;
    stem = m[1];
  }
  if (!steps.length) return null;
  const source = momentTitle(`${stem}.mp4`, kills).replace(/ · Saved clip$/, "");
  return `${source} · ${steps.join(" · ")}`;
}

export function momentTitle(name: string, kills: number): string {
  const edit = editTitle(name, kills);
  if (edit) return edit;
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
