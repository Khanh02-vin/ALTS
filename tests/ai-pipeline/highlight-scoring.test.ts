/// Guards the component-score scale: a clip analysed without audio must not be
/// silently scored as if it had flat audio. Hook and impact are normalised over
/// the signals that were actually measured, and the highlight says whether audio
/// energy was part of its score.
import assert from "node:assert/strict";
import { componentScoreMetadata, scoreHighlightComponents, type AudioRmsFeatures } from "../../services/ai-pipeline/highlight-scoring.ts";
import type { Transcript } from "../../packages/contracts/transcript.ts";

const transcript = {
  sourceArtifactId: "artifact-1",
  duration: 30,
  language: "en",
  segments: [{ id: "seg-1", start: 0, end: 30, text: "Start here and finish the idea?", wordIds: [] }],
} as unknown as Transcript;

const strongText = {
  start: 0,
  end: 30,
  text: "Start here and finish the idea?",
  transcript,
  hookCue: true,
  complete: true,
  pauseBoundary: true,
};

/** One 1 s window per second over [0, seconds). */
function windows(seconds: number, rms: (index: number) => number): AudioRmsFeatures {
  return {
    windows: Array.from({ length: seconds }, (_, index) => ({ start: index, end: index + 1, rms: rms(index) })),
    query: () => 0,
  };
}

// Text-only: every measurable signal is present, so the axes sit at their ceiling
// instead of losing the 25/15 points reserved for the missing audio term.
const textOnly = scoreHighlightComponents(strongText);
assert.equal(textOnly.hook, 100);
assert.equal(textOnly.impact, 100);

// Measured but flat audio is information, not a missing signal: it stays on the
// same 0–100 scale and loses exactly the audio contribution.
const flat = scoreHighlightComponents({ ...strongText, audioRms: windows(30, () => 0.02) });
assert.equal(flat.hook, 75);
assert.equal(flat.impact, 85);

// A peak in the first three seconds plus variation across the clip fills both axes.
const lively = scoreHighlightComponents({ ...strongText, audioRms: windows(30, (index) => (index % 2 ? 0.05 : 0.01)) });
assert.equal(lively.hook, 100);
assert.equal(lively.impact, 100);

// Summary never reads audio, so its value must not move with it.
assert.equal(flat.summary, textOnly.summary);

// Weak signals stay inside 0–100 on both paths.
const weak = { start: 0, end: 4, text: "ok", transcript, hookCue: false, complete: false, pauseBoundary: false };
const weakTextOnly = scoreHighlightComponents(weak);
const weakWithAudio = scoreHighlightComponents({ ...weak, audioRms: windows(4, (index) => (index % 2 ? 0.05 : 0.01)) });
assert.equal(weakTextOnly.hook, 40);
assert.equal(weakTextOnly.impact, 29);
for (const scores of [weakTextOnly, weakWithAudio]) {
  for (const value of Object.values(scores)) assert.ok(value >= 0 && value <= 100, `axis out of range: ${value}`);
}

// The highlight carries whether audio energy contributed to hook/impact.
assert.equal(componentScoreMetadata(undefined, textOnly, false).scoreAudio, false);
assert.equal(componentScoreMetadata(undefined, textOnly, true).scoreAudio, true);
// Provider values win over the deterministic fallback, and defaults stay explicit.
assert.deepEqual(componentScoreMetadata({ hook: 80 }, textOnly).scores, { hook: 80, summary: textOnly.summary, impact: textOnly.impact });
assert.equal(componentScoreMetadata({ hook: 80 }, textOnly).scoreAudio, false);

console.log("highlight-scoring: ok");
