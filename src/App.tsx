import { useCallback, useEffect, useRef, useState } from "react";
import { gameName, momentTitle, killBadge, clipKillCount, matchesClipSearch } from "./clip-presentation";
import { moveItem } from "./clip-selection";
import { createSettingsWriter } from "./settings-save";
import { useMediaQuery } from "./use-media-query";
import { SetupCheck } from "./SetupCheck";
import { isDiscordApp } from "./app-blacklist";
import { confirmDialog, convertFileSrc, getVersion, invoke, isTauri, listen, openDialog } from "./tauri-shim";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  Camera,
  CheckCircle,
  Circle,
  ArrowSquareOut,
  Copy,
  Crosshair,
  LinkSimple,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  ArrowsInLineHorizontal,
  DiscordLogo,
  DotsThree,
  Gif,
  FilmSlate,
  FilmStrip,
  FolderOpen,
  GameController,
  GearSix,
  Headset,
  MagnifyingGlass,
  Microphone,
  Monitor,
  PencilSimple,
  Play,
  Repeat,
  Scissors,
  SpeakerHigh,
  Star,
  Sparkle,
  Stack,
  Trash,
  Warning,
  Waveform,
  X,
} from "@phosphor-icons/react";
import { AppPickerModal, Modal, OnboardingModal, SettingsPage, VcPickerModal } from "./panels";
import { TimelineController } from "./timeline/controller";
import { Filmstrip, KillMarkers, Ruler } from "./timeline/parts";
import type {
  CaptureTest,
  ClipInfo,
  ObsStatus,
  RunningApp,
  Settings,
  SetupStatus,
  SupervisorState,
  ThumbInfo,
} from "./types";
import appIcon from "./assets/logo.svg";
import "./tokens.css";
import "./App.css";
import "./editor.css";

function trimReadout(start: number, end: number) {
  return `${start.toFixed(1)}s → ${end.toFixed(1)}s · ${(end - start).toFixed(1)}s selected`;
}

// Thumbnails live at a deterministic path next to the clip, so a card can
// show one before the backend confirms it exists (broken loads fall back
// to the placeholder underneath).
function guessThumb(clipPath: string) {
  const slash = clipPath.lastIndexOf("/");
  const name = clipPath.slice(slash + 1).replace(/\.[^.]+$/, "");
  return `${clipPath.slice(0, slash)}/.thumbs/${name}.jpg`;
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
  valorant: "#c4a0ec",
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
  edits: "#8a8f9a",
};

// Output of a ClipForge edit (trim/export/gif/frame/montage) rather than a
// recording — grouped under "Edits" so game groups stay clean.
function isEdit(name: string) {
  return /_discord\.|_trim_|_gif\.gif$|_frame_|^Montage_/.test(name);
}

// "<Game> Session <date time>.mp4" from full-session recording.
function isSession(name: string) {
  return /^\S+ Session \d{4}-\d{2}-\d{2}/.test(name);
}

function gameOf(clip: ClipInfo) {
  if (isEdit(clip.name)) return "Edits";
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

// Label each audio track by what it actually contains, which depends on how
// many tracks the clip has: new clips record the full 5-track split, while
// older clips used a 3-track (mix/desktop/mic) or 2-track layout. Guessing
// from the count keeps the labels matching the real audio per track.
type ShareLink = { host: string; url: string; start: number; end: number; at: number };

type TrackMeta = { i: number; label: string; Icon: typeof SpeakerHigh };

/// Tracks that contain each other's sound, so keeping both plays it twice.
/// The mix (track 1) holds everything; desktop is all system sound, which
/// includes the game and voice chat tracks (5-track layout).
function trackOverlaps(count: number, track: number): number[] {
  const all = Array.from({ length: count }, (_, i) => i);
  if (track === 0) return all.filter((i) => i !== 0);
  if (count >= 5) {
    if (track === 3) return [0, 1, 2];
    if (track === 1 || track === 2) return [0, 3];
  }
  return [0];
}

/// Check `track` and uncheck everything that would double its sound.
function keepTrack(prev: Set<number>, track: number, count: number): Set<number> {
  const next = new Set(prev);
  next.add(track);
  for (const o of trackOverlaps(count, track)) next.delete(o);
  return next;
}

/// Drop broad tracks (mix, then desktop) that overlap a kept specific one.
function withoutOverlaps(keep: Set<number>, count: number): Set<number> {
  const next = new Set([...keep].filter((t) => t < Math.max(count, 1)));
  if (next.size > 1) next.delete(0);
  if (count >= 5 && next.has(3) && (next.has(1) || next.has(2))) next.delete(3);
  return next.size ? next : new Set([0]);
}

function trackLabels(count: number): TrackMeta[] {
  if (count >= 5) {
    return [
      { i: 0, label: "mix", Icon: SpeakerHigh },
      { i: 1, label: "game", Icon: GameController },
      { i: 2, label: "voice", Icon: Headset },
      { i: 3, label: "desktop", Icon: Monitor },
      { i: 4, label: "mic", Icon: Microphone },
    ];
  }
  if (count === 3) {
    return [
      { i: 0, label: "mix", Icon: SpeakerHigh },
      { i: 1, label: "desktop", Icon: Monitor },
      { i: 2, label: "mic", Icon: Microphone },
    ];
  }
  if (count === 2) {
    return [
      { i: 0, label: "mix", Icon: SpeakerHigh },
      { i: 1, label: "mic", Icon: Microphone },
    ];
  }
  if (count <= 1) return [{ i: 0, label: "audio", Icon: SpeakerHigh }];
  return Array.from({ length: count }, (_, i) => ({ i, label: `track ${i + 1}`, Icon: Waveform }));
}

function App() {
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [showSetupCheck, setShowSetupCheck] = useState(false);
  const [status, setStatus] = useState<ObsStatus>({
    connected: false,
    replay_buffer_active: false,
    obs_version: null,
  });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsSave, setSettingsSave] = useState<{ state: "idle" | "saving" | "saved" | "error"; detail?: string }>({ state: "idle" });
  const settingsPending = useRef(0);
  const settingsSubmitted = useRef<Settings | null>(null);
  const settingsVersion = useRef(0);
  const settingsRetry = useRef<Settings | null>(null);
  const writeSettings = useRef(createSettingsWriter<Settings>(() => invoke<Settings>("load_settings"), async (snapshot) => {
    await invoke("save_settings", { settings: snapshot });
    void invoke("apply_obs_config").catch(() => {});
  }));
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
  // First-run capture-engine download: "Downloading… 42%" / "Unpacking… 80%".
  const [engineProgress, setEngineProgress] = useState<{ stage: string; pct: number } | null>(null);
  const engineProgressText = engineProgress
    ? `${engineProgress.stage === "extract" ? "unpacking" : "downloading"} ${engineProgress.pct}%`
    : null;
  const [showSettings, setShowSettings] = useState(false);
  // Thumbnail map hydrates from the last session's cache so cards paint
  // instantly on boot; the backend refresh replaces it when it lands.
  const [thumbs, setThumbs] = useState<Record<string, ThumbInfo>>(() => {
    try {
      return JSON.parse(localStorage.getItem("clipforge_thumbs") || "{}");
    } catch {
      return {};
    }
  });
  const [exporting, setExporting] = useState(false);
  const [undoDelete, setUndoDelete] = useState<{ id: string; clip: ClipInfo } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [markerCounts, setMarkerCounts] = useState<Record<string, number>>({});
  const [diskDismissed, setDiskDismissed] = useState(false);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [noVideo, setNoVideo] = useState(false);
  // Bumped after a clip is re-encoded in place, to remount the player.
  const [playerReload, setPlayerReload] = useState(0);
  const [converting, setConverting] = useState(false);
  const [gameFilter, setGameFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [hkSave, setHkSave] = useState("");
  const [hkShort, setHkShort] = useState("");
  const [booting, setBooting] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [loopPreview, setLoopPreview] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [reorderNotice, setReorderNotice] = useState("");
  const [mixerOpen, setMixerOpen] = useState(false);
  const [audioNotice, setAudioNotice] = useState("");
  const [audioTracks, setAudioTracks] = useState(1);
  const [audioKeep, setAudioKeep] = useState<Set<number>>(new Set([0]));
  // Per-track export gain, 1 = unchanged. Applied in the ffmpeg mix.
  const [trackGain, setTrackGain] = useState<Record<number, number>>({});
  const [trackWaves, setTrackWaves] = useState<{ track: number; waveform: string }[]>([]);
  // Filmstrip image for the editor's video lane (10 tiled frames).
  const [filmstrip, setFilmstrip] = useState<string | null>(null);
  const [montageSel, setMontageSel] = useState<Set<string>>(new Set());
  const [montaging, setMontaging] = useState(false);
  // Kill timestamps (seconds) for the open clip, from the auto-clip sidecar.
  const [killMarkers, setKillMarkers] = useState<number[]>([]);
  // Last trim range per clip, persisted — montage cuts each clip to this.
  const [trimRanges, setTrimRanges] = useState<Record<string, [number, number]>>(() => {
    try {
      return JSON.parse(localStorage.getItem("clipforge_trims") || "{}");
    } catch {
      return {};
    }
  });
  // Last track keep/gain mix per clip, persisted — reopening a clip restores
  // its export mix instead of resetting to "mix only".
  const [audioMemory, setAudioMemory] = useState<
    Record<string, { keep: number[]; gain: Record<number, number> }>
  >(() => {
    try {
      return JSON.parse(localStorage.getItem("clipforge_audio") || "{}");
    } catch {
      return {};
    }
  });
  // Card focused by keyboard navigation; -1 = none.
  const [focusIdx, setFocusIdx] = useState(-1);
  // The grid rises in once per session; returning from the editor (Esc) or
  // Settings shows it instantly.
  const gridEntered = useRef(false);
  // Back-to-back preview of the selection: queue of paths + position.
  const [previewQueue, setPreviewQueue] = useState<string[] | null>(null);
  const [previewQIdx, setPreviewQIdx] = useState(0);
  // Index being dragged in the selection-reorder strip.
  const dragFrom = useRef(-1);
  // Timestamp of the previous session's last visit — clips newer than this
  // get a NEW badge. Advanced immediately so it stays fixed for this session.
  const lastSeenRef = useRef<number>(Number(localStorage.getItem("clipforge_seen") || 0));
  const [hoverPath, setHoverPath] = useState<string | null>(null);
  // Right-click context menu over a library card.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; clip: ClipInfo } | null>(null);
  // Release notes of the update that just installed (first boot only).
  const [whatsNew, setWhatsNew] = useState<{ version: string; notes: string } | null>(null);
  // Manual buffer pause — mirrors the supervisor flag, optimistic on click.
  const [bufferPaused, setBufferPaused] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [diskFree, setDiskFree] = useState<number | null>(null);
  const [exportPct, setExportPct] = useState<number | null>(null);
  // Which job the percentage belongs to: "export", "share", "upload", …
  const [exportLabel, setExportLabel] = useState<string | null>(null);
  // Share-as-link: the running job, this clip's saved links, and the
  // Streamable link field shown after the file is prepared.
  const [sharing, setSharing] = useState<"catbox" | "streamable" | null>(null);
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [streamableReady, setStreamableReady] = useState(false);
  const [streamableUrl, setStreamableUrl] = useState("");
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "largest" | "longest" | "name" | "kills">(
    "newest"
  );
  const [targetMb, setTargetMb] = useState(10);
  // Sidebar/library extras: starred clips already backed up, and what OBS is
  // really recording with ("AMD AV1 · 1080p60 · 20 Mbps"). Polled slowly;
  // both are cheap reads.
  const [backedUp, setBackedUp] = useState(0);
  const [recLine, setRecLine] = useState<string | null>(null);
  useEffect(() => {
    const load = () => {
      invoke<{ backed_up: number }>("backup_status")
        .then((b) => setBackedUp(b.backed_up))
        .catch(() => {});
      invoke<{ encoder: string | null; resolution: string | null; fps: number | null; bitrate_kbps: number | null }>(
        "obs_diagnostics",
      )
        .then((d) => {
          const enc = d.encoder ?? "";
          const codec = enc.includes("av1") ? "AV1" : enc.includes("265") || enc.includes("hevc") ? "HEVC" : "H.264";
          const vendor = enc.includes("amf") ? "AMD" : enc.includes("nvenc") ? "NVIDIA" : enc.includes("qsv") ? "Intel" : enc === "obs_x264" ? "CPU" : "";
          const h = d.resolution?.split("x")[1];
          const parts = [
            vendor ? `${vendor} ${codec}` : null,
            h && d.fps ? `${h}p${d.fps}` : null,
            d.bitrate_kbps ? `${Math.round(d.bitrate_kbps / 1000)} Mbps` : null,
          ].filter(Boolean);
          setRecLine(parts.length ? parts.join(" · ") : null);
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, []);
  const [renaming, setRenaming] = useState(false);
  const [libRenamePath, setLibRenamePath] = useState<string | null>(null);
  const [libRenameValue, setLibRenameValue] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  // While OBS or ffmpeg is missing, re-check every few seconds: the user may
  // install it outside the app (or the OBS installer's own window), and the
  // warning bar must clear without a restart.
  const setupIncomplete = setup !== null && !setup.ffmpeg_installed;
  useEffect(() => {
    if (!setupIncomplete || installing) return;
    const id = setInterval(() => {
      invoke<SetupStatus>("setup_status").then(setSetup).catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [setupIncomplete, installing]);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardStep, setOnboardStep] = useState(0);
  const [resetting, setResetting] = useState(false);
  const [gameSources, setGameSources] = useState<{ exe: string; kind: string }[]>([]);
  const [sourceBusy, setSourceBusy] = useState<string | null>(null);
  const [sourceTest, setSourceTest] = useState<
    Record<string, CaptureTest | "error">
  >({});
  const [kindChoice, setKindChoice] = useState<Record<string, string>>({});
  const [showAppPicker, setShowAppPicker] = useState(false);
  const [vcPicker, setVcPicker] = useState(false);
  const [runningApps, setRunningApps] = useState<RunningApp[]>([]);
  const [appVersion, setAppVersion] = useState("");
  const [launchingObs, setLaunchingObs] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Timeline DOM, driven by TimelineController (pointer, playhead, zoom).
  const tl = {
    scroller: useRef<HTMLDivElement>(null),
    sizer: useRef<HTMLDivElement>(null),
    surface: useRef<HTMLDivElement>(null),
    videoLane: useRef<HTMLDivElement>(null),
    playhead: useRef<HTMLDivElement>(null),
    range: useRef<HTMLDivElement>(null),
    startHandle: useRef<HTMLDivElement>(null),
    endHandle: useRef<HTMLDivElement>(null),
    dimLeft: useRef<HTMLDivElement>(null),
    dimRight: useRef<HTMLDivElement>(null),
  };
  const [timeline, setTimeline] = useState<TimelineController | null>(null);
  const [timelineZoom, setTimelineZoom] = useState(1);
  // Live "a → b" readout while dragging (written directly, no re-render).
  const trimReadoutRef = useRef<HTMLSpanElement>(null);
  // Per-track mixer: one hidden <audio> per track, each solo'd to its own
  // track, volume driven by that track's slider. The master <video> is muted
  // while this engine is active (multi-track clip + track API available).
  const trackAudioRefs = useRef<Record<number, HTMLAudioElement | null>>({});
  const perTrackOk = useRef(false);
  // Track elements already soloed to their track. Until then an element
  // would play the full mix (its default track), so it stays silent.
  const configuredTracks = useRef<Set<number>>(new Set());
  const settingsRef = useRef<Settings | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  settingsRef.current = settings;

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }

  function finishOnboarding() {
    localStorage.setItem("clipforge_onboarded", "1");
    setShowOnboarding(false);
    setOnboardStep(0);
  }

  // Mid-match (game running, window hidden) new clips are only listed:
  // thumbnail rendering waits until the game ends or the window is opened,
  // so ClipForge does no heavy work while you play.
  const gameRunningRef = useRef(false);
  const thumbsPendingRef = useRef(false);
  const refreshClips = useCallback(async (dir?: string) => {
    const clipsDir = dir ?? settingsRef.current?.clips_dir;
    if (!clipsDir) return;
    try {
      setClips(await invoke<ClipInfo[]>("list_clips", { dir: clipsDir }));
      if (gameRunningRef.current && document.hidden) {
        thumbsPendingRef.current = true;
        return;
      }
      thumbsPendingRef.current = false;
      setThumbs(await invoke<Record<string, ThumbInfo>>("gen_thumbnails", { dir: clipsDir }));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    gameRunningRef.current = !!sup?.game;
    if (!sup?.game && thumbsPendingRef.current) refreshClips();
  }, [sup?.game, refreshClips]);
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden && thumbsPendingRef.current) refreshClips();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshClips]);

  // Asks the capture engine for its state (the supervisor starts it). The
  // argument is unused; callers predate the engine.
  const connect = useCallback(async (_s?: Settings) => {
    setConnecting(true);
    setError(null);
    try {
      setStatus(await invoke<ObsStatus>("obs_connect"));
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      getVersion().then(setAppVersion).catch(() => {});
      const s = await invoke<Settings>("load_settings");
      settingsSubmitted.current = s;
      setSettings(s);
      setHkSave(s.hotkey_save);
      setHkShort(s.hotkey_short);
      try {
        const list = await invoke<ClipInfo[]>("list_clips", { dir: s.clips_dir });
        setClips(list);
      } catch {
        /* dir may not exist yet */
      }
      localStorage.setItem("clipforge_seen", String(Date.now()));
      invoke<string[]>("load_favorites").then(setFavorites).catch(() => {});
      invoke<{ version: string; notes: string } | null>("take_update_notes")
        .then((n) => n && setWhatsNew(n))
        .catch(() => {});
      invoke<SetupStatus>("setup_status")
        .then(setSetup)
        .catch(() => {});
      setBooting(false);
      if (!localStorage.getItem("clipforge_onboarded")) {
        setShowOnboarding(true);
      }
      // Thumbnails come after the splash — they take a few seconds.
      invoke<Record<string, ThumbInfo>>("gen_thumbnails", { dir: s.clips_dir })
        .then(setThumbs)
        .catch(() => {});
      connect();
    })();
  }, [connect, refreshClips]);

  const applySup = useCallback((s: SupervisorState) => {
    setSup(s);
    setBufferPaused(s.paused);
    setStatus((st) => ({ ...st, connected: s.connected, replay_buffer_active: s.buffer_active }));
    if (s.connected) setError(null);
  }, []);

  useEffect(() => {
    const unlisteners = [
      // Refresh comes from the dir-watcher's clips-changed event — a second
      // timer here just raced it into double refreshes.
      listen<{ path: string }>("clip-saved", () => showToast("Clip saved")),
      listen<boolean>("replay-buffer-state", (e) => {
        setStatus((s) => ({ ...s, replay_buffer_active: e.payload }));
      }),
      listen<string>("clip-error", (e) => setError(e.payload)),
      listen("clips-changed", () => refreshClips()),
      listen<{ label: string; pct: number }>("export-progress", (e) => {
        setExportLabel(e.payload.label);
        setExportPct(e.payload.pct);
      }),
      listen("auto-clip-armed", () => showToast("Kill detected — clipping in a few seconds…")),
      listen("auto-clipped", () => showToast("Auto-clipped!")),
      // Every settings save (UI or backend) arrives here, so the UI's copy
      // stays current and never overwrites a backend change when it saves.
      listen<Settings>("settings-changed", (e) => {
        if (!settingsPending.current && !settingsRetry.current) {
          settingsSubmitted.current = e.payload;
          setSettings(e.payload);
        }
      }),
      listen<{ stage: string; pct: number }>("engine-download-progress", (e) => setEngineProgress(e.payload)),
      // The game hook failed on a game and the backend switched it to
      // window capture: pick up the changed settings and say so.
      listen<string>("capture-fallback", async (e) => {
        showToast(`${e.payload} switched to window capture`);
        try {
          setSettings(await invoke<Settings>("load_settings"));
          setGameSources(await invoke<{ exe: string; kind: string }[]>("list_game_capture_sources"));
        } catch {
          /* next settings load picks it up */
        }
      }),
      listen<string>("update-installing", (e) =>
        showToast(`Updating to v${e.payload} — restarting shortly…`)
      ),
      listen("obs-disconnected", () => {
        setStatus({ connected: false, replay_buffer_active: false, obs_version: null });
      }),
      listen<SupervisorState>("supervisor-state", (e) => applySup(e.payload)),
    ];
    // State changes are only broadcast when they happen; one that fired
    // before this window was listening (app start, reload) is fetched here.
    invoke<SupervisorState | null>("supervisor_state")
      .then((s) => s && applySup(s))
      .catch(() => {});
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, [refreshClips, applySup]);

  useEffect(() => {
    if (!showSettings) return;
    setSourceTest({});
    invoke<{ exe: string; kind: string }[]>("list_game_capture_sources")
      .then(setGameSources)
      .catch(() => setGameSources([]));
  }, [showSettings]);

  useEffect(() => {
    let cancelled = false;
    const pending = [...clips];
    const counts: Record<string, number> = {};
    async function worker() {
      while (pending.length && !cancelled) {
        const clip = pending.shift()!;
        try { counts[clip.path] = (await invoke<number[]>("load_markers", { input: clip.path })).length; }
        catch { /* Missing sidecars are ordinary recordings. */ }
      }
    }
    Promise.all(Array.from({ length: 4 }, worker)).then(() => { if (!cancelled) setMarkerCounts(counts); });
    return () => { cancelled = true; };
  }, [clips]);

  useEffect(() => {
    if (!reduceMotion) return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHoverPath(null);
  }, [reduceMotion]);

  // Re-apply the keep-checkboxes to live playback whenever they change.
  useEffect(() => {
    syncPlaybackAudio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioKeep, selected]);

  // Solo one hidden <audio> element to a single track. Once any element
  // manages this, the per-track mixer owns playback audio: the video's own
  // audio tracks are switched off, and each track's slider drives its own
  // element's volume.
  function configTrackAudio(el: HTMLAudioElement, track: number) {
    const list = (el as unknown as {
      audioTracks?: { length: number; [i: number]: { enabled: boolean } };
    }).audioTracks;
    if (!list || list.length <= track) return;
    for (let k = 0; k < list.length; k++) list[k].enabled = k === track;
    configuredTracks.current.add(track);
    perTrackOk.current = true;
    silenceVideoAudio();
    applyTrackVolumes();
  }

  // The mixer plays the sound; the video plays none. Disabling its audio
  // tracks (rather than muting it) leaves its volume/mute controls usable:
  // they drive the mixer through applyTrackVolumes instead of adding a
  // second copy of the sound on top of it.
  function silenceVideoAudio() {
    const list = (videoRef.current as unknown as {
      audioTracks?: { length: number; [i: number]: { enabled: boolean } };
    } | null)?.audioTracks;
    if (list) for (let k = 0; k < list.length; k++) list[k].enabled = false;
    else if (videoRef.current) videoRef.current.muted = true;
  }

  function applyTrackVolumes() {
    if (!perTrackOk.current) return;
    const v = videoRef.current;
    // The video's own controls act as the master volume and mute.
    // (Without the audio-track API the video was muted by us, so its mute
    // state says nothing about the user's wish: play at full volume.)
    const hasTrackApi = !!v && "audioTracks" in v;
    const master = !v || !hasTrackApi ? 1 : v.muted ? 0 : v.volume;
    for (const key of Object.keys(trackAudioRefs.current)) {
      const i = Number(key);
      const el = trackAudioRefs.current[i];
      if (!el) continue;
      const audible = configuredTracks.current.has(i) && audioKeep.has(i);
      el.volume = audible ? Math.max(0, Math.min(1, trackGain[i] ?? 1)) * master : 0;
    }
  }

  // Track gain → live playback volume. With the per-track mixer active every
  // slider mixes live; otherwise (single-track clip or no track API) fall
  // back to the master volume following the first checked track. >100%
  // boosts land in the export only — element volume caps at 1.
  useEffect(() => {
    if (perTrackOk.current) {
      applyTrackVolumes();
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    const first = [...audioKeep].sort((a, b) => a - b)[0];
    v.volume = Math.max(0, Math.min(1, first != null ? trackGain[first] ?? 1 : 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioKeep, trackGain, selected]);

  // Per-track audio sync and the selection preview/loop. The playhead is
  // the TimelineController's job. The rAF loop only runs while playing, so
  // the editor sits at ~0% CPU when idle.
  useEffect(() => {
    if (!selected) return;
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    // Keep the per-track <audio> mixer locked to the video clock: pause
    // together, resume together, and nudge any element that drifts >0.2s.
    const syncAudios = () => {
      if (!perTrackOk.current) return;
      for (const [key, el] of Object.entries(trackAudioRefs.current)) {
        if (!el) continue;
        if (!configuredTracks.current.has(Number(key))) {
          if (!el.paused) el.pause();
          continue;
        }
        if (v.paused) {
          if (!el.paused) el.pause();
        } else if (el.paused) {
          el.currentTime = v.currentTime;
          el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - v.currentTime) > 0.2) {
          el.currentTime = v.currentTime;
        }
      }
    };
    const tick = () => {
      syncAudios();
      if (previewing) {
        if (v.currentTime >= trimEnd) {
          if (loopPreview) v.currentTime = trimStart;
          else {
            v.pause();
            setPreviewing(false);
          }
        } else if (v.currentTime < trimStart - 1) {
          setPreviewing(false);
        }
      }
      raf = v.paused ? 0 : requestAnimationFrame(tick);
    };
    const start = () => {
      if (!raf) raf = requestAnimationFrame(tick);
      syncAudios();
    };
    const onPause = () => syncAudios();
    const onSeeked = () => {
      // Align paused audio elements so a resume starts in sync.
      if (perTrackOk.current && v.paused) {
        for (const el of Object.values(trackAudioRefs.current)) {
          if (el?.paused) el.currentTime = v.currentTime;
        }
      }
    };
    v.addEventListener("play", start);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onSeeked);
    start(); // autoPlay may already be running when the effect attaches
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("play", start);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onSeeked);
    };
  }, [selected, previewing, trimStart, trimEnd, loopPreview]);

  // Keep the selection in sync with what actually exists — drop any selected
  // clip that got deleted, so the Montage/Delete count never counts ghosts.
  useEffect(() => {
    setMontageSel((prev) => {
      const live = new Set(clips.map((c) => c.path));
      const next = new Set([...prev].filter((p) => live.has(p)));
      return next.size === prev.size ? prev : next;
    });
    // Same for saved trim ranges and audio mixes, or localStorage fills
    // with dead paths.
    if (clips.length > 0) {
      const live = new Set(clips.map((c) => c.path));
      if (undoDelete) live.add(undoDelete.clip.path);
      const prune = <T,>(prev: Record<string, T>): Record<string, T> => {
        const stale = Object.keys(prev).filter((p) => !live.has(p));
        if (stale.length === 0) return prev;
        const next = { ...prev };
        stale.forEach((p) => delete next[p]);
        return next;
      };
      setTrimRanges(prune);
      setAudioMemory(prune);
    }
  }, [clips, undoDelete]);

  // Remember the trim range per clip (dropped again when it's the full clip),
  // so montage can cut each clip to its last trim without re-opening it.
  useEffect(() => {
    if (!selected || duration <= 0 || trimEnd <= 0) return;
    const path = selected.path;
    const isFull = trimStart <= 0 && trimEnd >= Math.floor(duration * 10) / 10;
    setTrimRanges((prev) => {
      if (isFull) {
        if (!(path in prev)) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      }
      const cur = prev[path];
      if (cur && cur[0] === trimStart && cur[1] === trimEnd) return prev;
      return { ...prev, [path]: [trimStart, trimEnd] };
    });
  }, [trimStart, trimEnd, duration, selected]);

  useEffect(() => {
    localStorage.setItem("clipforge_trims", JSON.stringify(trimRanges));
  }, [trimRanges]);

  // Remember the export mix per clip; the default (mix track only, all
  // gains at 100%) stores nothing.
  useEffect(() => {
    if (!selected) return;
    const path = selected.path;
    const keep = [...audioKeep].sort((a, b) => a - b);
    const gains = Object.entries(trackGain).filter(([, v]) => v !== 1);
    const isDefault = keep.length === 1 && keep[0] === 0 && gains.length === 0;
    setAudioMemory((prev) => {
      if (isDefault) {
        if (!(path in prev)) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      }
      const gain = Object.fromEntries(gains.map(([k, v]) => [Number(k), v]));
      const cur = prev[path];
      if (cur && JSON.stringify(cur) === JSON.stringify({ keep, gain })) return prev;
      return { ...prev, [path]: { keep, gain } };
    });
  }, [audioKeep, trackGain, selected]);

  useEffect(() => {
    localStorage.setItem("clipforge_audio", JSON.stringify(audioMemory));
  }, [audioMemory]);

  useEffect(() => {
    if (Object.keys(thumbs).length > 0) {
      localStorage.setItem("clipforge_thumbs", JSON.stringify(thumbs));
    }
  }, [thumbs]);

  // Watch free space on the clips drive — OBS silently fails to save when
  // the disk fills, so warn well before that.
  useEffect(() => {
    if (!settings?.clips_dir) return;
    const check = () =>
      invoke<number>("disk_free", { dir: settingsRef.current!.clips_dir })
        .then(setDiskFree)
        .catch(() => {});
    check();
    const timer = setInterval(check, 60_000);
    return () => clearInterval(timer);
  }, [settings?.clips_dir]);

  async function addGameSource(exe: string, kind: string) {
    setSourceBusy(exe);
    setError(null);
    try {
      await invoke("add_game_capture_source", { exe, kind });
      setGameSources(await invoke<{ exe: string; kind: string }[]>("list_game_capture_sources"));
      showToast(`Capture source added for ${exe}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSourceBusy(null);
    }
  }

  async function testGameSource(exe: string) {
    setSourceBusy(exe);
    try {
      const result = await invoke<CaptureTest>("test_capture_source", {
        name: `Capture: ${exe}`,
      });
      setSourceTest((s) => ({ ...s, [exe]: result }));
    } catch {
      setSourceTest((s) => ({ ...s, [exe]: "error" }));
    } finally {
      setSourceBusy(null);
    }
  }

  // Add an exe to the watch list (from the running-apps picker or a folder
  // browse). Also drops it from the blacklist in case it was removed before.
  async function addGameByExe(rawExe: string) {
    if (!settings) return;
    const exe = rawExe.trim().toLowerCase();
    if (isDiscordApp(exe)) {
      showToast("Discord is excluded from video capture");
      return;
    }
    if (settings.game_exes.some((g) => g.toLowerCase() === exe)) {
      showToast(`${exe} is already watched`);
      return;
    }
    const next: Settings = {
      ...settings,
      game_exes: [...settings.game_exes, exe],
      game_blacklist: settings.game_blacklist.filter((g) => g.toLowerCase() !== exe),
    };
    await saveSettings(next);
    showToast(`Added ${exe} — add a capture source for it below`);
  }

  async function openAppPicker() {
    try {
      setRunningApps(await invoke<{ exe: string; title: string }[]>("list_running_apps"));
      setShowAppPicker(true);
    } catch (e) {
      setError(String(e));
    }
  }

  async function addGameFromFolder() {
    const picked = await openDialog({
      filters: [{ name: "Game executable", extensions: ["exe"] }],
    });
    if (typeof picked !== "string") return;
    const exe = picked.split(/[\\/]/).pop();
    if (exe) await addGameByExe(exe);
  }

  async function removeGame(exe: string) {
    setSourceBusy(exe);
    try {
      const fresh = await invoke<Settings>("remove_watched_game", { exe });
      setSettings(fresh);
      // Tear down its OBS source too; ignore if there wasn't one.
      invoke("remove_game_capture_source", { exe }).catch(() => {});
      setGameSources((list) => list.filter((g) => g.exe !== exe));
      showToast(`Blocked ${exe}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSourceBusy(null);
    }
  }

  function selectClip(clip: ClipInfo) {
    setAudioNotice("");
    setSelected(clip);
    setTrimStart(0);
    setTrimEnd(0);
    setDuration(0);
    setPreviewing(false);
    const mem = audioMemory[clip.path];
    setAudioKeep(new Set(mem?.keep ?? [0]));
    setTrackGain(mem?.gain ?? {});
    setAudioTracks(1);
    setTrackWaves([]);
    perTrackOk.current = false;
    configuredTracks.current = new Set();
    trackAudioRefs.current = {};
    setRenaming(false);
    setKillMarkers([]);
    invoke<number[]>("load_markers", { input: clip.path })
      .then((m) => setKillMarkers(m ?? []))
      .catch(() => {});
    invoke<number>("list_audio_tracks", { input: clip.path })
      .then((count) => {
        setAudioTracks(count);
        // A remembered selection from before overlap handling may double
        // sound (mix + game): keep the specific tracks, drop the broad ones.
        setAudioKeep((prev) => withoutOverlaps(prev, count));
      })
      .catch(() => {});
    invoke<{ track: number; waveform: string }[]>("gen_waveforms", { input: clip.path })
      .then(setTrackWaves)
      .catch(() => {});
    setFilmstrip(null);
    invoke<string>("gen_filmstrip", { input: clip.path })
      .then(setFilmstrip)
      .catch(() => {});
  }

  // Mirror the keep-checkboxes onto the <video>'s audio tracks so preview
  // plays only the checked tracks. Needs the AudioVideoTracks blink feature
  // (enabled via additionalBrowserArgs); WebView2 may only play the first
  // enabled track, so preview is a guide — export does the real mix.
  function syncPlaybackAudio() {
    // The per-track mixer plays the audio; the video must stay silent.
    if (perTrackOk.current) {
      silenceVideoAudio();
      return;
    }
    const list = (videoRef.current as unknown as { audioTracks?: { length: number; [i: number]: { enabled: boolean } } })
      ?.audioTracks;
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      list[i].enabled = audioKeep.has(i);
    }
  }

  // Put the clip file on the clipboard — paste straight into Discord.
  async function copyClip(clip: ClipInfo) {
    try {
      await invoke("copy_clip", { path: clip.path });
      showToast("Clip copied — Ctrl+V it into Discord");
    } catch (e) {
      setError(`Could not copy this clip. Check that the source file is still available, then try Share again. Details: ${String(e)}`);
    }
  }

  function toggleMontage(clip: ClipInfo) {
    setMontageSel((prev) => {
      const next = new Set(prev);
      next.has(clip.path) ? next.delete(clip.path) : next.add(clip.path);
      return next;
    });
  }

  // Explorer-style: click selects one (the range start); shift-click makes
  // the selection exactly the run from that start to the shift-clicked clip,
  // in the currently visible (filtered) order.
  const selAnchor = useRef<string | null>(null);
  function handleSelect(clip: ClipInfo, shift: boolean) {
    if (shift && selAnchor.current && selAnchor.current !== clip.path) {
      const a = visibleClips.findIndex((x) => x.path === selAnchor.current);
      const b = visibleClips.findIndex((x) => x.path === clip.path);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setMontageSel(new Set(visibleClips.slice(lo, hi + 1).map((c) => c.path)));
        return; // keep the anchor — a further shift-click re-ranges from it
      }
    }
    toggleMontage(clip);
    selAnchor.current = clip.path;
  }

  // Move one entry of the (insertion-ordered) selection Set — the montage
  // cut order — from one position to another.
  function reorderSel(from: number, to: number) {
    const paths = [...montageSel];
    if (from < 0 || to < 0 || from >= paths.length || to >= paths.length || from === to) return;
    const moved = paths[from];
    setMontageSel(new Set(moveItem(paths, from, to)));
    setReorderNotice(`Clip moved to position ${to + 1} of ${paths.length}.`);
    requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>(".sel-strip-entry")].find((entry) => entry.dataset.selectionPath === moved)?.focus());
  }

  function queueNext() {
    setPreviewQIdx((i) => {
      if (previewQueue && i + 1 < previewQueue.length) return i + 1;
      setPreviewQueue(null);
      return 0;
    });
  }

  async function exportMontage() {
    setMontaging(true);
    setError(null);
    try {
      // Cut order = selection order (Sets iterate in insertion order; the
      // numbered badges on the cards show it). Each clip is cut to its
      // saved trim range (start=end=0 → whole clip).
      const inputs = [...montageSel]
        .map((p) => clips.find((c) => c.path === p))
        .filter((c): c is ClipInfo => !!c)
        .map((c) => {
          const r = trimRanges[c.path];
          return { path: c.path, start: r?.[0] ?? 0, end: r?.[1] ?? 0 };
        });
      const newPath = await invoke<string>("export_montage", { inputs });
      showToast(`Montage of ${inputs.length} clips saved — opening it`);
      setMontageSel(new Set());
      await refreshClips();
      // Same flow as trim: land in the result, not back in the grid
      // wondering where it went.
      const name = newPath.split("/").pop() ?? "";
      selectClip({ path: newPath, name, modified_ms: Date.now(), size_bytes: 0 });
    } catch (e) {
      setError(`Could not save the montage. Check that all selected clips are available and the clips drive has free space, then try again. Details: ${String(e)}`);
    } finally {
      setMontaging(false);
      setExportPct(null);
    }
  }

  // Per-day cleanup: every clip of that day that isn't starred goes to the
  // Recycle Bin (recoverable), after a confirm that names the count.
  async function clearUnstarred(day: string, dayClips: ClipInfo[]) {
    const paths = dayClips.filter((c) => !favorites.includes(c.path)).map((c) => c.path);
    if (paths.length === 0) return;
    const ok = await confirmDialog(
      `Move ${paths.length} unstarred clip${paths.length > 1 ? "s" : ""} from ${day} to the Recycle Bin? Starred clips stay.`,
      { title: "Keep starred, clear the rest", kind: "warning" }
    );
    if (!ok) return;
    setError(null);
    try {
      for (const path of paths) {
        await invoke("delete_clip", { path });
      }
      showToast(`Cleared ${paths.length} clip${paths.length > 1 ? "s" : ""} from ${day}`);
    } catch (e) {
      setError(String(e));
    } finally {
      await refreshClips();
    }
  }

  async function deleteSelected() {
    const paths = clips.filter((c) => montageSel.has(c.path)).map((c) => c.path);
    if (paths.length === 0) return;
    const ok = await confirmDialog(
      `Move ${paths.length} selected clip${paths.length > 1 ? "s" : ""} to the Recycle Bin?`,
      { title: "Delete selected", kind: "warning" }
    );
    if (!ok) return;
    setError(null);
    try {
      for (const path of paths) {
        await invoke("delete_clip", { path });
      }
      setMontageSel(new Set());
      showToast(`Deleted ${paths.length} clips`);
    } catch (e) {
      setError(String(e));
    } finally {
      await refreshClips();
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
      setError(`Could not export the GIF. Keep the selection under 15 seconds, check free disk space, then try again. Details: ${String(e)}`);
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
      setError(`Could not save the frame. Wait for the video to load and check free disk space, then try Save frame again. Details: ${String(e)}`);
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

  function startLibRename(clip: ClipInfo) {
    setLibRenamePath(clip.path);
    setLibRenameValue(clip.name.replace(/\.[^.]+$/, ""));
  }

  async function commitLibRename(clip: ClipInfo) {
    const value = libRenameValue.trim();
    setLibRenamePath(null);
    const base = clip.name.replace(/\.[^.]+$/, "");
    if (!value || value === base) return;
    try {
      const wasFav = favorites.includes(clip.path);
      const newPath = await invoke<string>("rename_clip", { path: clip.path, newName: value });
      if (wasFav) {
        await invoke("toggle_favorite", { path: clip.path });
        setFavorites(await invoke<string[]>("toggle_favorite", { path: newPath }));
      }
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


  // Timeline controller: created once the lanes exist, torn down with the
  // clip. React pushes the trim range and markers in; drags come back once.
  const onTimelineCommit = useRef((_start: number, _end: number, _by: "start" | "end" | "move") => {});
  onTimelineCommit.current = (start, end, by) => {
    setTrimStart(start);
    setTrimEnd(end);
    // Play the selection from the edge just moved; for the end handle,
    // start a couple of seconds before it so the cut point is audible.
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = by === "end" ? Math.max(start, end - 2) : start;
    setPreviewing(true);
    video.play().catch(() => {});
  };
  const hasDuration = duration > 0;
  useEffect(() => {
    const video = videoRef.current;
    const els = {
      scroller: tl.scroller.current,
      sizer: tl.sizer.current,
      surface: tl.surface.current,
      videoLane: tl.videoLane.current,
      playhead: tl.playhead.current,
      range: tl.range.current,
      startHandle: tl.startHandle.current,
      endHandle: tl.endHandle.current,
      dimLeft: tl.dimLeft.current,
      dimRight: tl.dimRight.current,
    };
    if (!selected || !hasDuration || !video || Object.values(els).some((el) => !el)) return;
    const ctl = new TimelineController(video, els as Record<keyof typeof els, HTMLElement>, {
      onTrimCommit: (start, end, by) => onTimelineCommit.current(start, end, by),
      onTrimLive: (start, end) => {
        if (trimReadoutRef.current) trimReadoutRef.current.textContent = trimReadout(start, end);
      },
      onInteract: () => setPreviewing(false),
      onZoom: setTimelineZoom,
    });
    setTimeline(ctl);
    setTimelineZoom(1);
    return () => {
      ctl.destroy();
      setTimeline(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.path, playerReload, hasDuration]);
  useEffect(() => {
    timeline?.setDuration(duration);
  }, [timeline, duration]);
  useEffect(() => {
    timeline?.setTrim(trimStart, trimEnd);
    if (trimReadoutRef.current) trimReadoutRef.current.textContent = trimReadout(trimStart, trimEnd);
  }, [timeline, trimStart, trimEnd]);
  useEffect(() => {
    timeline?.setMarkers(killMarkers);
  }, [timeline, killMarkers]);

  // Editor keyboard shortcuts: space play/pause, arrows frame-step
  // (shift = 1s), [ ] set trim markers at the playhead.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // Dropdowns (export size, audio) use the arrow keys themselves.
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (e.key !== "Escape" && target.closest("button, summary, [role=slider], [role=radio]"))
      )
        return;
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
        case "Escape":
          setSelected(null);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, duration, trimStart, trimEnd]);

  // Library / settings keyboard shortcuts: Esc backs out (settings → library,
  // selection → clear), Ctrl+A selects everything visible, Delete recycles
  // the selection, arrows walk the grid, Enter opens the focused clip.
  // Re-attached per render so closures stay fresh — cheap.
  useEffect(() => {
    if (selected) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (ctxMenu) return;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (e.key !== "Escape" && target.closest("button, summary, [role=slider], [role=radio]"))
      )
        return;
      // Queue player owns the keys while it's open.
      if (previewQueue) {
        if (e.key === "ArrowRight") queueNext();
        else if (e.key === "ArrowLeft") setPreviewQIdx((i) => Math.max(0, i - 1));
        else return;
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        if (showSettings) setShowSettings(false);
        else if (focusIdx !== -1) setFocusIdx(-1);
        else setMontageSel(new Set());
      } else if (!showSettings && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setMontageSel(new Set(visibleClips.map((c) => c.path)));
      } else if (!showSettings && e.key === "Delete" && montageSel.size > 0) {
        deleteSelected();
      } else if (!showSettings && e.key.startsWith("Arrow") && visibleClips.length > 0) {
        e.preventDefault();
        // Column count from layout: cards sharing the first card's top row.
        const cards = document.querySelectorAll<HTMLElement>(".grid .card");
        // Columns from the grid template: with day sessions the first row
        // can be a short session, so counting cards on it undercounts.
        const firstGrid = document.querySelector<HTMLElement>(".session-grid");
        const cols = firstGrid
          ? Math.max(1, getComputedStyle(firstGrid).gridTemplateColumns.split(" ").length)
          : 1;
        const delta =
          e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? cols : -cols;
        const next =
          focusIdx === -1 ? 0 : Math.max(0, Math.min(visibleClips.length - 1, focusIdx + delta));
        setFocusIdx(next);
        cards[next]?.focus();
      } else if (
        !showSettings &&
        e.key === "Enter" &&
        !(target instanceof HTMLButtonElement) &&
        focusIdx >= 0 &&
        focusIdx < visibleClips.length
      ) {
        selectClip(visibleClips[focusIdx]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Keyboard focus is positional — a new filter/sort reshuffles the grid,
  // so the old index would point at a different clip.
  useEffect(() => {
    setFocusIdx(-1);
  }, [gameFilter, search, sortBy]);

  // Any click or Esc anywhere closes the context menu.
  useEffect(() => {
    if (!ctxMenu) return;
    const owner = [...document.querySelectorAll<HTMLElement>(".card")].find((card) => card.dataset.clipPath === ctxMenu.clip.path);
    const previousFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : owner;
    document.querySelector<HTMLButtonElement>(".ctx-menu button")?.focus();
    const close = (restore = false) => {
      setCtxMenu(null);
      if (restore) requestAnimationFrame(() => {
        const active = document.activeElement;
        if (previousFocus?.isConnected && (active === document.body || (active instanceof Element && active.closest(".ctx-menu")))) previousFocus.focus();
      });
    };
    const onClick = (e: MouseEvent) => close(e.target instanceof Element && !!e.target.closest(".ctx-menu"));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close(true);
    };
    window.addEventListener("click", onClick);
    window.addEventListener("contextmenu", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("contextmenu", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

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

  // Winget install of a required tool (OBS / ffmpeg), shared by the setup
  // banner and the onboarding walkthrough.
  async function installTool(label: string, wingetId: string): Promise<boolean> {
    setInstalling(label);
    try {
      await invoke("winget_install", { id: wingetId });
      setSetup(await invoke("setup_status"));
      if (label === "ffmpeg") await refreshClips();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setInstalling(null);
    }
  }

  function saveSettings(snapshot: Settings): Promise<void> {
    const before = settingsSubmitted.current ?? settingsRef.current ?? snapshot;
    settingsSubmitted.current = snapshot;
    const version = ++settingsVersion.current;
    settingsPending.current++;
    settingsRetry.current = snapshot;
    settingsRef.current = snapshot;
    setSettings(snapshot);
    setSettingsSave({ state: "saving" });
    const request = writeSettings.current(before, snapshot).then((canonical) => {
      if (version === settingsVersion.current) {
        settingsSubmitted.current = canonical;
        settingsRef.current = canonical;
        setSettings(canonical);
        settingsRetry.current = null;
        setSettingsSave({ state: "saved" });
      }
    }).catch((error: unknown) => {
      if (version === settingsVersion.current) setSettingsSave({ state: "error", detail: String(error) });
      throw error;
    }).finally(() => { settingsPending.current--; });
    void request.catch(() => {});
    return request;
  }

  // Persist a new clips folder, point OBS's recording output at it, and
  // reload the library from the new location — all without an app restart.
  async function applyClipsDir(dir: string) {
    const next = { ...settingsRef.current!, clips_dir: dir };
    try { await saveSettings(next); }
    catch { return; }
    invoke("apply_obs_config").catch(() => {});
    await refreshClips(dir);
    showToast("Clips folder updated");
  }

  async function resetSettings() {
    const ok = await confirmDialog(
      "This resets every ClipForge setting (hotkeys, capture, storage cap, connection) back to defaults. Your clips are not affected.",
      { title: "Reset to defaults", kind: "warning" }
    );
    if (!ok || settingsPending.current) return;
    setResetting(true);
    try {
      const fresh = await invoke<Settings>("reset_settings");
      writeSettings.current.reset();
      settingsVersion.current++;
      settingsRetry.current = null;
      settingsSubmitted.current = fresh;
      settingsRef.current = fresh;
      setSettingsSave({ state: "idle" });
      setSettings(fresh);
      setHkSave(fresh.hotkey_save);
      setHkShort(fresh.hotkey_short);
      await invoke("set_hotkeys", { save: fresh.hotkey_save, short: fresh.hotkey_short });
      setSetup(await invoke("setup_status"));
      await refreshClips(fresh.clips_dir);
      showToast("Settings reset to defaults");
    } catch (e) {
      setError(String(e));
    } finally {
      setResetting(false);
    }
  }

  async function deleteClip(clip: ClipInfo) {
    if (deleting || restoring) return;
    setDeleting(true);
    setError(null);
    try {
      const id = await invoke<string>("recycle_clip", { path: clip.path });
      if (selected?.path === clip.path) setSelected(null);
      setCtxMenu(null);
      setClips((prev) => prev.filter((c) => c.path !== clip.path));
      setUndoDelete({ id, clip });
      showToast("Moved to Recycle Bin");
    } catch (e) { setError(String(e)); }
    finally { setDeleting(false); await refreshClips(); }
  }

  async function restoreDeleted() {
    if (!undoDelete || restoring) return;
    setRestoring(true);
    try {
      await invoke("restore_clip", { id: undoDelete.id });
      await refreshClips();
      setUndoDelete(null);
      showToast("Clip restored");
    } catch (e) { setError(`Could not restore clip: ${String(e)}. You can also restore it from the Recycle Bin.`); }
    finally { setRestoring(false); }
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
    if (!black.length) return;
    const ok = await confirmDialog(`Move ${black.length} blank recording${black.length === 1 ? "" : "s"} to the Recycle Bin? Review the marked clips first if you are unsure.`, { title: "Delete blank recordings", kind: "warning" });
    if (!ok) return;
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
      const newPath = await invoke<string>("trim_clip", {
        input: selected.path,
        start: trimStart,
        end: trimEnd,
      });
      showToast("Trimmed — opening the new clip");
      await refreshClips();
      // Jump straight into the result so the trim isn't a mystery file
      // sitting somewhere back in the library.
      const name = newPath.split("/").pop() ?? "";
      selectClip({ path: newPath, name, modified_ms: Date.now(), size_bytes: 0 });
    } catch (e) {
      setError(`Could not trim this clip. Check that the source file is available and the clips drive has free space, then retry. Details: ${String(e)}`);
    } finally {
      setTrimming(false);
    }
  }

  // Load the links already made for the open clip.
  useEffect(() => {
    setStreamableReady(false);
    setStreamableUrl("");
    if (!selected) {
      setShareLinks([]);
      return;
    }
    invoke<ShareLink[]>("list_share_links", { input: selected.path })
      .then(setShareLinks)
      .catch(() => setShareLinks([]));
  }, [selected]);

  function shareArgs() {
    return {
      input: selected!.path,
      start: trimStart,
      end: trimEnd,
      audioTracks: [...audioKeep].sort((a, b) => a - b).map((t) => [t, trackGain[t] ?? 1]),
    };
  }

  async function shareCatbox() {
    if (!selected) return;
    setSharing("catbox");
    setError(null);
    try {
      await invoke<string>("share_catbox", shareArgs());
      setShareLinks(await invoke<ShareLink[]>("list_share_links", { input: selected.path }));
      showToast("Link copied — paste it anywhere, it plays in Discord");
    } catch (e) {
      setError(`Could not upload to Catbox. Check your connection and optional account key in Sharing settings, then try again. Details: ${String(e)}`);
    } finally {
      setSharing(null);
      setExportPct(null);
    }
  }

  async function shareStreamable() {
    if (!selected) return;
    setSharing("streamable");
    setError(null);
    try {
      await invoke<string>("share_streamable", shareArgs());
      setStreamableReady(true);
      showToast("Drag the highlighted file onto streamable.com");
    } catch (e) {
      setError(`Could not prepare the Streamable upload. Check free disk space and that your browser can open, then try again. Details: ${String(e)}`);
    } finally {
      setSharing(null);
      setExportPct(null);
    }
  }

  async function saveStreamableLink() {
    if (!selected) return;
    try {
      await invoke("save_share_link", {
        input: selected.path,
        host: "streamable",
        url: streamableUrl,
        start: trimStart,
        end: trimEnd,
      });
      setShareLinks(await invoke<ShareLink[]>("list_share_links", { input: selected.path }));
      setStreamableReady(false);
      setStreamableUrl("");
    } catch (e) {
      setError(String(e));
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
        audioTracks: [...audioKeep].sort((a, b) => a - b).map((t) => [t, trackGain[t] ?? 1]),
      });
      showToast("Exported and copied to clipboard — Ctrl+V in Discord");
      await refreshClips();
    } catch (e) {
      setError(`Could not export for Discord. Check that the source clip is available and the clips drive has free space, then try Export and copy again. Details: ${String(e)}`);
    } finally {
      setExporting(false);
      setExportPct(null);
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
            <img src={appIcon} alt="" draggable={false} />
          </div>
          <span className="splash-name">ClipForge</span>
          <span className="splash-hint">loading library…</span>
        </div>
      </div>
    );
  }

  const games = [...new Set(clips.map(gameOf))].sort();
  const visibleClips = clips
    .filter(
      (c) =>
        (gameFilter === "all" ||
          (gameFilter === "favorites" ? favorites.includes(c.path) : gameOf(c) === gameFilter)) &&
        matchesClipSearch(c.name, gameOf(c), markerCounts[c.path] ?? 0, search)
    )
    .sort((a, b) => {
      switch (sortBy) {
        case "oldest":
          return a.modified_ms - b.modified_ms;
        case "kills":
          return clipKillCount(b.name, markerCounts[b.path] ?? 0) - clipKillCount(a.name, markerCounts[a.path] ?? 0) || b.modified_ms - a.modified_ms;
        case "largest":
          return b.size_bytes - a.size_bytes;
        case "longest":
          return (thumbs[b.path]?.duration ?? 0) - (thumbs[a.path]?.duration ?? 0);
        case "name":
          return a.name.localeCompare(b.name);
        default:
          return b.modified_ms - a.modified_ms;
      }
    });
  const totalSize = formatSize(clips.reduce((a, c) => a + c.size_bytes, 0));

  // Library sessions: sorted by date, clips group by the day they were
  // recorded ("Today · Valorant, CS2 · 6 clips · 1.4 GB"). Other sorts
  // stay one grid. Flat indices are kept for the keyboard focus.
  const clipGroups = (() => {
    const items = visibleClips.map((c, i) => ({ c, i }));
    if (sortBy !== "newest" && sortBy !== "oldest") {
      return [{ key: "all", label: "", meta: "", items }];
    }
    const dayKey = (ms: number) => new Date(ms).toDateString();
    const today = dayKey(Date.now());
    const yesterday = dayKey(Date.now() - 86400000);
    const groups: { key: string; label: string; meta: string; items: typeof items }[] = [];
    for (const it of items) {
      const key = dayKey(it.c.modified_ms);
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) {
        const label =
          key === today
            ? "Today"
            : key === yesterday
              ? "Yesterday"
              : new Date(it.c.modified_ms).toLocaleDateString(undefined, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                });
        g = { key, label, meta: "", items: [] };
        groups.push(g);
      }
      g.items.push(it);
    }
    for (const g of groups) {
      const names = [...new Set(g.items.map(({ c }) => gameName(gameOf(c))))];
      const gamesText = names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
      const n = g.items.length;
      const size = formatSize(g.items.reduce((a, { c }) => a + c.size_bytes, 0));
      g.meta = `${gamesText} · ${n} ${n === 1 ? "clip" : "clips"} · ${size}`;
    }
    return groups;
  })();
  const kbps = discordKbps(Math.max(0.1, trimEnd - trimStart), targetMb);
  const goodQuality = kbps >= 2000;

  return (
    <div className={`app-frame ${status.replay_buffer_active ? "live" : ""}`}>
      <div className="titlebar" data-tauri-drag-region>
        <span className="titlebar-title" data-tauri-drag-region>ClipForge</span>
        <span className="titlebar-live" title="Replay buffer is armed — gameplay is being recorded">
          <span className="titlebar-live-dot" />
          READY
        </span>
        <div className="titlebar-controls">
          <button
            className="tb-btn"
            title="Minimize" aria-label="Minimize"
            onClick={() => isTauri && getCurrentWindow().minimize()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1.2" /></svg>
          </button>
          <button
            className="tb-btn"
            title="Maximize" aria-label="Maximize"
            onClick={() => isTauri && getCurrentWindow().toggleMaximize()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.6" y="0.6" width="8.8" height="8.8" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
          </button>
          <button
            className="tb-btn close"
            title="Close" aria-label="Close"
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
            <img src={appIcon} alt="" draggable={false} />
          </div>
          <div className="brand-text">
            <span className="brand-name">ClipForge</span>
            <span className="brand-ver">{appVersion === "dev" ? "Development" : appVersion ? `v${appVersion}` : ""}</span>
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
          <button
            className={`nav-item ${showSettings ? "active" : ""}`}
            onClick={() => {
              setShowSettings(true);
              setSelected(null);
            }}
          >
            <GearSix size={17} weight={showSettings ? "fill" : "regular"} />
            Settings
          </button>
          {whatsNew && <button className="nav-item" onClick={() => setShowWhatsNew(true)}><Sparkle size={17} />What’s new <span className="update-dot" /></button>}
        </nav>

        <div className="sidebar-spacer" />

        <div className={`status-card ${status.replay_buffer_active ? "armed" : ""}`}>
          <div className="obs-row">
            <span className={`obs-dot ${status.connected ? "on" : ""}`} />
            <span className="obs-name">{sup?.engine_downloading ? "Setting up capture…" : "Capture engine"}</span>
            <span className="obs-ver">{status.obs_version ?? ""}</span>
          </div>
          <button
            className={`buffer-pill ${bufferPaused ? "paused" : status.replay_buffer_active ? "armed" : ""}`}
            title={
              bufferPaused
                ? "Recording is paused — click to resume"
                : "Click to pause recording — stays off, even in-game, until you resume"
            }
            onClick={() => {
              const next = !bufferPaused;
              setBufferPaused(next);
              invoke("set_buffer_paused", { paused: next }).catch(() => {});
              showToast(next ? "Recording paused until you resume it" : "Recording resumed");
            }}
          >
            <span className="buffer-dot" />
            {bufferPaused ? "PAUSED" : status.replay_buffer_active ? "REC" : "IDLE"}
          </button>
          {status.replay_buffer_active && !bufferPaused && (
            <div className="rec-summary">
              <span className="rec-ready">Last {formatDuration(settings.replay_seconds)} ready</span>
              {recLine && <span className="rec-line">{recLine}</span>}
            </div>
          )}
          {sup?.game && (
            <div className="game-row">
              <GameController size={15} color="#ff8c42" weight="fill" />
              <span className="game-name">{sup.game}</span>
              <span className="game-running">running</span>
            </div>
          )}
          {!sup?.game && status.replay_buffer_active && !bufferPaused && (
            <div className="game-row">
              <GameController size={15} color="#767a85" weight="fill" />
              <span className="game-name">Game closed</span>
              <span className="game-running">stopping shortly</span>
            </div>
          )}
          <div className="status-divider" />
          <button
            className="hotkey-rows"
            title="Change hotkeys"
            aria-label={`Hotkeys: save clip ${settings.hotkey_save}, short clip ${settings.hotkey_short}. Change hotkeys`}
            onClick={() => {
              setSelected(null);
              setShowSettings(true);
              // Settings mounts next frame; land on the hotkey field ready to record.
              setTimeout(() => {
                const el = document.getElementById("hotkey-save");
                el?.scrollIntoView({ block: "center" });
                el?.focus();
              }, 120);
            }}
          >
            <div className="hk-row">
              <span>Save clip</span>
              <kbd>{settings.hotkey_save}</kbd>
            </div>
            <div className="hk-row">
              <span>Short clip</span>
              <kbd>{settings.hotkey_short}</kbd>
            </div>
          </button>
        </div>
      </aside>

      <a className="skip-main" href="#clipforge-content" onClick={(e) => { e.preventDefault(); document.getElementById("clipforge-content")?.focus(); }}>Skip to main content</a>
      <main className="main" id="clipforge-content" tabIndex={-1}>
        {!showSettings && settingsSave.state === "error" && <div className="error-bar" role="alert"><span>Settings were not saved. Your edits are preserved.</span><button className="btn-ghost" onClick={() => { setSelected(null); setShowSettings(true); }}>Review settings</button></div>}
        {showSetupCheck && <SetupCheck
          supervisor={sup}
          onClose={() => setShowSetupCheck(false)}
          onSample={(path) => {
            setShowSettings(false);
            selectClip({ path, name: path.split(/[\\/]/).pop() ?? "Setup sample", modified_ms: Date.now(), size_bytes: 0 });
            void refreshClips();
          }}
        />}
        {exportPct != null && (
          <div className="export-bar">
            <div className="export-bar-fill" style={{ transform: `scaleX(${exportPct / 100})` }} />
          </div>
        )}
        {error && (
          <div className="error-bar" role="alert">
            <span>{error}</span>
            {/capture engine|replay buffer/i.test(error) && (
              <button
                className="setup-btn"
                disabled={launchingObs}
                onClick={async () => {
                  setLaunchingObs(true);
                  try {
                    await invoke("launch_obs");
                    setError(null);
                    showToast("Restarting the capture engine…");
                    setTimeout(() => connect(settings), 4000);
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setLaunchingObs(false);
                  }
                }}
              >
                {launchingObs ? "restarting…" : "Restart capture"}
              </button>
            )}
            <button className="error-dismiss" title="Dismiss" aria-label="Dismiss error" onClick={() => setError(null)}>
              <X size={14} />
            </button>
          </div>
        )}
        {diskFree != null && diskFree < 5 * 1024 ** 3 && (!diskDismissed || diskFree < 1024 ** 3) && (
          <div className={`setup-bar disk-bar ${diskFree < 1024 ** 3 ? "critical" : ""}`} role="status">
            <Warning size={15} weight="fill" />
            <span>
              Low disk space — {formatSize(diskFree)} free. Free up space to keep saving clips.
            </span>
            <button className="setup-btn" onClick={() => { setSelected(null); setShowSettings(true); requestAnimationFrame(() => document.getElementById("settings-storage")?.scrollIntoView()); }}>Storage settings</button>
            {diskFree >= 1024 ** 3 && <button className="btn-ghost" aria-label="Dismiss low disk warning" onClick={() => setDiskDismissed(true)}><X size={14} /></button>}
          </div>
        )}
        {sup?.engine_downloading && (
          <div className="setup-bar">
            <Warning size={15} weight="fill" />
            <span>
              Setting up the capture engine (one time, about 150 MB)
              {engineProgressText ? ` — ${engineProgressText}` : "…"} Clips record as soon as it's
              done.
            </span>
            {engineProgress && (
              <div className="engine-progress" role="progressbar" aria-valuenow={engineProgress.pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="engine-progress-fill" style={{ transform: `scaleX(${engineProgress.pct / 100})` }} />
              </div>
            )}
          </div>
        )}
        {sup?.engine_error && !sup.engine_downloading && (
          <div className="setup-bar">
            <Warning size={15} weight="fill" />
            <span>{sup.engine_error} ClipForge retries every minute.</span>
          </div>
        )}
        {setup && !setup.ffmpeg_installed && (
          <div className="setup-bar">
            <Warning size={15} weight="fill" />
            <span>ffmpeg is missing — needed for thumbnails, trims and exports.</span>
            <button
              className="setup-btn"
              disabled={installing !== null}
              onClick={() => installTool("ffmpeg", "Gyan.FFmpeg")}
            >
              {installing === "ffmpeg" ? "installing…" : "Install ffmpeg"}
            </button>
          </div>
        )}

        {sup?.game_elevated && (
          <div className="setup-bar">
            <Warning size={15} weight="fill" />
            <span>
              {sup.game} runs as admin, so ClipForge can't record it or hear your save hotkey.
            </span>
            <button
              className="setup-btn"
              onClick={async () => {
                try {
                  await invoke("set_run_elevated", { enabled: true });
                  await invoke("restart_elevated");
                } catch (error) {
                  setToast(String(error));
                }
              }}
            >
              Run ClipForge as admin
            </button>
          </div>
        )}
        {sup?.render_lag && (
          <div className="setup-bar">
            <Warning size={15} weight="fill" />
            <span>
              Clips are dropping frames: your GPU is maxed out by the game. Cap the game's FPS a
              little below your monitor's refresh rate to give recording some room.
            </span>
          </div>
        )}
        {!sup?.render_lag && sup?.encoder_lag && (
          <div className="setup-bar">
            <Warning size={15} weight="fill" />
            <span>
              The encoder can't keep up, so clips will stutter. Lower the bitrate or recording
              FPS in Settings.
            </span>
          </div>
        )}
        {showSettings ? null : !selected ? (
          <>
            <header className="lib-header">
              <div className="lib-title">
                <h1>Library</h1>
                <span className="lib-count">
                  {clips.length} clips · {totalSize}
                  {backedUp > 0 && ` · ${backedUp} backed up`}
                </span>
              </div>
              <div className="lib-actions">
                <div className="search-box">
                  <MagnifyingGlass size={15} color="#5f636e" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && setSearch("")}
                    placeholder="Search clips…"
                  />
                  {search && (
                    <button className="search-clear" title="Clear (Esc)" aria-label="Clear search" onClick={() => setSearch("")}>
                      <X size={13} />
                    </button>
                  )}
                </div>
                <select
                  className="audio-select"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                  title="Sort clips" aria-label="Sort clips"
                >
                  <option value="newest">Newest</option>
                  <option value="oldest">Oldest</option>
                  <option value="kills">Most kills</option>
                  <option value="largest">Largest</option>
                  <option value="longest">Longest</option>
                  <option value="name">Name</option>
                </select>
                <button
                  className="btn-ghost"
                  onClick={async () => {
                    setRefreshing(true);
                    await refreshClips();
                    setRefreshing(false);
                  }}
                  disabled={refreshing}
                  title="Reload clips from disk"
                  aria-label="Refresh"
                >
                  <ArrowsClockwise size={15} />
                  <span className="btn-label">{refreshing ? "refreshing…" : "Refresh"}</span>
                </button>
                <button
                  className="btn-ghost"
                  onClick={scanBlack}
                  disabled={scanning || clips.length === 0}
                  title="Find clips that recorded only a black screen"
                  aria-label="Find blank recordings"
                >
                  <MagnifyingGlass size={15} />
                  <span className="btn-label">{scanning ? "Checking…" : "Find blank recordings"}</span>
                </button>
                {blackCount > 0 && (
                  <button className="btn-danger" onClick={deleteAllBlack}>
                    <Trash size={15} />
                    Delete {blackCount} black
                  </button>
                )}
              </div>
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
                  // Active game chip wears its game's color, not the app accent.
                  style={
                    gameFilter === g
                      ? { borderColor: gameColor(g), background: `${gameColor(g)}1f` }
                      : undefined
                  }
                  onClick={() => setGameFilter(g)}
                >
                  <span className="chip-dot" style={{ background: gameColor(g) }} />
                  {gameName(g)}
                  <span className="chip-count">{clips.filter((c) => gameOf(c) === g).length}</span>
                </button>
              ))}
            </div>

            {visibleClips.length === 0 ? (
              clips.length > 0 ? (
                // Clips exist — this is a filter/search miss, not an empty library.
                <div className="empty-state">
                  <MagnifyingGlass size={44} color="#33363f" />
                  <span className="empty-title">No clips match</span>
                  <span className="empty-hint">
                    {search ? `Nothing named or tagged “${search}”` : "Nothing in this filter"}
                  </span>
                  <button
                    className="btn-ghost"
                    onClick={() => {
                      setSearch("");
                      setGameFilter("all");
                    }}
                  >
                    Clear search & filters
                  </button>
                </div>
              ) : (
                <div className="empty-state">
                  <FilmStrip size={44} color="#33363f" />
                  <span className="empty-title">No clips here yet</span>
                  <span className="empty-hint">
                    Press <span className="empty-key">{settings.hotkey_save}</span> in-game to save one
                  </span>
                </div>
              )
            ) : (
              <div
                className={gridEntered.current ? "grid" : "grid enter"}
                onAnimationEnd={(e) => {
                  if (e.target === e.currentTarget) gridEntered.current = true;
                }}
              >
                {clipGroups.map((g) => (
                  <section className="session" key={g.key} aria-label={g.label || "Clips"}>
                    {g.label && (
                      <div className="session-head">
                        <h2 className="session-title">{g.label}</h2>
                        <span className="session-meta">{g.meta}</span>
                        <span className="session-rule" />
                        {g.items.some(({ c }) => !favorites.includes(c.path)) && (
                          <details className="session-actions"><summary aria-label={`Cleanup options for ${g.label}`}>Cleanup</summary><button className="session-clear" onClick={() => clearUnstarred(g.label, g.items.map(({ c }) => c))}>
                            Keep starred, clear the rest
                          </button></details>
                        )}
                      </div>
                    )}
                    <div className="session-grid">
                {g.items.map(({ c, i }) => (
                  <div
                    key={c.path}
                    data-clip-path={c.path}
                    className={`card ${i === focusIdx ? "kb-focus" : ""}`}
                    style={{ "--game": gameColor(gameOf(c)) } as React.CSSProperties}
                    // Roving tabindex: Tab lands on one card, arrows walk the
                    // grid (library shortcuts below), Enter opens it.
                    tabIndex={i === Math.max(0, focusIdx) ? 0 : -1}
                    role="group"
                    aria-label={`${momentTitle(c.name, markerCounts[c.path] ?? 0)}, ${new Date(c.modified_ms).toLocaleString()}. Enter to edit; Shift+F10 for actions.`}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "F10" && e.shiftKey) {
                        e.preventDefault(); e.stopPropagation();
                        const r = e.currentTarget.getBoundingClientRect();
                        setCtxMenu({ x: Math.min(r.left, window.innerWidth - 200), y: Math.min(r.top, window.innerHeight - 300), clip: c });
                      }
                    }}
                    onFocus={(e) => e.target === e.currentTarget && setFocusIdx(i)}
                    // Shift-click anywhere on the card range-selects instead of
                    // opening; mousedown guard stops the browser text-select.
                    onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                    onClick={(e) => (e.shiftKey ? handleSelect(c, true) : selectClip(c))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      // Clamp so the menu never renders off-screen.
                      setCtxMenu({
                        x: Math.min(e.clientX, window.innerWidth - 200),
                        y: Math.min(e.clientY, window.innerHeight - 300),
                        clip: c,
                      });
                    }}
                  >
                    <div
                      className="card-thumb"
                      // Hover a beat → muted looping preview replaces the
                      // still. The delay keeps fast mouse passes from
                      // spinning up video decodes.
                      onMouseEnter={() => {
                        if (reduceMotion) return;
                        if (hoverTimer.current) clearTimeout(hoverTimer.current);
                        hoverTimer.current = setTimeout(() => setHoverPath(c.path), 250);
                      }}
                      onMouseLeave={() => {
                        if (hoverTimer.current) clearTimeout(hoverTimer.current);
                        setHoverPath((p) => (p === c.path ? null : p));
                      }}
                    >
                      <div className="thumb-placeholder" />
                      <img
                        // Remount when the backend confirms the thumb, so a
                        // guess that 404'd (fresh clip) retries once the
                        // file actually exists.
                        key={`${c.path}#${thumbs[c.path] ? "t" : "g"}`}
                        src={convertFileSrc(thumbs[c.path]?.thumb ?? guessThumb(c.path))}
                        alt=""
                        loading="lazy"
                        onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                      />
                      {hoverPath === c.path && !reduceMotion && (
                        // Layered over the still and faded in only once
                        // frames actually flow — no blank flash.
                        <video
                          className="thumb-preview"
                          src={convertFileSrc(c.path)}
                          muted
                          autoPlay
                          loop
                          playsInline
                          onPlaying={(e) => e.currentTarget.classList.add("ready")}
                        />
                      )}
                      <div className="thumb-vignette" />
                      <div className="game-tag">
                        <span className="chip-dot" style={{ background: gameColor(gameOf(c)) }} />
                        {gameName(gameOf(c))}
                      </div>
                      <div className="card-topright">
                        {killBadge(markerCounts[c.path] ?? 0, c.name) && <span className="highlight-badge"><Crosshair size={13} />{killBadge(markerCounts[c.path], c.name)}</span>}
                        {isSession(c.name) && <div className="session-badge">SESSION</div>}
                        {lastSeenRef.current > 0 &&
                          c.modified_ms > lastSeenRef.current &&
                          !isEdit(c.name) && <div className="new-badge">NEW</div>}
                        {trimRanges[c.path] && (
                          <div
                            className="trim-badge"
                            title={`Saved trim ${trimRanges[c.path][0].toFixed(1)}s → ${trimRanges[c.path][1].toFixed(1)}s — montage uses this cut`}
                          >
                            <Scissors size={11} weight="bold" />
                          </div>
                        )}
                        {blackMap[c.path] === true && (
                          <div className="black-badge">
                            <Warning size={11} weight="fill" />
                            BLACK
                          </div>
                        )}
                        <button
                          className={`card-select ${montageSel.has(c.path) ? "on" : ""}`}
                          title="Select — shift-click selects the range"
                          aria-label={montageSel.has(c.path) ? `Deselect ${c.name}` : `Select ${c.name}`}
                          aria-pressed={montageSel.has(c.path)}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelect(c, e.shiftKey);
                          }}
                        >
                          {montageSel.has(c.path) ? (
                            // Number = cut position in the montage.
                            <span className="sel-num">{[...montageSel].indexOf(c.path) + 1}</span>
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
                      <button className="card-quick-share" title="Copy file to share in Discord" aria-label={`Copy ${momentTitle(c.name, markerCounts[c.path] ?? 0)} to share`}
                        onClick={(e) => { e.stopPropagation(); void copyClip(c); }}><Copy size={15} /> Share</button>
                      <button className="card-menu" aria-label={`More actions for ${momentTitle(c.name, markerCounts[c.path] ?? 0)}`} title="More actions"
                        onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setCtxMenu({ x: Math.min(r.left, window.innerWidth - 200), y: Math.min(r.bottom, window.innerHeight - 300), clip: c }); }}><DotsThree size={20} weight="bold" /></button>
                      <button
                        className={`card-star ${favorites.includes(c.path) ? "on" : ""}`}
                        title="Favorite — survives storage cleanup"
                        aria-label={`Favorite ${c.name}`}
                        aria-pressed={favorites.includes(c.path)}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(c);
                        }}
                      >
                        <Star size={15} weight={favorites.includes(c.path) ? "fill" : "regular"} />
                      </button>
                    </div>
                    <div className="card-text">
                      {libRenamePath === c.path ? (
                        <input
                          className="card-rename"
                          autoFocus
                          value={libRenameValue}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setLibRenameValue(e.target.value)}
                          onBlur={() => commitLibRename(c)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitLibRename(c);
                            if (e.key === "Escape") setLibRenamePath(null);
                          }}
                        />
                      ) : (
                        <span className="card-title" title={c.name}>
                          {momentTitle(c.name, markerCounts[c.path] ?? 0)}
                          <button
                            className="card-rename-btn"
                            title="Rename"
                            aria-label={`Rename ${c.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              startLibRename(c);
                            }}
                          >
                            <PencilSimple size={13} />
                          </button>
                        </span>
                      )}
                      <span className="card-meta">
                        {new Date(c.modified_ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} <span className="meta-dot" /> {relativeTime(c.modified_ms)} <span className="meta-dot" /> {formatSize(c.size_bytes)}
                      </span>
                    </div>
                  </div>
                ))}
                    </div>
                  </section>
                ))}
              </div>
            )}

            <p className="library-hints"><span>Arrow keys: browse</span><span>Enter: edit</span><span>Shift-click: select a range</span><span>Right-click / Shift+F10: actions</span><span>Share: copy for Discord</span></p>
            {montageSel.size >= 1 && (
              <div className="sel-bar">
                {montageSel.size >= 2 && (
                  <div className="sel-strip" title="Montage cut order — drag to reorder">
                    {[...montageSel].map((p, i) => {
                      const c = clips.find((x) => x.path === p);
                      if (!c) return null;
                      return (
                        <div key={p} className="sel-strip-entry" data-selection-path={p} role="group" tabIndex={0}
                          aria-label={`Montage clip ${i + 1} of ${montageSel.size}: ${momentTitle(c.name, markerCounts[p] ?? 0)}. Control and arrow keys move it.`}
                          onKeyDown={(e) => {
                            if (!e.ctrlKey || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
                            e.preventDefault(); e.stopPropagation(); reorderSel(i, i + (e.key === "ArrowLeft" ? -1 : 1));
                          }}>
                        <div
                          className="sel-strip-item"
                          title={c.name}
                          draggable
                          onDragStart={() => (dragFrom.current = i)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => {
                            reorderSel(dragFrom.current, i);
                            dragFrom.current = -1;
                          }}
                        >
                          <img
                            src={convertFileSrc(thumbs[p]?.thumb ?? guessThumb(p))}
                            alt=""
                            draggable={false}
                            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                          />
                          <span className="sel-strip-num">{i + 1}</span>
                        </div>
                        <div className="sel-strip-moves">
                          <button aria-label={`Move clip ${i + 1} earlier`} disabled={i === 0} onClick={() => reorderSel(i, i - 1)}><ArrowLeft size={13} /></button>
                          <button aria-label={`Move clip ${i + 1} later`} disabled={i === montageSel.size - 1} onClick={() => reorderSel(i, i + 1)}><ArrowRight size={13} /></button>
                        </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <span className="sr-only" role="status">{reorderNotice}</span>
                <div className="sel-bar-row">
                  <span className="sel-count">
                    {montageSel.size} selected
                    {[...montageSel].some((p) => trimRanges[p]) && (
                      <span className="sel-trim-note">
                        <Scissors size={11} weight="bold" />
                        trims apply
                      </span>
                    )}
                  </span>
                  <button
                    className="btn-ghost"
                    title="Play the selection back-to-back (with trims) before rendering"
                    onClick={() => {
                      setPreviewQIdx(0);
                      setPreviewQueue([...montageSel]);
                    }}
                  >
                    <Play size={15} weight="fill" />
                    Preview
                  </button>
                  {montageSel.size >= 2 && (
                    <button
                      className="btn-discord"
                      onClick={exportMontage}
                      disabled={montaging}
                      title="Stitch the selected clips into one video, in badge order — clips with a saved trim contribute only that cut"
                    >
                      <FilmStrip size={15} weight="fill" />
                      {montaging
                        ? `rendering… ${exportPct != null ? Math.round(exportPct) + "%" : ""}`
                        : `Montage ${montageSel.size}`}
                    </button>
                  )}
                  <button className="btn-danger" onClick={deleteSelected} disabled={montaging}>
                    <Trash size={15} />
                    Delete {montageSel.size}
                  </button>
                  <button className="btn-ghost" onClick={() => setMontageSel(new Set())} title="Esc also clears">
                    Clear
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div
            className={`editor ${mixerOpen ? "mixer-open" : ""}`}
            style={{ "--game": gameColor(gameOf(selected)) } as React.CSSProperties}
          >
            <div className="editor-top">
              <button className="btn-ghost" onClick={() => setSelected(null)}>
                <ArrowLeft size={15} />
                Library
              </button>
              <span className="chip-dot" style={{ background: gameColor(gameOf(selected)) }} />
              <h1 className="editor-heading">
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
                <button
                  className="editor-title"
                  title={selected.name}
                  aria-label={`Rename ${momentTitle(selected.name, markerCounts[selected.path] ?? killMarkers.length)}`}
                  onClick={() => {
                    setRenameValue(selected.name.replace(/\.[^.]+$/, ""));
                    setRenaming(true);
                  }}
                >
                  {momentTitle(selected.name, markerCounts[selected.path] ?? killMarkers.length)}
                </button>
              )}
              </h1>
              <span className="editor-meta mono">
                {formatSize(selected.size_bytes)}
                {duration > 0 && ` · ${formatDuration(duration)}`}
              </span>
              <div className="lib-spacer" />
              <button
                className="btn-delete"
                title="Show in Explorer"
                aria-label="Show in Explorer"
                onClick={() => invoke("show_in_folder", { path: selected.path }).catch(() => {})}
              >
                <FolderOpen size={15} />
              </button>
              <button
                className={`btn-delete star ${favorites.includes(selected.path) ? "on" : ""}`}
                onClick={() => toggleFavorite(selected)}
              >
                <Star size={15} weight={favorites.includes(selected.path) ? "fill" : "regular"} />
                {favorites.includes(selected.path) ? "Favorited" : "Favorite"}
              </button>
              <button className="btn-delete" disabled={deleting || restoring} onClick={() => deleteClip(selected)}>
                <Trash size={15} />
                Delete
              </button>
            </div>

            <div className={`editor-stage ${audioTracks >= 5 ? "many-tracks" : ""}`}>
            <div className="player-wrap">
              <video
                ref={videoRef}
                key={`${selected.path}#${playerReload}`}
                src={convertFileSrc(selected.path)}
                controls
                autoPlay
                // Its volume/mute controls are the mixer's master.
                onVolumeChange={() => applyTrackVolumes()}
                onLoadStart={() => setNoVideo(false)}
                onLoadedMetadata={(e) => {
                  const d = e.currentTarget.duration;
                  setDuration(d);
                  // A video track the WebView can't decode loads as audio-only.
                  setNoVideo(e.currentTarget.videoWidth === 0);
                  // Restore the clip's last trim so montage prep survives
                  // closing and re-opening the editor.
                  const saved = trimRanges[selected.path];
                  if (saved && saved[0] < d) {
                    setTrimStart(Math.max(0, saved[0]));
                    setTrimEnd(Math.min(saved[1], d));
                  } else {
                    // Tenth-second precision like the handles; whole
                    // seconds cut up to a second off every full export.
                    setTrimEnd(Math.floor(d * 10) / 10);
                  }
                  syncPlaybackAudio();
                }}
              />
              {noVideo && (
                <div className="player-nodecode">
                  <strong>Can't preview this clip's video</strong>
                  <span>
                    It was recorded in a codec this player can't decode (usually HEVC). Converting
                    re-encodes it to H.264 (all audio tracks kept); the file plays everywhere after.
                  </span>
                  <button
                    className="setup-btn"
                    disabled={converting}
                    onClick={async () => {
                      setConverting(true);
                      try {
                        await invoke("convert_for_preview", { path: selected.path });
                        setPlayerReload((n) => n + 1);
                      } catch (error) {
                        setToast(String(error));
                      } finally {
                        setConverting(false);
                      }
                    }}
                  >
                    {converting ? "Converting…" : "Convert for preview"}
                  </button>
                </div>
              )}
              {audioTracks > 1 &&
                trackLabels(audioTracks).map((t) => (
                  <audio
                    key={`${selected.path}#track${t.i}`}
                    ref={(el) => {
                      trackAudioRefs.current[t.i] = el;
                    }}
                    src={convertFileSrc(selected.path)}
                    preload="auto"
                    onLoadedMetadata={(e) => configTrackAudio(e.currentTarget, t.i)}
                  />
                ))}
            </div>

            <aside className="export-panel" aria-label="Export">
              <section className="export-card">
                <h2 className="export-title">Share to Discord</h2>
                <div className="size-seg" role="radiogroup" aria-label="Discord size limit">
                  {[
                    { mb: 10, note: "Free" },
                    { mb: 50, note: "Basic" },
                    { mb: 500, note: "Nitro" },
                  ].map((o) => (
                    <button
                      key={o.mb}
                      role="radio"
                      aria-label={`${o.mb} MB · ${o.note}`}
                      tabIndex={targetMb === o.mb ? 0 : -1}
                      onKeyDown={(e) => {
                        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
                        e.preventDefault(); e.stopPropagation();
                        const sizes = [10, 50, 500];
                        const next = (sizes.indexOf(targetMb) + (["ArrowRight", "ArrowDown"].includes(e.key) ? 1 : 2)) % 3;
                        setTargetMb(sizes[next]);
                        (e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
                      }}
                      aria-checked={targetMb === o.mb}
                      className={targetMb === o.mb ? "on" : ""}
                      onClick={() => setTargetMb(o.mb)}
                    >
                      <span>{o.mb} MB</span>
                      <span className="size-note">{o.note}</span>
                    </button>
                  ))}
                </div>
                {/* No estimate until the clip's length is known — a 0s range
                    divides the size budget into a nonsense bitrate. */}
                {trimEnd - trimStart > 0 && (
                  <div className="export-quality">
                    <span>Quality</span>
                    <span className={`mono ${goodQuality ? "good" : "bad"}`}>
                      ~{(kbps / 1000).toFixed(1)} Mbps · {goodQuality ? "good" : "trim shorter"}
                    </span>
                  </div>
                )}
                <button className="btn-discord wide" onClick={exportDiscord} disabled={exporting || sharing !== null}>
                  <DiscordLogo size={17} weight="fill" />
                  {exporting
                    ? `exporting… ${exportPct != null && exportLabel === "export" ? Math.round(exportPct) + "%" : ""}`
                    : "Export and copy"}
                </button>
              </section>
              <details className="more-share"><summary>More ways to share</summary>
              <section className="export-card share-card">
                <h2 className="export-title">Share as link</h2>
                <span className="field-hint">
                  An HD copy of your selection. Anyone with the link can watch. catbox links don't
                  expire; free Streamable links last 90 days.
                </span>
                <div className="share-buttons">
                  <button className="btn-trim" onClick={shareCatbox} disabled={sharing !== null || exporting}>
                    <LinkSimple size={16} />
                    {sharing === "catbox"
                      ? exportLabel === "upload"
                        ? `uploading… ${exportPct != null ? Math.round(exportPct) + "%" : ""}`
                        : `making HD copy… ${exportPct != null ? Math.round(exportPct) + "%" : ""}`
                      : "catbox.moe link"}
                  </button>
                  <button
                    className="btn-trim"
                    title="Prepares the file and opens streamable.com — drag the file in there"
                    onClick={shareStreamable}
                    disabled={sharing !== null || exporting}
                  >
                    <ArrowSquareOut size={16} />
                    {sharing === "streamable"
                      ? `making HD copy… ${exportPct != null ? Math.round(exportPct) + "%" : ""}`
                      : "Streamable"}
                  </button>
                </div>
                {streamableReady && (
                  <form
                    className="set-row share-paste"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveStreamableLink();
                    }}
                  >
                    <input
                      className="mono"
                      placeholder="Paste the Streamable link to keep it here"
                      aria-label="Streamable share link" type="url" name="streamable-url" spellCheck={false} autoComplete="off"
                      value={streamableUrl}
                      onChange={(e) => setStreamableUrl(e.target.value)}
                    />
                    <button className="btn-ghost" type="submit" disabled={!streamableUrl.trim()}>
                      Save
                    </button>
                  </form>
                )}
                {shareLinks.length > 0 && (
                  <ul className="share-links">
                    {shareLinks.slice(0, 4).map((l) => (
                      <li key={l.url}>
                        <span className="share-host">{l.host}</span>
                        <span className="mono share-url" title={l.url}>
                          {l.url.replace(/^https:\/\//, "")}
                        </span>
                        <button
                          className="btn-ghost"
                          title="Copy link"
                          aria-label={`Copy ${l.host} link`}
                          onClick={() =>
                            invoke("copy_link", { url: l.url })
                              .then(() => showToast("Link copied"))
                              .catch((e) => setError(String(e)))
                          }
                        >
                          <Copy size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <div className="export-tools">
                <button className="btn-trim" onClick={doTrim} disabled={trimming || trimEnd <= trimStart}>
                  <Scissors size={16} />
                  {trimming ? "trimming…" : "Trim, lossless"}
                </button>
                <button
                  className="btn-trim"
                  title="Export the trim range as a GIF (15 s max)"
                  onClick={exportGif}
                  disabled={trimEnd - trimStart > 15 || trimEnd <= trimStart}
                >
                  <Gif size={18} />
                  GIF
                </button>
                <button className="btn-trim" onClick={exportFrame}>
                  <Camera size={16} />
                  Save frame
                </button>
                <button
                  className="btn-trim"
                  title="Copy the clip file, then paste it in Discord without exporting"
                  onClick={() => selected && copyClip(selected)}
                >
                  <Copy size={16} />
                  Copy file
                </button>
              </div>
              </details>
            </aside>
            </div>

            <div className="trim-section">
              <div className="trim-head">
                <div className="trim-actions">
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
                {killMarkers.length > 0 && (
                  <button
                    className="kill-count"
                    title="Jump to the first kill — timeline markers jump to each"
                    onClick={() => {
                      const v = videoRef.current;
                      const first = Math.min(...killMarkers);
                      if (!v || !isFinite(first)) return;
                      v.pause();
                      setPreviewing(false);
                      v.currentTime = Math.max(0, first);
                    }}
                  >
                    <Crosshair size={12} weight="bold" />
                    {killMarkers.length} kill{killMarkers.length > 1 ? "s" : ""}
                  </button>
                )}
                <button className="preview-btn mixer-toggle" aria-expanded={mixerOpen} aria-controls="clip-multitrack" onClick={() => setMixerOpen((open) => !open)}>
                  <Waveform size={14} />Audio · {audioKeep.has(0) ? "all" : `${audioKeep.size} tracks`}
                </button>
                </div>
                <span className="trim-readout" ref={trimReadoutRef}>
                  {trimReadout(trimStart, trimEnd)}
                </span>
                <div className="tl-zoom" title="Zoom the timeline (Ctrl + scroll)">
                  <button
                    className="preview-btn"
                    onClick={() => timeline?.zoomBy(1 / 1.5)}
                    disabled={timelineZoom <= 1}
                    aria-label="Zoom out"
                  >
                    <MagnifyingGlassMinus size={13} weight="bold" />
                  </button>
                  <span className="tl-zoom-level">
                    {timelineZoom < 10 ? timelineZoom.toFixed(1) : Math.round(timelineZoom)}×
                  </span>
                  <button
                    className="preview-btn"
                    onClick={() => timeline?.zoomBy(1.5)}
                    disabled={!timeline || timelineZoom >= timeline.maxZoom}
                    aria-label="Zoom in"
                  >
                    <MagnifyingGlassPlus size={13} weight="bold" />
                  </button>
                  <button
                    className="preview-btn"
                    onClick={() =>
                      trimStart <= 0.05 && trimEnd >= duration - 0.05
                        ? timeline?.setZoom(1)
                        : timeline?.fitRange(trimStart, trimEnd)
                    }
                    title="Zoom to the selection"
                    aria-label="Zoom to the selection"
                  >
                    <ArrowsInLineHorizontal size={13} weight="bold" />
                  </button>
                </div>
              </div>
              {duration > 0 && mixerOpen && <p className="audio-note" role="status">{audioNotice || (audioTracks >= 5 ? "Mix keeps all audio. Game or Voice replaces Mix/Desktop; add Mic to keep your reaction." : "Mix keeps all audio. Individual tracks replace the mix to avoid duplicate sound.")}</p>}
              {duration > 0 && (
                <div className="multitrack" id="clip-multitrack" tabIndex={mixerOpen ? 0 : -1} aria-label={mixerOpen ? "Audio mixer and timeline; scroll for more tracks" : "Video timeline"}>
                  <div className="mt-labels">
                    <div className="mt-ruler-spacer" />
                    <div className="mt-label mt-vid-label">
                      <FilmSlate size={14} weight="fill" />
                      video
                    </div>
                    {trackLabels(audioTracks).map((t) => {
                      const on = audioKeep.has(t.i);
                      return (
                        <label
                          key={t.i}
                          className={`mt-label mt-audio ${on ? "on" : ""}`}
                          title={
                            t.i === 0
                              ? "Keep in export. The mix already contains every other track."
                              : audioTracks >= 5 && t.i === 3
                                ? "Keep in export. Desktop already contains game and voice chat."
                                : "Keep in export"
                          }
                        >
                          <input
                            type="checkbox"
                            aria-label={`Include ${t.label} in export`}
                            checked={on}
                            onChange={(e) => {
                              const next = e.target.checked ? keepTrack(audioKeep, t.i, audioTracks) : new Set([...audioKeep].filter((i) => i !== t.i));
                              const removed = trackLabels(audioTracks).filter((track) => audioKeep.has(track.i) && !next.has(track.i));
                              const kept = trackLabels(audioTracks).filter((track) => next.has(track.i)).map((track) => track.label);
                              setAudioKeep(next);
                              setAudioNotice(`${removed.length ? `${removed.map((track) => track.label).join(" and ")} removed to avoid duplicate sound. ` : ""}Export audio: ${kept.join(", ") || "none (silent video)"}.${next.size === 1 && next.has(1) && audioTracks >= 5 ? " Add voice or mic to keep reactions." : ""}`);
                            }}
                          />
                          <t.Icon size={14} weight="fill" className="mt-label-icon" />
                          {t.label}
                          <input
                            type="range"
                            aria-label={`${t.label} export volume`}
                            aria-valuetext={`${Math.round((trackGain[t.i] ?? 1) * 100)} percent`}
                            min={0}
                            max={2}
                            step={0.05}
                            value={trackGain[t.i] ?? 1}
                            disabled={!on}
                            title={`Export volume: ${Math.round((trackGain[t.i] ?? 1) * 100)}% — double-click resets`}
                            onDoubleClick={() => setTrackGain((g) => ({ ...g, [t.i]: 1 }))}
                            onChange={(e) =>
                              setTrackGain((g) => ({ ...g, [t.i]: Number(e.target.value) }))
                            }
                          />
                        </label>
                      );
                    })}
                  </div>
                  <div ref={tl.scroller} className={`mt-scroller ${timelineZoom > 1 ? "zoomed" : ""}`}>
                    <div ref={tl.sizer} className="mt-sizer">
                      <div ref={tl.surface} className="mt-tracks">
                        <Ruler ctl={timeline} />
                        <div ref={tl.videoLane} className="mt-lane mt-vid">
                          <Filmstrip
                            ctl={timeline}
                            reel={filmstrip ? convertFileSrc(filmstrip) : null}
                            poster={thumbs[selected.path] ? convertFileSrc(thumbs[selected.path].thumb) : null}
                          />
                        </div>
                        {trackLabels(audioTracks).map((t) => {
                          const wave = trackWaves.find((w) => w.track === t.i);
                          return (
                            <div key={t.i} className={`mt-lane mt-audio ${audioKeep.has(t.i) ? "" : "off"}`}>
                              {wave && <img src={convertFileSrc(wave.waveform)} alt="" draggable={false} />}
                            </div>
                          );
                        })}
                        <div ref={tl.dimLeft} className="mt-dim left" />
                        <div ref={tl.dimRight} className="mt-dim right" />
                        <div ref={tl.range} className="mt-range" />
                        <KillMarkers
                          ctl={timeline}
                          times={killMarkers}
                          icon={<Crosshair size={11} weight="bold" />}
                          onJump={(t) => {
                            const v = videoRef.current;
                            if (!v) return;
                            v.pause();
                            setPreviewing(false);
                            v.currentTime = t;
                          }}
                        />
                        <div ref={tl.startHandle} className="mt-handle start" title="Drag or use arrow keys to trim" role="slider" tabIndex={0}
                          aria-label="Trim start" aria-valuemin={0} aria-valuemax={trimEnd - 0.5} aria-valuenow={trimStart} aria-valuetext={`${trimStart.toFixed(1)} seconds`}
                          onKeyDown={(e) => {
                            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
                            e.preventDefault(); e.stopPropagation();
                            const next = e.key === "Home" ? 0 : e.key === "End" ? trimEnd - 0.5 : trimStart + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 1 : 0.1);
                            setTrimStart(Math.round(Math.max(0, Math.min(trimEnd - 0.5, next)) * 10) / 10);
                          }}>
                          <span className="grip" />
                        </div>
                        <div ref={tl.endHandle} className="mt-handle end" title="Drag or use arrow keys to trim" role="slider" tabIndex={0}
                          aria-label="Trim end" aria-valuemin={trimStart + 0.5} aria-valuemax={duration} aria-valuenow={trimEnd} aria-valuetext={`${trimEnd.toFixed(1)} seconds`}
                          onKeyDown={(e) => {
                            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
                            e.preventDefault(); e.stopPropagation();
                            const next = e.key === "Home" ? trimStart + 0.5 : e.key === "End" ? duration : trimEnd + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 1 : 0.1);
                            setTrimEnd(Math.round(Math.max(trimStart + 0.5, Math.min(duration, next)) * 10) / 10);
                          }}>
                          <span className="grip" />
                        </div>
                        <div ref={tl.playhead} className="mt-playhead">
                          <div className="mt-playhead-grab" data-playhead />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <details className="editor-shortcuts"><summary>Keyboard shortcuts</summary>
            <p className="kbd-hints">
              <span className="key-hint"><kbd>space</kbd> play/pause</span>
              <span className="key-hint"><kbd>←</kbd><kbd>→</kbd> frame</span>
              <span className="key-hint"><kbd>shift</kbd> + arrows: 1s</span>
              <span className="key-hint"><kbd>[</kbd> start</span>
              <span className="key-hint"><kbd>]</kbd> end</span>
              <span className="key-hint"><kbd>ctrl</kbd> + scroll: zoom</span>
              <span className="key-hint"><kbd>esc</kbd> back</span>
            </p>
            </details>
          </div>
        )}

        {(toast || undoDelete) && (
          <div className="toast" role="status">
            <CheckCircle size={17} weight="fill" color="#40dd80" />
            {toast ?? "Clip moved to Recycle Bin"}
            {undoDelete && <><button className="btn-ghost" disabled={restoring} onClick={restoreDeleted}>{restoring ? "Restoring…" : "Undo delete"}</button><button className="btn-ghost" aria-label="Dismiss undo" onClick={() => setUndoDelete(null)}><X size={14} /></button></>}
          </div>
        )}

      {/* Waits for the tutorial so first launch never stacks two dialogs. */}
      {whatsNew && showWhatsNew && !showOnboarding && (
        <Modal label={`Updated to v${whatsNew.version}`} className="modal whatsnew-modal" onClose={() => setWhatsNew(null)}>
          <div className="modal-head">
            <Sparkle size={19} color="#7f9bff" weight="fill" />
            <span className="modal-title">Updated to v{whatsNew.version}</span>
            <div className="lib-spacer" />
            <button className="modal-close" onClick={() => setWhatsNew(null)} aria-label="Close">
              <X size={16} />
            </button>
          </div>
          <div className="modal-body">
            <span className="set-label">WHAT'S NEW</span>
            {whatsNew.notes
              .split(/\n+/)
              .filter((l) => l.trim())
              .map((line, i) => (
                <p key={i} className="onboard-copy">
                  {line.trim()}
                </p>
              ))}
            {!whatsNew.notes.trim() && (
              <p className="onboard-copy">Bug fixes and improvements.</p>
            )}
          </div>
          <div className="onboard-footer">
            <div />
            <button className="btn-ghost apply-btn" onClick={() => setWhatsNew(null)}>
              Nice
            </button>
          </div>
        </Modal>
      )}

      {ctxMenu && (
        <div className="ctx-menu" role="dialog" aria-label="Clip actions" style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onKeyDown={(e) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(e.key)) return;
            e.preventDefault(); e.stopPropagation();
            const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey) ? -1 : 1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }}>
          <button onClick={() => selectClip(ctxMenu.clip)}>
            <Play size={14} weight="fill" />
            Open in editor
          </button>
          <button onClick={() => copyClip(ctxMenu.clip)}>
            <Copy size={14} />
            Copy file — paste in Discord
          </button>
          <div className="ctx-sep" />
          <button onClick={() => toggleFavorite(ctxMenu.clip)}>
            <Star size={14} weight={favorites.includes(ctxMenu.clip.path) ? "fill" : "regular"} />
            {favorites.includes(ctxMenu.clip.path) ? "Unfavorite" : "Favorite"}
          </button>
          <button onClick={() => startLibRename(ctxMenu.clip)}>
            <PencilSimple size={14} />
            Rename
          </button>
          <button onClick={() => handleSelect(ctxMenu.clip, false)}>
            {montageSel.has(ctxMenu.clip.path) ? <CheckCircle size={14} weight="fill" /> : <Circle size={14} />}
            {montageSel.has(ctxMenu.clip.path) ? "Deselect" : "Select"}
          </button>
          <button onClick={() => invoke("show_in_folder", { path: ctxMenu.clip.path }).catch(() => {})}>
            <FolderOpen size={14} />
            Show in Explorer
          </button>
          <div className="ctx-sep" />
          <button className="danger" disabled={deleting || restoring} onClick={() => deleteClip(ctxMenu.clip)}>
            <Trash size={14} />
            Delete
          </button>
        </div>
      )}

      {previewQueue && previewQueue[previewQIdx] && (
        <Modal label="Clip preview queue" className="queue-player" onClose={() => setPreviewQueue(null)}>
          <video
            tabIndex={0}
            key={previewQueue[previewQIdx]}
            src={convertFileSrc(previewQueue[previewQIdx])}
            autoPlay
            controls
            onLoadedMetadata={(e) => {
              // Honor the clip's saved trim — start at its in-point…
              const r = trimRanges[previewQueue[previewQIdx]];
              if (r) e.currentTarget.currentTime = r[0];
            }}
            onTimeUpdate={(e) => {
              // …and advance at its out-point, like the montage will.
              const r = trimRanges[previewQueue[previewQIdx]];
              if (r && e.currentTarget.currentTime >= r[1]) queueNext();
            }}
            onEnded={queueNext}
          />
          <div className="queue-bar">
            <span className="queue-count">
              {previewQIdx + 1} / {previewQueue.length}
            </span>
            <span className="queue-name">{previewQueue[previewQIdx].split("/").pop()}</span>
            <div className="lib-spacer" />
            <button
              className="btn-ghost"
              disabled={previewQIdx === 0}
              onClick={() => setPreviewQIdx((i) => Math.max(0, i - 1))}
            >
              <ArrowLeft size={15} />
              Prev
            </button>
            <button className="btn-ghost" onClick={queueNext}>
              {previewQIdx + 1 < previewQueue.length ? "Next" : "Done"}
              <ArrowRight size={15} />
            </button>
            <button className="btn-ghost" onClick={() => setPreviewQueue(null)} title="Close (Esc)" aria-label="Close preview">
              <X size={15} />
            </button>
          </div>
        </Modal>
      )}

      {showAppPicker && (
        <AppPickerModal
          settings={settings}
          runningApps={runningApps}
          onAdd={addGameByExe}
          onRefresh={openAppPicker}
          onFolder={addGameFromFolder}
          onClose={() => setShowAppPicker(false)}
        />
      )}

      {vcPicker && (
        <VcPickerModal
          currentVc={settings.vc_exe}
          runningApps={runningApps}
          onPick={async (exe) => {
            try { await saveSettings({ ...settings, vc_exe: exe }); }
            catch { return; }
            setVcPicker(false);
            showToast(`Voice-chat audio set to ${exe}`);
          }}
          onClose={() => setVcPicker(false)}
        />
      )}

      {showSettings && (
        <SettingsPage
          onTestSetup={() => setShowSetupCheck(true)}
          settings={settings}
          setSettings={setSettings}
          saveSettings={saveSettings}
          savingSettings={settingsSave.state === "saving"}
          saveFeedback={settingsSave.state !== "idle" && <div className={`settings-save-feedback ${settingsSave.state}`} role={settingsSave.state === "error" ? "alert" : "status"}>
            <span>{settingsSave.state === "saving" ? "Saving settings…" : settingsSave.state === "saved" ? "Changes saved" : "Could not save settings. Your edits are preserved. Check the settings folder is writable, then retry."}</span>
            {settingsSave.state === "error" && <><button className="btn-ghost" onClick={() => { if (settingsRetry.current) void saveSettings(settingsRetry.current); }}>Retry saving</button><details><summary>Technical details</summary><p>{settingsSave.detail}</p></details></>}
          </div>}
          applyClipsDir={applyClipsDir}
          resetSettings={resetSettings}
          resetting={resetting}
          hkSave={hkSave}
          hkShort={hkShort}
          setHkSave={setHkSave}
          setHkShort={setHkShort}
          applyHotkeys={applyHotkeys}
          gameSources={gameSources}
          sourceBusy={sourceBusy}
          sourceTest={sourceTest}
          kindChoice={kindChoice}
          setKindChoice={setKindChoice}
          addGameSource={addGameSource}
          testGameSource={testGameSource}
          removeGame={removeGame}
          openAppPicker={openAppPicker}
          addGameFromFolder={addGameFromFolder}
          sup={sup}
          connect={connect}
          connecting={connecting}
          onTutorial={() => {
            setOnboardStep(0);
            setShowOnboarding(true);
          }}
          onPickVc={async () => {
            try {
              setRunningApps(await invoke<RunningApp[]>("list_running_apps"));
              setVcPicker(true);
            } catch (e) {
              setError(String(e));
            }
          }}
        />
      )}
      </main>

      {showOnboarding && (
        <OnboardingModal
          step={onboardStep}
          setStep={setOnboardStep}
          setup={setup}
          status={status}
          settings={settings}
          setSettings={setSettings}
          saveSettings={saveSettings}
          connecting={connecting}
          connect={connect}
          installing={installing}
          installTool={installTool}
          engineError={sup?.engine_error ?? null}
          engineDownloading={sup?.engine_downloading ?? false}
          engineProgress={engineProgressText}
          firstRun={!localStorage.getItem("clipforge_onboarded")}
          onClose={() => setShowOnboarding(false)}
          onFinish={finishOnboarding}
        />
      )}
      </div>
    </div>
  );
}

export default App;
