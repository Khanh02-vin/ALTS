import type { Highlight } from "../../packages/contracts/highlight.ts";
import type { Transcript } from "../../packages/contracts/transcript.ts";
import { validateHighlights } from "../../packages/contracts/highlight.ts";
import { componentScoreMetadata, scoreAggregateHighlight, scoreHighlightComponents, type AudioRmsFeatures } from "./highlight-scoring.ts";
import { PAUSE_SECONDS, SENTENCE_END } from "./text-boundaries.ts";

const HOOK_WORDS = /\b(how|why|secret|mistake|important|best|never|first|problem|solution|learn|key)\b/i;
// A candidate window may not exceed this many seconds. Whisper segments rarely
// run longer; without a cap an engine that emits neither punctuation nor pauses
// would collapse a whole recording into one highlight.
const MAX_WINDOW_SECONDS = 30.0;
// A window must contain at least this many seconds of audio to be a candidate.
const MIN_WINDOW_SECONDS = 4.0;

export type HeuristicWindow = {
  start: number;
  end: number;
  wordIds: string[];
  text: string;
  hook: boolean;
  complete: boolean;
  pauseBoundary: boolean;
  score: number;
  scores: { hook: number; summary: number; impact: number };
};

/** Builds candidate windows from transcript boundaries for ranking and evaluation. */
export function buildWindows(transcript: Transcript, audioRms?: AudioRmsFeatures): HeuristicWindow[] {
  const windows: HeuristicWindow[] = [];
  const addWindow = (
    start: number,
    end: number,
    wordIds: string[],
    text: string,
    hook: boolean,
    complete: boolean,
    pauseBoundary: boolean,
  ) => {
    const score = scoreAggregateHighlight({ start, end, text, transcript, hookCue: hook, complete, pauseBoundary, audioRms, baseScore: Math.min(100, (wordIds.length || text.split(/\s+/).filter(Boolean).length) * 5 + (hook ? 25 : 0) + (complete ? 10 : 0) + (pauseBoundary ? 8 : 0)) });
    const scores = scoreHighlightComponents({
      start,
      end,
      text,
      transcript,
      hookCue: hook,
      complete,
      pauseBoundary,
      audioRms,
    });
    windows.push({ start, end, wordIds, text, hook, complete, pauseBoundary, score, scores });
  };

  if (transcript.words.length > 0) {
    addWordWindows(transcript, addWindow);
  } else {
    addSegmentWindows(transcript, addWindow);
  }

  return windows;
}

type WindowSink = (
  start: number,
  end: number,
  wordIds: string[],
  text: string,
  hook: boolean,
  complete: boolean,
  pauseBoundary: boolean,
) => void;

/** True when the gap on either side of [start, end) is long enough to be a cut. */
function hasPauseBoundary(
  beforeEnd: number | undefined,
  afterStart: number | undefined,
  start: number,
  end: number,
): boolean {
  const gapBefore = beforeEnd === undefined ? 0 : start - beforeEnd;
  const gapAfter = afterStart === undefined ? 0 : afterStart - end;
  return gapBefore >= PAUSE_SECONDS || gapAfter >= PAUSE_SECONDS;
}

/**
 * Sentence mode: walk the words and cut at sentence ends, pauses and the
 * max-length cap. Boundaries come from the words, never from a clock tick, so a
 * candidate is the same span no matter which engine produced the words.
 */
function addWordWindows(transcript: Transcript, addWindow: WindowSink): void {
  const words = transcript.words;
  type Group = { start: number; end: number; words: typeof words };

  const groups: Group[] = [];
  let group: Group | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const prev = words[i - 1];
    if (
      group && prev &&
      (SENTENCE_END.test(prev.text.trim()) ||
        word.start - prev.end >= PAUSE_SECONDS ||
        word.end - group.start > MAX_WINDOW_SECONDS)
    ) {
      groups.push(group);
      group = undefined;
    }
    group ??= { start: word.start, end: word.end, words: [] };
    group.end = word.end;
    group.words.push(word);
  }
  if (group) groups.push(group);

  for (const candidate of groups) {
    if (candidate.end - candidate.start < MIN_WINDOW_SECONDS) continue;
    const text = candidate.words.map((w) => w.text).join(" ");
    const hook = candidate.words.some((w) => HOOK_WORDS.test(w.text));
    const complete = SENTENCE_END.test(
      candidate.words[candidate.words.length - 1]!.text.trim(),
    );
    const prevWord = words.findLast((w) => w.end <= candidate.start);
    const nextWord = words.find((w) => w.start >= candidate.end);
    addWindow(
      candidate.start,
      candidate.end,
      candidate.words.map((w) => w.id),
      text,
      hook,
      complete,
      hasPauseBoundary(prevWord?.end, nextWord?.start, candidate.start, candidate.end),
    );
  }
}

/** No words at all: each segment is one candidate window. */
function addSegmentWindows(transcript: Transcript, addWindow: WindowSink): void {
  for (const segment of transcript.segments) {
    const duration = segment.end - segment.start;
    if (duration < MIN_WINDOW_SECONDS) continue;
    const text = segment.text.trim();
    const prevSegment = transcript.segments.findLast(
      (s) => s.end <= segment.start,
    );
    const nextSegment = transcript.segments.find(
      (s) => s.start >= segment.end,
    );
    addWindow(
      segment.start,
      segment.end,
      segment.wordIds,
      text,
      HOOK_WORDS.test(text),
      SENTENCE_END.test(text),
      hasPauseBoundary(prevSegment?.end, nextSegment?.start, segment.start, segment.end),
    );
  }
}

/** Non-maximum suppression: keep the highest-scoring window, drop any later window
 *  that overlaps it at all, repeat. Result is sorted by start time so highlights
 *  appear in chronological order and never overlap (satisfies validateHighlights). */
export function nonMaximumSuppression(
  windows: Array<{ start: number; end: number; score: number }>,
  limit: number,
): Array<{ start: number; end: number; score: number }> {
  const sorted = [...windows].sort((a, b) => b.score - a.score || a.start - b.start);
  const chosen: Array<{ start: number; end: number; score: number }> = [];
  for (const w of sorted) {
    const overlaps = chosen.some((c) => w.start < c.end && c.start < w.end);
    if (!overlaps) chosen.push(w);
    if (chosen.length >= limit) break;
  }
  return chosen.sort((a, b) => a.start - b.start);
}

export function selectHeuristicWindows<T extends { start: number; end: number; score: number }>(windows: T[], limit: number): T[] {
  const sorted = [...windows].sort((a, b) => b.score - a.score || a.start - b.start);
  const chosen: T[] = [];
  for (const window of sorted) {
    if (chosen.some((selected) => window.start < selected.end && selected.start < window.end)) continue;
    chosen.push(window);
    if (chosen.length >= limit) break;
  }
  return chosen.sort((a, b) => a.start - b.start);
}

export function chooseHeuristicHighlights(transcript: Transcript, limit = 5, audioRms?: AudioRmsFeatures): Highlight[] {
  const windows = buildWindows(transcript, audioRms);
  const chosen = nonMaximumSuppression(windows, limit);
  const highlights = chosen.map((w, index) => ({
    version: 1 as const,
    id: `heuristic-${index}`,
    sourceArtifactId: transcript.sourceArtifactId,
    start: w.start,
    end: w.end,
    wordIds: w.wordIds,
    title: w.text.slice(0, 80),
    hook: w.hook ? w.text.slice(0, 100) : undefined,
    score: w.score,
    ...componentScoreMetadata(w.scores, undefined, audioRms !== undefined),
    reason: [
      ...(w.hook ? ["hook keyword"] : []),
      ...(w.complete ? ["complete sentence"] : []),
      ...(w.pauseBoundary ? ["pause boundary"] : []),
      "sentence group",
    ]
      .filter(Boolean)
      .join(", "),
  }));
  validateHighlights(highlights, transcript.duration);
  return highlights;
}
