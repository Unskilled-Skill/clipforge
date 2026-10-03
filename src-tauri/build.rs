fn main() {
    // Lets the exe start without obs.dll, so the OBS runtime can be
    // downloaded on first run before anything touches it (see engine.rs).
    libobs_bootstrapper::build::emit_windows_obs_delay_load();
    tauri_build::build()
}
