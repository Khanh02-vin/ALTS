import { chooseContentHighlights } from "../services/ai-pipeline/content-highlights.ts";
import { chooseHeuristicHighlights } from "../services/ai-pipeline/heuristic.ts";
import { generateSemanticHighlights, SemanticProviderAdapter, type SemanticHighlightProvider } from "../services/ai-pipeline/semantic.ts";
import { GeminiHighlightProvider, LlamaCppHighlightProvider, OpenAIChatHighlightProvider } from "../services/ai-pipeline/providers.ts";
import { CachedSemanticProvider } from "../services/ai-pipeline/llm-cache.ts";
import { analyzeLocalVideo, analyzeLocalVideoWithSemantic, resolveHighlightStrategy } from "../services/ai-pipeline/index.ts";
import { transcriptFromCaptions, isTranscriptUnavailable, YOUTUBE_AUDIO_FALLBACK_REQUIRED, type CaptionPayload } from "../services/ai-pipeline/youtube-transcript.ts";
import { groupHighlightsIntoCollections } from "../services/ai-pipeline/collections.ts";
import { validateHighlights, type Highlight } from "../packages/contracts/highlight.ts";
import { buildScriptOutline, associateHighlightsWithOutline, buildSummaryVariants } from "../services/ai-pipeline/script-outline.ts";
import { AnalysisStore } from "../adapters/local/analysis-store.ts";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function createSemanticProvider(strategy: string): SemanticHighlightProvider | undefined {
  const geminiKey = process.env.GEMINI_API_KEY ?? "";
  const activeBaseUrl = process.env.ACTIVE_PROVIDER_BASE_URL ?? "";
  const activeApiKey = process.env.ACTIVE_PROVIDER_API_KEY ?? "";
  const activeModel = process.env.ACTIVE_PROVIDER_MODEL ?? "";
  const llamaBaseUrl = process.env.LOCAL_LLM_BASE_URL ?? "http://127.0.0.1:8080";
  const llamaModel = process.env.LOCAL_LLM_MODEL ?? "qwen2.5-3b-instruct";
  return strategy === "semantic-openai" && activeBaseUrl && activeModel ? new CachedSemanticProvider(new SemanticProviderAdapter(new OpenAIChatHighlightProvider(activeBaseUrl, activeApiKey, activeModel), "openai"), `openai:${activeBaseUrl}|${activeModel}`)
    : strategy === "semantic-gemini" && geminiKey ? new CachedSemanticProvider(new SemanticProviderAdapter(new GeminiHighlightProvider(geminiKey), "gemini"), "gemini")
    : strategy === "semantic-local" ? new CachedSemanticProvider(new SemanticProviderAdapter(new LlamaCppHighlightProvider(llamaBaseUrl, llamaModel), "llama-cpp"), `llama-cpp:${llamaModel}`)
    : undefined;
}

function fetchCaptions(videoUrl: string): CaptionPayload {
  const python = process.env.YT_PYTHON;
  const crawler = process.env.YT_CRAWLER;
  if (!python || !crawler) throw new Error("YOUTUBE_CRAWLER_ENV_MISSING");
  const run = spawnSync(python, [crawler, "--video", videoUrl], { encoding: "utf8", timeout: 180_000 });
  if (run.error) throw new Error(`CRAWLER_SPAWN:${run.error.message}`);
  if (run.status !== 0) {
    const error = run.stderr?.trim() || `CRAWLER_EXIT:${run.status}`;
    if (isTranscriptUnavailable(error)) throw new Error(`YOUTUBE_TRANSCRIPT_UNAVAILABLE:${error}`);
    throw new Error(error);
  }
  let payload: CaptionPayload;
  try { payload = JSON.parse(run.stdout) as CaptionPayload; } catch { throw new Error("YOUTUBE_PAYLOAD_JSON"); }
  if (typeof payload.videoId !== "string" || !payload.videoId || !Array.isArray(payload.segments)) throw new Error("YOUTUBE_PAYLOAD_SHAPE");
  return payload;
}

const [url, durationText, jobId, statePath] = process.argv.slice(2);
const duration = Number(durationText);
if (!url?.startsWith("http") || !Number.isFinite(duration) || duration <= 0 || !jobId || !statePath) {
  console.error("YOUTUBE_INVALID_ARGUMENTS");
  process.exit(2);
}

const store = AnalysisStore.open(statePath);
const persistResult = async (payload: unknown): Promise<string> => {
  const path = join(dirname(statePath), `analysis-result-${jobId}.json`);
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

async function main(): Promise<void> {
try {
  store.update(jobId, { status: "running", phase: "transcribe", progress: 0.1 });
  store.setWorkerPid(jobId, process.pid);
  let payload: CaptionPayload;
  try {
    if (process.env.YOUTUBE_AUDIO_FALLBACK_ONLY === "1") throw new Error("YOUTUBE_AUDIO_FALLBACK_ONLY");
    payload = fetchCaptions(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== "YOUTUBE_AUDIO_FALLBACK_ONLY" && !message.startsWith("YOUTUBE_TRANSCRIPT_UNAVAILABLE:")) throw error;
    const audioPath = process.env.ANALYSIS_PREEXTRACTED_AUDIO;
    if (!audioPath) throw new Error(YOUTUBE_AUDIO_FALLBACK_REQUIRED);
    store.update(jobId, { phase: "transcribe", progress: 0.15 });
    const strategy = resolveHighlightStrategy();
    const semanticProvider = createSemanticProvider(strategy);
    const analysisOptions = { command: process.env.WHISPER_COMMAND, engine: process.env.WHISPER_ENGINE === "python" ? "python" as const : "cpp" as const, model: process.env.WHISPER_MODEL, modelPath: process.env.WHISPER_MODEL_PATH, language: process.env.WHISPER_LANGUAGE, device: process.env.WHISPER_DEVICE, fp16: process.env.WHISPER_FP16 === undefined ? undefined : process.env.WHISPER_FP16 === "1" || process.env.WHISPER_FP16 === "true", sourceDuration: duration, shouldAbort: () => interrupted, onProgress: (completed: number, total: number) => store.update(jobId, { phase: "transcribe", progress: 0.15 + 0.7 * completed / total }) };
    const result = semanticProvider
      ? await analyzeLocalVideoWithSemantic(audioPath, url, duration, { ...analysisOptions, semanticProvider, semanticLimit: 5 })
      : await analyzeLocalVideo(audioPath, url, duration, analysisOptions);
    if (interrupted) throw new Error("ANALYZE_INTERRUPTED");
    if (process.env.LICENSE_TIER !== "pro") result.highlights = result.highlights.slice(0, 3);
    const fallbackResult = { ...result, videoId: new URL(url).searchParams.get("v") ?? url, collections: await groupHighlightsIntoCollections(result.highlights, { projectId: url, sourceArtifactId: url }) };
    const resultPath = await persistResult(fallbackResult);
    store.update(jobId, { status: "completed", phase: "completed", progress: 1, resultPath, error: null });
    store.close();
    process.stdout.write(JSON.stringify(fallbackResult));
    return;
  }
  if (interrupted) throw new Error("ANALYZE_INTERRUPTED");
  const transcript = transcriptFromCaptions({ ...payload, duration });
  store.update(jobId, { phase: "transcribe", progress: 0.7 });

  // Unset or "heuristic" resolves by available credentials (see helper);
  // explicit "semantic-*" values pass through untouched.
  const strategy = resolveHighlightStrategy();
  const geminiKey = process.env.GEMINI_API_KEY ?? "";
  const activeBaseUrl = process.env.ACTIVE_PROVIDER_BASE_URL ?? "";
  const activeApiKey = process.env.ACTIVE_PROVIDER_API_KEY ?? "";
  const activeModel = process.env.ACTIVE_PROVIDER_MODEL ?? "";
  const llamaBaseUrl = process.env.LOCAL_LLM_BASE_URL ?? "http://127.0.0.1:8080";
  const llamaModel = process.env.LOCAL_LLM_MODEL ?? "qwen2.5-3b-instruct";

  // CachedSemanticProvider: replays stored highlights for the same transcript +
  // prompt version instead of re-calling the LLM; identity includes the model.
  const semanticProvider: SemanticHighlightProvider | undefined =
    strategy === "semantic-openai" && activeBaseUrl && activeModel ? new CachedSemanticProvider(new SemanticProviderAdapter(new OpenAIChatHighlightProvider(activeBaseUrl, activeApiKey, activeModel), "openai"), `openai:${activeBaseUrl}|${activeModel}`)
    : strategy === "semantic-gemini" && geminiKey ? new CachedSemanticProvider(new SemanticProviderAdapter(new GeminiHighlightProvider(geminiKey), "gemini"), "gemini")
    : strategy === "semantic-local" ? new CachedSemanticProvider(new SemanticProviderAdapter(new LlamaCppHighlightProvider(llamaBaseUrl, llamaModel), "llama-cpp"), `llama-cpp:${llamaModel}`)
    : undefined;

  const chooseFallback = (): Highlight[] => duration > 120 ? chooseContentHighlights(transcript) : chooseHeuristicHighlights(transcript);
  let highlights: Highlight[];
  if (semanticProvider) {
    try {
      highlights = await generateSemanticHighlights(transcript, semanticProvider, { limit: 5, minDuration: 10, maxDuration: 90 });
    } catch (error) {
      // Provider failure must not lose the job: fall back to the deterministic selector.
      console.warn(`[ai-pipeline] semantic provider failed (${error instanceof Error ? error.message : error}); fell back to ${duration > 120 ? "content" : "heuristic"} selector`);
      highlights = chooseFallback();
    }
  } else {
    highlights = chooseFallback();
  }
  if (interrupted) throw new Error("ANALYZE_INTERRUPTED");
  const scriptOutline = buildScriptOutline(transcript);
  highlights = associateHighlightsWithOutline(highlights, scriptOutline);
  const summaryVariants = buildSummaryVariants(transcript);
  validateHighlights(highlights, duration);
  // Free tier: only the top 3 highlights.
  if (process.env.LICENSE_TIER !== "pro") highlights = highlights.slice(0, 3);
  store.update(jobId, { phase: "rank", progress: 0.9 });
  // Collections group the final highlight set the UI receives. The video id is a
  // stable project identity for the YouTube path.
  const result = { transcript, highlights, scriptOutline, summaryVariants, videoId: payload.videoId, collections: await groupHighlightsIntoCollections(highlights, { projectId: payload.videoId, sourceArtifactId: transcript.sourceArtifactId }) };
  const resultPath = await persistResult(result);
  store.update(jobId, { status: "completed", phase: "completed", progress: 1, resultPath, error: null });
  store.close();
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  store.update(jobId, { status: interrupted ? "queued" : "failed", phase: interrupted ? "queued" : "failed", error: message });
  store.close();
  console.error(message);
  process.exit(1);
}
}

void main();
