import { Fragment, Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { gameName, momentTitle, killBadge, clipKillCount, matchesClipSearch } from "./clip-presentation";
import { moveItem } from "./clip-selection";
import { createSettingsWriter } from "./settings-save";
import { useMediaQuery } from "./use-media-query";
import { SetupCheck } from "./SetupCheck";
import { StudioCommands, type StudioCommand } from "./StudioCommands";
import { isSessionRecording, recentSessions, latestClipForExport } from "./studio-data";
import { matchLabel, recordingMatchLabel, roundLabel } from "./match-presentation";
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
  ArrowsInLineHorizontal,
  DiscordLogo,
  DotsThree,
  Gif,
  CaretRight,
  Pause,
  SkipBack,
  SkipForward,
  SpeakerSlash,
  FilmSlate,
  FilmStrip,
  FolderOpen,
  GameController,
  GearSix,
  Headset,
  MagnifyingGlass,
  Microphone,
  MusicNotes,
  Monitor,
  PencilSimple,
  Play,
  Scissors,
  SpeakerHigh,
  Star,
  Sparkle,
  Trash,
  Warning,
  Waveform,
  X,
} from "@phosphor-icons/react";
import { AppPickerModal, Modal, OnboardingModal, SegRadios, SettingsPage, VcPickerModal, voiceAppsOf } from "./panels";
import { dateBucket, sessionIndices, sessionLabel } from "./library-groups";
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
  RecordingMetadata,
} from "./types";
import appIcon from "./assets/logo.svg";
import "./tokens.css";
import "./App.css";
import "./editor.css";
import "./studio.css";
const SessionView=lazy(()=>import("./SessionView").then(module=>({default:module.SessionView})));

// Editor times all read m:ss.t ("0:12.4"); lengths as seconds ("19.2 s").
function clipTime(s: number) {
  const tenths = Math.max(0, Math.round(s * 10));
  const m = Math.floor(tenths / 600);
  const sec = (tenths % 600) / 10;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
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
const isSession = isSessionRecording;

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
  return "#7fe6d7";
}

// The game's own icon once ClipForge has cached it from the game's .exe;
// until then a dot in the game's colour. Edits (trims, exports, GIFs) get scissors.
function GameMark({ game, icons }: { game: string; icons: Record<string, string> }) {
  if (game === "Edits") {
    return <span className="st-game-dot st-game-edits" aria-hidden="true"><Scissors size={13} weight="bold" /></span>;
  }
  const icon = icons[game.toLowerCase()];
  return icon ? (
    <img className="st-game-icon" src={convertFileSrc(icon)} alt="" draggable={false} />
  ) : (
    <span className="st-game-dot" aria-hidden="true"><span style={{ background: gameColor(game) }} /></span>
  );
}

// Label each audio track by what it actually contains, which depends on how
// many tracks the clip has: new clips record the full 5-track split, while
// older clips used a 3-track (mix/desktop/mic) or 2-track layout. Guessing
// from the count keeps the labels matching the real audio per track.
type ShareLink = { host: string; url: string; start: number; end: number; at: number };

type TrackMeta = { i: number; role?: string; label: string; Icon: typeof SpeakerHigh };

/// What each audio stream of a clip holds, in stream order. Clips skip
/// tracks that were switched off or had nothing to record, so a stream's
/// position alone doesn't say what it is.
type TrackRole = "mix" | "game" | "voice" | "desktop" | "mic" | "other" | "track";

/// Track ids used by settings (export_tracks, record_tracks) → role.
const ROLE_OF_ID: TrackRole[] = ["mix", "game", "voice", "desktop", "mic", "other"];

const ROLE_META: Record<TrackRole, { label: string; Icon: typeof SpeakerHigh }> = {
  mix: { label: "mix", Icon: SpeakerHigh },
  game: { label: "game", Icon: GameController },
  voice: { label: "voice", Icon: Headset },
  desktop: { label: "desktop", Icon: Monitor },
  mic: { label: "mic", Icon: Microphone },
  other: { label: "other apps", Icon: MusicNotes },
  track: { label: "track", Icon: Waveform },
};

/// Roles whose sound another role also holds: the mix holds everything,
/// desktop holds the game, voice chat and other apps.
function roleOverlaps(role: TrackRole): TrackRole[] {
  if (role === "mix") return ["game", "voice", "desktop", "mic", "other", "track"];
  if (role === "desktop") return ["mix", "game", "voice", "other"];
  if (role === "game" || role === "voice" || role === "other") return ["mix", "desktop"];
  return ["mix"];
}

/// Check stream `track` and uncheck everything that would double its sound.
function keepTrack(prev: Set<number>, track: number, roles: TrackRole[]): Set<number> {
  const clash = roleOverlaps(roles[track] ?? "track");
  const next = new Set([...prev].filter((t) => !clash.includes(roles[t] ?? "track")));
  next.add(track);
  return next;
}

/// Drop broad tracks (mix, then desktop) that overlap a kept specific one.
function withoutOverlaps(keep: Set<number>, roles: TrackRole[]): Set<number> {
  const next = new Set([...keep].filter((t) => t < Math.max(roles.length, 1)));
  if (next.size > 1) for (const t of [...next]) if (roles[t] === "mix") next.delete(t);
  if ([...next].some((t) => ["game", "voice", "other"].includes(roles[t]))) for (const t of [...next]) if (roles[t] === "desktop") next.delete(t);
  return next.size ? next : new Set([0]);
}

/// Settings track ids → this clip's stream indices (ids it lacks drop out).
function streamsForIds(ids: number[], roles: TrackRole[]): number[] {
  const streams = ids.map((id) => roles.indexOf(ROLE_OF_ID[id])).filter((i) => i >= 0);
  return streams.length ? streams : [0];
}

function trackLabels(roles: TrackRole[]): TrackMeta[] {
  if (roles.length <= 1) return [{ i: 0, label: "audio", Icon: SpeakerHigh }];
  return roles.map((role, i) => ({ i, role, ...ROLE_META[role], label: role === "track" ? `track ${i + 1}` : ROLE_META[role].label }));
}

function App() {
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const compactLibrary = useMediaQuery("(max-width: 1100px)");
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
  const [recordingMetadata, setRecordingMetadata] = useState<Record<string,RecordingMetadata>>({});
  const [metadataRevision,setMetadataRevision] = useState(0);
  useEffect(()=> {
    let cancelled=false;
    const timer=setTimeout(()=> { invoke<Record<string,RecordingMetadata>>("list_recording_metadata",{inputs:clips.map(c=>c.path)}).then(data=>{if(!cancelled)setRecordingMetadata(data??{});}).catch(()=>{}); },150);
    return ()=>{cancelled=true;clearTimeout(timer);};
  },[clips,metadataRevision]);
  const [selected, setSelected] = useState<ClipInfo | null>(null);
  const [sessionClip, setSessionClip] = useState<ClipInfo | null>(null);
  const pendingTrim = useRef<[number, number] | null>(null);
  const [commandsOpen, setCommandsOpen] = useState(false);
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
  const [trackRoles, setTrackRoles] = useState<TrackRole[]>(["mix"]);
  // Frame rate of the open clip, so arrow keys step exactly one frame.
  const [clipFps, setClipFps] = useState(30);
  const [playing, setPlaying] = useState(false);
  // Library groups folded shut, and older groups (folded by default) that
  // were opened; both remembered between runs.
  const loadKeys = (name: string) => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem(name) ?? "[]"));
    } catch {
      return new Set<string>();
    }
  };
  const [foldedGroups, setFoldedGroups] = useState(() => loadKeys("foldedGroups"));
  const [openedGroups, setOpenedGroups] = useState(() => loadKeys("openedGroups"));
  const isFolded = (key: string, recent: boolean) => foldedGroups.has(key) || (!recent && !openedGroups.has(key));
  const toggleGroup = (key: string, recent: boolean) => {
    const fold = !isFolded(key, recent);
    const folded = new Set(foldedGroups);
    const opened = new Set(openedGroups);
    if (fold) {
      folded.add(key);
      opened.delete(key);
    } else {
      folded.delete(key);
      opened.add(key);
    }
    setFoldedGroups(folded);
    setOpenedGroups(opened);
    try {
      localStorage.setItem("foldedGroups", JSON.stringify([...folded]));
      localStorage.setItem("openedGroups", JSON.stringify([...opened]));
    } catch {
      /* storage unavailable: folding just isn't remembered */
    }
  };
  // Drags snap to kill markers (as well as the playhead) while this is on.
  const [snapKills, setSnapKills] = useState(true);
  const [videoSize, setVideoSize] = useState<[number, number] | null>(null);
  // The zoom slider while it's being dragged (the controller reports the
  // settled zoom a moment later).
  const [zoomDraft, setZoomDraft] = useState<number | null>(null);
  const audioTracks = trackRoles.length;
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
  // The clip behind focusIdx, so the selection survives rows shifting.
  const focusPath = useRef<string | null>(null);
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
  // Library details panel: kill times per clip (loaded when its row takes
  // focus), the inline preview they seek, and the quick-export size.
  const [killTimes, setKillTimes] = useState<Record<string, number[]>>({});
  const inspectorVideo = useRef<HTMLVideoElement>(null);
  const [libExportMb, setLibExportMb] = useState(10);
  const [inspectorPath, setInspectorPath] = useState<string | null>(null);
  const [inspectorMedia, setInspectorMedia] = useState<{ path: string; tracks: number | null; links: ShareLink[]; error: boolean } | null>(null);
  useEffect(() => {
    if (!inspectorPath || selected || showSettings || sessionClip) return;
    let cancelled = false;
    setInspectorMedia(null);
    Promise.allSettled([
      invoke<number>("list_audio_tracks", { input: inspectorPath }),
      invoke<ShareLink[]>("list_share_links", { input: inspectorPath }),
    ]).then(([tracks, links]) => {
      if (!cancelled) setInspectorMedia({ path: inspectorPath, tracks: tracks.status === "fulfilled" ? tracks.value : null, links: links.status === "fulfilled" ? links.value : [], error: links.status === "rejected" });
    });
    return () => { cancelled = true; };
  }, [inspectorPath, selected, showSettings, sessionClip]);
  useEffect(() => { if (showSettings) setSessionClip(null); }, [showSettings]);
  // Admin banner: also make "restart automatically" this game's rule.
  const [adminAlways, setAdminAlways] = useState(false);
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
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "sessions" | "largest" | "longest" | "name" | "kills">(
    "newest"
  );
  const [targetMb, setTargetMb] = useState(10);
  // Sidebar/library extras: starred clips already backed up, and what OBS is
  // really recording with ("AMD AV1 · 1080p60 · 20 Mbps"). Polled slowly;
  // both are cheap reads.
  const [backedUp, setBackedUp] = useState(0);
  const [recLine, setRecLine] = useState<string | null>(null);
  // Cached game icons (label → PNG). Reloaded when a game starts: its icon
  // is extracted on first sight, a moment after the game appears.
  const [gameIcons, setGameIcons] = useState<Record<string, string>>({});
  const gameRunning = sup?.game ?? null;
  // Display name for the running game ("Valorant", not its .exe).
  const runningGameName = sup?.game_label ? gameName(sup.game_label) : sup?.game ? gameName(sup.game.replace(/\.exe$/i, "")) : null;
  useEffect(() => {
    const load = () => invoke<Record<string, string>>("list_game_icons").then(setGameIcons).catch(() => {});
    load();
    const later = setTimeout(load, 5000);
    return () => clearTimeout(later);
  }, [gameRunning]);
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
  const [vcPicker, setVcPicker] = useState<"voice" | "other" | null>(null);
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
    rangeLabel: useRef<HTMLSpanElement>(null),
  };
  const [timeline, setTimeline] = useState<TimelineController | null>(null);
  const [timelineZoom, setTimelineZoom] = useState(1);
  // In / Out / Selection readouts and the clock: written directly, so a
  // drag or playback never re-renders the editor.
  const trimInRef = useRef<HTMLSpanElement>(null);
  const trimOutRef = useRef<HTMLSpanElement>(null);
  const trimLenRef = useRef<HTMLSpanElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const paintTrimInfo = (start: number, end: number) => {
    const len = `${(end - start).toFixed(1)} s`;
    if (trimInRef.current) trimInRef.current.textContent = clipTime(start);
    if (trimOutRef.current) trimOutRef.current.textContent = clipTime(end);
    if (trimLenRef.current) trimLenRef.current.textContent = len;
    if (tl.rangeLabel.current) tl.rangeLabel.current.textContent = len;
  };
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

  // Apply a changed default immediately, while retaining per-export choices
  // until the default itself changes.
  useEffect(() => {
    setTargetMb(settings?.discord_target_mb || 10);
    setLibExportMb(settings?.discord_target_mb || 10);
  }, [settings?.discord_target_mb]);

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
      // An auto clip joined the one before it: follow it if that one was open.
      listen<{ old: string; new: string }>("clip-replaced", async (e) => {
        await refreshClips();
        const dir = settingsRef.current?.clips_dir;
        const list = dir ? await invoke<ClipInfo[]>("list_clips", { dir }) : [];
        const next = list.find((c) => c.path === e.payload.new);
        if (!next) return;
        setSelected((cur) => (cur?.path === e.payload.old ? next : cur));
        setInspectorPath((cur) => (cur === e.payload.old ? next.path : cur));
      }),
      listen("match-metadata-changed",()=>setMetadataRevision(n=>n+1)),
      listen<{ label: string; pct: number }>("export-progress", (e) => {
        setExportLabel(e.payload.label);
        setExportPct(e.payload.pct);
      }),
      listen("auto-clip-armed", () => showToast("Kill detected — clipping in a few seconds…")),
      listen("auto-clipped", () => showToast("Auto-clipped!")),
      listen<{ removed: number; relabeled: number; result: string | null }>("valorant-checked", (e) => {
        const { removed, relabeled, result } = e.payload;
        const parts = [
          result ? `Match ${result}` : "Match checked",
          removed ? `${removed} ${removed === 1 ? "clip" : "clips"} without your kill removed` : "",
          relabeled ? `${relabeled} relabeled` : "",
        ].filter(Boolean);
        showToast(parts.join(" · "));
      }),
      listen<number>("highlights-saved",(e) => showToast(`${e.payload} ${e.payload === 1 ? "highlight" : "highlights"} saved from your session`)),
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

  function selectClip(clip: ClipInfo, range?: [number, number]) {
    setSessionClip(null);
    setShowSettings(false);
    pendingTrim.current = range ?? null;
    setAudioNotice("");
    setSelected(clip);
    setTrimStart(0);
    setTrimEnd(0);
    setDuration(0);
    setPreviewing(false);
    const mem = audioMemory[clip.path];
    setAudioKeep(new Set(mem?.keep ?? [0]));
    setTrackGain(mem?.gain ?? {});
    setTrackRoles(["mix"]);
    setTrackWaves([]);
    perTrackOk.current = false;
    configuredTracks.current = new Set();
    trackAudioRefs.current = {};
    setRenaming(false);
    setKillMarkers([]);
    invoke<number[]>("load_markers", { input: clip.path })
      .then((m) => setKillMarkers(m ?? []))
      .catch(() => {});
    setClipFps(settings?.video_fps || 30);
    invoke<number>("clip_fps", { input: clip.path })
      .then((fps) => { if (fps > 0) setClipFps(fps); })
      .catch(() => {});
    invoke<TrackRole[]>("audio_track_roles", { input: clip.path })
      .then((roles) => {
        setTrackRoles(roles.length ? roles : ["mix"]);
        // New clips start from the default export tracks (Settings › Split
        // audio). A remembered selection from before overlap handling may
        // double sound (mix + game): keep the specific tracks.
        setAudioKeep((prev) => withoutOverlaps(mem?.keep ? prev : new Set(streamsForIds(settings?.export_tracks ?? [0], roles)), roles));
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

  function openClip(clip: ClipInfo) {
    setShowSettings(false);
    if (isSession(clip.name) || recordingMetadata[clip.path]?.is_session) { setSelected(null); setSessionClip(clip); }
    else selectClip(clip);
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

  function loadKillTimes(clip: ClipInfo) {
    setInspectorPath(clip.path);
    if (killTimes[clip.path]) return;
    invoke<number[]>("load_markers", { input: clip.path })
      .then((m) => setKillTimes((prev) => ({ ...prev, [clip.path]: m ?? [] })))
      .catch(() => setKillTimes((prev) => ({ ...prev, [clip.path]: [] })));
  }

  // Whole clip, default audio, sized to the chosen Discord tier. Trims and
  // per-track audio stay in the editor.
  async function exportClipForDiscord(clip: ClipInfo, mb: number) {
    setExporting(true);
    setError(null);
    try {
      // Default export tracks from Settings › Split audio, matched to the
      // tracks this clip actually has.
      const roles = await invoke<TrackRole[]>("audio_track_roles", { input: clip.path });
      const tracks = streamsForIds(settings?.export_tracks ?? [0], roles).map((t) => [t, 1]);
      await invoke<string>("export_discord", { input: clip.path, targetMb: mb, start: 0, end: 0, audioTracks: tracks });
      showToast("Exported and copied to clipboard — Ctrl+V in Discord");
      await refreshClips();
    } catch (e) {
      setError(`Could not export for Discord. Check that the source clip is available and the clips drive has free space, then try again. Details: ${String(e)}`);
    } finally {
      setExporting(false);
      setExportPct(null);
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
      rangeLabel: tl.rangeLabel.current,
    };
    if (!selected || !hasDuration || !video || Object.values(els).some((el) => !el)) return;
    const ctl = new TimelineController(video, els as Record<keyof typeof els, HTMLElement>, {
      onTrimCommit: (start, end, by) => onTimelineCommit.current(start, end, by),
      onTrimLive: paintTrimInfo,
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
    paintTrimInfo(trimStart, trimEnd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, trimStart, trimEnd]);
  useEffect(() => {
    timeline?.setMarkers(snapKills ? killMarkers : []);
  }, [timeline, killMarkers, snapKills]);
  // The transport clock: per frame while playing, once on every seek.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    const paint = () => {
      const el = clockRef.current;
      if (!el) return;
      const [whole, tenth] = clipTime(video.currentTime).split(".");
      el.innerHTML = `${whole}<small>.${tenth}</small>`;
    };
    const tick = () => {
      paint();
      raf = video.paused ? 0 : requestAnimationFrame(tick);
    };
    const onPlay = () => {
      setPlaying(true);
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setPlaying(false);
      paint();
    };
    paint();
    setPlaying(!video.paused);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", paint);
    video.addEventListener("timeupdate", paint);
    return () => {
      cancelAnimationFrame(raf);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", paint);
      video.removeEventListener("timeupdate", paint);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.path, playerReload, hasDuration]);

  // Editor keyboard shortcuts: space play/pause, arrows frame-step
  // (shift = 1s), [ ] set trim markers at the playhead.
  useEffect(() => {
    if (!selected || commandsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // Fields and dropdowns use these keys themselves; so do sliders and
      // radio groups for arrows. A focused button only keeps Space (it
      // presses the button), so arrows still step after clicking one.
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (e.key !== "Escape" && target.closest("[role=slider], [role=radio], [role=tab], [role=menu]")) ||
        (e.key === " " && target.closest("button, summary"))
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
        case "ArrowRight": {
          e.preventDefault();
          const dir = e.key === "ArrowRight" ? 1 : -1;
          if (timeline) {
            if (e.shiftKey) timeline.step(dir);
            else timeline.step(dir, clipFps);
          } else {
            video.pause();
            video.currentTime = Math.min(duration, Math.max(0, video.currentTime + dir * (e.shiftKey ? 1 : 1 / clipFps)));
          }
          break;
        }
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
  }, [selected, duration, trimStart, trimEnd, commandsOpen, timeline, clipFps]);

  // Library / settings keyboard shortcuts: Esc backs out (settings → library,
  // selection → clear), Ctrl+A selects everything visible, Delete recycles
  // the selection, arrows walk the grid, Enter opens the focused clip.
  // Re-attached per render so closures stay fresh — cheap.
  useEffect(() => {
    if (selected || sessionClip || commandsOpen) return;
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
      } else if (!showSettings && !e.ctrlKey && !e.metaKey && !e.altKey && focusIdx >= 0 && visibleClips[focusIdx] && (e.key === " " || e.key.toLowerCase() === "s")) {
        e.preventDefault();
        if (e.key.toLowerCase() === "s") void toggleFavorite(visibleClips[focusIdx]);
        else { const v = inspectorVideo.current; if (v?.paused) void v.play().catch(() => showToast("Preview unavailable. Open the editor to convert this recording.")); else v?.pause(); }
      } else if (!showSettings && e.key.startsWith("Arrow") && visibleClips.length > 0) {
        e.preventDefault();
        // Column count from layout: cards sharing the first card's top row.
        // One clip per table row, so every arrow steps a single row.
        // Rows in folded days aren't drawn: step over them, and find the
        // row by its clip rather than its position on screen.
        const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
        const folded = (i: number) => foldedPaths.has(visibleClips[i].path);
        let next = focusIdx === -1 ? 0 : focusIdx + delta;
        while (next >= 0 && next < visibleClips.length && folded(next)) next += delta;
        if (next < 0 || next >= visibleClips.length) next = focusIdx === -1 ? -1 : focusIdx;
        if (next < 0) return;
        setFocusIdx(next);
        document.querySelector<HTMLElement>(`.st-table .st-row[data-clip-path="${CSS.escape(visibleClips[next].path)}"]`)?.focus();
      } else if (
        !showSettings &&
        e.key === "Enter" &&
        !(target instanceof HTMLButtonElement) &&
        focusIdx >= 0 &&
        focusIdx < visibleClips.length
      ) {
        openClip(visibleClips[focusIdx]);
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
    const owner = [...document.querySelectorAll<HTMLElement>(".st-row")].find((card) => card.dataset.clipPath === ctxMenu.clip.path);
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
    if (!selected || trimEnd <= trimStart) return;
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
    if (!selected || trimEnd <= trimStart) return;
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
    if (!selected || trimEnd <= trimStart) return;
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

  // App-wide shortcuts only. Global recording shortcuts stay registered by Rust.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!settings || booting || e.repeat || e.altKey || !(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "k" && (!document.querySelector('[aria-modal="true"]') || commandsOpen)) {
        e.preventDefault(); setCommandsOpen(open => !open); return;
      }
      if (document.querySelector('[aria-modal="true"]')) return;
      if (key === ",") { e.preventDefault(); setSelected(null); setSessionClip(null); setShowSettings(s => !s); }
      else if (key === "e" && !exporting && !sharing && !showSettings) {
        e.preventDefault();
        if (e.shiftKey) { const latest = latestClipForExport(clips,recordingMetadata); if (latest) void exportClipForDiscord(latest, settings.discord_target_mb); }
        else if (selected) void exportDiscord();
        else if (sessionClip) selectClip(sessionClip);
        else if (inspected) void exportClipForDiscord(inspected, libExportMb);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
  // Sidebar views share the game filter's slot: "all", the smart lists, or a game.
  const inLibraryView = (c: ClipInfo, view: string) => {
    switch (view) {
      case "all":
        return true;
      case "favorites":
        return favorites.includes(c.path);
      case "multikills":
        return clipKillCount(c.name, markerCounts[c.path] ?? 0) >= 2;
      case "sessions":
        return isSession(c.name) || recordingMetadata[c.path]?.is_session;
      default:
        return gameOf(c) === view;
    }
  };
  const libraryViews = [
    { key: "all", label: "All clips", Icon: FilmStrip },
    { key: "multikills", label: "Multikills", Icon: Crosshair },
    { key: "favorites", label: "Favorites", Icon: Star },
    { key: "sessions", label: "Full matches", Icon: FilmSlate },
  ]
    .map((v) => ({ ...v, count: clips.filter((c) => inLibraryView(c, v.key)).length }))
    // Multikills appears once there are multikill clips (or while it's open).
    .filter((v) => v.key !== "multikills" || v.count > 0 || gameFilter === "multikills");
  // Open Settings and bring one section or field into view (it mounts next frame).
  const openSettingsAt = (id: string) => {
    setSelected(null);
    setShowSettings(true);
    setTimeout(() => {
      const el = document.getElementById(id);
      el?.scrollIntoView({ block: "start" });
      if (el instanceof HTMLInputElement) el.focus();
    }, 120);
  };
  const openLibraryView = (view: string) => {
    setShowSettings(false);
    setSelected(null);
    setSessionClip(null);
    setGameFilter(view);
  };
  const visibleClips = clips
    .filter(
      (c) =>
        inLibraryView(c, gameFilter) &&
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
    if (sortBy !== "newest" && sortBy !== "oldest" && sortBy !== "sessions") {
      return [{ key: "all", date: "", recent: true, label: "", meta: "", sub: "", dayItems: items, items }];
    }
    // Each clip's group: a play session, or a time bucket (days for the
    // last week, then weeks, months, years). A group with several matches
    // (or games) lists each as a sub-row under it. Cleanup acts on the
    // whole group.
    const now = Date.now();
    const sessionOf = sortBy === "sessions" ? sessionIndices(items.map(({ c }) => c.modified_ms)) : [];
    const sessionStart = new Map<number, number>();
    sessionOf.forEach((n, k) => sessionStart.set(n, items[k].c.modified_ms));
    const bucketOf = (k: number) => {
      if (sortBy !== "sessions") return dateBucket(items[k].c.modified_ms, now);
      const start = sessionStart.get(sessionOf[k]) ?? items[k].c.modified_ms;
      return { key: `s:${start}`, label: sessionLabel(start, now), recent: now - items[k].c.modified_ms < 7 * 86400000 };
    };
    const groups: { key: string; date: string; recent: boolean; label: string; meta: string; sub: string; dayItems: typeof items; items: typeof items }[] = [];
    items.forEach((it, k) => {
      const bucket = bucketOf(k);
      const matchId=recordingMetadata[it.c.path]?.matches.length === 1 ? recordingMetadata[it.c.path].matches[0].info.id : "";
      const key = `${bucket.key}:${matchId}`;
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) {
        g = { key, date: bucket.key, recent: bucket.recent, label: bucket.label, meta: "", sub: "", dayItems: [], items: [] };
        groups.push(g);
      }
      g.items.push(it);
    });
    const summary = (list: typeof items, match?: string) => {
      const names = [...new Set(list.map(({ c }) => gameName(gameOf(c))))];
      const gamesText = names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
      const n = list.length;
      const size = formatSize(list.reduce((a, { c }) => a + c.size_bytes, 0));
      const matches = new Set(list.map(({ c }) => recordingMetadata[c.path]?.matches.length === 1 ? recordingMetadata[c.path].matches[0].info.id : "").filter(Boolean)).size;
      const matchesText = !match && sortBy === "sessions" && matches > 1 ? ` · ${matches} matches` : "";
      return `${gamesText}${match ? ` · ${match}` : ""}${matchesText} · ${n} ${n === 1 ? "clip" : "clips"} · ${size}`;
    };
    for (const g of groups) {
      const metadata = recordingMetadata[g.items[0].c.path];
      g.meta = summary(g.items, metadata?.matches.length === 1 ? matchLabel(metadata.matches[0].info) : undefined);
    }
    for (const date of new Set(groups.map((g) => g.date))) {
      const day = groups.filter((g) => g.date === date);
      day[0].dayItems = day.flatMap((g) => g.items);
      if (day.length === 1) continue;
      for (const g of day) g.sub = g.meta;
      day[0].meta = summary(day[0].dayItems);
      for (const g of day.slice(1)) g.label = "";
    }
    return groups;
  })();
  // Clips in folded groups: not drawn, so keyboard focus steps over them.
  const foldedPaths = new Set(
    clipGroups.filter((g) => g.date && isFolded(g.date, g.recent)).flatMap((g) => g.items.map(({ c }) => c.path)),
  );
  const kbps = discordKbps(Math.max(0.1, trimEnd - trimStart), targetMb);
  const goodQuality = kbps >= 2000;
  // Details panel for the library row that has focus (click, arrows).
  // The panel follows the clip, not the row: a clip landing above the
  // selection (an export, a fresh save) would otherwise shift it.
  if (focusIdx >= 0 && focusPath.current && visibleClips[focusIdx]?.path !== focusPath.current) {
    const moved = visibleClips.findIndex((c) => c.path === focusPath.current);
    if (moved >= 0) setFocusIdx(moved);
  }
  const inspected = focusIdx >= 0 ? visibleClips[focusIdx] ?? null : null;
  const sessions = recentSessions(clips,3,recordingMetadata);
  const latestClip = latestClipForExport(clips,recordingMetadata);
  const commandClip = selected ? (trimEnd > trimStart ? selected : null) : sessionClip ?? inspected;
  const setTrackKept = (i: number, keep: boolean) => {
    const next = keep ? keepTrack(audioKeep, i, trackRoles) : new Set([...audioKeep].filter((x) => x !== i));
    const removed = trackLabels(trackRoles).filter((track) => audioKeep.has(track.i) && !next.has(track.i));
    const kept = trackLabels(trackRoles).filter((track) => next.has(track.i)).map((track) => track.label);
    setAudioKeep(next);
    setAudioNotice(`${removed.length ? `${removed.map((track) => track.label).join(" and ")} left out to avoid duplicate sound. ` : ""}Export audio: ${kept.join(", ") || "none (silent video)"}.${next.size === 1 && trackRoles[[...next][0]] === "game" ? " Add voice or mic to keep reactions." : ""}`);
  };
  // Clips: auto-clips save as you play. Whole match: the session is recorded
  // too, and its kills become highlight clips when the game closes.
  const setWholeMatch = (whole: boolean) => {
    if (whole === settings.session_recording) return;
    void saveSettings({ ...settings, session_recording: whole });
    showToast(
      whole
        ? settings.session_highlights
          ? "Recording whole matches. Highlights are cut when the game closes"
          : "Recording whole matches"
        : "Back to clips. Auto-clips save as you play",
    );
  };
  const commandItems: StudioCommand[] = [
    { id: "record-mode", group: "Actions", label: settings.session_recording ? "Switch to clips only" : "Switch to recording whole matches", keywords: "session record mode replay buffer highlights", detail: settings.session_recording ? "Now: whole match" : "Now: clips", run: () => setWholeMatch(!settings.session_recording) },
    ...(commandClip && !exporting && !sharing ? [{ id: "export", group: "Actions" as const, label: sessionClip ? "Edit session before exporting" : "Export selected clip for Discord", detail: `${selected ? targetMb : libExportMb} MB`, shortcut: "Ctrl E", keywords: "share copy", run: () => { if (selected) void exportDiscord(); else if (sessionClip) selectClip(sessionClip); else void exportClipForDiscord(commandClip, libExportMb); } }] : []),
    ...(latestClip && !exporting && !sharing ? [{ id: "latest", group: "Actions" as const, label: "Export latest clip for Discord", detail: `${settings.discord_target_mb} MB · ${momentTitle(latestClip.name, markerCounts[latestClip.path] ?? 0)}`, shortcut: "Ctrl Shift E", run: () => void exportClipForDiscord(latestClip, settings.discord_target_mb) }] : []),
    { id: "settings", group: "Actions", label: "Open settings", shortcut: "Ctrl ,", run: () => { setSelected(null); setShowSettings(true); } },
    { id: "export-settings", group: "Actions", label: "Settings › Export: Discord upload limit", keywords: "size free nitro", detail: `${settings.discord_target_mb} MB`, run: () => { setSelected(null); setShowSettings(true); requestAnimationFrame(() => document.querySelector<HTMLAnchorElement>('.settings-sections a[href="#settings-export"]')?.click()); } },
    ...libraryViews.map(v => ({ id: `view-${v.key}`, group: "Views" as const, label: v.label, detail: `${v.count} clips`, run: () => openLibraryView(v.key) })),
    ...games.map(g => ({ id: `game-${g}`, group: "Games" as const, label: gameName(g), run: () => { setSearch(""); openLibraryView(g); } })),
    ...[...clips].sort((a,b) => b.modified_ms - a.modified_ms).map(c => ({ id: c.path, group: "Clips" as const, label: momentTitle(c.name, markerCounts[c.path] ?? 0), keywords: `${c.name} ${gameName(gameOf(c))}`, detail: `${gameName(gameOf(c))} · ${new Date(c.modified_ms).toLocaleString()}`, run: () => openClip(c) })),
  ];
  const inspector = (() => {
    if (!inspected) {
      return (
        <aside className="st-insp st-insp-empty" aria-label="Clip details">
          <FilmStrip size={28} />
          <span>Select a clip to see its kills and share it.</span>
          <span className="st-insp-hint">Double-click or Enter opens a clip.</span>
        </aside>
      );
    }
    const c = inspected;
    const markers = markerCounts[c.path] ?? 0;
    const title = momentTitle(c.name, markers);
    const times = killTimes[c.path] ?? [];
    const kills = clipKillCount(c.name, markers);
    const length = thumbs[c.path]?.duration ?? 0;
    const fav = favorites.includes(c.path);
    const exportKbps = length > 0 ? discordKbps(length, libExportMb) : 0;
    const span = times.length > 1 ? times[times.length - 1] - times[0] : 0;
    return (
      <aside className="st-insp" aria-label="Clip details">
        <div className="st-insp-body">
          <video
            key={c.path}
            ref={inspectorVideo}
            className="st-insp-video"
            src={convertFileSrc(c.path)}
            poster={convertFileSrc(thumbs[c.path]?.thumb ?? guessThumb(c.path))}
            preload="none"
            controls
            aria-label={`Preview of ${title}`}
          />

          <div className="st-insp-title">
            <span>{title}</span>
            <span className="st-sub st-insp-game">
              <GameMark game={gameOf(c)} icons={gameIcons} />
              {gameName(gameOf(c))} · {new Date(c.modified_ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}
            </span>
            {recordingMetadata[c.path] && <span className="st-match-context">{recordingMatchLabel(recordingMetadata[c.path])}{roundLabel(recordingMetadata[c.path]) && ` · ${roundLabel(recordingMetadata[c.path])}`}</span>}
          </div>

          <dl className="st-insp-facts">
            <div>
              <dt>Kills</dt>
              <dd>{kills > 0 ? (span > 0 ? `${kills} in ${span.toFixed(1)} s` : `${kills}`) : "None marked"}</dd>
            </div>
            <div>
              <dt>Length</dt>
              <dd>{length ? formatDuration(length) : "–"}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatSize(c.size_bytes)}</dd>
            </div>
            <div>
              <dt>Saved</dt>
              <dd>{relativeTime(c.modified_ms)}</dd>
            </div>
            {inspectorMedia?.path === c.path && !!inspectorMedia.tracks && (
              <div className="st-insp-audio">
                <dt>Audio</dt>
                <dd>
                  {inspectorMedia.tracks} {inspectorMedia.tracks === 1 ? "track" : "tracks"}
                  <button className="st-link" onClick={() => { selectClip(c); setMixerOpen(true); }}>Edit mix</button>
                </dd>
              </div>
            )}
          </dl>

          {times.length > 0 && (
            <div className="st-insp-kills">
              <span className="st-insp-label">Kills in this clip</span>
              {times.map((t, k) => (
                <button
                  key={t}
                  className="st-insp-kill"
                  title="Jump the preview to this kill"
                  onClick={() => {
                    const v = inspectorVideo.current;
                    if (!v) return;
                    v.currentTime = Math.max(0, t - 2);
                    void v.play().catch(() => {});
                  }}
                >
                  <span className="st-insp-kill-dot" aria-hidden="true" />
                  Kill {k + 1}
                  <span className="st-insp-kill-time">{formatDuration(t)}.{Math.floor((t % 1) * 10)}</span>
                </button>
              ))}
            </div>
          )}

          {inspectorMedia?.path === c.path && inspectorMedia.links.length > 0 && (
            <div className="st-insp-links">
              <span className="st-insp-label">Shared links</span>
              <ul className="st-inspector-links">{inspectorMedia.links.map(link => <li key={link.url}><div><strong>{link.host}</strong><span title={link.url}>{link.url}</span><small>{formatDuration(link.start) || "0:00"} → {formatDuration(link.end) || "full clip"}</small></div><button className="st-ghost" aria-label={`Copy ${link.host} link`} onClick={() => invoke("copy_link", { url: link.url }).then(() => showToast("Link copied")).catch(e => setError(String(e)))}><Copy size={14} /></button></li>)}</ul>
            </div>
          )}

          {blackMap[c.path] === true && (
            <div className="st-insp-warn" role="status">
              <Warning size={16} weight="fill" />
              <span>
                <strong>This clip is black</strong>
                The game’s picture was hidden from capture, usually because the game runs as admin and ClipForge doesn’t.
                {sup?.game_elevated ? " That’s the case right now." : " Settings › Automation decides what ClipForge does when that happens."}
              </span>
              {sup?.game_elevated ? (
                <button className="st-primary st-solo" onClick={async () => {
                  try {
                    await invoke("ensure_admin_task");
                    await invoke("restart_elevated");
                  } catch (error) {
                    setToast(String(error));
                  }
                }}>Restart as admin</button>
              ) : (
                <button className="st-ghost" onClick={() => openSettingsAt("settings-automation")}>Admin rule</button>
              )}
            </div>
          )}
          <div className="st-insp-actions">
            {length > 0 && (
              <div className={`st-insp-hint-box ${exportKbps < 2000 ? "soft" : ""}`}>
                <span>
                  All {formatDuration(length)} at {libExportMb} MB → {(exportKbps / 1000).toFixed(1)} Mbps video.
                  {exportKbps < 2000 ? " May look soft." : " Looks clean."}
                </span>
                {exportKbps < 2000 && (
                  <span className="st-sub">
                    Trim it shorter to keep it sharp.{" "}
                    <button className="st-link" onClick={() => selectClip(c)}>Trim in editor</button>
                  </span>
                )}
              </div>
            )}
            <div className="st-split">
              <button className="st-primary" disabled={exporting} onClick={() => void exportClipForDiscord(c, libExportMb)}>
                <DiscordLogo size={16} weight="fill" />
                {exporting ? "Exporting…" : "Export for Discord"}
              </button>
              <select
                className="st-primary-select"
                aria-label="Discord upload limit"
                value={libExportMb}
                onChange={(e) => setLibExportMb(Number(e.target.value))}
              >
                <option value={10}>10 MB</option>
                <option value={50}>50 MB</option>
                <option value={500}>500 MB</option>
              </select>
            </div>
            <div className="st-insp-grid">
              <button className="st-ghost" onClick={() => openClip(c)}>
                <Scissors size={14} /> {isSession(c.name) ? "Open session" : "Edit"}
              </button>
              <button className="st-ghost" onClick={() => void copyClip(c)}>
                <Copy size={14} /> Copy file
              </button>
              <button className={`st-ghost ${fav ? "on" : ""}`} aria-pressed={fav} onClick={() => toggleFavorite(c)}>
                <Star size={14} weight={fav ? "fill" : "regular"} /> {fav ? "Starred" : "Star"}
              </button>
              <button className="st-ghost" onClick={() => invoke("show_in_folder", { path: c.path }).catch(() => {})}>
                <FolderOpen size={14} /> Show in folder
              </button>
            </div>
            <button className="st-ghost st-insp-delete" disabled={deleting} onClick={() => void deleteClip(c)}>
              <Trash size={14} /> Move to Recycle Bin
            </button>
          </div>
        </div>
      </aside>
    );
  })();


  return (
    <div className={`app-frame ${status.replay_buffer_active ? "live" : ""} ${showSettings ? "st-settings" : selected ? "st-editing" : sessionClip ? "st-session" : "st-library"}`}>
      <div className="titlebar" data-tauri-drag-region>
        <span className="titlebar-brand" data-tauri-drag-region title={`ClipForge ${appVersion}`}>
          <img src={appIcon} alt="" draggable={false} />
          <span className="titlebar-title" data-tauri-drag-region>ClipForge</span>
        </span>
        <button className="st-search titlebar-search st-command-trigger" onClick={() => setCommandsOpen(true)} aria-label="Search clips or run a command" aria-haspopup="dialog"><MagnifyingGlass size={14} /><span>Search clips or run a command</span><kbd>Ctrl K</kbd></button>
        <span className={`st-title-status ${sup?.game_elevated || sup?.engine_error ? "warn" : status.replay_buffer_active && !bufferPaused ? "recording" : "idle"}`} role="status">
          <span />
          {sup?.game_elevated ? `Can’t capture ${runningGameName ?? "this game"}` : sup?.engine_downloading ? "Setting up capture" : sup?.engine_error ? "Capture needs attention" : bufferPaused ? "Capture paused" : status.replay_buffer_active ? `Live${runningGameName ? ` · ${runningGameName}` : ""}` : "Waiting for a game"}
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
      <aside className="st-side" aria-label="Sidebar">
        <nav className="st-nav" aria-label="Clips">
          {libraryViews.map(({ key, label, Icon, count }) => {
            const active = !showSettings && gameFilter === key;
            return (
              <button
                key={key}
                className={`st-navlink ${active ? "active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={() => openLibraryView(key)}
              >
                <Icon size={15} weight={active ? "fill" : "regular"} />
                <span className="st-label">{label}</span>
                <span className="st-count">{count}</span>
              </button>
            );
          })}
        </nav>

        {games.length > 0 && (
          <>
            <div className="st-section">Games</div>
            <nav className="st-nav" aria-label="Games">
              {games.map((g) => {
                const active = !showSettings && gameFilter === g;
                return (
                  <button
                    key={g}
                    className={`st-navlink ${active ? "active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    onClick={() => openLibraryView(g)}
                  >
                    <GameMark game={g} icons={gameIcons} />
                    <span className="st-label">{gameName(g)}</span>
                    <span className="st-count">{clips.filter((c) => gameOf(c) === g).length}</span>
                  </button>
                );
              })}
            </nav>
          </>
        )}

        {sessions.length > 0 && <>
          <div className="st-section">Recent sessions</div>
          <nav className="st-recent-sessions" aria-label="Recent sessions">{sessions.map(c => <button key={c.path} className={sessionClip?.path === c.path ? "active" : ""} aria-current={sessionClip?.path === c.path ? "page" : undefined} onClick={() => openClip(c)}>
            <span>{gameName(gameOf(c))}<small>{new Date(c.modified_ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</small></span>
            <small>{thumbs[c.path]?.duration ? formatDuration(thumbs[c.path].duration) : "Full session"}</small>
          </button>)}</nav>
        </>}
        <div className="st-spacer" />

        <div className={`st-capture ${sup?.game_elevated ? "warn" : ""}`} role="status">
          <div className="st-capture-head">
            <span>Capture</span>
            <button
              className={`st-pill ${sup?.game_elevated ? "warn" : bufferPaused || !status.replay_buffer_active ? "idle" : ""}`}
              title={bufferPaused ? "Recording is paused. Click to resume" : "Click to pause recording. Stays off, even in-game, until you resume"}
              onClick={() => {
                const next = !bufferPaused;
                setBufferPaused(next);
                invoke("set_buffer_paused", { paused: next }).catch(() => {});
                showToast(next ? "Recording paused until you resume it" : "Recording resumed");
              }}
            >
              {sup?.game_elevated
                ? "Can’t capture"
                : sup?.engine_downloading
                  ? "Setting up"
                  : bufferPaused
                    ? "Paused"
                    : status.replay_buffer_active
                      ? "Live"
                      : "Idle"}
            </button>
          </div>
          <div className="st-mode" title="Clips: auto-clips save as you play. Whole match: each match is recorded and cut into highlights when the game closes.">
            <SegRadios label="Recording mode" value={settings.session_recording ? "match" : "clips"} options={[["clips", "Clips"], ["match", "Whole match"]]} onPick={(v) => setWholeMatch(v === "match")} />
          </div>
          <div className="st-buffer">
            <div className="st-buffer-row">
              <span>Replay buffer</span>
              <span>{status.replay_buffer_active && !bufferPaused ? `${formatDuration(settings.replay_seconds)} ready` : "Off"}</span>
            </div>
            <div className="st-meter" aria-hidden="true">
              <div style={{ transform: `scaleX(${status.replay_buffer_active && !bufferPaused ? 1 : 0})` }} />
            </div>
          </div>
          <dl className="st-kv">
            <dt>Game</dt>
            <dd title={sup?.game ?? undefined}>{runningGameName ? runningGameName : (status.replay_buffer_active && !bufferPaused ? "Closed, stopping soon" : "None running")}</dd>
            {recLine && (
              <>
                <dt>Output</dt>
                <dd title={recLine}>{recLine}</dd>
              </>
            )}
          </dl>
          <div className="st-divider" />
          <button
            className="st-hotkeys"
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
            <div>
              <span>Save clip</span>
              <kbd className="st-kbd">{settings.hotkey_save}</kbd>
            </div>
            <div>
              <span>Short clip</span>
              <kbd className="st-kbd">{settings.hotkey_short}</kbd>
            </div>
          </button>
        </div>

        <nav className="st-nav" aria-label="App" style={{ marginTop: 6 }}>
          {whatsNew && (
            <button className="st-navlink" onClick={() => setShowWhatsNew(true)}>
              <Sparkle size={15} />
              <span className="st-label">What’s new</span>
              <span className="update-dot" />
            </button>
          )}
          <button
            className={`st-navlink ${showSettings ? "active" : ""}`}
            aria-current={showSettings ? "page" : undefined}
            onClick={() => {
              setShowSettings(true);
              setSelected(null);
            }}
          >
            <GearSix size={15} weight={showSettings ? "fill" : "regular"} />
            <span className="st-label">Settings</span>
          </button>
        </nav>
      </aside>

      <a className="skip-main" href="#clipforge-content" onClick={(e) => { e.preventDefault(); document.getElementById("clipforge-content")?.focus(); }}>Skip to main content</a>
      <main className={`main ${!showSettings && !selected ? "st-lib-page" : ""}`} id="clipforge-content" tabIndex={-1}>
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

        {sup?.game_elevated && sup.game && (
          <div className="st-admin-banner" role="alert">
            <Warning size={18} weight="fill" />
            <div className="st-admin-text">
              <strong>Can’t capture {runningGameName}</strong>
              <span>
                It runs as administrator, so ClipForge can’t see it: clips come out black and {settings.hotkey_save} can’t reach the game.
                Restart as admin to fix it. Windows asks for permission the first time.
              </span>
            </div>
            <div className="st-admin-actions">
              <button
                className="st-primary st-solo"
                onClick={async () => {
                  try {
                    await invoke("ensure_admin_task");
                    if (adminAlways && sup.game) {
                      const exe = sup.game.toLowerCase();
                      await saveSettings({ ...settings, admin_rule_games: { ...settings.admin_rule_games, [exe]: "auto" } });
                    }
                    await invoke("restart_elevated");
                  } catch (error) {
                    setToast(String(error));
                  }
                }}
              >
                Restart as admin
              </button>
              <label className="st-admin-check">
                <input type="checkbox" checked={adminAlways} onChange={(e) => setAdminAlways(e.target.checked)} />
                Next time, restart automatically for this game
              </label>
            </div>
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
        {showSettings ? null : sessionClip ? <Suspense fallback={<p className="st-session-note" role="status">Opening full session…</p>}><SessionView key={sessionClip.path} clip={sessionClip} game={gameName(gameOf(sessionClip))} metadata={recordingMetadata[sessionClip.path]} durationHint={thumbs[sessionClip.path]?.duration ?? 0} starred={favorites.includes(sessionClip.path)} onStar={() => toggleFavorite(sessionClip)} onBack={() => setSessionClip(null)} onEdit={range => selectClip(sessionClip, range)} /></Suspense> : !selected ? (
          <>
            <div className="st-toolbar">
              <h1>{libraryViews.find((v) => v.key === gameFilter)?.label ?? gameName(gameFilter)}</h1>
              <span className="st-total">
                {visibleClips.length} · {formatSize(visibleClips.reduce((a, c) => a + c.size_bytes, 0))}
                {backedUp > 0 && ` · ${backedUp} backed up`}
              </span>
              <div className="st-toolbar-actions">
                <label className="st-search st-library-search"><MagnifyingGlass size={14} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter this view" aria-label="Filter clips" onKeyDown={e => { if (e.key === "Escape") setSearch(""); }} />{search && <button className="st-icon-btn" aria-label="Clear filter" onClick={() => setSearch("")}><X size={12} /></button>}</label>
                <select
                  className="st-select"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                  title="Sort clips" aria-label="Sort clips"
                >
                  <option value="newest">Newest</option>
                  <option value="oldest">Oldest</option>
                  <option value="sessions">Sessions</option>
                  <option value="kills">Most kills</option>
                  <option value="largest">Largest</option>
                  <option value="longest">Longest</option>
                  <option value="name">Name</option>
                </select>
                <button
                  className="st-ghost"
                  onClick={async () => {
                    setRefreshing(true);
                    await refreshClips();
                    setRefreshing(false);
                  }}
                  disabled={refreshing}
                  title="Reload clips from disk"
                  aria-label="Refresh"
                >
                  <ArrowsClockwise size={14} />
                  {refreshing ? "Refreshing…" : "Refresh"}
                </button>
                <button
                  className="st-ghost"
                  onClick={scanBlack}
                  disabled={scanning || clips.length === 0}
                  title="Find clips that recorded only a black screen"
                >
                  <MagnifyingGlass size={14} />
                  {scanning ? "Checking…" : "Find blank recordings"}
                </button>
                {blackCount > 0 && (
                  <button className="st-ghost danger" onClick={deleteAllBlack}>
                    <Trash size={14} />
                    Delete {blackCount} black
                  </button>
                )}
              </div>
            </div>

            {visibleClips.length === 0 ? (
              clips.length > 0 ? (
                // Clips exist — this is a filter/search miss, not an empty library.
                <div className="empty-state">
                  <MagnifyingGlass size={44} color="#33363f" />
                  <span className="empty-title">No clips match</span>
                  <span className="empty-hint">
                    {search ? `Nothing named or tagged “${search}”` : "Nothing in this view"}
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
                  <span className="empty-title">No clips yet</span>
                  <span className="empty-hint">
                    ClipForge keeps the last {formatDuration(settings.replay_seconds)} of gameplay, ready when you need it.
                  </span>
                  <div className="st-first-steps">
                    {/* Each step shows done (tick), now (numbered, teal) or later. */}
                    <div className={sup?.connected ? "done" : "now"}>
                      {sup?.connected ? <CheckCircle size={20} weight="fill" aria-label="Done" /> : <span className="st-step-num">1</span>}
                      <span><strong>{sup?.connected ? "Capture engine is ready" : "Check your capture setup"}</strong><span>{recLine ?? "Check picture and audio before your next game."}</span></span>
                      <button className="st-ghost" onClick={() => setShowSetupCheck(true)}>{sup?.connected ? "Test again" : "Test my setup"}</button>
                    </div>
                    <div className={sup?.game ? "done" : sup?.connected ? "now" : "later"}>
                      {sup?.game ? <CheckCircle size={20} weight="fill" aria-label="Done" /> : <span className="st-step-num">2</span>}
                      <span>
                        <strong>{sup?.game && runningGameName ? `${runningGameName} is running` : "Start a game"}</strong>
                        <span>Watched games arm the replay buffer automatically. If a game runs as admin, ClipForge offers to restart as admin so clips aren’t black.</span>
                      </span>
                      <button className="st-ghost" onClick={() => openSettingsAt("settings-games")}>Game not found?</button>
                    </div>
                    <div className={sup?.game ? "now" : "later"}>
                      <span className="st-step-num">3</span>
                      <span><strong>Save a good play</strong><span>Press <kbd className="st-kbd">{settings.hotkey_save}</kbd> after it happens, or let auto-clip catch your kills. The clip shows up here with its kills marked.</span></span>
                      <button className="st-ghost" onClick={() => openSettingsAt("hotkey-save")}>Change hotkey</button>
                    </div>
                  </div>
                </div>
              )
            ) : (
              <div className="st-lib-body">
              <div className="st-scroll">
                <table className="st-table">
                  <thead>
                    <tr>
                      <th scope="col" className="c-check">
                        <input
                          type="checkbox"
                          aria-label="Select all clips in this view"
                          checked={visibleClips.every((c) => montageSel.has(c.path))}
                          onChange={(e) => setMontageSel(e.target.checked ? new Set(visibleClips.map((c) => c.path)) : new Set())}
                        />
                      </th>
                      <th scope="col">Clip</th>
                      <th scope="col" className="c-game">Game</th>
                      <th scope="col" className="c-kills">Kills</th>
                      <th scope="col" className="c-len num">Length</th>
                      <th scope="col" className="c-size num">Size</th>
                      <th scope="col" className="c-saved num">Saved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clipGroups.map((g, gi) => {
                      const folded = !!g.date && isFolded(g.date, g.recent);
                      return (
                      // The same match can come back within a group (other
                      // clips in between), so its key alone isn't unique.
                      <Fragment key={`${g.key}#${gi}`}>
                        {g.label && (
                          <tr className={`st-group ${g.sub ? "st-group-day" : ""} ${folded ? "folded" : ""}`}>
                            <td colSpan={compactLibrary ? 4 : 7}>
                              <div className="st-group-inner">
                                <button
                                  type="button"
                                  className="st-group-toggle"
                                  aria-expanded={!folded}
                                  title={folded ? `Show ${g.label}'s clips` : `Hide ${g.label}'s clips`}
                                  onClick={() => toggleGroup(g.date, g.recent)}
                                >
                                  <CaretRight size={11} weight="bold" className="st-group-caret" />
                                  <strong>{g.label}</strong>
                                </button>
                                <span className="st-group-meta">{g.meta}</span>
                                {g.dayItems.some(({ c }) => !favorites.includes(c.path)) && (
                                  <details className="session-actions"><summary aria-label={`Cleanup options for ${g.label}`}>Cleanup</summary><button className="session-clear" onClick={() => clearUnstarred(g.label, g.dayItems.map(({ c }) => c))}>
                                    Keep starred, clear the rest
                                  </button></details>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                        {g.sub && !folded && (
                          <tr className="st-group st-group-sub">
                            <td colSpan={compactLibrary ? 4 : 7}>
                              <div className="st-group-inner"><span className="st-group-meta">{g.sub}</span></div>
                            </td>
                          </tr>
                        )}
                        {!folded && g.items.map(({ c, i }) => {
                          const markers = markerCounts[c.path] ?? 0;
                          const title = momentTitle(c.name, markers);
                          const kills = clipKillCount(c.name, markers);
                          const ace = killBadge(markers, c.name) === "ACE";
                          const fav = favorites.includes(c.path);
                          return (
                            <tr
                              key={c.path}
                              data-clip-path={c.path}
                              className={`st-row ${i === focusIdx ? "kb-focus" : ""} ${montageSel.has(c.path) ? "picked" : ""}`}
                              // Roving tabindex: Tab lands on one row, arrows walk
                              // the table (library shortcuts), Enter opens it.
                              tabIndex={i === Math.max(0, focusIdx) ? 0 : -1}
                              aria-label={`${title}, ${new Date(c.modified_ms).toLocaleString()}. Enter to open; Shift+F10 for actions.`}
                              onKeyDown={(e) => {
                                if (e.target !== e.currentTarget) return;
                                if (e.key === "F10" && e.shiftKey) {
                                  e.preventDefault(); e.stopPropagation();
                                  const r = e.currentTarget.getBoundingClientRect();
                                  setCtxMenu({ x: Math.min(r.left + 120, window.innerWidth - 200), y: Math.min(r.bottom, window.innerHeight - 300), clip: c });
                                }
                              }}
                              onFocus={(e) => {
                                if (e.target !== e.currentTarget) return;
                                focusPath.current = c.path;
                                setFocusIdx(i);
                                loadKillTimes(c);
                              }}
                              // Shift-click range-selects instead of opening; the
                              // mousedown guard stops the browser text-select.
                              onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                              // Click selects the row for the details panel; double-click
                              // or Enter opens the editor.
                              onClick={(e) => (e.shiftKey ? handleSelect(c, true) : e.currentTarget.focus())}
                              onDoubleClick={(e) => !e.shiftKey && openClip(c)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setCtxMenu({
                                  x: Math.min(e.clientX, window.innerWidth - 200),
                                  y: Math.min(e.clientY, window.innerHeight - 300),
                                  clip: c,
                                });
                              }}
                              // Hover a beat → muted looping preview over the still.
                              // The delay keeps fast mouse passes from decoding video.
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
                              <td className="c-check" onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={montageSel.has(c.path)}
                                  aria-label={`Select ${title}`}
                                  title="Select. Shift-click selects the range"
                                  onChange={() => {}}
                                  onClick={(e) => handleSelect(c, e.shiftKey)}
                                />
                              </td>
                              <td>
                                <div className="st-clip">
                                  <div className="st-thumb">
                                    <img
                                      // Remount when the backend confirms the thumb, so a
                                      // guess that 404'd (fresh clip) retries once the file exists.
                                      key={`${c.path}#${thumbs[c.path] ? "t" : "g"}`}
                                      src={convertFileSrc(thumbs[c.path]?.thumb ?? guessThumb(c.path))}
                                      alt=""
                                      loading="lazy"
                                      onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                                    />
                                    {hoverPath === c.path && !reduceMotion && (
                                      <video
                                        src={convertFileSrc(c.path)}
                                        muted
                                        autoPlay
                                        loop
                                        playsInline
                                        onPlaying={(e) => e.currentTarget.classList.add("ready")}
                                      />
                                    )}
                                  </div>
                                  <div className="st-clip-text">
                                    {libRenamePath === c.path ? (
                                      <input
                                        className="st-rename"
                                        autoFocus
                                        aria-label="Clip name"
                                        value={libRenameValue}
                                        onClick={(e) => e.stopPropagation()}
                                        onChange={(e) => setLibRenameValue(e.target.value)}
                                        onBlur={() => commitLibRename(c)}
                                        onKeyDown={(e) => {
                                          e.stopPropagation();
                                          if (e.key === "Enter") commitLibRename(c);
                                          if (e.key === "Escape") setLibRenamePath(null);
                                        }}
                                      />
                                    ) : (
                                      <span className="st-title">
                                        <span title={c.name}>{title}</span>
                                        {fav && <Star size={12} weight="fill" color="#f5c518" aria-label="Starred" style={{ flex: "0 0 auto" }} />}
                                        {isSession(c.name) && <span className="st-tag">Full match</span>}
                                        {blackMap[c.path] === true && <span className="st-tag warn">Black</span>}
                                        {trimRanges[c.path] && (
                                          <span className="st-tag" title={`Saved trim ${clipTime(trimRanges[c.path][0])} → ${clipTime(trimRanges[c.path][1])}. Montage uses this cut`}>Trimmed</span>
                                        )}
                                        {lastSeenRef.current > 0 && c.modified_ms > lastSeenRef.current && !isEdit(c.name) && (
                                          <span className="st-tag new">New</span>
                                        )}
                                      </span>
                                    )}
                                    <span className="st-sub" title={c.name}>
                                      {relativeTime(c.modified_ms)} · {recordingMatchLabel(recordingMetadata[c.path]) ? [recordingMatchLabel(recordingMetadata[c.path]),roundLabel(recordingMetadata[c.path])].filter(Boolean).join(" · ") : c.name.replace(/\.[^.]+$/, "")}
                                    </span>
                                  </div>
                                </div>
                              </td>
                              <td className="c-game">
                                <span className="st-game">
                                  <GameMark game={gameOf(c)} icons={gameIcons} />
                                  <span className="st-game-name">{gameName(gameOf(c))}</span>
                                </span>
                              </td>
                              <td className="c-kills">
                                {ace ? (
                                  <span className="st-chip ace" aria-label="Ace">ACE</span>
                                ) : kills > 0 ? (
                                  <span className={`st-chip ${kills > 1 ? "multi" : ""}`} aria-label={`${kills} ${kills === 1 ? "kill" : "kills"}`}>{kills}K</span>
                                ) : (
                                  <span className="st-sub" aria-label="No kills marked">–</span>
                                )}
                              </td>
                              <td className="num c-len">{thumbs[c.path]?.duration ? formatDuration(thumbs[c.path].duration) : "–"}</td>
                              <td className="num c-size" style={{ color: "var(--st-muted)" }}>{formatSize(c.size_bytes)}</td>
                              <td className="num c-saved">
                                {new Date(c.modified_ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                              
                                  <div className="st-row-actions" onClick={(e) => e.stopPropagation()}>
                                    <button className="st-icon-btn" title="Rename" aria-label={`Rename ${title}`} onClick={() => startLibRename(c)}>
                                      <PencilSimple size={14} />
                                    </button>
                                    <button
                                      className={`st-icon-btn ${fav ? "on" : ""}`}
                                      title="Star. Starred clips survive storage cleanup"
                                      aria-label={`Star ${title}`}
                                      aria-pressed={fav}
                                      onClick={() => toggleFavorite(c)}
                                    >
                                      <Star size={14} weight={fav ? "fill" : "regular"} />
                                    </button>
                                    <button className="st-icon-btn" title="Copy file to share in Discord" aria-label={`Copy ${title} to share`} onClick={() => void copyClip(c)}>
                                      <Copy size={14} />
                                    </button>
                                    <button
                                      className="st-icon-btn"
                                      title="More actions"
                                      aria-label={`More actions for ${title}`}
                                      onClick={(e) => {
                                        const r = e.currentTarget.getBoundingClientRect();
                                        setCtxMenu({ x: Math.min(r.left, window.innerWidth - 200), y: Math.min(r.bottom, window.innerHeight - 300), clip: c });
                                      }}
                                    >
                                      <DotsThree size={16} weight="bold" />
                                    </button>
                                  </div>
                              </td>
                            </tr>
                          );
                        })}
                      </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {inspector}
              </div>
            )}

            <footer className="st-footer">
              <span className="st-mono">
                {montageSel.size > 0 ? `${montageSel.size} selected · ` : ""}
                {clips.length} clips · {totalSize}
              </span>
              <span className="st-storage" title="All recordings count toward the storage cap. Star clips to protect them from cleanup.">
                Storage
                {settings.max_storage_gb > 0 ? <><span className="st-meter"><span style={{ width: `${Math.min(100, clips.reduce((sum, c) => sum + c.size_bytes, 0) / (settings.max_storage_gb * 1024 ** 3) * 100)}%` }} /></span><span>{totalSize} / {settings.max_storage_gb} GB</span></> : <span>No limit</span>}
              </span>
              <span className="st-footer-keys">
                <span><kbd>↑↓</kbd> browse</span>
                <span><kbd>Enter</kbd> or double-click open</span>
                <span><kbd>Space</kbd> preview</span>
                <span><kbd>Ctrl E</kbd> export</span>
                <span><kbd>S</kbd> star</span>
              </span>
            </footer>
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
              {recordingMetadata[selected.path] && <span className="st-editor-match" title={recordingMatchLabel(recordingMetadata[selected.path])}>{[recordingMatchLabel(recordingMetadata[selected.path]),roundLabel(recordingMetadata[selected.path],trimStart)].filter(Boolean).join(" · ")}</span>}
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

            <div className={`editor-stage ${audioTracks >= 4 ? "many-tracks" : ""}`}>
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
                  setVideoSize(e.currentTarget.videoWidth ? [e.currentTarget.videoWidth, e.currentTarget.videoHeight] : null);
                  // A video track the WebView can't decode loads as audio-only.
                  setNoVideo(e.currentTarget.videoWidth === 0);
                  // Restore the clip's last trim so montage prep survives
                  // closing and re-opening the editor.
                  const requested = pendingTrim.current;
                  pendingTrim.current = null;
                  const saved = requested ?? trimRanges[selected.path];
                  if (saved && saved[0] < d) {
                    setTrimStart(Math.max(0, saved[0]));
                    setTrimEnd(Math.min(saved[1], d));
                    if (requested) e.currentTarget.currentTime = Math.max(0, saved[0]);
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
                trackLabels(trackRoles).map((t) => (
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
                <h2 className="export-title">Export selection</h2>
                <span className="st-field-caption">Discord upload limit</span>
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
                <span className="field-hint">Sized to fit your limit. Exported and copied, ready to paste.</span>
                {trimEnd > trimStart && <dl className="st-export-output">
                  <div><dt>Selection</dt><dd>{clipTime(trimStart)} → {clipTime(trimEnd)}</dd></div>
                  <div><dt>Duration</dt><dd>{(trimEnd - trimStart).toFixed(1)} s</dd></div>
                  <div><dt>Video bitrate</dt><dd>{(kbps / 1000).toFixed(1)} Mbps</dd></div>
                  <div><dt>Upload limit</dt><dd>{targetMb} MB</dd></div>
                </dl>}
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
                <button className="btn-discord wide" onClick={exportDiscord} disabled={exporting || sharing !== null || trimEnd <= trimStart}>
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
                  <button className="btn-trim" onClick={shareCatbox} disabled={sharing !== null || exporting || trimEnd <= trimStart}>
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
                    disabled={sharing !== null || exporting || trimEnd <= trimStart}
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
              </details>
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
            </aside>
            </div>

            <div className="trim-section">
              <div className="tx-bar">
                <span className="tx-clock mono" ref={clockRef} aria-label="Current time" />
                <span className="tx-total mono">/ {clipTime(duration)}</span>
                <div className="tl-readouts">
                  <span>In <span className="mono" ref={trimInRef} /></span>
                  <span>Out <span className="mono" ref={trimOutRef} /></span>
                  <span>Selection <span className="mono tl-info-len" ref={trimLenRef} /></span>
                </div>
                <div className="tx-controls">
                  <button type="button" className="tx-btn" aria-label="Back one frame" title="Back one frame (←)" onClick={() => timeline?.step(-1, clipFps)}>
                    <SkipBack size={14} weight="fill" />
                  </button>
                  <button
                    type="button"
                    className="tx-btn tx-play"
                    aria-label={playing ? "Pause" : "Play"}
                    title="Play / pause (Space)"
                    onClick={() => {
                      const v = videoRef.current;
                      if (!v) return;
                      if (v.paused) v.play().catch(() => {});
                      else v.pause();
                    }}
                  >
                    {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
                  </button>
                  <button type="button" className="tx-btn" aria-label="Forward one frame" title="Forward one frame (→)" onClick={() => timeline?.step(1, clipFps)}>
                    <SkipForward size={14} weight="fill" />
                  </button>
                  <span className="tx-sep" aria-hidden="true" />
                  <button type="button" className="tx-toggle" aria-pressed={previewing} onClick={previewSelection} title="Play the selected range">
                    Play selection
                  </button>
                  <button type="button" className="tx-toggle" aria-pressed={loopPreview} onClick={() => setLoopPreview(!loopPreview)} title="Loop the selection">
                    Loop
                  </button>
                </div>
                <div className="tl-tools">
                  <label className="tl-snap" title="Trim handles snap to kills and the playhead">
                    <input type="checkbox" checked={snapKills} onChange={(e) => setSnapKills(e.target.checked)} />
                    Snap to kills
                  </label>
                  <span className="tl-info-sep" aria-hidden="true" />
                  <label className="tl-zoom" title="Zoom the timeline (Ctrl + scroll)">
                    Zoom
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      aria-label="Timeline zoom"
                      disabled={!timeline || timeline.maxZoom <= 1}
                      value={zoomDraft ?? (timeline && timeline.maxZoom > 1 ? Math.round((Math.log(timelineZoom) / Math.log(timeline.maxZoom)) * 100) : 0)}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setZoomDraft(v);
                        if (timeline) timeline.setZoom(Math.exp((v / 100) * Math.log(timeline.maxZoom)));
                      }}
                      onPointerUp={() => setZoomDraft(null)}
                      onKeyUp={() => setZoomDraft(null)}
                      onBlur={() => setZoomDraft(null)}
                    />
                  </label>
                  <button
                    type="button"
                    className="tl-fit"
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
              {duration > 0 && (
                <div className="multitrack" id="clip-multitrack" aria-label="Timeline">
                  <div className="mt-labels">
                    <div className="mt-ruler-spacer" />
                    <button
                      type="button"
                      className="mt-label mt-vid-label"
                      aria-expanded={mixerOpen}
                      aria-controls="clip-multitrack"
                      title={mixerOpen ? "Hide audio tracks" : "Show audio tracks"}
                      onClick={() => setMixerOpen((open) => !open)}
                    >
                      <span className="mt-id">V1</span>
                      Video
                      <span className="mt-vid-audio">{audioKeep.has(0) ? "All audio" : audioKeep.size ? `${audioKeep.size} audio` : "No audio"}</span>
                      <CaretRight size={11} weight="bold" className="mt-vid-caret" />
                    </button>
                    {trackLabels(trackRoles).map((t, n) => {
                      const on = audioKeep.has(t.i);
                      const gain = trackGain[t.i] ?? 1;
                      return (
                        <div
                          key={t.i}
                          className={`mt-label mt-audio ${on ? "on" : "off"}`}
                          title={
                            t.i === 0
                              ? "The mix already contains every other track."
                              : t.role === "desktop"
                                ? "Desktop already contains game, voice chat and other apps."
                                : undefined
                          }
                        >
                          <span className="mt-id">A{n + 1}</span>
                          <span className="mt-name">{t.label}</span>
                          <input
                            type="range"
                            className="mt-gain"
                            aria-label={`${t.label} export volume`}
                            aria-valuetext={`${Math.round(gain * 100)} percent`}
                            min={0}
                            max={2}
                            step={0.05}
                            value={gain}
                            disabled={!on}
                            title={`Export volume: ${Math.round(gain * 100)}% — double-click resets`}
                            onDoubleClick={() => setTrackGain((g) => ({ ...g, [t.i]: 1 }))}
                            onChange={(e) => setTrackGain((g) => ({ ...g, [t.i]: Number(e.target.value) }))}
                          />
                          <button
                            type="button"
                            className="mt-mute"
                            aria-pressed={!on}
                            aria-label={on ? `Leave ${t.label} out of the export` : `Keep ${t.label} in the export`}
                            title={on ? "In the export. Click to leave it out" : "Left out of the export. Click to keep it"}
                            onClick={() => setTrackKept(t.i, !on)}
                          >
                            {on ? <SpeakerHigh size={13} /> : <SpeakerSlash size={13} />}
                          </button>
                        </div>
                      );
                    })}
                    {killMarkers.length > 0 && <div className="mt-label mt-kills-label"><span className="mt-id">E</span>Kills</div>}
                  </div>
                  <div ref={tl.scroller} className={`mt-scroller ${timelineZoom > 1 ? "zoomed" : ""}`}>
                    <div ref={tl.sizer} className="mt-sizer">
                      <div ref={tl.surface} className="mt-tracks">
                        <Ruler ctl={timeline} markers={killMarkers} />
                        <div ref={tl.videoLane} className="mt-lane mt-vid">
                          <Filmstrip
                            ctl={timeline}
                            reel={filmstrip ? convertFileSrc(filmstrip) : null}
                            poster={thumbs[selected.path] ? convertFileSrc(thumbs[selected.path].thumb) : null}
                          />
                        </div>
                        {trackLabels(trackRoles).map((t) => {
                          const wave = trackWaves.find((w) => w.track === t.i);
                          return (
                            <div key={t.i} className={`mt-lane mt-audio ${audioKeep.has(t.i) ? "" : "off"}`}>
                              {wave && <img src={convertFileSrc(wave.waveform)} alt="" draggable={false} />}
                            </div>
                          );
                        })}
                        {killMarkers.length > 0 && (
                          <div className="mt-lane mt-kills">
                            <KillMarkers
                              ctl={timeline}
                              times={killMarkers}
                              onJump={(t) => {
                                const v = videoRef.current;
                                if (!v) return;
                                v.pause();
                                setPreviewing(false);
                                v.currentTime = t;
                              }}
                            />
                          </div>
                        )}
                        <div ref={tl.dimLeft} className="mt-dim left" />
                        <div ref={tl.dimRight} className="mt-dim right" />
                        <div ref={tl.range} className="mt-range" />
                        <span ref={tl.rangeLabel} className="mt-range-label mono" aria-hidden="true" />
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

            <footer className="ed-status">
              <span className="mono">
                {[
                  videoSize && `${videoSize[0]}×${videoSize[1]}`,
                  `${Math.round(clipFps * 100) / 100} fps`,
                  `${audioTracks} audio track${audioTracks === 1 ? "" : "s"}`,
                  formatSize(selected.size_bytes),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {audioNotice && <span className="ed-note" role="status" title={audioNotice}>{audioNotice}</span>}
              <span className="ed-keys">
                <span><kbd>Space</kbd> play</span>
                <span><kbd>[</kbd> <kbd>]</kbd> set in/out</span>
                <span><kbd>←</kbd> <kbd>→</kbd> frame</span>
                <span><kbd>Shift</kbd>+arrows 1 s</span>
                <span><kbd>Ctrl</kbd>+scroll zoom</span>
              </span>
            </footer>
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
            <Sparkle size={19} color="#7fe6d7" weight="fill" />
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

      {commandsOpen && <StudioCommands items={commandItems} onClose={() => setCommandsOpen(false)} />}
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
          <button onClick={() => { openClip(ctxMenu.clip); setCtxMenu(null); }}>
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
          title={vcPicker === "voice" ? "Add voice-chat app" : "Add other app"}
          hint={vcPicker === "voice" ? "Its audio goes on the Voice track." : "Its audio goes on the Other apps track."}
          added={vcPicker === "voice" ? voiceAppsOf(settings) : settings.other_apps}
          runningApps={runningApps}
          onPick={async (exe) => {
            const next = vcPicker === "voice"
              ? { ...settings, vc_exes: [...voiceAppsOf(settings), exe], vc_exe: "" }
              : { ...settings, other_apps: [...settings.other_apps, exe] };
            try { await saveSettings(next); }
            catch { return; }
            setVcPicker(null);
            showToast(`Added ${exe}`);
          }}
          onClose={() => setVcPicker(null)}
        />
      )}

      {showSettings && (
        <SettingsPage
          onBack={() => setShowSettings(false)}
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
          onPickApp={async (target) => {
            try {
              setRunningApps(await invoke<RunningApp[]>("list_running_apps"));
              setVcPicker(target);
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
