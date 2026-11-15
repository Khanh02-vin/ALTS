import { analyzeLocalVideo, analyzeLocalVideoWithSemantic, analyzeLocalVideoWithSttFallback, resolveHighlightStrategy, SemanticProviderAdapter, type SemanticHighlightProvider } from "../services/ai-pipeline/index.ts";
import { GeminiHighlightProvider, LlamaCppHighlightProvider, OpenAIChatHighlightProvider } from "../services/ai-pipeline/providers.ts";
import { CachedSemanticProvider } from "../services/ai-pipeline/llm-cache.ts";
import { AnalysisStore } from "../adapters/local/analysis-store.ts";
import { readFile, mkdir, rename, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { validateTranscript, type Transcript } from "../packages/contracts/transcript.ts";
import { dirname, join } from "node:path";
import { assertAudioTrack } from "../adapters/local/probe-audio.ts";
import { resolveWhisperEngine } from "../adapters/local/whisper-engine.ts";
import { REMOTE_STT_FAILED } from "../adapters/local/whisper-remote.ts";
import { groupHighlightsIntoCollections } from "../services/ai-pipeline/collections.ts";
import { parseSrtVtt, transcriptFromSubtitles, pickSubtitleTrack } from "../services/ai-pipeline/subtitles.ts";
import { parsePcm16WavRms } from "../services/ai-pipeline/wav-rms.ts";
import { planChunkBoundaries } from "../adapters/local/chunked-whisper.ts";
import { parseSceneCutMetadata } from "../services/ai-pipeline/scene-cuts.ts";

function detectLocalSceneCuts(mediaPath: string, sourceArtifactId: string, duration: number): number[] {
  if (/^https?:\/\//i.test(sourceArtifactId) || /\.(?:wav|mp3|m4a|aac|flac|ogg)$/i.test(mediaPath)) return [];
  try {
    const result = spawnSync(process.env.FFMPEG_COMMAND ?? "ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-i", mediaPath,
      "-vf", "scdet=threshold=20,metadata=print:file=-", "-an", "-f", "null", "-",
    ], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0 || result.error) return [];
    return parseSceneCutMetadata(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, duration);
  } catch {
    return [];
  }
}

/// Embedded-subtitle probe (subtitle-first): a local file that already carries
/// a subtitle track skips Whisper — the cues become the transcript and are
/// scored exactly like an injected fixture. Best-effort: any probe/extract
/// failure returns undefined and the pipeline stays on Whisper.
async function embeddedSubtitleTranscript(mediaPath: string, duration: number, language?: string): Promise<Transcript | undefined> {
  const probe = spawnSync(process.env.FFPROBE_PATH ?? "ffprobe", ["-v", "error", "-show_entries", "stream=index,codec_type:stream_tags=language", "-of", "json", mediaPath], { encoding: "utf8", timeout: 30_000 });
  if (probe.status !== 0) return undefined;
  const streams = (JSON.parse(probe.stdout || "{}")?.streams ?? []) as Array<{ index: number; codec_type?: string; tags?: { language?: string } }>;
  const track = pickSubtitleTrack(streams.map((stream) => ({ index: stream.index, codecType: stream.codec_type, language: stream.tags?.language })), language);
  if (track === undefined) return undefined;
  const relative = streams.filter((stream) => stream.codec_type === "subtitle").findIndex((stream) => stream.index === track);
  if (relative < 0) return undefined;
  const out = join(tmpdir(), `lfai-sub-${Date.now()}-${process.pid}.srt`);
  const extract = spawnSync(process.env.FFMPEG_COMMAND ?? "ffmpeg", ["-y", "-nostdin", "-loglevel", "error", "-i", mediaPath, "-map", `0:s:${relative}`, "-f", "srt", out], { encoding: "utf8", timeout: 60_000 });
  if (extract.status !== 0) return undefined;
  const cues = parseSrtVtt(readFileSync(out, "utf8"));
  rm(out, { force: true }).catch(() => {});
  if (!cues.length) return undefined;
  console.warn(`[analyze-video] using embedded subtitle track — Whisper skipped`);
  return transcriptFromSubtitles(sourceArtifactId, duration, language ?? "und", cues, "embedded-subs");
}

const [mediaPath, sourceArtifactId, durationText, rangeStartText, rangeEndText, jobId, statePath] = process.argv.slice(2);
const duration = Number(durationText);
const rangeStart = Number(rangeStartText ?? 0);
const rangeEnd = Number(rangeEndText ?? duration);

const store = jobId && statePath ? AnalysisStore.open(statePath) : undefined;
// Report the failure on the job row before exiting: without this the queued
// row this worker was spawned for stays "queued" forever and the UI keeps
// showing "Analyzing…" with no error.
  const failJob = (code: string): never => {
  if (store && jobId) store.update(jobId, { status: "failed", phase: "failed", error: code });
  store?.close();
  console.error(code);
  process.exit(2);
};
if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeStart < 0 || rangeEnd <= rangeStart || rangeEnd > duration) failJob("ANALYZE_INVALID_RANGE");
if (!mediaPath || !sourceArtifactId || !Number.isFinite(duration) || duration <= 0) failJob("ANALYZE_INVALID_ARGUMENTS");
const persistResult = async (payload: unknown): Promise<string> => {
  const path = join(dirname(statePath ?? "."), `analysis-result-${jobId}.json`);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(payload));
  await rename(temp, path);
  return path;
};

let interrupted = false;
const onSignal = () => { interrupted = true; };
process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);

/**
 * Loads a pre-built transcript when TRANSCRIPT_FIXTURE points at a JSON file.
 * Whisper is skipped entirely: the fixture feeds the same highlight-selection
 * pipeline a real transcription would, and a broken fixture fails the job with a
 * named error instead of silently falling back to a real (and probably missing)
 * Whisper install.
 */
async function loadTranscriptFixture(sourceArtifactId: string): Promise<Transcript | undefined> {
  const fixturePath = process.env.TRANSCRIPT_FIXTURE?.trim();
  if (!fixturePath) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(fixturePath, "utf8"));
  } catch (error) {
    failJob(`TRANSCRIPT_FIXTURE_UNREADABLE:${String(error)}`);
  }
  const transcript = parsed as Transcript;
  try {
    // The fixture carries its own artifact id; rebind it so highlights reference
    // the artifact this job actually analyzes, then revalidate the whole shape.
    const rebound = { ...transcript, sourceArtifactId };
    validateTranscript(rebound);
    return rebound;
  } catch (error) {
    failJob(`TRANSCRIPT_FIXTURE_INVALID:${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  assertAudioTrack(mediaPath);
  store?.update(jobId!, { status: "running", phase: "transcribe", progress: 0.1 });
  store?.setWorkerPid(jobId!, process.pid);
  // Unset or "heuristic" resolves by available credentials (see helper);
  // explicit "semantic-*" values pass through untouched.
  const strategy = resolveHighlightStrategy();
  const geminiKey = process.env.GEMINI_API_KEY ?? "";
  const activeBaseUrl = process.env.ACTIVE_PROVIDER_BASE_URL ?? "";
  const activeApiKey = process.env.ACTIVE_PROVIDER_API_KEY ?? "";
  const activeModel = process.env.ACTIVE_PROVIDER_MODEL ?? "";
  const llamaBaseUrl = process.env.LOCAL_LLM_BASE_URL ?? "http://127.0.0.1:8080";
  const llamaModel = process.env.LOCAL_LLM_MODEL ?? "qwen2.5-3b-instruct";

  const preextractedAudio = process.env.ANALYSIS_PREEXTRACTED_AUDIO?.trim();
  const audioRms = preextractedAudio
    ? parsePcm16WavRms(await readFile(preextractedAudio))
    : undefined;

  const analyzeOptions = {
    command: process.env.WHISPER_COMMAND,
    engine: resolveWhisperEngine(process.env.WHISPER_ENGINE),
    model: process.env.WHISPER_MODEL,
    modelPath: process.env.WHISPER_MODEL_PATH,
    language: process.env.WHISPER_LANGUAGE,
    device: process.env.WHISPER_DEVICE,
    fp16: process.env.WHISPER_FP16 === undefined ? undefined : process.env.WHISPER_FP16 === "1" || process.env.WHISPER_FP16 === "true",
    offsetSeconds: rangeStart,
    sourceDuration: duration,
    audioRms,
    // Downloaded audio can run 30 minutes: cut it into ~600 s pieces on a quiet
    // 100 ms window so each Whisper run stays short and progress moves per chunk.
    // Local files keep the historical 120 s layout their chunk rows expect.
    ...(rangeEnd - rangeStart > 600 && /^https?:\/\//.test(sourceArtifactId)
      ? {
        chunkSeconds: 600,
        boundaries: planChunkBoundaries(rangeEnd - rangeStart, 600, audioRms?.windows.map((window) => ({ ...window, start: window.start - rangeStart, end: window.end - rangeStart }))),
      }
      : {}),
    transcript: (await loadTranscriptFixture(sourceArtifactId)) ?? (await embeddedSubtitleTranscript(mediaPath, duration, process.env.WHISPER_LANGUAGE)),
    sceneCuts: detectLocalSceneCuts(mediaPath, sourceArtifactId, duration),
    onChunkStart: (index: number, total: number) => store?.updateChunk(jobId!, index, { status: "running", attempts: 1 }),
    onChunkComplete: (index: number, total: number, cacheHit: boolean) => {
      store?.updateChunk(jobId!, index, { status: "completed", error: cacheHit ? "cache hit" : null });
      store?.update(jobId!, { phase: "transcribe", progress: 0.1 + 0.8 * (index + 1) / total });
      store?.resetAttempts(jobId!);
    },
    onChunkFail: (index: number, total: number, error: string) => store?.updateChunk(jobId!, index, { status: "failed", error }),
    onProgress: (completed: number, total: number) => store?.update(jobId!, { phase: "transcribe", progress: 0.1 + 0.8 * completed / total }),
    // Kills the whisper/ffmpeg child currently running instead of letting it finish
    // after this process is asked to stop (the old flag was only read between chunks).
    shouldAbort: () => interrupted,
    whisperPrompt: process.env.WHISPER_PROMPT?.trim() || undefined,
    useDtw: process.env.WHISPER_DTW === "1" || process.env.WHISPER_DTW === "true",
  };

  // CachedSemanticProvider: same transcript + prompt version replays stored
  // highlights instead of re-calling the LLM (identity includes the model so a
  // model swap never serves the wrong cache).
  const semanticProvider: SemanticHighlightProvider | undefined =
    strategy === "semantic-openai" && activeBaseUrl && activeModel ? new CachedSemanticProvider(new SemanticProviderAdapter(new OpenAIChatHighlightProvider(activeBaseUrl, activeApiKey, activeModel), "openai"), `openai:${activeBaseUrl}|${activeModel}`)
    : strategy === "semantic-gemini" && geminiKey ? new CachedSemanticProvider(new SemanticProviderAdapter(new GeminiHighlightProvider(geminiKey), "gemini"), "gemini")
    : strategy === "semantic-local" ? new CachedSemanticProvider(new SemanticProviderAdapter(new LlamaCppHighlightProvider(llamaBaseUrl, llamaModel), "llama-cpp"), `llama-cpp:${llamaModel}`)
    : undefined;

  // Cloud STT (BYOK) is best-effort: a REMOTE_STT_FAILED failure re-runs the
  // whole analysis on the local whisper.cpp engine before the job can fail.
  const attemptAnalysis = (engine: "python" | "cpp" | "openai-audio" | undefined) => semanticProvider
    ? analyzeLocalVideoWithSemantic(mediaPath, sourceArtifactId, rangeEnd - rangeStart, { semanticProvider, semanticLimit: 5, ...analyzeOptions, engine })
    : analyzeLocalVideoWithSttFallback(mediaPath, sourceArtifactId, rangeEnd - rangeStart, { ...analyzeOptions, engine });
  let result;
  try {
    result = await attemptAnalysis(analyzeOptions.engine);
  } catch (error) {
    if (!String(error).includes(REMOTE_STT_FAILED)) throw error;
    console.warn("[analyze-video] cloud STT failed; falling back to the local whisper.cpp engine");
    result = await attemptAnalysis("cpp");
  }
  if (interrupted) throw new Error("ANALYZE_INTERRUPTED");
  // Free tier: only the top 3 highlights, CPU + tiny already enforced by start_analysis.
  if (process.env.LICENSE_TIER !== "pro") result.highlights = result.highlights.slice(0, 3);
  // Collections group the final (post-tier) highlight set, so every item points at
  // a highlight the UI actually received. projectId falls back to the source
  // artifact id — swap in a real project id once a local project store exists.
  const payload = { ...result, collections: await groupHighlightsIntoCollections(result.highlights, { projectId: sourceArtifactId, sourceArtifactId }) };
  store?.update(jobId!, { phase: "rank", progress: 0.9 });
  const resultPath = store ? await persistResult(payload) : null;
  store?.update(jobId!, { status: "completed", phase: "completed", progress: 1, resultPath, error: null });
  store?.close();
  process.stdout.write(JSON.stringify(payload));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  store?.update(jobId!, { status: interrupted ? "queued" : "failed", phase: interrupted ? "queued" : "failed", error: message });
  store?.close();
  console.error(message);
  process.exit(1);
}
