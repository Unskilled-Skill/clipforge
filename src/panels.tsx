// Panels extracted from App.tsx: settings page, onboarding walkthrough and
// the two app-picker modals. All state stays in App — these are pure views
// over props, so App.tsx keeps the data flow while this file keeps the bulk.
import { useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { confirmDialog, invoke, listen, openDialog } from "./tauri-shim";
import appIcon from "./assets/logo.svg";
import { blacklistApp, isDiscordApp } from "./app-blacklist";
import type { BackupStatus, CaptureTest, Diagnostics, GameSource, ObsStatus, RunningApp, Settings, SetupStatus, SupervisorState } from "./types";
import { captureTestLabel } from "./types";

// Backend save echoes must not replace text being edited before its blur save.
function useSettingDraft<T>(value: T) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(value); }, [value]);
  return [draft, (next: T) => { editing.current = true; setDraft(next); }, () => { editing.current = false; }] as const;
}
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  BookOpen,
  CheckCircle,
  Circle,
  DiscordLogo,
  FilmSlate,
  GameController,
  HardDrives,
  Heartbeat,
  Keyboard,
  Lightning,
  Waveform,
  WarningCircle,
  X,
} from "@phosphor-icons/react";

/// RAM the replay buffer reserves, matching the backend's cap
/// (setup::replay_ram_mb): bitrate + 25% + audio, min 512 MB.
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
          if (e.key === "Tab") return;
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
  /** false: backdrop clicks and Esc don't close it (flows that must be finished). */
  dismissible?: boolean;
  children: ReactNode;
}) {
  const { label, className, onClose, zIndex, dismissible = true, children } = props;
  const dismissRef = useRef(dismissible);
  dismissRef.current = dismissible;
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Focus guards let the browser traverse native media shadow controls normally.
  const wrapFocus = (last: boolean) => {
    const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), video[controls], audio[controls], summary, [tabindex]:not([tabindex="-1"])') ?? [])]
      .filter((el) => !el.hasAttribute("data-modal-focus-guard") && (el.tabIndex >= 0 || el.matches("video[controls], audio[controls]")) && el.getClientRects().length > 0);
    const target = last ? nodes[nodes.length - 1] : nodes[0];
    if (target) target.focus();
    else ref.current?.focus();
  };

  useEffect(() => {
    const close = () => closeRef.current();
    modalStack.push(close);
    const returnFocus = document.activeElement as HTMLElement | null;
    wrapFocus(false);
    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== close) return;
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (dismissRef.current) close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      modalStack.splice(modalStack.indexOf(close), 1);
      returnFocus?.focus?.();
    };
  }, []);

  return (
    <div className="modal-backdrop" style={zIndex ? { zIndex } : undefined} onClick={dismissible ? onClose : undefined}>
      <div
        ref={ref}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <span tabIndex={0} className="modal-focus-guard" data-modal-focus-guard aria-hidden="true" onFocus={() => wrapFocus(true)} />
        {children}
        <span tabIndex={0} className="modal-focus-guard" data-modal-focus-guard aria-hidden="true" onFocus={() => wrapFocus(false)} />
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
  /** "block" toggles apps on the blacklist and stays open for several picks. */
  mode?: "watch" | "block";
  onRemove?: (exe: string) => Promise<void>;
  busy?: boolean;
}) {
  const { settings, runningApps, onAdd, onRefresh, onFolder, onClose, mode = "watch", onRemove, busy } = props;
  const blocking = mode === "block";
  const title = blocking ? "Block an app" : "Add a game";
  return (
    <Modal label={title} className="modal app-picker" zIndex={200} onClose={onClose}>
      <div className="modal-head">
        <GameController size={19} color="#7fe6d7" weight="fill" />
        <span className="modal-title">{title}</span>
        <div className="lib-spacer" />
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <div className="modal-body">
        <span className="field-label">
          {blocking
            ? "Click apps to block or unblock them. Blocked apps are never detected as games or captured."
            : "Pick a running app to watch as a game. Not listed? Use “Find .exe in folder”."}
        </span>
        <div className="app-list">
          {runningApps.length === 0 && (
            <span className="field-label">No running windowed apps found.</span>
          )}
          {runningApps.map((a) => {
            const exe = a.exe.toLowerCase();
            const alwaysBlocked = blocking && isDiscordApp(exe);
            const already = blocking
              ? alwaysBlocked || settings.game_blacklist.some((g) => g.toLowerCase() === exe)
              : settings.game_exes.some((g) => g.toLowerCase() === exe);
            return (
              <div key={a.exe} className="onboard-check">
                <span>
                  <strong>{a.title}</strong> — <span className="mono">{a.exe}</span>
                </span>
                {blocking ? (
                  <button
                    className="setup-btn"
                    disabled={busy || alwaysBlocked}
                    aria-pressed={already}
                    title={alwaysBlocked ? "Always excluded" : already ? "Click to unblock" : "Click to block"}
                    onClick={() => (already ? onRemove?.(exe) : onAdd(a.exe))}
                  >
                    {already ? "Blocked ✓" : "Block"}
                  </button>
                ) : (
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
                )}
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
        <GameController size={19} color="#7fe6d7" weight="fill" />
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
      ? "Backup folder unavailable. Reconnect the drive or choose another folder."
      : status.running
        ? `Backing up… ${status.pending} left`
        : status.pending > 0
          ? `${status.backed_up} backed up, ${status.pending} waiting for your game to close`
          : `All ${status.backed_up} starred ${status.backed_up === 1 ? "clip" : "clips"} backed up${
              status.last_run_ms ? `, checked ${timeAgo(status.last_run_ms)}` : ""
            }`;

  return (
    <div className="set-col">
      <label className="field-label" htmlFor="backup-folder">Back up starred clips to</label>
      <div className="set-row">
        <input
          className="mono"
          id="backup-folder" name="backup-folder" autoComplete="off" spellCheck={false}
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

      </span>
      {(message || status?.error) && <div className="field-error" role="alert">
        <p>Could not back up your clips. Reconnect the backup drive or choose a writable folder, then use Back up now to retry.</p>
        <details><summary>Technical details</summary><p>{message || status?.error}</p></details>
      </div>}
      <span className="field-hint">
        Only starred clips are copied, and only when no game is running, so uploads never slow
        down your matches. Keep the clips folder above on a local drive.
      </span>
    </div>
  );
}

function CatboxSettings(props: { settings: Settings; saveSettings: (s: Settings) => Promise<void> }) {
  const { settings, saveSettings } = props;
  const [draft, setDraft] = useState(settings.catbox_userhash);
  useEffect(() => setDraft(settings.catbox_userhash), [settings.catbox_userhash]);
  return (
    <label className="set-col">
      <span className="field-label">Catbox account key (optional)</span>
      <input
        className="mono"
        type="password" name="catbox-account-key" spellCheck={false}
        autoComplete="off"
        placeholder="Empty = upload without an account"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft.trim() !== settings.catbox_userhash) saveSettings({ ...settings, catbox_userhash: draft.trim() });
        }}
      />
      <span className="field-hint">
        Find your account key in Catbox → Manage account; leave blank for anonymous uploads.
      </span>
    </label>
  );
}

/// `action` names a one-click fix the Health panel can run for this row.
type Check = { label: string; value: string; ok: boolean; fix?: string; action?: "install-ffmpeg" | "restart-engine" };

function encoderName(id: string | null): string {
  if (!id || id === "none") return "not set";
  if (id === "obs_x264") return "CPU (x264)";
  const codec = id.includes("av1") ? "AV1" : id.includes("265") || id.includes("hevc") ? "HEVC" : "H.264";
  if (id.includes("amf")) return `AMD ${codec}`;
  if (id.includes("nvenc")) return `NVIDIA ${codec}`;
  if (id.includes("qsv")) return `Intel ${codec}`;
  return id;
}

/// Turn raw diagnostics into rows a player can read: what the engine is really
/// using, whether it's right for clipping, and what to do if not.
function healthChecks(d: Diagnostics): Check[] {
  const hw = (id: string | null) => !!id && /nvenc|amf|qsv/.test(id);
  const gb = d.disk_free_bytes != null ? d.disk_free_bytes / 1024 ** 3 : null;
  const lag = Math.max(d.health.render_lag_pct, d.health.encoder_lag_pct);
  return [
    {
      label: "Capture engine",
      value: d.obs_connected ? `Running (OBS ${d.obs_version ?? "unknown"})` : "Not running",
      ok: d.obs_connected,
      fix: !d.obs_connected ? "It starts by itself. If it's stuck, retry." : undefined,
      action: d.obs_connected ? undefined : "restart-engine",
    },
    {
      label: "Admin rights",
      value: d.elevated ? "On — capture has GPU priority" : "Off — standard permissions",
      ok: true,
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
        ? `${Math.round(d.bitrate_kbps / 1000)} Mbps ${d.rate_control === "CBR" ? "constant bitrate" : d.rate_control ?? ""}`.trim()
        : "Unknown",
      ok: (d.bitrate_kbps ?? 0) >= 8000,
    },
    {
      label: "Keyframes",
      value: d.keyint_sec ? `Every ${d.keyint_sec}s` : "Encoder default",
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
      ok: !!d.buffer_seconds,
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
      fix: gb != null && gb < 10 ? "Clips can't save when the drive is full. Free up space or lower the storage cap." : undefined,
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
      fix: d.ffmpeg_found ? undefined : "Needed for thumbnails, trims and exports.",
      action: d.ffmpeg_found ? undefined : "install-ffmpeg",
    },
  ];
}

/// Settings "Health" section: a live view of the recording setup.
export function HealthPanel({ onTestSetup }: { onTestSetup: () => void }) {
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [applying, setApplying] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  async function runFix(action: NonNullable<Check["action"]>) {
    setFixing(action);
    setFixError(null);
    try {
      if (action === "install-ffmpeg") await invoke("winget_install", { id: "Gyan.FFmpeg" });
      else await invoke("launch_obs");
      setDiag(await invoke<Diagnostics>("obs_diagnostics"));
    } catch (e) {
      setFixError(String(e));
    } finally {
      // The engine restarts on the supervisor's next tick; keep the button
      // busy briefly so it isn't pressed again mid-restart.
      setTimeout(() => setFixing(null), action === "restart-engine" ? 4000 : 0);
    }
  }
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
    // Refresh the moment a settings change reaches OBS, not on the next poll.
    const unlisten = [
      listen("obs-config-applying", () => alive && setApplying(true)),
      listen("obs-config-applied", () => {
        if (!alive) return;
        setApplying(false);
        load();
      }),
    ];
    return () => {
      alive = false;
      clearInterval(id);
      unlisten.forEach((p) => p.then((off) => off()));
    };
  }, []);
  const checks = diag ? healthChecks(diag) : [];
  const issues = checks.filter((c) => !c.ok).length;
  const renderCheck = (c: Check) => (
          <li key={c.label} className={`health-row ${c.ok ? "ok" : "warn"}`}>
            {c.ok ? (
              <CheckCircle size={16} weight="fill" aria-label="OK" />
            ) : (
              <WarningCircle size={16} weight="fill" aria-label="Needs attention" />
            )}
            <span className="health-label">{c.label}</span>
            <span className="health-value mono">{c.value}</span>
            {!c.ok && c.fix && <span className="health-fix">{c.fix}</span>}
            {!c.ok && c.action && (
              <button className="setup-btn health-action" disabled={fixing !== null} onClick={() => runFix(c.action!)}>
                {fixing === c.action
                  ? c.action === "install-ffmpeg" ? "installing…" : "retrying…"
                  : c.action === "install-ffmpeg" ? "Install" : "Retry"}
              </button>
            )}
          </li>
  );
  return (
    <section id="settings-health" className="set-group health-group">
      <div className="set-head">
        <div className="set-head-icon"><Heartbeat size={16} weight="fill" /></div>
        <div className="set-head-text">
          <h2 className="set-head-title">Health</h2>
          <span className="set-head-desc">
            {!diag
              ? "Checking…"
              : applying
                ? "Applying your change…"
                : issues === 0
                ? "Everything is set up for clipping"
                : `${issues} ${issues > 1 ? "things" : "thing"} to look at`}
          </span>
        </div>
      </div>
      {diag?.settings_pending && (
        <span className="field-hint">Some changes are waiting. They apply once your game closes.</span>
      )}
      {issues > 0 && <ul className="health-list">{checks.filter((c) => !c.ok).map(renderCheck)}</ul>}
      {checks.some((c) => c.ok) && <details className="health-details" open={diagnosticsOpen} onToggle={(e) => setDiagnosticsOpen(e.currentTarget.open)}>
        <summary>{diagnosticsOpen ? "Hide healthy diagnostics" : `Show ${checks.filter((c) => c.ok).length} healthy checks`}</summary>
        <ul className="health-list">{checks.filter((c) => c.ok).map(renderCheck)}</ul>
      </details>}
      {fixError && <span className="field-hint" role="alert">{fixError}</span>}
      <div className="set-row">
        <button className="btn-ghost" onClick={onTestSetup}>Test my setup</button>
        <button className="btn-ghost" onClick={() => invoke("open_logs").catch((e) => setFixError(String(e)))}>
          Open logs
        </button>
      </div>
    </section>
  );
}

const ADMIN_RULES: [string, string][] = [["ask", "Ask"], ["auto", "Restart automatically"], ["never", "Never"]];

function SegRadios<T extends string | number>(props: { label: string; value: T; options: [T, string][]; onPick: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label={props.label} onKeyDown={(e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      const radios = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
      const index = radios.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? radios.length - 1 : (index + (["ArrowLeft", "ArrowUp"].includes(e.key) ? -1 : 1) + radios.length) % radios.length;
      radios[next]?.focus(); radios[next]?.click();
    }}>
      {props.options.map(([v, label]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={props.value === v} tabIndex={props.value === v ? 0 : -1}
          className={props.value === v ? "on" : ""} onClick={() => props.onPick(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

const SETTINGS_SECTIONS: [string, string][] = [
  ["capture", "Capture"], ["automation", "Auto-clip"], ["export", "Export"], ["hotkeys", "Hotkeys"],
  ["audio", "Audio"], ["games", "Games"], ["storage", "Storage"], ["advanced", "Advanced"], ["health", "Health"],
];

export function SettingsPage(props: {
  onTestSetup: () => void;
  settings: Settings;
  setSettings: (s: Settings) => void;
  saveSettings: (s: Settings) => Promise<void>;
  savingSettings: boolean;
  saveFeedback: ReactNode;
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
  sourceTest: Record<string, CaptureTest | "error">;
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
    sup, onTutorial, onPickVc,
  } = props;
  const [watchedDraft, setWatchedDraft] = useState(settings.game_exes.join("\n"));
  const [vcDraft, setVcDraft, finishVcDraft] = useSettingDraft(settings.vc_exe);
  const [clipsDraft, setClipsDraft, finishClipsDraft] = useSettingDraft(settings.clips_dir);
  const editingWatched = useRef(false);
  useEffect(() => {
    if (!editingWatched.current) setWatchedDraft(settings.game_exes.join("\n"));
  }, [settings.game_exes]);
  const [blockedExe, setBlockedExe] = useState("");
  const [elevating, setElevating] = useState(false);
  const [elevateError, setElevateError] = useState<string | null>(null);
  // The section list highlights whichever section is at the top of the scroll.
  const [activeSection, setActiveSection] = useState("capture");
  const bodyRef = useRef<HTMLDivElement>(null);
  // A clicked section stays highlighted while its jump scrolls: the last
  // sections can't reach the top, so the scroll position alone would miss them.
  const pinnedUntil = useRef(0);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onScroll = () => {
      if (Date.now() < pinnedUntil.current) return;
      const top = body.getBoundingClientRect().top + 40;
      let current = SETTINGS_SECTIONS[0][0];
      for (const [id] of SETTINGS_SECTIONS) {
        const el = document.getElementById(`settings-${id}`);
        if (el && el.getBoundingClientRect().top <= top) current = id;
      }
      setActiveSection(current);
    };
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  }, []);
  function goToSection(id: string) {
    const target = document.getElementById(`settings-${id}`);
    const disclosure = target?.closest("details");
    if (disclosure) disclosure.open = true;
    pinnedUntil.current = Date.now() + 700;
    target?.scrollIntoView({ block: "start" });
    setActiveSection(id);
    const heading = target?.querySelector<HTMLElement>("h2");
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }
  // "auto" needs the admin task (one UAC prompt the first time). A game
  // override set to "default" drops back to the general rule.
  async function setAdminRule(exe: string | null, rule: string) {
    setElevateError(null);
    try {
      if (rule === "auto") await invoke("ensure_admin_task");
      const games = { ...settings.admin_rule_games };
      if (exe) {
        if (rule === "default") delete games[exe];
        else games[exe] = rule;
      }
      await saveSettings({ ...settings, admin_rule: exe ? settings.admin_rule : rule, admin_rule_games: games });
    } catch (error) {
      setElevateError(`Could not set up restarting as admin: ${String(error)}`);
    }
  }
  const [blacklistBusy, setBlacklistBusy] = useState(false);
  const [blacklistError, setBlacklistError] = useState<string | null>(null);
  // Seconds since the Overwolf companion app checked in; null = never.
  const [overwolfSeen, setOverwolfSeen] = useState<number | null>(null);
  useEffect(() => {
    if (!settings.overwolf_events) return;
    const poll = () => invoke<number | null>("overwolf_status").then(setOverwolfSeen).catch(() => {});
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [settings.overwolf_events]);
  async function updateBlacklist(next: Settings) {
    setBlacklistBusy(true);
    setBlacklistError(null);
    try {
      await saveSettings(next);
      setBlockedExe("");
    } catch (error) {
      setBlacklistError(`Could not save the blacklist: ${String(error)}`);
    } finally {
      setBlacklistBusy(false);
    }
  }
  async function blockApp(raw: string) {
    try {
      await updateBlacklist(blacklistApp(settings, raw));
    } catch (error) {
      setBlacklistError(String(error instanceof Error ? error.message : error));
    }
  }
  function unblockApp(exe: string) {
    return updateBlacklist({
      ...settings,
      game_blacklist: settings.game_blacklist.filter((g) => g.toLowerCase() !== exe.toLowerCase()),
    });
  }
  const [blockPickerApps, setBlockPickerApps] = useState<RunningApp[] | null>(null);
  async function openBlockPicker() {
    try {
      setBlockPickerApps(await invoke<RunningApp[]>("list_running_apps"));
    } catch (error) {
      setBlacklistError(String(error));
    }
  }
  async function browseBlockedExe() {
    try {
      const picked = await openDialog({ filters: [{ name: "Application", extensions: ["exe"] }] });
      if (typeof picked === "string") await blockApp(picked);
    } catch (error) { setBlacklistError(String(error)); }
  }
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
        <button className="btn-ghost reset-btn" disabled={resetting || props.savingSettings} onClick={resetSettings}>
          <ArrowCounterClockwise size={14} />
          {resetting ? "resetting…" : "Reset to defaults"}
        </button>
      </header>
      {props.saveFeedback}
      <div className="settings-layout">
      <nav className="settings-sections" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map(([id, label]) => (
          <a
            key={id}
            href={`#settings-${id}`}
            className={activeSection === id ? "active" : ""}
            aria-current={activeSection === id ? "true" : undefined}
            onClick={(e) => { e.preventDefault(); goToSection(id); }}
          >
            {label}
          </a>
        ))}
      </nav>
      <div className="settings-body" ref={bodyRef}>
        <section id="settings-capture" className="set-group">
          <div className="set-head">
            <div className="set-head-icon"><FilmSlate size={16} weight="fill" /></div>
            <div className="set-head-text">
              <h2 className="set-head-title">Capture</h2>
              <span className="set-head-desc">Buffer length and recording quality</span>
            </div>
          </div>
          <label className="set-col">
            <span className="field-label">Clip length</span>
            <div className="seg" role="radiogroup" aria-label="Clip length" onKeyDown={(e) => {
              if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
              e.preventDefault(); e.stopPropagation();
              const radios = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
              const index = radios.indexOf(document.activeElement as HTMLButtonElement);
              const next = e.key === "Home" ? 0 : e.key === "End" ? radios.length - 1 : (index + (["ArrowLeft", "ArrowUp"].includes(e.key) ? -1 : 1) + radios.length) % radios.length;
              radios[next]?.focus(); radios[next]?.click();
            }}>
              {[...new Set([30, 60, 120, 180, 300, settings.replay_seconds])]
                .sort((a, b) => a - b)
                .map((s) => (
                  <button
                    key={s}
                    role="radio"
                    aria-checked={settings.replay_seconds === s}
                    tabIndex={settings.replay_seconds === s ? 0 : -1}
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

          </div>
          <span className="field-hint">
            Applies after your game closes. Auto chooses the bitrate for your recording quality.
          </span>
        </section>

        <section id="settings-automation" className="set-group">
          <div className="set-head">
            <div className="set-head-icon"><Lightning size={16} weight="fill" /></div>
            <div className="set-head-text">
              <h2 className="set-head-title">Automation</h2>
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
              <span className="toggle-title">Record whole sessions</span>
              <span className="toggle-desc">
                Save full sessions with kill bookmarks; about 9 GB/hour at 20 Mbps. Pauses below 3 GB free.
              </span>
            </div>
            <button
              className={`switch ${settings.session_recording ? "on" : ""}`}
              role="switch"
              aria-checked={settings.session_recording}
              aria-label="Record whole sessions"
              onClick={() => saveSettings({ ...settings, session_recording: !settings.session_recording })}
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
          <div className="set-col admin-rule">
            <span className="field-label">When a game runs as admin</span>
            <span className="field-hint">
              Its picture is hidden from ClipForge, so clips come out black and the save hotkey can't reach it.
              ClipForge can restart as admin to match. Windows asks for permission once.
            </span>
            <SegRadios label="When a game runs as admin" value={settings.admin_rule} options={ADMIN_RULES} onPick={(v) => void setAdminRule(null, v)} />
            <div className="admin-games">
              <span className="field-label">Per game</span>
              {Object.entries(settings.admin_rule_games).map(([exe, rule]) => (
                <div className="admin-game" key={exe}>
                  <span className="mono">{exe}</span>
                  <select className="audio-select" value={rule} aria-label={`Admin rule for ${exe}`} onChange={(e) => void setAdminRule(exe, e.target.value)}>
                    {ADMIN_RULES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    <option value="default">Use default</option>
                  </select>
                </div>
              ))}
              {settings.game_exes.some((g) => !(g.toLowerCase() in settings.admin_rule_games)) && (
                <select className="audio-select" aria-label="Add a per-game rule" value="" onChange={(e) => { if (e.target.value) void setAdminRule(e.target.value, "auto"); }}>
                  <option value="">Add a game…</option>
                  {settings.game_exes
                    .filter((g) => !(g.toLowerCase() in settings.admin_rule_games))
                    .map((g) => <option key={g} value={g.toLowerCase()}>{g}</option>)}
                </select>
              )}
            </div>
          </div>
          <div className="toggle-card">
            <div className="toggle-text">
              <span className="toggle-title">Always start as administrator</span>
              <span className="toggle-desc">
                Starts ClipForge as admin at login, so admin games never block capture and capture gets GPU priority.
              </span>
            </div>
            <button
              className={`switch ${settings.run_elevated ? "on" : ""}`}
              role="switch"
              aria-checked={settings.run_elevated}
              aria-label="Always start as administrator"
              disabled={elevating}
              onClick={async () => {
                const enabled = !settings.run_elevated;
                setElevating(true);
                setElevateError(null);
                try {
                  await invoke("set_run_elevated", { enabled });
                  setSettings({ ...settings, run_elevated: enabled });
                  if (enabled && !(await invoke<boolean>("is_running_elevated"))) {
                    const now = await confirmDialog("Restart ClipForge with admin rights now?", {
                      title: "ClipForge",
                      kind: "info",
                    });
                    if (now) await invoke("restart_elevated");
                  }
                } catch (error) {
                  setElevateError(String(error));
                } finally {
                  setElevating(false);
                }
              }}
            >
              <span className="knob" />
            </button>
          </div>
          {elevateError && <span className="field-hint" role="alert">{elevateError}</span>}
          <div className="toggle-card">
            <div className="toggle-text">
              <span className="toggle-title">Auto-clip kills</span>
              <span className="toggle-desc">
                Save supported game highlights automatically. Restart a running game after enabling.
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
          {settings.auto_clip && (
            <label className="set-col">
              <span className="field-label">Valorant: clip</span>
              <select
                className="audio-select wide"
                value={settings.auto_clip_min_kills}
                onChange={(e) => saveSettings({ ...settings, auto_clip_min_kills: Number(e.target.value) })}
              >
                <option value={1}>Every kill</option>
                <option value={2}>Rounds with 2+ kills</option>
                <option value={3}>Rounds with 3+ kills</option>
                <option value={4}>Rounds with 4+ kills</option>
                <option value={5}>Aces only</option>
              </select>
              <span className="field-hint">
                Multikill clips are named 2K, 3K, 4K or ACE. With a minimum, the whole round is saved
                as one clip when it ends.
              </span>
            </label>
          )}
          <div className="toggle-card">
            <div className="toggle-text">
              <span className="toggle-title">Overwolf game events</span>
              <span className="toggle-desc">
                Valorant, Fortnite, Apex, Siege, Overwatch and Marvel Rivals.
                Needs Overwolf and the ClipForge Overwolf app. ClipForge still does the recording.
                {settings.overwolf_events &&
                  (overwolfSeen !== null && overwolfSeen < 180
                    ? " Connected."
                    : " Not connected. Open Overwolf.")}
              </span>
            </div>
            <button
              className={`switch ${settings.overwolf_events ? "on" : ""}`}
              role="switch"
              aria-checked={settings.overwolf_events}
              aria-label="Overwolf game events"
              onClick={() => saveSettings({ ...settings, overwolf_events: !settings.overwolf_events })}
            >
              <span className="knob" />
            </button>
          </div>
        </section>

        <section id="settings-export" className="set-group">
          <div className="set-head">
            <div className="set-head-icon"><DiscordLogo size={16} weight="fill" /></div>
            <div className="set-head-text">
              <h2 className="set-head-title">Export</h2>
              <span className="set-head-desc">Discord exports are sized to fit and copied, ready to paste</span>
            </div>
          </div>
          <div className="set-col">
            <span className="field-label">Discord upload limit</span>
            <SegRadios
              label="Discord upload limit"
              value={settings.discord_target_mb}
              options={[[10, "10 MB · Free"], [50, "50 MB · Nitro Basic"], [500, "500 MB · Nitro"]]}
              onPick={(v) => saveSettings({ ...settings, discord_target_mb: v })}
            />
            <span className="field-hint">The bitrate is set so each export lands just under this limit. You can change it per export too.</span>
          </div>
          <span className="field-hint">
            Upload links (catbox, Streamable) are under{" "}
            <a href="#settings-sharing" onClick={(e) => { e.preventDefault(); goToSection("advanced"); document.getElementById("settings-sharing")?.scrollIntoView({ block: "start" }); }}>Advanced › Sharing</a>.
          </span>
        </section>

        <section id="settings-hotkeys" className="set-group">
          <div className="set-head">
            <div className="set-head-icon"><Keyboard size={16} weight="fill" /></div>
            <div className="set-head-text">
              <h2 className="set-head-title">Hotkeys</h2>
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

        <section id="settings-audio" className="set-group">
          <div className="set-head">
            <div className="set-head-icon"><Waveform size={16} weight="fill" /></div>
            <div className="set-head-text">
              <h2 className="set-head-title">Split audio</h2>
              <span className="set-head-desc">Five tracks per clip — game, voice, desktop, mic, mix</span>
            </div>
          </div>
          <span className="field-hint">
            Choose which tracks to keep when exporting. Set your voice-chat app below.
          </span>
          <label className="set-col">
            <span className="field-label">Voice-chat app (.exe)</span>
            <div className="set-row">
              <input
                className="mono"
                aria-label="Voice-chat app (.exe)" name="voice-chat-executable" autoComplete="off" spellCheck={false}
                value={vcDraft}
                onChange={(e) => setVcDraft(e.target.value)}
                onBlur={() => { finishVcDraft(); void saveSettings({ ...settings, vc_exe: vcDraft }); }}
                placeholder="discord.exe"
              />
              <button className="btn-ghost" onClick={onPickVc}>
                Pick app
              </button>
            </div>
          </label>
          <div className="toggle-card">
            <div className="toggle-text">
              <span className="toggle-title">Mic noise suppression</span>
              <span className="toggle-desc">Removes keyboard clatter and fan hum from your mic</span>
            </div>
            <button
              className={`switch ${settings.mic_noise_suppression ? "on" : ""}`}
              role="switch"
              aria-checked={settings.mic_noise_suppression}
              aria-label="Mic noise suppression"
              onClick={() => saveSettings({ ...settings, mic_noise_suppression: !settings.mic_noise_suppression })}
            >
              <span className="knob" />
            </button>
          </div>
        </section>

        <section id="settings-games" className="set-group">
          <div className="set-head">
            <div className="set-head-icon"><GameController size={16} weight="fill" /></div>
            <div className="set-head-text">
              <h2 className="set-head-title">Games watched</h2>
              <span className="set-head-desc">What arms the buffer, and how each game is captured</span>
            </div>
          </div>
          <textarea
            className="mono"
            aria-label="Watched game executables, one per line"
            rows={5}
            value={watchedDraft}
            spellCheck={false}
            autoComplete="off"
            name="watched-games"
            onFocus={() => { editingWatched.current = true; }}
            onChange={(e) => setWatchedDraft(e.target.value)}
            onBlur={() => {
              editingWatched.current = false;
              const game_exes = watchedDraft.split("\n").map((exe) => exe.trim()).filter(Boolean);
              if (game_exes.join("\n") !== settings.game_exes.join("\n")) void saveSettings({ ...settings, game_exes });
            }}
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
            Most games work automatically. For blank recordings, add the game's .exe and test capture.
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
                  {test && test !== "error" && captureTestLabel(test)}
                </span>
                <select
                  className="audio-select"
                  value={kind}
                  aria-label={`Capture method for ${exe}`}
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
                  title="Move to app blacklist"
                  aria-label={`Stop watching ${exe}`}
                  onClick={() => removeGame(exe)}
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </section>

        {blockPickerApps && (
          <AppPickerModal
            mode="block"
            settings={settings}
            runningApps={blockPickerApps}
            onAdd={blockApp}
            onRemove={unblockApp}
            busy={blacklistBusy}
            onRefresh={openBlockPicker}
            onFolder={browseBlockedExe}
            onClose={() => setBlockPickerApps(null)}
          />
        )}


        <section id="settings-storage" className="set-group">
          <div className="set-head">
            <div className="set-head-icon"><HardDrives size={16} weight="fill" /></div>
            <div className="set-head-text">
              <h2 className="set-head-title">Storage</h2>
              <span className="set-head-desc">Where clips live and how much space they may take</span>
            </div>
          </div>
          <div className="set-row">
            <input
              className="mono"
              aria-label="Clips folder" name="clips-folder" autoComplete="off" spellCheck={false}
              value={clipsDraft}
              onChange={(e) => setClipsDraft(e.target.value)}
              onBlur={() => { finishClipsDraft(); void applyClipsDir(clipsDraft); }}
            />
            <button
              className="btn-ghost"
              onClick={async () => {
                const picked = await openDialog({
                  directory: true,
                  defaultPath: settings.clips_dir,
                });
                if (typeof picked === "string") {
                  setClipsDraft(picked);
                  finishClipsDraft();
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

        <details id="settings-advanced" className="set-group advanced-group">
          <summary>Advanced</summary>
          <div className="advanced-content">
            <section className="advanced-section" aria-label="Encoding">
              <h2 className="set-head-title">Encoding</h2>
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
              <p className="field-hint">Keyframe timing is managed automatically. See Health for its current value.</p>
            </section>
        <section id="settings-blacklist" className="advanced-section" aria-labelledby="blacklist-title">
          <div className="set-head">
            <div className="set-head-icon"><GameController size={16} weight="fill" /></div>
            <div className="set-head-text">
              <h2 className="set-head-title" id="blacklist-title">App blacklist</h2>
              <span className="set-head-desc">Exclude apps from game detection and video capture</span>
            </div>
          </div>
          <span className="field-hint">Discord, Discord PTB and Discord Canary are always excluded. Voice-chat audio follows your audio settings.</span>
          <label className="field-label" htmlFor="blacklist-exe">App executable</label>
          <form className="set-row blacklist-entry" onSubmit={(e) => { e.preventDefault(); void blockApp(blockedExe); }}>
            <input id="blacklist-exe" className="mono" value={blockedExe} placeholder="spotify.exe"
              disabled={blacklistBusy} onChange={(e) => setBlockedExe(e.target.value)}
              aria-describedby={blacklistError ? "blacklist-error" : undefined} />
            <button className="btn-ghost" type="submit" disabled={blacklistBusy || !blockedExe.trim()}>
              {blacklistBusy ? "Saving…" : "Block app"}
            </button>
            <button className="btn-ghost" type="button" disabled={blacklistBusy} onClick={openBlockPicker}>
              Pick running app…
            </button>
            <button className="btn-ghost" type="button" disabled={blacklistBusy} onClick={browseBlockedExe}>Browse…</button>
          </form>
          {blacklistError && <span id="blacklist-error" role="alert" className="field-hint">{blacklistError}</span>}
          {settings.game_blacklist.length === 0 && <span className="field-hint">No additional apps blocked.</span>}
          {settings.game_blacklist.length > 0 && (
            <>
              <span className="field-label">Blocked apps</span>
              <div className="blacklist-chips">
                {settings.game_blacklist.map((g) => (
                  <button
                    key={g}
                    className="chip"
                    title="Remove from blacklist"
                    aria-label={`Unblock ${g}`}
                    disabled={blacklistBusy}
                    onClick={() => unblockApp(g)}
                  >
                    {g} <X size={11} />
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
            <section id="settings-sharing" className="advanced-section" aria-labelledby="sharing-title">
              <h2 id="sharing-title" className="set-head-title">Sharing</h2>
              <CatboxSettings settings={settings} saveSettings={saveSettings} />
            </section>
          </div>
        </details>

        <HealthPanel onTestSetup={props.onTestSetup} />

      </div>
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
  installTool: (label: string, wingetId: string) => Promise<boolean>;
  engineError: string | null;
  engineDownloading: boolean;
  /** "downloading 42%" while the engine downloads, else null. */
  engineProgress: string | null;
  /** First launch: no way out but through every step. */
  firstRun: boolean;
  onClose: () => void;
  onFinish: () => void;
}) {
  const {
    step: onboardStep, setStep: setOnboardStep, setup, status, settings,
    saveSettings, installing, installTool, engineError, engineDownloading, engineProgress, firstRun, onClose, onFinish,
  } = props;
  // Setup gate: Next stays locked until the required software is in place,
  // unless an install actually failed. Then the user may continue and fix
  // it later from Settings → Health instead of being stuck here.
  const [ffmpegFailed, setFfmpegFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [replayDraft, setReplayDraft, finishReplayDraft] = useSettingDraft(settings.replay_seconds);
  const engineReady = status.connected;
  const ffmpegReady = !!setup?.ffmpeg_installed;
  const setupFailed = (!engineReady && !!engineError && !engineDownloading) || (!ffmpegReady && ffmpegFailed);
  const setupBlocked = onboardStep === 1 && !(engineReady && ffmpegReady) && !setupFailed;
  return (
    <Modal label="ClipForge tutorial" className="modal onboarding-modal" onClose={onFinish}>
      <div className="modal-head">
        <BookOpen size={19} color="#7fe6d7" weight="fill" />
        <span className="modal-title">
          {onboardStep === 0 && "Welcome to ClipForge"}
          {onboardStep === 1 && "One-time setup"}
          {onboardStep === 2 && "Capture settings"}
          {onboardStep === 3 && "Using ClipForge"}
          {onboardStep === 4 && "You're all set"}
        </span>
        <div className="lib-spacer" />
        <span className="field-label">{onboardStep + 1} / 5</span>
        {!firstRun && (
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        )}
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
              ClipForge keeps a rolling buffer of your gameplay in memory. Hit a hotkey (or
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
              {status.connected ? (
                <CheckCircle size={16} weight="fill" color="#40dd80" />
              ) : (
                <Circle size={16} color="#767a85" />
              )}
              <span>
                Capture engine{" "}
                {engineReady
                  ? "— ready"
                  : engineError && !engineDownloading
                    ? "— couldn't set up"
                    : `— ${engineProgress ?? "downloading"} (one time, about 150 MB)`}
              </span>
              {!engineReady && engineError && !engineDownloading && (
                <button
                  className="setup-btn"
                  disabled={retrying}
                  onClick={async () => {
                    setRetrying(true);
                    await invoke("launch_obs").catch(() => {});
                    setTimeout(() => setRetrying(false), 4000);
                  }}
                >
                  {retrying ? "retrying…" : "Retry"}
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
                  onClick={async () => setFfmpegFailed(!(await installTool("ffmpeg", "Gyan.FFmpeg")))}
                >
                  {installing === "ffmpeg" ? "installing…" : ffmpegFailed ? "Try again" : "Install"}
                </button>
              )}
            </div>
            {setupBlocked && (
              <span className="field-hint">
                {!ffmpegReady && installing === null
                  ? "Install ffmpeg to continue."
                  : "Finishing setup, this can take a minute…"}
              </span>
            )}
            {setupFailed && (
              <span className="field-hint" role="alert">
                Something couldn't be installed. You can continue and fix it later in Settings → Health.
              </span>
            )}
          </section>
        )}

        {onboardStep === 2 && (
          <section className="set-group">
            <p className="onboard-copy">
              Clip length controls how far back a save reaches — ClipForge keeps this much
              footage buffered in RAM while a game runs.
            </p>
            <label className="set-col">
              <span className="field-label">
                Clip length (seconds) — about {bufferRamText(settings)} of RAM at this setting
              </span>
              <input
                className="mono"
                type="number"
                min={15}
                max={900}
                value={replayDraft}
                onChange={(e) =>
                  setReplayDraft(Number(e.target.value))
                }
                onBlur={() => {
                  finishReplayDraft();
                  void saveSettings({
                    ...settings,
                    replay_seconds: Math.min(900, Math.max(15, replayDraft || 15)),
                  });
                }}
              />
            </label>
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
          {onboardStep < 4 && <button className="btn-ghost" onClick={onFinish}>Skip tutorial</button>}
          {onboardStep > 0 && (
            <button className="btn-ghost" onClick={() => setOnboardStep((s) => s - 1)}>
              <ArrowLeft size={15} />
              Back
            </button>
          )}
          {onboardStep < 4 ? (
            <button
              className="btn-ghost apply-btn"
              disabled={setupBlocked}
              title={setupBlocked ? "Finish the required setup first" : undefined}
              onClick={() => setOnboardStep((s) => s + 1)}
            >
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
