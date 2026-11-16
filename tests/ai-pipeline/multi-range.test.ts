import assert from "node:assert/strict";
import { createEditorState } from "../../packages/editor-core/index.ts";
import { validateHighlights, type Highlight } from "../../packages/contracts/highlight.ts";
import { remapCaptionTimes, unionHighlightRanges, buildValidatedRanges } from "../../services/ai-pipeline/multi-range.ts";

function highlight(overrides: Partial<Highlight> = {}): Highlight {
  return { version: 1, id: "h", sourceArtifactId: "src", start: 88, end: 191.8, wordIds: ["a", "b", "c"], title: "Finish the work", score: 80, ...overrides };
}

// Contract stays backward compatible: legacy highlights have no ranges.
{
  validateHighlights([highlight()], 300);
  const state = createEditorState("src", 300, highlight());
  assert.deepEqual(state.plan.ranges, [{ start: 88, end: 191.8 }]);
}

// Two ranges keep the outer union for old consumers but export as two pieces.
{
  const multi = highlight({
    ranges: [
      { start: 88, end: 109, wordIds: ["a"], role: "setup" },
      { start: 119, end: 191.8, wordIds: ["b", "c"], role: "core" },
    ],
  });
  validateHighlights([multi], 300);
  const state = createEditorState("src", 300, multi);
  assert.deepEqual(state.plan.ranges, [
    { start: 88, end: 109 },
    { start: 119, end: 191.8 },
  ]);
  assert.equal(state.plan.effects?.includes("jump-cut"), true, "multi-range exports must request the jump-cut render path");
}

// Malformed ranges are rejected instead of silently rendering the gaps.
{
  const bad = highlight({ ranges: [{ start: 200, end: 210, wordIds: ["a"] }, { start: 88, end: 100, wordIds: ["b"] }] });
  assert.throws(() => validateHighlights([bad], 300), /range/i);
  const wrongUnion = highlight({ start: 0, ranges: [{ start: 88, end: 109, wordIds: ["a"] }] });
  assert.throws(() => validateHighlights([wrongUnion], 300), /union/i);
}

// Removing the 10s hedge shifts every later caption back by exactly that gap.
{
  const captions = [
    { id: "c1", text: "first", start: 90, end: 95, words: [{ text: "first", start: 91, end: 92 }] },
    { id: "c2", text: "hedge", start: 112, end: 116 },
    { id: "c3", text: "last", start: 150, end: 155, words: [{ text: "last", start: 151, end: 152 }] },
  ];
  const remapped = remapCaptionTimes(captions, [{ start: 88, end: 109 }, { start: 119, end: 191.8 }]);
  assert.equal(remapped.find((caption) => caption.id === "c1")!.start, 90);
  assert.equal(remapped.find((caption) => caption.id === "c3")!.start, 140, "captions after the jump move back by the 10s cut");
  assert.equal(remapped.find((caption) => caption.id === "c3")!.words![0]!.start, 141);
  assert.equal(remapped.some((caption) => caption.id === "c2"), false, "captions in removed ranges are dropped");
}

// Union helper is the single source of truth for start/end/wordIds.
{
  const union = unionHighlightRanges([
    { start: 119, end: 191.8, wordIds: ["b", "c"] },
    { start: 88, end: 109, wordIds: ["a"] },
  ]);
  assert.deepEqual(union, { start: 88, end: 191.8, wordIds: ["a", "b", "c"] });
}

// LLM returns sentence IDs; local code derives timestamps and drops the hedge.
{
  const words = Array.from({ length: 60 }, (_, index) => ({ id: `w-${index}`, text: "word", start: index * 3, end: index * 3 + 2.8 }));
  const transcript = { version: 1 as const, sourceArtifactId: "src", language: "en", duration: 180, provider: "fixture", words, segments: [] };
  const sentences = Array.from({ length: 6 }, (_, index) => ({
    id: `sentence-${index}`,
    start: index * 30,
    end: index * 30 + 27,
    text: "sentence",
    wordIds: words.filter((word) => word.start >= index * 30 && word.end <= index * 30 + 27).map((word) => word.id),
  }));
  const ranges = buildValidatedRanges(
    [{ startSentenceId: "sentence-1", endSentenceId: "sentence-2" }, { startSentenceId: "sentence-4", endSentenceId: "sentence-5" }],
    sentences,
    transcript,
    { start: 30, end: 177, wordIds: [] },
    { minTotal: 30, maxTotal: 120, mergeGap: 1.5 },
  );
  assert.ok(ranges, "valid sentence IDs must produce ranges");
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0]!.start, 30);
  assert.equal(ranges[0]!.end, 87);
  assert.equal(ranges[1]!.start, 120);
  assert.equal(ranges[1]!.end, 177);
  assert.equal(ranges[0]!.role, "setup");
  assert.equal(ranges[1]!.role, "payoff");
  assert.ok(ranges[0]!.wordIds.length > 0, "wordIds come from the transcript, not the model");
}

console.log("multi-range: ok");
