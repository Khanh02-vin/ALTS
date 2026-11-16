import assert from "node:assert/strict";
import type { Transcript, Word } from "../../packages/contracts/transcript.ts";
import { buildSemanticUnits, buildSentences } from "../../services/ai-pipeline/semantic-units.ts";

function transcript(words: Array<[string, number, number]>, duration: number, sceneCuts: number[] = []): Transcript {
  const typed: Word[] = words.map(([text, start, end], index) => ({ id: `w-${index}`, text, start, end }));
  return { version: 1, sourceArtifactId: "sentence-fixture", language: "en", duration, provider: "fixture", words: typed, segments: [] };
}

const opts = { minDuration: 5, maxDuration: 60, pauseSeconds: 0.8 };

// 1. Sentence boundaries come from punctuation and pauses, with stable IDs.
{
  const t = transcript([["First.", 0, 0.8], ["Second", 0.9, 1.5], ["word.", 1.5, 2], ["Third", 3, 3.6]], 6);
  const sentences = buildSentences(t);
  assert.deepEqual(sentences.map((sentence) => sentence.id), ["sentence-0", "sentence-1", "sentence-2"]);
  assert.deepEqual(sentences.map((sentence) => sentence.text), ["First.", "Second word.", "Third"]);
  assert.deepEqual(sentences.map((sentence) => sentence.complete), [true, true, false]);
  assert.deepEqual(buildSentences(t).map((sentence) => sentence.id), sentences.map((sentence) => sentence.id), "sentence IDs must be deterministic");
}

// 2. A seed starting with a dangling connector pulls in the subject sentence.
{
  const t = transcript([["We", 0, 0.5], ["had", 0.5, 1], ["problems", 1, 2], ["So", 3, 3.4], ["the", 3.4, 3.7], ["biggest", 3.7, 4.2], ["mistake.", 4.2, 5]], 12);
  const [unit] = buildSemanticUnits(t, undefined, { ...opts, minDuration: 1 });
  assert.ok(unit, "expected one semantic unit");
  assert.equal(unit.start, 0, "a leading 'So' must step back to the sentence that introduces the subject");
  assert.equal(unit.end, 5);}

// 3. A natural pause stops expansion in both directions.
{
  const t = transcript([["Setup", 0, 1], ["here.", 1, 2], ["The", 3, 3.4], ["biggest", 3.4, 3.9], ["mistake.", 3.9, 4.8], ["More", 5, 5.5], ["details.", 5.5, 6.3]], 10);
  const [unit] = buildSemanticUnits(t, undefined, opts);
  assert.ok(unit);
  assert.equal(unit.start, 3, "a 1s pause before the seed must stop backward expansion");
  assert.equal(unit.end, 6.3, "a 0.2s gap after is a continuation, so expansion reaches the next complete sentence");
}

// 4. A scene cut is a hard boundary even without a long pause.
{
  const t = transcript([["Setup", 0, 1], ["here.", 1, 2], ["The", 2.2, 2.6], ["mistake.", 2.6, 3.4], ["New", 3.5, 4], ["scene.", 4, 4.8]], 10);
  const [unit] = buildSemanticUnits(t, undefined, { ...opts, pauseSeconds: 5, sceneCuts: [3.45] });
  assert.ok(unit);
  assert.equal(unit.end, 3.4, "a scene cut between sentences must end the unit");
}

// 5. Short transcripts collapse to one bounded unit; long ones respect maxDuration.
{
  const short = transcript([["One", 0, 1], ["two.", 1, 2]], 10);
  const shortUnits = buildSemanticUnits(short, undefined, { ...opts, minDuration: 45 });
  assert.equal(shortUnits.length, 1);
  assert.equal(shortUnits[0]!.start, 0);
  assert.equal(shortUnits[0]!.end, 2);

  const words = Array.from({ length: 60 }, (_, index) => [`word${index}.`, index * 2, index * 2 + 1.8] as [string, number, number]);
  const long = transcript(words, 120);
  const longUnits = buildSemanticUnits(long, undefined, { ...opts, minDuration: 20, maxDuration: 25 });
  assert.ok(longUnits.length > 1);
  assert.ok(longUnits.every((unit) => unit.end - unit.start <= 25), "units must respect maxDuration");
  assert.ok(longUnits.every((unit) => unit.end <= long.duration));
}

// 6. RMS helps choose the seed when two sentences carry the same hook cue.
{
  const t = transcript([["The", 0, 1], ["mistake.", 1, 2], ["quiet", 4, 5], ["mistake.", 5, 6]], 10);
  const audioRms = { windows: [], query: (start: number) => start < 3 ? 0.01 : 0.09 };
  const [unit] = buildSemanticUnits(t, audioRms, { ...opts, minDuration: 1 });
  assert.ok(unit);
  assert.equal(unit.start, 4, "the higher-energy sentence should become the seed");
}

console.log("semantic units: ok");
