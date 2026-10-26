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
import { openUrl as realOpenUrl } from "@tauri-apps/plugin-opener";
import type { MatchInfo, RecordingMetadata } from "./types";

const inTauri = "__TAURI_INTERNALS__" in window;

const mockSettings = {
  clips_dir: "D:/RECORDINGS/Clips",
  game_exes: ["cs2.exe", "valorant-win64-shipping.exe", "rainbowsix.exe"],
  game_blacklist: [],
  window_capture_games: [],
  mic_noise_suppression: true,
  run_elevated: false,
  admin_rule: "ask",
  admin_rule_games: { "valorant-win64-shipping.exe": "auto" },
  discord_target_mb: 10,
  vc_exe: "discord.exe",
  vc_exes: [],
  other_apps: [],
  audio_mix: "everything",
  mic_device: "default",
  output_device: "default",
  export_tracks: [0],
  record_tracks: [0, 1, 2, 3, 4],
  launch_at_login: true,
  auto_manage_buffer: true,
  hotkey_save: "alt+f10",
  hotkey_short: "shift+alt+f10",
  short_clip_seconds: 30,
  max_storage_gb: 100,
  backup_dir: "F:/My Drive/Media/Clips",
  catbox_userhash: "",
  auto_clip: false,
  auto_clip_delay_s: 8,
  auto_clip_min_kills: 1,
  auto_clip_games: {},
  session_recording: false,
  replay_seconds: 180,
  video_fps: 60,
  video_height: 0,
  bitrate_mbps: 0,
  encoder_pref: "auto",
};

const mockDefaults = structuredClone(mockSettings);
let mockFavorites: string[] = [];
const mockDeleted = new Map<string, (typeof mockClips)[number]>();

const games = ["Valorant", "Rainbowsix", "Marathon", "Cs2", "Apex"];
// Browser-only fixtures for checking the first-run and capture-problem boards.
const mockPreview = new URLSearchParams(location.search).get("preview");
const mockClips = Array.from({ length: mockPreview === "empty" ? 0 : 14 }, (_, i) => ({
  path: `D:/RECORDINGS/Clips/mock-${i}.mp4`,
  name: `${i === 12 ? "Valorant" : games[i % games.length]} ${i >= 12 ? "Session " : ""}2026-07-0${(i % 7) + 1} 2${i % 10}-1${i % 6}-0${i % 9}.mp4`,
  modified_ms: Date.now() - i * 3600_000 * 5,
  size_bytes: 120_000_000 + i * 37_000_000,
}));

const mockThumbs = Object.fromEntries(
  mockClips.map((c, i) => [c.path, { thumb: `mock://thumb-${i}`, duration: 34 + i * 11 }])
);

// Sample context for visual verification only; native builds read persisted sources.
function mockRecordingMetadata(input: string): RecordingMetadata | null {
  const i=Number(input.match(/mock-(\d+)/)?.[1]??-1);
  // Match data comes from CS2's Game State Integration: the CS2 clips
  // (every fifth from 3) and the CS2 full session (13).
  if (![3,8,13].includes(i)) return null;
  const info: MatchInfo={id:"demo-cs2",game:"cs2.exe",source:"cs2-gsi",map:"de_nuke",mode:"Competitive",score:{won:13,lost:9},result:"won",round_results:{"4":"won","9":"won","13":"lost","17":"won"}};
  const bounds=[0,9,20,30,39.066667];
  const rounds=i>=12 ? [4,9,13,17].map((number,j)=>({match_id:info.id,number,start:bounds[j],end:bounds[j+1],result:info.round_results[String(number)]})) : [{match_id:info.id,number:9,start:0,end:mockThumbs[input]?.duration??34,result:info.round_results["9"]}];
  return {version:1,is_session:i>=12,matches:[{start:0,end:i>=12?39.066667:mockThumbs[input]?.duration??34,info}],rounds};
}

async function mockInvoke(cmd: string, _args?: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "list_recording_metadata":
      return Object.fromEntries(((_args?.inputs??[]) as string[]).map(input=>[input,mockRecordingMetadata(input)]).filter(([,data])=>data));
    case "load_recording_metadata":
      return mockRecordingMetadata(String(_args?.input??""));
    case "supervisor_state":
      return mockPreview === "admin" ? {
        obs_running: true, connected: true, game: "valorant-win64-shipping.exe",
        buffer_active: false, paused: false, obs_needs_restart: false, obs_outdated: null,
        engine_downloading: false, engine_error: null, render_lag: false, encoder_lag: false,
        game_elevated: true,
      } : null;
    case "recycle_clip": {
      const path = String(_args?.path);
      const index = mockClips.findIndex((clip) => clip.path === path);
      if (index < 0) throw new Error("Clip not found");
      mockDeleted.set(path, mockClips.splice(index, 1)[0]);
      return path;
    }
    case "restore_clip": {
      const id = String(_args?.id);
      const clip = mockDeleted.get(id);
      if (!clip) throw new Error("Clip is no longer in the Recycle Bin");
      mockClips.push(clip);
      mockDeleted.delete(id);
      return null;
    }
    case "save_settings":
      Object.assign(mockSettings, structuredClone(_args?.settings));
      mockSettings.game_exes = mockSettings.game_exes.map(exe => exe.trim().toLowerCase()).filter(exe => exe && !mockSettings.game_blacklist.some((blocked: string) => blocked === exe) && !/^discord(ptb|canary)?\.exe$/.test(exe));
      return null;
    case "list_audio_devices":
      return { inputs: [{ id: "{mic-1}", name: "Mic In (Elgato Wave:3)" }, { id: "{mic-2}", name: "Headset Microphone (Arctis Nova 7X)" }], outputs: [{ id: "{out-1}", name: "Headphones (Arctis Nova 7X)" }, { id: "{out-2}", name: "Speakers (Realtek Audio)" }] };
    case "list_game_icons":
      return {};
    case "load_settings":
      return structuredClone(mockSettings);
    case "list_clips":
      return [...mockClips];
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
      return 5;
    case "clip_fps":
      return 60;
    case "audio_track_roles":
      return ["mix", "game", "voice", "desktop", "mic"];
    case "load_markers":
      // Every third mock clip has kill markers, for editor design work.
      return (_args as { input: string }).input.match(/mock-(\d+)/)?.[1] &&
        Number((_args as { input: string }).input.match(/mock-(\d+)/)![1]) % 3 === 0
        ? [4.2, 11.9, 12.6, 13.4, 23.5] // a quick triple shows marker grouping
        : [];
    case "copy_clip":
      return null;
    case "gen_filmstrip":
      return "mock://filmstrip.reel20.jpg";
    case "take_update_notes":
      // Show the what's-new modal once per browser tab, like a real update.
      if (!sessionStorage.getItem("mock_whatsnew")) {
        sessionStorage.setItem("mock_whatsnew", "1");
        return {
          version: "0.1.99",
          notes: "Mock release notes: kill markers on the timeline, trim-aware montage, hover previews.",
        };
      }
      return null;
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
    case "obs_diagnostics":
      return {
        obs_connected: true,
        obs_version: "32.2.2",
        obs_outdated: false,
        output_mode: "Advanced",
        encoder: "av1_texture_amf",
        best_encoder: "av1_texture_amf",
        rate_control: "CBR",
        bitrate_kbps: 20000,
        keyint_sec: 1,
        buffer_seconds: 180,
        buffer_ram_mb: 585,
        fps: 60,
        resolution: "1920x1080",
        settings_pending: false,
        health: { render_lag_pct: 0.2, encoder_lag_pct: 0, active_fps: 60, obs_cpu_pct: 1.4 },
        disk_free_bytes: 3.2 * 1024 ** 3,
        ffmpeg_found: true,
        clips_dir_cloud: null,
      };
    case "backup_status":
      return {
        enabled: true,
        folder_ok: true,
        backed_up: 4,
        pending: 1,
        running: false,
        last_run_ms: Date.now() - 12 * 60 * 1000,
        error: null,
      };
    case "backup_now":
      return null;
    case "winget_install":
      return null;
    case "launch_obs":
      return null;
    case "set_run_elevated":
    case "restart_elevated":
    case "ensure_admin_task":
      return null;
    case "open_logs":
      return null;
    case "list_share_links":
      return [{ host: "catbox", url: "https://files.catbox.moe/abc123.mp4", start: 0, end: 30, at: 0 }];
    case "share_catbox":
      return "https://files.catbox.moe/abc123.mp4";
    case "share_streamable":
    case "save_share_link":
    case "copy_link":
      return null;
    case "is_running_elevated":
      return false;
    case "apply_obs_config":
      return null;
    case "list_running_apps":
      return [
        { exe: "minecraft.windows.exe", title: "Minecraft" },
        { exe: "chrome.exe", title: "Google Chrome" },
        { exe: "spotify.exe", title: "Spotify" },
      ];
    case "reset_settings":
      Object.assign(mockSettings, structuredClone(mockDefaults));
      return structuredClone(mockSettings);
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

// Optional real media for editor design work: drop a clip.mp4 and its
// clip.reel20.jpg into the git-ignored .mock/ folder (vite serves it).
const mockMedia = (p: string) =>
  p.endsWith(".mp4") ? "/.mock/clip.mp4" : p.includes(".reel20.jpg") ? "/.mock/clip.reel20.jpg" : null;

export const convertFileSrc: typeof realConvert = inTauri
  ? realConvert
  : (p: string) =>
      mockMedia(p) ??
      `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#1b1f2e"/><rect x="0" y="120" width="320" height="60" fill="#141824"/><circle cx="${(p.length * 37) % 280 + 20}" cy="80" r="26" fill="#2c3350"/></svg>`
      )}`;

// Browser mock: `?mock-setup` fakes a supervisor state with both OBS setup
// banners showing, so they can be designed without a real OBS.
export const listen: typeof realListen = inTauri
  ? realListen
  : (((event: string, handler: (e: { payload: unknown }) => void) => {
      if (event === "supervisor-state" && new URLSearchParams(location.search).has("mock-setup")) {
        setTimeout(() =>
          handler({
            payload: {
              obs_running: true,
              connected: false,
              game: null,
              buffer_active: false,
              paused: false,
              obs_needs_restart: true,
              obs_outdated: "29.1.3",
            },
          }),
        );
      }
      return Promise.resolve(() => {});
    }) as unknown as typeof realListen);

export const openDialog = inTauri
  ? realOpenDialog
  : async (opts?: OpenDialogOptions) =>
      opts?.directory ? "D:/RECORDINGS/Clips" : "C:/Program Files/obs-studio/bin/64bit/obs64.exe";

export const confirmDialog: typeof realConfirmDialog = inTauri
  ? realConfirmDialog
  : (async (message: string) => window.confirm(message)) as typeof realConfirmDialog;

export const getVersion: typeof realGetVersion = inTauri
  ? realGetVersion
  : (async () => "dev") as typeof realGetVersion;

export const openUrl: (url: string) => Promise<void> = inTauri
  ? realOpenUrl
  : async (url: string) => void window.open(url, "_blank", "noopener");

export const isTauri = inTauri;
