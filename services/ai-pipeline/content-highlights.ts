import type { Highlight } from "../../packages/contracts/highlight.ts";
import type { Transcript, TranscriptSegment } from "../../packages/contracts/transcript.ts";
import { componentScoreMetadata, scoreAggregateHighlight, scoreHighlightComponents, type AudioRmsFeatures } from "./highlight-scoring.ts";

const HOOK = /\b(how|why|problem|mistake|secret|important|key|solution|example|first|never|best)\b/i;
const VALUE = /\b(problem|solution|step|example|result|learn|fix|use|because|therefore)\b/i;
const OPEN = /^(and|but|so|because|then|this|it)\b/i;
const WEAK_END = /\b(and|but|because|if|to|is|are)$/i;
export type CandidateQuality = { completeness: number; coherence: number; hook: number; value: number; ending: number; abruptCutPenalty: number; confidence: number };

export type ContentWindow = {
  start: number;
  end: number;
  wordIds: string[];
  text: string;
  score: number;
  quality: CandidateQuality;
};

function scoreContentWindow(segments: TranscriptSegment[], transcript: Transcript, audioRms?: AudioRmsFeatures, allowShortHook = false): ContentWindow | undefined {
  const firstSegment = segments[0];
  const lastSegment = segments.at(-1);
  if (!firstSegment || !lastSegment) return undefined;
  const duration = lastSegment.end - firstSegment.start;
  const text = segments.map((segment) => segment.text).join(" ").trim();
  const shortHookException = allowShortHook && duration >= 8 && duration < 15 && segments.length === 1 && HOOK.test(text) && /[.!?]$/.test(text);
  if (duration < (shortHookException ? 8 : 15) || duration > 60) return undefined;
  const quality = score(segments, text);
  if (quality.completeness < 45 || quality.abruptCutPenalty > 55) return undefined;
  const hookCue = HOOK.test(text);
  const baseScore = Math.max(0, Math.min(100, Math.round(quality.completeness * .25 + quality.coherence * .2 + quality.hook * .2 + quality.value * .2 + quality.ending * .15 - quality.abruptCutPenalty * .25)));
  const pauseBoundary = segments.slice(1).some((segment, index) => segment.start - segments[index]!.end >= 0.7);
  const aggregateScore = scoreAggregateHighlight({ start: firstSegment.start, end: lastSegment.end, text, transcript, hookCue, complete: quality.ending >= 70, pauseBoundary, audioRms, baseScore });
  return { start: firstSegment.start, end: lastSegment.end, wordIds: segments.flatMap((segment) => segment.wordIds), text, score: aggregateScore, quality };
}

/** Build every eligible content window once so legacy/current scorers can rank identical candidates. */
export function buildContentWindows(transcript: Transcript, audioRms?: AudioRmsFeatures): ContentWindow[] {
  const segments = transcript.segments.filter((segment) => segment.end > segment.start && segment.text.trim());
  const candidates: ContentWindow[] = [];
  for (let i = 0; i < segments.length; i++) {
    for (let j = i; j < segments.length && segments[j]!.end - segments[i]!.start <= 60; j++) {
      const candidate = scoreContentWindow(segments.slice(i, j + 1), transcript, audioRms, true);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

export function chooseContentHighlights(transcript: Transcript, limit = 5, audioRms?: AudioRmsFeatures): Highlight[] {
  const segments = transcript.segments.filter((segment) => segment.end > segment.start && segment.text.trim());
  const candidates: Highlight[] = [];
  for (let i = 0; i < segments.length; i++) {
    for (let j = i; j < segments.length && segments[j]!.end - segments[i]!.start <= 60; j++) {
      const window = segments.slice(i, j + 1);
      const candidate = scoreContentWindow(window, transcript, audioRms, true);
      if (!candidate) continue;
      candidates.push({
        version: 1,
        id: `content-${i}-${j}`,
        sourceArtifactId: transcript.sourceArtifactId,
        start: candidate.start,
        end: candidate.end,
        wordIds: candidate.wordIds,
        title: candidate.text.slice(0, 80),
        hook: HOOK.test(candidate.text) ? candidate.text.slice(0, 100) : undefined,
        score: candidate.score,
        ...componentScoreMetadata(scoreHighlightComponents({
          start: candidate.start,
          end: candidate.end,
          text: candidate.text,
          transcript,
          hookCue: HOOK.test(candidate.text),
          complete: candidate.quality.ending >= 70,
          pauseBoundary: window.slice(1).some((segment, index) => segment.start - window[index]!.end >= 0.7),
          audioRms,
        }), undefined, audioRms !== undefined),
        reason: "content window with hook, context, value and complete ending",
        quality: candidate.quality,
      });
    }
  }
  const ranked = candidates.sort((a, b) => b.score - a.score || a.start - b.start);
  const chosen: Highlight[] = [];
  for (const candidate of ranked) {
    if (chosen.some((other) => candidate.start < other.end && other.start < candidate.end)) continue;
    chosen.push(candidate);
    if (chosen.length >= limit) break;
  }
  return chosen.sort((a, b) => a.start - b.start);
}

function score(segments: TranscriptSegment[], text: string): CandidateQuality {
  const first = segments[0]!.text.trim();
  const last = segments.at(-1)!.text.trim();
  const tokens = segments.map((segment) => new Set(segment.text.toLowerCase().split(/\W+/).filter((token) => token.length > 3)));
  const shared = tokens.length < 2 ? 50 : Math.round((tokens.slice(1).reduce((sum, set) => sum + [...set].filter((token) => tokens[0]!.has(token)).length, 0) / Math.max(1, tokens.length - 1)) * 20);
  const completeness = Math.min(100, 45 + Math.min(30, segments.length * 10) + (OPEN.test(first) ? -30 : 15) + (WEAK_END.test(last) ? -30 : 15));
  const ending = /[.!?]$/.test(last) ? 90 : 25;
  const hook = HOOK.test(text) ? 90 : 35;
  const value = VALUE.test(text) ? 80 : 35;
  const abruptCutPenalty = (OPEN.test(first) ? 35 : 0) + (WEAK_END.test(last) ? 35 : 0);
  return { completeness: Math.max(0, completeness), coherence: Math.min(100, 50 + shared), hook, value, ending, abruptCutPenalty, confidence: Math.max(0, Math.min(100, completeness - abruptCutPenalty / 2)) };
}
