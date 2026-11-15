import assert from "node:assert/strict";
import { chooseContentHighlights } from "../../services/ai-pipeline/content-highlights.ts";
import type { Transcript } from "../../packages/contracts/transcript.ts";

function makeTranscript(segments: Transcript["segments"], duration: number): Transcript {
  return { version: 1, sourceArtifactId: "content-regression", language: "en", duration, provider: "fixture", words: [], segments };
}

// A short, self-contained hook late in a long recording should still be a viable
// candidate, while short filler without a hook stays below the normal 15s floor.
{
  const transcript = makeTranscript([
    { id: "filler", text: "A quiet walk home after a long day with no real point.", start: 0, end: 10 },
    { id: "hook", text: "The biggest mistake is shipping features nobody asked for.", start: 10, end: 20.2, wordIds: [] },
    { id: "tail", text: "That is the lesson.", start: 20.2, end: 34, wordIds: [] },
  ], 180);
  const highlights = chooseContentHighlights(transcript, 15);
  assert.ok(highlights.some((highlight) => highlight.start === 10 && highlight.end === 20.2), "standalone short hook should be retained");
  assert.ok(!highlights.some((highlight) => highlight.start === 0 && highlight.end === 10), "short filler should not bypass the minimum window duration");
}

// A hook in a later segment must contribute when ranking a longer content window.
{
  const transcript = makeTranscript([
    { id: "setup", text: "We spent the morning waiting and walking around the old town.", start: 0, end: 16, wordIds: [] },
    { id: "hook", text: "The biggest mistake was ignoring what customers asked for.", start: 16, end: 31, wordIds: [] },
    { id: "end", text: "That changed the entire launch plan.", start: 31, end: 46, wordIds: [] },
  ], 180);
  const highlights = chooseContentHighlights(transcript, 5);
  assert.ok(highlights.some((highlight) => highlight.start <= 16 && highlight.end >= 31 && highlight.hook?.includes("biggest mistake")), "combined content windows should recognize hooks after the first segment");
}

console.log("content highlight regressions: ok");
