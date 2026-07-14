import { useCallback, useEffect, useRef, useState } from "react";
import { confirmDialog, convertFileSrc, getVersion, invoke, isTauri, listen, openDialog } from "./tauri-shim";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  Camera,
  CheckCircle,
  Circle,
  Copy,
  Crosshair,
  DiscordLogo,
  Gif,
  FilmSlate,
  FilmStrip,
  FolderOpen,
  GameController,
  Gauge,
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
import { AppPickerModal, OnboardingModal, SettingsPage, VcPickerModal } from "./panels";
import type {
  ClipInfo,
  ObsStatus,
  RunningApp,
  Settings,
  SetupStatus,
  SupervisorState,
  ThumbInfo,
} from "./types";
import "./App.css";

// Ruler tick positions (seconds) for a clip: coarsest step that still
// yields a readable ~10 labels.
function rulerTicks(duration: number): number[] {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => duration / s <= 10) ?? 600;
  const out: number[] = [];
  for (let t = step; t < duration; t += step) out.push(t);
  return out;
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
  edits: "#8a8f9a",
};

// Output of a ClipForge edit (trim/export/gif/frame/montage) rather than a
// recording — grouped under "Edits" so game groups stay clean.
function isEdit(name: string) {
  return /_discord\.|_trim_|_gif\.gif$|_frame_|^Montage_/.test(name);
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
type TrackMeta = { i: number; label: string; Icon: typeof SpeakerHigh };
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
  const [toast, setToast] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [gameFilter, setGameFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [hkSave, setHkSave] = useState("");
  const [hkShort, setHkShort] = useState("");
  const [booting, setBooting] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [loopPreview, setLoopPreview] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [audioTracks, setAudioTracks] = useState(1);
  const [audioKeep, setAudioKeep] = useState<Set<number>>(new Set([0]));
  // Per-track export gain, 1 = unchanged. Applied in the ffmpeg mix.
  const [trackGain, setTrackGain] = useState<Record<number, number>>({});
  const [trackWaves, setTrackWaves] = useState<{ track: number; waveform: string }[]>([]);
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
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [diskFree, setDiskFree] = useState<number | null>(null);
  const [exportPct, setExportPct] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "largest" | "longest" | "name">(
    "newest"
  );
  const [targetMb, setTargetMb] = useState(10);
  const [renaming, setRenaming] = useState(false);
  const [libRenamePath, setLibRenamePath] = useState<string | null>(null);
  const [libRenameValue, setLibRenameValue] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardStep, setOnboardStep] = useState(0);
  const [resetting, setResetting] = useState(false);
  const [gameSources, setGameSources] = useState<{ exe: string; kind: string }[]>([]);
  const [sourceBusy, setSourceBusy] = useState<string | null>(null);
  const [sourceTest, setSourceTest] = useState<
    Record<string, { capturing: boolean } | "error">
  >({});
  const [kindChoice, setKindChoice] = useState<Record<string, string>>({});
  const [showAppPicker, setShowAppPicker] = useState(false);
  const [vcPicker, setVcPicker] = useState(false);
  const [runningApps, setRunningApps] = useState<RunningApp[]>([]);
  const [appVersion, setAppVersion] = useState("");
  const [launchingObs, setLaunchingObs] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const dragging = useRef<"start" | "end" | "scrub" | null>(null);
  // Seek requested while a previous seek was still decoding — applied on
  // 'seeked' so scrubbing renders every frame it can without flooding seeks.
  const scrubTarget = useRef<number | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  // Per-track mixer: one hidden <audio> per track, each solo'd to its own
  // track, volume driven by that track's slider. The master <video> is muted
  // while this engine is active (multi-track clip + track API available).
  const trackAudioRefs = useRef<Record<number, HTMLAudioElement | null>>({});
  const perTrackOk = useRef(false);
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
      getVersion().then(setAppVersion).catch(() => {});
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
      localStorage.setItem("clipforge_seen", String(Date.now()));
      invoke<string[]>("load_favorites").then(setFavorites).catch(() => {});
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
      if (s.auto_connect && s.password) {
        connect(s);
      }
    })();
  }, [connect, refreshClips]);

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
      listen<{ label: string; pct: number }>("export-progress", (e) =>
        setExportPct(e.payload.pct)
      ),
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

  useEffect(() => {
    if (!showSettings) return;
    setSourceTest({});
    invoke<{ exe: string; kind: string }[]>("list_game_capture_sources")
      .then(setGameSources)
      .catch(() => setGameSources([]));
  }, [showSettings]);

  // Re-apply the keep-checkboxes to live playback whenever they change.
  useEffect(() => {
    syncPlaybackAudio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioKeep, selected]);

  // Solo one hidden <audio> element to a single track. Once any element
  // manages this, the per-track mixer owns playback audio: the master video
  // is muted and each track's slider drives its own element's volume.
  function configTrackAudio(el: HTMLAudioElement, track: number) {
    const list = (el as unknown as {
      audioTracks?: { length: number; [i: number]: { enabled: boolean } };
    }).audioTracks;
    if (!list || list.length <= track) return;
    for (let k = 0; k < list.length; k++) list[k].enabled = k === track;
    perTrackOk.current = true;
    if (videoRef.current) videoRef.current.muted = true;
    applyTrackVolumes();
  }

  function applyTrackVolumes() {
    if (!perTrackOk.current) return;
    for (const key of Object.keys(trackAudioRefs.current)) {
      const i = Number(key);
      const el = trackAudioRefs.current[i];
      if (!el) continue;
      el.volume = audioKeep.has(i) ? Math.max(0, Math.min(1, trackGain[i] ?? 1)) : 0;
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

  // Drive the playhead straight from the video clock, moving the DOM node
  // directly (translateX — no layout, no React re-render). The rAF loop only
  // runs while the video is actually playing; when paused, 'seeked' events
  // (scrub, frame-step) reposition it one-shot. Keeps the editor at ~0% CPU
  // when idle instead of ticking 60fps forever.
  useEffect(() => {
    if (!selected) return;
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    let last = -1;
    const setPos = () => {
      const d = v.duration || 0;
      const lane = timelineRef.current;
      if (d <= 0 || !lane || !playheadRef.current) return;
      const px = (v.currentTime / d) * lane.clientWidth;
      if (Math.abs(px - last) > 0.25) {
        playheadRef.current.style.transform = `translateX(${px}px)`;
        last = px;
      }
    };
    // Keep the per-track <audio> mixer locked to the video clock: pause
    // together, resume together, and nudge any element that drifts >0.2s.
    const syncAudios = () => {
      if (!perTrackOk.current) return;
      for (const el of Object.values(trackAudioRefs.current)) {
        if (!el) continue;
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
      setPos();
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
      // While scrubbing the pointer owns the playhead; don't snap it back to
      // the decoded frame. Drain the queued scrub target so the video keeps
      // chasing the cursor one completed seek at a time.
      if (dragging.current !== "scrub") setPos();
      // Align paused audio elements so a resume starts in sync.
      if (perTrackOk.current && v.paused) {
        for (const el of Object.values(trackAudioRefs.current)) {
          if (el?.paused) el.currentTime = v.currentTime;
        }
      }
      if (scrubTarget.current != null) {
        const t = scrubTarget.current;
        scrubTarget.current = null;
        v.currentTime = t;
      }
    };
    v.addEventListener("play", start);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("loadedmetadata", setPos);
    start(); // autoPlay may already be running when the effect attaches
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("play", start);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("loadedmetadata", setPos);
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
  }, [clips]);

  // Remember the trim range per clip (dropped again when it's the full clip),
  // so montage can cut each clip to its last trim without re-opening it.
  useEffect(() => {
    if (!selected || duration <= 0 || trimEnd <= 0) return;
    const path = selected.path;
    const isFull = trimStart <= 0 && trimEnd >= Math.floor(duration);
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
      const result = await invoke<{ capturing: boolean }>("test_capture_source", {
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
    const exe = rawExe.toLowerCase();
    if (settings.game_exes.some((g) => g.toLowerCase() === exe)) {
      showToast(`${exe} is already watched`);
      return;
    }
    const next: Settings = {
      ...settings,
      game_exes: [...settings.game_exes, exe],
      game_blacklist: settings.game_blacklist.filter((g) => g.toLowerCase() !== exe),
    };
    setSettings(next);
    await invoke("save_settings", { settings: next });
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
      showToast(`Removed ${exe} — won't be auto-added again`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSourceBusy(null);
    }
  }

  function selectClip(clip: ClipInfo) {
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
    trackAudioRefs.current = {};
    setRenaming(false);
    setKillMarkers([]);
    invoke<number[]>("load_markers", { input: clip.path })
      .then((m) => setKillMarkers(m ?? []))
      .catch(() => {});
    invoke<number>("list_audio_tracks", { input: clip.path })
      .then(setAudioTracks)
      .catch(() => {});
    invoke<{ track: number; waveform: string }[]>("gen_waveforms", { input: clip.path })
      .then(setTrackWaves)
      .catch(() => {});
  }

  // Mirror the keep-checkboxes onto the <video>'s audio tracks so preview
  // plays only the checked tracks. Needs the AudioVideoTracks blink feature
  // (enabled via additionalBrowserArgs); WebView2 may only play the first
  // enabled track, so preview is a guide — export does the real mix.
  function syncPlaybackAudio() {
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
      setError(String(e));
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
    if (from < 0 || to < 0 || from === to) return;
    setMontageSel((prev) => {
      const arr = [...prev];
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return new Set(arr);
    });
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
      setError(String(e));
    } finally {
      setMontaging(false);
      setExportPct(null);
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
    } else {
      // Scrub: pause (editor convention), seek to the pointer, follow the drag.
      beginScrub();
      scrubTo(t);
    }
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onTimelineMove(e: React.PointerEvent) {
    if (!dragging.current) return;
    const t = timeAt(e.clientX);
    if (dragging.current === "start") {
      setTrimStart(Math.min(Math.round(t * 10) / 10, trimEnd - 0.5));
    } else if (dragging.current === "end") {
      setTrimEnd(Math.max(Math.round(t * 10) / 10, trimStart + 0.5));
    } else {
      scrubTo(t);
    }
  }

  function onTimelineUp() {
    dragging.current = null;
  }

  function beginScrub() {
    dragging.current = "scrub";
    setPreviewing(false);
    videoRef.current?.pause();
  }

  // Grab the playhead itself (head cap or the line) to scrub from its spot.
  function onPlayheadDown(e: React.PointerEvent) {
    e.stopPropagation();
    beginScrub();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function movePlayheadToTime(t: number) {
    const lane = timelineRef.current;
    const ph = playheadRef.current;
    const d = videoRef.current?.duration || duration;
    if (!lane || !ph || d <= 0) return;
    ph.style.transform = `translateX(${(Math.min(Math.max(t, 0), d) / d) * lane.clientWidth}px)`;
  }

  // Scrub: the playhead sticks to the pointer instantly; the video renders
  // every frame it can keep up with. Only one seek is in flight at a time —
  // the next target waits for 'seeked' (drained in the playhead effect) so
  // Chromium doesn't cancel/restart seeks and skip frames.
  function scrubTo(t: number) {
    const v = videoRef.current;
    if (!v) return;
    movePlayheadToTime(t);
    if (v.seeking) {
      scrubTarget.current = t;
    } else {
      v.currentTime = t;
    }
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
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      // Queue player owns the keys while it's open.
      if (previewQueue) {
        if (e.key === "Escape") setPreviewQueue(null);
        else if (e.key === "ArrowRight") queueNext();
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
        let cols = 1;
        while (cols < cards.length && cards[cols].offsetTop === cards[0].offsetTop) cols++;
        const delta =
          e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? cols : -cols;
        const next =
          focusIdx === -1 ? 0 : Math.max(0, Math.min(visibleClips.length - 1, focusIdx + delta));
        setFocusIdx(next);
        cards[next]?.scrollIntoView({ block: "nearest" });
      } else if (!showSettings && e.key === "Enter" && focusIdx >= 0 && focusIdx < visibleClips.length) {
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
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
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
  async function installTool(label: string, wingetId: string) {
    setInstalling(label);
    try {
      await invoke("winget_install", { id: wingetId });
      setSetup(await invoke("setup_status"));
      if (label === "ffmpeg") await refreshClips();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(null);
    }
  }

  async function saveSettings(s: Settings) {
    setSettings(s);
    await invoke("save_settings", { settings: s });
    // Push the change straight to OBS (path, tracks, length, video). Best
    // effort — fails harmlessly when OBS isn't connected yet.
    invoke("apply_obs_config").catch(() => {});
  }

  // Persist a new clips folder, point OBS's recording output at it, and
  // reload the library from the new location — all without an app restart.
  async function applyClipsDir(dir: string) {
    const next = { ...settingsRef.current!, clips_dir: dir };
    setSettings(next);
    await invoke("save_settings", { settings: next });
    invoke("apply_obs_config").catch(() => {});
    await refreshClips(dir);
    showToast("Clips folder updated");
  }

  async function resetSettings() {
    const ok = await confirmDialog(
      "This resets every ClipForge setting (hotkeys, capture, storage cap, connection) back to defaults. Your clips are not affected.",
      { title: "Reset to defaults", kind: "warning" }
    );
    if (!ok) return;
    setResetting(true);
    try {
      const fresh = await invoke<Settings>("reset_settings");
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
    setError(null);
    try {
      await invoke("delete_clip", { path: clip.path });
      if (selected?.path === clip.path) setSelected(null);
      setClips((prev) => prev.filter((c) => c.path !== clip.path));
      showToast("Moved to Recycle Bin");
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
        audioTracks: [...audioKeep].sort((a, b) => a - b).map((t) => [t, trackGain[t] ?? 1]),
      });
      showToast("Exported and copied to clipboard — Ctrl+V in Discord");
      await refreshClips();
    } catch (e) {
      setError(String(e));
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
            <FilmSlate size={26} weight="fill" color="#fff" />
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
        (search === "" ||
          c.name.toLowerCase().includes(search.toLowerCase()) ||
          gameOf(c).toLowerCase().includes(search.toLowerCase()))
    )
    .sort((a, b) => {
      switch (sortBy) {
        case "oldest":
          return a.modified_ms - b.modified_ms;
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
            <span className="brand-ver">{appVersion ? `v${appVersion}` : ""}</span>
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
        </nav>

        <div className="sidebar-spacer" />

        <div className={`status-card ${status.replay_buffer_active ? "armed" : ""}`}>
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
        {exportPct != null && (
          <div className="export-bar">
            <div className="export-bar-fill" style={{ width: `${exportPct}%` }} />
          </div>
        )}
        {error && (
          <div className="error-bar">
            <span>{error}</span>
            {/connect|websocket|not connected|obs/i.test(error) && (
              <button
                className="setup-btn"
                disabled={launchingObs}
                onClick={async () => {
                  setLaunchingObs(true);
                  try {
                    await invoke("launch_obs");
                    setError(null);
                    showToast("Launching OBS — connecting…");
                    setTimeout(() => connect(settings), 4000);
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setLaunchingObs(false);
                  }
                }}
              >
                {launchingObs ? "launching…" : "Launch OBS"}
              </button>
            )}
            <button className="error-dismiss" title="Dismiss" onClick={() => setError(null)}>
              <X size={14} />
            </button>
          </div>
        )}
        {diskFree != null && diskFree < 5 * 1024 ** 3 && (
          <div className="setup-bar disk-bar">
            <Warning size={15} weight="fill" />
            <span>
              Low disk space — {formatSize(diskFree)} free on the clips drive. OBS stops saving
              clips when it runs out; delete some clips or lower the storage cap.
            </span>
          </div>
        )}
        {setup && (!setup.obs_installed || !setup.ffmpeg_installed) && (
          <div className="setup-bar">
            <Warning size={15} weight="fill" />
            {!setup.obs_installed && (
              <>
                <span>OBS Studio is not installed — ClipForge needs it to record.</span>
                <button
                  className="setup-btn"
                  disabled={installing !== null}
                  onClick={() => installTool("OBS Studio", "OBSProject.OBSStudio")}
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
                  onClick={() => installTool("ffmpeg", "Gyan.FFmpeg")}
                >
                  {installing === "ffmpeg" ? "installing…" : "Install ffmpeg"}
                </button>
              </>
            )}
          </div>
        )}

        {showSettings ? null : !selected ? (
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
                  onKeyDown={(e) => e.key === "Escape" && setSearch("")}
                  placeholder="Search clips…"
                />
                {search && (
                  <button className="search-clear" title="Clear (Esc)" onClick={() => setSearch("")}>
                    <X size={13} />
                  </button>
                )}
              </div>
              <select
                className="audio-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                title="Sort clips"
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
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
              >
                <ArrowsClockwise size={15} />
                {refreshing ? "refreshing…" : "Refresh"}
              </button>
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
                  {g}
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
              <div className="grid">
                {visibleClips.map((c, i) => (
                  <div
                    key={c.path}
                    className={`card ${i === focusIdx ? "kb-focus" : ""}`}
                    style={{ "--game": gameColor(gameOf(c)) } as React.CSSProperties}
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
                      {hoverPath === c.path && (
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
                        {gameOf(c)}
                      </div>
                      <div className="card-topright">
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
                        <span className="card-title">
                          {c.name}
                          <button
                            className="card-rename-btn"
                            title="Rename"
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
                        {formatSize(c.size_bytes)} <span className="meta-dot" /> {relativeTime(c.modified_ms)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {montageSel.size >= 1 && (
              <div className="sel-bar">
                {montageSel.size >= 2 && (
                  <div className="sel-strip" title="Montage cut order — drag to reorder">
                    {[...montageSel].map((p, i) => {
                      const c = clips.find((x) => x.path === p);
                      if (!c) return null;
                      return (
                        <div
                          key={p}
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
                      );
                    })}
                  </div>
                )}
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
            className="editor"
            style={{ "--game": gameColor(gameOf(selected)) } as React.CSSProperties}
          >
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
                className="btn-delete"
                title="Show in Explorer"
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
                  const d = e.currentTarget.duration;
                  setDuration(d);
                  // Restore the clip's last trim so montage prep survives
                  // closing and re-opening the editor.
                  const saved = trimRanges[selected.path];
                  if (saved && saved[0] < d) {
                    setTrimStart(Math.max(0, saved[0]));
                    setTrimEnd(Math.min(saved[1], d));
                  } else {
                    setTrimEnd(Math.floor(d));
                  }
                  syncPlaybackAudio();
                }}
              />
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
                <span className="trim-readout">
                  {trimStart.toFixed(1)}s → {trimEnd.toFixed(1)}s · {(trimEnd - trimStart).toFixed(1)}s selected
                </span>
              </div>
              {duration > 0 && (
                <div className="multitrack">
                  <div className="mt-labels">
                    <div className="mt-ruler-spacer" />
                    <div className="mt-label mt-vid-label">
                      <FilmSlate size={14} weight="fill" />
                      video
                    </div>
                    {trackLabels(audioTracks).map((t) => {
                      const on = audioKeep.has(t.i);
                      return (
                        <label key={t.i} className={`mt-label ${on ? "on" : ""}`} title="Keep in export">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) =>
                              setAudioKeep((prev) => {
                                const next = new Set(prev);
                                e.target.checked ? next.add(t.i) : next.delete(t.i);
                                return next;
                              })
                            }
                          />
                          <t.Icon size={14} weight="fill" className="mt-label-icon" />
                          {t.label}
                          <input
                            type="range"
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
                  <div
                    ref={timelineRef}
                    className="mt-tracks"
                    onPointerDown={onTimelineDown}
                    onPointerMove={onTimelineMove}
                    onPointerUp={onTimelineUp}
                  >
                    <div className="mt-ruler">
                      {rulerTicks(duration).map((t) => (
                        <span key={t} className="mt-tick" style={{ left: `${(t / duration) * 100}%` }}>
                          {formatDuration(t)}
                        </span>
                      ))}
                    </div>
                    <div className="mt-lane mt-vid">
                      {thumbs[selected.path] && (
                        <img src={convertFileSrc(thumbs[selected.path].thumb)} alt="" draggable={false} />
                      )}
                    </div>
                    {trackLabels(audioTracks).map((t) => {
                      const wave = trackWaves.find((w) => w.track === t.i);
                      return (
                        <div key={t.i} className={`mt-lane ${audioKeep.has(t.i) ? "" : "off"}`}>
                          {wave && (
                            <img src={convertFileSrc(wave.waveform)} alt="" draggable={false} />
                          )}
                        </div>
                      );
                    })}
                    <div
                      className="mt-range"
                      style={{
                        left: `${(trimStart / duration) * 100}%`,
                        width: `${((trimEnd - trimStart) / duration) * 100}%`,
                      }}
                    />
                    {killMarkers
                      .filter((t) => t >= 0 && t <= duration)
                      .map((t, i) => (
                        <div
                          key={i}
                          className="kill-marker"
                          style={{ left: `${(t / duration) * 100}%` }}
                          title={`Kill at ${formatDuration(t)} — click to jump`}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            const v = videoRef.current;
                            if (!v) return;
                            v.pause();
                            setPreviewing(false);
                            v.currentTime = t;
                          }}
                        >
                          <Crosshair size={11} weight="bold" />
                        </div>
                      ))}
                    <div ref={playheadRef} className="mt-playhead" style={{ left: 0 }}>
                      <div className="mt-playhead-grab" onPointerDown={onPlayheadDown} />
                    </div>
                    <div className="mt-handle" style={{ left: `${(trimStart / duration) * 100}%` }}>
                      <span className="grip" />
                    </div>
                    <div className="mt-handle" style={{ left: `${(trimEnd / duration) * 100}%` }}>
                      <span className="grip" />
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="action-row">
              <div className={`quality-pill ${goodQuality ? "good" : "bad"}`}>
                <Gauge size={15} weight="fill" />
                ~{Math.round(kbps)} kbps · {goodQuality ? "good" : "trim shorter"}
              </div>
              <div className="lib-spacer" />
              <button
                className="btn-trim icon-only"
                title="Copy the clip file — paste in Discord without exporting"
                onClick={() => selected && copyClip(selected)}
              >
                <Copy size={16} />
              </button>
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
              <div className="export-group">
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
                  {exporting
                    ? `exporting… ${exportPct != null ? Math.round(exportPct) + "%" : ""}`
                    : "Export for Discord"}
                </button>
              </div>
            </div>
            <p className="kbd-hints">
              <kbd>space</kbd> play/pause · <kbd>←</kbd><kbd>→</kbd> frame · <kbd>shift</kbd>+arrows 1s ·{" "}
              <kbd>[</kbd> set start · <kbd>]</kbd> set end · <kbd>esc</kbd> back
            </p>
          </div>
        )}

        {toast && (
          <div className="toast">
            <CheckCircle size={17} weight="fill" color="#40dd80" />
            {toast}
          </div>
        )}

      {ctxMenu && (
        <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
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
          <button className="danger" onClick={() => deleteClip(ctxMenu.clip)}>
            <Trash size={14} />
            Delete
          </button>
        </div>
      )}

      {previewQueue && previewQueue[previewQIdx] && (
        <div className="modal-backdrop" onClick={() => setPreviewQueue(null)}>
          <div className="queue-player" onClick={(e) => e.stopPropagation()}>
            <video
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
              <button className="btn-ghost" onClick={() => setPreviewQueue(null)} title="Esc">
                <X size={15} />
              </button>
            </div>
          </div>
        </div>
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
            await saveSettings({ ...settings, vc_exe: exe });
            setVcPicker(false);
            showToast(`Voice-chat audio set to ${exe}`);
          }}
          onClose={() => setVcPicker(false)}
        />
      )}

      {showSettings && (
        <SettingsPage
          settings={settings}
          setSettings={setSettings}
          saveSettings={saveSettings}
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
          onClose={() => setShowOnboarding(false)}
          onFinish={finishOnboarding}
        />
      )}
      </div>
    </div>
  );
}

export default App;
