import assert from "node:assert/strict";
import { analyzeVideo } from "../../services/ai-pipeline/index.ts";
import { createEditorState, addRange, moveRange, removeRange, updateRange, updateAspectRatio } from "../../packages/editor-core/index.ts";
import { validateRenderPlan } from "../../packages/contracts/render-plan.ts";
import { ApprovalRequiredPublisher } from "../../services/publishing/index.ts";

const analysis = analyzeVideo("source-1", 60);
assert.equal(analysis.highlights.length, 1);
let editor = createEditorState("source-1", 60, { ...analysis.highlights[0], start: 1, end: 10 });
editor = updateAspectRatio(editor, "9:16");
validateRenderPlan(editor.plan, 60);
editor = addRange(editor, { start: 32, end: 36 });
const transcriptWithPause = {
  version: 1,
  sourceArtifactId: "source-1",
  language: "en",
  duration: 60,
  words: [
    { id: "w1", text: "First", start: 32.5, end: 32.9 },
    { id: "w2", text: "thought.", start: 33.0, end: 33.5 },
    { id: "w3", text: "Next", start: 33.55, end: 33.95 },
    { id: "w4", text: "thought.", start: 34.0, end: 34.5 },
  ],
  segments: [{
    id: "s1",
    text: "First thought. Next thought.",
    start: 32.5,
    end: 34.5,
    wordIds: ["w1", "w2", "w3", "w4"],
  }],
  provider: "test",
} as const;
editor = updateRange(editor, { start: 32.52, end: 34.48 }, 1, transcriptWithPause as never);
assert.deepEqual(editor.plan.ranges[1], { start: 32.5, end: 34.5 }, "manual trims should snap to sentence edges");
editor = moveRange(editor, 1, -1);
assert.equal(editor.plan.ranges[0].start, 32.5, "manual order controls output order");
editor = moveRange(editor, 0, 1);
editor = removeRange(editor, 1);
assert.equal(editor.plan.ranges.length, 1);
assert.throws(() => removeRange(editor, 0), /At least one/);
const publisher = new ApprovalRequiredPublisher();
await assert.rejects(() => publisher.publish({ version: 1, id: "p1", artifactId: "a1", platform: "youtube-shorts", accountId: "account", status: "draft" }));
const published = await publisher.publish({ version: 1, id: "p1", artifactId: "a1", platform: "youtube-shorts", accountId: "account", status: "queued" });
assert.equal(published.status, "published");
console.log("MVP pipeline tests: ok");
