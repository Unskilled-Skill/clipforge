//! Run the capture engine on the GPU games run on.
//!
//! libobs renders on adapter 0. On laptops (and desktops with an iGPU next
//! to a discrete card) adapter 0 can be the integrated GPU while the game
//! runs on the discrete one; cross-adapter capture then comes out black or
//! costs a copy every frame. Windows' per-app "High performance" preference
//! reorders DXGI so the discrete GPU is adapter 0 for our process.

use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};

const PREFS_KEY: &str = r"HKCU\Software\Microsoft\DirectX\UserGpuPreferences";

fn hardware_adapters() -> usize {
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else { return 0 };
        let mut count = 0;
        let mut i = 0;
        while let Ok(adapter) = factory.EnumAdapters1(i) {
            i += 1;
            if let Ok(desc) = adapter.GetDesc1() {
                if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 == 0 {
                    count += 1;
                }
            }
        }
        count
    }
}

fn reg(args: &[&str]) -> std::io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("reg")
        .args(args)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
}

/// Set "High performance" for this exe on multi-GPU machines, unless the
/// user already chose something in Windows' graphics settings. Must run
/// before libobs creates its D3D device (at startup).
pub fn prefer_high_performance() {
    let Ok(exe) = std::env::current_exe() else { return };
    let exe = exe.to_string_lossy().into_owned();
    if hardware_adapters() < 2 {
        return;
    }
    let already_set = reg(&["query", PREFS_KEY, "/v", &exe]).is_ok_and(|o| o.status.success());
    if already_set {
        return;
    }
    // GpuPreference=2 = High performance.
    let ok = reg(&["add", PREFS_KEY, "/v", &exe, "/t", "REG_SZ", "/d", "GpuPreference=2;", "/f"])
        .is_ok_and(|o| o.status.success());
    crate::logs::line(&format!(
        "multiple GPUs: {} High performance GPU preference",
        if ok { "set" } else { "couldn't set" }
    ));
}
