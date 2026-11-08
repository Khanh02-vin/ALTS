import assert from "node:assert/strict";
import type { Transcript } from "../../packages/contracts/transcript.ts";
import { analyzeLocalVideo } from "../../services/ai-pipeline/index.ts";
import { buildScriptOutline, associateHighlightsWithOutline, buildSummaryVariants } from "../../services/ai-pipeline/script-outline.ts";

const transcript: Transcript = {
  version: 1, sourceArtifactId: "src", language: "en", duration: 80, provider: "test",
  words: Array.from({ length: 16 }, (_, i) => ({ id: `w${i}`, text: ["Opening", "idea.", "Middle", "point.", "Another", "fact.", "Ending", "now."][i % 8]!, start: i * 5, end: i * 5 + 2 })),
  segments: [],
};
const outline = buildScriptOutline(transcript);
assert.ok(outline.length >= 4);
assert.ok(outline.every((item, i) => item.start < item.end && (i === 0 || outline[i - 1]!.end <= item.start)));
const highlights = [{ version: 1 as const, id: "h1", sourceArtifactId: "src", start: 0, end: 12, wordIds: ["w0", "w1"], title: "Opening", score: 88 }];
assert.equal(associateHighlightsWithOutline(highlights, outline)[0]!.outlineId, outline[0]!.id);
const variants = buildSummaryVariants(transcript);
assert.equal(variants.length, 2);
assert.ok(variants.every(v => v.ranges.length >= 3 && v.ranges.length <= 4 && v.axis === "summary"));
assert.ok(variants.every(v => v.ranges.every((range, i) => i === 0 || v.ranges[i - 1]!.end <= range.start)));
assert.ok(variants.every(v => v.axis === "summary" && v.dominantAxis === "summary" && v.scores.summary >= 70));
assert.ok(variants.every(v => v.ranges.length === 3 || v.ranges.length === 4));
assert.ok(variants.every(v => {
  const centers = v.ranges.map(range => (range.start + range.end) / 2);
  return centers[0]! < centers[1]! && centers[1]! < centers.at(-1)!;
}), "summary ranges should progress across transcript time");
assert.deepEqual(buildSummaryVariants({ ...transcript, words: transcript.words.slice(0, 4), duration: 20 }), []);
const result = await analyzeLocalVideo("unused.wav", "src", 80, { transcript });
assert.equal(result.scriptOutline.length, outline.length);
assert.ok(result.highlights.every(highlight => highlight.outlineId));
assert.equal(result.summaryVariants.length, 2);
assert.ok(result.summaryVariants.every(variant => variant.axis === "summary"));
console.log("script outline tests: ok");
