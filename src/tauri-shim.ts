// Thin indirection over the Tauri APIs so the UI can also run in a plain
// browser (vite dev without Tauri) with mock data for design work.
import { convertFileSrc as realConvert, invoke as realInvoke } from "@tauri-apps/api/core";
import { listen as realListen } from "@tauri-apps/api/event";
import { getVersion as realGetVersion } from "@tauri-apps/api/app";
import {
  confirm as realConfirmDialog,
  open as realOpenDialog,
  type OpenDialogOptions,
} from "@tauri-apps/plugin-dialog";

const inTauri = "__TAURI_INTERNALS__" in window;

const mockSettings = {
  host: "localhost",
  port: 4455,
  password: "hunter2",
  clips_dir: "D:/RECORDINGS/Clips",
  auto_connect: true,
  game_exes: ["cs2.exe", "valorant-win64-shipping.exe", "rainbowsix.exe"],
  game_blacklist: [],
  vc_exe: "discord.exe",
  auto_launch_obs: true,
  auto_manage_buffer: true,
  obs_path: "C:/Program Files/obs-studio/bin/64bit/obs64.exe",
  hotkey_save: "alt+f10",
  hotkey_short: "shift+alt+f10",
  short_clip_seconds: 30,
  max_storage_gb: 100,
  auto_clip: false,
  auto_clip_delay_s: 8,
  replay_seconds: 180,
  video_fps: 60,
  video_height: 0,
  bitrate_mbps: 20,
  encoder_pref: "auto",
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
    case "load_markers":
      // Every third mock clip has kill markers, for editor design work.
      return (_args as { input: string }).input.match(/mock-(\d+)/)?.[1] &&
        Number((_args as { input: string }).input.match(/mock-(\d+)/)![1]) % 3 === 0
        ? [4.2, 11.9, 23.5]
        : [];
    case "copy_clip":
      return null;
    case "gen_filmstrip":
      return "mock://filmstrip";
    case "disk_free":
      return 3_400_000_000; // low on purpose — shows the warning banner in dev
    case "gen_waveform":
      return "mock://waveform";
    case "gen_waveforms":
      return [0, 1, 2, 3, 4].map((track) => ({ track, waveform: `mock://wave-${track}` }));
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
    case "launch_obs":
      return null;
    case "apply_obs_config":
      return null;
    case "list_running_apps":
      return [
        { exe: "minecraft.windows.exe", title: "Minecraft" },
        { exe: "chrome.exe", title: "Google Chrome" },
        { exe: "spotify.exe", title: "Spotify" },
      ];
    case "reset_settings":
      return mockSettings;
    case "remove_watched_game":
      return mockSettings;
    case "list_game_capture_sources":
      return [] as { exe: string; kind: string }[];
    case "add_game_capture_source":
      return null;
    case "test_capture_source":
      return { capturing: true };
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

export const openDialog = inTauri
  ? realOpenDialog
  : async (opts?: OpenDialogOptions) =>
      opts?.directory ? "D:/RECORDINGS/Clips" : "C:/Program Files/obs-studio/bin/64bit/obs64.exe";

export const confirmDialog: typeof realConfirmDialog = inTauri
  ? realConfirmDialog
  : (async () => true) as typeof realConfirmDialog;

export const getVersion: typeof realGetVersion = inTauri
  ? realGetVersion
  : (async () => "dev") as typeof realGetVersion;

export const isTauri = inTauri;
