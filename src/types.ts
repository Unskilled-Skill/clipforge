// Shared shapes between App and the extracted panels. Field names mirror the
// Rust structs (serde) — keep snake_case.

export interface ObsStatus {
  connected: boolean;
  replay_buffer_active: boolean;
  obs_version: string | null;
}

export interface Settings {
  host: string;
  port: number;
  password: string | null;
  clips_dir: string;
  auto_connect: boolean;
  game_exes: string[];
  game_blacklist: string[];
  vc_exe: string;
  auto_launch_obs: boolean;
  launch_at_login: boolean;
  auto_manage_buffer: boolean;
  obs_path: string;
  hotkey_save: string;
  hotkey_short: string;
  short_clip_seconds: number;
  max_storage_gb: number;
  backup_dir: string;
  auto_clip: boolean;
  auto_clip_delay_s: number;
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
  buffer_active: boolean;
  paused: boolean;
  obs_needs_restart: boolean;
  obs_outdated: string | null;
  render_lag: boolean;
  encoder_lag: boolean;
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
