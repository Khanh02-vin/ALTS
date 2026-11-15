import { dominantHighlightAxis, type HighlightAxis, type HighlightScores } from "../../packages/contracts/highlight.ts";
import type { Transcript } from "../../packages/contracts/transcript.ts";

export type AudioRmsFeatures = {
  windows: Array<{ start: number; end: number; rms: number }>;
  query(start: number, end: number): number;
};

export type HighlightScoreSignals = {
  start: number;
  end: number;
  text: string;
  transcript: Transcript;
  hookCue?: boolean;
  complete?: boolean;
  pauseBoundary?: boolean;
  audioRms?: AudioRmsFeatures;
};

export type AggregateHighlightSignals = Pick<HighlightScoreSignals, "start" | "end" | "text" | "transcript" | "hookCue" | "complete" | "pauseBoundary" | "audioRms"> & { baseScore?: number };

/** Add bounded, deterministic audio-energy and speech-rate evidence to selector ranking. */
export function scoreAggregateHighlight(signals: AggregateHighlightSignals): number {
  const duration = Math.max(0.001, signals.end - signals.start);
  const wordCount = signals.transcript.words.length
    ? signals.transcript.words.filter((word) => word.start >= signals.start && word.end <= signals.end).length
    : tokens(signals.text).length;
  const legacyBaseline = Math.min(100, wordCount * 5 + (signals.hookCue ? 25 : 0) + (signals.complete ? 10 : 0) + (signals.pauseBoundary ? 8 : 0));
  const baseline = Math.max(0, Math.min(100, signals.baseScore ?? legacyBaseline));
  const speechRate = wordCount / duration;
  // Reward a moderate speaking pace lightly; this should refine, not replace,
  // the selector's existing text-quality rank.
  const speechBonus = signals.audioRms && wordCount > 0 ? Math.max(0, 4 * (1 - Math.abs(speechRate - 3) / 3)) : 0;
  const energyWindows = signals.audioRms?.windows.filter((window) => window.end > signals.start && window.start < signals.end) ?? [];
  const energy = energyWindows.length
    ? energyWindows.reduce((sum, window) => sum + window.rms, 0) / energyWindows.length
    : 0;
  const energyBonus = signals.audioRms && energyWindows.length ? Math.min(10, Math.max(0, energy / 0.08 * 10)) : 0;
  return Math.max(0, Math.min(100, Math.round(baseline + speechBonus + energyBonus)));
}

/** Coerces component scores into their literal inclusive 0–100 scale. */
export function normalizeComponentScore(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 0;
}

/** Legacy aggregate scores may arrive as probabilities; preserve that mapping. */
export function normalizeHighlightScore(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return normalizeComponentScore(parsed >= 0 && parsed <= 1 ? parsed * 100 : parsed);
}

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter((token) => token.length > 2);
}

function summarySimilarity(candidateText: string, transcript: Transcript): number {
  const candidate = new Set(tokens(candidateText));
  const documents = transcript.segments.map((segment) => new Set(tokens(segment.text)));
  if (!candidate.size || !documents.length) return 0;
  const all = new Set(documents.flatMap((document) => [...document]));
  let weightedTotal = 0;
  let weightedMatch = 0;
  for (const token of all) {
    const frequency = documents.filter((document) => document.has(token)).length;
    const weight = Math.log(1 + (documents.length + 1) / (frequency + 1));
    weightedTotal += weight;
    if (candidate.has(token)) weightedMatch += weight;
  }
  return weightedTotal ? weightedMatch / weightedTotal : 0;
}

function audioPeak(start: number, end: number, audioRms?: AudioRmsFeatures): boolean {
  if (!audioRms) return false;
  const upper = Math.min(end, start + 3);
  const windows = audioRms.windows.filter((window) => window.end > start && window.start < upper);
  if (windows.length < 2) return false;
  const mean = windows.reduce((sum, window) => sum + window.rms, 0) / windows.length;
  return mean > 0.01 && Math.max(...windows.map((window) => window.rms)) >= mean * 1.5;
}

function rmsVariation(start: number, end: number, audioRms?: AudioRmsFeatures): number {
  if (!audioRms) return 0;
  const values = audioRms.windows.filter((window) => window.end > start && window.start < end).map((window) => window.rms);
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 1e-6) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.min(1, Math.sqrt(variance) / mean / 0.6);
}

/** Deterministic local component scores; these never participate in selector ranking. */
export function scoreHighlightComponents(signals: HighlightScoreSignals): HighlightScores {
  const duration = signals.end - signals.start;
  const durationFit = duration >= 15 && duration <= 60 ? 1 : duration < 15 ? Math.max(0, (duration - 4) / 11) : Math.max(0, (90 - duration) / 30);
  // Audio energy only exists when RMS windows were supplied. Normalising over the
  // measured maximum keeps a text-only clip on the same 0–100 scale instead of
  // silently charging it the 25 hook / 15 impact points of an absent measurement.
  const audio = signals.audioRms !== undefined;
  const hookRaw = 30 + (signals.hookCue ? 35 : 0) + (signals.text.includes("?") ? 10 : 0) + (audio && audioPeak(signals.start, signals.end, signals.audioRms) ? 25 : 0);
  const hookMax = audio ? 100 : 75;
  const summary = 25 + summarySimilarity(signals.text, signals.transcript) * 75;
  const impactRaw = 25 + (signals.complete ? 25 : 0) + (signals.pauseBoundary ? 15 : 0) + durationFit * 20 + (audio ? rmsVariation(signals.start, signals.end, signals.audioRms) * 15 : 0);
  const impactMax = audio ? 100 : 85;
  return {
    hook: Math.round(Math.min(100, hookRaw / hookMax * 100)),
    summary: Math.round(Math.min(100, summary)),
    impact: Math.round(Math.min(100, impactRaw / impactMax * 100)),
  };
}

/** Builds component metadata from provider values, or deterministic local signals when absent. */
export function componentScoreMetadata(rawScores: unknown, fallback?: HighlightScores, scoreAudio = false): {
  scores: HighlightScores;
  dominantAxis?: HighlightAxis;
  /** False when hook/impact were scored from text alone (no audio energy). */
  scoreAudio: boolean;
} {
  const source = rawScores && typeof rawScores === "object"
    ? rawScores as Partial<Record<HighlightAxis, unknown>>
    : {};
  const scores: HighlightScores = {
    hook: normalizeComponentScore(source.hook ?? fallback?.hook),
    summary: normalizeComponentScore(source.summary ?? fallback?.summary),
    impact: normalizeComponentScore(source.impact ?? fallback?.impact),
  };
  return { scores, dominantAxis: dominantHighlightAxis(scores), scoreAudio };
}
