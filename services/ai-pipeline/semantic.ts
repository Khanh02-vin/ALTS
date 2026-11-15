import type { Highlight, HighlightScores } from "../../packages/contracts/highlight.ts";
import type { Transcript } from "../../packages/contracts/transcript.ts";
import { validateHighlights } from "../../packages/contracts/highlight.ts";
import { componentScoreMetadata, scoreHighlightComponents } from "./highlight-scoring.ts";

export type SemanticHighlightProposal = {
  start: number;
  end: number;
  wordIds: string[];
  title: string;
  hook?: string;
  score: number;
  scores?: HighlightScores;
  reason?: string;
};

export type SemanticHighlightResult = {
  highlights: Highlight[];
  provider: string;
  rawProposals?: SemanticHighlightProposal[];
};

export type SemanticRerankCandidate = {
  id: string;
  start: number;
  end: number;
  text: string;
  confidence: number;
  energy?: number;
  silenceBoundary: boolean;
  componentScores?: HighlightScores;
};

export type SemanticRerankResult = {
  selections: Array<{ candidateId: string; score: number; title?: string; reason?: string }>;
};

export type SemanticHighlightOptions = {
  category?: string;
  limit?: number;
  minDuration?: number;
  maxDuration?: number;
  /** Transcript window length (seconds) handed to the LLM per call. */
  windowSeconds?: number;
  /** Overlap between consecutive windows (seconds). */
  windowOverlapSeconds?: number;
};

export interface SemanticHighlightProvider {
  generate(
    input: { transcript: Transcript; options?: SemanticHighlightOptions; signal?: AbortSignal }
  ): Promise<SemanticHighlightResult>;
  rerank?(input: { transcript: Transcript; candidates: SemanticRerankCandidate[]; limit: number; signal?: AbortSignal }): Promise<SemanticRerankResult>;
}

export class NotImplementedSemanticProvider implements SemanticHighlightProvider {
  async generate(): Promise<SemanticHighlightResult> {
    throw new Error("SEMANTIC_HIGHLIGHT_NOT_IMPLEMENTED");
  }
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function fallbackComponentScores(
  transcript: Transcript,
  input: { start: number; end: number; text?: string; title?: string; hook?: string },
): HighlightScores {
  const words = transcript.words.filter((word) => word.start >= input.start && word.end <= input.end);
  return scoreHighlightComponents({
    start: input.start,
    end: input.end,
    text: input.text || words.map((word) => word.text).join(" ") || input.title || "",
    transcript,
    hookCue: Boolean(input.hook) || /\b(how|why|secret|mistake|important|best|never|first|problem|solution|learn|key)\b/i.test(input.title ?? ""),
    complete: /[.!?]$/.test(words.at(-1)?.text.trim() ?? ""),
    pauseBoundary: transcript.words.some((word, index, all) => index > 0 && all[index - 1].start >= input.start && word.end <= input.end && word.start - all[index - 1].end >= 0.7),
  });
}

function normalizeHighlightMetadata(transcript: Transcript, highlight: Highlight): Highlight {
  return {
    ...highlight,
    ...componentScoreMetadata(highlight.scores, fallbackComponentScores(transcript, highlight)),
  };
}

function normalizeProposals(
  transcript: Transcript,
  proposals: SemanticHighlightProposal[],
  options: Required<SemanticHighlightOptions>
): Highlight[] {
  const duration = transcript.duration;
  const wordIdSet = new Set(transcript.words.map((w) => w.id));

  const normalized: Highlight[] = [];
  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    if (!Number.isFinite(p.start) || !Number.isFinite(p.end) || p.start < 0 || p.end <= p.start) {
      continue;
    }
    if (p.end > duration) {
      continue;
    }
    if (p.end - p.start < options.minDuration || p.end - p.start > options.maxDuration) {
      continue;
    }
    if (p.wordIds.some((id) => !wordIdSet.has(id))) {
      continue;
    }
    const words = transcript.words.filter((w) => w.start >= p.start && w.end <= p.end);
    const wordIds = words.length > 0 ? words.map((w) => w.id) : p.wordIds;
    if (wordIds.length === 0) {
      continue;
    }
    const fallback = fallbackComponentScores(transcript, {
      start: p.start,
      end: p.end,
      text: words.map((word) => word.text).join(" "),
      title: p.title,
      hook: p.hook,
    });
    normalized.push({
      version: 1 as const,
      id: `semantic-${i}`,
      sourceArtifactId: transcript.sourceArtifactId,
      start: p.start,
      end: p.end,
      wordIds,
      title: p.title.trim().slice(0, 120),
      hook: p.hook?.trim().slice(0, 200),
      score: clampScore(p.score),
      ...componentScoreMetadata(p.scores, fallback),
      reason: p.reason?.trim().slice(0, 500) ?? "semantic proposal",
    });
  }
  return normalized;
}

function deoverlapAndRank(highlights: Highlight[], limit: number): Highlight[] {
  const sorted = [...highlights].sort((a, b) => b.score - a.score || a.start - b.start);
  const chosen: Highlight[] = [];
  for (const candidate of sorted) {
    if (chosen.some((other) => candidate.start < other.end && other.start < candidate.end)) {
      continue;
    }
    chosen.push(candidate);
    if (chosen.length >= limit) break;
  }
  return chosen.sort((a, b) => a.start - b.start);
}

export async function generateSemanticHighlights(
  transcript: Transcript,
  provider: SemanticHighlightProvider,
  options: SemanticHighlightOptions = {}
): Promise<Highlight[]> {
  const mergedOptions = {
    category: options.category ?? "default",
    limit: options.limit ?? 5,
    minDuration: options.minDuration ?? 10,
    maxDuration: options.maxDuration ?? 90,
    windowSeconds: options.windowSeconds ?? 180,
    windowOverlapSeconds: options.windowOverlapSeconds ?? 30,
  };

  const result = await provider.generate({ transcript, options: mergedOptions });

  if (!result?.highlights || result.highlights.length === 0) {
    if (result?.rawProposals?.length) {
      const normalized = normalizeProposals(transcript, result.rawProposals, mergedOptions);
      const ranked = deoverlapAndRank(normalized, mergedOptions.limit);
      validateHighlights(ranked, transcript.duration);
      return ranked;
    }
    return [];
  }

  const ranked = deoverlapAndRank(result.highlights.map((highlight) => normalizeHighlightMetadata(transcript, highlight)), mergedOptions.limit);
  validateHighlights(ranked, transcript.duration);
  return ranked;
}

export function createMockSemanticProvider(
  proposals: SemanticHighlightProposal[],
  providerName = "mock-semantic"
): SemanticHighlightProvider {
  return {
    async generate({ transcript }) {
      const proposalsWithinDuration = proposals.filter(
        (p) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end <= transcript.duration
      );
      const highlights: Highlight[] = proposalsWithinDuration.map((p, i) => ({
        version: 1 as const,
        id: `semantic-${i}`,
        sourceArtifactId: transcript.sourceArtifactId,
        start: p.start,
        end: p.end,
        wordIds: p.wordIds,
        title: p.title,
        hook: p.hook,
        score: p.score,
        ...componentScoreMetadata(p.scores, fallbackComponentScores(transcript, {
          ...p,
          text: transcript.words.filter((word) => word.start >= p.start && word.end <= p.end).map((word) => word.text).join(" "),
        })),
        reason: p.reason,
      }));
      return { highlights, provider: providerName, rawProposals: proposalsWithinDuration };
    },
  };
}

/**
 * Adapts the existing LLM HighlightProvider interface (Gemini, etc.) to the
 * SemanticHighlightProvider shape expected by the local-first pipeline.
 */
export class SemanticProviderAdapter implements SemanticHighlightProvider {
  private readonly inner: {
    choose(input: { transcript: Transcript; signal?: AbortSignal; windowSeconds?: number; overlapSeconds?: number }): Promise<Highlight[]>;
    rerank?(input: { transcript: Transcript; candidates: SemanticRerankCandidate[]; limit: number; signal?: AbortSignal }): Promise<SemanticRerankResult>;
  };
  private readonly name: string;
  constructor(inner: { choose(input: { transcript: Transcript; signal?: AbortSignal; windowSeconds?: number; overlapSeconds?: number }): Promise<Highlight[]>; rerank?(input: { transcript: Transcript; candidates: SemanticRerankCandidate[]; limit: number; signal?: AbortSignal }): Promise<SemanticRerankResult> }, name = "semantic-llm") { this.inner = inner; this.name = name; }

  async rerank(input: { transcript: Transcript; candidates: SemanticRerankCandidate[]; limit: number; signal?: AbortSignal }): Promise<SemanticRerankResult> {
    if (!this.inner.rerank) throw new Error("SEMANTIC_RERANK_UNSUPPORTED");
    return this.inner.rerank(input);
  }
  async generate(input: { transcript: Transcript; options?: SemanticHighlightOptions; signal?: AbortSignal }): Promise<SemanticHighlightResult> {
    const highlights = (await this.inner.choose({
      transcript: input.transcript,
      signal: input.signal,
      windowSeconds: input.options?.windowSeconds,
      overlapSeconds: input.options?.windowOverlapSeconds,
    })).map((highlight) => normalizeHighlightMetadata(input.transcript, highlight));
    return {
      highlights,
      provider: this.name,
      rawProposals: highlights.map((highlight) => ({
        start: highlight.start,
        end: highlight.end,
        wordIds: highlight.wordIds,
        title: highlight.title,
        hook: highlight.hook,
        score: highlight.score,
        scores: highlight.scores,
        reason: highlight.reason,
      })),
    };
  }
}