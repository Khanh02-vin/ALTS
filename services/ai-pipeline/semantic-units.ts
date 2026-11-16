import type { Highlight } from "../../packages/contracts/highlight.ts";
import type { Transcript, Word } from "../../packages/contracts/transcript.ts";
import { componentScoreMetadata, scoreAggregateHighlight, scoreHighlightComponents, type AudioRmsFeatures } from "./highlight-scoring.ts";
import { assessNarrativeArc, type NarrativeArc } from "./narrative-arc.ts";

const HOOK_CUE = /\b(how|why|problem|mistake|secret|important|key|solution|example|first|never|best)\b/i;
const SENTENCE_END = /[.!?]["')\]]?$/;
const SENTENCE_PAUSE_SECONDS = 0.7;
// A clip that begins with a connector has no referent yet; step back at most
// two sentences to find the subject it points at.
const DANGLING_START = /^(so|because|and|but|then|this|that|it|they|which|also|however|therefore|which is why|as i said|like i said|for that|vì vậy|do đó|vì thế|điều này|cái đó|như vừa nói|nên|rồi)\b/i;
const NON_SPEECH = /^[(\[]|\b(upbeat music|music|applause|laughter|silence|subtitles)\b/i;

export type Sentence = {
  id: string;
  start: number;
  end: number;
  text: string;
  wordIds: string[];
  complete: boolean;
};

export type SemanticUnit = {
  id: string;
  start: number;
  end: number;
  text: string;
  wordIds: string[];
  sentenceIds: string[];
  score: number;
  arc: NarrativeArc;
  highlight: Highlight;
};

export type SemanticUnitOptions = {
  minDuration?: number;
  maxDuration?: number;
  pauseSeconds?: number;
  sceneCuts?: number[];
  limit?: number;
};

/** Split a transcript into deterministic sentences; word timings win, segments are the fallback. */
export function buildSentences(transcript: Transcript): Sentence[] {
  const words = transcript.words;
  if (!words.length) {
    return transcript.segments.map((segment, index) => ({
      id: `sentence-${index}`,
      start: segment.start,
      end: segment.end,
      text: segment.text.trim(),
      wordIds: [...segment.wordIds],
      complete: SENTENCE_END.test(segment.text.trim()),
    }));
  }
  const sentences: Sentence[] = [];
  let group: Word[] = [];
  const flush = () => {
    if (!group.length) return;
    const text = group.map((word) => word.text).join(" ").trim();
    sentences.push({
      id: `sentence-${sentences.length}`,
      start: group[0]!.start,
      end: group[group.length - 1]!.end,
      text,
      wordIds: group.map((word) => word.id),
      complete: SENTENCE_END.test(group[group.length - 1]!.text.trim()),
    });
    group = [];
  };
  for (const word of words) {
    const previous = group[group.length - 1];
    if (previous && (SENTENCE_END.test(previous.text.trim()) || word.start - previous.end >= SENTENCE_PAUSE_SECONDS)) flush();
    group.push(word);
  }
  flush();
  return sentences;
}

function hasSceneCut(cuts: number[], start: number, end: number): boolean {
  return cuts.some((cut) => cut > start && cut < end);
}

function energyOf(audioRms: AudioRmsFeatures | undefined, start: number, end: number): number {
  if (!audioRms) return 0;
  try { return Math.max(0, Math.min(1, audioRms.query(start, end))); }
  catch { return 0; }
}

/** Grow a seed sentence into a self-contained unit, stopping at soft pauses and hard scene cuts. */
export function buildSemanticUnits(
  transcript: Transcript,
  audioRms?: AudioRmsFeatures,
  options: SemanticUnitOptions = {},
): SemanticUnit[] {
  // A 90-second recording cannot yield several 45–150s units; scale the
  // defaults down for short sources while keeping the documented range for
  // long recordings. Explicit caller bounds always win.
  const adaptive = options.minDuration === undefined && options.maxDuration === undefined;
  const minDuration = adaptive
    ? Math.max(1, Math.min(45, transcript.duration / 4))
    : Math.max(1, options.minDuration ?? 45);
  const maxDuration = adaptive
    ? Math.max(minDuration, Math.min(150, transcript.duration / 2))
    : Math.max(minDuration, options.maxDuration ?? 150);
  const pauseSeconds = Math.max(0.1, options.pauseSeconds ?? 0.8);
  const cuts = (options.sceneCuts ?? []).filter((cut) => Number.isFinite(cut));
  const limit = Math.max(1, options.limit ?? 15);
  const sentences = buildSentences(transcript);
  if (!sentences.length) return [];

  // A transcript shorter than the target is one unit; keep only the spoken span,
  // not the trailing silence in the container duration.
  if (transcript.duration <= minDuration) {
    return [toUnit(0, sentences.length - 1, sentences, transcript, audioRms, "unit-0")];
  }

  const seeds = sentences.flatMap((sentence, index) => {
    if (NON_SPEECH.test(sentence.text)) return [];
    const previous = sentences[index - 1];
    const startsThought = !previous || sentence.start - previous.end >= pauseSeconds;
    return [{ index, score: (HOOK_CUE.test(sentence.text) ? 10 : 0) + (startsThought ? 4 : 0) }];
  });
  // Energy prefers a peak when hook cues tie; no RMS means text alone decides.
  const scored = seeds.map((seed) => ({
    ...seed,
    score: seed.score + energyOf(audioRms, sentences[seed.index]!.start, sentences[seed.index]!.end) * 5,
  })).sort((a, b) => b.score - a.score || sentences[a.index]!.start - sentences[b.index]!.start);

  const units: SemanticUnit[] = [];
  const covered = new Set<number>();
  for (const seed of scored) {
    if (units.length >= limit) break;
    if (covered.has(seed.index)) continue;
    let first = seed.index;
    let last = seed.index;
    let contextSteps = 0;
    while (first > 0 && contextSteps < 3) {
      const previous = sentences[first - 1]!;
      const current = sentences[first]!;
      if (hasSceneCut(cuts, previous.end, current.start)) break;
      const naturalPause = current.start - previous.end >= pauseSeconds;
      const dangling = DANGLING_START.test(current.text);
      if (naturalPause && !dangling) break;
      const overMax = sentences[last]!.end - previous.start > maxDuration;
      if (overMax && !dangling && contextSteps > 0) break;
      contextSteps += 1;
      first -= 1;
    }

    while (last < sentences.length - 1) {
      const current = sentences[last]!;
      const next = sentences[last + 1]!;
      const cut = hasSceneCut(cuts, current.end, next.start);
      if (cut) break; // A scene cut is a hard boundary even for a short unit.
      const naturalPause = next.start - current.end >= pauseSeconds;
      const duration = current.end - sentences[first]!.start;
      if (naturalPause && duration >= minDuration) break;
      if (next.end - sentences[first]!.start > maxDuration) break;
      last += 1;
    }
    // Do not end on an unfinished thought when the next sentence fits.
    if (!sentences[last]!.complete && last < sentences.length - 1) {
      const next = sentences[last + 1]!;
      if (!hasSceneCut(cuts, sentences[last]!.end, next.start) && next.end - sentences[first]!.start <= maxDuration) last += 1;
    }

    const span = sentences.slice(first, last + 1);
    if (span.every((sentence) => NON_SPEECH.test(sentence.text))) continue;
    for (let index = first; index <= last; index += 1) covered.add(index);
    units.push(toUnit(first, last, sentences, transcript, audioRms, `unit-${units.length}`));
  }
  return units;
}

function toUnit(
  first: number,
  last: number,
  sentences: Sentence[],
  transcript: Transcript,
  audioRms: AudioRmsFeatures | undefined,
  id: string,
): SemanticUnit {
  const span = sentences.slice(first, last + 1);
  const start = span[0]!.start;
  const end = span[span.length - 1]!.end;
  const text = span.map((sentence) => sentence.text).join(" ");
  const wordIds = span.flatMap((sentence) => sentence.wordIds);
  const hookCue = HOOK_CUE.test(text);
  const complete = span[span.length - 1]!.complete;
  const pauseBoundary = first > 0 && start - sentences[first - 1]!.end >= 0.3;
  const baseScore = Math.min(100, Math.round(wordIds.length * 1.5 + (hookCue ? 20 : 0) + (complete ? 10 : 0) + (pauseBoundary ? 5 : 0)));
  const score = scoreAggregateHighlight({ start, end, text, transcript, hookCue, complete, pauseBoundary, audioRms, baseScore });
  const scores = scoreHighlightComponents({ start, end, text, transcript, hookCue, complete, pauseBoundary, audioRms });
  const highlight: Highlight = {
    version: 1,
    id,
    sourceArtifactId: transcript.sourceArtifactId,
    start,
    end,
    wordIds,
    title: text.slice(0, 80),
    hook: hookCue ? text.slice(0, 100) : undefined,
    score,
    ...componentScoreMetadata(scores, undefined, audioRms !== undefined),
    reason: "semantic unit with sentence-aligned boundaries",
  };
  const arc = assessNarrativeArc(text);
  return { id, start, end, text, wordIds, sentenceIds: span.map((sentence) => sentence.id), score, arc, highlight };
}
