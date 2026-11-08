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
  const hook = 30 + (signals.hookCue ? 35 : 0) + (signals.text.includes("?") ? 10 : 0) + (audioPeak(signals.start, signals.end, signals.audioRms) ? 25 : 0);
  const summary = 25 + summarySimilarity(signals.text, signals.transcript) * 75;
  const impact = 25 + (signals.complete ? 25 : 0) + (signals.pauseBoundary ? 15 : 0) + durationFit * 20 + rmsVariation(signals.start, signals.end, signals.audioRms) * 15;
  return {
    hook: Math.round(Math.min(100, hook)),
    summary: Math.round(Math.min(100, summary)),
    impact: Math.round(Math.min(100, impact)),
  };
}

/** Builds component metadata from provider values, or deterministic local signals when absent. */
export function componentScoreMetadata(rawScores: unknown, fallback?: HighlightScores): {
  scores: HighlightScores;
  dominantAxis?: HighlightAxis;
} {
  const source = rawScores && typeof rawScores === "object"
    ? rawScores as Partial<Record<HighlightAxis, unknown>>
    : {};
  const scores: HighlightScores = {
    hook: normalizeComponentScore(source.hook ?? fallback?.hook),
    summary: normalizeComponentScore(source.summary ?? fallback?.summary),
    impact: normalizeComponentScore(source.impact ?? fallback?.impact),
  };
  return { scores, dominantAxis: dominantHighlightAxis(scores) };
}
