// Panels extracted from App.tsx: settings page, onboarding walkthrough and
// the two app-picker modals. All state stays in App — these are pure views
// over props, so App.tsx keeps the data flow while this file keeps the bulk.
import type { Dispatch, SetStateAction } from "react";
import { invoke, openDialog } from "./tauri-shim";
import type { GameSource, ObsStatus, RunningApp, Settings, SetupStatus, SupervisorState } from "./types";
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
  Keyboard,
  Lightning,
  Plugs,
  Waveform,
  X,
} from "@phosphor-icons/react";

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
    <div className="modal-backdrop" style={{ zIndex: 200 }} onClick={onClose}>
      <div className="modal app-picker" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <GameController size={19} color="#7f9bff" weight="fill" />
          <span className="modal-title">Add a game</span>
          <div className="lib-spacer" />
          <button className="modal-close" onClick={onClose}>
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
      </div>
    </div>
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
    <div className="modal-backdrop" style={{ zIndex: 200 }} onClick={onClose}>
      <div className="modal app-picker" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <GameController size={19} color="#7f9bff" weight="fill" />
          <span className="modal-title">Pick voice-chat app</span>
          <div className="lib-spacer" />
          <button className="modal-close" onClick={onClose}>
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
      </div>
    </div>
  );
}

export function SettingsPage(props: {
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
        <section className="set-group">
          <div className="set-head">
            <div className="set-head-icon"><FilmSlate size={16} weight="fill" /></div>
            <div className="set-head-text">
              <span className="set-head-title">Capture</span>
              <span className="set-head-desc">Buffer length and recording quality</span>
            </div>
          </div>
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
              <span className="field-label">Bitrate (Mbps)</span>
              <input
                className="mono"
                type="number"
                min={4}
                max={100}
                value={settings.bitrate_mbps}
                onChange={(e) =>
                  saveSettings({
                    ...settings,
                    bitrate_mbps: Math.min(100, Math.max(4, Number(e.target.value) || 4)),
                  })
                }
              />
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
          <span className="field-label">
            FPS / resolution / encoder apply within seconds. Bitrate applies on the next OBS
            restart.
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
          <div className="set-head">
            <div className="set-head-icon"><Keyboard size={16} weight="fill" /></div>
            <div className="set-head-text">
              <span className="set-head-title">Hotkeys</span>
              <span className="set-head-desc">Global — they work while a game has focus</span>
            </div>
          </div>
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
          <div className="set-head">
            <div className="set-head-icon"><Waveform size={16} weight="fill" /></div>
            <div className="set-head-text">
              <span className="set-head-title">Split audio</span>
              <span className="set-head-desc">Five tracks per clip — game, voice, desktop, mic, mix</span>
            </div>
          </div>
          <span className="field-label">
            Clips record 5 audio tracks — full mix, game, voice chat, desktop, mic — so
            exports can isolate any of them. Voice-chat and game audio are captured per-app;
            set your voice app's .exe below (game audio follows the running game).
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
          <span className="field-label">
            A universal capture hook catches most fullscreen games automatically, but it
            misses plenty (anti-cheat, borderless, some exclusive-fullscreen titles). If a
            game's clips come out black, add a dedicated source (matched by its .exe, so it
            works whether or not the game is open). Test confirms the source is live in OBS;
            if it's active but clips are still black, switch the capture type and re-add.
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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal onboarding-modal" onClick={(e) => e.stopPropagation()}>
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
          <button className="modal-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body onboard-body">
          {onboardStep === 0 && (
            <section className="set-group">
              <div className="onboard-hero">
                <div className="brand-mark onboard-hero-mark">
                  <FilmSlate size={24} weight="fill" color="#fff" />
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
                <strong>Tutorial</strong> button in the sidebar.
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
      </div>
    </div>
  );
}
