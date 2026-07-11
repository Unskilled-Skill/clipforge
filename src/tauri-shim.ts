// Thin indirection over the Tauri APIs so the UI can also run in a plain
// browser (vite dev without Tauri) with mock data for design work.
import { convertFileSrc as realConvert, invoke as realInvoke } from "@tauri-apps/api/core";
import { listen as realListen } from "@tauri-apps/api/event";

const inTauri = "__TAURI_INTERNALS__" in window;

const mockSettings = {
  host: "localhost",
  port: 4455,
  password: "hunter2",
  clips_dir: "D:/RECORDINGS/Clips",
  auto_connect: true,
  game_exes: ["cs2.exe", "valorant-win64-shipping.exe", "rainbowsix.exe"],
  auto_launch_obs: true,
  auto_manage_buffer: true,
  obs_path: "C:/Program Files/obs-studio/bin/64bit/obs64.exe",
  hotkey_save: "alt+f10",
  hotkey_short: "shift+alt+f10",
  short_clip_seconds: 30,
  max_storage_gb: 100,
  auto_clip: false,
  auto_clip_delay_s: 8,
};

let mockFavorites: string[] = [];

const games = ["Valorant", "Rainbowsix", "Marathon", "Cs2", "Apex"];
const mockClips = Array.from({ length: 14 }, (_, i) => ({
  path: `D:/RECORDINGS/Clips/mock-${i}.mp4`,
  name: `${games[i % games.length]} 2026-07-0${(i % 7) + 1} 2${i % 10}-1${i % 6}-0${i % 9}.mp4`,
  modified_ms: Date.now() - i * 3600_000 * 5,
  size_bytes: 120_000_000 + i * 37_000_000,
}));

const mockThumbs = Object.fromEntries(
  mockClips.map((c, i) => [c.path, { thumb: `mock://thumb-${i}`, duration: 34 + i * 11 }])
);

async function mockInvoke(cmd: string, _args?: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "load_settings":
      return mockSettings;
    case "list_clips":
      return mockClips;
    case "gen_thumbnails":
      return mockThumbs;
    case "analyze_black":
      return { is_black: Math.random() < 0.3 };
    case "obs_connect":
      return { connected: true, replay_buffer_active: false, obs_version: "31.0.3" };
    case "load_favorites":
      return mockFavorites;
    case "toggle_favorite": {
      const p = (_args as { path: string }).path;
      mockFavorites = mockFavorites.includes(p)
        ? mockFavorites.filter((x) => x !== p)
        : [...mockFavorites, p];
      return mockFavorites;
    }
    case "list_audio_tracks":
      return 3;
    case "gen_waveform":
      return "mock://waveform";
    case "export_montage":
    case "export_gif":
    case "export_frame":
      return "D:/RECORDINGS/Clips/mock-out.mp4";
    case "rename_clip":
      return `D:/RECORDINGS/Clips/${(_args as { newName: string }).newName}.mp4`;
    case "setup_status":
      return { obs_installed: true, ffmpeg_installed: true };
    case "winget_install":
      return null;
    default:
      return null;
  }
}

export const invoke: typeof realInvoke = inTauri
  ? realInvoke
  : (mockInvoke as typeof realInvoke);

export const convertFileSrc: typeof realConvert = inTauri
  ? realConvert
  : (p: string) =>
      `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#1b1f2e"/><rect x="0" y="120" width="320" height="60" fill="#141824"/><circle cx="${(p.length * 37) % 280 + 20}" cy="80" r="26" fill="#2c3350"/></svg>`
      )}`;

export const listen: typeof realListen = inTauri
  ? realListen
  : ((() => Promise.resolve(() => {})) as typeof realListen);

export const isTauri = inTauri;
