import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke, isTauri, listen } from "./tauri-shim";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft,
  Camera,
  CheckCircle,
  Circle,
  DiscordLogo,
  Gif,
  FilmSlate,
  FilmStrip,
  GameController,
  Gauge,
  GearSix,
  MagnifyingGlass,
  Play,
  Repeat,
  Scissors,
  Star,
  Sparkle,
  Stack,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import "./App.css";

interface ObsStatus {
  connected: boolean;
  replay_buffer_active: boolean;
  obs_version: string | null;
}

interface Settings {
  host: string;
  port: number;
  password: string | null;
  clips_dir: string;
  auto_connect: boolean;
  game_exes: string[];
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
}

interface SupervisorState {
  obs_running: boolean;
  connected: boolean;
  game: string | null;
  buffer_active: boolean;
}

interface ClipInfo {
  path: string;
  name: string;
  modified_ms: number;
  size_bytes: number;
}

interface ThumbInfo {
  thumb: string;
  duration: number;
}

// Video bitrate a size-budgeted export gets for a given duration.
function discordKbps(seconds: number, budgetMb = 10) {
  return Math.max(200, (budgetMb * 8192 * 0.94) / seconds - 96);
}

function formatSize(bytes: number) {
  const gb = 1024 ** 3;
  if (bytes >= gb) return `${(bytes / gb).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatDuration(s: number) {
  if (!s || !isFinite(s)) return "";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function relativeTime(ms: number) {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

const GAME_COLORS: Record<string, string> = {
  valorant: "#ff4655",
  cs2: "#f5a623",
  apex: "#ff8c42",
  r5apex: "#ff8c42",
  rocketleague: "#3a7dff",
  overwatch: "#f77f00",
  rainbowsix: "#f0d43a",
  r6: "#f0d43a",
  marathon: "#42d7c8",
  arenabreakout: "#8ce99a",
  fortnite: "#a78bfa",
  hunt: "#c92a2a",
  lol: "#3bc9db",
  deeprock: "#fab005",
};

function gameOf(clip: ClipInfo) {
  // "<Game> <timestamp>.mp4" — anything without that shape (UUIDs,
  // one-word names) groups under "Other".
  const first = clip.name.split(" ")[0];
  if (first === clip.name || first.length > 24) return "Other";
  return first;
}

function gameColor(game: string) {
  const key = game.toLowerCase();
  for (const [k, v] of Object.entries(GAME_COLORS)) {
    if (key.includes(k)) return v;
  }
  return "#7f9bff";
}

function App() {
  const [status, setStatus] = useState<ObsStatus>({
    connected: false,
    replay_buffer_active: false,
    obs_version: null,
  });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [clips, setClips] = useState<ClipInfo[]>([]);
  const [selected, setSelected] = useState<ClipInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [trimming, setTrimming] = useState(false);
  const [blackMap, setBlackMap] = useState<Record<string, boolean>>({});
  const [scanning, setScanning] = useState(false);
  const [sup, setSup] = useState<SupervisorState | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, ThumbInfo>>({});
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [gameFilter, setGameFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [hkSave, setHkSave] = useState("");
  const [hkShort, setHkShort] = useState("");
  const [booting, setBooting] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [loopPreview, setLoopPreview] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [audioTracks, setAudioTracks] = useState(1);
  const [audioTrack, setAudioTrack] = useState(0);
  const [waveform, setWaveform] = useState<string | null>(null);
  const [montageSel, setMontageSel] = useState<Set<string>>(new Set());
  const [montaging, setMontaging] = useState(false);
  const [targetMb, setTargetMb] = useState(10);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [setup, setSetup] = useState<{ obs_installed: boolean; ffmpeg_installed: boolean } | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const dragging = useRef<"start" | "end" | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const settingsRef = useRef<Settings | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  settingsRef.current = settings;

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }

  const refreshClips = useCallback(async (dir?: string) => {
    const clipsDir = dir ?? settingsRef.current?.clips_dir;
    if (!clipsDir) return;
    try {
      setClips(await invoke<ClipInfo[]>("list_clips", { dir: clipsDir }));
      setThumbs(await invoke<Record<string, ThumbInfo>>("gen_thumbnails", { dir: clipsDir }));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const connect = useCallback(async (s: Settings) => {
    setConnecting(true);
    setError(null);
    try {
      const st = await invoke<ObsStatus>("obs_connect", {
        host: s.host,
        port: s.port,
        password: s.password || null,
      });
      setStatus(st);
      await invoke("start_replay_buffer");
      setStatus((prev) => ({ ...prev, replay_buffer_active: true }));
      const saved: Settings = { ...s, auto_connect: true };
      setSettings(saved);
      await invoke("save_settings", { settings: saved });
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const s = await invoke<Settings>("load_settings");
      setSettings(s);
      setHkSave(s.hotkey_save);
      setHkShort(s.hotkey_short);
      try {
        const list = await invoke<ClipInfo[]>("list_clips", { dir: s.clips_dir });
        setClips(list);
      } catch {
        /* dir may not exist yet */
      }
      invoke<string[]>("load_favorites").then(setFavorites).catch(() => {});
      invoke<{ obs_installed: boolean; ffmpeg_installed: boolean }>("setup_status")
        .then(setSetup)
        .catch(() => {});
      setBooting(false);
      // Thumbnails come after the splash — they take a few seconds.
      invoke<Record<string, ThumbInfo>>("gen_thumbnails", { dir: s.clips_dir })
        .then(setThumbs)
        .catch(() => {});
      if (s.auto_connect && s.password) {
        connect(s);
      }
    })();
  }, [connect, refreshClips]);

  useEffect(() => {
    const unlisteners = [
      listen<{ path: string }>("clip-saved", () => {
        showToast("Clip saved");
        setTimeout(() => refreshClips(), 500);
      }),
      listen<boolean>("replay-buffer-state", (e) => {
        setStatus((s) => ({ ...s, replay_buffer_active: e.payload }));
      }),
      listen<string>("clip-error", (e) => setError(e.payload)),
      listen("clips-changed", () => refreshClips()),
      listen("auto-clip-armed", () => showToast("Kill detected — clipping in a few seconds…")),
      listen("auto-clipped", () => showToast("Auto-clipped!")),
      listen<string>("update-installing", (e) =>
        showToast(`Updating to v${e.payload} — restarting shortly…`)
      ),
      listen("obs-disconnected", () => {
        setStatus({ connected: false, replay_buffer_active: false, obs_version: null });
      }),
      listen<SupervisorState>("supervisor-state", (e) => {
        setSup(e.payload);
        setStatus((s) => ({
          ...s,
          connected: e.payload.connected,
          replay_buffer_active: e.payload.buffer_active,
        }));
        if (e.payload.connected) setError(null);
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, [refreshClips]);

  function selectClip(clip: ClipInfo) {
    setSelected(clip);
    setTrimStart(0);
    setTrimEnd(0);
    setDuration(0);
    setCurrentTime(0);
    setPreviewing(false);
    setAudioTrack(0);
    setAudioTracks(1);
    setWaveform(null);
    setRenaming(false);
    invoke<number>("list_audio_tracks", { input: clip.path })
      .then(setAudioTracks)
      .catch(() => {});
    invoke<string>("gen_waveform", { input: clip.path })
      .then(setWaveform)
      .catch(() => {});
  }

  function toggleMontage(clip: ClipInfo) {
    setMontageSel((prev) => {
      const next = new Set(prev);
      next.has(clip.path) ? next.delete(clip.path) : next.add(clip.path);
      return next;
    });
  }

  async function exportMontage() {
    setMontaging(true);
    setError(null);
    try {
      // keep library order (newest first) for the cut order
      const inputs = clips.filter((c) => montageSel.has(c.path)).map((c) => c.path);
      await invoke<string>("export_montage", { inputs });
      showToast(`Montage of ${inputs.length} clips saved`);
      setMontageSel(new Set());
      await refreshClips();
    } catch (e) {
      setError(String(e));
    } finally {
      setMontaging(false);
    }
  }

  async function exportGif() {
    if (!selected) return;
    setError(null);
    try {
      await invoke<string>("export_gif", { input: selected.path, start: trimStart, end: trimEnd });
      showToast("GIF exported and copied — Ctrl+V it");
      await refreshClips();
    } catch (e) {
      setError(String(e));
    }
  }

  async function exportFrame() {
    if (!selected || !videoRef.current) return;
    setError(null);
    try {
      await invoke<string>("export_frame", {
        input: selected.path,
        time: videoRef.current.currentTime,
      });
      showToast("Frame saved and copied — Ctrl+V it");
      await refreshClips();
    } catch (e) {
      setError(String(e));
    }
  }

  async function commitRename() {
    if (!selected) return;
    setRenaming(false);
    const base = selected.name.replace(/\.[^.]+$/, "");
    if (!renameValue.trim() || renameValue === base) return;
    try {
      const wasFav = favorites.includes(selected.path);
      const newPath = await invoke<string>("rename_clip", {
        path: selected.path,
        newName: renameValue,
      });
      if (wasFav) {
        await invoke("toggle_favorite", { path: selected.path });
        setFavorites(await invoke<string[]>("toggle_favorite", { path: newPath }));
      }
      setSelected({ ...selected, path: newPath, name: newPath.split("/").pop() ?? renameValue });
      await refreshClips();
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleFavorite(clip: ClipInfo) {
    try {
      setFavorites(await invoke<string[]>("toggle_favorite", { path: clip.path }));
    } catch (e) {
      setError(String(e));
    }
  }

  function previewSelection() {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = trimStart;
    setPreviewing(true);
    video.play();
  }

  function onVideoTime(t: number) {
    setCurrentTime(t);
    const video = videoRef.current;
    if (!previewing || !video) return;
    if (t >= trimEnd) {
      if (loopPreview) {
        video.currentTime = trimStart;
      } else {
        video.pause();
        setPreviewing(false);
      }
    } else if (t < trimStart - 1) {
      // user seeked away — drop preview mode
      setPreviewing(false);
    }
  }

  function timeAt(clientX: number) {
    const el = timelineRef.current;
    if (!el || duration === 0) return 0;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * duration;
  }

  function onTimelineDown(e: React.PointerEvent) {
    const t = timeAt(e.clientX);
    const startDist = Math.abs(t - trimStart);
    const endDist = Math.abs(t - trimEnd);
    const grabRange = duration * 0.04;
    if (Math.min(startDist, endDist) < grabRange) {
      dragging.current = startDist <= endDist ? "start" : "end";
    } else if (videoRef.current) {
      videoRef.current.currentTime = t;
    }
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onTimelineMove(e: React.PointerEvent) {
    if (!dragging.current) return;
    const t = timeAt(e.clientX);
    if (dragging.current === "start") {
      setTrimStart(Math.min(Math.round(t * 10) / 10, trimEnd - 0.5));
    } else {
      setTrimEnd(Math.max(Math.round(t * 10) / 10, trimStart + 0.5));
    }
  }

  function onTimelineUp() {
    dragging.current = null;
  }

  // Editor keyboard shortcuts: space play/pause, arrows frame-step
  // (shift = 1s), [ ] set trim markers at the playhead.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const video = videoRef.current;
      if (!video) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          video.paused ? video.play() : video.pause();
          break;
        case "ArrowLeft":
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 1 : 1 / 60));
          break;
        case "ArrowRight":
          e.preventDefault();
          video.currentTime = Math.min(duration, video.currentTime + (e.shiftKey ? 1 : 1 / 60));
          break;
        case "[":
          setTrimStart(Math.min(Math.round(video.currentTime * 10) / 10, trimEnd - 0.5));
          break;
        case "]":
          setTrimEnd(Math.max(Math.round(video.currentTime * 10) / 10, trimStart + 0.5));
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, duration, trimStart, trimEnd]);

  async function applyHotkeys(save: string, short: string) {
    setError(null);
    try {
      await invoke("set_hotkeys", { save, short });
      if (settings) setSettings({ ...settings, hotkey_save: save, hotkey_short: short });
      showToast("Hotkeys updated");
    } catch (e) {
      setError(String(e));
      // revert display to what is actually registered
      if (settings) {
        setHkSave(settings.hotkey_save);
        setHkShort(settings.hotkey_short);
      }
    }
  }

  // Turn a keydown into a hotkey string like "ctrl+shift+f9".
  function captureHotkey(e: React.KeyboardEvent): string | null {
    e.preventDefault();
    e.stopPropagation();
    const key = e.key.toLowerCase();
    if (["control", "shift", "alt", "meta"].includes(key)) return null; // modifier alone
    const mods = [
      e.ctrlKey ? "ctrl" : null,
      e.shiftKey ? "shift" : null,
      e.altKey ? "alt" : null,
    ].filter(Boolean);
    const name = key === " " ? "space" : key;
    return [...mods, name].join("+");
  }

  async function saveSettings(s: Settings) {
    setSettings(s);
    await invoke("save_settings", { settings: s });
  }

  async function deleteClip(clip: ClipInfo) {
    setError(null);
    try {
      await invoke("delete_clip", { path: clip.path });
      if (selected?.path === clip.path) setSelected(null);
      setClips((prev) => prev.filter((c) => c.path !== clip.path));
    } catch (e) {
      setError(String(e));
    } finally {
      await refreshClips();
    }
  }

  async function scanBlack() {
    setScanning(true);
    setError(null);
    try {
      for (const clip of clips) {
        if (blackMap[clip.path] !== undefined) continue;
        const r = await invoke<{ is_black: boolean }>("analyze_black", { path: clip.path });
        setBlackMap((prev) => ({ ...prev, [clip.path]: r.is_black }));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function deleteAllBlack() {
    setError(null);
    const black = clips.filter((c) => blackMap[c.path]);
    for (const clip of black) {
      try {
        await invoke("delete_clip", { path: clip.path });
        if (selected?.path === clip.path) setSelected(null);
      } catch (e) {
        setError(String(e));
      }
    }
    await refreshClips();
  }

  async function doTrim() {
    if (!selected) return;
    setTrimming(true);
    setError(null);
    try {
      await invoke<string>("trim_clip", {
        input: selected.path,
        start: trimStart,
        end: trimEnd,
      });
      showToast("Trimmed — new file saved next to the original");
      await refreshClips();
    } catch (e) {
      setError(String(e));
    } finally {
      setTrimming(false);
    }
  }

  async function exportDiscord() {
    if (!selected) return;
    setExporting(true);
    setError(null);
    try {
      await invoke<string>("export_discord", {
        input: selected.path,
        targetMb,
        start: trimStart,
        end: trimEnd,
        audioTrack,
      });
      showToast("Exported and copied to clipboard — Ctrl+V in Discord");
      await refreshClips();
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }

  const blackCount = clips.filter((c) => blackMap[c.path]).length;

  if (booting || !settings) {
    return (
      <div className="app-frame">
        <div className="titlebar" data-tauri-drag-region>
          <span className="titlebar-title" data-tauri-drag-region>ClipForge</span>
        </div>
        <div className="splash">
          <div className="brand-mark splash-mark">
            <FilmSlate size={26} weight="fill" color="#fff" />
          </div>
          <span className="splash-name">ClipForge</span>
          <span className="splash-hint">loading library…</span>
        </div>
      </div>
    );
  }

  const games = [...new Set(clips.map(gameOf))].sort();
  const visibleClips = clips.filter(
    (c) =>
      (gameFilter === "all" ||
        (gameFilter === "favorites" ? favorites.includes(c.path) : gameOf(c) === gameFilter)) &&
      (search === "" || c.name.toLowerCase().includes(search.toLowerCase()))
  );
  const totalSize = formatSize(clips.reduce((a, c) => a + c.size_bytes, 0));
  const kbps = discordKbps(Math.max(0.1, trimEnd - trimStart), targetMb);
  const goodQuality = kbps >= 2000;

  return (
    <div className="app-frame">
      <div className="titlebar" data-tauri-drag-region>
        <span className="titlebar-title" data-tauri-drag-region>ClipForge</span>
        <div className="titlebar-controls">
          <button
            className="tb-btn"
            title="Minimize"
            onClick={() => isTauri && getCurrentWindow().minimize()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1.2" /></svg>
          </button>
          <button
            className="tb-btn"
            title="Maximize"
            onClick={() => isTauri && getCurrentWindow().toggleMaximize()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.6" y="0.6" width="8.8" height="8.8" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
          </button>
          <button
            className="tb-btn close"
            title="Close"
            onClick={() => isTauri && getCurrentWindow().close()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" /><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2" /></svg>
          </button>
        </div>
      </div>
      <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <FilmSlate size={19} weight="fill" color="#fff" />
          </div>
          <div className="brand-text">
            <span className="brand-name">ClipForge</span>
            <span className="brand-ver">v2.0</span>
          </div>
        </div>

        <nav className="nav">
          <button
            className={`nav-item ${!showSettings ? "active" : ""}`}
            onClick={() => {
              setShowSettings(false);
              setSelected(null);
            }}
          >
            <Stack size={17} weight={!showSettings ? "fill" : "regular"} />
            Library
          </button>
          <button className="nav-item" onClick={() => setShowSettings(true)}>
            <GearSix size={17} />
            Settings
          </button>
        </nav>

        <div className="sidebar-spacer" />

        <div className="status-card">
          <div className="obs-row">
            <span className={`obs-dot ${status.connected ? "on" : ""}`} />
            <span className="obs-name">OBS Studio</span>
            <span className="obs-ver">{status.obs_version ?? ""}</span>
          </div>
          <div className={`buffer-pill ${status.replay_buffer_active ? "armed" : ""}`}>
            <span className="buffer-dot" />
            {status.replay_buffer_active ? "BUFFER ARMED" : "IDLE"}
          </div>
          {sup?.game && (
            <div className="game-row">
              <GameController size={15} color="#ff8c42" weight="fill" />
              <span className="game-name">{sup.game}</span>
              <span className="game-running">running</span>
            </div>
          )}
          <div className="status-divider" />
          <div className="hotkey-rows">
            <div className="hk-row">
              <span>Save clip</span>
              <kbd>{settings.hotkey_save}</kbd>
            </div>
            <div className="hk-row">
              <span>Short clip</span>
              <kbd>{settings.hotkey_short}</kbd>
            </div>
          </div>
        </div>
      </aside>

      <main className="main">
        {error && <div className="error-bar">{error}</div>}
        {setup && (!setup.obs_installed || !setup.ffmpeg_installed) && (
          <div className="setup-bar">
            <Warning size={15} weight="fill" />
            {!setup.obs_installed && (
              <>
                <span>OBS Studio is not installed — ClipForge needs it to record.</span>
                <button
                  className="setup-btn"
                  disabled={installing !== null}
                  onClick={async () => {
                    setInstalling("OBS Studio");
                    try {
                      await invoke("winget_install", { id: "OBSProject.OBSStudio" });
                      setSetup(await invoke("setup_status"));
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setInstalling(null);
                    }
                  }}
                >
                  {installing === "OBS Studio" ? "installing…" : "Install OBS"}
                </button>
              </>
            )}
            {setup.obs_installed && !setup.ffmpeg_installed && (
              <>
                <span>ffmpeg is missing — needed for thumbnails, trims and exports.</span>
                <button
                  className="setup-btn"
                  disabled={installing !== null}
                  onClick={async () => {
                    setInstalling("ffmpeg");
                    try {
                      await invoke("winget_install", { id: "Gyan.FFmpeg" });
                      setSetup(await invoke("setup_status"));
                      await refreshClips();
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setInstalling(null);
                    }
                  }}
                >
                  {installing === "ffmpeg" ? "installing…" : "Install ffmpeg"}
                </button>
              </>
            )}
          </div>
        )}

        {!selected ? (
          <>
            <header className="lib-header">
              <div className="lib-title">
                <h1>Library</h1>
                <span className="lib-count">
                  {clips.length} clips · {totalSize}
                </span>
              </div>
              <div className="lib-spacer" />
              <div className="search-box">
                <MagnifyingGlass size={15} color="#5f636e" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search clips…"
                />
              </div>
              <button className="btn-ghost" onClick={scanBlack} disabled={scanning || clips.length === 0}>
                <Sparkle size={15} />
                {scanning ? "scanning…" : "Scan for black"}
              </button>
              {blackCount > 0 && (
                <button className="btn-danger" onClick={deleteAllBlack}>
                  <Trash size={15} />
                  Delete {blackCount} black
                </button>
              )}
              {montageSel.size >= 2 && (
                <button className="btn-discord" onClick={exportMontage} disabled={montaging}>
                  <FilmStrip size={15} weight="fill" />
                  {montaging ? "rendering…" : `Montage ${montageSel.size} clips`}
                </button>
              )}
            </header>

            <div className="filter-row">
              <button
                className={`chip ${gameFilter === "all" ? "active" : ""}`}
                onClick={() => setGameFilter("all")}
              >
                <span className="chip-dot" style={{ background: "#7f9bff" }} />
                All games
              </button>
              <button
                className={`chip ${gameFilter === "favorites" ? "active" : ""}`}
                onClick={() => setGameFilter("favorites")}
              >
                <Star size={12} weight="fill" color="#f5c518" />
                Favorites
              </button>
              {games.map((g) => (
                <button
                  key={g}
                  className={`chip ${gameFilter === g ? "active" : ""}`}
                  onClick={() => setGameFilter(g)}
                >
                  <span className="chip-dot" style={{ background: gameColor(g) }} />
                  {g}
                </button>
              ))}
            </div>

            {visibleClips.length === 0 ? (
              <div className="empty-state">
                <FilmStrip size={44} color="#33363f" />
                <span className="empty-title">No clips here yet</span>
                <span className="empty-hint">
                  Press <span className="empty-key">{settings.hotkey_save}</span> in-game to save one
                </span>
              </div>
            ) : (
              <div className="grid">
                {visibleClips.map((c) => (
                  <div key={c.path} className="card" onClick={() => selectClip(c)}>
                    <div className="card-thumb">
                      {thumbs[c.path] ? (
                        <img src={convertFileSrc(thumbs[c.path].thumb)} alt="" loading="lazy" />
                      ) : (
                        <div className="thumb-placeholder" />
                      )}
                      <div className="thumb-vignette" />
                      <div className="game-tag">
                        <span className="chip-dot" style={{ background: gameColor(gameOf(c)) }} />
                        {gameOf(c)}
                      </div>
                      <div className="card-topright">
                        {blackMap[c.path] === true && (
                          <div className="black-badge">
                            <Warning size={11} weight="fill" />
                            BLACK
                          </div>
                        )}
                        <button
                          className={`card-select ${montageSel.has(c.path) ? "on" : ""}`}
                          title="Select for montage"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleMontage(c);
                          }}
                        >
                          {montageSel.has(c.path) ? (
                            <CheckCircle size={17} weight="fill" />
                          ) : (
                            <Circle size={17} />
                          )}
                        </button>
                      </div>
                      <div className="play-circle">
                        <Play size={18} weight="fill" color="#fff" />
                      </div>
                      {thumbs[c.path] && thumbs[c.path].duration > 0 && (
                        <div className="duration-badge">{formatDuration(thumbs[c.path].duration)}</div>
                      )}
                      <button
                        className="card-trash"
                        title="Move to Recycle Bin"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteClip(c);
                        }}
                      >
                        <Trash size={15} />
                      </button>
                      <button
                        className={`card-star ${favorites.includes(c.path) ? "on" : ""}`}
                        title="Favorite — survives storage cleanup"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(c);
                        }}
                      >
                        <Star size={15} weight={favorites.includes(c.path) ? "fill" : "regular"} />
                      </button>
                    </div>
                    <div className="card-text">
                      <span className="card-title">{c.name}</span>
                      <span className="card-meta">
                        {formatSize(c.size_bytes)} <span className="meta-dot" /> {relativeTime(c.modified_ms)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="editor">
            <div className="editor-top">
              <button className="btn-ghost" onClick={() => setSelected(null)}>
                <ArrowLeft size={15} />
                Library
              </button>
              <span className="chip-dot" style={{ background: gameColor(gameOf(selected)) }} />
              {renaming ? (
                <input
                  className="rename-input"
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenaming(false);
                  }}
                />
              ) : (
                <span
                  className="editor-title"
                  title="Click to rename"
                  onClick={() => {
                    setRenameValue(selected.name.replace(/\.[^.]+$/, ""));
                    setRenaming(true);
                  }}
                >
                  {selected.name}
                </span>
              )}
              <div className="lib-spacer" />
              <button
                className={`btn-delete star ${favorites.includes(selected.path) ? "on" : ""}`}
                onClick={() => toggleFavorite(selected)}
              >
                <Star size={15} weight={favorites.includes(selected.path) ? "fill" : "regular"} />
                {favorites.includes(selected.path) ? "Favorited" : "Favorite"}
              </button>
              <button className="btn-delete" onClick={() => deleteClip(selected)}>
                <Trash size={15} />
                Delete
              </button>
            </div>

            <div className="player-wrap">
              <video
                ref={videoRef}
                key={selected.path}
                src={convertFileSrc(selected.path)}
                controls
                autoPlay
                onLoadedMetadata={(e) => {
                  setDuration(e.currentTarget.duration);
                  setTrimEnd(Math.floor(e.currentTarget.duration));
                }}
                onTimeUpdate={(e) => onVideoTime(e.currentTarget.currentTime)}
              />
            </div>

            <div className="trim-section">
              <div className="trim-head">
                <span className="trim-label">TRIM</span>
                <button
                  className={`preview-btn ${previewing ? "on" : ""}`}
                  onClick={previewSelection}
                  title="Play the selected range"
                >
                  <Play size={12} weight="fill" />
                  {previewing ? "previewing…" : "preview"}
                </button>
                <button
                  className={`preview-btn ${loopPreview ? "on" : ""}`}
                  onClick={() => setLoopPreview(!loopPreview)}
                  title="Loop the selection"
                >
                  <Repeat size={12} weight="bold" />
                  loop
                </button>
                <span className="trim-readout">
                  {trimStart.toFixed(1)}s → {trimEnd.toFixed(1)}s · {(trimEnd - trimStart).toFixed(1)}s selected
                </span>
              </div>
              {duration > 0 && (
                <div
                  ref={timelineRef}
                  className="timeline"
                  onPointerDown={onTimelineDown}
                  onPointerMove={onTimelineMove}
                  onPointerUp={onTimelineUp}
                >
                  <div className="ticks" />
                  {waveform && (
                    <img className="waveform" src={convertFileSrc(waveform)} alt="" draggable={false} />
                  )}
                  <div
                    className="range"
                    style={{
                      left: `${(trimStart / duration) * 100}%`,
                      width: `${((trimEnd - trimStart) / duration) * 100}%`,
                    }}
                  />
                  <div className="playhead" style={{ left: `${(currentTime / duration) * 100}%` }} />
                  <div className="handle" style={{ left: `${(trimStart / duration) * 100}%` }}>
                    <span className="grip" />
                  </div>
                  <div className="handle" style={{ left: `${(trimEnd / duration) * 100}%` }}>
                    <span className="grip" />
                  </div>
                </div>
              )}
            </div>

            <div className="action-row">
              <div className={`quality-pill ${goodQuality ? "good" : "bad"}`}>
                <Gauge size={15} weight="fill" />
                ~{Math.round(kbps)} kbps · {goodQuality ? "good" : "trim shorter"}
              </div>
              {audioTracks > 1 && (
                <select
                  className="audio-select"
                  value={audioTrack}
                  onChange={(e) => setAudioTrack(Number(e.target.value))}
                  title="Audio for the Discord export"
                >
                  <option value={0}>🔊 full mix</option>
                  <option value={1}>🎮 game only</option>
                  {audioTracks > 2 && <option value={2}>🎤 mic only</option>}
                </select>
              )}
              <div className="lib-spacer" />
              <button className="btn-trim icon-only" title="Save current frame as PNG" onClick={exportFrame}>
                <Camera size={16} />
              </button>
              <button
                className="btn-trim icon-only"
                title="Export trim range as GIF (max 15s)"
                onClick={exportGif}
                disabled={trimEnd - trimStart > 15 || trimEnd <= trimStart}
              >
                <Gif size={18} />
              </button>
              <button className="btn-trim" onClick={doTrim} disabled={trimming || trimEnd <= trimStart}>
                <Scissors size={16} />
                {trimming ? "trimming…" : "Trim · lossless"}
              </button>
              <select
                className="audio-select"
                value={targetMb}
                onChange={(e) => setTargetMb(Number(e.target.value))}
                title="Export size budget"
              >
                <option value={10}>10 MB</option>
                <option value={50}>50 MB · Nitro Basic</option>
                <option value={500}>500 MB · Nitro</option>
              </select>
              <button className="btn-discord" onClick={exportDiscord} disabled={exporting}>
                <DiscordLogo size={17} weight="fill" />
                {exporting ? "exporting…" : "Export for Discord"}
              </button>
            </div>
            <p className="kbd-hints">
              <kbd>space</kbd> play/pause · <kbd>←</kbd><kbd>→</kbd> frame · <kbd>shift</kbd>+arrows 1s ·{" "}
              <kbd>[</kbd> set start · <kbd>]</kbd> set end
            </p>
          </div>
        )}

        {toast && (
          <div className="toast">
            <CheckCircle size={17} weight="fill" color="#40dd80" />
            {toast}
          </div>
        )}
      </main>

      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <GearSix size={19} color="#7f9bff" weight="fill" />
              <span className="modal-title">Settings</span>
              <div className="lib-spacer" />
              <button className="modal-close" onClick={() => setShowSettings(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <details className="set-group advanced">
                <summary className="set-label">
                  ADVANCED CONNECTION — auto-configured, only for remote or portable OBS
                </summary>
                <div className="set-row">
                  <input
                    className="mono"
                    value={settings.host}
                    onChange={(e) => setSettings({ ...settings, host: e.target.value })}
                    placeholder="host"
                  />
                  <input
                    className="mono port"
                    type="number"
                    value={settings.port}
                    onChange={(e) => setSettings({ ...settings, port: Number(e.target.value) })}
                  />
                </div>
                <input
                  type="password"
                  value={settings.password ?? ""}
                  onChange={(e) => setSettings({ ...settings, password: e.target.value })}
                  placeholder="obs-websocket password (auto-detected normally)"
                />
                <button className="btn-ghost apply-btn" onClick={() => connect(settings)} disabled={connecting}>
                  {connecting ? "connecting…" : "Apply & connect"}
                </button>
              </details>

              <section className="set-group">
                <span className="set-label">CAPTURE</span>
                <label className="set-col">
                  <span className="field-label">
                    Clip length (seconds) — how far back a save reaches. Longer = more RAM while
                    a game runs (~{Math.round((settings.replay_seconds * 4.5) / 100) / 10} GB at
                    current setting). Applies to OBS automatically.
                  </span>
                  <input
                    className="mono"
                    type="number"
                    min={15}
                    max={900}
                    step={15}
                    value={settings.replay_seconds}
                    onChange={(e) =>
                      saveSettings({
                        ...settings,
                        replay_seconds: Math.min(900, Math.max(15, Number(e.target.value) || 15)),
                      })
                    }
                  />
                </label>
              </section>

              <section className="set-group">
                <span className="set-label">AUTOMATION</span>
                <div className="toggle-card">
                  <div className="toggle-text">
                    <span className="toggle-title">Auto buffer</span>
                    <span className="toggle-desc">Arm when a game runs, disarm when it exits</span>
                  </div>
                  <button
                    className={`switch ${settings.auto_manage_buffer ? "on" : ""}`}
                    onClick={() => saveSettings({ ...settings, auto_manage_buffer: !settings.auto_manage_buffer })}
                  >
                    <span className="knob" />
                  </button>
                </div>
                <div className="toggle-card">
                  <div className="toggle-text">
                    <span className="toggle-title">Auto-launch OBS</span>
                    <span className="toggle-desc">Start OBS hidden when it is not running</span>
                  </div>
                  <button
                    className={`switch ${settings.auto_launch_obs ? "on" : ""}`}
                    onClick={() => saveSettings({ ...settings, auto_launch_obs: !settings.auto_launch_obs })}
                  >
                    <span className="knob" />
                  </button>
                </div>
                <div className="toggle-card">
                  <div className="toggle-text">
                    <span className="toggle-title">Auto-clip kills</span>
                    <span className="toggle-desc">
                      CS2 / Dota 2 / League only (official event APIs). Saves a clip a few seconds
                      after your kill — multikills land in one clip. Other games: hotkey.
                    </span>
                  </div>
                  <button
                    className={`switch ${settings.auto_clip ? "on" : ""}`}
                    onClick={() => saveSettings({ ...settings, auto_clip: !settings.auto_clip })}
                  >
                    <span className="knob" />
                  </button>
                </div>
              </section>

              <section className="set-group">
                <span className="set-label">HOTKEYS</span>
                <div className="set-row">
                  <label className="set-col">
                    <span className="field-label">Save clip — click, then press keys</span>
                    <input
                      className="mono hotkey-capture"
                      value={hkSave}
                      placeholder="press a combo…"
                      readOnly
                      onKeyDown={(e) => {
                        const combo = captureHotkey(e);
                        if (combo) {
                          setHkSave(combo);
                          applyHotkeys(combo, hkShort);
                        }
                      }}
                    />
                  </label>
                  <label className="set-col">
                    <span className="field-label">Short clip — click, then press keys</span>
                    <input
                      className="mono hotkey-capture"
                      value={hkShort}
                      placeholder="press a combo…"
                      readOnly
                      onKeyDown={(e) => {
                        const combo = captureHotkey(e);
                        if (combo) {
                          setHkShort(combo);
                          applyHotkeys(hkSave, combo);
                        }
                      }}
                    />
                  </label>
                  <label className="set-col short-len">
                    <span className="field-label">Short length</span>
                    <input
                      className="mono"
                      type="number"
                      min={5}
                      value={settings.short_clip_seconds}
                      onChange={(e) => saveSettings({ ...settings, short_clip_seconds: Number(e.target.value) })}
                    />
                  </label>
                </div>
              </section>

              <section className="set-group">
                <span className="set-label">GAMES WATCHED</span>
                <textarea
                  className="mono"
                  rows={5}
                  value={settings.game_exes.join("\n")}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      game_exes: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                    })
                  }
                  onBlur={() => invoke("save_settings", { settings })}
                />
              </section>

              <section className="set-group">
                <span className="set-label">STORAGE</span>
                <input
                  className="mono"
                  value={settings.clips_dir}
                  onChange={(e) => setSettings({ ...settings, clips_dir: e.target.value })}
                  onBlur={() => invoke("save_settings", { settings })}
                />
                <label className="set-col">
                  <span className="field-label">
                    Max storage (GB) — oldest non-favorites auto-recycled, 0 = off
                  </span>
                  <input
                    className="mono"
                    type="number"
                    min={0}
                    value={settings.max_storage_gb}
                    onChange={(e) => saveSettings({ ...settings, max_storage_gb: Number(e.target.value) })}
                  />
                </label>
              </section>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

export default App;
