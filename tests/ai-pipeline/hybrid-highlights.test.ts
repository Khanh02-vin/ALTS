import assert from "node:assert/strict";
import type { Transcript } from "../../packages/contracts/transcript.ts";
import { buildRerankCandidates, rerankCandidates } from "../../services/ai-pipeline/hybrid-highlights.ts";
import type { SemanticHighlightProvider, SemanticRerankResult } from "../../services/ai-pipeline/semantic.ts";

const words = Array.from({ length: 150 }, (_, index) => ({
  id: `w-${index}`, text: index % 20 === 0 ? "important" : "word", start: index * 0.5, end: index * 0.5 + 0.4,
}));
const transcript: Transcript = {
  version: 1, sourceArtifactId: "hybrid", duration: 80, language: "en", provider: "fixture", words,
  segments: Array.from({ length: 10 }, (_, index) => ({
    id: `s-${index}`, start: index * 8, end: index * 8 + 7.5,
    text: "This is an important useful idea with a complete result.",
    wordIds: words.slice(index * 15, index * 15 + 15).map((word) => word.id),
  })),
};
const audioRms = {
  windows: Array.from({ length: 800 }, (_, index) => ({ start: index / 10, end: (index + 1) / 10, rms: index < 100 ? 0.07 : 0.02 })),
  query: (start: number, end: number) => start < 10 && end > 0 ? 0.07 : 0.02,
};

const candidates = buildRerankCandidates(transcript, audioRms, 15);
assert.ok(candidates.length > 0 && candidates.length <= 15);
assert.equal(new Set(candidates.map((candidate) => candidate.id)).size, candidates.length);
assert.ok(candidates.every((candidate) => Number.isFinite(candidate.confidence) && candidate.confidence >= 0 && candidate.confidence <= 100));
assert.ok(candidates.some((candidate) => candidate.energy !== undefined));
assert.ok(candidates.every((candidate) => typeof candidate.silenceBoundary === "boolean"));
assert.deepEqual(buildRerankCandidates(transcript, undefined, 0), []);

const rerankProvider: SemanticHighlightProvider = {
  async generate() { throw new Error("first-pass generate must not run"); },
  async rerank() {
    return { selections: [
      { candidateId: candidates[1]!.id, score: 99, title: "LLM choice", reason: "strong" },
      { candidateId: "not-real", score: 100 },
      { candidateId: candidates[1]!.id, score: 98 },
      { candidateId: candidates[0]!.id, score: 80 },
    ] } satisfies SemanticRerankResult;
  },
};
const reranked = await rerankCandidates(transcript, candidates, rerankProvider, 5);
assert.equal(reranked.length, 2, "unknown and duplicate candidate IDs must be ignored");
assert.equal(reranked.find((item) => item.title === "LLM choice")?.id, candidates[1]!.id);
assert.equal(reranked.find((item) => item.title === "LLM choice")?.id, candidates[1]!.id);
assert.equal(reranked.find((item) => item.title === "LLM choice")?.title, "LLM choice");
assert.equal(reranked.find((item) => item.title === "LLM choice")?.start, candidates[1]!.highlight.start, "LLM cannot change candidate timestamps");
assert.ok(reranked.every((highlight) => candidates.some((candidate) => candidate.id === highlight.id)), "reranked items must map back to supplied candidates");

const failingProvider: SemanticHighlightProvider = {
  async generate() { throw new Error("unused"); },
  async rerank() { throw new Error("provider offline"); },
};
await assert.rejects(() => rerankCandidates(transcript, candidates, failingProvider), /provider offline/);
console.log("hybrid rerank tests: ok");
