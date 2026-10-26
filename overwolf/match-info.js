// Whitelist match context. Never forward rosters, names, chat or account data.
globalThis.ClipForgeMatchInfo = (() => {
  const keys = ["map", "game_mode", "round_number", "score", "round_phase", "match_outcome", "pseudo_match_id", "match_id"];
  const parse = value => { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return null; } };
  function merge(previous, update) {
    const incoming = update?.info?.match_info ?? (update?.category === "match_info" && update.key ? { [update.key]: update.value ?? update.data } : {});
    const patch = {};
    for (const key of keys) {
      const value = incoming[key];
      if (value === undefined || value === null) continue;
      if (key === "game_mode") {
        const mode = parse(value);
        if (mode && typeof mode === "object") patch[key] = { mode: String(mode.mode ?? "").slice(0, 80), custom: mode.custom === true, ranked: String(mode.ranked ?? "") };
      } else if (key === "score") {
        const score = parse(value);
        if (score && [score.won, score.lost].every(n => Number.isInteger(Number(n)) && Number(n) >= 0 && Number(n) <= 10000)) patch[key] = { won: Number(score.won), lost: Number(score.lost) };
      } else if (key === "round_number") {
        const round = Number(value);
        if (Number.isInteger(round) && round > 0 && round < 10000) patch[key] = round;
      } else if (typeof value === "string" && value.trim() && value.length <= 160) patch[key] = value.trim();
    }
    const changedMap = patch.map && previous.map && patch.map !== previous.map;
    const changedId = patch.pseudo_match_id && previous.pseudo_match_id && patch.pseudo_match_id !== previous.pseudo_match_id;
    const ended = previous.round_phase === "game_end" || ["victory", "defeat", "draw"].includes(previous.match_outcome);
    const newRound = ended && ["shopping", "combat"].includes(patch.round_phase);
    const base = changedMap || changedId ? {} : newRound ? { map: previous.map, game_mode: previous.game_mode } : previous;
    return { ...base, ...patch };
  }
  return { merge };
})();
