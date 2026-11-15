// The preview proxy: a browser-friendly copy of the source for the in-app player.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// The preview cache holds a near-source-size transcode per imported video and is
/// pure regenerable cache, so it must never grow unbounded: every import adds a
/// file and nothing used to delete one. 5 GiB keeps dozens of projects' previews
/// while bounding the disk leak the production audit called out.
const PREVIEW_CACHE_CAP_BYTES: u64 = 5 * 1024 * 1024 * 1024;

/// LRU eviction for the preview cache: removes oldest-modified `*.mp4` entries
/// until the directory fits the cap. Best effort — a file that cannot be deleted
/// (e.g. the webview is playing it on Windows) stays and the rest still evict.
pub(crate) fn enforce_preview_cache_quota(cache_dir: &Path) {
    enforce_preview_cache_quota_at(cache_dir, PREVIEW_CACHE_CAP_BYTES);
}

pub(crate) fn enforce_preview_cache_quota_at(cache_dir: &Path, cap_bytes: u64) {
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return; // nothing cached yet (or the dir vanished): nothing to evict
    };
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().is_some_and(|ext| ext == "mp4")
                && !path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().ends_with(".tmp.mp4"))
        })
        .filter_map(|path| {
            let metadata = std::fs::metadata(&path).ok()?;
            Some((
                path.clone(),
                metadata.len(),
                metadata.modified().unwrap_or(UNIX_EPOCH),
            ))
        })
        .collect();
    let total: u64 = files.iter().map(|(_, size, _)| size).sum();
    if total <= cap_bytes {
        return;
    }
    files.sort_by_key(|(_, _, modified)| *modified);
    let mut remaining = total;
    for (path, size, _) in files {
        if remaining <= cap_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            remaining = remaining.saturating_sub(size);
        }
    }
}

use crate::paths::{
    cache_dir, ffmpeg_bin, ffprobe_bin, local_preview_source, preview_proxy_cache_key,
    transcode_preview_proxy,
};

/// The cached proxy path for `source` inside `dir`. Keyed on the source's path,
/// size and mtime so a re-encoded file never reuses a stale proxy. The producer
/// and the discard-time deleter both go through here so they cannot drift.
pub(crate) fn preview_proxy_output(dir: &Path, source: &Path) -> Result<PathBuf, String> {
    let metadata = std::fs::metadata(source).map_err(|e| format!("INPUT_PATH:{e}"))?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let key = preview_proxy_cache_key(source, metadata.len(), modified_nanos);
    Ok(dir.join(format!("{key}.mp4")))
}

/// Drops the cached proxy for `source`, reporting whether one existed. The proxy
/// is shared by every highlight of one source, so callers only invoke this once
/// no active candidate is left; a missing file is a no-op, not an error.
pub(crate) fn remove_preview_proxy(dir: &Path, source: &Path) -> Result<bool, String> {
    match std::fs::remove_file(preview_proxy_output(dir, source)?) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("PREVIEW_CACHE_DELETE:{error}")),
    }
}

#[tauri::command]
pub(crate) async fn prepare_video_preview(
    app: tauri::AppHandle,
    path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = local_preview_source(&path)?;
        let cache_dir = cache_dir().join("preview-cache");
        std::fs::create_dir_all(&cache_dir).map_err(|e| format!("PREVIEW_CACHE:{e}"))?;
        let output = preview_proxy_output(&cache_dir, &source)?;
        if output.is_file() {
            return Ok(output.to_string_lossy().into_owned());
        }
        // `{key}.{pid}.tmp.mp4` next to the final file, so publishing is a rename.
        let temporary = output.with_extension(format!("{}.tmp.mp4", std::process::id()));
        transcode_preview_proxy(&ffmpeg_bin(&app), &ffprobe_bin(&app), &source, &temporary)?;
        std::fs::rename(&temporary, &output).map_err(|e| {
            let _ = std::fs::remove_file(&temporary);
            format!("PREVIEW_CACHE_PUBLISH:{e}")
        })?;
        enforce_preview_cache_quota(&cache_dir);
        Ok(output.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("PREVIEW_WORKER:{error}"))?
}

/// Deletes the cached preview for a local source once its last candidate is
/// discarded. Regenerable, so a failure here must not block the discard; the
/// command reports whether a cached file was actually removed.
#[tauri::command]
pub(crate) fn delete_video_preview(path: String) -> Result<bool, String> {
    let source = local_preview_source(&path)?;
    remove_preview_proxy(&cache_dir().join("preview-cache"), &source)
}
