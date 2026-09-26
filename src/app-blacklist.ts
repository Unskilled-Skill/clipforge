export function blacklistApp<T extends { game_exes: string[]; game_blacklist: string[] }>(settings: T, raw: string): T {
  const exe = raw.trim().replace(/^"|"$/g, "").split(/[\\/]/).pop()?.trim().toLowerCase() ?? "";
  if (!/^[^<>:"|?*\x00-\x1f]+\.exe$/.test(exe)) {
    throw new Error("Enter an app executable, such as spotify.exe, or browse for its .exe file.");
  }
  if (isDiscordApp(exe)) throw new Error("Discord is already excluded from video capture.");
  return {
    ...settings,
    game_exes: settings.game_exes.filter((g) => g.trim().toLowerCase() !== exe),
    game_blacklist: [...new Set([...settings.game_blacklist.map((g) => g.trim().toLowerCase()), exe])],
  };
}
export function isDiscordApp(exe: string): boolean {
  return ["discord.exe", "discordptb.exe", "discordcanary.exe"].includes(exe.trim().toLowerCase());
}
