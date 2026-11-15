<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { invoke, isTauri, Channel } from "@tauri-apps/api/core";
  import { open, save } from "@tauri-apps/plugin-dialog";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { isActiveHighlight, type Highlight, type HighlightStatus } from "../../../../../packages/contracts/highlight.ts";
  import type { Collection } from "../../../../../packages/contracts/collection.ts";
  import type { Transcript } from "../../../../../packages/contracts/transcript.ts";
  import { applySpeakerIntervals, transcriptSpeakerIds, speakerExamples } from "../../../../../services/ai-pipeline/diarization.ts";
  import type { EditVariant, RenderPlan } from "../../../../../packages/contracts/render-plan.ts";
  import { mapEditVariantProposals, VARIANT_PROMPT_VERSION } from "../../../../../services/ai-pipeline/variants.ts";
  import { exportFileName } from "../export-file-name.ts";
  import { enqueueProjectSave } from "../project-save-queue.ts";
  import { studioState } from "../studio-state.svelte.ts";
  import { captionsFromTranscript, createEditorState, createEditorStateFromVariant } from "../../../../../packages/editor-core/index.ts";
  import { refreshRuntime, runtimeStore } from "../runtime-status.svelte.ts";
  import Icon from "../icons.svelte";
  import RelatedYoutubeSearch from "../components/RelatedYoutubeSearch.svelte";
  // Generated from the Rust declarations in apps/desktop/src-tauri/src/main.rs: if the
  // wire contract changes, regenerate (`npm run contracts:generate`) and the drift test
  // fails until both sides agree. Hand-written copies here caused the probe bug where
  // TypeScript expected camelCase keys that ffprobe/Rust never sent.
  import type { ProbeMetadata, RenderProgress } from "../../../../../packages/contracts/generated/generated.ts";

  // Keep-alive mounted by +layout.svelte: `active` tells this page it is the
  // visible one, so background polls only run while the user can see them.
  let { active = true }: { active?: boolean } = $props();

  type AnalysisResult = { transcript?: Transcript; highlights?: Highlight[]; scriptOutline?: { id: string; start: number; end: number; text: string }[]; summaryVariants?: EditVariant[]; collections?: Collection[]; videoId?: string; title?: string; topic?: string };
  type AnalysisJob = { status: string; phase: string; progress: number; chunkCompleted: number; chunkTotal: number; currentChunk?: number; result?: AnalysisResult; error?: string };
  type RenderRequest = { input: string; output: string; plan: RenderPlan };
  type Meta = { name: string; duration: number; width: number; height: number; sourceArtifactId?: string };
  const e2eVideo = import.meta.env.MODE === "desktop-e2e" && import.meta.env.VITE_DESKTOP_E2E === "1" ? import.meta.env.VITE_DESKTOP_E2E_VIDEO : "";
  const e2eOutput = import.meta.env.MODE === "desktop-e2e" && import.meta.env.VITE_DESKTOP_E2E === "1" ? import.meta.env.VITE_DESKTOP_E2E_OUTPUT : "";
  type JobRow = { id: string; input?: string; status: string; phase: string; progress: number; rangeStart?: number; rangeEnd?: number; chunkCompleted?: number; chunkTotal?: number; error?: string };
  type RenderRecord = { id?: string; output: string; status: "running" | "completed" | "failed" | "interrupted" | "cancelled"; highlightId: string; error?: string };
  type Project = { id: string; revision: number; title: string; sourcePath: string; sourceName: string; sourceDuration: number; analysisJobId: string | null; analysisResultId?: string | null; transcript: unknown | null; highlights: Highlight[]; selectedId: string | null; selectedIds?: string[]; plans: Record<string, RenderPlan>; variants?: EditVariant[]; summaryVariants?: EditVariant[]; scriptOutline?: Array<{ id: string; start: number; end: number; text: string }>; selectedVariantId?: string | null; speakerFaceMatches?: { version: 1; sourceArtifactId: string; confirmed: boolean; matches: Record<string, string> } | null; renders: RenderRecord[]; updatedAt: string };

  let projects = $state<Project[]>([]);
  let projectId = $state("");
  let inputPath = $state("");
  let outputPath = $state("");
  let analyzeStart = $state(0);
  let analyzeEnd = $state(600);
  let aspectRatio = $state("9:16");
  // Design default: exports are burned with subtitles. The toggle exists only so a
  // user can take a clean clip into their own editor.
  let burnCaptions = $state(true);
  let message = $state("Drop a video to begin.");
  let busy = $state(false);
  let jobId = $state("");
  let projectLinkWarning = $state(false);
  let phase = $state("");
  let progress = $state(0);
  let elapsedSeconds = $state(0);
  let renderProgress = $state(0);
  let rendering = $state(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  let pollRun = 0;
  let watchStarted = false;
  let watcherId = "";
  let timerStartedAt = 0;
  let highlights = $state<Highlight[]>([]);
  let collections = $state<Collection[]>([]);
  let selectedCollection = $state("");
  let selectedId = $state("");
  let selectedIds = $state<string[]>([]);
  let variants = $state<EditVariant[]>([]);
  let summaryVariants = $state<EditVariant[]>([]);
  let scriptOutline = $state<Array<{ id: string; start: number; end: number; text: string }>>([]);
  let selectedVariantId = $state("");
  let variantsBusy = $state(false);
  let diarizationBusy = $state(false);
  let faceSamplesBusy = $state(false);
  let speakerMatches = $state<Record<string, string>>({});
  let faceSamples = $state<Array<{ id: string; speakerId: string; time: number; thumbnail: string }>>([]);
  let diarizedSourceId = $state("");
  let speakerMatchesConfirmed = $state(false);
  let diarizationReady = $state(false);
  let faceModelReady = $state(false);
  let youtubeUrl = $state("");
  let youtubeVideoId = $state("");
  let relatedQuery = $state("");
  let relatedSourceText = $state("");
  // Loopback base for the preview iframe: the packaged webview's tauri:// origin
  // carries no Referer, which YouTube rejects (error 153). Empty in the browser,
  // where the plain embed already works.
  let previewBase = $state("");
  let selectedCandidate = $derived(highlights.find((item) => item.id === selectedId) ?? null);
  let activeHighlights = $derived(highlights.filter(isActiveHighlight));
  let activeSelectedIds = $derived(selectedIds.filter((id) => activeHighlights.some((item) => item.id === id)));
  // Step 4 is only "done" when a render actually finished. A failed or
  // cancelled attempt is still a row in renders[], so counting rows marked the
  // workflow complete without an export.
  let exportedCount = $derived((projects.find((item) => item.id === projectId)?.renders ?? []).filter((render) => render.status === "completed").length);
  function dominantAxisLabel(candidate: Highlight): string | undefined {
    if (!candidate.dominantAxis) return;
    const labels = studioState.transcript?.language.toLowerCase().startsWith("vi")
      ? { hook: "Mở đầu", summary: "Tóm tắt", impact: "Tác động" }
      : { hook: "Hook", summary: "Summary", impact: "Impact" };
    return labels[candidate.dominantAxis];
  }
  // Highlight ids belonging to the selected collection, so the candidate list
  // can mark which clips the grouping picked. Empty when nothing is selected.
  let collectionMembers = $derived(new Set(
    collections.find((collection) => collection.id === selectedCollection)?.items
      .map((item) => (item.reference.kind === "highlight" ? item.reference.highlightId : "")) ?? []
  ));
  function pickCollection(collection: Collection) {
    selectedCollection = collection.id;
    const first = collection.items[0]?.reference;
    if (first?.kind === "highlight" && highlights.some((item) => item.id === first.highlightId)) selectedId = first.highlightId;
  }
  let meta = $state<Meta | null>(null);
  let sourceVerified = $state(false);
  let probeError = $state("");
  let dragOver = $state(false);
  let folderFiles = $state<string[]>([]);
  let recording = $state(false);
  let cameraSupported = $state(false);
  let recorder: MediaRecorder | null = null;
  let recordingStream: MediaStream | null = null;
  let recordingChunks: Blob[] = [];
  let resumableJobs = $state<JobRow[]>([]);
  let currentStep = $state<1 | 2 | 3 | 4>(1);

  // Manual clip fallback when Whisper/runtime is not ready.
  let manualStart = $state(0);
  let manualEnd = $state(0);
  let manualAspectRatio = $state("9:16");
  let manualBusy = $state(false);
  let manualFallbackOpen = $state(false);

  async function choose() {
    if (!isTauri()) { message = "File dialogs only work in the desktop app — open the installed app to load a video."; return; }
    if (e2eVideo) { await loadVideo(e2eVideo); return; }
    const path = await open({ multiple: false, directory: false, filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "mts", "m2ts", "3gp"] }] });
    if (typeof path === "string") { folderFiles = []; await loadVideo(path); }
  }

  async function chooseFolder() {
    if (!isTauri()) { message = "Folder import only works in the desktop app."; return; }
    const path = await open({ multiple: false, directory: true });
    if (typeof path !== "string") return;
    await importPath(path);
  }

  async function importPath(path: string) {
    try {
      const files = await invoke<string[]>("list_video_files", { path });
      if (!files.length) { message = "No supported video files were found in that location."; return; }
      folderFiles = files;
      message = files.length === 1 ? "Video found. Verifying…" : `${files.length} videos found. Choose one to verify.`;
      await loadVideo(files[0]);
    } catch (error) {
      folderFiles = [];
      await loadVideo(path);
    }
  }
  async function startCameraRecording() {
    if (!isTauri()) { message = "Camera recording is available in the desktop app."; return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { message = "This desktop runtime does not support camera recording. Record with the system camera, then import the file."; return; }
    try {
      recordingStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
      recorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
      recordingChunks = [];
      recorder.ondataavailable = (event) => { if (event.data.size) recordingChunks.push(event.data); };
      recorder.onerror = () => { message = "Camera recording failed. You can record with the system camera and import the file instead."; stopCameraRecording(); };
      recorder.onstop = async () => {
        const currentRecorder = recorder;
        const blob = new Blob(recordingChunks, { type: currentRecorder?.mimeType || "video/webm" });
        recordingChunks = [];
        recorder = null;
        try {
          const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
          const path = await invoke<string>("save_recording", { data: bytes });
          await importPath(path);
        } catch (error) { message = `Could not save camera recording: ${String(error)}`; }
      };
      recorder.start(1000);
      recording = true;
      message = "Recording camera video… click Stop recording when finished.";
    } catch (error) {
      recording = false;
      recordingStream?.getTracks().forEach((track) => track.stop());
      recordingStream = null;
      message = `Camera access failed: ${String(error)}. You can import a camera file instead.`;
    }
  }

  function stopCameraRecording() {
    if (!recorder || recorder.state === "inactive") return;
    recording = false;
    recorder.stop();
    recordingStream?.getTracks().forEach((track) => track.stop());
    recordingStream = null;
  }



  async function refreshDiarizationStatus() {
    if (!isTauri()) return;
    try {
      const status = await invoke<{ ortAvailable: boolean; faceModelReady: boolean; vadModelReady: boolean; ready: boolean }>("diarization_setup_status");
      diarizationReady = status.ready; faceModelReady = status.faceModelReady;
    } catch { diarizationReady = false; faceModelReady = false; }
  }

  async function runDiarization() {
    const transcript = studioState.transcript;
    if (!isTauri() || !transcript || diarizationBusy || !inputPath || inputPath.startsWith("http")) return;
    if (!diarizationReady) { message = "Local diarization needs the bundled ONNX runtime and silero_vad model. Check Settings for runtime readiness."; return; }
    diarizationBusy = true; message = "Running local speaker diarization…";
    try {
      const intervals = await invoke<unknown>("diarize_video", { path: inputPath, duration: Math.min(meta?.duration ?? transcript.duration, 1800) });
      const updated = applySpeakerIntervals(transcript, intervals);
      studioState.transcript = updated;
      diarizedSourceId = updated.sourceArtifactId;
      speakerMatches = {}; speakerMatchesConfirmed = false; faceSamples = [];
      studioState.speakerFaceMatches = {}; studioState.speakerFaceConfirmed = false;
      await persistProject({ transcript: updated, speakerFaceMatches: null });
      message = `Diarization complete: ${transcriptSpeakerIds(updated).length} speakers found. Review the labels and confirm any face matches.`;
    } catch (error) { message = `Diarization failed: ${String(error)}`; }
    finally { diarizationBusy = false; }
  }

  async function sampleFaces() {
    const transcript = studioState.transcript;
    if (!isTauri() || !transcript || faceSamplesBusy || !inputPath || inputPath.startsWith("http")) return;
    const speakers = transcriptSpeakerIds(transcript);
    if (!speakers.length) return;
    const samples = speakers.slice(0, 8).map((speakerId) => {
      const segment = transcript.segments.find((item) => item.speakerId === speakerId);
      const midpoint = segment ? (segment.start + segment.end) / 2 : transcript.words.find((word) => word.speakerId === speakerId)?.start ?? 0;
      return { speakerId, time: Math.max(0, Math.min(midpoint, Math.max(0, (meta?.duration ?? transcript.duration) - 0.05))) };
    });
    faceSamplesBusy = true; message = "Sampling temporary face crops locally…";
    try {
      const detected = await invoke<Array<{ id: string; speakerId: string; time: number; thumbnail: string }>>("sample_speaker_faces", { path: inputPath, speakers: samples });
      faceSamples = detected.slice(0, 32).map((sample) => ({ ...sample, thumbnail: speakerFaceDataUrl(sample.thumbnail) })).filter((sample) => sample.thumbnail);
      message = faceSamples.length ? `${faceSamples.length} temporary face samples ready. Choose matches, then confirm.` : "No faces were detected in the sampled frames.";
    } catch (error) { message = `Face sampling failed: ${String(error)}`; }
    finally { faceSamplesBusy = false; }
  }

  async function cancelSpeakerMatches() {
    const transcript = studioState.transcript;
    if (transcript) {
      const words = transcript.words.map(({ speakerId: _speakerId, ...word }) => word);
      const segments = transcript.segments.map(({ speakerId: _speakerId, ...segment }) => segment);
      studioState.transcript = { ...transcript, words, segments };
      await persistProject({ transcript: studioState.transcript, speakerFaceMatches: null });
    }
    clearSpeakerState();
    message = "Diarization and face-match changes cancelled.";
  }

  async function confirmSpeakerMatches() {
    const transcript = studioState.transcript;
    if (!transcript) return;
    const speakers = transcriptSpeakerIds(transcript);
    const sampleIds = new Set(faceSamples.map((sample) => sample.id));
    const clean: Record<string, string> = {};
    const usedSamples = new Set<string>();
    for (const speakerId of speakers) {
      const selected = speakerMatches[speakerId];
      if (selected && sampleIds.has(selected) && !usedSamples.has(selected) && faceSamples.some((sample) => sample.id === selected && sample.speakerId === speakerId)) { clean[speakerId] = selected; usedSamples.add(selected); }
    }
    speakerMatches = clean; diarizedSourceId = transcript.sourceArtifactId; speakerMatchesConfirmed = true;
    studioState.speakerFaceMatches = clean; studioState.speakerFaceConfirmed = true;
    const saved = await persistProject({ speakerFaceMatches: { version: 1, sourceArtifactId: diarizedSourceId, confirmed: true, matches: clean } });
    // A failed save already set an error message; do not overwrite it with "saved".
    if (!projectId) message = "Speaker labels and face matches confirmed.";
    else if (saved) message = "Speaker labels and face matches confirmed and saved with this project.";
  }

  function speakerFaceDataUrl(thumbnail: string): string {
    if (thumbnail.startsWith("data:image/jpeg;base64,")) return thumbnail;
    if (!/^(?:[0-9a-f]{2})+$/i.test(thumbnail)) return "";
    const binary = (thumbnail.match(/.{2}/g) ?? []).map((byte) => String.fromCharCode(parseInt(byte, 16))).join("");
    return `data:image/jpeg;base64,${btoa(binary)}`;
  }

  function clearSpeakerState() {
    speakerMatches = {}; faceSamples = []; diarizedSourceId = ""; speakerMatchesConfirmed = false;
    studioState.speakerFaceMatches = {}; studioState.speakerFaceConfirmed = false;
  }

  async function refreshProjects() {
    if (!isTauri()) return;
    try { projects = await invoke<Project[]>("project_list"); } catch { projects = []; }
  }

  async function persistProject(patch: Partial<Project> = {}): Promise<boolean> {
    if (!isTauri() || !projectId) return false;
    const saveProjectId = projectId;
    return enqueueProjectSave(saveProjectId, async () => {
      const existing = projects.find((item) => item.id === saveProjectId);
      if (!existing) return false;
      const next = { ...existing, sourcePath: inputPath || existing.sourcePath, sourceName: meta?.name ?? existing.sourceName, sourceDuration: meta?.duration ?? existing.sourceDuration, highlights, selectedId: selectedId || existing.selectedId, selectedIds, plans: studioState.plans, variants, summaryVariants, scriptOutline, selectedVariantId: selectedVariantId || null, speakerFaceMatches: speakerMatchesConfirmed && diarizedSourceId === (studioState.transcript?.sourceArtifactId ?? "") ? { version: 1, sourceArtifactId: diarizedSourceId, confirmed: true, matches: speakerMatches } : null, ...patch };

      try {
        const saved = await invoke<Project>("project_save", { project: { ...next, revision: existing.revision } });
        projects = [saved, ...projects.filter((item) => item.id !== saved.id)];
        if (projectId === saveProjectId) studioState.projectRevision = saved.revision;
        return true;
      } catch (error) {
        message = String(error).includes("PROJECT_REVISION_CONFLICT")
          ? "Project changed elsewhere. Reload it before saving again."
          : `Project save failed: ${String(error)}`;
        return false;
      }
    });
  }

  async function persistRender(render: RenderRecord): Promise<boolean> {
    const current = projects.find((item) => item.id === projectId)?.renders ?? [];
    const renders = render.id ? current.map((item) => item.id === render.id ? render : item) : [...current, render];
    if (render.id && !current.some((item) => item.id === render.id)) renders.push(render);
    return persistProject({ renders });
  }

  function renderEntry(output: string, highlightId: string): RenderRecord {
    return { id: crypto.randomUUID(), output, status: "running", highlightId };
  }

  async function openProject(id: string) {
    try {
      const project = await invoke<Project>("project_get", { id });
      await hydrateProject(project);
    } catch (error) { message = `Could not open project: ${String(error)}`; }
  }

  async function hydrateProject(loaded: Project) {
    let project = loaded;
    projects = [project, ...projects.filter((item) => item.id !== project.id)];
    projectId = project.id; inputPath = project.sourcePath; sourceVerified = false; probeError = ""; studioState.projectRevision = project.revision; meta = { name: project.sourceName, duration: project.sourceDuration, width: 0, height: 0 };
    const rendered = (project.renders ?? []).map((render) => render.status === "running" ? { ...render, status: "interrupted" as const } : render);
    if (rendered.some((render, index) => render !== (project.renders ?? [])[index])) {
      if (await persistProject({ renders: rendered })) project = projects.find((item) => item.id === project.id) ?? project;
    }
    applyDefaultRange(Number(project.sourceDuration ?? 0));
    await refreshDiarizationStatus();
    faceSamples = []; diarizationBusy = false; faceSamplesBusy = false;
    highlights = project.highlights ?? [];
    // Discarded highlights must not drive the active selection on reopen.
    const activeIds = new Set(highlights.filter(isActiveHighlight).map((item) => item.id));
    selectedId = activeIds.has(project.selectedId ?? "")
      ? project.selectedId as string
      : highlights.find((item) => isActiveHighlight(item))?.id ?? "";
    selectedIds = project.selectedIds?.length
      ? project.selectedIds.filter((id) => activeIds.has(id))
      : (selectedId ? [selectedId] : []);
    studioState.selectedIds = selectedIds;
    studioState.projectId = project.id; studioState.sourcePath = project.sourcePath; studioState.sourceName = project.sourceName; studioState.sourceDuration = project.sourceDuration;
    studioState.highlights = highlights; studioState.transcript = project.transcript as typeof studioState.transcript; studioState.selectedId = selectedId;
    studioState.plans = project.plans ?? {}; studioState.variants = project.variants ?? []; studioState.selectedVariantId = project.selectedVariantId ?? ""; variants = studioState.variants; summaryVariants = project.summaryVariants ?? []; scriptOutline = project.scriptOutline ?? []; studioState.summaryVariants = summaryVariants; studioState.scriptOutline = scriptOutline; selectedVariantId = studioState.selectedVariantId;
    const mapping = project.speakerFaceMatches;
    const mappingMatchesTranscript = mapping?.sourceArtifactId === studioState.transcript?.sourceArtifactId;
    speakerMatches = mappingMatchesTranscript ? mapping?.matches ?? {} : {};
    speakerMatchesConfirmed = mappingMatchesTranscript && !!mapping?.confirmed;
    diarizedSourceId = speakerMatchesConfirmed ? mapping?.sourceArtifactId ?? "" : "";
    studioState.speakerFaceMatches = speakerMatches; studioState.speakerFaceConfirmed = speakerMatchesConfirmed;
    studioState.editingVariantId = ""; studioState.plan = studioState.plans[selectedId] ?? null;
    currentStep = highlights.length ? 4 : 2; message = "Project reopened.";
    if (project.sourcePath && !/^https?:\/\//i.test(project.sourcePath)) {
      try {
        const probe = await invoke<ProbeMetadata>("probe_video", { path: project.sourcePath });
        const stream = (probe.streams ?? []).find((item) => item.codec_type === "video");
        const duration = Number(probe.format?.duration ?? 0);
        if (!stream || !Number.isFinite(duration) || duration <= 0) throw new Error("MEDIA_NOT_VERIFIED: ffprobe returned no valid video stream or duration");
        meta = { name: project.sourceName, duration, width: Number(stream.width ?? 0), height: Number(stream.height ?? 0) };
        sourceVerified = true;
        applyDefaultRange(duration);
      } catch (error) { probeError = String(error); message = `Source could not be verified: ${probeError}`; }
    } else sourceVerified = /^https?:\/\//i.test(project.sourcePath) && Number.isFinite(project.sourceDuration) && project.sourceDuration > 0;
    if (!project.transcript || !project.highlights.length) {
      if (project.analysisJobId) {
      try {
        const job = await invoke<AnalysisJob>("analysis_status", { id: project.analysisJobId });
        if (job.status === "completed" && job.result) {
          const result = job.result;
          highlights = result.highlights ?? []; collections = result.collections ?? []; selectedCollection = collections[0]?.id ?? ""; selectedId = highlights[0]?.id ?? ""; selectedIds = selectedId ? [selectedId] : []; studioState.selectedIds = selectedIds;
          variants = project.variants ?? []; studioState.variants = variants; studioState.selectedVariantId = project.selectedVariantId ?? ""; selectedVariantId = studioState.selectedVariantId;
          summaryVariants = result.summaryVariants ?? project.summaryVariants ?? []; scriptOutline = result.scriptOutline ?? project.scriptOutline ?? []; studioState.summaryVariants = summaryVariants; studioState.scriptOutline = scriptOutline;
          studioState.highlights = highlights; studioState.selectedId = selectedId; studioState.transcript = result.transcript ?? null;
          await persistProject({ analysisJobId: project.analysisJobId, transcript: result.transcript ?? null, highlights, selectedId, summaryVariants, scriptOutline });
          message = highlights.length ? `${highlights.length} highlight candidates restored from analysis.` : "Analysis restored; no highlights found.";
        } else if (job.status === "queued" || job.status === "running") void watch(project.analysisJobId, true);
      } catch (error) { message = `Could not restore analysis job: ${String(error)}`; }
      } else if (!project.transcript) message = "This project has no saved analysis result yet.";
    }
  }

  /// Re-point an opened project at a new local file when the saved source is
  /// gone (moved, renamed, deleted). The replacement must be ffprobe-verifiable
  /// and run within 2 s of the saved duration, so highlights keep landing on
  /// the same footage instead of being grafted onto different work.
  async function relinkMedia() {
    if (!isTauri() || !projectId) return;
    const path = await open({ multiple: false, directory: false, filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "mts", "m2ts", "3gp"] }] });
    if (typeof path !== "string") return;
    try {
      const probe = await invoke<ProbeMetadata>("probe_video", { path });
      const stream = (probe.streams ?? []).find((item) => item.codec_type === "video");
      const duration = Number(probe.format?.duration ?? 0);
      if (!stream || !Number.isFinite(duration) || duration <= 0) throw new Error("MEDIA_NOT_VERIFIED: ffprobe returned no valid video stream or duration");
      if (meta && meta.duration > 0 && Math.abs(duration - meta.duration) > 2) {
        message = `Relink refused: the chosen file runs ${clock(duration)} but this project was saved for ${clock(meta.duration)}. Highlights must stay on the original cut.`;
        return;
      }
      meta = { name: path.split(/[\\/]/).pop() ?? path, duration, width: Number(stream.width ?? 0), height: Number(stream.height ?? 0), sourceArtifactId: path };
      inputPath = path; folderFiles = [];
      studioState.sourcePath = path; studioState.sourceName = meta.name; studioState.sourceDuration = duration;
      sourceVerified = true; probeError = "";
      applyDefaultRange(duration);
      await persistProject();
      message = "Source relinked — highlights and settings are preserved.";
    } catch (error) {
      probeError = String(error);
      message = `Could not relink source: ${String(error)}`;
    }
  }

  $effect(() => {
    const id = studioState.projectId;
    if (active && id && id !== projectId) void openProject(id);
  });

  async function ensureProject() {
    if (!isTauri() || projectId || !inputPath) return;
    try {
      const project = await invoke<Project>("project_create", { sourcePath: inputPath, sourceName: meta?.name ?? inputPath.split(/[\\\\/]/).pop() ?? inputPath, sourceDuration: meta?.duration ?? 0 });
      projectId = project.id; studioState.projectId = project.id; studioState.projectRevision = project.revision; projects = [project, ...projects];
    } catch (error) { message = `Could not create project: ${String(error)}`; }
  }

  /// Default analysis range: the whole video, no 600 s cap — a 30-minute video
  /// is scored in full instead of only its first 10 minutes.
  function applyDefaultRange(duration: number) {
    const seconds = Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : 0;
    analyzeStart = 0;
    analyzeEnd = Math.floor(Math.max(0, seconds));
    manualStart = 0;
    manualEnd = Math.floor(Math.max(0, seconds));
  }

  // Single reset path for "no source loaded". loadVideo and the Remove button
  // both need it; the old inline Remove copy forgot progress/step/range, so a
  // removed source could still look half-analysed.
  function resetSourceState() {
    projectId = ""; sourceVerified = false; probeError = ""; studioState.projectId = ""; studioState.projectRevision = 0; clearSpeakerState(); studioState.plans = {}; studioState.variants = []; variants = []; summaryVariants = []; scriptOutline = []; studioState.summaryVariants = []; studioState.scriptOutline = []; selectedVariantId = ""; studioState.selectedVariantId = ""; studioState.editingVariantId = ""; studioState.plan = null; studioState.transcript = null;
    jobId = ""; projectLinkWarning = false; busy = false; pollRun += 1; watchStarted = false; watcherId = ""; phase = ""; progress = 0; renderProgress = 0; rendering = false; currentStep = 1; highlights = []; meta = null; youtubeVideoId = "";
    studioState.highlights = []; studioState.selectedId = ""; studioState.selectedIds = [];
    // Candidate/collection/export state belongs to the removed source; keep it out of the next one.
    selectedId = ""; selectedIds = []; collections = []; selectedCollection = ""; outputPath = ""; manualFallbackOpen = false;
  }

  async function loadVideo(path: string) {
    inputPath = path;
    resetSourceState();
    await reconnectJobs(false);
    try {
      const probe = await invoke<ProbeMetadata>("probe_video", { path });
        const stream = (probe.streams ?? []).find((item) => item.codec_type === "video");
        const duration = Number(probe.format?.duration ?? 0);
        if (!stream || !Number.isFinite(duration) || duration <= 0) throw new Error("MEDIA_NOT_VERIFIED: ffprobe returned no valid video stream or duration");
        meta = { name: path.split(/[\\/]/).pop() ?? path, duration, width: Number(stream.width ?? 0), height: Number(stream.height ?? 0), sourceArtifactId: path };
      studioState.sourcePath = path; studioState.sourceName = meta.name; studioState.sourceDuration = duration; sourceVerified = true;
      applyDefaultRange(duration);
      message = "Video loaded and verified. Set the range and start analysis.";
      await ensureProject();
      await refreshProjects();
    } catch (error) {
      probeError = String(error);
      meta = { name: path.split(/[\\/]/).pop() ?? path, duration: 0, width: 0, height: 0 };
      studioState.sourcePath = path; studioState.sourceName = meta.name; studioState.sourceDuration = 0;
      message = `Video could not be verified: ${probeError}`;
    }
  }

  function onDrop(event: DragEvent) {
    dragOver = false;
    // Native Tauri drop events carry the real filesystem path; this handler
    // exists for browsers, where the File API cannot expose an absolute path.
    message = "Use the Browse button, or drop the file onto the window (desktop app).";
  }

  function stopTimer() { if (timer) clearInterval(timer); timer = undefined; }
  function resetTimer() { stopTimer(); timerStartedAt = 0; elapsedSeconds = 0; }
  function elapsedLabel() { return `${Math.floor(elapsedSeconds / 60)}m ${String(elapsedSeconds % 60).padStart(2, "0")}s`; }
  $effect(() => {
    const visible = active;
    const running = busy;
    if (!visible || !running) { stopTimer(); return; }
    if (!timerStartedAt) timerStartedAt = Date.now() - untrack(() => elapsedSeconds) * 1000;
    timer = setInterval(() => elapsedSeconds = Math.floor((Date.now() - timerStartedAt) / 1000), 1000);
    return stopTimer;
  });

  async function clearCache(id: string) {
    try { const bytes = await invoke<number>("clear_analysis_cache", { id }); resumableJobs = resumableJobs.filter((job) => job.id !== id); message = `Cleared ${(bytes / 1024 / 1024).toFixed(1)} MB for this setup.`; }
    catch (error) { message = `Cache clear failed: ${String(error)}`; }
  }
  async function retryJob(id: string) { try { await invoke("retry_analysis", { id }); await watch(id, true); } catch (error) { message = `Retry failed: ${String(error)}`; } }

  async function reconnectJobs(attach = true) {
    try { resumableJobs = await invoke<JobRow[]>("list_analysis_jobs"); } catch { resumableJobs = []; }
    const active = inputPath ? resumableJobs.find((job) => job.input === inputPath && (job.status === "queued" || job.status === "running")) : undefined;
    if (attach && active && !busy && !jobId) void watch(active.id);
  }

  /// The analysis worker's real ladder (`analysis.rs::spawn_analysis_worker_reserved`
  /// and `scripts/analyze-video.ts`): queued → probe → transcribe → rank → completed.
  const PHASE_LABELS: Record<string, string> = { queued: "Queued", probe: "Preparing input", transcribe: "Transcribing", rank: "Ranking highlights", completed: "Done", cancelled: "Stopped", failed: "Failed", interrupted: "Interrupted" };

  /// `phase` carries a "· chunk n/m" suffix while transcribing; translate only the base.
  function describePhaseValue(value: string) {
    const [base, ...rest] = value.split(" · ");
    return [PHASE_LABELS[base] ?? base, ...rest].join(" · ");
  }
  function describePhase() { return describePhaseValue(phase); }

  async function watch(id: string, resuming = true) {
    if (!active) { jobId = id; busy = true; return; }
    if (watchStarted && watcherId === id) return;
    watchStarted = true;
    watcherId = id;
    const run = ++pollRun;
    jobId = id; busy = true; if (!resuming) { phase = "queued"; progress = 0; resetTimer(); timerStartedAt = Date.now(); } currentStep = 3; message = resuming ? "Resuming analysis…" : "Analyzing…";
    try {
      let delay = 250;
      let lastProgress = -1;
      while (busy && jobId === id && pollRun === run && active) {
        const job = await invoke<AnalysisJob>("analysis_status", { id });
        if (!active || pollRun !== run || jobId !== id) break;
        // While a render runs, `busy` and the status line belong to the render: waiting
        // here keeps a finished poll from clearing busy and hiding render progress.
        if (rendering) { await new Promise((resolve) => setTimeout(resolve, 1000)); continue; }
        phase = job.chunkTotal ? `${job.phase} · chunk ${Math.min((job.currentChunk ?? job.chunkCompleted) + 1, job.chunkTotal)}/${job.chunkTotal}` : job.phase;
        progress = job.progress;
        if (job.status === "completed") {
          const result = job.result ?? { highlights: [] };
          highlights = result.highlights ?? []; selectedId = highlights[0]?.id ?? ""; selectedIds = selectedId ? [selectedId] : []; studioState.selectedIds = selectedIds;
          variants = []; studioState.variants = []; studioState.selectedVariantId = "";
          summaryVariants = result.summaryVariants ?? []; selectedVariantId = ""; scriptOutline = result.scriptOutline ?? []; studioState.summaryVariants = summaryVariants; studioState.scriptOutline = scriptOutline;
          collections = result.collections ?? []; selectedCollection = collections[0]?.id ?? "";
          if (result.videoId) youtubeVideoId = result.videoId;
          studioState.highlights = highlights; studioState.selectedId = selectedId; clearSpeakerState(); studioState.transcript = result.transcript ?? null; studioState.variants = variants; studioState.selectedVariantId = ""; studioState.editingVariantId = "";
          if (projectId) {
            const segments = (result.transcript as { segments?: { text?: string }[] } | null)?.segments ?? [];
            relatedSourceText = (segments.map((segment) => segment.text ?? "").join(" ") || result.title || highlights[0]?.title || "").slice(0, 4000);
            relatedQuery = [result.title, highlights[0]?.title, result.topic, ...segments.slice(0, 12).map((segment) => segment.text)].filter(Boolean).join(" ").slice(0, 200);
            await persistProject({ analysisJobId: id, transcript: result.transcript ?? null, highlights, selectedId, summaryVariants, scriptOutline, selectedVariantId: null });
          }

          message = projectLinkWarning ? `Analysis finished, but project recovery link is missing (${id}).` : highlights.length ? `${highlights.length} highlight candidates ready.` : "No highlights found.";
          currentStep = 4; busy = false; resetTimer(); break;
        }
        if (job.status === "failed" || job.status === "cancelled" || job.status === "interrupted") {
          message = job.status === "cancelled" ? "Analysis stopped." : `Analyze ${job.status}: ${job.error ?? "unknown error"}`;
          busy = false; resetTimer(); break;
        }
        delay = job.progress !== lastProgress ? 250 : Math.min(2000, Math.round(delay * 1.5));
        lastProgress = job.progress;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      if (pollRun === run) { message = `Resume failed: ${String(error)}`; busy = false; resetTimer(); }
    } finally { if (pollRun === run) { watchStarted = false; watcherId = ""; await reconnectJobs(false); } }
  }
  $effect(() => {
    const visible = active;
    const id = jobId;
    if (visible && busy && id && !watchStarted && !rendering) void watch(id, true);
  });

  async function analyze() {
    if (!isTauri()) { message = "Analysis runs in the desktop app only — this browser preview cannot transcribe."; return; }
    if (!inputPath || !sourceVerified || !runtimeStore.ready) { message = sourceVerified ? "Choose a verified video and wait for the runtime to be ready." : "Load and verify a video before analysis."; return; }
    // Clamp to the real duration before invoking: the backend rejects an
    // out-of-range request before creating a job, which used to look like the
    // button did nothing. Write the clamped values back so the fields match.
    const duration = Number(meta?.duration ?? 0);
    if (duration > 0) {
      analyzeEnd = Math.min(Math.max(1, Math.floor(analyzeEnd)), Math.floor(duration));
      analyzeStart = Math.min(Math.max(0, analyzeStart), analyzeEnd - 1);
    }
    const existing = resumableJobs.find((job) => job.input === inputPath && (job.status === "queued" || job.status === "running") && Math.abs((job.rangeStart ?? 0) - analyzeStart) < 0.01 && Math.abs((job.rangeEnd ?? analyzeEnd) - analyzeEnd) < 0.01);
    if (existing && confirm("Continue existing analysis? Cancel = clear this setup and start fresh.")) { await watch(existing.id, true); return; }
    if (existing) await clearCache(existing.id);
    highlights = []; collections = []; selectedCollection = ""; selectedId = ""; clearSpeakerState(); variants = []; studioState.variants = []; summaryVariants = []; scriptOutline = []; studioState.summaryVariants = []; studioState.scriptOutline = []; selectedVariantId = ""; studioState.selectedVariantId = ""; message = "Analyzing…";
    try {
      projectLinkWarning = false;
      const id = await invoke<string>("start_analysis", { path: inputPath, start: analyzeStart, end: analyzeEnd });
      jobId = id;
      if (projectId && !await persistProject({ analysisJobId: id })) {
        projectLinkWarning = true;
        message = `Analysis started (${id}), but its project link could not be saved. Keep this job ID to reconnect later.`;
      }
      await watch(id, false);
    } catch (error) { message = `Analyze failed: ${String(error)}`; busy = false; resetTimer(); }
  }

  /// Every export goes through here so the burn-subtitles toggle means the same
  /// thing for manual clips, AI candidates and edit variants. Plans edited in the
  /// Editor keep their own captions; fresh plans get them from the transcript.
  function withCaptions(plan: RenderPlan): RenderPlan {
    const captions = burnCaptions
      ? plan.captions.length ? plan.captions : plan.ranges.flatMap((range) => captionsFromTranscript(studioState.transcript, range))
      : [];
    return { ...plan, captions };
  }

  /// Manual clip: when Whisper/runtime is not ready, the user can still render a
  /// hand-picked range by calling render_video directly. This keeps the same
  /// progress/cancel path as the AI-driven render so the UI stays consistent.
  async function renderManualClip() {
    if (!isTauri()) { message = "Rendering runs in the desktop app only."; return; }
    if (!inputPath || !sourceVerified || manualBusy) return;
    const duration = Number(meta?.duration ?? 0);
    if (duration <= 0) { message = "Video duration unknown — cannot render."; return; }
    const start = Math.max(0, Math.min(manualStart, duration - 1));
    const end = Math.min(duration, Math.max(start + 1, manualEnd));
    if (end <= start) { message = "Invalid range — end must be after start."; return; }
    const output = e2eOutput || await save({ defaultPath: "manual-clip.mp4", filters: [{ name: "MP4", extensions: ["mp4"] }] });
    if (!output) return;
    const plan = withCaptions(createEditorState(meta?.sourceArtifactId ?? inputPath, duration, {
      id: `manual-${Date.now()}`,
      sourceArtifactId: meta?.sourceArtifactId ?? inputPath,
      start,
      end,
      wordIds: [],
      title: "Manual clip",
      score: 100,
      version: 1,
    }).plan);
    plan.aspectRatio = manualAspectRatio as "9:16" | "1:1" | "16:9";
    const render = renderEntry(output, `manual-${Date.now()}`);
    if (!await persistRender(render)) return;
    manualBusy = true; rendering = true; renderProgress = 0; busy = true;
    message = `Rendering manual clip…`;
    try {
      const channel = new Channel<RenderProgress>();
      channel.onmessage = (update) => {
        renderProgress = update.percent;
        if (update.errorCode) { message = renderErrorCodeToMessage(update.errorCode, "Manual clip render failed"); }
        else { message = `Rendering manual clip · ${Math.floor(update.percent)}%`; }
      };
      await invoke<string>("render_video", { request: { input: inputPath, output, plan } satisfies RenderRequest, onProgress: channel });
      if (!await persistRender({ ...render, status: "completed" })) { message = `Manual clip rendered but project status not saved: ${output}`; }
      else { message = `Manual clip rendered: ${output}`; }
    } catch (error) {
      const cancelled = String(error).includes("RENDER_CANCELLED");
      await persistRender({ ...render, status: cancelled ? "cancelled" : "failed", error: String(error) });
      message = cancelled ? "Manual clip render cancelled" : `Manual clip render failed: ${String(error)}`;
    } finally { manualBusy = false; rendering = false; busy = false; }
  }

  /// Remote link: one metadata call, then YouTube captions or a Facebook/TikTok
  /// audio download transcribed on-device with Whisper.
  async function analyzeLink() {
    if (!isTauri()) { message = "Link analysis runs in the desktop app only."; return; }
    const url = youtubeUrl.trim();
    if (!url || busy) return;
    highlights = []; collections = []; selectedCollection = ""; selectedId = ""; selectedIds = []; jobId = ""; youtubeVideoId = ""; meta = null;
    busy = true; message = "Fetching link…"; resetTimer(); timerStartedAt = Date.now();
    try {
      projectId = ""; studioState.projectId = ""; clearSpeakerState(); studioState.plans = {}; studioState.variants = []; variants = []; summaryVariants = []; scriptOutline = []; studioState.summaryVariants = []; studioState.scriptOutline = []; selectedVariantId = ""; studioState.selectedVariantId = ""; studioState.editingVariantId = ""; studioState.plan = null; studioState.transcript = null;
      const info = await invoke<{ id: string; duration: number; title: string }>("start_youtube_analysis", { url });
      inputPath = url;
      meta = { name: info.title, duration: info.duration, width: 0, height: 0 };
      sourceVerified = Number.isFinite(info.duration) && info.duration > 0;
      if (!sourceVerified) throw new Error("MEDIA_NOT_VERIFIED: public video metadata has no valid duration");
      studioState.sourcePath = url; studioState.sourceName = info.title; studioState.sourceDuration = info.duration;
      const project = await invoke<Project>("project_create", { sourcePath: url, sourceName: info.title, sourceDuration: info.duration });
      projectId = project.id; studioState.projectId = project.id; studioState.projectRevision = project.revision; projects = [project, ...projects];
      if (!await persistProject({ analysisJobId: info.id })) projectLinkWarning = true;
      youtubeUrl = "";
      await watch(info.id, false);
    } catch (error) {
      message = `Link analyze failed: ${String(error)}`;
      busy = false; resetTimer();
    }
  }

  async function generateVariants() {
    if (!isTauri()) { message = "Variant generation is available in the desktop app."; return; }
    if (!studioState.transcript || variantsBusy) return;
    variantsBusy = true; message = "AI is proposing transcript edits…";
    try {
      const result = await invoke<{ promptVersion: string; variants: EditVariant[] }>("generate_transcript_variants", { transcript: studioState.transcript });
      if (result.promptVersion !== VARIANT_PROMPT_VERSION || !result.variants.length) throw new Error("No valid transcript variants were returned.");
      variants = result.variants.map((variant) => {
        const plan = studioState.plans[`variant:${variant.id}`] ?? variant.plan;
        return { ...variant, ...(plan ? { plan } : {}) };
      });
      studioState.variants = variants; selectedVariantId = variants[0]?.id ?? ""; studioState.selectedVariantId = selectedVariantId;
      await persistProject({ variants, summaryVariants, scriptOutline, selectedVariantId });
      message = `${variants.length} transcript variants ready to compare.`;
    } catch (error) { message = `Variant generation failed: ${String(error)}`; }
    finally { variantsBusy = false; }
  }

  function chooseVariant(id: string) {
    selectedVariantId = id; studioState.selectedVariantId = id;
    void persistProject({ selectedVariantId: id });
  }

  function editVariant(id: string) {
    const variant = [...variants, ...summaryVariants].find((item) => item.id === id);
    if (!variant) return;
    selectedVariantId = id; studioState.selectedVariantId = id; studioState.editingVariantId = id;
    void persistProject({ selectedVariantId: id });
    // Client-side navigation keeps the keep-alive store alive, so the Editor can
    // hydrate from studioState.editingVariantId. A full document load would wipe
    // it and land on the demo highlight.
    void goto("/editor/variant");
  }

  async function renderVariant(id: string) {
    if (!isTauri()) { message = "Rendering runs in the desktop app only."; return; }
    const variant = [...variants, ...summaryVariants].find((item) => item.id === id);
    const transcript = studioState.transcript;
    if (!variant || !transcript || !inputPath || !sourceVerified) return;
    busy = true;
    message = `Rendering ${variant.title}… Keep this window open; longer videos can take a while.`;
    try {
      const plan = withCaptions(variant.plan ?? studioState.plans[`variant:${id}`] ?? createEditorStateFromVariant(transcript, variant).plan);
      variant.plan = plan;
      const output = await save({ defaultPath: exportFileName(variant.title, "variant"), filters: [{ name: "MP4", extensions: ["mp4"] }] });
      if (!output) return;
      const render = renderEntry(output, `variant:${id}`);
      if (!await persistRender(render)) return;
      const channel = new Channel<RenderProgress>();
      channel.onmessage = (update) => {
        renderProgress = Math.max(renderProgress, update.percent);
        if (update.errorCode) {
          message = renderErrorCodeToMessage(update.errorCode, "Render failed");
        } else {
          message = `${update.phase === "joining" ? "Joining clips" : "Rendering clips"} · ${Math.floor(renderProgress)}%`;
        }
      };
      rendering = true; renderProgress = 0;
      try {
        await invoke<string>("render_video", { request: { input: inputPath, output, plan } satisfies RenderRequest, onProgress: channel });
        outputPath = output;
        if (!await persistRender({ ...render, status: "completed" })) message = `Rendered ${variant.title}, but the project status could not be saved: ${output}`;
        else message = `Rendered ${variant.title}: ${output}`;
      } catch (error) {
        const cancelled = String(error).includes("RENDER_CANCELLED");
        await persistRender({ ...render, status: cancelled ? "cancelled" : "failed", error: String(error) });
        throw error;
      } finally { rendering = false; }
    } catch (error) { message = `Render failed for ${variant.title}: ${String(error)}`; }
    finally { busy = false; }
  }

  function chooseCandidate(id: string) {
    const candidate = highlights.find((item) => item.id === id);
    if (!candidate || !isActiveHighlight(candidate)) return;
    // Picking a candidate only previews it; "Keep clip" decides what Render exports.
    selectedId = id; studioState.selectedId = id;
    void persistProject({ selectedId: id });
  }

  // One decision: a clip you keep is selected for Render and marked saved.
  // Discard stays separate and already drops the clip from the selection.
  function keepClip(id: string) {
    const candidate = highlights.find((item) => item.id === id);
    if (!candidate || !isActiveHighlight(candidate)) return;
    const kept = !selectedIds.includes(id);
    selectedIds = kept ? [...selectedIds, id] : selectedIds.filter((selected) => selected !== id);
    studioState.selectedIds = selectedIds;
    // Persists highlights + selectedId + selectedIds in one write.
    setHighlightStatus(id, kept ? "saved" : undefined);
  }

  function setHighlightStatus(id: string, status: HighlightStatus | undefined) {
    highlights = highlights.map((item) => item.id === id
      ? (status === undefined ? { ...item, status: undefined } : { ...item, status })
      : item);
    studioState.highlights = highlights;
    const activeIds = new Set(highlights.filter(isActiveHighlight).map((item) => item.id));
    const nextSelectedIds = selectedIds.filter((selected) => activeIds.has(selected));
    const nextSelectedId = activeIds.has(selectedId)
      ? selectedId
      : highlights.find((item) => isActiveHighlight(item))?.id ?? "";
    selectedIds = nextSelectedIds; studioState.selectedIds = nextSelectedIds;
    selectedId = nextSelectedId; studioState.selectedId = nextSelectedId;
    studioState.plan = studioState.plans[nextSelectedId] ?? null;
    void persistProject({ highlights, selectedId: nextSelectedId, selectedIds: nextSelectedIds });
  }

  function discardHighlight(id: string) {
    setHighlightStatus(id, "discarded");
    // One browser-friendly transcode is cached per source and shared by every
    // candidate, so it can only go once nothing active is left to play. The
    // Editor rebuilds it on demand; a failure here must not block the discard.
    if (!isTauri() || !inputPath || /^https?:/i.test(inputPath)) return;
    if (highlights.some(isActiveHighlight)) return;
    void invoke("delete_video_preview", { path: inputPath }).catch(() => {});
  }
  function restoreHighlight(id: string) { setHighlightStatus(id, undefined); }

  async function renderSelected() {
    if (!isTauri()) { message = "Rendering runs in the desktop app only."; return; }
    const ids = activeSelectedIds.filter((id) => highlights.some((item) => item.id === id && isActiveHighlight(item)));
    if (!inputPath || !sourceVerified || !ids.length) return;
    // Mark the render before busy flips: busy=true is what re-arms the analysis watcher
    // effect, and it must see a render in flight instead of resuming the finished job.
    busy = true; rendering = true;
    message = `Rendering ${ids.length} clip${ids.length === 1 ? "" : "s"}… Keep this window open; longer videos can take a while.`;
    try {
      for (const [clipIndex, id] of ids.entries()) {
        const candidate = highlights.find((item) => item.id === id)!;
        // A plan saved from the Editor keeps its own aspect ratio; for a fresh plan
        // the export format chosen on this page applies (the fresh default "9:16"
        // used to silently override the selection).
        const storedPlan = studioState.plans[id];
        const plan = withCaptions(storedPlan ?? { ...createEditorState(candidate.sourceArtifactId, meta?.duration ?? candidate.end, candidate).plan, aspectRatio: aspectRatio as "9:16" | "1:1" | "16:9" });
        const output = e2eOutput || await save({ defaultPath: exportFileName(candidate.title, "short"), filters: [{ name: "MP4", extensions: ["mp4"] }] });
        if (!output) break;
        const render = renderEntry(output, id);
        if (!await persistRender(render)) break;
          const channel = new Channel<RenderProgress>();
          // The backend reports this clip's own 0→100; scale it by batch position so the
          // bar advances across the whole selection instead of restarting per clip.
          channel.onmessage = (update) => {
            const clipPercent = Math.max(renderProgress, update.percent);
            renderProgress = clipPercent;
            const overall = ((clipIndex + clipPercent / 100) / ids.length) * 100;
            if (update.errorCode) { message = renderErrorCodeToMessage(update.errorCode, "Render failed"); }
            else { message = `${update.phase === "joining" ? "Joining clips" : "Rendering clips"} · ${Math.floor(overall)}%`; }
          };
          rendering = true; renderProgress = 0;
          try {
            await invoke<string>("render_video", { request: { input: inputPath, output, plan } satisfies RenderRequest, onProgress: channel });
            if (!await persistRender({ ...render, status: "completed" })) {
              message = `Rendered ${candidate.title}, but the project status could not be saved: ${output}`;
              break;
            }
            outputPath = output;
            message = `Rendered ${candidate.title}: ${output}`;
          } catch (error) {
            const cancelled = String(error).includes("RENDER_CANCELLED");
            await persistRender({ ...render, status: cancelled ? "cancelled" : "failed", error: String(error) });
            message = cancelled ? `Render cancelled: ${candidate.title}` : `Render failed for ${candidate.title}: ${String(error)}`;
            break;
          }
      }
    } finally { busy = false; rendering = false; }
  }

  async function render() {
    if (!selectedIds.includes(selectedId)) selectedIds = [...selectedIds, selectedId];
    await renderSelected();
  }

  async function cancelRender() {
    try { await invoke("cancel_render"); message = "Stopping render…"; }
    catch (error) { message = `Could not cancel render: ${String(error)}`; }
  }

  async function abort() {
    if (!jobId) { busy = false; resetTimer(); return; }
    const stoppingId = jobId;
    const stoppingRun = pollRun;
    busy = false; pollRun += 1;
    try { await invoke("stop_analysis", { id: stoppingId }); message = "Analysis stopped."; }
    catch (error) { message = `Abort failed: ${String(error)}`; }
    finally { if (jobId === stoppingId && pollRun === stoppingRun + 1) { busy = false; resetTimer(); } await reconnectJobs(false); }
  }

function renderErrorCodeToMessage(code: string | undefined, fallback: string): string {
  const map: Record<string, string> = {
    RENDER_CANCELLED: "render cancelled.",
    FFMPEG_SPAWN: "could not start FFmpeg — check the FFmpeg install.",
    FFMPEG_EXIT: "FFmpeg exited with an error — the codec may be unsupported.",
    FFMPEG_WAIT: "failed while waiting for FFmpeg to exit.",
    RENDER_CHILD_MISSING: "the render process disappeared mid-run.",
    OUTPUT_COPY: "could not copy the output file.",
    OUTPUT_PROBE_VERIFY: "the output file failed verification after render.",
    OUTPUT_RENAME: "could not rename the output file.",
    OUTPUT_DIR: "could not create the output folder.",
    OUTPUT_PARENT_MISSING: "the output folder is missing.",
    INPUT_NOT_FILE: "the source is not a valid file.",
    OUTPUT_MUST_DIFFER_FROM_INPUT: "the output must differ from the source.",
    INVALID_RENDER_RANGES: "the clip range is invalid.",
    INVALID_RENDER_MEDIA: "the source media is invalid.",
    RENDER_STATE_LOCK_POISONED: "internal render-state error.",
    RENDER_WORKER: "render worker error.",
  };
  const friendly = map[code ?? ""];
  return friendly ? `${fallback}: ${friendly}` : fallback;
}
function clock(seconds: number) { return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`; }
  onMount(() => {
    cameraSupported = Boolean(typeof Reflect.get(navigator.mediaDevices, "getUserMedia") === "function" && typeof Reflect.get(window, "MediaRecorder") === "function");
    void refreshRuntime(); void reconnectJobs(); void refreshProjects(); void refreshDiarizationStatus();
    if (isTauri()) invoke<string>("preview_origin").then((base) => previewBase = base).catch(() => {});
    if (isTauri()) invoke<number>("recover_render_jobs").catch(() => {});
    const unlisten = getCurrentWindow().onDragDropEvent((event) => {
      const payload = event.payload;
      dragOver = payload.type === "over" || payload.type === "enter";
      if (payload.type === "drop") {
        dragOver = false;
        const path = payload.paths?.[0];
        if (path) void importPath(path);
      }
    });
    // Browser-preview drop blocking lives in +layout.svelte (once per app
    // session — the old per-mount window listeners leaked on every visit).
    return () => { stopCameraRecording(); stopTimer(); unlisten.then((fn) => fn()); };
  });
  // Refresh job lists only while visible; keep-alive pages remain mounted.
  $effect(() => {
    if (!active) return;
    const refresh = setInterval(() => { if (!busy) void reconnectJobs(); }, 5000);
    return () => clearInterval(refresh);
  });
</script>

<main class="bench bench-duo studio-workspace">
  <aside class="bench-left">
    <div class="panel"><span class="eyebrow">Local-first</span><h1>Studio</h1><p class="note">Turn long footage into a clean short-form cut without leaving this machine.</p></div>
    <div class="panel" style="margin-top:auto;"><span class="eyebrow">Engine</span><div class="spread" style="align-items:center;"><span style="display:flex;align-items:center;gap:.5rem;font-size:.82rem;color:var(--ink-2);"><span class="rail-dot" class:ok={runtimeStore.ready}></span> {runtimeStore.ready ? "100% on-device" : "Checking runtime"}</span><a class="btn btn-sm btn-quiet" href="/settings">Details</a></div><p class="note">{runtimeStore.runtimeMessage}</p></div>
  </aside>

  <section class="bench-center">
    <div class="stage"><div class="stage-head"><div class="stage-title"><span class="badge volt">source studio</span><span class="stage-name">{meta?.name ?? "Drop a source to begin"}</span></div><span class="badge">{rendering ? `rendering · ${Math.floor(renderProgress)}%` : busy ? describePhase() : highlights.length ? `${highlights.length} candidates` : `step ${currentStep} / 4`}</span></div><div class="stage-body">
    <ol class="steps" aria-label="Workflow steps">
      <li class:active={currentStep === 1} class:done={!!inputPath}><button type="button" onclick={() => currentStep = 1}><span class="step-no">1</span>Source</button></li>
      <li class:active={currentStep === 2} class:done={!!jobId}><button type="button" disabled={!sourceVerified} onclick={() => currentStep = 2}><span class="step-no">2</span>Setup</button></li>
      <li class:active={currentStep === 3} class:done={highlights.length > 0}><button type="button" disabled={!jobId} onclick={() => currentStep = 3}><span class="step-no">3</span>Analyze</button></li>
      <li class:active={currentStep === 4} class:done={exportedCount > 0}><button type="button" disabled={!highlights.length} onclick={() => currentStep = 4}><span class="step-no">4</span>Review &amp; export</button></li>
    </ol>

    {#if currentStep === 1}
    <div class="card drop" class:over={dragOver} role="region" aria-label="Video upload drop zone" ondragover={(e) => { e.preventDefault(); dragOver = true; }} ondragleave={() => dragOver = false} ondrop={(e) => { e.preventDefault(); onDrop(e); }}>
      {#if !inputPath}
        <div class="drop-inner">
          <div class="drop-icon"><Icon name="film" size={28} /></div>
          <h2>Drop a video to start</h2>
          <p>Drag & drop here, or</p>
          <button class="browse" onclick={choose} disabled={busy}><Icon name="folder" size={15} /> Browse files</button>
          <details class="other-sources">
            <summary class="disclosure-summary">Other sources</summary>
            <button class="browse" onclick={chooseFolder} disabled={busy}><Icon name="folder" size={15} /> Import camera folder</button>
            {#if cameraSupported}
              <button class="browse" onclick={recording ? stopCameraRecording : startCameraRecording} disabled={busy}>
                <Icon name="film" size={15} /> {recording ? "Stop recording" : "Record from camera"}
              </button>
            {/if}
          </details>
          <p class="hint">MP4 · MOV · MKV · MTS · M2TS · AVI — processed 100% on your device</p>
          {#if folderFiles.length > 1}
            <div class="source-list" aria-label="Videos found in folder">
              {#each folderFiles as file}
                <button type="button" class="source-item" class:selected={inputPath === file} onclick={() => loadVideo(file)} disabled={busy}>
                  {file.split(/[\\/]/).pop() ?? file}
                </button>
              {/each}
            </div>
          {/if}
          <div style="display:flex;gap:.5rem;margin-top:1rem;flex-wrap:wrap;justify-content:center;">
            <input type="url" placeholder="…or paste a supported public video URL" aria-label="Public video URL" bind:value={youtubeUrl} disabled={busy} style="flex:1;min-width:220px;" />
            <button class="browse" onclick={analyzeLink} disabled={busy || !youtubeUrl.trim()}>{#if busy}<span class="spinner"></span>{:else}Analyze link{/if}</button>
          </div>
          <p class="hint">YouTube reads captions instantly. Facebook &amp; TikTok are downloaded and transcribed on-device with Whisper (up to 30 min).</p>
        </div>
      {:else if meta}
        <div class="preview-card">
          <div class="thumb"><Icon name="film" size={22} /></div>
          <div class="preview-info">
            <strong>{meta.name}</strong>
            {#if sourceVerified}<span>{clock(meta.duration)} · {meta.width && meta.height ? `${meta.width}×${meta.height}` : ""} · verified</span>{:else}<span class="hint">Not verified — analysis and export are disabled</span>{/if}
          </div>
          <button class="btn btn-primary btn-sm" disabled={!sourceVerified} onclick={() => currentStep = 2}>Continue to config →</button>
          {#if probeError}<p class="hint" aria-live="polite">{probeError}</p>{/if}
          {#if projectId}<button class="btn btn-quiet btn-sm" disabled={busy} onclick={relinkMedia}>Relink media…</button>{/if}
          {#if inputPath.startsWith("http") && !youtubeVideoId}
            <a class="btn btn-quiet btn-sm" href={inputPath} target="_blank" rel="noreferrer">Open original post</a>
          {/if}
          <button class="btn btn-quiet btn-sm" disabled={busy} onclick={() => { resetSourceState(); inputPath = ""; folderFiles = []; youtubeUrl = ""; applyDefaultRange(0); message = "Drop a video to begin."; }}>Remove</button>
        </div>
      {/if}
    </div>
    {/if}

    {#if currentStep === 2}
    {#if probeError && projectId}
    <div class="card">
      <div class="section-title">Missing media</div>
      <p class="hint">The saved source file could not be found on disk. Relink it to keep the saved analysis, highlights and settings.</p>
      <button class="btn btn-primary btn-sm" disabled={busy} onclick={relinkMedia}>Relink media…</button>
    </div>
    {/if}
    <div class="card">
      <div class="section-title">AI model</div>
      <p class="hint">tiny = fastest on CPU · switch models in Settings · GPU (CUDA) speeds all up</p>
      <div class="spec-line"><span class="tc">{runtimeStore.device === "cuda" ? "GPU · CUDA" : "CPU · 1 thread"}</span><span>{runtimeStore.model} model</span></div>
      <p class="hint">{runtimeStore.storageMessage}</p>
    </div>

    <div class="card">
      <div class="section-title">Analyze the full video</div>
      <button class="btn btn-primary btn-wide" disabled={!inputPath || !sourceVerified || busy || analyzeEnd <= analyzeStart} onclick={runtimeStore.ready ? analyze : () => (manualFallbackOpen = !manualFallbackOpen)}>
        {#if busy}<span class="spinner"></span>{/if}
        {busy ? "Processing…" : "Start analysis"}
      </button>
      {#if !runtimeStore.ready && inputPath && sourceVerified}
        <p class="hint">Whisper is not ready, so Start analysis opens a manual clip renderer instead.</p>
        <details bind:open={manualFallbackOpen}>
          <summary class="disclosure-summary">Manual clip (Whisper not ready)</summary>
          <p class="hint">The AI transcription engine is not available. You can still render a hand-picked range directly — no analysis needed.</p>
          <div class="field-row">
            <label>Start <input type="number" min="0" max={meta && meta.duration > 0 ? Math.max(0, Math.floor(meta.duration) - 1) : undefined} bind:value={manualStart} /></label>
            <label>End <input type="number" min="1" max={meta && meta.duration > 0 ? Math.floor(meta.duration) : undefined} bind:value={manualEnd} /></label>
          </div>
          <div class="section-title">Output format</div>
          <div class="model-row">
            {#each ["9:16", "1:1", "16:9"] as ratio}<button class="chip" class:on={manualAspectRatio === ratio} disabled={manualBusy} onclick={() => manualAspectRatio = ratio}>{ratio}</button>{/each}
          </div>
          <button class="btn btn-primary btn-wide" disabled={manualBusy || manualEnd <= manualStart} onclick={renderManualClip}>
            {#if manualBusy}<span class="spinner"></span>{/if}
            {manualBusy ? "Rendering…" : "Render manual clip"}
          </button>
          {#if manualBusy}<button class="btn btn-quiet btn-wide" onclick={cancelRender}>Cancel render</button>{/if}
          <p class="hint" aria-live="polite">Use Settings → System Doctor to set up Whisper for AI highlights.</p>
        </details>
      {/if}
      {#if busy && !manualBusy}<button class="btn btn-quiet btn-wide" onclick={abort}>Abort</button>{/if}
      <p class="hint" aria-live="polite">{runtimeStore.licenseMessage}</p>
    </div>
    {/if}

    {#if currentStep === 3}
    <div class="card">
      <div class="section-title">Analysis pipeline</div>
      {#if busy}<div class="run-track"><div class="run-fill" style:width="{Math.round(progress * 100)}%"></div></div><p class="hint">{describePhase()} · {Math.round(progress * 100)}% · elapsed {elapsedLabel()}</p>
      <button class="btn btn-quiet btn-wide" onclick={abort}>Abort analysis</button>
      {:else if jobId}<p class="hint" aria-live="polite">{message}</p>
      {#if highlights.length}<button class="btn btn-primary btn-wide" onclick={() => currentStep = 4}>View candidates →</button>
      {:else}<button class="btn btn-quiet btn-wide" onclick={() => currentStep = 2}>← Back to setup</button>{/if}
      {:else}<p class="hint">No analysis job in this session.</p>
      <button class="btn btn-quiet btn-wide" onclick={() => currentStep = 2}>← Back to setup</button>{/if}
    </div>
    {/if}

    {#if currentStep === 4}
    {#if highlights.length}
      {#if studioState.transcript}
        <div class="card">
          <div class="section-title">Transcript outline</div>
          {#if scriptOutline.length}
            <ol class="outline-list">{#each scriptOutline as item}<li><span>{clock(item.start)}–{clock(item.end)}</span><p>{item.text}</p></li>{/each}</ol>
          {:else}<p class="hint">No sentence outline was available for this transcript.</p>{/if}
        </div>
        {#if summaryVariants.length}
          <div class="card">
            <div class="section-title">Summary versions</div>
            <div class="variant-grid">
              {#each summaryVariants as variant}
                <article class="variant-card">
                  <strong>{variant.title}</strong><span class="cand-sub">Summary score {variant.scores?.summary ?? "—"} · {variant.ranges.length} ranges</span>
                  <ol>{#each variant.ranges as range}<li>{clock(range.start)}–{clock(range.end)}</li>{/each}</ol>
                  <div class="field-row"><button class="btn btn-sm" onclick={() => editVariant(variant.id)}>Edit</button><button class="btn btn-sm btn-primary" disabled={busy || !sourceVerified} onclick={() => renderVariant(variant.id)}>Export</button></div>
                </article>
              {/each}
            </div>
          </div>
        {/if}
      {/if}
      <div class="card">
        <div class="section-title">Shorts Showcase</div>
        {#if collections.length}
          <div class="stack">
            {#each collections as collection}
              <button class="cand" class:on={collection.id === selectedCollection} aria-pressed={collection.id === selectedCollection} onclick={() => pickCollection(collection)}>
                <span class="cand-rank">{collection.items.length}</span>
                <span>
                  <span class="cand-title">{collection.title}</span>
                  {#if collection.topic}<span class="cand-sub">{collection.topic}</span>{/if}
                </span>
                <span class="cand-score">{collection.state}</span>
              </button>
            {/each}
          </div>
        {/if}
        <div class="cand-list">
          {#each highlights as candidate}
            {@const discarded = candidate.status === "discarded"}
            <div class="cand-item" class:discarded>
              <button class="cand" class:on={candidate.id === selectedId} aria-pressed={candidate.id === selectedId} disabled={discarded} onclick={() => chooseCandidate(candidate.id)}>
                <span class="cand-rank">{highlights.findIndex((item) => item.id === candidate.id) + 1}</span>
                <span>
                  <span class="cand-title">{candidate.title}</span>
                  <span class="cand-sub">{clock(candidate.start)}–{clock(candidate.end)} · rank {highlights.findIndex((item) => item.id === candidate.id) + 1} · rank score {candidate.score}{#if candidate.scores} · axes Hook {candidate.scores.hook} / Summary {candidate.scores.summary} / Impact {candidate.scores.impact}{/if}{#if candidate.scoreAudio === false} · audio not measured{/if}{#if collectionMembers.has(candidate.id)} · in collection{/if}{#if dominantAxisLabel(candidate)} · {dominantAxisLabel(candidate)}{/if}{#if discarded} · Discarded{/if}</span>
                  {#if candidate.hook}<span class="cand-hook">{candidate.hook}</span>{/if}
                </span>
                <span class="cand-score" title="Ranking score used to order candidates — not the same scale as Hook / Summary / Impact">{candidate.score}</span>
              </button>
              <button class="chip" class:on={selectedIds.includes(candidate.id)} aria-pressed={selectedIds.includes(candidate.id)} disabled={discarded} onclick={() => keepClip(candidate.id)}>{selectedIds.includes(candidate.id) ? "Kept" : "Keep clip"}</button>
              <div class="field-row">
                {#if discarded}
                  <button class="btn btn-sm" onclick={() => restoreHighlight(candidate.id)}>Restore</button>
                {:else}
                  <button class="btn btn-sm" onclick={() => discardHighlight(candidate.id)}>Discard</button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
        <div class="section-title">Output format</div>
        <div class="model-row">
          {#each ["9:16", "1:1", "16:9"] as ratio}<button class="chip" class:on={aspectRatio === ratio} disabled={busy} onclick={() => aspectRatio = ratio}>{ratio}</button>{/each}
        </div>
        <p class="hint">Aspect ratio for the final export (FFmpeg crop + scale).</p>
        <div class="model-row">
          <button class="chip" class:on={burnCaptions} disabled={busy} onclick={() => burnCaptions = true}>Burn subtitles</button>
          <button class="chip" class:on={!burnCaptions} disabled={busy} onclick={() => burnCaptions = false}>Clean (no subtitles)</button>
        </div>
        <p class="hint">Exports burn the transcript subtitles into the picture; choose clean for a clip you will caption elsewhere.</p>
        <div class="spec-line"><span>Export {aspectRatio}{burnCaptions ? " · burned subtitles" : " · no subtitles"}</span><span>{activeHighlights.length} active candidates · {highlights.length - activeHighlights.length} discarded{collections.length ? ` · ${collections.length} collections` : ""}</span></div>
        <button class="btn btn-primary btn-wide" disabled={busy || !sourceVerified || !activeSelectedIds.length} onclick={renderSelected}>
          {#if busy}<span class="spinner"></span>{/if}
          {busy ? "Rendering…" : `Render ${activeSelectedIds.length} selected clip${activeSelectedIds.length === 1 ? "" : "s"} (${aspectRatio})`}
        </button>
      {#if busy && rendering}<div class="run-track"><div class="run-fill" style:width="{Math.round(renderProgress)}%"></div></div><p class="hint">Render progress · {Math.floor(renderProgress)}%</p><button class="btn btn-quiet btn-wide" onclick={cancelRender}>Cancel render</button>{/if}
      </div>
      <details class="card speaker-face-match">
        <summary class="section-title">Experimental</summary>
        <p class="hint">Optional tools that work on this project's transcript and video. Nothing here is needed for the export above.</p>
        <div class="section-title experimental-sub">Match speakers to faces</div>
        <div class="spread"><div><p class="hint">Assign a face sample to each anonymous speaker label. Samples stay temporary; no identity recognition is performed.</p></div><span class="badge" class:ok={speakerMatchesConfirmed}>{speakerMatchesConfirmed ? "confirmed" : "not confirmed"}</span></div>
        {#if inputPath.startsWith("http")}
          <p class="hint">Speaker diarization and local face sampling are available for local video sources only.</p>
        {:else if !studioState.transcript?.words.some((word) => word.speakerId)}
          <div class="stack"><div class="field-row"><button class="btn btn-sm btn-primary" disabled={diarizationBusy || !diarizationReady} onclick={runDiarization}>{diarizationBusy ? "Analyzing speakers…" : "Run local diarization"}</button><span class="note">Runs locally with the bundled ONNX runtime and silero_vad model. No Hugging Face token or Python runtime is required.</span></div></div>
        {:else}
          <div class="field-row"><button class="btn btn-sm" disabled={faceSamplesBusy} onclick={sampleFaces}>{faceSamplesBusy ? "Sampling frames…" : "Sample faces from video"}</button><button class="btn btn-sm btn-quiet" onclick={cancelSpeakerMatches}>Cancel changes</button></div>
          <div class="speaker-grid">
            {#each transcriptSpeakerIds(studioState.transcript) as speakerId}
              {@const example = speakerExamples(studioState.transcript).find((item) => item.speakerId === speakerId)}
              <section class="speaker-row"><strong>{speakerId}</strong><p class="note">{example?.text ?? "Speaker turn"}</p><label class="field"><span class="field-label">Matching face sample</span><select value={speakerMatches[speakerId] ?? ""} onchange={(event) => { speakerMatches = { ...speakerMatches, [speakerId]: event.currentTarget.value }; speakerMatchesConfirmed = false; studioState.speakerFaceConfirmed = false; }}><option value="">Unknown / no match</option>{#each faceSamples.filter((sample) => sample.speakerId === speakerId) as sample}<option value={sample.id}>Sample at {clock(sample.time)}</option>{/each}</select></label></section>
            {/each}
          </div>
          {#if faceSamples.length}<div class="face-samples">{#each faceSamples as sample}<figure><img src={speakerFaceDataUrl(sample.thumbnail)} alt={`Detected face sample near ${clock(sample.time)}`} /><figcaption>{sample.speakerId} · {clock(sample.time)}</figcaption></figure>{/each}</div>{/if}
          <button class="btn btn-primary" disabled={!transcriptSpeakerIds(studioState.transcript).length} onclick={confirmSpeakerMatches}>Confirm speaker matches</button>
        {/if}
        {#if studioState.transcript}
          <div class="section-title experimental-sub">Transcript edit variants</div>
          <div class="spread"><div><p class="hint">AI suggests ordered source ranges from the transcript. Compare a version, edit it, then export that version only.</p></div><button class="btn btn-primary btn-sm" disabled={variantsBusy || busy} onclick={generateVariants}>{#if variantsBusy}<span class="spinner"></span>{/if}{variantsBusy ? "Generating…" : "Generate transcript edits"}</button></div>
          {#if variants.length}
            <div class="variant-grid">
              {#each variants as variant}
                {@const plan = variant.plan ?? studioState.plans[`variant:${variant.id}`]}
                {@const duration = (plan?.ranges ?? variant.ranges).reduce((sum, range) => sum + range.end - range.start, 0)}
                <article class="variant-card" class:on={selectedVariantId === variant.id}>
                  <div class="variant-select" aria-current={selectedVariantId === variant.id ? "true" : undefined}><button class="variant-choice" aria-pressed={selectedVariantId === variant.id} onclick={() => chooseVariant(variant.id)}><strong>{variant.title}</strong><span>{variant.reason ?? "Transcript-selected moments"}</span><small>{variant.ranges.length} ranges · {clock(duration)}</small></button>
                    <ol>{#each variant.ranges as range, index}<li><span>{index + 1}. {clock(range.start)}–{clock(range.end)}</span><small>{(studioState.transcript?.segments ?? []).filter((segment) => segment.end > range.start && segment.start < range.end).map((segment) => segment.text).join(" ")}</small></li>{/each}</ol>
                  </div>
                  <div class="field-row"><button class="btn btn-sm" onclick={() => editVariant(variant.id)}>Edit in Editor</button><button class="btn btn-sm btn-primary" disabled={busy || !sourceVerified} onclick={() => renderVariant(variant.id)}>Export this version</button></div>
                </article>
              {/each}
            </div>
          {/if}
        {/if}
      </details>
      {#if inputPath.startsWith("http") && youtubeVideoId && selectedCandidate}
        <div class="card">
          <div class="section-title">Preview (YouTube)</div>
          <iframe
            title="YouTube clip preview"
            style="width:100%;aspect-ratio:16/9;border:0;border-radius:12px;background:#000;"
            src={previewBase
              ? `${previewBase}&id=${youtubeVideoId}&start=${Math.floor(selectedCandidate.start)}&end=${Math.ceil(selectedCandidate.end)}`
              : `https://www.youtube.com/embed/${youtubeVideoId}?start=${Math.floor(selectedCandidate.start)}&end=${Math.ceil(selectedCandidate.end)}&rel=0`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen
          ></iframe>
          <p class="hint">Seek preview streams from YouTube — nothing is rendered until you export.</p>
        </div>
      {/if}
      {#if inputPath.startsWith("http") && !youtubeVideoId}
        <div class="card">
          <div class="section-title">Preview</div>
          <p class="hint">This link has no in-app player — open the original post to check a clip against the source before exporting.</p>
          <a class="btn btn-quiet btn-wide" href={inputPath} target="_blank" rel="noreferrer">Open original post</a>
        </div>
      {/if}
      {#if relatedQuery}
        <RelatedYoutubeSearch initialQuery={relatedQuery} sourceText={relatedSourceText} />
      {/if}
    {:else}
      <div class="card"><p class="hint">No highlights yet. Run an analysis first.</p><button class="btn btn-quiet btn-wide" onclick={() => currentStep = 2}>← Back to config</button></div>
    {/if}
    {/if}

    <p class="message" class:error={message.startsWith("Analyze failed") || message.startsWith("Link analyze failed")} aria-live="polite">{message}</p>

    <div class="panel">
      <div class="panel-head"><span class="panel-title"><span class="eyebrow">Analysis jobs</span></span><span class="badge">{resumableJobs.length}</span></div>
      {#if resumableJobs.length}{#each resumableJobs as job}<div class="row"><div class="row-body"><span class="row-title">{job.id.slice(-8)}</span><span class="row-sub">{PHASE_LABELS[job.status] ?? job.status}{#if job.phase} · {describePhaseValue(job.phase)}{/if}</span></div><div class="row-actions">{#if job.status === "queued" || job.status === "running"}<button class="btn btn-sm" disabled={busy} onclick={() => watch(job.id, true)}>Continue</button>{/if}{#if job.status === "failed"}<button class="btn btn-sm" disabled={busy} onclick={() => retryJob(job.id)}>Retry</button>{/if}</div></div>{/each}{:else}<p class="note">No analysis jobs yet.</p>{/if}
    </div>
      </div>
    <div class="stage-foot">
      <span>Device: {runtimeStore.device === "cuda" ? "GPU (CUDA)" : "CPU"} · Model: {runtimeStore.model} · License: {runtimeStore.licenseMessage}</span>
      <span title="Safe cleanup only: inspect caches and old renders before removing anything.">Storage: {runtimeStore.storageMessage}</span>
    </div>
    </div>
  </section>
  <style>
    .experimental-sub { margin-top: 1.1rem; }
    .variant-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr)); gap:.75rem; margin-top:.8rem; }
    .variant-card { border:1px solid var(--line-soft); border-radius:14px; padding:.8rem; background:var(--surface); }
    .variant-card.on { border-color:var(--volt); box-shadow:0 0 0 1px var(--volt); }
    .variant-select { display:flex; flex-direction:column; align-items:flex-start; gap:.45rem; width:100%; text-align:left; color:inherit; }
    .variant-choice { display:flex; flex-direction:column; align-items:flex-start; gap:.45rem; width:100%; text-align:left; color:inherit; background:none; border:0; padding:0; cursor:pointer; }
    .variant-choice > span,.variant-choice > small { color:var(--ink-2); }
    .variant-select ol { padding-left:1.25rem; margin:.25rem 0; width:100%; }
    .variant-select li { margin:.35rem 0; }
    .variant-select li small { display:block; color:var(--ink-2); }
    .variant-card .field-row { margin-top:.6rem; }
    .source-list { display:grid; gap:.35rem; width:100%; max-height:10rem; overflow:auto; margin-top:.75rem; text-align:left; }
    .source-item { border:1px solid var(--line-soft); border-radius:8px; background:var(--surface); color:var(--ink); padding:.45rem .6rem; text-align:left; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .source-item:hover,.source-item.selected { border-color:var(--volt); }
  </style>
</main>
