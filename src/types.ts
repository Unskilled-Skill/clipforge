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
  auto_manage_buffer: boolean;
  obs_path: string;
  hotkey_save: string;
  hotkey_short: string;
  short_clip_seconds: number;
  max_storage_gb: number;
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
