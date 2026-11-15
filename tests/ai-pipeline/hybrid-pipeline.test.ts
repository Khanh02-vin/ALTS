import assert from "node:assert/strict";
import { analyzeLocalVideoWithSemantic } from "../../services/ai-pipeline/index.ts";
import type { SemanticHighlightProvider } from "../../services/ai-pipeline/semantic.ts";
import type { Transcript } from "../../packages/contracts/transcript.ts";

const words = Array.from({ length: 80 }, (_, index) => ({
  id: `w-${index}`, text: index % 10 === 9 ? "result." : "useful", start: index * 0.5, end: index * 0.5 + 0.35,
}));
const transcript: Transcript = {
  version: 1, sourceArtifactId: "pipeline-hybrid", duration: 40, language: "en", provider: "fixture", words,
  segments: [{ id: "s-1", start: 0, end: 39.85, text: words.map((word) => word.text).join(" "), wordIds: words.map((word) => word.id) }],
};
let rerankCalls = 0;
let receivedCount = 0;
const provider: SemanticHighlightProvider = {
  async generate() { throw new Error("legacy semantic selection should not run"); },
  async rerank({ candidates }) {
    rerankCalls += 1;
    receivedCount = candidates.length;
    return { selections: [{ candidateId: candidates.at(-1)!.id, score: 97, title: "Reranked moment", reason: "strongest payoff" }] };
  },
};
const successful = await analyzeLocalVideoWithSemantic("unused.wav", "pipeline-hybrid", 40, { transcript, semanticProvider: provider });
assert.equal(rerankCalls, 1);
assert.ok(receivedCount > 0 && receivedCount <= 15);
assert.equal(successful.highlights.length, 1);
assert.equal(successful.highlights[0]!.title, "Reranked moment");
assert.equal(successful.highlights[0]!.score, 97);

const offline = await analyzeLocalVideoWithSemantic("unused.wav", "pipeline-hybrid", 40, {
  transcript,
  semanticProvider: { async generate() { throw new Error("unused"); }, async rerank() { throw new Error("provider offline"); } },
});
assert.ok(offline.highlights.length > 0 && offline.highlights.length <= 5, "provider failure returns a local top-five shortlist");
assert.ok(offline.highlights.every((highlight) => highlight.id.startsWith("heuristic-")), "fallback retains deterministic local highlights");
console.log("hybrid pipeline tests: ok");
