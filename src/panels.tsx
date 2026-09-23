// Panels extracted from App.tsx: settings page, onboarding walkthrough and
// the two app-picker modals. All state stays in App — these are pure views
// over props, so App.tsx keeps the data flow while this file keeps the bulk.
import { useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { invoke, openDialog } from "./tauri-shim";
import appIcon from "./assets/logo.svg";
import type { BackupStatus, Diagnostics, GameSource, ObsStatus, RunningApp, Settings, SetupStatus, SupervisorState } from "./types";
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  BookOpen,
  CheckCircle,
  Circle,
  FilmSlate,
  GameController,
  HardDrives,
  Heartbeat,
  Keyboard,
  Lightning,
  Plugs,
  Waveform,
  WarningCircle,
  X,
} from "@phosphor-icons/react";

/// RAM the replay buffer reserves, matching the backend's cap
/// (setup::ensure_replay_buffer_config): bitrate + 25% + audio, min 512 MB.
/// Auto bitrate is estimated at 20 Mbps (1080p60 AV1/HEVC).
function bufferRamText(settings: Settings): string {
  const mbps = settings.bitrate_mbps > 0 ? settings.bitrate_mbps : 20;
  const mb = Math.max(512, Math.ceil(settings.replay_seconds * ((mbps / 8) * 1.25 + 0.12)));
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

// Keys that are safe to bind without a modifier: nothing types them.
const BARE_OK = /^(f([1-9]|1[0-9]|2[0-4])|pause|scrolllock|insert)$/;

// Turn a keydown into a hotkey string like "ctrl+shift+f9". Uses the
// physical key (e.code), so shift+1 records as "shift+1" rather than "!",
// on any keyboard layout. Returns the modifiers typed so far ("alt+…")
// while only modifiers are held.
function captureHotkey(e: React.KeyboardEvent): { combo: string; complete: boolean } {
  e.preventDefault();
  e.stopPropagation();
  const mods = [e.ctrlKey ? "ctrl" : null, e.shiftKey ? "shift" : null, e.altKey ? "alt" : null].filter(
    Boolean,
  ) as string[];
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) {
    return { combo: mods.length ? `${mods.join("+")}+…` : "", complete: false };
  }
  const key = e.code.replace(/^Key/, "").replace(/^Digit/, "").toLowerCase();
  return { combo: [...mods, key].join("+"), complete: true };
}

/// Why a combo can't be used, or null when it's fine.
function hotkeyProblem(combo: string, other: string): string | null {
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  if (parts.length === 1 && !BARE_OK.test(key)) {
    return "Add Ctrl, Alt or Shift: a single key would stop working everywhere else.";
  }
  if (combo === other) return "That's already your other hotkey.";
  return null;
}

/// Click, press a combo, done. Global hotkeys are paused while the field
/// is focused so even the current combo can be pressed and captured.
function HotkeyInput(props: {
  id?: string;
  value: string;
  other: string;
  onChange: (combo: string) => void;
}) {
  const { id, value, other, onChange } = props;
  const [live, setLive] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <input
        id={id}
        className={`mono hotkey-capture ${live !== null ? "recording" : ""}`}
        value={live ?? value}
        placeholder="Press keys… (Esc to cancel)"
        readOnly
        onFocus={() => {
          setLive("");
          setProblem(null);
          invoke("set_hotkeys_paused", { paused: true }).catch(() => {});
        }}
        onBlur={() => {
          setLive(null);
          invoke("set_hotkeys_paused", { paused: false }).catch(() => {});
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.blur();
            return;
          }
          const { combo, complete } = captureHotkey(e);
          setLive(combo);
          if (!complete) return;
          const issue = hotkeyProblem(combo, other);
          setProblem(issue);
          if (issue) return;
          onChange(combo);
          e.currentTarget.blur();
        }}
        onKeyUp={(e) => {
          // Released the modifiers without finishing a combo: start over.
          if (live && live.endsWith("…") && !e.ctrlKey && !e.altKey && !e.shiftKey) setLive("");
        }}
      />
      {problem && <span className="field-hint hotkey-problem">{problem}</span>}
    </>
  );
}

// Open dialogs, innermost last — only the top one answers Esc.
const modalStack: (() => void)[] = [];

/// Shared dialog shell: backdrop click and Esc close it, focus moves into the
/// dialog on open and back to the trigger on close. Esc is caught in the
/// capture phase so the library/editor shortcuts underneath never see it.
export function Modal(props: {
  label: string;
  className: string;
  onClose: () => void;
  zIndex?: number;
  children: ReactNode;
}) {
  const { label, className, onClose, zIndex, children } = props;
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const close = () => closeRef.current();
    modalStack.push(close);
    const returnFocus = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || modalStack[modalStack.length - 1] !== close) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      modalStack.splice(modalStack.indexOf(close), 1);
      returnFocus?.focus?.();
    };
  }, []);

  return (
    <div className="modal-backdrop" style={zIndex ? { zIndex } : undefined} onClick={onClose}>
      <div
        ref={ref}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function AppPickerModal(props: {
  settings: Settings;
  runningApps: RunningApp[];
  onAdd: (exe: string) => Promise<void>;
  onRefresh: () => void;
  onFolder: () => Promise<void>;
  onClose: () => void;
}) {
  const { settings, runningApps, onAdd, onRefresh, onFolder, onClose } = props;
  return (
    <Modal label="Add a game" className="modal app-picker" zIndex={200} onClose={onClose}>
      <div className="modal-head">
        <GameController size={19} color="#7f9bff" weight="fill" />
        <span className="modal-title">Add a game</span>
        <div className="lib-spacer" />
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <div className="modal-body">
        <span className="field-label">
          Pick a running app to watch as a game. Not listed? Use “Find .exe in folder”.
        </span>
        <div className="app-list">
          {runningApps.length === 0 && (
            <span className="field-label">No running windowed apps found.</span>
          )}
          {runningApps.map((a) => {
            const already = settings.game_exes.some((g) => g.toLowerCase() === a.exe);
            return (
              <div key={a.exe} className="onboard-check">
                <span>
                  <strong>{a.title}</strong> — <span className="mono">{a.exe}</span>
                </span>
                <button
                  className="setup-btn"
                  disabled={already}
                  onClick={async () => {
                    await onAdd(a.exe);
                    onClose();
                  }}
                >
                  {already ? "added" : "Add"}
                </button>
              </div>
            );
          })}
        </div>
        <div className="set-row">
          <button className="btn-ghost" onClick={onRefresh}>
            <ArrowsClockwise size={15} />
            Refresh list
          </button>
          <button
            className="btn-ghost"
            onClick={async () => {
              onClose();
              await onFolder();
            }}
          >
            Find .exe in folder…
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function VcPickerModal(props: {
  currentVc: string;
  runningApps: RunningApp[];
  onPick: (exe: string) => Promise<void>;
  onClose: () => void;
}) {
  const { currentVc, runningApps, onPick, onClose } = props;
  return (
    <Modal label="Pick voice-chat app" className="modal app-picker" zIndex={200} onClose={onClose}>
      <div className="modal-head">
        <GameController size={19} color="#7f9bff" weight="fill" />
        <span className="modal-title">Pick voice-chat app</span>
        <div className="lib-spacer" />
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <div className="modal-body">
        <span className="field-label">
          Choose the app whose audio goes on the voice-chat track.
        </span>
        <div className="app-list">
          {runningApps.length === 0 && (
            <span className="field-label">No running windowed apps found.</span>
          )}
          {runningApps.map((a) => (
            <div key={a.exe} className="onboard-check">
              <span>
                <strong>{a.title}</strong> — <span className="mono">{a.exe}</span>
              </span>
              <button
                className="setup-btn"
                disabled={currentVc.toLowerCase() === a.exe}
                onClick={() => onPick(a.exe)}
              >
                {currentVc.toLowerCase() === a.exe ? "current" : "Use"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function timeAgo(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/// Storage > Backup: favorites copied to a synced folder between games.
function BackupSettings(props: { settings: Settings; saveSettings: (s: Settings) => Promise<void> }) {
  const { settings, saveSettings } = props;
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Typed locally, saved on blur: every save also re-applies OBS config.
  const [draft, setDraft] = useState(settings.backup_dir);
  useEffect(() => setDraft(settings.backup_dir), [settings.backup_dir]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      invoke<BackupStatus>("backup_status")
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [settings.backup_dir]);

  const summary = !status?.enabled
    ? "Off. Pick a folder to back up your starred clips."
    : !status.folder_ok
      ? "Folder not found. Is Google Drive running?"
      : status.running
        ? `Backing up… ${status.pending} left`
        : status.pending > 0
          ? `${status.backed_up} backed up, ${status.pending} waiting for your game to close`
          : `All ${status.backed_up} starred ${status.backed_up === 1 ? "clip" : "clips"} backed up${
              status.last_run_ms ? `, checked ${timeAgo(status.last_run_ms)}` : ""
            }`;

  return (
    <div className="set-col">
      <span className="field-label">Back up starred clips to</span>
      <div className="set-row">
        <input
          className="mono"
          placeholder="F:/My Drive/ClipForge"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== settings.backup_dir) saveSettings({ ...settings, backup_dir: draft.trim() });
          }}
        />
        <button
          className="btn-ghost"
          onClick={async () => {
            const picked = await openDialog({ directory: true, defaultPath: settings.backup_dir || undefined });
            if (typeof picked === "string") await saveSettings({ ...settings, backup_dir: picked });
          }}
        >
          Browse
        </button>
        {status?.enabled && status.folder_ok && (
          <button
            className="btn-ghost"
            disabled={status.running}
            onClick={() =>
              invoke("backup_now")
                .then(() => setMessage(null))
                .catch((e) => setMessage(String(e)))
            }
          >
            Back up now
          </button>
        )}
      </div>
      <span className="field-hint">
        {summary}
        {(message || status?.error) && (
          <>
            <br />
            {message || status?.error}
          </>
        )}
      </span>
      <span className="field-hint">
        Only starred clips are copied, and only when no game is running, so uploads never slow
        down your matches. Keep the clips folder above on a local drive.
      </span>
    </div>
  );
}

type Check = { label: string; value: string; ok: boolean; fix?: string };

function encoderName(id: string | null): string {
  if (!id || id === "none") return "not set";
  if (id === "obs_x264") return "CPU (x264)";
  const codec = id.includes("av1") ? "AV1" : id.includes("265") || id.includes("hevc") ? "HEVC" : "H.264";
  if (id.includes("amf")) return `AMD ${codec}`;
  if (id.includes("nvenc")) return `NVIDIA ${codec}`;
  if (id.includes("qsv")) return `Intel ${codec}`;
  return id;
}

/// Turn raw diagnostics into rows a player can read: what OBS is really
/// using, whether it's right for clipping, and what to do if not.
function healthChecks(d: Diagnostics): Check[] {
  const hw = (id: string | null) => !!id && /nvenc|amf|qsv/.test(id);
  const gb = d.disk_free_bytes != null ? d.disk_free_bytes / 1024 ** 3 : null;
  const lag = Math.max(d.health.render_lag_pct, d.health.encoder_lag_pct);
  return [
    {
      label: "OBS",
      value: d.obs_connected ? `Connected, version ${d.obs_version ?? "unknown"}` : "Not connected",
      ok: d.obs_connected && !d.obs_outdated,
      fix: !d.obs_connected
        ? "Start OBS, or check Advanced connection below."
        : d.obs_outdated
          ? "Update OBS to 30.2 or newer."
          : undefined,
    },
    {
      label: "Encoder",
      value: encoderName(d.encoder),
      ok: hw(d.encoder) && (!d.best_encoder || d.encoder === d.best_encoder),
      fix: !hw(d.encoder)
        ? "Recording on the CPU costs game FPS. Set Encoder to Auto."
        : d.best_encoder && d.encoder !== d.best_encoder
          ? `${encoderName(d.best_encoder)} is better here. It switches over after your game.`
          : undefined,
    },
    {
      label: "Quality",
      value: d.bitrate_kbps
        ? `${Math.round(d.bitrate_kbps / 1000)} Mbps ${d.rate_control ?? ""}`.trim()
        : "Unknown",
      ok: (d.bitrate_kbps ?? 0) >= 8000,
    },
    {
      label: "Keyframes",
      value: d.keyint_sec ? `Every ${d.keyint_sec}s` : "OBS default",
      ok: d.keyint_sec === 1,
      fix: d.keyint_sec === 1 ? undefined : "Switches to every 1s after your game, so trims land on time.",
    },
    {
      label: "Video",
      value: d.resolution && d.fps ? `${d.resolution} at ${d.fps} fps` : "Unknown",
      ok: !!d.resolution,
    },
    {
      label: "Replay buffer",
      value: d.buffer_seconds ? `${d.buffer_seconds}s, ${d.buffer_ram_mb ?? "?"} MB of RAM` : "Not set",
      ok: !!d.buffer_seconds && d.output_mode === "Advanced",
    },
    {
      label: "Smoothness",
      value: lag > 0 ? `${lag.toFixed(1)}% frames dropped, last 30s` : "No dropped frames",
      ok: lag < 1,
      fix:
        d.health.render_lag_pct >= 1
          ? "Your GPU is maxed out. Cap the game's FPS a little below your monitor's refresh rate."
          : d.health.encoder_lag_pct >= 1
            ? "The encoder can't keep up. Lower the bitrate or the recording FPS."
            : undefined,
    },
    {
      label: "Disk",
      value: gb != null ? `${gb.toFixed(1)} GB free` : "Unknown",
      ok: gb == null || gb >= 10,
      fix: gb != null && gb < 10 ? "OBS stops saving when the drive is full. Free up space or lower the storage cap." : undefined,
    },
    {
      label: "Clips folder",
      value: d.clips_dir_cloud ? `On ${d.clips_dir_cloud}` : "Local drive",
      ok: !d.clips_dir_cloud,
      fix: d.clips_dir_cloud
        ? `Every clip uploads the moment it's saved, which can spike your ping mid-match. Move the clips folder to a local drive and use "Back up starred clips" instead.`
        : undefined,
    },
    {
      label: "ffmpeg",
      value: d.ffmpeg_found ? "Installed" : "Missing",
      ok: d.ffmpeg_found,
      fix: d.ffmpeg_found ? undefined : "Needed for thumbnails, trims and exports. Use the install button at the top.",
    },
  ];
}

/// Settings "Health" section: a live view of the recording setup.
export function HealthPanel({ onTestSetup }: { onTestSetup: () => void }) {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      invoke<Diagnostics>("obs_diagnostics")
        .then((d) => {
          if (alive) setDiag(d);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  const checks = diag ? healthChecks(diag) : [];
  const issues = checks.filter((c) => !c.ok).length;
  return (
    <section className="set-group">
      <div className="set-head">
        <div className="set-head-icon"><Heartbeat size={16} weight="fill" /></div>
        <div className="set-head-text">
          <span className="set-head-title">Health</span>
          <span className="set-head-desc">
            {!diag
              ? "Checking…"
              : issues === 0
                ? "Everything is set up for clipping"
                : `${issues} ${issues > 1 ? "things" : "thing"} to look at`}
          </span>
        </div>
      </div>
      {diag?.settings_pending && (
        <span className="field-hint">Some changes are waiting. They apply once your game closes.</span>
      )}
      <ul className="health-list">
        {checks.map((c) => (
          <li key={c.label} className={`health-row ${c.ok ? "ok" : "warn"}`}>
            {c.ok ? (
              <CheckCircle size={16} weight="fill" aria-label="OK" />
            ) : (
              <WarningCircle size={16} weight="fill" aria-label="Needs attention" />
            )}
            <span className="health-label">{c.label}</span>
            <span className="health-value mono">{c.value}</span>
            {!c.ok && c.fix && <span className="health-fix">{c.fix}</span>}
          </li>
        ))}
      </ul>
      <button className="btn-ghost" onClick={onTestSetup}>Test my setup</button>
    </section>
  );
}

export function SettingsPage(props: {
  onTestSetup: () => void;
  settings: Settings;
  setSettings: (s: Settings) => void;
  saveSettings: (s: Settings) => Promise<void>;
  applyClipsDir: (dir: string) => Promise<void>;
  resetSettings: () => Promise<void>;
  resetting: boolean;
  hkSave: string;
  hkShort: string;
  setHkSave: (v: string) => void;
  setHkShort: (v: string) => void;
  applyHotkeys: (save: string, short: string) => Promise<void>;
  gameSources: GameSource[];
  sourceBusy: string | null;
  sourceTest: Record<string, { capturing: boolean } | "error">;
  kindChoice: Record<string, string>;
  setKindChoice: Dispatch<SetStateAction<Record<string, string>>>;
  addGameSource: (exe: string, kind: string) => Promise<void>;
  testGameSource: (exe: string) => Promise<void>;
  removeGame: (exe: string) => Promise<void>;
  openAppPicker: () => Promise<void>;
  addGameFromFolder: () => Promise<void>;
  sup: SupervisorState | null;
  connect: (s: Settings) => Promise<void>;
  connecting: boolean;
  onTutorial: () => void;
  onPickVc: () => Promise<void>;
}) {
  const {
    settings, setSettings, saveSettings, applyClipsDir, resetSettings, resetting,
    hkSave, hkShort, setHkSave, setHkShort, applyHotkeys,
    gameSources, sourceBusy, sourceTest, kindChoice, setKindChoice,
    addGameSource, testGameSource, removeGame, openAppPicker, addGameFromFolder,
    sup, connect, connecting, onTutorial, onPickVc,
  } = props;
  return (
    <div className="settings-page">
      <header className="lib-header">
        <div className="lib-title">
          <h1>Settings</h1>
        </div>
        <div className="lib-spacer" />
        <button className="btn-ghost" onClick={onTutorial}>
          <BookOpen size={15} />
          Tutorial
        </button>
        <button className="btn-ghost reset-btn" disabled={resetting} onClick={resetSettings}>
          <ArrowCounterClockwise size={14} />
          {resetting ? "resetting…" : "Reset to defaults"}
        </button>
      </header>
      <div className="settings-body">
        <HealthPanel onTestSetup={props.onTestSetup} />
        <section className="set-group">
          <div className="set-head">
            <div className="set-head-icon"><FilmSlate size={16} weight="fill" /></div>
            <div className="set-head-text">
              <span className="set-head-title">Capture</span>
              <span className="set-head-desc">Buffer length and recording quality</span>
            </div>
          </div>
          <label className="set-col">
            <span className="field-label">Clip length</span>
            <div className="seg" role="radiogroup" aria-label="Clip length">
              {[...new Set([30, 60, 120, 180, 300, settings.replay_seconds])]
                .sort((a, b) => a - b)
                .map((s) => (
                  <button
                    key={s}
                    role="radio"
                    aria-checked={settings.replay_seconds === s}
                    className={settings.replay_seconds === s ? "on" : ""}
                    onClick={() => saveSettings({ ...settings, replay_seconds: s })}
                  >
                    {s < 60 ? `${s}s` : s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`}
                  </button>
                ))}
            </div>
            <span className="field-hint">
              How far back a save reaches. Uses about {bufferRamText(settings)} of RAM while a game
              runs.
            </span>
          </label>
          <div className="set-row">
            <label className="set-col">
              <span className="field-label">FPS</span>
              <select
                className="audio-select wide"
                value={settings.video_fps}
                onChange={(e) => saveSettings({ ...settings, video_fps: Number(e.target.value) })}
              >
                <option value={30}>30</option>
                <option value={60}>60</option>
                <option value={120}>120</option>
              </select>
            </label>
            <label className="set-col">
              <span className="field-label">Resolution</span>
              <select
                className="audio-select wide"
                value={settings.video_height}
                onChange={(e) => saveSettings({ ...settings, video_height: Number(e.target.value) })}
              >
                <option value={0}>Native</option>
                <option value={1440}>1440p</option>
                <option value={1080}>1080p</option>
                <option value={720}>720p</option>
              </select>
            </label>
            <label className="set-col">
              <span className="field-label">Bitrate</span>
              {/* 0 = auto: sized from resolution, fps and codec (backend
                  target_bitrate_mbps). A custom value from an older version
                  stays selectable. */}
              <select
                className="audio-select wide"
                value={settings.bitrate_mbps}
                onChange={(e) => saveSettings({ ...settings, bitrate_mbps: Number(e.target.value) })}
              >
                <option value={0}>Auto (best)</option>
                {[...new Set([10, 15, 20, 30, 40, 50, 80, settings.bitrate_mbps])]
                  .filter((v) => v > 0)
                  .sort((a, b) => a - b)
                  .map((v) => (
                    <option key={v} value={v}>
                      {v} Mbps
                    </option>
                  ))}
              </select>
            </label>
            <label className="set-col">
              <span className="field-label">Encoder</span>
              <select
                className="audio-select wide"
                value={settings.encoder_pref}
                onChange={(e) => saveSettings({ ...settings, encoder_pref: e.target.value })}
              >
                <option value="auto">Auto (best)</option>
                <option value="av1">AV1</option>
                <option value="hevc">HEVC</option>
                <option value="h264">H264</option>
              </select>
            </label>
          </div>
          <span className="field-hint">
            Changes apply to OBS automatically, as soon as no game is running. Auto picks the
            bitrate from your resolution, frame rate and encoder.
          </span>
        </section>

        <section className="set-group">
          <div className="set-head">
            <div className="set-head-icon"><Lightning size={16} weight="fill" /></div>
            <div className="set-head-text">
              <span className="set-head-title">Automation</span>
              <span className="set-head-desc">Hands-free recording and clipping</span>
            </div>
          </div>
          <div className="toggle-card">
            <div className="toggle-text">
              <span className="toggle-title">Auto buffer</span>
              <span className="toggle-desc">Arm when a game runs, disarm when it exits</span>
            </div>
            <button
              className={`switch ${settings.auto_manage_buffer ? "on" : ""}`}
              role="switch"
              aria-checked={settings.auto_manage_buffer}
              aria-label="Auto buffer"
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
              role="switch"
              aria-checked={settings.auto_launch_obs}
              aria-label="Auto-launch OBS"
              onClick={() => saveSettings({ ...settings, auto_launch_obs: !settings.auto_launch_obs })}
            >
              <span className="knob" />
            </button>
          </div>
          <div className="toggle-card">
            <div className="toggle-text">
              <span className="toggle-title">Start with Windows</span>
              <span className="toggle-desc">Launch to the tray at login, ready before you play</span>
            </div>
            <button
              className={`switch ${settings.launch_at_login ? "on" : ""}`}
              role="switch"
              aria-checked={settings.launch_at_login}
              aria-label="Start with Windows"
              onClick={() => saveSettings({ ...settings, launch_at_login: !settings.launch_at_login })}
            >
              <span className="knob" />
            </button>
          </div>
          <div className="toggle-card">
            <div className="toggle-text">
              <span className="toggle-title">Auto-clip kills</span>
              <span className="toggle-desc">
                CS2 and League only (official event APIs). Saves a clip a few seconds
                after your kill — multikills land in one clip. Other games: hotkey.
              </span>
            </div>
            <button
              className={`switch ${settings.auto_clip ? "on" : ""}`}
              role="switch"
              aria-checked={settings.auto_clip}
              aria-label="Auto-clip kills"
              onClick={() => saveSettings({ ...settings, auto_clip: !settings.auto_clip })}
            >
              <span className="knob" />
            </button>
          </div>
        </section>

        <section className="set-group">
          <div className="set-head">
            <div className="set-head-icon"><Keyboard size={16} weight="fill" /></div>
            <div className="set-head-text">
              <span className="set-head-title">Hotkeys</span>
              <span className="set-head-desc">Global — they work while a game has focus</span>
            </div>
          </div>
          <div className="set-row">
            <label className="set-col">
              <span className="field-label">Save clip</span>
              <HotkeyInput
                id="hotkey-save"
                value={hkSave}
                other={hkShort}
                onChange={(combo) => {
                  setHkSave(combo);
                  applyHotkeys(combo, hkShort);
                }}
              />
            </label>
            <label className="set-col">
              <span className="field-label">Short clip</span>
              <HotkeyInput
                value={hkShort}
                other={hkSave}
                onChange={(combo) => {
                  setHkShort(combo);
                  applyHotkeys(hkSave, combo);
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
          <div className="set-row hotkey-foot">
            <span className="field-hint">
              Click a field and press the new keys. Use Ctrl, Alt or Shift with a key, or an F-key on
              its own.
            </span>
            {(hkSave !== "alt+f10" || hkShort !== "shift+alt+f10") && (
              <button
                className="btn-ghost"
                onClick={() => {
                  setHkSave("alt+f10");
                  setHkShort("shift+alt+f10");
                  applyHotkeys("alt+f10", "shift+alt+f10");
                }}
              >
                Reset to Alt+F10
              </button>
            )}
          </div>
        </section>

        <section className="set-group">
          <div className="set-head">
            <div className="set-head-icon"><Waveform size={16} weight="fill" /></div>
            <div className="set-head-text">
              <span className="set-head-title">Split audio</span>
              <span className="set-head-desc">Five tracks per clip — game, voice, desktop, mic, mix</span>
            </div>
          </div>
          <span className="field-hint">
            Every clip records 5 audio tracks (full mix, game, voice chat, desktop, mic), so
            an export can keep any of them. Game audio follows the running game; set your
            voice-chat app below.
          </span>
          <label className="set-col">
            <span className="field-label">Voice-chat app (.exe)</span>
            <div className="set-row">
              <input
                className="mono"
                value={settings.vc_exe}
                onChange={(e) => setSettings({ ...settings, vc_exe: e.target.value })}
                onBlur={() => saveSettings(settings)}
                placeholder="discord.exe"
              />
              <button className="btn-ghost" onClick={onPickVc}>
                Pick app
              </button>
            </div>
          </label>
        </section>

        <section className="set-group">
          <div className="set-head">
            <div className="set-head-icon"><GameController size={16} weight="fill" /></div>
            <div className="set-head-text">
              <span className="set-head-title">Games watched</span>
              <span className="set-head-desc">What arms the buffer, and how each game is captured</span>
            </div>
          </div>
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
          <div className="set-row">
            <button className="btn-ghost apply-btn" onClick={openAppPicker}>
              <GameController size={15} />
              Add from running apps
            </button>
            <button className="btn-ghost" onClick={addGameFromFolder}>
              Find .exe in folder…
            </button>
          </div>
          <span className="field-hint">
            Most fullscreen games are captured automatically. If a game's clips come out
            black, add a dedicated source for it (matched by its .exe, so the game doesn't
            need to be open). If Test says the source is live but clips are still black,
            switch the capture type and add it again.
          </span>
          {settings.game_exes.map((exe) => {
            const source = gameSources.find((g) => g.exe === exe);
            const isRunning = sup?.game?.toLowerCase() === exe.toLowerCase();
            const test = sourceTest[exe];
            const kind = kindChoice[exe] ?? source?.kind ?? "window_capture";
            return (
              <div key={exe} className="onboard-check">
                {source ? (
                  <CheckCircle size={16} weight="fill" color="#40dd80" />
                ) : (
                  <Circle size={16} color="#767a85" />
                )}
                <span>
                  {exe} —{" "}
                  {source
                    ? `dedicated ${source.kind === "window_capture" ? "window capture" : "game capture"}`
                    : "universal capture only"}
                  {test === "error" && " — test failed"}
                  {test && test !== "error" && (test.capturing ? " — active in OBS ✓" : " — not active ✗")}
                </span>
                <select
                  className="audio-select"
                  value={kind}
                  disabled={sourceBusy !== null}
                  onChange={(e) => setKindChoice((k) => ({ ...k, [exe]: e.target.value }))}
                >
                  <option value="window_capture">Window Capture</option>
                  <option value="game_capture">Game Capture</option>
                </select>
                <button
                  className="setup-btn"
                  disabled={sourceBusy !== null}
                  onClick={() => addGameSource(exe, kind)}
                >
                  {sourceBusy === exe ? "working…" : source ? "Redo" : "Add source"}
                </button>
                {source && (
                  <button
                    className="setup-btn"
                    disabled={sourceBusy !== null}
                    title={isRunning ? "" : "Launch the game first for a meaningful result"}
                    onClick={() => testGameSource(exe)}
                  >
                    Test
                  </button>
                )}
                <button
                  className="row-remove"
                  disabled={sourceBusy !== null}
                  title="Remove & never auto-add again"
                  aria-label={`Stop watching ${exe}`}
                  onClick={() => removeGame(exe)}
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
          {settings.game_blacklist.length > 0 && (
            <>
              <span className="field-label">Blacklisted (won't auto-add):</span>
              <div className="blacklist-chips">
                {settings.game_blacklist.map((g) => (
                  <button
                    key={g}
                    className="chip"
                    title="Remove from blacklist"
                    onClick={() =>
                      saveSettings({
                        ...settings,
                        game_blacklist: settings.game_blacklist.filter((x) => x !== g),
                      })
                    }
                  >
                    {g} <X size={11} />
                  </button>
                ))}
              </div>
            </>
          )}
        </section>

        <section className="set-group">
          <div className="set-head">
            <div className="set-head-icon"><HardDrives size={16} weight="fill" /></div>
            <div className="set-head-text">
              <span className="set-head-title">Storage</span>
              <span className="set-head-desc">Where clips live and how much space they may take</span>
            </div>
          </div>
          <div className="set-row">
            <input
              className="mono"
              value={settings.clips_dir}
              onChange={(e) => setSettings({ ...settings, clips_dir: e.target.value })}
              onBlur={() => applyClipsDir(settings.clips_dir)}
            />
            <button
              className="btn-ghost"
              onClick={async () => {
                const picked = await openDialog({
                  directory: true,
                  defaultPath: settings.clips_dir,
                });
                if (typeof picked === "string") {
                  setSettings({ ...settings, clips_dir: picked });
                  await applyClipsDir(picked);
                }
              }}
            >
              Browse
            </button>
          </div>
          <label className="set-col">
            <span className="field-label">Max storage (GB)</span>
            <input
              className="mono"
              type="number"
              min={0}
              value={settings.max_storage_gb}
              onChange={(e) => saveSettings({ ...settings, max_storage_gb: Number(e.target.value) })}
            />
            <span className="field-hint">
              Past this size, the oldest clips that aren't favorites go to the Recycle Bin.
              0 turns it off.
            </span>
          </label>
          <BackupSettings settings={settings} saveSettings={saveSettings} />
        </section>

        <details className="set-group advanced">
          <summary>
            <div className="set-head">
              <div className="set-head-icon"><Plugs size={16} weight="fill" /></div>
              <div className="set-head-text">
                <span className="set-head-title">Advanced connection</span>
                <span className="set-head-desc">
                  Auto-configured — only for remote or portable OBS setups
                </span>
              </div>
            </div>
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
          <div className="set-row">
            <input
              className="mono"
              value={settings.obs_path}
              onChange={(e) => setSettings({ ...settings, obs_path: e.target.value })}
              onBlur={() => invoke("save_settings", { settings })}
              placeholder="obs64.exe path (auto-detected normally)"
            />
            <button
              className="btn-ghost"
              onClick={async () => {
                const picked = await openDialog({
                  defaultPath: settings.obs_path,
                  filters: [{ name: "OBS executable", extensions: ["exe"] }],
                });
                if (typeof picked === "string") {
                  const next = { ...settings, obs_path: picked };
                  setSettings(next);
                  await invoke("save_settings", { settings: next });
                }
              }}
            >
              Browse
            </button>
          </div>
          <button className="btn-ghost apply-btn" onClick={() => connect(settings)} disabled={connecting}>
            {connecting ? "connecting…" : "Apply & connect"}
          </button>
        </details>
      </div>
    </div>
  );
}

export function OnboardingModal(props: {
  step: number;
  setStep: Dispatch<SetStateAction<number>>;
  setup: SetupStatus | null;
  status: ObsStatus;
  settings: Settings;
  setSettings: (s: Settings) => void;
  saveSettings: (s: Settings) => Promise<void>;
  connecting: boolean;
  connect: (s: Settings) => Promise<void>;
  installing: string | null;
  installTool: (label: string, wingetId: string) => Promise<void>;
  onClose: () => void;
  onFinish: () => void;
}) {
  const {
    step: onboardStep, setStep: setOnboardStep, setup, status, settings, setSettings,
    saveSettings, connecting, connect, installing, installTool, onClose, onFinish,
  } = props;
  return (
    <Modal label="ClipForge tutorial" className="modal onboarding-modal" onClose={onClose}>
      <div className="modal-head">
        <BookOpen size={19} color="#7f9bff" weight="fill" />
        <span className="modal-title">
          {onboardStep === 0 && "Welcome to ClipForge"}
          {onboardStep === 1 && "One-time setup"}
          {onboardStep === 2 && "Capture settings"}
          {onboardStep === 3 && "Using ClipForge"}
          {onboardStep === 4 && "You're all set"}
        </span>
        <div className="lib-spacer" />
        <span className="field-label">{onboardStep + 1} / 5</span>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <div className="modal-body onboard-body">
        {onboardStep === 0 && (
          <section className="set-group">
            <div className="onboard-hero">
              <div className="brand-mark onboard-hero-mark">
                <img src={appIcon} alt="" draggable={false} />
              </div>
              <span className="onboard-hero-title">Clip first, record never</span>
              <span className="onboard-hero-sub">
                Your gameplay is always buffered — you only keep the good parts
              </span>
            </div>
            <p className="onboard-copy">
              ClipForge keeps a rolling buffer of your gameplay through OBS. Hit a hotkey (or
              let auto-clip catch a kill) and the last stretch of footage saves as a clip —
              no manual recording, no huge files piling up.
            </p>
            <p className="onboard-copy">
              Every clip records five audio tracks (full mix, game, voice chat, desktop,
              mic) so you can mute your friends — or yourself — at export time.
            </p>
            <p className="onboard-copy">
              This walkthrough covers setup, capture settings, and how to edit + share a
              clip. Takes under a minute.
            </p>
          </section>
        )}

        {onboardStep === 1 && (
          <section className="set-group">
            <span className="set-label">REQUIRED SOFTWARE</span>
            <div className="onboard-check">
              {setup?.obs_installed ? (
                <CheckCircle size={16} weight="fill" color="#40dd80" />
              ) : (
                <Circle size={16} color="#767a85" />
              )}
              <span>OBS Studio {setup?.obs_installed ? "— installed" : "— required to record"}</span>
              {!setup?.obs_installed && (
                <button
                  className="setup-btn"
                  disabled={installing !== null}
                  onClick={() => installTool("OBS Studio", "OBSProject.OBSStudio")}
                >
                  {installing === "OBS Studio" ? "installing…" : "Install"}
                </button>
              )}
            </div>
            <div className="onboard-check">
              {setup?.ffmpeg_installed ? (
                <CheckCircle size={16} weight="fill" color="#40dd80" />
              ) : (
                <Circle size={16} color="#767a85" />
              )}
              <span>
                ffmpeg {setup?.ffmpeg_installed ? "— installed" : "— needed for trims & exports"}
              </span>
              {!setup?.ffmpeg_installed && (
                <button
                  className="setup-btn"
                  disabled={installing !== null}
                  onClick={() => installTool("ffmpeg", "Gyan.FFmpeg")}
                >
                  {installing === "ffmpeg" ? "installing…" : "Install"}
                </button>
              )}
            </div>
            <div className="onboard-check">
              {status.connected ? (
                <CheckCircle size={16} weight="fill" color="#40dd80" />
              ) : (
                <Circle size={16} color="#767a85" />
              )}
              <span>
                OBS connection{" "}
                {status.connected
                  ? `— ${status.obs_version ?? "connected"}`
                  : "— connects automatically once OBS is running"}
              </span>
              {!status.connected && setup?.obs_installed && (
                <button className="setup-btn" disabled={connecting} onClick={() => connect(settings)}>
                  {connecting ? "connecting…" : "Connect"}
                </button>
              )}
            </div>
          </section>
        )}

        {onboardStep === 2 && (
          <section className="set-group">
            <p className="onboard-copy">
              Clip length controls how far back a save reaches — OBS keeps this much
              footage buffered in RAM at all times.
            </p>
            <label className="set-col">
              <span className="field-label">
                Clip length (seconds) — ~
                {Math.round((settings.replay_seconds * 4.5) / 100) / 10} GB RAM at current
                setting
              </span>
              <input
                className="mono"
                type="number"
                min={15}
                max={900}
                value={settings.replay_seconds}
                onChange={(e) =>
                  setSettings({ ...settings, replay_seconds: Number(e.target.value) })
                }
                onBlur={() =>
                  saveSettings({
                    ...settings,
                    replay_seconds: Math.min(900, Math.max(15, settings.replay_seconds || 15)),
                  })
                }
              />
            </label>
            <div className="toggle-card">
              <div className="toggle-text">
                <span className="toggle-title">Auto-launch OBS</span>
                <span className="toggle-desc">Start OBS hidden when it isn't running</span>
              </div>
              <button
                className={`switch ${settings.auto_launch_obs ? "on" : ""}`}
                role="switch"
                aria-checked={settings.auto_launch_obs}
                aria-label="Auto-launch OBS"
                onClick={() => saveSettings({ ...settings, auto_launch_obs: !settings.auto_launch_obs })}
              >
                <span className="knob" />
              </button>
            </div>
            <div className="toggle-card">
              <div className="toggle-text">
                <span className="toggle-title">Auto buffer</span>
                <span className="toggle-desc">Arm when a game runs, disarm when it exits</span>
              </div>
              <button
                className={`switch ${settings.auto_manage_buffer ? "on" : ""}`}
                role="switch"
                aria-checked={settings.auto_manage_buffer}
                aria-label="Auto buffer"
                onClick={() =>
                  saveSettings({ ...settings, auto_manage_buffer: !settings.auto_manage_buffer })
                }
              >
                <span className="knob" />
              </button>
            </div>
            <span className="field-label">
              More capture options (fps, bitrate, encoder, hotkeys) live in Settings.
            </span>
          </section>
        )}

        {onboardStep === 3 && (
          <section className="set-group">
            <p className="onboard-copy">
              Once a clip saves, it shows up in your Library — hover a card to preview it,
              click to open the editor.
            </p>
            <ul className="onboard-list">
              <li>
                The editor shows the video plus every audio track with its own waveform —
                checkboxes pick which tracks export, sliders set their volume.
              </li>
              <li>
                Drag anywhere on the timeline to scrub. <kbd>space</kbd> plays/pauses,{" "}
                <kbd>←</kbd>
                <kbd>→</kbd> steps a frame, <kbd>shift</kbd>+arrows steps 1s.
              </li>
              <li>
                Drag the handles (or <kbd>[</kbd> / <kbd>]</kbd>) to set the trim range —
                it's remembered per clip.
              </li>
              <li>
                Auto-clipped kills show as markers on the timeline — click one to jump
                straight to the action.
              </li>
              <li>
                <strong>Export for Discord</strong> renders a size-budgeted MP4 straight to
                your clipboard; GIF and frame-grab buttons sit next to it.
              </li>
              <li>
                Select multiple clips in the Library and hit <strong>Montage</strong> to
                stitch them — each clip contributes its saved trim.
              </li>
              <li>
                Star a clip to keep it exempt from auto-cleanup; use{" "}
                <strong>Scan for black</strong> to catch dead recordings. Capture quality,
                hotkeys and storage live in <strong>Settings</strong>.
              </li>
            </ul>
          </section>
        )}

        {onboardStep === 4 && (
          <section className="set-group">
            <p className="onboard-copy">
              That's everything. Play a game, save a clip, and it lands in your Library
              ready to trim and share. Revisit this walkthrough anytime from the{" "}
              <strong>Tutorial</strong> button at the top of Settings.
            </p>
          </section>
        )}
      </div>
      <div className="onboard-footer">
        <div className="onboard-dots">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={`onboard-dot ${i === onboardStep ? "active" : ""}`} />
          ))}
        </div>
        <div className="onboard-actions">
          {onboardStep > 0 && (
            <button className="btn-ghost" onClick={() => setOnboardStep((s) => s - 1)}>
              <ArrowLeft size={15} />
              Back
            </button>
          )}
          {onboardStep < 4 ? (
            <button className="btn-ghost apply-btn" onClick={() => setOnboardStep((s) => s + 1)}>
              Next
              <ArrowRight size={15} />
            </button>
          ) : (
            <button className="btn-ghost apply-btn" onClick={onFinish}>
              Done
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
