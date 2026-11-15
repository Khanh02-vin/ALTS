import type { Highlight } from "../../packages/contracts/highlight.ts";
import type { Transcript } from "../../packages/contracts/transcript.ts";
import { chooseContentHighlights } from "./content-highlights.ts";
import { chooseHeuristicHighlights } from "./heuristic.ts";
import { scoreHighlightComponents, type AudioRmsFeatures } from "./highlight-scoring.ts";
import type { SemanticHighlightProvider, SemanticRerankCandidate, SemanticRerankResult } from "./semantic.ts";

export type HybridCandidate = SemanticRerankCandidate & { highlight: Highlight };

export function buildRerankCandidates(transcript: Transcript, audioRms?: AudioRmsFeatures, limit = 15): HybridCandidate[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const count = Math.min(15, Math.max(1, Math.floor(limit)));
  const selected = transcript.duration > 120
    ? chooseContentHighlights(transcript, count, audioRms)
    : chooseHeuristicHighlights(transcript, count, audioRms);
  const words = transcript.words;
  return selected.map((highlight, index) => {
    const text = words.length
      ? words.filter((word) => word.start >= highlight.start && word.end <= highlight.end).map((word) => word.text).join(" ")
      : transcript.segments.filter((segment) => segment.start >= highlight.start && segment.end <= highlight.end).map((segment) => segment.text).join(" ");
    const before = words.length ? words.filter((word) => word.end <= highlight.start).at(-1) : undefined;
    const after = words.find((word) => word.start >= highlight.end);
    const silenceBoundary = Boolean((before && highlight.start - before.end >= 0.3) || (after && after.start - highlight.end >= 0.3));
    let energy: number | undefined;
    if (audioRms) {
      try { energy = Math.round(Math.max(0, Math.min(1, audioRms.query(highlight.start, highlight.end))) * 1000) / 1000; }
      catch { energy = undefined; }
    }
    return {
      id: `candidate-${index}`,
      start: highlight.start,
      end: highlight.end,
      text: text.slice(0, 1200),
      confidence: highlight.score,
      energy,
      silenceBoundary,
      componentScores: highlight.scores ?? scoreHighlightComponents({ start: highlight.start, end: highlight.end, text, transcript, audioRms }),
      highlight,
    };
  });
}

/** Ask an LLM to select and rank only supplied candidates; timing stays local. */
export async function rerankCandidates(
  transcript: Transcript,
  candidates: HybridCandidate[],
  provider: SemanticHighlightProvider,
  limit = 5,
): Promise<Highlight[]> {
  if (!provider.rerank) throw new Error("SEMANTIC_RERANK_UNSUPPORTED");
  const result: SemanticRerankResult = await provider.rerank({ transcript, candidates, limit: Math.min(5, Math.max(1, limit)) });
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const used = new Set<string>();
  const chosen: Array<{ candidate: HybridCandidate; score: number; title?: string; reason?: string }> = [];
  for (const selection of result.selections) {
    const candidate = byId.get(selection.candidateId);
    if (!candidate || used.has(selection.candidateId) || !Number.isFinite(selection.score)) continue;
    used.add(selection.candidateId);
    chosen.push({ candidate, score: Math.max(0, Math.min(100, Math.round(selection.score))), title: selection.title, reason: selection.reason });
  }
  const ranked = chosen.sort((a, b) => b.score - a.score || a.candidate.start - b.candidate.start);
  const nonOverlapping: typeof ranked = [];
  for (const item of ranked) {
    if (nonOverlapping.some((other) => item.candidate.start < other.candidate.end && other.candidate.start < item.candidate.end)) continue;
    nonOverlapping.push(item);
    if (nonOverlapping.length >= Math.min(5, Math.max(1, limit))) break;
  }
  return nonOverlapping.map(({ candidate, score, title, reason }) => ({
    ...candidate.highlight,
    id: candidate.id,
    score,
    title: title?.trim().slice(0, 120) || candidate.highlight.title,
    reason: reason?.trim().slice(0, 500) || candidate.highlight.reason,
  })).sort((a, b) => a.start - b.start);
}
