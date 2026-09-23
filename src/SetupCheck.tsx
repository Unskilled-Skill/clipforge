import { useState } from "react";
import { invoke, isTauri } from "./tauri-shim";
import { captureSetupSample } from "./setup-check";
import type { SupervisorState } from "./types";

export function SetupCheck({ supervisor, onSample, onClose }: {
  supervisor: SupervisorState | null;
  onSample: (path: string) => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<"ready" | "saving" | "review" | "done">("ready");
  const [error, setError] = useState<string | null>(null);
  const [picture, setPicture] = useState(false);
  const [audio, setAudio] = useState(false);
  const [sample, setSample] = useState<string | null>(null);
  const ready = isTauri && supervisor?.connected && supervisor.game && supervisor.buffer_active && !supervisor.paused;

  async function capture() {
    setStage("saving");
    setError(null);
    setPicture(false);
    setAudio(false);
    try {
      const path = await captureSetupSample({
        save: () => invoke<string>("save_setup_replay"),
        prepare: (input) => invoke<string>("prepare_setup_sample", { input }),
      });
      setSample(path);
      onSample(path);
      setStage("review");
    } catch (e) {
      setError(String(e));
      setStage("ready");
    }
  }

  return <section className="setup-check" aria-label="Test my setup">
    <div className="setup-check-heading">
      <strong>Test my setup</strong>
      <button className="btn-ghost" disabled={stage === "saving"} onClick={onClose}>Dismiss</button>
    </div>
    <p role="status">{stage === "done"
      ? "You confirmed that this sample looks and sounds right. Run this check again after changing capture or audio settings."
      : stage === "saving"
        ? "Saving and preparing your sample…"
        : stage === "review"
          ? "Play the sample in the editor below. Check the picture, game sound, and microphone if you use one."
          : "Play your game for at least ten seconds, make some sound, then return here and save a sample. Its last ten seconds will open in the editor; the original replay stays in your library."}</p>
    {error && <p role="alert">{error}</p>}
    {stage === "ready" && <>
      {!ready && <p className="field-hint">{!isTauri ? "Open the desktop app to test real recording." : "Start a detected game and wait for BUFFER ARMED. Resume recording if it is paused."}</p>}
      <button className="setup-btn" disabled={!ready} onClick={capture}>Save test sample</button>
    </>}
    {stage === "review" && <>
      <div className="setup-check-options">
        <label><input type="checkbox" checked={picture} onChange={(e) => setPicture(e.target.checked)} /> Picture looks right</label>
        <label><input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} /> Expected audio is audible</label>
      </div>
      <div className="setup-check-options">
        <button className="setup-btn" disabled={!picture || !audio} onClick={() => setStage("done")}>Confirm setup</button>
        <button className="btn-ghost" onClick={() => sample && onSample(sample)}>Open sample</button>
        <button className="btn-ghost" onClick={() => { setStage("ready"); setError("Check Health and your game capture/audio settings, then record another sample."); }}>Something is wrong</button>
      </div>
    </>}
  </section>;
}
