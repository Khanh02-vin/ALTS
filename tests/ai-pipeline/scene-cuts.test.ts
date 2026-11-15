import assert from "node:assert/strict";
import { parseSceneCutMetadata } from "../../services/ai-pipeline/scene-cuts.ts";
import { snapHighlightsToScenes } from "../../services/ai-pipeline/scene-snap.ts";
import type { Highlight } from "../../packages/contracts/highlight.ts";
import type { Transcript } from "../../packages/contracts/transcript.ts";

const transcript: Transcript = {
  version: 1, sourceArtifactId: "scene-test", language: "en", duration: 32, provider: "fixture",
  words: [
    { id: "before", text: "before", start: 9.2, end: 9.8 },
    { id: "first", text: "first", start: 10.15, end: 12 },
    { id: "last", text: "last", start: 17, end: 19.8 },
    { id: "after", text: "after", start: 20.2, end: 21 },
  ],
  segments: [],
};
const highlight: Highlight = { version: 1, id: "h", sourceArtifactId: "scene-test", start: 10.4, end: 19.9, wordIds: ["stale"], title: "clip", score: 82 };

assert.deepEqual(parseSceneCutMetadata("frame:1 lavfi.scd.time=10.1 lavfi.scd.score=22\nframe:2 lavfi.scd.time=20.25 lavfi.scd.score=25", 32), [10.1, 20.25]);
assert.deepEqual(parseSceneCutMetadata("frame:1 lavfi.scd.time=10.1 lavfi.scd.score=18", 32), [], "sub-threshold scene scores are ignored");
assert.deepEqual(parseSceneCutMetadata("lavfi.scd.time=0\nlavfi.scd.time=32", 32), []);
const snapped = snapHighlightsToScenes([highlight], transcript, [20.25, 10.1]);
assert.equal(snapped[0]!.start, 10.1);
assert.equal(snapped[0]!.end, 20.25);
assert.deepEqual(snapped[0]!.wordIds, ["first", "last"]);
assert.equal(snapped[0]!.score, highlight.score);
assert.deepEqual(snapHighlightsToScenes([highlight], transcript, [8, 22]), [highlight]);
console.log("scene cuts and snapping: ok");
