// Shared shapes between App and the extracted panels. Field names mirror the
// Rust structs (serde) — keep snake_case.

export interface ObsStatus {
  connected: boolean;
  replay_buffer_active: boolean;
  obs_version: string | null;
}

export interface AudioDevice {
  id: string;
  name: string;
}

export interface AudioDevices {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
}

export interface Settings {
  clips_dir: string;
  game_exes: string[];
  game_blacklist: string[];
  window_capture_games: string[];
  mic_noise_suppression: boolean;
  run_elevated: boolean;
  admin_rule: string;
  admin_rule_games: Record<string, string>;
  discord_target_mb: number;
  vc_exe: string;
  vc_exes: string[];
  other_apps: string[];
  audio_mix: "everything" | "game_voice_mic";
  mic_device: string;
  output_device: string;
  export_tracks: number[];
  record_tracks: number[];
  launch_at_login: boolean;
  auto_manage_buffer: boolean;
  hotkey_save: string;
  hotkey_short: string;
  short_clip_seconds: number;
  max_storage_gb: number;
  backup_dir: string;
  catbox_userhash: string;
  auto_clip: boolean;
  auto_clip_delay_s: number;
  auto_clip_min_kills: number;
  auto_clip_games: Record<string, { enabled: boolean; min_kills: number }>;
  session_recording: boolean;
  session_highlights: boolean;
  valorant_match_check: boolean;
  replay_seconds: number;
  video_fps: number;
  video_height: number;
  bitrate_mbps: number;
  encoder_pref: string;
}

export interface SupervisorState {
  obs_running: boolean;
  connected: boolean;
  game: string | null;
  game_label?: string | null;
  buffer_active: boolean;
  paused: boolean;
  obs_needs_restart: boolean;
  obs_outdated: string | null;
  engine_downloading: boolean;
  engine_error: string | null;
  render_lag: boolean;
  encoder_lag: boolean;
  game_elevated: boolean;
}

export interface Diagnostics {
  obs_connected: boolean;
  obs_version: string | null;
  obs_outdated: boolean;
  output_mode: string | null;
  encoder: string | null;
  best_encoder: string | null;
  rate_control: string | null;
  bitrate_kbps: number | null;
  keyint_sec: number | null;
  buffer_seconds: number | null;
  buffer_ram_mb: number | null;
  fps: number | null;
  resolution: string | null;
  settings_pending: boolean;
  health: { render_lag_pct: number; encoder_lag_pct: number; active_fps: number; obs_cpu_pct: number };
  disk_free_bytes: number | null;
  ffmpeg_found: boolean;
  clips_dir_cloud: string | null;
  elevated: boolean;
  mic_noise_suppression: boolean;
}

export interface BackupStatus {
  enabled: boolean;
  folder_ok: boolean;
  backed_up: number;
  pending: number;
  running: boolean;
  last_run_ms: number | null;
  error: string | null;
}

export interface ClipInfo {
  path: string;
  name: string;
  modified_ms: number;
  size_bytes: number;
}

export interface PlayerStats {
  champion?: string | null; kills?: number | null; deaths?: number | null; assists?: number | null;
  cs?: number | null; gold?: number | null; champion_damage?: number | null; vision_score?: number | null;
  finalized?: boolean;
  /** Game-clock seconds of our deaths and assists (League). */
  deaths_at?: number[]; assists_at?: number[];
}
export interface MatchInfo {
  id: string; game: string; source: string; map: string | null; mode: string | null;
  score: { won: number; lost: number } | null; result: "won" | "lost" | "draw" | null;
  round_results: Record<string, "won" | "lost" | "draw">;
  /** When the game's own clock read 0:00 (Unix seconds), for games with one. */
  clock_start?: number | null;
  player_stats?: PlayerStats | null;
}
export interface RecordingMetadata {
  version: number; is_session: boolean;
  matches: { start: number; end: number; info: MatchInfo }[];
  rounds: { match_id: string; number: number; start: number; end: number; result: "won" | "lost" | "draw" | null }[];
}

export interface ThumbInfo {
  thumb: string;
  duration: number;
}

export interface SetupStatus {
  obs_installed: boolean;
  ffmpeg_installed: boolean;
}

export interface GameSource {
  exe: string;
  kind: string;
}

export interface RunningApp {
  exe: string;
  title: string;
}

export type CaptureTest = { capturing: boolean; reason?: "not_running" | "admin" | null };

export function captureTestLabel(t: CaptureTest): string {
  if (t.reason === "not_running") return " — start this game, then test";
  if (t.reason === "admin") return " — game runs as admin: turn on Run with admin rights";
  return t.capturing ? " — capturing ✓" : " — not capturing ✗";
}
