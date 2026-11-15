import type { WhisperOptions } from "../../adapters/local/whisper.ts";
import { transcribeChunkedWithWhisper, type ChunkedWhisperOptions } from "../../adapters/local/chunked-whisper.ts";
import { REMOTE_STT_FAILED } from "../../adapters/local/whisper-remote.ts";
import { chooseContentHighlights } from "./content-highlights.ts";
import { chooseHeuristicHighlights } from "./heuristic.ts";
import { snapHighlightsToPauses } from "./pause-snap.ts";
import { buildRerankCandidates, rerankCandidates } from "./hybrid-highlights.ts";
import { snapHighlightsToScenes } from "./scene-snap.ts";
import { NotImplementedSemanticProvider, type SemanticHighlightProvider } from "./semantic.ts";
import type { AudioRmsFeatures } from "./highlight-scoring.ts";
import { validateHighlights, type Highlight } from "../../packages/contracts/highlight.ts";
import { validateTranscript, type Transcript } from "../../packages/contracts/transcript.ts";
import { associateHighlightsWithOutline, buildScriptOutline, buildSummaryVariants, type ScriptOutlineItem, type SummaryVariant } from "./script-outline.ts";
// Real callers use analyzeLocalVideo/analyzeLocalVideoWithSemantic.
import type { SemanticHighlightProvider } from "./semantic.ts";
export * from "./variants.ts";
export * from "./diarization.ts";
// ponytail: mockTranscribe/mockHighlights deleted — analyzeVideo now returns deterministic placeholder.
// Real callers use analyzeLocalVideo/analyzeLocalVideoWithSemantic.
export type ClipAnalysis = { transcript: Transcript; highlights: Highlight[]; scriptOutline?: ScriptOutlineItem[]; summaryVariants?: SummaryVariant[] };
export type LocalClipAnalysis = { transcript: Transcript; highlights: Highlight[]; scriptOutline: ScriptOutlineItem[]; summaryVariants: SummaryVariant[] };

function enrichAnalysis(transcript: Transcript, highlights: Highlight[]): LocalClipAnalysis {
  const scriptOutline = buildScriptOutline(transcript);
  const associated = associateHighlightsWithOutline(highlights, scriptOutline);
  return { transcript, highlights: associated, scriptOutline, summaryVariants: buildSummaryVariants(transcript) };
}

/**
 * Resolves the highlight strategy the analysis worker should run. An explicit
 * "semantic-*" value is honored as-is; unset, empty, or "heuristic" means auto:
 * prefer the activated OpenAI-compatible provider, then a saved Gemini key.
 * Installs without credentials fall through to the offline heuristic selector,
 * which stays the fallback. The local llama.cpp provider stays opt-in — auto-
 * connecting to a default localhost endpoint would be surprising.
 */
export function resolveHighlightStrategy(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.HIGHLIGHT_STRATEGY?.trim();
  if (explicit && explicit !== "heuristic") return explicit;
  const has = (value?: string) => Boolean(value?.trim());
  if (has(env.ACTIVE_PROVIDER_BASE_URL) && has(env.ACTIVE_PROVIDER_API_KEY) && has(env.ACTIVE_PROVIDER_MODEL)) return "semantic-openai";
  if (has(env.GEMINI_API_KEY)) return "semantic-gemini";
  return "heuristic";
}

export function analyzeVideo(sourceArtifactId: string, duration: number): ClipAnalysis {
  const transcript: Transcript = { version: 1, sourceArtifactId, language: "und", duration, provider: "mock", words: [{ id: "w1", text: "placeholder", start: 0, end: duration }], segments: [{ id: "s1", text: "placeholder", start: 0, end: duration, wordIds: ["w1"] }] };
  validateTranscript(transcript);
  const highlights: Highlight[] = [{ version: 1, id: "h1", sourceArtifactId, start: 0, end: duration, wordIds: ["w1"], title: "Placeholder highlight", score: 50 }];
  validateHighlights(highlights, duration);
  return { transcript, highlights };
}

export type LocalAnalyzeOptions = WhisperOptions & Pick<ChunkedWhisperOptions, "onProgress" | "onChunkStart" | "onChunkComplete" | "onChunkFail" | "chunkSeconds" | "overlapSeconds" | "offsetSeconds" | "boundaries"> & {
  /** Pre-built transcript (e.g. from a fixture): skips Whisper entirely and only selects highlights. */
  transcript?: Transcript;
  audioRms?: AudioRmsFeatures;
  semanticProvider?: SemanticHighlightProvider;
  semanticLimit?: number;
  /** Optional video scene-cut timestamps, used only for boundary alignment. */
  sceneCuts?: number[];
};

export async function analyzeLocalVideo(audioPath: string, sourceArtifactId: string, duration: number, options: LocalAnalyzeOptions = {}): Promise<LocalClipAnalysis> {
  if (options.semanticProvider) {
    return analyzeLocalVideoWithSemantic(audioPath, sourceArtifactId, duration, options);
  }
  const sourceDuration = options.sourceDuration ?? duration;
  const transcript = options.transcript
    ? await Promise.resolve(options.transcript)
    : await transcribeChunkedWithWhisper(audioPath, sourceArtifactId, duration, { ...options, transcript: undefined, sourceDuration });
  const selected = duration > 120
    ? chooseContentHighlights(transcript, 5, options.audioRms)
    : chooseHeuristicHighlights(transcript, 5, options.audioRms);
  const sceneCuts = options.sceneCuts ?? [];
  const highlights = snapHighlightsToScenes(snapHighlightsToPauses(selected, transcript), transcript, sceneCuts);
  validateTranscript(transcript);
  // Chunked transcription shifts every timestamp by the range offset, so the
  // highlights carry absolute source times — validate them against the source
  // duration, not the range length (a range starting deep in a long video used
  // to fail with "Timestamp exceeds duration").
  validateHighlights(highlights, sourceDuration);
  return enrichAnalysis(transcript, highlights);
}

/// Cloud STT (BYOK) is best-effort: any REMOTE_STT_FAILED failure re-runs the
/// whole analysis on the local whisper.cpp engine, so a network outage or a
/// bad key degrades to the offline path instead of failing the job.
export async function analyzeLocalVideoWithSttFallback(
  audioPath: string,
  sourceArtifactId: string,
  duration: number,
  options: LocalAnalyzeOptions = {},
): Promise<LocalClipAnalysis> {
  try {
    return await analyzeLocalVideo(audioPath, sourceArtifactId, duration, options);
  } catch (error) {
    if (!String(error).includes(REMOTE_STT_FAILED)) throw error;
    console.warn("[ai-pipeline] cloud STT failed; falling back to the local whisper.cpp engine");
    return await analyzeLocalVideo(audioPath, sourceArtifactId, duration, { ...options, engine: "cpp" });
  }
}

export type SemanticAnalyzeOptions = LocalAnalyzeOptions & { semanticCategory?: string; semanticLimit?: number };

export async function analyzeLocalVideoWithSemantic(
  audioPath: string,
  sourceArtifactId: string,
  duration: number,
  options: SemanticAnalyzeOptions = {}
): Promise<LocalClipAnalysis> {
  const sourceDuration = options.sourceDuration ?? duration;
  const transcript = options.transcript
    ? await Promise.resolve(options.transcript)
    : await transcribeChunkedWithWhisper(audioPath, sourceArtifactId, duration, { ...options, transcript: undefined, sourceDuration });

  const provider = options.semanticProvider ?? new NotImplementedSemanticProvider();
  const fallback = duration > 120
    ? chooseContentHighlights(transcript, 15, options.audioRms)
    : chooseHeuristicHighlights(transcript, 15, options.audioRms);
  const fallbackSnapped = snapHighlightsToScenes(snapHighlightsToPauses(fallback, transcript), transcript, options.sceneCuts ?? []).slice(0, 5);
  let highlights: Highlight[];
  try {
    const candidates = buildRerankCandidates(transcript, options.audioRms, 15);
    if (candidates.length && provider.rerank) {
      const reranked = await rerankCandidates(transcript, candidates, provider, Math.min(5, options.semanticLimit ?? 5));
      highlights = reranked.length ? snapHighlightsToScenes(snapHighlightsToPauses(reranked, transcript), transcript, options.sceneCuts ?? []) : fallbackSnapped;
    } else {
      highlights = fallbackSnapped;
    }
  } catch (error) {
    console.warn(`[ai-pipeline] semantic rerank failed (${error instanceof Error ? error.message : error}); keeping local shortlist`);
    highlights = fallbackSnapped;
  }

  validateTranscript(transcript);
  // Highlights use absolute source timestamps (see analyzeLocalVideo).
  validateHighlights(highlights, sourceDuration);
  return enrichAnalysis(transcript, highlights);
}

// Re-export all symbols from semantic.ts so they are available at package boundary
export * from "./semantic.ts";
export * from "./variants.ts";
