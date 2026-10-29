// League champion portraits from Riot's public Data Dragon CDN. The latest
// version and the champion table (display name -> image id: "Kai'Sa" ->
// "Kaisa", "Wukong" -> "MonkeyKing") are fetched once and cached for a week.
// Offline, or for a name the table doesn't know, the fallback shows instead.

import { useEffect, useState, type ReactNode } from "react";

const CDN = "https://ddragon.leagueoflegends.com";
const CACHE = "clipforge.ddragon";
type Table = { version: string; ids: Record<string, string>; at: number };

export const championKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

let table: Promise<Table | null> | null = null;
function loadTable(): Promise<Table | null> {
  table ??= (async () => {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE) ?? "null") as Table | null;
      if (cached && Date.now() - cached.at < 7 * 86_400_000) return cached;
    } catch { /* no storage: fetch */ }
    try {
      const [version] = (await fetch(`${CDN}/api/versions.json`).then((r) => r.json())) as string[];
      const data = (await fetch(`${CDN}/cdn/${version}/data/en_US/champion.json`).then((r) => r.json())) as { data: Record<string, { id: string; name: string }> };
      const fresh: Table = { version, ids: Object.fromEntries(Object.values(data.data).map((c) => [championKey(c.name), c.id])), at: Date.now() };
      try { localStorage.setItem(CACHE, JSON.stringify(fresh)); } catch { /* fine uncached */ }
      return fresh;
    } catch {
      table = null; // offline: try again next time a portrait is wanted
      return null;
    }
  })();
  return table;
}

export function ChampionIcon({ name, size, fallback }: { name: string; size: number; fallback?: ReactNode }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSrc(null); setFailed(false);
    void loadTable().then((t) => {
      const id = t?.ids[championKey(name)];
      if (!cancelled && t && id) setSrc(`${CDN}/cdn/${t.version}/img/champion/${id}.png`);
    });
    return () => { cancelled = true; };
  }, [name]);
  if (!src || failed) {
    return fallback ? <>{fallback}</> : <span className="mv-champ mv-champ-blank" style={{ width: size, height: size }} aria-hidden="true">{name.slice(0, 1)}</span>;
  }
  return <img className="mv-champ" src={src} width={size} height={size} alt="" draggable={false} onError={() => setFailed(true)} />;
}
