//! Share a clip as a link instead of a file.
//!
//! Both hosts get a high-quality H.264 copy of the editor's selection (same
//! trim and audio tracks as a Discord export, but sized for quality, not for
//! a 10 MB cap), which plays everywhere, including inline in Discord.
//! - catbox.moe: uploaded here, link copied. Anonymous, no expiry, 200 MB max.
//! - Streamable: its API no longer accepts uploads, so the copy is prepared,
//!   streamable.com opens and the file is highlighted in Explorer to drag in.
//!   (Free uploads there are deleted after 90 days.)
//!
//! Links are remembered per clip so they can be copied again later.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const CATBOX_MAX_MB: f64 = 200.0;
const STREAMABLE_MAX_MB: f64 = 250.0;
/// Near-original quality for 1080p game footage in H.264; the size cap only
/// bites on long selections.
const SHARE_MAX_VIDEO_KBPS: f64 = 16_000.0;

#[derive(Serialize, Deserialize, Clone)]
pub struct ShareLink {
    pub host: String,
    pub url: String,
    pub start: f64,
    pub end: f64,
    /// Unix seconds.
    pub at: u64,
}

fn links_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("share-links.json"))
}

type LinkMap = std::collections::HashMap<String, Vec<ShareLink>>;

fn read_links(app: &AppHandle) -> LinkMap {
    links_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn remember(app: &AppHandle, clip: &str, link: ShareLink) {
    let mut links = read_links(app);
    links.entry(clip.to_string()).or_default().insert(0, link);
    if let (Ok(path), Ok(raw)) = (links_path(app), serde_json::to_string_pretty(&links)) {
        let _ = std::fs::write(path, raw);
    }
}

/// Links made for this clip, newest first.
#[tauri::command]
pub fn list_share_links(app: AppHandle, input: String) -> Vec<ShareLink> {
    read_links(&app).remove(&input).unwrap_or_default()
}

/// Encode the share copy into ClipForge's cache (not the clips folder, so it
/// never shows up in the library).
async fn share_copy(
    app: &AppHandle,
    input: &str,
    start: f64,
    end: f64,
    audio_tracks: Option<Vec<(u32, f32)>>,
    max_mb: f64,
) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("share");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = PathBuf::from(input)
        .file_stem()
        .ok_or("bad input path")?
        .to_string_lossy()
        .into_owned();
    let name = if end > start {
        format!("{stem} ({:.0}-{:.0}s).mp4", start, end)
    } else {
        format!("{stem}.mp4")
    };
    let out = crate::clips::encode_selection(
        app,
        input,
        start,
        end,
        audio_tracks,
        // Headroom for the host's limit; encode_selection also re-encodes
        // smaller if the GPU encoder overshoots.
        max_mb * 0.95,
        Some(SHARE_MAX_VIDEO_KBPS),
        dir.join(name),
        "share",
    )
    .await?;
    Ok(PathBuf::from(out))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Upload the selection to catbox.moe and copy the link.
#[tauri::command]
pub async fn share_catbox(
    app: AppHandle,
    input: String,
    start: f64,
    end: f64,
    audio_tracks: Option<Vec<(u32, f32)>>,
) -> Result<String, String> {
    let file = share_copy(&app, &input, start, end, audio_tracks, CATBOX_MAX_MB).await?;
    let result = upload_catbox(&app, &file).await;
    let _ = std::fs::remove_file(&file);
    let url = result?;
    crate::logs::line(&format!("shared to catbox: {url}"));
    remember(&app, &input, ShareLink { host: "catbox".into(), url: url.clone(), start, end, at: now_secs() });
    let _ = copy_text_to_clipboard(&url);
    Ok(url)
}

async fn upload_catbox(app: &AppHandle, file: &std::path::Path) -> Result<String, String> {
    use futures_util::StreamExt;

    let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
    let total = bytes.len() as u64;
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "clip.mp4".into());

    // Stream the body in chunks so upload progress can be reported.
    const CHUNK: usize = 256 * 1024;
    let chunks: Vec<Vec<u8>> = bytes.chunks(CHUNK).map(<[u8]>::to_vec).collect();
    let progress_app = app.clone();
    let mut sent = 0u64;
    let mut last_pct = u64::MAX;
    let stream = futures_util::stream::iter(chunks).map(move |chunk| {
        sent += chunk.len() as u64;
        let pct = sent * 100 / total.max(1);
        if pct != last_pct {
            last_pct = pct;
            let _ = progress_app.emit("export-progress", serde_json::json!({ "label": "upload", "pct": pct }));
        }
        Ok::<_, std::io::Error>(chunk)
    });
    let part = reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream), total)
        .file_name(name)
        .mime_str("video/mp4")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("reqtype", "fileupload")
        .part("fileToUpload", part);

    let client = reqwest::Client::builder()
        .user_agent(concat!("ClipForge/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post("https://catbox.moe/user/api.php")
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Upload to catbox.moe failed: {e}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let url = body.trim();
    if status.is_success() && url.starts_with("https://") {
        Ok(url.to_string())
    } else {
        Err(format!(
            "catbox.moe didn't accept the upload ({status}): {}",
            if url.is_empty() { "no response" } else { url }
        ))
    }
}

/// Prepare the selection for Streamable: encode it, open streamable.com,
/// highlight the file in Explorer. Returns the prepared file's path.
#[tauri::command]
pub async fn share_streamable(
    app: AppHandle,
    input: String,
    start: f64,
    end: f64,
    audio_tracks: Option<Vec<(u32, f32)>>,
) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let file = share_copy(&app, &input, start, end, audio_tracks, STREAMABLE_MAX_MB).await?;
    let path = file.to_string_lossy().replace('\\', "/");
    crate::clips::show_in_folder(path.clone())?;
    app.opener()
        .open_url("https://streamable.com/", None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(path)
}

/// Remember a link pasted back from Streamable, so it shows with the clip.
#[tauri::command]
pub fn save_share_link(app: AppHandle, input: String, host: String, url: String, start: f64, end: f64) -> Result<(), String> {
    let url = url.trim();
    if !url.starts_with("https://") {
        return Err("That doesn't look like a link.".into());
    }
    remember(&app, &input, ShareLink { host, url: url.to_string(), start, end, at: now_secs() });
    Ok(())
}

#[tauri::command]
pub fn copy_link(url: String) -> Result<(), String> {
    copy_text_to_clipboard(&url)
}

fn copy_text_to_clipboard(text: &str) -> Result<(), String> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_UNICODETEXT;

    let wide: Vec<u16> = text.encode_utf16().chain([0u16]).collect();
    unsafe {
        let hglobal = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2).map_err(|e| e.to_string())?;
        let ptr = GlobalLock(hglobal) as *mut u16;
        if ptr.is_null() {
            return Err("GlobalLock failed".into());
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
        let _ = GlobalUnlock(hglobal);
        OpenClipboard(None).map_err(|e| e.to_string())?;
        let _ = EmptyClipboard();
        let result = SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(hglobal.0)));
        let _ = CloseClipboard();
        result.map_err(|e| e.to_string())?;
    }
    Ok(())
}
