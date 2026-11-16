// The render engine: the one place that turns a RenderPlan into FFmpeg arguments.
//
// Both front doors — the desktop app and the headless CLI — call `render_segments`
// here, so there is exactly one final renderer (ADR-001: "FFmpeg là final renderer
// authoritative", "Một final renderer"). The engine knows nothing about Tauri: the
// caller supplies the progress sink and the cancel flag.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::contracts::RenderProgress;
use crate::process::tool;

/// Where the engine reports render progress. The app forwards this to the webview
/// channel; the CLI prints it. The engine itself never talks to a UI.
pub trait ProgressSink: Send + Sync {
    fn report(&self, progress: RenderProgress);
}

impl<F> ProgressSink for F
where
    F: Fn(RenderProgress) + Send + Sync,
{
    fn report(&self, progress: RenderProgress) {
        self(progress);
    }
}

/// Set while a render is being asked to stop; the FFmpeg child checks it while running.
pub static RENDER_CANCELLED: AtomicBool = AtomicBool::new(false);
/// The FFmpeg child currently running, so a cancel can kill it.
pub static ACTIVE_RENDER_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);

/// FFmpeg's `-progress` file logs how much of the input it has encoded so far
/// (`out_time_us=`), which turns a render into a smooth 0→100 ramp instead of a single
/// jump when the child exits.
pub fn render_fraction(path: &Path, span_seconds: f64) -> Option<f64> {
    // `!(x > 0.0)` rather than `x <= 0.0`: the negated form also rejects NaN.
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    if !(span_seconds > 0.0) {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let encoded = text.lines().rev().find_map(|line| {
        line.strip_prefix("out_time_us=")
            .and_then(|value| value.trim().parse::<f64>().ok())
            .map(|micros| micros / 1_000_000.0)
            .or_else(|| {
                line.strip_prefix("out_time_ms=")
                    .and_then(|value| value.trim().parse::<f64>().ok())
                    .map(|millis| millis / 1000.0)
            })
    })?;
    Some((encoded / span_seconds).clamp(0.0, 1.0))
}

/// Spawns one FFmpeg child and watches it until it exits, the cancel flag flips, or it
/// has to be killed. `window` is the (start, end) slice of the overall 0→100 progress
/// this child owns; `span_seconds` is how much source this child encodes, which is what
/// turns FFmpeg's `out_time` into a percentage of that slice. `progress_log` is the path
/// FFmpeg writes `-progress` to, kept inside the app-private temp dir.
pub fn run_render_child(
    command: &mut std::process::Command,
    on_progress: &dyn ProgressSink,
    window: (f64, f64),
    span_seconds: f64,
    phase: &str,
    progress_log: &Path,
) -> Result<(), String> {
    if RENDER_CANCELLED.load(Ordering::SeqCst) {
        on_progress.report(RenderProgress {
            percent: 0.0,
            phase: "cancelled".into(),
            error_code: Some("RENDER_CANCELLED".into()),
        });
        return Err("RENDER_CANCELLED".into());
    }
    let _ = std::fs::remove_file(progress_log);
    let progress_arg = progress_log.to_string_lossy().into_owned();
    command.args(["-progress", progress_arg.as_str()]);
    // Put the child in its own process group so a cancel can kill the whole tree
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        // PR_SET_PDEATHSIG: a SIGKILLed app (OOM killer, force-quit) must not
        // leave this encoding tree running — Drop handlers never run on SIGKILL.
        let app_pid = std::process::id();
        unsafe {
            command.pre_exec(move || {
                const PR_SET_PDEATHSIG: libc::c_int = 1;
                if libc::prctl(PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // Close the fork/prctl race: if the app died in between, die too.
                if libc::getppid() as u32 != app_pid {
                    libc::_exit(1);
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // creation_flags replaces rather than ORs: keep CREATE_NO_WINDOW from tool(),
        // keep the cancel-kill group, and drop to BELOW_NORMAL so encoding doesn't
        // starve the webview's compositor mid-export.
        command.creation_flags(0x0800_0000 | 0x0001_0000 | 0x0000_4000);
    } // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | BELOW_NORMAL_PRIORITY_CLASS
    let child = command.spawn().map_err(|error| {
        on_progress.report(RenderProgress {
            percent: 0.0,
            phase: "error".into(),
            error_code: Some("FFMPEG_SPAWN".into()),
        });
        format!("FFMPEG_SPAWN:{error}")
    })?;
    {
        let mut active = ACTIVE_RENDER_CHILD
            .lock()
            .map_err(|_| "RENDER_STATE_LOCK_POISONED")?;
        *active = Some(child);
    }
    loop {
        if RENDER_CANCELLED.load(Ordering::SeqCst) {
            if let Ok(mut active) = ACTIVE_RENDER_CHILD.lock() {
                if let Some(child) = active.as_mut() {
                    let _ = child.kill();
                }
            }
        }
        let status = {
            let mut active = ACTIVE_RENDER_CHILD
                .lock()
                .map_err(|_| "RENDER_STATE_LOCK_POISONED")?;
            match active.as_mut() {
                Some(child) => child
                    .try_wait()
                    .map_err(|error| format!("FFMPEG_WAIT:{error}"))?,
                None => {
                    on_progress.report(RenderProgress {
                        percent: 0.0,
                        phase: "error".into(),
                        error_code: Some("RENDER_CHILD_MISSING".into()),
                    });
                    return Err("RENDER_CHILD_MISSING".into());
                }
            }
        };
        if let Some(status) = status {
            if let Ok(mut active) = ACTIVE_RENDER_CHILD.lock() {
                active.take();
            }
            if RENDER_CANCELLED.load(Ordering::SeqCst) {
                on_progress.report(RenderProgress {
                    percent: 0.0,
                    phase: "cancelled".into(),
                    error_code: Some("RENDER_CANCELLED".into()),
                });
                return Err("RENDER_CANCELLED".into());
            }
            if !status.success() {
                on_progress.report(RenderProgress {
                    percent: 0.0,
                    phase: "error".into(),
                    error_code: Some("FFMPEG_EXIT".into()),
                });
                return Err(format!("FFMPEG_EXIT:{status}"));
            }
            on_progress.report(RenderProgress {
                percent: window.1,
                phase: phase.to_string(),
                error_code: None,
            });
            return Ok(());
        }
        if let Some(fraction) = render_fraction(&progress_log, span_seconds) {
            let percent = window.0 + fraction * (window.1 - window.0);
            on_progress.report(RenderProgress {
                percent,
                phase: phase.to_string(),
                error_code: None,
            });
        }
        thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// Reads the container duration of a media file with ffprobe.
pub fn probe_duration(ffprobe: &Path, input: &str) -> Result<f64, String> {
    let output = tool(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(input)
        .output()
        .map_err(|e| format!("FFPROBE_SPAWN:{e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .map_err(|_| "INVALID_SOURCE_DURATION".to_string())
}

/// Reads the dimensions of the first video stream with ffprobe.
fn probe_video_dimensions(ffprobe: &Path, input: &str) -> Result<(u32, u32), String> {
    let output = tool(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=s=x:p=0",
        ])
        .arg(input)
        .output()
        .map_err(|error| format!("FFPROBE_SPAWN:{error}"))?;
    if !output.status.success() {
        return Err("SOURCE_DIMENSIONS_UNAVAILABLE".into());
    }
    let dimensions: Vec<u32> = String::from_utf8_lossy(&output.stdout)
        .trim()
        .split('x')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .map_err(|_| "SOURCE_DIMENSIONS_UNAVAILABLE".to_string())?;
    match dimensions.as_slice() {
        [width, height] if *width > 0 && *height > 0 => Ok((*width, *height)),
        _ => Err("SOURCE_DIMENSIONS_UNAVAILABLE".into()),
    }
}

/// True when the media file carries an audio stream; a video without audio gets a
/// synthetic silent track so the output still has an audio stream.
fn audio_present(ffprobe: &Path, media: &[String]) -> bool {
    let index = if media.len() > 1 { 1 } else { 0 };
    let probe = tool(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
        ])
        .arg(&media[index])
        .output()
        .map_err(|e| format!("FFPROBE_SPAWN:{e}"));
    matches!(probe, Ok(probe) if probe.status.success() && !probe.stdout.is_empty())
}

pub fn remapped_captions_for_range(
    captions: Option<&Vec<serde_json::Value>>,
    ranges: &[(f64, f64)],
    index: usize,
    margin_v: u32,
) -> Result<Option<String>, String> {
    let Some(captions) = captions else {
        return Ok(None);
    };
    let (start, end) = ranges[index];
    ass_dialogue(captions, start, end - start, margin_v)
}

pub fn remap_hook(
    hook: &serde_json::Value,
    ranges: &[(f64, f64)],
) -> Result<Vec<(usize, f64, f64)>, String> {
    let start = hook["start"].as_f64().ok_or("INVALID_RENDER_HOOK")?;
    let end = hook["end"].as_f64().ok_or("INVALID_RENDER_HOOK")?;
    if !start.is_finite() || !end.is_finite() || end <= start {
        return Err("INVALID_RENDER_HOOK".into());
    }
    Ok(ranges
        .iter()
        .enumerate()
        .filter_map(|(index, (range_start, range_end))| {
            let from = start.max(*range_start);
            let to = end.min(*range_end);
            (to > from).then_some((index, from - range_start, to - range_start))
        })
        .collect())
}

pub struct TemporarySubtitle(pub PathBuf);

pub struct TemporaryRenderDir(pub PathBuf);

pub fn create_temporary_render_dir(temp_dir: &Path) -> Result<TemporaryRenderDir, String> {
    // Garbage collection: remove old render temp dirs (older than 24h) on each new render.
    // This prevents scratch dirs from accumulating indefinitely after crashes.
    if let Ok(entries) = std::fs::read_dir(temp_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("lfai-render-") && path.is_dir() {
                // Check age by metadata
                if let Ok(meta) = std::fs::metadata(&path) {
                    if let Ok(modified) = meta.modified() {
                        let age = SystemTime::now()
                            .duration_since(modified)
                            .unwrap_or_default();
                        if age.as_secs() > 86400 {
                            let _ = std::fs::remove_dir_all(&path);
                        }
                    }
                }
            }
            // Clean up stale progress log files
            if name.starts_with("local-first-render-progress-") {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    for attempt in 0..100 {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("CLOCK:{e}"))?
            .as_nanos();
        let path = temp_dir.join(format!(
            "lfai-render-{}-{suffix}-{attempt}",
            std::process::id()
        ));
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(TemporaryRenderDir(path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("RENDER_TEMP_CREATE:{error}")),
        }
    }
    Err("RENDER_TEMP_COLLISION".into())
}

pub fn subject_pair_continues(
    previous: &[serde_json::Value],
    current: &[serde_json::Value],
) -> bool {
    if previous.len() != 2 || current.len() != 2 {
        return false;
    }
    let order = |items: &[serde_json::Value]| {
        let mut v = items.to_vec();
        v.sort_by(|a, b| {
            a["x"]
                .as_f64()
                .unwrap_or(0.5)
                .total_cmp(&b["x"].as_f64().unwrap_or(0.5))
        });
        v
    };
    let (a, b) = (order(previous), order(current));
    (0..2).all(|i| {
        let center = |v: &serde_json::Value| {
            (
                v["x"].as_f64().unwrap_or(0.0) + v["width"].as_f64().unwrap_or(0.0) / 2.0,
                v["y"].as_f64().unwrap_or(0.0) + v["height"].as_f64().unwrap_or(0.0) / 2.0,
            )
        };
        let (ax, ay) = center(&a[i]);
        let (bx, by) = center(&b[i]);
        (ax - bx).hypot(ay - by) <= 0.2
    })
}

pub fn stable_subject_pair(samples: &[Vec<serde_json::Value>]) -> Option<[serde_json::Value; 2]> {
    if samples.len() < 3 || samples.iter().any(|sample| sample.len() != 2) {
        return None;
    }
    let ordered: Vec<Vec<serde_json::Value>> = samples
        .iter()
        .map(|sample| {
            let mut values = sample.clone();
            values.sort_by(|a, b| {
                a["x"]
                    .as_f64()
                    .unwrap_or(0.5)
                    .total_cmp(&b["x"].as_f64().unwrap_or(0.5))
            });
            values
        })
        .collect();
    for pair in ordered.windows(2) {
        for (first, second) in pair[0].iter().zip(pair[1].iter()) {
            let center = |b: &serde_json::Value| {
                (
                    b["x"].as_f64().unwrap_or(0.0) + b["width"].as_f64().unwrap_or(0.0) / 2.0,
                    b["y"].as_f64().unwrap_or(0.0) + b["height"].as_f64().unwrap_or(0.0) / 2.0,
                )
            };
            let (ax, ay) = center(first);
            let (bx, by) = center(second);
            if (ax - bx).hypot(ay - by) > 0.2 {
                return None;
            }
        }
    }
    let median = |mut values: Vec<f64>| {
        values.sort_by(f64::total_cmp);
        let middle = values.len() / 2;
        if values.len().is_multiple_of(2) {
            (values[middle - 1] + values[middle]) / 2.0
        } else {
            values[middle]
        }
    };
    let representative = std::array::from_fn(|index| {
        let mut box_value = ordered[0][index].clone();
        for field in ["x", "y", "width", "height", "confidence"] {
            let value = median(
                ordered
                    .iter()
                    .filter_map(|sample| sample[index][field].as_f64())
                    .collect(),
            );
            box_value[field] = serde_json::json!(value);
        }
        box_value
    });
    Some(representative)
}

pub fn side_by_side_graph(
    boxes: &[serde_json::Value],
    post_filters: &[String],
    ratio: &str,
) -> Option<String> {
    if boxes.len() != 2 {
        return None;
    }
    let center = |b: &serde_json::Value| {
        let (x, y, w, h, c) = (
            b["x"].as_f64()?,
            b["y"].as_f64()?,
            b["width"].as_f64()?,
            b["height"].as_f64()?,
            b["confidence"].as_f64()?,
        );
        (x.is_finite()
            && y.is_finite()
            && w.is_finite()
            && h.is_finite()
            && c.is_finite()
            && x >= 0.0
            && y >= 0.0
            && w > 0.0
            && h > 0.0
            && x + w <= 1.0
            && y + h <= 1.0
            && (0.0..=1.0).contains(&c))
        .then_some((x + w / 2.0, y + h / 2.0))
    };
    let centers = [center(&boxes[0])?, center(&boxes[1])?];
    if centers[0].0 >= centers[1].0 {
        return None;
    }
    let (panel_w, panel_h, out_size) = match ratio {
        "1:1" => ("540", "1080", "1080:1080"),
        "16:9" => ("960", "1080", "1920:1080"),
        _ => ("540", "1920", "1080:1920"),
    };
    let mut graph = String::from("[0:v]split=2[lin][rin];");
    for (index, (cx, cy)) in centers.iter().enumerate() {
        let (input, output) = if index == 0 {
            ("lin", "left")
        } else {
            ("rin", "right")
        };
        graph.push_str(&format!("[{input}]crop=ih*{panel_w}/{panel_h}:ih:max(0\\,min(iw-ih*{panel_w}/{panel_h}\\,{cx:.6}*iw-ih*{panel_w}/{panel_h}/2)):max(0\\,min(ih-ih\\,{cy:.6}*ih-ih/2)),scale={panel_w}:{panel_h}[{output}];"));
    }
    graph.push_str(&format!(
        "[left][right]hstack=inputs=2,scale={out_size},setsar=1{}[vout]",
        if post_filters.is_empty() {
            String::new()
        } else {
            format!(",{}", post_filters.join(","))
        }
    ));
    Some(graph)
}

/// A composition layout box must be a normalized 0..1 span with ordered edges.
fn valid_span_box(candidate: &serde_json::Value) -> bool {
    let (Some(left), Some(right), Some(top), Some(bottom)) = (
        candidate["left"].as_f64(),
        candidate["right"].as_f64(),
        candidate["top"].as_f64(),
        candidate["bottom"].as_f64(),
    ) else {
        return false;
    };
    (0.0..=1.0).contains(&left)
        && (0.0..=1.0).contains(&right)
        && left <= right
        && (0.0..=1.0).contains(&top)
        && (0.0..=1.0).contains(&bottom)
        && top <= bottom
}

/// Decodes whether a single plan crop keyframe is usable by the renderer: approved,
/// from the same source artifact, confident, sampled at a finite time, carrying a
/// normalized centre, and still linked to the face it was mapped from.
///
/// The same rule gates the Editor's "manual crop" state, so a keyframe the renderer
/// refuses is also one that must not suppress the automatic composition.
pub fn admits_crop_keyframe(key: &serde_json::Value, plan: Option<&serde_json::Value>) -> bool {
    key["confirmed"].as_bool() == Some(true)
        && key["sourceArtifactId"].as_str()
            == plan.and_then(|value| value["sourceArtifactId"].as_str())
        && key["confidence"]
            .as_f64()
            .is_some_and(|confidence| confidence >= 0.5)
        && key["centerX"]
            .as_f64()
            .is_some_and(|center| (0.0..=1.0).contains(&center))
        && key["time"].as_f64().is_some_and(|time| time.is_finite())
        && key["speakerId"].as_str().is_some_and(|speaker| {
            plan.and_then(|value| value["speakerMap"][speaker].as_str())
                .is_some_and(|face| key["sourceFaceId"].as_str() == Some(face))
        })
}

/// True when the plan carries at least one crop keyframe the renderer will actually
/// use — i.e. the user configured a crop path in the Editor. Automatic composition
/// layouts must never override that path (manual crop takes precedence).
pub fn has_confirmed_crop_keyframes(plan: &serde_json::Value) -> bool {
    plan.get("cropKeyframes")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|items| {
            !items.is_empty()
                && items.len() <= 600
                && items
                    .iter()
                    .any(|key| admits_crop_keyframe(key, Some(plan)))
        })
}

/// A plan that asks for tracking must carry at least one signature the renderer
/// will actually honour. Otherwise the engine silently centre-crops, which is
/// how a speaker can end up on the left edge of a 9:16 export without any error.
pub fn render_crop_mode_is_satisfied(plan: &serde_json::Value) -> bool {
    let mode = plan.get("cropMode").and_then(serde_json::Value::as_str).unwrap_or("track");
    if mode != "track" {
        return true;
    }
    if has_confirmed_crop_keyframes(plan) {
        return true;
    }
    plan.get("compositionLayouts")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|layout| {
                layout["confirmed"].as_bool() == Some(true)
                    && layout["sourceArtifactId"].as_str()
                        == plan.get("sourceArtifactId").and_then(serde_json::Value::as_str)
            })
        })
}

/// Builds the filter graph for a piece covered by a composition layout, mirroring the
/// TypeScript containment solver (packages/media-engine/reframe/containment.ts): the
/// person owns the frame, and a text box widens it only when it contains the subject.
/// The crop is constant for the whole piece — layouts resolve per segment, never
/// per caption cue, so the frame does not shake when subtitles change length.
///
/// Creates a source-space delogo filter for a normalized text box.
///
/// Applying this before crop/scale keeps the same source box valid in both the
/// ordinary `-vf` path and the composition graph (including its blurred split).
fn text_box_delogo_filter(layout: &serde_json::Value, source_size: (u32, u32)) -> Option<String> {
    let text = &layout["textBox"];
    let left = text["left"].as_f64()?;
    let right = text["right"].as_f64()?;
    let top = text["top"].as_f64()?;
    let bottom = text["bottom"].as_f64()?;
    let (width, height) = source_size;
    if width == 0
        || height == 0
        || ![left, right, top, bottom]
            .iter()
            .all(|value| value.is_finite())
        || left < 0.0
        || top < 0.0
        || right > 1.0
        || bottom > 1.0
        || right <= left
        || bottom <= top
    {
        return None;
    }
    // The subject wins over the burn-in: a text box that contains the person would
    // erase the human the render exists to show, so it is left in place. A band that
    // merely overlaps them (a lower third, a title above the head) is still masked.
    let person = &layout["personBox"];
    let contains_person = ["left", "right", "top", "bottom"]
        .iter()
        .all(|field| person[field].is_number())
        && left <= person["left"].as_f64().unwrap_or(0.0)
        && right >= person["right"].as_f64().unwrap_or(0.0)
        && top <= person["top"].as_f64().unwrap_or(0.0)
        && bottom >= person["bottom"].as_f64().unwrap_or(0.0);
    if contains_person {
        return None;
    }
    // `delogo` rejects a box touching the frame border, so the mask is inset by at least
    // one pixel on every side; a box that collapses once inset is dropped instead of
    // emitting a filter that would abort the whole render.
    const DELOGO_INSET: f64 = 1.0;
    let x = (left * f64::from(width)).floor().max(DELOGO_INSET);
    let y = (top * f64::from(height)).floor().max(DELOGO_INSET);
    let x2 = (right * f64::from(width))
        .ceil()
        .min(f64::from(width) - DELOGO_INSET);
    let y2 = (bottom * f64::from(height))
        .ceil()
        .min(f64::from(height) - DELOGO_INSET);
    let (x, x2) = (x as u32, x2 as u32);
    let (y, y2) = (y as u32, y2 as u32);
    if x2 <= x || y2 <= y {
        return None;
    }
    Some(format!(
        "delogo=x={x}:y={y}:w={}:h={}:show=0",
        x2 - x,
        y2 - y
    ))
}

/// The window never narrows below the standard full-bleed portrait width. A wider window
/// keeps the full source height, so after fitting the width the frame is shorter than
/// 1080x1920; instead of letterboxing it over black bars the fitted frame is composited
/// over a blurred, zoomed-to-fill copy of the same crop — the full-screen look a real
/// portrait short uses for wide content. Resolved `centerX`/`frameWidth` win when
/// present; otherwise they are recomputed from the boxes, so a plan without the resolved
/// fields still renders a safe frame.
///
/// The person is the anchor. A `textBox` (OCR of burned-in titles, corner tags) is
/// secondary composition information: it widens the window only when it genuinely
/// contains the subject — a wide title the presenter stands in front of. A tag sitting
/// beside the person never widens the frame, so the subject keeps the middle of the
/// plate instead of being shoved to the edge by a union of both boxes.
///
/// `tail` filters (hook drawtext, subtitles, setsar) run on the composed frame; the
/// graph always ends at `[vout]`.
pub fn composition_graph_filter(
    layout: &serde_json::Value,
    ratio: &str,
    tail: &[String],
    source_size: Option<(u32, u32)>,
) -> Option<String> {
    if ratio != "9:16" {
        return None;
    }
    let calc_dominant = || -> Option<(f64, f64)> {
        let span_box = |candidate: &serde_json::Value| {
            Some((
                candidate["left"].as_f64()?,
                candidate["right"].as_f64()?,
                candidate["top"].as_f64()?,
                candidate["bottom"].as_f64()?,
            ))
        };
        let person = span_box(&layout["personBox"])?;
        // Containment is the full box, not just the horizontal span: a title band
        // that only shares the person's width across the top of the frame is OCR
        // noise beside the subject, not a frame that owns them.
        let contains = |outer: (f64, f64, f64, f64), inner: (f64, f64, f64, f64)| {
            outer.0 <= inner.0 && outer.1 >= inner.1 && outer.2 <= inner.2 && outer.3 >= inner.3
        };
        let text = layout["textBox"]
            .as_object()
            .and_then(|candidate| span_box(&serde_json::Value::Object(candidate.clone())));
        match text {
            Some(text) if contains(text, person) => Some((text.0, text.1)),
            _ => Some((person.0, person.1)),
        }
    };
    let center_x = layout["centerX"]
        .as_f64()
        .filter(|center| (0.0..=1.0).contains(center))
        .or_else(|| calc_dominant().map(|(left, right)| (left + right) / 2.0))?;
    let frame_width = layout["frameWidth"]
        .as_f64()
        .filter(|width| *width > 0.0 && *width <= 1.0)
        .or_else(|| calc_dominant().map(|(left, right)| (right - left + 0.04).min(1.0)))?;
    // Round the window up to an even pixel count: rounding down could dip below the
    // standard full-bleed width, and after scale=1080:-2 the frame would then be
    // taller than the 1920 output, which overlay would reject. Clamp to the source
    // width as well — on a source taller than 9:16 the full-bleed width alone can be
    // wider than `iw`, and crop rejects a window it cannot fit.
    let window = format!("2*ceil(min(iw\\,max(ih*9/16\\,{frame_width:.4}*iw))/2)");
    let crop =
        format!("crop={window}:ih:max(0\\,min(iw-({window})\\,({center_x:.4}*iw-({window})/2))):0");
    let source_cover = source_size.and_then(|size| text_box_delogo_filter(layout, size));
    let composed = if tail.is_empty() { "vout" } else { "pad0" };
    let mut graph = format!(
        "[0:v]{}{}{crop},split=2[fit][wide];[wide]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=24[bg];[fit]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[{composed}]",
        source_cover.as_deref().unwrap_or(""),
        if source_cover.is_some() { "," } else { "" }
    );
    for (index, filter) in tail.iter().enumerate() {
        let output = if index + 1 == tail.len() {
            "vout".to_string()
        } else {
            format!("pad{}", index + 1)
        };
        graph.push_str(&format!(";[pad{index}]{filter}[{output}]"));
    }
    Some(graph)
}

/// Builds the portrait background/foreground treatment for an explicitly marked
/// zero-face scene. Unlike person composition, this keeps the complete landscape
/// source visible and centered over its blurred, fill-sized copy.
fn zero_face_scene_graph_filter(tail: &[String]) -> String {
    let composed = if tail.is_empty() { "vout" } else { "pad0" };
    let mut graph = format!(
        "[0:v]split=2[fit][wide];[wide]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=24[bg];[fit]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[{composed}]"
    );
    for (index, filter) in tail.iter().enumerate() {
        let output = if index + 1 == tail.len() {
            "vout".to_string()
        } else {
            format!("pad{}", index + 1)
        };
        graph.push_str(&format!(";[pad{index}]{filter}[{output}]"));
    }
    graph
}

/// The zero-face path is enabled only by a confirmed solo scene with an explicit
/// faceCount of zero. Missing counts and unconfirmed layouts retain the normal render.
fn is_confirmed_zero_face_scene(
    scene: &serde_json::Value,
    plan: Option<&serde_json::Value>,
) -> bool {
    scene["layout"] == "solo"
        && scene["faceCount"].as_u64() == Some(0)
        && scene["confirmed"].as_bool() == Some(true)
        && scene["sourceArtifactId"]
            .as_str()
            .zip(plan.and_then(|value| value["sourceArtifactId"].as_str()))
            .is_some_and(|(scene_source, plan_source)| scene_source == plan_source)
}

/// Selects the H.264 encoder and preset based on platform + hardware preference.
/// Falls back to libx264 (CPU) when no GPU encoder is available or hardware is not
/// requested. Returns (codec, extra_args).
pub fn video_codec(prefer_hardware: bool) -> (&'static str, Vec<&'static str>) {
    if prefer_hardware {
        #[cfg(target_os = "windows")]
        {
            return ("h264_nvenc", vec!["-preset", "p4", "-tune", "hq"]);
        }
        #[cfg(target_os = "macos")]
        {
            return ("h264_videotoolbox", vec!["-real_time", ""]);
        }
        #[cfg(target_os = "linux")]
        {
            return ("h264_qsv", vec!["-preset", "fast"]);
        }
    }
    ("libx264", vec!["-preset", "fast", "-crf", "22"])
}

/// Renders the given source ranges into `output`.
///
/// `media` is the resolved source list: one local path, or two when a separate audio
/// track was downloaded. `plan` carries the optional crop/caption/hook information the
/// editor produced; `None` renders a plain centre-cropped clip.
/// `temp_dir` is the app-private scratch directory; `progress_log` is the FFmpeg progress
/// log path inside it. `prefer_hardware` requests a GPU encoder when available.
#[allow(clippy::too_many_arguments)]
pub fn render_segments(
    ffmpeg: &Path,
    ffprobe: &Path,
    media: &[String],
    output: &Path,
    ranges: &[(f64, f64)],
    aspect_ratio: Option<String>,
    plan: Option<&serde_json::Value>,
    on_progress: &dyn ProgressSink,
    temp_dir: &Path,
    progress_log: &Path,
    prefer_hardware: bool,
) -> Result<String, String> {
    if ranges.is_empty() {
        return Err("INVALID_RENDER_RANGES".into());
    }
    for (index, (start, end)) in ranges.iter().enumerate() {
        if !start.is_finite()
            || !end.is_finite()
            || *start < 0.0
            || *end <= *start
            || ranges[..index]
                .iter()
                .any(|(from, to)| *start < *to && *from < *end)
        {
            return Err("INVALID_RENDER_RANGES".into());
        }
    }
    let output_path = output
        .canonicalize()
        .unwrap_or_else(|_| output.to_path_buf());
    if media.is_empty() || media.len() > 2 {
        return Err("INVALID_RENDER_MEDIA".into());
    }
    if !media[0].starts_with("http://") && !media[0].starts_with("https://") {
        let input_path = Path::new(&media[0])
            .canonicalize()
            .map_err(|e| format!("INPUT_PATH:{e}"))?;
        if input_path == output_path {
            return Err("OUTPUT_MUST_DIFFER_FROM_INPUT".into());
        }
        if !input_path.is_file() {
            return Err("INPUT_NOT_FILE".into());
        }
    }
    let total_duration: f64 = ranges.iter().map(|(start, end)| end - start).sum();
    if !total_duration.is_finite() || total_duration <= 0.0 {
        return Err("INVALID_RENDER_RANGES".into());
    }
    if let Ok(probe) = tool(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(&media[0])
        .output()
    {
        if probe.status.success() {
            if let Ok(source_duration) =
                String::from_utf8_lossy(&probe.stdout).trim().parse::<f64>()
            {
                if ranges.iter().any(|(_, end)| *end > source_duration + 0.05) {
                    return Err("INVALID_RENDER_RANGES".into());
                }
            }
        }
    }
    let has_audio = audio_present(ffprobe, media);
    let ratio = aspect_ratio.unwrap_or_else(|| "9:16".into());
    let crop = match ratio.as_str() {
        "1:1" => "crop=ih:ih:(iw-ih)/2:0,scale=1080:1080".to_string(),
        "16:9" => "crop=ih*16/9:ih:(iw-ih*16/9)/2:0,scale=1920:1080".to_string(),
        _ => "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920".to_string(),
    };
    if plan.is_some_and(|value| !render_crop_mode_is_satisfied(value)) {
        return Err("CROP_TRACKING_UNSATISFIED".into());
    }
    let keyframes = plan
        .and_then(|value| value.get("cropKeyframes"))
        .and_then(serde_json::Value::as_array)
        .filter(|items| !items.is_empty() && items.len() <= 600)
        .cloned()
        .unwrap_or_default();
    let keyframes: Vec<_> = keyframes
        .into_iter()
        .filter(|key| admits_crop_keyframe(key, plan))
        .collect();
    let scene_layouts: Vec<_> = plan
        .and_then(|value| value["sceneLayouts"].as_array())
        .map(|items| {
            items
                .iter()
                .filter(|scene| {
                    scene["confirmed"].as_bool() == Some(true)
                        && scene["sourceArtifactId"].as_str()
                            == plan.and_then(|value| value["sourceArtifactId"].as_str())
                        && scene["start"]
                            .as_f64()
                            .is_some_and(|start| start.is_finite() && start >= 0.0)
                        && scene["end"].as_f64().is_some_and(|end| {
                            end.is_finite() && end > scene["start"].as_f64().unwrap_or(end)
                        })
                        && ["solo", "side-by-side"]
                            .contains(&scene["layout"].as_str().unwrap_or(""))
                })
                .take(600)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let composition_layouts: Vec<_> = plan
        .and_then(|value| value["compositionLayouts"].as_array())
        .map(|items| {
            items
                .iter()
                .filter(|layout| {
                    layout["confirmed"].as_bool() == Some(true)
                        && layout["sourceArtifactId"].as_str()
                            == plan.and_then(|value| value["sourceArtifactId"].as_str())
                        && layout["start"]
                            .as_f64()
                            .is_some_and(|start| start.is_finite() && start >= 0.0)
                        && layout["end"].as_f64().is_some_and(|end| {
                            end.is_finite() && end > layout["start"].as_f64().unwrap_or(end)
                        })
                        && valid_span_box(&layout["personBox"])
                        && (layout["textBox"].is_null() || valid_span_box(&layout["textBox"]))
                })
                .take(600)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let auto_text_boxes: Vec<_> = plan
        .and_then(|value| value["autoTextBoxes"].as_array())
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    item["confirmed"].as_bool() == Some(true)
                        && item["sourceArtifactId"].as_str()
                            == plan.and_then(|value| value["sourceArtifactId"].as_str())
                        && item["start"]
                            .as_f64()
                            .is_some_and(|start| start.is_finite() && start >= 0.0)
                        && item["end"].as_f64().is_some_and(|end| {
                            end.is_finite() && end > item["start"].as_f64().unwrap_or(end)
                        })
                        && valid_span_box(&item["textBox"])
                })
                .take(600)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let source_size = if composition_layouts
        .iter()
        .any(|layout| !layout["textBox"].is_null())
        || !auto_text_boxes.is_empty()
    {
        Some(probe_video_dimensions(ffprobe, &media[0])?)
    } else {
        None
    };
    let crop_for_range = |start: f64| -> String {
        if keyframes.is_empty() {
            return crop.clone();
        }
        let expression = |axis: &str| {
            let value = |key: &serde_json::Value| key[axis].as_f64().unwrap_or(0.5).clamp(0.0, 1.0);
            let mut result = format!("{}", value(keyframes.last().unwrap()));
            for index in (0..keyframes.len()).rev() {
                let key = &keyframes[index];
                let time = key["time"].as_f64().unwrap_or(start) - start;
                if index == 0 {
                    result = format!("if(lt(t\\,{time:.3})\\,{}\\,{result})", value(key));
                } else {
                    let previous = &keyframes[index - 1];
                    let from = (previous["time"].as_f64().unwrap_or(start) - start).max(0.0);
                    let to = time.max(0.0);
                    if to <= 0.0 {
                        continue;
                    }
                    let t1 = previous["time"].as_f64().unwrap_or(start);
                    let t2 = key["time"].as_f64().unwrap_or(t1 + 1.0);
                    let slope = (value(key) - value(previous)) / (t2 - t1);
                    let intercept = value(previous) - slope * t1 + slope * start;
                    result = format!("if(lt(t\\,{from:.3})\\,{}\\,if(lt(t\\,{to:.3})\\,{slope:.6}*t+{intercept:.6}\\,{result}))", value(previous));
                }
            }
            result
        };
        let dimensions = match ratio.as_str() {
            "1:1" => ("ih", "ih", "1080:1080"),
            "16:9" => ("ih*16/9", "ih", "1920:1080"),
            _ => ("ih*9/16", "ih", "1080:1920"),
        };
        format!(
            "crop={}:{}:max(0\\,min(iw-({})\\,({}*iw-({})/2))):max(0\\,min(ih-({})\\,({}*ih-({})/2))),scale={}",
            dimensions.0,
            dimensions.1,
            dimensions.0,
            expression("centerX"),
            dimensions.0,
            dimensions.1,
            expression("centerY"),
            dimensions.1,
            dimensions.2
        )
    };
    fn drawtext_escape(text: &str) -> String {
        text.replace('\\', "\\\\")
            .replace(':', "\\:")
            .replace('\'', "\\'")
            .replace('%', "\\%")
            .replace(',', "\\,")
            .replace('[', "\\[")
            .replace(']', "\\]")
            .replace(';', "\\;")
    }

    /// Splits hook text into display lines short enough to fit the frame; drawtext does not wrap.
    fn wrap_hook_lines(text: &str) -> Vec<String> {
        const MAX_LINE: usize = 24;
        let mut lines = Vec::new();
        let mut current = String::new();
        for word in text.split_whitespace() {
            if !current.is_empty() && current.len() + 1 + word.len() > MAX_LINE {
                lines.push(std::mem::take(&mut current));
            }
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
        }
        if !current.is_empty() {
            lines.push(current);
        }
        if lines.is_empty() {
            lines.push(String::new());
        }
        lines
    }
    let captions = plan
        .and_then(|value| value.get("captions"))
        .and_then(serde_json::Value::as_array);
    let hook_intervals = if let Some(hook) = plan
        .and_then(|value| value.get("hook"))
        .filter(|hook| !hook.is_null())
    {
        remap_hook(hook, ranges)?
    } else {
        Vec::new()
    };
    let temp = create_temporary_render_dir(temp_dir)?;
    let mut segments = Vec::new();
    let mut piece_durations = Vec::new();
    for (index, (start, end)) in ranges.iter().enumerate() {
        let mut boundaries: Vec<f64> = vec![*start, *end];
        let mut cut_scenes: Vec<u64> = keyframes
            .iter()
            .filter_map(|key| key["sceneId"].as_u64())
            .collect();
        cut_scenes.sort_unstable();
        cut_scenes.dedup();
        for key in &keyframes {
            let key_time = key["time"].as_f64().unwrap_or(*start);
            if key["sceneId"]
                .as_u64()
                .is_some_and(|scene| cut_scenes.contains(&scene))
                && key_time > *start
                && key_time < *end
                && keyframes.iter().any(|other| {
                    other["time"]
                        .as_f64()
                        .is_some_and(|other_time| other_time < key_time)
                        && other["sceneId"] != key["sceneId"]
                })
            {
                boundaries.push(key_time);
            }
        }
        for scene in &scene_layouts {
            let scene_start = scene["start"].as_f64().unwrap_or(*start);
            let scene_end = scene["end"].as_f64().unwrap_or(*end);
            if scene_start > *start && scene_start < *end {
                boundaries.push(scene_start);
            }
            if scene_end > *start && scene_end < *end {
                boundaries.push(scene_end);
            }
        }
        for layout in &composition_layouts {
            let layout_start = layout["start"].as_f64().unwrap_or(*start);
            let layout_end = layout["end"].as_f64().unwrap_or(*end);
            if layout_start > *start && layout_start < *end {
                boundaries.push(layout_start);
            }
            if layout_end > *start && layout_end < *end {
                boundaries.push(layout_end);
            }
        }
        for layout in &auto_text_boxes {
            let layout_start = layout["start"].as_f64().unwrap_or(*start);
            let layout_end = layout["end"].as_f64().unwrap_or(*end);
            if layout_start > *start && layout_start < *end {
                boundaries.push(layout_start);
            }
            if layout_end > *start && layout_end < *end {
                boundaries.push(layout_end);
            }
        }
        boundaries.sort_by(f64::total_cmp);
        boundaries.dedup_by(|a, b| (*a - *b).abs() < 0.001);
        let windows_count = boundaries.len().saturating_sub(1).max(1) as f64;
        for (piece_index, window) in boundaries.windows(2).enumerate() {
            let piece_start = window[0];
            let piece_end = window[1];
            let duration = piece_end - piece_start;
            let segment = temp
                .0
                .join(format!("segment-{index:04}-{piece_index:03}.mp4"));
            let active_scene = scene_layouts.iter().find(|scene| {
                scene["start"]
                    .as_f64()
                    .is_some_and(|value| piece_start >= value)
                    && scene["end"]
                        .as_f64()
                        .is_some_and(|value| piece_start < value)
            });
            let zero_face_scene = active_scene.filter(|scene| {
                ratio == "9:16" && keyframes.is_empty() && is_confirmed_zero_face_scene(scene, plan)
            });
            let side_by_side = active_scene
                .filter(|scene| scene["layout"] == "side-by-side")
                .and_then(|scene| scene["subjectBoxes"].as_array())
                .and_then(|boxes| side_by_side_graph(boxes, &[], &ratio));
            let active_composition = composition_layouts.iter().find(|layout| {
                layout["start"]
                    .as_f64()
                    .is_some_and(|value| piece_start >= value)
                    && layout["end"]
                        .as_f64()
                        .is_some_and(|value| piece_start < value)
            });
            let active_ocr = auto_text_boxes.iter().find(|layout| {
                layout["start"]
                    .as_f64()
                    .is_some_and(|value| piece_start >= value)
                    && layout["end"]
                        .as_f64()
                        .is_some_and(|value| piece_start < value)
            });
            let active_composition_mask = active_composition.map(|layout| {
                let mut masked = layout.clone();
                if masked["textBox"].is_null() {
                    if let Some(ocr_layout) = active_ocr {
                        masked["textBox"] = ocr_layout["textBox"].clone();
                    }
                }
                masked
            });
            let active_ocr_mask =
                active_ocr.map(|layout| serde_json::json!({ "textBox": layout["textBox"] }));
            let active_mask = active_composition_mask
                .as_ref()
                .or(active_ocr_mask.as_ref());
            // A confirmed crop path is the user's own composition; the automatic layout
            // must never override it, so the piece keeps the plain crop graph (which
            // carries the keyframes) instead of the composition graph.
            let use_composition = zero_face_scene.is_none()
                && active_composition.is_some_and(|layout| valid_span_box(&layout["personBox"]))
                && ratio == "9:16"
                && keyframes.is_empty();
            let mut filters = if side_by_side.is_some() || use_composition {
                Vec::new()
            } else {
                vec![crop_for_range(piece_start)]
            };
            if !use_composition {
                if let Some(cover) = active_mask.and_then(|layout| {
                    text_box_delogo_filter(layout, source_size.unwrap_or((0, 0)))
                }) {
                    filters.insert(0, cover);
                }
            }
            let mut complex_graph_filters = Vec::new();
            let mut composition_tail = Vec::new();
            let mut subtitle_file = None;
            let piece_hook = hook_intervals
                .iter()
                .filter(|(hook_index, _, _)| *hook_index == index)
                .filter_map(|(_, from, to)| {
                    let absolute_from = start + from;
                    let absolute_to = start + to;
                    let clipped_from = absolute_from.max(piece_start);
                    let clipped_to = absolute_to.min(piece_end);
                    (clipped_to > clipped_from)
                        .then_some((clipped_from - piece_start, clipped_to - piece_start))
                });
            for (from, to) in piece_hook {
                let text = plan
                    .and_then(|value| value.get("hook"))
                    .and_then(|hook| hook.get("text"))
                    .and_then(serde_json::Value::as_str)
                    .ok_or("INVALID_RENDER_HOOK")?;
                // drawtext does not wrap, so long hook text is split into short display
                // lines stacked below y=h*0.12; a multi-line block uses a smaller font
                // so the stack stays in the upper part of the frame.
                let lines = wrap_hook_lines(text);
                let fontsize = if lines.len() == 1 && lines[0].chars().count() <= 19 {
                    "h/18"
                } else {
                    "h/24"
                };
                for (line, text_line) in lines.iter().enumerate() {
                    let drawtext = format!("drawtext=text='{}':x=(w-text_w)/2:y=h*0.12+{line}*h*0.056:fontsize={fontsize}:fontcolor=white:borderw=3:enable='between(t,{from:.3},{to:.3})'", drawtext_escape(text_line));
                    filters.push(drawtext.clone());
                    composition_tail.push(drawtext);
                }
            }
            // When the composition keeps a baked-in text block that reaches the lower
            // half of the frame, lift the burned captions above it instead of letting
            // both white text blocks overlap.
            let caption_margin_v = if use_composition
                && active_mask
                    .and_then(|layout| layout["textBox"]["bottom"].as_f64())
                    .is_some_and(|bottom| bottom > 0.55)
            {
                900
            } else {
                650
            };
            let scene_subtitle_ranges = [(piece_start, piece_end)];
            if let Some(contents) =
                remapped_captions_for_range(captions, &scene_subtitle_ranges, 0, caption_margin_v)?
            {
                let subtitle = write_temporary_ass(temp_dir, &contents)?;
                let filter = format!(
                    "ass='{}'",
                    escape_ass_filter_path(&subtitle.0.to_string_lossy())
                );
                if side_by_side.is_some() {
                    complex_graph_filters.push(filter.clone());
                } else {
                    filters.push(filter.clone());
                }
                composition_tail.push(filter);
                subtitle_file = Some(subtitle);
            }
            filters.push("setsar=1".to_string());
            composition_tail.push("setsar=1".to_string());
            let complex_graph = zero_face_scene
                .map(|_| zero_face_scene_graph_filter(&composition_tail))
                .or_else(|| {
                    side_by_side.as_ref().and_then(|_| {
                        let mut graph = side_by_side_graph(
                            active_scene?.get("subjectBoxes")?.as_array()?,
                            &complex_graph_filters,
                            &ratio,
                        )?;
                        if let Some(cover) = active_mask
                            .and_then(|layout| text_box_delogo_filter(layout, source_size?))
                        {
                            graph =
                                graph.replacen("[0:v]split=2", &format!("[0:v]{cover},split=2"), 1);
                        }
                        Some(graph)
                    })
                })
                .or_else(|| {
                    // The composition graph also decides the crop, so it must not run
                    // while the user's own keyframe crop is in play — that path keeps
                    // the plain filters (which carry the keyframes) instead.
                    active_composition_mask
                        .as_ref()
                        .filter(|_| {
                            zero_face_scene.is_none() && ratio == "9:16" && keyframes.is_empty()
                        })
                        .and_then(|layout| {
                            composition_graph_filter(layout, &ratio, &composition_tail, source_size)
                        })
                });
            let mut cmd = tool(ffmpeg);
            cmd.args(["-y", "-nostdin", "-hide_banner", "-loglevel", "error"]);
            for source in media {
                cmd.args(["-ss"])
                    .arg(format!("{piece_start:.3}"))
                    .args(["-t"])
                    .arg(format!("{duration:.3}"))
                    .args(["-i"])
                    .arg(source);
            }
            if !has_audio {
                // A source without an audio track still gets a silent track, so the
                // output is a normal playable MP4. The fake input has to be declared
                // with the real inputs: past the first output option FFmpeg reads
                // `-f lavfi` as an output format and refuses to open the input.
                cmd.args([
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=channel_layout=stereo:sample_rate=44100",
                    "-t",
                ])
                .arg(format!("{duration:.3}"));
            }
            if let Some(graph) = complex_graph.as_ref() {
                cmd.args(["-filter_complex", graph, "-map", "[vout]"]);
            } else {
                cmd.args(["-vf", &filters.join(","), "-map", "0:v:0"]);
            }
            let (codec, codec_extra) = video_codec(prefer_hardware);
            cmd.args(["-c:v", codec, "-pix_fmt", "yuv420p", "-r", "30"]);
            cmd.args(codec_extra);
            if !prefer_hardware {
                cmd.args(["-crf", "22"]);
            }
            if has_audio {
                let audio_index = if media.len() > 1 { 1 } else { 0 };
                cmd.args(["-map"])
                    .arg(format!("{audio_index}:a:0"))
                    .args(["-c:a", "aac", "-b:a", "128k"]);
            } else {
                let audio_input_index = media.len();
                cmd.args(["-map", "0:v:0", "-map"])
                    .arg(format!("{audio_input_index}:a:0"))
                    .args(["-c:a", "aac", "-b:a", "128k"]);
            }
            let window_start =
                ((index as f64 + piece_index as f64 / windows_count) / ranges.len() as f64) * 90.0;
            let window_end = ((index as f64 + (piece_index + 1) as f64 / windows_count)
                / ranges.len() as f64)
                * 90.0;
            run_render_child(
                cmd.arg(&segment),
                on_progress,
                (window_start, window_end),
                (end - start) / windows_count as f64,
                "segments",
                progress_log,
            )?;
            drop(subtitle_file);
            segments.push(segment);
            piece_durations.push(duration);
        }
    }
    let parent = output_path.parent().ok_or("OUTPUT_PARENT_MISSING")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("OUTPUT_DIR:{e}"))?;
    let expected_dimensions = match ratio.as_str() {
        "1:1" => (1080, 1080),
        "16:9" => (1920, 1080),
        _ => (1080, 1920),
    };
    let jump_cut = plan
        .and_then(|value| value.get("effects"))
        .and_then(serde_json::Value::as_array)
        .is_some_and(|effects| effects.iter().any(|effect| effect.as_str() == Some("jump-cut")));
    let partial = join_segments(
        ffmpeg,
        ffprobe,
        &segments,
        has_audio,
        total_duration,
        expected_dimensions,
        &temp,
        on_progress,
        progress_log,
        jump_cut,
        &piece_durations,
    )?;

    // Atomic output: write to a sibling .tmp file first, probe-verify it, then atomically
    // rename onto the final path so a crashed render never leaves a half-written MP4.
    let tmp_path = output_path.with_extension("tmp");
    if let Err(e) = std::fs::copy(&partial, &tmp_path) {
        on_progress.report(RenderProgress {
            percent: 99.0,
            phase: "error".into(),
            error_code: Some("OUTPUT_COPY".into()),
        });
        return Err(format!("OUTPUT_COPY:{e}"));
    }
    if let Err(e) = probe_duration(ffprobe, &tmp_path.to_string_lossy()) {
        let _ = std::fs::remove_file(&tmp_path);
        on_progress.report(RenderProgress {
            percent: 99.0,
            phase: "error".into(),
            error_code: Some("OUTPUT_PROBE_VERIFY".into()),
        });
        return Err(format!("OUTPUT_PROBE_VERIFY:{e}"));
    }
    if let Err(e) = std::fs::rename(&tmp_path, &output_path) {
        let _ = std::fs::remove_file(&tmp_path);
        on_progress.report(RenderProgress {
            percent: 99.0,
            phase: "error".into(),
            error_code: Some("OUTPUT_RENAME".into()),
        });
        return Err(format!("OUTPUT_RENAME:{e}"));
    }
    let _ = std::fs::remove_file(&tmp_path);
    on_progress.report(RenderProgress {
        percent: 100.0,
        phase: "completed".into(),
        error_code: None,
    });
    Ok(output_path.to_string_lossy().into_owned())
}

/// Joins the encoded segments and returns the joined file inside the temp dir.
///
/// Fast path: concat demuxer with `-c copy` — every segment comes from this same
/// encode run (same `-r`/`-crf`/`pix_fmt`/audio settings), so a stream copy joins
/// them without the second full encode the filter path performs. On the ADR-007
/// benchmark that is ~180x faster on the join step and one less crf22 generation
/// on the output.
///
/// The copy result is validated (duration + stream shape) and *any* mismatch — or
/// any copy failure at all — falls back to the filter re-encode, so the rendered
/// output never regresses below what the filter path produced.
#[allow(clippy::too_many_arguments)]
pub fn join_segments(
    ffmpeg: &Path,
    ffprobe: &Path,
    segments: &[PathBuf],
    has_audio: bool,
    total_duration: f64,
    expected_dimensions: (u32, u32),
    temp: &TemporaryRenderDir,
    on_progress: &dyn ProgressSink,
    progress_log: &Path,
    jump_cut: bool,
    piece_durations: &[f64],
) -> Result<PathBuf, String> {
    if jump_cut {
        if let Some(graph) = jump_cut_graph(&piece_durations, has_audio, expected_dimensions) {
            return join_segments_with_graph(
                ffmpeg, segments, has_audio, total_duration, temp, on_progress, progress_log, &graph,
            );
        }
    }
    let copy = temp.0.join("joined-copy.mp4");
    let copied = join_segments_copy(
        ffmpeg,
        segments,
        has_audio,
        &copy,
        on_progress,
        progress_log,
    )
    .and_then(|_| {
        validate_joined_output(
            ffprobe,
            &copy,
            has_audio,
            expected_dimensions,
            total_duration,
            segments.len(),
        )
    });
    match copied {
        Ok(()) => Ok(copy),
        Err(copy_error) => {
            // The filter path re-encodes, so it tolerates whatever the stream copy
            // could not preserve. If it fails too, report both causes.
            let _ = std::fs::remove_file(&copy);
            join_segments_filter(
                ffmpeg,
                segments,
                has_audio,
                total_duration,
                temp,
                on_progress,
                progress_log,
            )
            .map_err(|filter_error| format!("JOIN_COPY:{copy_error}; JOIN_FILTER:{filter_error}"))
        }
    }
}

fn join_segments_with_graph(
    ffmpeg: &Path,
    segments: &[PathBuf],
    has_audio: bool,
    total_duration: f64,
    temp: &TemporaryRenderDir,
    on_progress: &dyn ProgressSink,
    progress_log: &Path,
    graph: &str,
) -> Result<PathBuf, String> {
    let partial = temp.0.join("joined-jumpcut.mp4");
    let mut cmd = tool(ffmpeg);
    cmd.args(["-y", "-nostdin", "-hide_banner", "-loglevel", "error"]);
    for segment in segments {
        cmd.arg("-i").arg(segment);
    }
    cmd.args(["-filter_complex", graph, "-map", "[vout]"])
        .args(["-c:v", "libx264", "-preset", "fast", "-crf", "22", "-pix_fmt", "yuv420p"])
        .args(["-movflags", "+faststart"]);
    if has_audio {
        cmd.args(["-map", "[aout]", "-c:a", "aac", "-b:a", "128k"]);
    }
    run_render_child(
        cmd.arg(&partial),
        on_progress,
        (90.0, 98.0),
        total_duration,
        "joining",
        progress_log,
    )?;
    Ok(partial)
}

/// Stream-copy join via the concat demuxer.
fn join_segments_copy(
    ffmpeg: &Path,
    segments: &[PathBuf],
    has_audio: bool,
    output: &Path,
    on_progress: &dyn ProgressSink,
    progress_log: &Path,
) -> Result<(), String> {
    let list = output.with_file_name("joined-copy-list.txt");
    let mut listing = String::new();
    for segment in segments {
        let quoted = segment.to_string_lossy().replace('\'', "'\\''");
        listing.push_str(&format!("file '{quoted}'\n"));
    }
    std::fs::write(&list, listing).map_err(|e| format!("JOIN_LIST:{e}"))?;
    let mut cmd = tool(ffmpeg);
    cmd.args(["-y", "-nostdin", "-hide_banner", "-loglevel", "error"])
        .args(["-f", "concat", "-safe", "0", "-i"])
        .arg(&list)
        .args(["-c", "copy", "-movflags", "+faststart"]);
    if !has_audio {
        // Segments always carry an audio track (a generated silent one when the
        // source has none); the filter join drops it, so the copy must too or the
        // output gains a stream the old path never had.
        cmd.arg("-an");
    }
    let result = run_render_child(
        cmd.arg(output),
        on_progress,
        (90.0, 98.0),
        0.0,
        "joining",
        progress_log,
    );
    let _ = std::fs::remove_file(&list);
    result
}

/// Filter graph for a multi-range export: a gentle punch-in on each later
/// range makes the jump deliberate, and a 30ms audio acrossfade removes the
/// click at the splice. Returns None for a single range (normal concat).
pub fn jump_cut_graph(durations: &[f64], has_audio: bool, dimensions: (u32, u32)) -> Option<String> {
    let count = durations.len();
    if count < 2 {
        return None;
    }
    let transition = 0.03_f64;
    let (width, height) = dimensions;
    let mut graph = String::new();
    for index in 0..count {
        if index > 0 {
            graph.push(';');
        }
        if index == 0 {
            graph.push_str(&format!("[{index}:v:0]null[v{index}]"));
        } else {
            graph.push_str(&format!(
                "[{index}:v:0]scale={}:{},crop={}:{},setsar=1[v{index}]",
                width * 26 / 25, height * 26 / 25, width, height
            ));
        }
        if has_audio {
            graph.push_str(&format!(";[{index}:a:0]anull[a{index}]"));
        }
    }
    let mut audio = String::new();
    if has_audio {
        for index in 0..count {
            audio.push_str(&format!("[{index}:a:0]"));
        }
    }
    // Video uses xfade with an offset computed from the real piece durations;
    // audio uses acrossfade. FFmpeg's acrossfade has video pads only on xfade,
    // so the two chains must stay separate.
    let mut vcurrent = 0usize;
    let mut acurrent = 0usize;
    let mut elapsed = durations[0];
    for index in 1..count {
        let vout = count + index;
        let offset = (elapsed - transition).max(0.0);
        graph.push_str(&format!(
            ";[v{vcurrent}][v{index}]xfade=transition=fade:duration={transition:.3}:offset={offset:.3}[v{vout}]"
        ));
        if has_audio {
            let aout = vout + count;
            graph.push_str(&format!(
                ";[a{acurrent}][a{index}]acrossfade=d={transition:.3}:c1=tri:c2=tri[a{aout}]"
            ));
            acurrent = aout;
        }
        elapsed += durations[index] - transition;
        vcurrent = vout;
    }
    graph.push_str(&format!(";[v{vcurrent}]setsar=1[vout]"));
    if has_audio {
        graph.push_str(&format!(";[a{acurrent}]anull[aout]"));
    } else {
        // The test asserts no crossfade without audio; keep the graph honest.
        debug_assert!(!graph.contains("acrossfade"));
    }
    Some(graph)
}

/// The previous join: concat filter with a full re-encode. Kept as the fallback.
fn join_segments_filter(
    ffmpeg: &Path,
    segments: &[PathBuf],
    has_audio: bool,
    total_duration: f64,
    temp: &TemporaryRenderDir,
    on_progress: &dyn ProgressSink,
    progress_log: &Path,
) -> Result<PathBuf, String> {
    let partial = temp.0.join("joined.mp4");
    let mut cmd = tool(ffmpeg);
    cmd.args(["-y", "-nostdin", "-hide_banner", "-loglevel", "error"]);
    for segment in segments {
        cmd.arg("-i").arg(segment);
    }
    let count = segments.len();
    let mut graph = String::new();
    if has_audio {
        for index in 0..count {
            graph.push_str(&format!("[{index}:v:0][{index}:a:0]"));
        }
        graph.push_str(&format!(
            "concat=n={count}:v=1:a=1[v0][aout];[v0]setsar=1[vout]"
        ));
    } else {
        for index in 0..count {
            graph.push_str(&format!("[{index}:v:0]"));
        }
        graph.push_str(&format!("concat=n={count}:v=1:a=0[vout]"));
    }
    cmd.args([
        "-filter_complex",
        &graph,
        "-map",
        "[vout]",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
    ]);
    if has_audio {
        cmd.args(["-map", "[aout]", "-c:a", "aac", "-b:a", "128k"]);
    }
    run_render_child(
        cmd.arg(&partial),
        on_progress,
        (90.0, 98.0),
        total_duration,
        "joining",
        progress_log,
    )?;
    Ok(partial)
}

/// Checks the stream-copied join before it is trusted: it must have the same shape
/// the filter path would produce (video at the expected dimensions, audio present
/// iff the source has audio) and cover the requested duration. Anything else sends
/// the render back to the filter re-encode.
pub fn validate_joined_output(
    ffprobe: &Path,
    joined: &Path,
    has_audio: bool,
    expected_dimensions: (u32, u32),
    total_duration: f64,
    segment_count: usize,
) -> Result<(), String> {
    let output = tool(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,width,height,duration:format=duration",
            "-of",
            "json",
        ])
        .arg(joined)
        .output()
        .map_err(|e| format!("JOIN_PROBE_SPAWN:{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "JOIN_PROBE:{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let probe: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("JOIN_PROBE_JSON:{e}"))?;
    let streams = probe["streams"].as_array().ok_or("JOIN_PROBE_NO_STREAMS")?;
    // Segment durations round to the frame grid independently, so the join may
    // drift by up to half a frame per boundary; beyond that is real breakage.
    let tolerance = 0.25 + 0.05 * segment_count as f64;
    let video = streams
        .iter()
        .find(|stream| stream["codec_type"] == "video")
        .ok_or("JOIN_COPY_NO_VIDEO")?;
    let width = video["width"].as_u64().ok_or("JOIN_COPY_NO_WIDTH")?;
    let height = video["height"].as_u64().ok_or("JOIN_COPY_NO_HEIGHT")?;
    if (width, height)
        != (
            u64::from(expected_dimensions.0),
            u64::from(expected_dimensions.1),
        )
    {
        return Err(format!("JOIN_COPY_SHAPE:{width}x{height}"));
    }
    let video_duration = video["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .or_else(|| {
            probe["format"]["duration"]
                .as_str()
                .and_then(|d| d.parse().ok())
        })
        .ok_or("JOIN_COPY_NO_DURATION")?;
    if (video_duration - total_duration).abs() > tolerance {
        return Err(format!(
            "JOIN_COPY_DURATION:{video_duration} vs {total_duration}"
        ));
    }
    let audio = streams
        .iter()
        .find(|stream| stream["codec_type"] == "audio");
    if has_audio {
        let audio = audio.ok_or("JOIN_COPY_NO_AUDIO")?;
        let audio_duration = audio["duration"]
            .as_str()
            .and_then(|d| d.parse::<f64>().ok())
            .ok_or("JOIN_COPY_NO_AUDIO_DURATION")?;
        if (audio_duration - video_duration).abs() > 0.1 {
            return Err(format!(
                "JOIN_COPY_AV_DRIFT:{audio_duration} vs {video_duration}"
            ));
        }
    } else if audio.is_some() {
        return Err("JOIN_COPY_UNEXPECTED_AUDIO".into());
    }
    Ok(())
}

pub fn ass_timestamp(seconds: f64) -> String {
    let centiseconds = (seconds.max(0.0) * 100.0).floor() as u64;
    format!(
        "{}:{:02}:{:02}.{:02}",
        centiseconds / 360_000,
        centiseconds / 6_000 % 60,
        centiseconds / 100 % 60,
        centiseconds % 100
    )
}

pub fn escape_ass_text(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('{', "\\{")
        .replace('}', "\\}")
        .replace(['\r', '\n'], " ")
}

/// Builds ASS text with optional word-level karaoke (`\k`) timing clipped to
/// the rendered window `[from, to)`. Falls back to the escaped caption text
/// when word timing is absent, empty, out of order, or contains newlines.
fn ass_caption_text(
    caption: &serde_json::Value,
    text: &str,
    cue_start: f64,
    cue_end: f64,
    from: f64,
    to: f64,
) -> String {
    if text.contains(['\n', '\r']) {
        return escape_ass_text(text);
    }
    let Some(words) = caption.get("words").and_then(|v| v.as_array()) else {
        return escape_ass_text(text);
    };
    if words.is_empty() {
        return escape_ass_text(text);
    }
    // Parse word timing; bail to plain text on any malformed entry.
    let mut parsed: Vec<(String, f64, f64)> = Vec::with_capacity(words.len());
    for word in words {
        let Some(wtext) = word["text"].as_str() else {
            return escape_ass_text(text);
        };
        if wtext.is_empty() || wtext.contains(['\n', '\r']) {
            return escape_ass_text(text);
        }
        let (Some(ws), Some(we)) = (word["start"].as_f64(), word["end"].as_f64()) else {
            return escape_ass_text(text);
        };
        if !ws.is_finite() || !we.is_finite() || we <= ws {
            return escape_ass_text(text);
        }
        if ws < cue_start || we > cue_end {
            return escape_ass_text(text);
        }
        parsed.push((wtext.to_string(), ws, we));
    }
    // Require strictly increasing (non-overlapping) word timings.
    for i in 1..parsed.len() {
        if parsed[i].1 < parsed[i - 1].2 {
            return escape_ass_text(text);
        }
    }
    // Clip to the rendered window; keep only words overlapping [from, to).
    let mut visible: Vec<(String, f64, f64)> = Vec::new();
    for (wtext, ws, we) in parsed {
        let cstart = ws.max(from);
        let cend = we.min(to);
        if cend > cstart {
            visible.push((wtext, cstart, cend));
        }
    }
    if visible.is_empty() {
        return escape_ass_text(text);
    }
    // Emit `{\k<centiseconds>}` before each word except the first. Override
    // tags are only interpreted inside braces; a bare `\k` is drawn as text.
    // Centiseconds are relative to the clipped caption's start (ASS timing is
    // dialogue local). For the first visible word, emit `{\k0}` so FFmpeg
    // anchors the highlight sweep to the visible window rather than the full
    // cue.
    let mut out = String::new();
    for (i, (wtext, cstart, _cend)) in visible.iter().enumerate() {
        if i == 0 {
            out.push_str("{\\k0}");
        } else {
            let delta_cs = ((cstart - from) * 100.0).floor() as i64;
            out.push_str(&format!("{{\\k{}}}", delta_cs.max(0)));
        }
        if i > 0 {
            out.push(' ');
        }
        out.push_str(&escape_ass_text(wtext));
    }
    out
}

pub fn ass_dialogue(
    captions: &[serde_json::Value],
    start: f64,
    duration: f64,
    margin_v: u32,
) -> Result<Option<String>, String> {
    if !start.is_finite() || start < 0.0 || !duration.is_finite() || duration <= 0.0 {
        return Err("INVALID_RENDER_REQUEST".into());
    }
    let end = start + duration;
    let mut events = Vec::new();
    for caption in captions {
        let text = caption["text"].as_str().ok_or("INVALID_RENDER_CAPTION")?;
        let cue_start = caption["start"].as_f64().ok_or("INVALID_RENDER_CAPTION")?;
        let cue_end = caption["end"].as_f64().ok_or("INVALID_RENDER_CAPTION")?;
        if !cue_start.is_finite() || !cue_end.is_finite() || cue_end <= cue_start {
            return Err("INVALID_RENDER_CAPTION".into());
        }
        let from = cue_start.max(start);
        let to = cue_end.min(end);
        if to > from {
            let display = ass_caption_text(caption, text, cue_start, cue_end, from, to);
            events.push(format!(
                "Dialogue: 0,{},{},Shorts,,0,0,0,,{}",
                ass_timestamp(from - start),
                ass_timestamp(to - start),
                display
            ));
        }
    }
    if events.is_empty() {
        return Ok(None);
    }
    let header = format!(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Shorts,Arial,70,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,1,6,0,2,40,40,{margin_v},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    );
    Ok(Some(format!("{header}{}\n", events.join("\n"))))
}

pub fn write_temporary_ass(temp_dir: &Path, contents: &str) -> Result<TemporarySubtitle, String> {
    use std::io::Write;
    for attempt in 0..100 {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("CLOCK:{e}"))?
            .as_nanos();
        let path = temp_dir.join(format!(
            "lfai-subtitle-{}-{suffix}-{attempt}.ass",
            std::process::id()
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
                }
                if let Err(error) = file.write_all(contents.as_bytes()) {
                    let _ = std::fs::remove_file(&path);
                    return Err(format!("SUBTITLE_WRITE:{error}"));
                }
                return Ok(TemporarySubtitle(path));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("SUBTITLE_CREATE:{error}")),
        }
    }
    Err("SUBTITLE_TEMP_COLLISION".into())
}

pub fn escape_ass_filter_path(path: &str) -> String {
    path.replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "\\'")
        .replace(',', "\\,")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace(';', "\\;")
}

impl Drop for TemporaryRenderDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
impl Drop for TemporarySubtitle {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ass_dialogue, composition_graph_filter, has_confirmed_crop_keyframes, is_confirmed_zero_face_scene,
        jump_cut_graph, render_crop_mode_is_satisfied, text_box_delogo_filter, zero_face_scene_graph_filter,
    };
    use serde_json::json;

    fn layout(person_left: f64, person_right: f64, text: Option<(f64, f64)>) -> serde_json::Value {
        json!({
            "personBox": { "left": person_left, "right": person_right, "top": 0.1, "bottom": 0.9 },
            "textBox": text.map(|(left, right)| json!({ "left": left, "right": right, "top": 0.02, "bottom": 0.18 })),
        })
    }

    #[test]
    fn crop_tracking_requires_usable_data() {
        let plan = json!({ "cropMode": "track", "sourceArtifactId": "src" });
        assert!(!render_crop_mode_is_satisfied(&plan));
        let centered = json!({ "cropMode": "center", "sourceArtifactId": "src" });
        assert!(render_crop_mode_is_satisfied(&centered));
        let with_face = json!({
            "cropMode": "track", "sourceArtifactId": "src", "speakerMap": { "A": "face-0" },
            "cropKeyframes": [{ "time": 1.0, "centerX": 0.4, "confidence": 0.9, "confirmed": true, "speakerId": "A", "sourceFaceId": "face-0", "sourceArtifactId": "src" }]
        });
        assert!(render_crop_mode_is_satisfied(&with_face));
    }

    #[test]
    fn jump_cut_uses_acrossfade_and_punch_in_zoom() {
        let graph = jump_cut_graph(&[40.0, 57.0], true, (1080, 1920)).unwrap();
        assert!(graph.contains("acrossfade=d=0.03"), "{graph}");
        assert!(graph.contains("scale=1123:1996,crop=1080:1920"), "{graph}");
        assert!(graph.contains("xfade=transition=fade"), "{graph}");
        assert!(graph.contains("offset=39.970"), "{graph}");
        assert!(graph.contains("[0:v:0]null[v0]"), "{graph}");
        assert!(graph.contains("[1:v:0]scale=1123:1996"), "{graph}");
        assert!(graph.matches(";").count() >= 2, "{graph}");
        assert!(graph.contains("1123:1996"), "{graph}");
        assert!(graph.contains("[vout]") && graph.contains("[aout]"), "{graph}");
        let no_audio = jump_cut_graph(&[40.0, 57.0], false, (1080, 1920)).unwrap();
        assert!(no_audio.contains("acrossfade") == false, "{no_audio}");
        assert!(jump_cut_graph(&[40.0], true, (1080, 1920)).is_none());
    }

    #[test]
    fn keeps_the_standard_full_bleed_window_for_a_bare_person() {
        // A narrow person's width is below the standard window; the max() in the
        // expression clamps it to the full-bleed width at runtime.
        let graph = composition_graph_filter(
            &layout(0.30, 0.52, None),
            "9:16",
            &["setsar=1".to_string()],
            None,
        )
        .unwrap();
        assert!(
            graph.contains("2*ceil(min(iw\\,max(ih*9/16\\,0.2600*iw))/2)"),
            "{graph}"
        );
        assert!(graph.contains("0.4100*iw"), "{graph}");
        assert!(graph.contains("split=2"), "{graph}");
        assert!(!graph.contains("delogo="), "{graph}");
        assert!(graph.contains("gblur=sigma=24"), "{graph}");
        assert!(graph.contains("overlay=(W-w)/2:(H-h)/2"), "{graph}");
        assert!(graph.ends_with(";[pad0]setsar=1[vout]"), "{graph}");
    }

    #[test]
    fn centres_the_frame_on_the_person_when_the_text_sits_off_to_one_side() {
        // Person on the left, a corner tag on the right: the person is the anchor, so
        // the frame width stays the person's own span and the subject keeps the middle
        // of the plate. The union would drag the subject to ~20% of the output frame.
        let graph = composition_graph_filter(
            &layout(0.05, 0.30, Some((0.60, 0.95))),
            "9:16",
            &[],
            Some((1920, 1080)),
        )
        .unwrap();
        assert!(graph.contains("max(ih*9/16\\,0.2900*iw)"), "{graph}");
        assert!(graph.contains("0.1750*iw"), "{graph}");
    }

    #[test]
    fn keeps_a_centred_person_centred_when_text_owns_the_far_right() {
        let graph = composition_graph_filter(
            &layout(0.40, 0.60, Some((0.65, 0.95))),
            "9:16",
            &[],
            Some((1920, 1080)),
        )
        .unwrap();
        assert!(graph.contains("max(ih*9/16\\,0.2400*iw)"), "{graph}");
        assert!(graph.contains("0.5000*iw"), "{graph}");
    }

    #[test]
    fn keeps_the_person_centred_when_the_person_is_on_the_right() {
        let graph = composition_graph_filter(
            &layout(0.70, 0.92, Some((0.02, 0.35))),
            "9:16",
            &[],
            Some((1920, 1080)),
        )
        .unwrap();
        assert!(graph.contains("max(ih*9/16\\,0.2600*iw)"), "{graph}");
        assert!(graph.contains("0.8100*iw"), "{graph}");
    }

    #[test]
    fn keeps_the_person_centred_when_the_boxes_overlap_without_containing() {
        // Overlapping but neither contains: still person-first, no union widening.
        let graph = composition_graph_filter(
            &layout(0.30, 0.60, Some((0.50, 0.80))),
            "9:16",
            &[],
            Some((1920, 1080)),
        )
        .unwrap();
        assert!(graph.contains("max(ih*9/16\\,0.3400*iw)"), "{graph}");
        assert!(graph.contains("0.4500*iw"), "{graph}");
    }

    #[test]
    fn keeps_the_text_when_it_contains_the_person() {
        // A wide title that still carries the person: the text legitimately owns the
        // frame, so it is not displaced by the person-first rule.
        let graph = composition_graph_filter(
            &json!({
                "personBox": { "left": 0.30, "right": 0.52, "top": 0.1, "bottom": 0.9 },
                "textBox": { "left": 0.02, "right": 0.66, "top": 0.05, "bottom": 0.95 },
            }),
            "9:16",
            &[],
            Some((1920, 1080)),
        )
        .unwrap();
        assert!(graph.contains("max(ih*9/16\\,0.6800*iw)"), "{graph}");
        assert!(graph.contains("0.3400*iw"), "{graph}");
    }

    #[test]
    fn ignores_a_title_band_that_only_spans_the_persons_width() {
        // A burned-in title across the top of the frame shares the person's width but
        // not their height: it is secondary information, so the subject keeps the
        // anchor instead of the frame widening and then being masked over the head.
        let graph = composition_graph_filter(
            &layout(0.30, 0.52, Some((0.02, 0.66))),
            "9:16",
            &[],
            Some((1920, 1080)),
        )
        .unwrap();
        assert!(graph.contains("max(ih*9/16\\,0.2600*iw)"), "{graph}");
        assert!(graph.contains("0.4100*iw"), "{graph}");
    }

    #[test]
    fn zero_face_scene_requires_explicit_confirmed_marker_and_matching_source() {
        let plan = json!({ "sourceArtifactId": "source" });
        let scene = json!({
            "layout": "solo",
            "faceCount": 0,
            "confirmed": true,
            "sourceArtifactId": "source"
        });
        assert!(is_confirmed_zero_face_scene(&scene, Some(&plan)));

        let mut unconfirmed = scene.clone();
        unconfirmed["confirmed"] = json!(false);
        assert!(!is_confirmed_zero_face_scene(&unconfirmed, Some(&plan)));

        let mut missing_count = scene.clone();
        missing_count.as_object_mut().unwrap().remove("faceCount");
        assert!(!is_confirmed_zero_face_scene(&missing_count, Some(&plan)));

        let mut unknown_count = scene.clone();
        unknown_count["faceCount"] = json!(1);
        assert!(!is_confirmed_zero_face_scene(&unknown_count, Some(&plan)));

        let mut other_layout = scene.clone();
        other_layout["layout"] = json!("side-by-side");
        assert!(!is_confirmed_zero_face_scene(&other_layout, Some(&plan)));

        let mut wrong_source = scene.clone();
        wrong_source["sourceArtifactId"] = json!("other");
        assert!(!is_confirmed_zero_face_scene(&wrong_source, Some(&plan)));
        assert!(!is_confirmed_zero_face_scene(&scene, None));
    }

    #[test]
    fn zero_face_scene_fits_landscape_foreground_over_blurred_background() {
        let graph = zero_face_scene_graph_filter(&["setsar=1".to_string()]);
        assert!(graph.contains("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=24[bg]"), "{graph}");
        assert!(
            graph.contains("scale=1080:1920:force_original_aspect_ratio=decrease[fg]"),
            "{graph}"
        );
        assert!(graph.contains("overlay=(W-w)/2:(H-h)/2"), "{graph}");
        assert!(graph.ends_with(";[pad0]setsar=1[vout]"), "{graph}");
    }

    #[test]
    fn falls_back_to_the_centre_crop_when_no_person_is_detected() {
        // No person box at all: the composition path refuses, so the caller keeps its
        // plain centre crop (the safe fallback when detection is unavailable).
        assert!(composition_graph_filter(
            &json!({ "textBox": { "left": 0.1, "right": 0.9, "top": 0.5, "bottom": 0.6 } }),
            "9:16",
            &[],
            Some((1920, 1080)),
        )
        .is_none());
        assert!(composition_graph_filter(&json!({}), "9:16", &[], Some((1920, 1080))).is_none());
    }

    #[test]
    fn ignores_out_of_range_resolved_geometry_and_keeps_the_crop_in_bounds() {
        // A layout that carries a broken centerX/frameWidth falls back to the person's
        // own geometry instead of pushing the crop outside the source frame.
        let mut broken = layout(0.30, 0.52, Some((0.70, 0.98)));
        broken["centerX"] = json!(1.4);
        broken["frameWidth"] = json!(1.5);
        let graph = composition_graph_filter(&broken, "9:16", &[], Some((1920, 1080))).unwrap();
        assert!(graph.contains("0.4100*iw"), "{graph}");
        assert!(graph.contains("max(ih*9/16\\,0.2600*iw)"), "{graph}");
        assert!(
            graph.contains("crop=") && graph.contains("max(0\\,min(iw-("),
            "the crop must be clamped into the source: {graph}"
        );

        // A zero or negative frame width is invalid too, and out-of-range person
        // coordinates cannot escape 0..1 through the resolved geometry.
        for width in [json!(0.0), json!(-1.0), json!(f64::NAN)] {
            let mut value = layout(0.30, 0.52, None);
            value["frameWidth"] = width;
            let graph = composition_graph_filter(&value, "9:16", &[], None).unwrap();
            assert!(graph.contains("0.2600*iw"), "{graph}");
        }
        let shifted = layout(-0.30, 0.52, Some((0.70, 0.98)));
        let graph = composition_graph_filter(&shifted, "9:16", &[], Some((1920, 1080))).unwrap();
        assert!(graph.contains("max(0\\,min(iw-("), "{graph}");
    }

    #[test]
    fn never_builds_a_window_wider_than_the_source() {
        // A source taller than 9:16 would make ih*9/16 exceed iw; the window clamps to
        // the source width so crop cannot fail with a too-big geometry.
        let graph = composition_graph_filter(
            &json!({ "centerX": 0.5, "frameWidth": 1.0 }),
            "9:16",
            &[],
            Some((1080, 2400)),
        )
        .unwrap();
        assert!(
            graph.contains("2*ceil(min(iw\\,max(ih*9/16\\,1.0000*iw))/2)"),
            "{graph}"
        );
    }

    #[test]
    fn holds_one_constant_window_per_piece_for_temporal_stability() {
        // The composition crop is a constant offset, never a function of t, so
        // consecutive frames cannot jitter; scene changes come from piece boundaries.
        let graph = composition_graph_filter(
            &layout(0.30, 0.52, Some((0.70, 0.98))),
            "9:16",
            &["setsar=1".to_string()],
            Some((1920, 1080)),
        )
        .unwrap();
        let crop = graph
            .split_once("crop=")
            .and_then(|(_, rest)| rest.split_once(",split=2"))
            .map(|(crop, _)| crop)
            .expect("composition graph must carry a crop filter");
        assert!(
            !crop.contains('t'),
            "the crop must not animate per frame: {crop}"
        );
    }

    #[test]
    fn resolves_the_crop_from_the_plan_keyframes_before_any_composition() {
        // A plan that carries BOTH a confirmed manual crop path and an automatic
        // composition layout must follow the keyframes: the auto layout never
        // overrides what the user configured in the Editor.
        let plan = json!({
            "sourceArtifactId": "src",
            "speakerMap": { "A": "face-1" },
            "cropKeyframes": [
                { "time": 0.0, "centerX": 0.2, "centerY": 0.5, "speakerId": "A", "sourceFaceId": "face-1", "confidence": 0.9, "confirmed": true, "sourceArtifactId": "src" },
                { "time": 6.0, "centerX": 0.8, "centerY": 0.5, "speakerId": "A", "sourceFaceId": "face-1", "confidence": 0.9, "confirmed": true, "sourceArtifactId": "src" }
            ],
            "compositionLayouts": [
                {
                    "start": 0.0, "end": 6.0, "confidence": 0.9, "confirmed": true, "sourceArtifactId": "src",
                    "personBox": { "left": 0.4, "right": 0.6, "top": 0.1, "bottom": 0.9 },
                    "centerX": 0.5, "frameWidth": 0.4
                }
            ]
        });
        assert!(has_confirmed_crop_keyframes(&plan));

        // An unapproved tracking run, an unconfirmed mapping (confidence below the
        // renderer's 0.5 gate), a foreign artifact, a lost face mapping and a keyframe
        // with no speaker link must not count as a manual path, so the automatic
        // composition still applies for them.
        for keyframes in [
            json!([{ "time": 0.0, "centerX": 0.2, "speakerId": "A", "sourceFaceId": "face-1", "confidence": 0.9, "confirmed": false, "sourceArtifactId": "src" }]),
            json!([{ "time": 0.0, "centerX": 0.2, "speakerId": "A", "sourceFaceId": "face-1", "confidence": 0.4, "confirmed": true, "sourceArtifactId": "src" }]),
            json!([{ "time": 0.0, "centerX": 0.2, "speakerId": "A", "sourceFaceId": "face-1", "confidence": 0.9, "confirmed": true, "sourceArtifactId": "other" }]),
            json!([{ "time": 0.0, "centerX": 0.2, "speakerId": "A", "sourceFaceId": "face-2", "confidence": 0.9, "confirmed": true, "sourceArtifactId": "src" }]),
            json!([{ "time": 0.0, "centerX": 0.2, "confidence": 0.9, "confirmed": true, "sourceArtifactId": "src" }]),
            json!([]),
        ] {
            let mut candidate = plan.clone();
            candidate["cropKeyframes"] = keyframes;
            assert!(!has_confirmed_crop_keyframes(&candidate), "{candidate}");
        }
        assert!(!has_confirmed_crop_keyframes(&json!({})));
    }

    #[test]
    fn prefers_the_resolved_center_and_width_when_present() {
        let mut value = layout(0.30, 0.52, Some((0.02, 0.66)));
        value["centerX"] = json!(0.40);
        value["frameWidth"] = json!(0.75);
        let graph = composition_graph_filter(&value, "9:16", &[], Some((1920, 1080))).unwrap();
        assert!(graph.contains("max(ih*9/16\\,0.7500*iw)"), "{graph}");
        assert!(graph.contains("0.4000*iw"), "{graph}");
    }

    #[test]
    fn uses_resolved_layout_without_source_boxes() {
        let value = json!({ "centerX": 0.5, "frameWidth": 0.8 });
        let graph = composition_graph_filter(&value, "9:16", &[], Some((1920, 1080))).unwrap();
        assert!(graph.contains("0.8000*iw"), "{graph}");
        assert!(graph.contains("0.5000*iw"), "{graph}");
    }

    #[test]
    fn delogo_uses_normalized_source_coordinates_and_rejects_invalid_boxes() {
        let value = json!({ "textBox": { "left": 0.1, "right": 0.4, "top": 0.7, "bottom": 0.8 } });
        assert_eq!(
            text_box_delogo_filter(&value, (1920, 1080)).as_deref(),
            Some("delogo=x=192:y=756:w=576:h=108:show=0")
        );
        let invalid =
            json!({ "textBox": { "left": -0.1, "right": 0.4, "top": 0.7, "bottom": 0.8 } });
        assert!(text_box_delogo_filter(&invalid, (1920, 1080)).is_none());
    }

    #[test]
    fn delogo_insets_boxes_that_touch_the_frame_border() {
        // A full-frame title band is legitimate composition data, but `delogo`
        // rejects a box touching the border — the mask has to shrink inside it
        // instead of failing the whole render.
        let full = json!({ "textBox": { "left": 0.0, "right": 1.0, "top": 0.0, "bottom": 1.0 } });
        assert_eq!(
            text_box_delogo_filter(&full, (1280, 720)).as_deref(),
            Some("delogo=x=1:y=1:w=1278:h=718:show=0")
        );
        let band = json!({ "textBox": { "left": 0.0, "right": 1.0, "top": 0.02, "bottom": 0.35 } });
        assert_eq!(
            text_box_delogo_filter(&band, (1280, 720)).as_deref(),
            Some("delogo=x=1:y=14:w=1278:h=238:show=0")
        );
        // A box that collapses once inset is dropped rather than emitted invalid.
        let hairline =
            json!({ "textBox": { "left": 0.0, "right": 0.0005, "top": 0.5, "bottom": 0.6 } });
        assert!(text_box_delogo_filter(&hairline, (1280, 720)).is_none());
    }

    #[test]
    fn delogo_never_masks_the_primary_subject() {
        let person = json!({
            "left": 0.2984, "right": 0.4672, "top": 0.16, "bottom": 0.90
        });
        // A caption band sitting over the subject: masking it would erase the
        // person, so the burn-in stays and the subject survives.
        let over = json!({
            "personBox": person,
            "textBox": { "left": 0.0, "right": 1.0, "top": 0.0, "bottom": 1.0 }
        });
        assert!(text_box_delogo_filter(&over, (1280, 720)).is_none());
        // A lower third below the subject is safe to mask.
        let below = json!({
            "personBox": person,
            "textBox": { "left": 0.05, "right": 0.95, "top": 0.78, "bottom": 0.98 }
        });
        assert!(text_box_delogo_filter(&below, (1280, 720)).is_some());
        // So is a title band above the subject.
        let above = json!({
            "personBox": person,
            "textBox": { "left": 0.0, "right": 1.0, "top": 0.02, "bottom": 0.14 }
        });
        assert!(text_box_delogo_filter(&above, (1280, 720)).is_some());
    }

    #[test]
    fn masks_source_before_composition_split_and_caption_tail() {
        let value = json!({
            "personBox": { "left": 0.30, "right": 0.52, "top": 0.1, "bottom": 0.9 },
            "textBox": { "left": 0.2, "right": 0.8, "top": 0.75, "bottom": 0.88 }
        });
        let graph = composition_graph_filter(
            &value,
            "9:16",
            &["ass=captions.ass".to_string()],
            Some((1920, 1080)),
        )
        .unwrap();
        let mask = graph.find("delogo=").unwrap();
        let split = graph.find("split=2").unwrap();
        let caption = graph.find("ass=captions.ass").unwrap();
        assert!(mask < split && split < caption, "{graph}");
    }

    #[test]
    fn chains_the_tail_filters_onto_the_composed_frame() {
        let graph = composition_graph_filter(
            &layout(0.30, 0.52, None),
            "9:16",
            &[
                "drawtext=x".to_string(),
                "ass=y.ass".to_string(),
                "setsar=1".to_string(),
            ],
            None,
        )
        .unwrap();
        assert!(
            graph.contains(";[pad0]drawtext=x[pad1];[pad1]ass=y.ass[pad2];[pad2]setsar=1[vout]"),
            "{graph}"
        );
    }

    #[test]
    fn optional_word_timing_emits_karaoke_tags_and_keeps_safe_area_margins() {
        let captions = vec![
            serde_json::json!({
                "text": "hello world",
                "start": 1.0,
                "end": 3.0,
                "words": [
                    {"text": "hello", "start": 1.0, "end": 2.0},
                    {"text": "world", "start": 2.0, "end": 3.0},
                ],
            }),
            serde_json::json!({"text": "plain caption", "start": 4.0, "end": 5.0}),
        ];
        let ass = ass_dialogue(&captions, 0.5, 5.0, 650)
            .unwrap()
            .unwrap();
        assert!(ass.contains("{\\k0}hello{\\k100} world"), "{ass}");
        assert!(!ass.contains("hello\\k"), "override tag leaked as text: {ass}");
        assert!(ass.contains("plain caption") && !ass.contains("plain\\k"), "{ass}");
        assert!(ass.contains("MarginV, Encoding") || ass.contains("40,40,650"), "{ass}");
        assert!(ass.contains("40,40,650"), "{ass}");
    }

    #[test]
    fn partial_word_timing_clips_to_caption_and_single_range() {
        let captions = vec![
            serde_json::json!({
                "text": "hello world",
                "start": 1.0,
                "end": 3.0,
                "words": [
                    {"text": "hello", "start": 1.0, "end": 2.0},
                    {"text": "world", "start": 2.0, "end": 3.0},
                ],
            }),
        ];
        let first = ass_dialogue(&captions, 6.0, 2.0, 650).unwrap();
        assert_eq!(first, None, "the caption is outside this range");
        let second = ass_dialogue(&captions, 2.0, 1.0, 650)
            .unwrap()
            .unwrap();
        assert!(second.contains("world"), "{second}");
        assert!(!second.contains("hello"), "{second}");
    }

    #[test]
    fn multiline_word_timing_falls_back_to_source_caption_text() {
        let captions = vec![
            serde_json::json!({
                "text": "hello\nworld",
                "start": 1.0,
                "end": 3.0,
                "words": [
                    {"text": "hello", "start": 1.0, "end": 2.0},
                    {"text": "world", "start": 2.0, "end": 3.0},
                ],
            }),
        ];
        let ass = ass_dialogue(&captions, 0.0, 4.0, 650)
            .unwrap()
            .unwrap();
        assert!(!ass.contains("hello\\k"), "{ass}");
    }

    #[test]
    fn rejects_other_ratios_and_broken_layouts() {
        assert_eq!(
            composition_graph_filter(&layout(0.30, 0.52, None), "1:1", &[], None),
            None
        );
        assert_eq!(
            composition_graph_filter(&json!({}), "9:16", &[], Some((1920, 1080))),
            None
        );
    }
}
