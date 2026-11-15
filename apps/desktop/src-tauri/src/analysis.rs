// The analysis branch: starting a job, spawning the Node worker, polling its status
// and cancelling it.
//
// The worker lifecycle (pid registry, process-group kill) lives here because it is
// only ever driven from the analysis commands.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::analysis_store::{job_with_result, read_status, AnalysisStore, MAX_JOB_ATTEMPTS};
use crate::contracts::AnalysisStatus;
use crate::paths::NODE_ARGS;
use crate::paths::{
    analysis_range_allowed, app_render_temp_dir, ffmpeg_bin, helper_env, helper_script,
    is_remote_input, jobs_path, node_bin, probe_duration, runtime_env, tool, venv_python,
};
use crate::runtime::storage;
use crate::youtube::{configured_cookie_args, remote_route, RemoteRoute};
use crate::{guard_pro_features, io_error};

pub(crate) static ANALYSIS_RUNNING: AtomicBool = AtomicBool::new(false);
const YOUTUBE_AUDIO_FALLBACK_REQUIRED: &str = "YOUTUBE_AUDIO_FALLBACK_REQUIRED";

/// Pids of analysis workers that are still running, keyed by job id so a cancel can
/// find the process Rust itself spawned (the DB copy is written by the worker and may
/// not exist yet) and an app exit can take down the whole tree.
pub(crate) static ANALYSIS_WORKERS: LazyLock<Mutex<HashMap<String, u32>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) struct RunningGuard(pub(crate) &'static AtomicBool);

pub(crate) struct AnalysisAudioCleanup {
    cleanup_path: Option<PathBuf>,
    audio_path: Option<PathBuf>,
}

impl AnalysisAudioCleanup {
    fn new(path: Option<PathBuf>) -> Self {
        Self {
            cleanup_path: path.clone(),
            audio_path: path,
        }
    }

    fn remote(directory: PathBuf, audio_path: PathBuf) -> Self {
        Self {
            cleanup_path: Some(directory),
            audio_path: Some(audio_path),
        }
    }

    fn path(&self) -> Option<&Path> {
        self.audio_path.as_deref()
    }
}

impl Drop for AnalysisAudioCleanup {
    fn drop(&mut self) {
        if let Some(path) = self.cleanup_path.take() {
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(path);
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

fn analysis_audio_path(temp_dir: &Path, job_id: &str) -> PathBuf {
    temp_dir.join(format!("analysis-{job_id}-audio.wav"))
}

fn prepare_analysis_audio(
    app: &tauri::AppHandle,
    input: &Path,
    job_id: &str,
) -> Result<AnalysisAudioCleanup, String> {
    let temp_dir = app_render_temp_dir(app).map_err(|e| format!("APP_TEMP_DIR:{e}"))?;
    if is_remote_input(&input.to_string_lossy()) {
        // Caption workers request audio explicitly only after a transcript miss.
        return Ok(AnalysisAudioCleanup::new(None));
    }

    let audio_path = analysis_audio_path(&temp_dir, job_id);
    let cleanup = AnalysisAudioCleanup::new(Some(audio_path.clone()));
    let complete_file = std::fs::metadata(&audio_path).is_ok_and(|metadata| metadata.len() > 44);
    if complete_file {
        return Ok(cleanup);
    }

    let extracted = tool(ffmpeg_bin(app))
        .args(["-y", "-nostdin", "-v", "error", "-i"])
        .arg(input)
        .args(["-vn", "-ac", "1", "-ar", "16000"])
        .arg(&audio_path)
        .status()
        .map_err(|e| format!("ANALYSIS_AUDIO_EXTRACT:{e}"))?;
    if !extracted.success() {
        return Err("ANALYSIS_AUDIO_EXTRACT_FAILED".into());
    }
    Ok(cleanup)
}

fn prepare_remote_analysis_audio(
    app: &tauri::AppHandle,
    input: &Path,
    job_id: &str,
) -> Result<AnalysisAudioCleanup, String> {
    let input_url = input.to_string_lossy();
    if remote_route(&input_url).is_none() {
        return Err("INVALID_PUBLIC_VIDEO_URL".into());
    }
    let temp_dir = app_render_temp_dir(app).map_err(|e| format!("APP_TEMP_DIR:{e}"))?;
    let work_dir = temp_dir.join(format!("analysis-{job_id}-remote-audio"));
    if work_dir.exists() {
        std::fs::remove_dir_all(&work_dir).map_err(|e| format!("ANALYSIS_AUDIO_STALE:{e}"))?;
    }
    std::fs::create_dir(&work_dir).map_err(|e| format!("ANALYSIS_AUDIO_TEMP:{e}"))?;
    let audio_path = analysis_audio_path(&work_dir, job_id);
    let cleanup = AnalysisAudioCleanup::remote(work_dir.clone(), audio_path.clone());
    let result = (|| -> Result<(), String> {
        let python = venv_python();
        if !python.is_file() {
            return Err("PYTHON_VENV_MISSING: remote links need the app Python environment — click \"Setup Whisper\" in Settings to prepare it".into());
        }
        let template = work_dir.join("source.%(ext)s");
        let cookies =
            configured_cookie_args().map_err(|e| format!("ANALYSIS_AUDIO_DOWNLOAD:{e}"))?;
        let output = tool(&python)
            .args([
                "-I",
                "-m",
                "yt_dlp",
                "--no-playlist",
                "-f",
                // Facebook often only offers a muxed format, so fall back to "best".
                "bestaudio/best",
                "-o",
            ])
            .args(&cookies)
            .arg(&template)
            .arg(input)
            .output()
            .map_err(|e| format!("ANALYSIS_AUDIO_DOWNLOAD:{e}"))?;
        if !output.status.success() {
            return Err(format!(
                "ANALYSIS_AUDIO_DOWNLOAD:{}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let source = std::fs::read_dir(&work_dir)
            .map_err(|e| format!("ANALYSIS_AUDIO_READ:{e}"))?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.is_file())
            .ok_or("ANALYSIS_AUDIO_DOWNLOAD_EMPTY")?;
        let extracted = tool(ffmpeg_bin(app))
            .args(["-y", "-nostdin", "-v", "error", "-i"])
            .arg(source)
            .args(["-vn", "-ac", "1", "-ar", "16000", "-f", "wav"])
            .arg(&audio_path)
            .status()
            .map_err(|e| format!("ANALYSIS_AUDIO_EXTRACT:{e}"))?;
        if !extracted.success()
            || std::fs::metadata(&audio_path).map(|m| m.len()).unwrap_or(0) <= 44
        {
            return Err("ANALYSIS_AUDIO_EXTRACT_FAILED".into());
        }
        Ok(())
    })();
    if let Err(error) = result {
        drop(cleanup);
        return Err(error);
    }
    Ok(cleanup)
}

fn existing_analysis_audio_path_in(temp_dir: &Path, job_id: &str) -> Option<PathBuf> {
    let local = analysis_audio_path(temp_dir, job_id);
    if local.is_file() {
        return Some(local);
    }
    let remote_dir = temp_dir.join(format!("analysis-{job_id}-remote-audio"));
    let remote = analysis_audio_path(&remote_dir, job_id);
    remote.is_file().then_some(remote)
}

fn remove_existing_analysis_audio(app: &tauri::AppHandle, job_id: &str) {
    if let Ok(temp_dir) = app_render_temp_dir(app) {
        let remote_dir = temp_dir.join(format!("analysis-{job_id}-remote-audio"));
        let _ = std::fs::remove_dir_all(remote_dir);
        let _ = std::fs::remove_file(analysis_audio_path(&temp_dir, job_id));
    }
}

fn set_analysis_audio_env(command: &mut std::process::Command, audio_path: Option<&Path>) {
    command.env_remove("ANALYSIS_PREEXTRACTED_AUDIO");
    if let Some(path) = audio_path {
        command.env("ANALYSIS_PREEXTRACTED_AUDIO", path);
    }
}

pub(crate) type Jobs = Arc<Mutex<HashMap<String, AnalysisStatus>>>;

#[tauri::command]
pub(crate) fn preflight_analyze(path: String) -> Result<serde_json::Value, String> {
    let input = Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("INPUT_PATH:{e}"))?;
    if !input.is_file() {
        return Err("INPUT_NOT_FILE".into());
    }
    let result = storage(
        input.parent().unwrap_or(Path::new("/")),
        2 * 1024 * 1024 * 1024u64,
    );
    if !result["ready"].as_bool().unwrap_or(false) {
        return Err("STORAGE_FULL:analysis requires at least 2 GiB free".into());
    }
    Ok(result)
}

#[tauri::command]
pub(crate) fn start_analysis(
    app: tauri::AppHandle,
    jobs: tauri::State<'_, Jobs>,
    path: String,
    start: Option<f64>,
    end: Option<f64>,
) -> Result<String, String> {
    let file = runtime_env();
    let whisper_model = file
        .get("WHISPER_MODEL")
        .cloned()
        .unwrap_or_else(|| "tiny".into());
    let whisper_device = file
        .get("WHISPER_DEVICE")
        .cloned()
        .unwrap_or_else(|| "cpu".into());
    guard_pro_features(&whisper_model, &whisper_device)?;
    let input = Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("INPUT_PATH:{e}"))?;
    if !input.is_file() {
        return Err("INPUT_NOT_FILE".into());
    }
    let id = format!(
        "analysis-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "CLOCK_ERROR")?
            .as_nanos()
    );
    let duration = probe_duration(&app, &input)?;
    let range_start = start.unwrap_or(0.0);
    let range_end = end.unwrap_or(duration);
    let init_script = helper_script(&app, "analysis-init.ts")?;
    if !analysis_range_allowed(range_start, range_end) || range_end > duration {
        return Err(if range_end - range_start > 1800.0 {
            "ANALYZE_RANGE_EXCEEDS_1800_SECONDS: select a range of 30 minutes or less".into()
        } else {
            "INVALID_ANALYZE_RANGE".into()
        });
    }

    // Decode the source audio once into the app-private temp dir. Rust-side AI commands
    // and the worker both consume the same WAV through ANALYSIS_PREEXTRACTED_AUDIO.
    let audio_cleanup = prepare_analysis_audio(&app, &input, &id)?;
    let audio_path = audio_cleanup.path();

    let mut init = tool(node_bin(&app));
    init.args(NODE_ARGS)
        .arg(init_script)
        .arg(jobs_path())
        .arg(&id)
        .arg(&input)
        .arg(format!("{duration:.3}"))
        .arg(format!("{range_start:.3}"))
        .arg(format!("{range_end:.3}"));
    for (key, value) in helper_env(&app, &[]) {
        init.env(key, value);
    }
    set_analysis_audio_env(&mut init, audio_path);
    let init = init.output().map_err(|e| format!("STORE_INIT:{e}"))?;
    if !init.status.success() {
        return Err(String::from_utf8_lossy(&init.stderr).trim().to_owned());
    }
    if !spawn_analysis_worker_with_audio(
        app.clone(),
        jobs.inner().clone(),
        id.clone(),
        input,
        duration,
        range_start,
        range_end,
        audio_cleanup,
    ) {
        let _ =
            AnalysisStore::open(&jobs_path()).and_then(|store| store.fail(&id, "ANALYSIS_BUSY"));
        return Err("ANALYSIS_BUSY: another analysis is already running".into());
    }
    Ok(id)
}

/// Spawns the Node analysis worker for `job_id`. The worker owns SQLite state updates;
/// this only guards against duplicate workers for the same job.
pub(crate) fn spawn_analysis_worker(
    app: tauri::AppHandle,
    jobs: Jobs,
    job_id: String,
    input: PathBuf,
    duration: f64,
    range_start: f64,
    range_end: f64,
) -> bool {
    if ANALYSIS_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return false;
    }
    let slot = RunningGuard(&ANALYSIS_RUNNING);
    let audio_cleanup = match prepare_analysis_audio(&app, &input, &job_id) {
        Ok(cleanup) => cleanup,
        Err(error) => {
            let _ = AnalysisStore::open(&jobs_path()).and_then(|store| store.fail(&job_id, &error));
            drop(slot);
            return false;
        }
    };
    spawn_analysis_worker_reserved(
        app,
        jobs,
        job_id,
        input,
        duration,
        range_start,
        range_end,
        slot,
        audio_cleanup,
    )
}

fn spawn_analysis_worker_with_audio(
    app: tauri::AppHandle,
    jobs: Jobs,
    job_id: String,
    input: PathBuf,
    duration: f64,
    range_start: f64,
    range_end: f64,
    audio_cleanup: AnalysisAudioCleanup,
) -> bool {
    if ANALYSIS_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return false;
    }
    spawn_analysis_worker_reserved(
        app,
        jobs,
        job_id,
        input,
        duration,
        range_start,
        range_end,
        RunningGuard(&ANALYSIS_RUNNING),
        audio_cleanup,
    )
}

pub(crate) fn spawn_analysis_worker_reserved(
    app: tauri::AppHandle,
    jobs: Jobs,
    job_id: String,
    input: PathBuf,
    duration: f64,
    range_start: f64,
    range_end: f64,
    slot: RunningGuard,
    audio_cleanup: AnalysisAudioCleanup,
) -> bool {
    {
        let mut all = match jobs.lock() {
            Ok(all) => all,
            Err(_) => return false,
        };
        all.insert(
            job_id.clone(),
            AnalysisStatus {
                status: "running".into(),
                phase: "probe".into(),
                progress: 0.02,
                result: None,
                error: None,
                chunk_completed: 0,
                chunk_total: 0,
                current_chunk: None,
            },
        );
    }
    thread::spawn(move || {
        let _slot = slot;
        let run = (|| -> Result<String, String> {
            let route = remote_route(&input.to_string_lossy());
            if is_remote_input(&input.to_string_lossy()) && route.is_none() {
                return Err("INVALID_PUBLIC_VIDEO_URL".into());
            }
            // Facebook/TikTok expose no caption track: download the audio (yt-dlp →
            // 16 kHz mono WAV) and hand it to the same Whisper worker local files use.
            // The guard deletes the download when this worker thread finishes.
            let remote_audio = match route {
                Some(RemoteRoute::Audio) => {
                    Some(prepare_remote_analysis_audio(&app, &input, &job_id)?)
                }
                _ => None,
            };
            let mut cmd = tool(node_bin(&app));
            if matches!(route, Some(RemoteRoute::Captions)) {
                // YouTube URL: text-only pipeline (captions via crawler), no Whisper chunks.
                let python = venv_python();
                if !python.is_file() {
                    // Local files still work in this state; only YouTube links need
                    // the app venv (yt-dlp + youtube-transcript-api).
                    return Err("PYTHON_VENV_MISSING: YouTube links need the app Python environment — click \"Setup Whisper\" in Settings to prepare it".into());
                }
                cmd.args(NODE_ARGS)
                    .arg(helper_script(&app, "analyze-youtube.ts")?)
                    .arg(&input)
                    .arg(format!("{duration:.3}"))
                    .arg(&job_id)
                    .arg(jobs_path())
                    .env("YT_PYTHON", &python)
                    .env("YT_CRAWLER", helper_script(&app, "yt-crawler.py")?);
            } else {
                let script = helper_script(&app, "analyze-video.ts")?;
                // A downloaded remote WAV replaces the input path as the media file;
                // the artifact id stays the original URL so the result points at it.
                let media_path = remote_audio
                    .as_ref()
                    .and_then(|cleanup| cleanup.path())
                    .unwrap_or(input.as_path());
                cmd.args(NODE_ARGS)
                    .arg(script)
                    .arg(media_path)
                    .arg(input.to_string_lossy().as_ref())
                    .arg(format!("{duration:.3}"))
                    .arg(format!("{range_start:.3}"))
                    .arg(format!("{range_end:.3}"))
                    .arg(&job_id)
                    .arg(jobs_path());
            }
            for (key, value) in helper_env(&app, &[]) {
                cmd.env(key, value);
            }
            set_analysis_audio_env(
                &mut cmd,
                remote_audio
                    .as_ref()
                    .and_then(|cleanup| cleanup.path())
                    .or_else(|| audio_cleanup.path()),
            );
            // BELOW_NORMAL keeps the webview responsive while whisper/ffmpeg saturate
            // the CPU — every grandchild inherits the parent's priority class. Must go
            // through the group builder: its spawn() REPLACES the Command's creation
            // flags (it starts from zero), so any flags set on cmd itself are lost —
            // including tool()'s CREATE_NO_WINDOW, which is re-added here.
            #[cfg(windows)]
            let group_flags = 0x0800_0000 | 0x0000_4000; // CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
                                                         // group_spawn puts the worker in its own process group (Unix) or a Job
                                                         // Object with KILL_ON_JOB_CLOSE (Windows): one kill reaches the whisper
                                                         // and chunk-ffmpeg grandchildren on every platform we ship, and a crashed
                                                         // app can no longer leave an orphaned tree behind.
            crate::spawn_guard::set_parent_death_sig(&mut cmd);
            use command_group::CommandGroup;
            let mut group = cmd.group();
            #[cfg(windows)]
            group.creation_flags(group_flags);
            let child = group.spawn().map_err(|e| io_error("NODE_SPAWN", e))?;
            let worker_pid = child.id();
            register_analysis_worker(&job_id, worker_pid);
            // The GroupChild owns the Windows Job Object, so it must outlive the
            // worker: wait through it (which also drains both pipes) instead of
            // unwrapping it into a plain Child.
            let output = child
                .wait_with_output()
                .map_err(|e| io_error("NODE_WAIT", e));
            unregister_analysis_worker(&job_id);
            let output = output?;
            if !output.status.success() {
                let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                if matches!(route, Some(RemoteRoute::Captions))
                    && message
                        .lines()
                        .any(|line| line.trim() == YOUTUBE_AUDIO_FALLBACK_REQUIRED)
                {
                    let audio_cleanup = prepare_remote_analysis_audio(&app, &input, &job_id)?;
                    let mut retry = tool(node_bin(&app));
                    retry
                        .args(NODE_ARGS)
                        .arg(helper_script(&app, "analyze-youtube.ts")?)
                        .arg(&input)
                        .arg(format!("{duration:.3}"))
                        .arg(&job_id)
                        .arg(jobs_path())
                        .env("YT_PYTHON", venv_python())
                        .env("YT_CRAWLER", helper_script(&app, "yt-crawler.py")?)
                        .env("YOUTUBE_AUDIO_FALLBACK_ONLY", "1");
                    for (key, value) in helper_env(&app, &[]) {
                        retry.env(key, value);
                    }
                    set_analysis_audio_env(&mut retry, audio_cleanup.path());
                    crate::spawn_guard::set_parent_death_sig(&mut retry);
                    let mut retry_group = retry.group();
                    #[cfg(windows)]
                    retry_group.creation_flags(group_flags);
                    let retry_child = retry_group.spawn().map_err(|e| io_error("NODE_SPAWN", e))?;
                    register_analysis_worker(&job_id, retry_child.id());
                    let retry_output = retry_child
                        .wait_with_output()
                        .map_err(|e| io_error("NODE_WAIT", e));
                    unregister_analysis_worker(&job_id);
                    let retry_output = retry_output?;
                    if !retry_output.status.success() {
                        return Err(String::from_utf8_lossy(&retry_output.stderr)
                            .trim()
                            .to_owned());
                    }
                    return String::from_utf8(retry_output.stdout)
                        .map_err(|e| format!("ANALYZE_OUTPUT:{e}"));
                }
                return Err(message);
            }
            Ok(String::from_utf8(output.stdout).map_err(|e| format!("ANALYZE_OUTPUT:{e}"))?)
        })();
        let _audio_cleanup = audio_cleanup;
        if let Ok(mut all) = jobs.lock() {
            if let Some(job) = all.get_mut(&job_id) {
                if job.status != "cancelled" {
                    match run {
                        Ok(result) => match serde_json::from_str(&result) {
                            Ok(value) => {
                                job.status = "completed".into();
                                job.phase = "completed".into();
                                job.progress = 1.0;
                                job.result = Some(value);
                            }
                            Err(error) => {
                                job.status = "failed".into();
                                job.phase = "failed".into();
                                job.error = Some(format!("ANALYSIS_RESULT_JSON:{error}"));
                            }
                        },
                        Err(error) => {
                            job.status = "failed".into();
                            job.phase = "failed".into();
                            job.error = Some(error);
                        }
                    }
                }
            }
        }
    });
    true
}

/// Resumes durable queued jobs left behind by a crash or restart.
///
/// Mirrors the status script's `--resumable` claim: a running job whose worker pid
/// is gone (or a queued job with no live worker) counts one crash against its
/// budget and is requeued, until the budget (`MAX_JOB_ATTEMPTS`) runs out.
pub(crate) fn resume_queued_jobs(app: tauri::AppHandle, jobs: Jobs) {
    let Ok(store) = AnalysisStore::open(&jobs_path()) else {
        return;
    };
    let Ok(all) = store.all_jobs() else { return };
    // Claim: bump the crash budget; a job that keeps dying without progress stops
    // being auto-resumed until the user retries it manually.
    let claim = |store: &AnalysisStore, job: &serde_json::Value| -> Option<serde_json::Value> {
        let id = job["id"].as_str()?;
        let attempts = store.bump_attempts(id).ok()?;
        if attempts >= MAX_JOB_ATTEMPTS {
            let _ = store.fail(
                id,
                &format!("worker died {attempts} times without progress; retry manually"),
            );
            return None;
        }
        store.mark_worker_lost(id).ok()?;
        store.get(id).ok().flatten()
    };
    let alive = |store: &AnalysisStore, job: &serde_json::Value| -> bool {
        store
            .worker_pid(job["id"].as_str().unwrap_or(""))
            .ok()
            .flatten()
            .map(|pid| process_alive(pid.max(0) as u32))
            .unwrap_or(false)
    };
    for job in all.iter() {
        if job["status"] == "running" && !alive(&store, job) {
            if claim(&store, job).is_none() {
                if let Some(id) = job["id"].as_str() {
                    remove_existing_analysis_audio(&app, id);
                }
            }
        }
    }
    let Ok(queued) = store.all_jobs() else { return };
    for job in queued.iter().filter(|job| job["status"] == "queued") {
        if alive(&store, job) {
            continue;
        }
        let Some(claimed) = claim(&store, job) else {
            if let Some(id) = job["id"].as_str() {
                remove_existing_analysis_audio(&app, id);
            }
            continue;
        };
        let Some(id) = claimed["id"].as_str() else {
            continue;
        };
        let Some(input) = claimed["input"].as_str() else {
            remove_existing_analysis_audio(&app, id);
            continue;
        };
        let duration = claimed["duration"].as_f64().unwrap_or(0.0);
        if duration <= 0.0 {
            let _ = store.fail(id, "invalid job duration");
            remove_existing_analysis_audio(&app, id);
            continue;
        }
        let path = PathBuf::from(input);
        if is_remote_input(input) && remote_route(input).is_none() {
            let _ = store.fail(id, "INVALID_PUBLIC_VIDEO_URL");
            remove_existing_analysis_audio(&app, id);
            continue;
        }
        if !is_remote_input(input) && !path.is_file() {
            let _ = store.fail(id, "input file missing");
            remove_existing_analysis_audio(&app, id);
            continue;
        }
        let range_start = claimed["rangeStart"].as_f64().unwrap_or(0.0);
        let range_end = claimed["rangeEnd"]
            .as_f64()
            .filter(|end| *end > range_start)
            .unwrap_or(duration);
        if !spawn_analysis_worker(
            app.clone(),
            jobs.clone(),
            id.to_string(),
            path,
            duration,
            range_start,
            range_end,
        ) {
            break;
        }
    }
}

#[tauri::command]
pub(crate) fn analysis_status(
    _app: tauri::AppHandle,
    _jobs: tauri::State<'_, Jobs>,
    id: String,
) -> Result<AnalysisStatus, String> {
    read_status(&id)
}

#[tauri::command]
pub(crate) fn list_analysis_jobs(_app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let store = AnalysisStore::open(&jobs_path())?;
    Ok(serde_json::Value::Array(store.all_jobs()?))
}

/// Clears the crash budget and requeues failed chunks, then restarts the worker.
#[tauri::command]
pub(crate) fn retry_analysis(
    app: tauri::AppHandle,
    jobs: tauri::State<'_, Jobs>,
    id: String,
) -> Result<serde_json::Value, String> {
    let file = runtime_env();
    let whisper_model = file
        .get("WHISPER_MODEL")
        .cloned()
        .unwrap_or_else(|| "tiny".into());
    let whisper_device = file
        .get("WHISPER_DEVICE")
        .cloned()
        .unwrap_or_else(|| "cpu".into());
    guard_pro_features(&whisper_model, &whisper_device)?;
    if let Ok(all) = jobs.lock() {
        if all.get(&id).is_some_and(|job| job.status == "running") {
            return Err("ANALYSIS_ALREADY_RUNNING: job already has a worker".into());
        }
    } else {
        return Err("ANALYSIS_STATE_LOCK_POISONED".into());
    }
    if ANALYSIS_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("ANALYSIS_BUSY: another analysis is already running".into());
    }
    let slot = RunningGuard(&ANALYSIS_RUNNING);
    let store = AnalysisStore::open(&jobs_path())?;
    if !store.retry(&id)? {
        return Err("JOB_NOT_RETRYABLE: only failed jobs can be retried".into());
    }
    let job = store.get(&id)?.ok_or("JOB_NOT_FOUND")?;
    let (Some(input), Some(duration)) = (job["input"].as_str(), job["duration"].as_f64()) else {
        return Err("JOB_NOT_FOUND".into());
    };
    let path = PathBuf::from(input);
    if is_remote_input(input) && remote_route(input).is_none() {
        let _ = store.fail(&id, "INVALID_PUBLIC_VIDEO_URL");
        return Err("INVALID_PUBLIC_VIDEO_URL".into());
    }
    if !is_remote_input(input) && !path.is_file() {
        let _ = store.fail(&id, "input file missing");
        return Err("INPUT_NOT_FILE".into());
    }
    let range_start = job["rangeStart"].as_f64().unwrap_or(0.0);
    let range_end = job["rangeEnd"].as_f64().unwrap_or(duration);
    let audio_cleanup = if is_remote_input(input) {
        AnalysisAudioCleanup::new(None)
    } else {
        match prepare_analysis_audio(&app, &path, &id) {
            Ok(cleanup) => cleanup,
            Err(error) => {
                let _ = store.fail(&id, &error);
                return Err(error);
            }
        }
    };
    if !spawn_analysis_worker_reserved(
        app.clone(),
        jobs.inner().clone(),
        id.clone(),
        path,
        duration,
        range_start,
        range_end,
        slot,
        audio_cleanup,
    ) {
        return Err("ANALYSIS_ALREADY_RUNNING: job already has a worker".into());
    }
    Ok(job)
}

/// Stops a job from being auto-resumed without deleting its transcript cache.
#[tauri::command]
pub(crate) fn abandon_analysis(
    _app: tauri::AppHandle,
    id: String,
) -> Result<serde_json::Value, String> {
    let store = AnalysisStore::open(&jobs_path())?;
    store.fail(&id, "abandoned by user")?;
    Ok(store.get(&id)?.unwrap_or(serde_json::Value::Null))
}

/// Kills the analysis worker for a job and marks it cancelled cleanly (user abort).
#[tauri::command]
pub(crate) fn stop_analysis(
    _app: tauri::AppHandle,
    id: String,
) -> Result<serde_json::Value, String> {
    let store = AnalysisStore::open(&jobs_path())?;
    // Prefer the pid Rust spawned (authoritative); fall back to the worker's own
    // record for a job started by a previous app run.
    let spawned = ANALYSIS_WORKERS
        .lock()
        .ok()
        .and_then(|guard| guard.get(&id).copied());
    let recorded = store
        .worker_pid(&id)?
        .filter(|pid| *pid > 0)
        .map(|pid| pid as u32);
    for pid in spawned.into_iter().chain(recorded) {
        kill_analysis_worker(pid);
    }
    store.cancel(&id)?;
    job_with_result(&store, &id)?.ok_or_else(|| "JOB_NOT_FOUND".into())
}

/// Stops the detached llama-server and RAG sidecar processes, if running.
/// Terminates an analysis worker and everything it spawned.
///
/// Three prongs on purpose, because each has failed in the field on its own: the
/// negative pid reaches the worker's whole process group (whisper, chunk ffmpeg), the
/// bare pid covers a worker that never became a group leader, and the delayed SIGKILL
/// covers a worker whose signal handler only records the request and keeps running.
pub(crate) fn kill_analysis_worker(pid: u32) {
    #[cfg(unix)]
    {
        // The worker runs in its own process group, so the negative pid reaches the
        // whole tree. TERM first, with a delayed KILL as the enforcement backstop.
        let group = format!("-{pid}");
        let bare = pid.to_string();
        let signal = |name: &str, target: &str| {
            for candidate in ["/usr/bin/kill", "/bin/kill", "kill"] {
                if tool(candidate).args([name, target]).status().is_ok() {
                    return;
                }
            }
        };
        signal("-TERM", &group);
        signal("-TERM", &bare);
        thread::spawn(move || {
            thread::sleep(std::time::Duration::from_secs(3));
            if process_alive(pid) {
                signal("-KILL", &group);
                signal("-KILL", &bare);
            }
        });
    }
    #[cfg(windows)]
    {
        // The worker runs inside a Job Object, but this call site only has the pid:
        // taskkill's /T walks the full child tree (whisper, ffmpeg grandchildren) and
        // /F forces it — there is no graceful TERM for a detached tree on Windows.
        let _ = tool("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .status();
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
    }
}

pub(crate) fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        tool("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        // tasklist prints the pid row while the process exists; a filtered empty
        // table means it is gone.
        tool("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}

/// Drains the registry on a clean exit: no analysis worker (or its children) outlives
/// the app.
pub(crate) fn stop_analysis_workers() {
    let entries = ANALYSIS_WORKERS
        .lock()
        .map(|mut guard| guard.drain().collect::<Vec<_>>())
        .unwrap_or_default();
    for (_, pid) in entries {
        kill_analysis_worker(pid);
    }
}

#[cfg(test)]
mod audio_lifecycle_tests {
    use super::*;

    #[test]
    fn analysis_audio_path_is_job_scoped() {
        let temp = Path::new("/private/tmp");
        assert_eq!(
            analysis_audio_path(temp, "job-123"),
            PathBuf::from("/private/tmp/analysis-job-123-audio.wav")
        );
    }

    #[test]
    fn existing_analysis_audio_path_only_returns_existing_files() {
        let temp = std::env::temp_dir().join(format!("analysis-audio-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();
        let audio = analysis_audio_path(&temp, "job-123");

        assert_eq!(existing_analysis_audio_path_in(&temp, "job-123"), None);
        let remote_dir = temp.join("analysis-job-123-remote-audio");
        std::fs::create_dir_all(&remote_dir).unwrap();
        let remote = analysis_audio_path(&remote_dir, "job-123");
        std::fs::write(&remote, b"wav").unwrap();
        assert_eq!(
            existing_analysis_audio_path_in(&temp, "job-123"),
            Some(remote.clone())
        );
        std::fs::remove_dir_all(&remote_dir).unwrap();

        std::fs::write(&audio, b"wav").unwrap();
        assert_eq!(
            existing_analysis_audio_path_in(&temp, "job-123"),
            Some(audio.clone())
        );

        std::fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn audio_cleanup_removes_owned_file_on_drop() {
        let temp =
            std::env::temp_dir().join(format!("analysis-audio-cleanup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();
        let audio = analysis_audio_path(&temp, "job-123");
        std::fs::write(&audio, b"wav").unwrap();

        {
            let cleanup = AnalysisAudioCleanup::new(Some(audio.clone()));
            assert_eq!(cleanup.path(), Some(audio.as_path()));
            assert!(audio.is_file());
        }

        assert!(!audio.exists());
        std::fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn worker_audio_env_sets_and_clears_preextracted_audio() {
        let audio = Path::new("/private/tmp/analysis-job-123-audio.wav");
        let mut command = std::process::Command::new("worker");
        set_analysis_audio_env(&mut command, Some(audio));
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == "ANALYSIS_PREEXTRACTED_AUDIO"),
            Some((
                std::ffi::OsStr::new("ANALYSIS_PREEXTRACTED_AUDIO"),
                Some(audio.as_os_str())
            ))
        );

        set_analysis_audio_env(&mut command, None);
        assert!(command
            .get_envs()
            .any(|(key, value)| key == "ANALYSIS_PREEXTRACTED_AUDIO" && value.is_none()));
    }
}

/// Registers a worker so cancel/exit can reach it, and returns a guard that removes it.
pub(crate) fn register_analysis_worker(job_id: &str, pid: u32) {
    if let Ok(mut guard) = ANALYSIS_WORKERS.lock() {
        guard.insert(job_id.to_string(), pid);
    }
}

pub(crate) fn unregister_analysis_worker(job_id: &str) {
    if let Ok(mut guard) = ANALYSIS_WORKERS.lock() {
        guard.remove(job_id);
    }
}
