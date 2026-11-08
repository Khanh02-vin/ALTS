import type { Highlight } from "../../packages/contracts/highlight.ts";
import type { Transcript } from "../../packages/contracts/transcript.ts";

const MIN_PAUSE_SECONDS = 0.3;
const MAX_SNAP_SECONDS = 0.5;

type TimedText = { start: number; end: number; id: string };

export function snapHighlightsToPauses(highlights: Highlight[], transcript: Transcript): Highlight[] {
  const timed: TimedText[] = transcript.words.length
    ? transcript.words.map((word) => ({ start: word.start, end: word.end, id: word.id }))
    : transcript.segments.map((segment) => ({ start: segment.start, end: segment.end, id: segment.id }));
  if (!timed.length) return highlights;

  const gaps = timed.slice(1).flatMap((item, i) => {
    const before = timed[i];
    return item.start - before.end >= MIN_PAUSE_SECONDS ? [{ before, after: item }] : [];
  });
  const sentenceStarts = transcript.words.length
    ? [transcript.words[0]!.start, ...transcript.words.flatMap((word, index) => /[.!?]["')\]]*$/.test(word.text) && transcript.words[index + 1]
      ? [transcript.words[index + 1]!.start]
      : [])]
    : [transcript.segments[0]!.start, ...transcript.segments.flatMap((segment, index) => /[.!?]["')\]]*$/.test(segment.text.trim()) && transcript.segments[index + 1]
      ? [transcript.segments[index + 1]!.start]
      : [])];
  const sentenceEnds = transcript.words.length
    ? [...transcript.words.flatMap((word, index) => /[.!?]["')\]]*$/.test(word.text) && transcript.words[index + 1]
      ? [word.end]
      : []), transcript.words[transcript.words.length - 1]!.end]
    : [...transcript.segments.flatMap((segment, index) => /[.!?]["')\]]*$/.test(segment.text.trim()) && transcript.segments[index + 1]
      ? [segment.end]
      : []), transcript.segments[transcript.segments.length - 1]!.end];
  const sentenceEdges = sentenceStarts.map((start, index) => ({ start, end: sentenceEnds[index] ?? start }));

  const nearest = (values: number[], target: number) => values
    .filter((time) => Math.abs(time - target) <= MAX_SNAP_SECONDS)
    .sort((a, b) => Math.abs(a - target) - Math.abs(b - target));

  const snapped: Highlight[] = [];
  for (const [index, highlight] of highlights.entries()) {
    const previous = snapped[index - 1];
    const next = highlights[index + 1];
    const startCandidates = nearest(sentenceEdges.map(({ start }) => start), highlight.start);
    const endCandidates = nearest(sentenceEdges.map(({ end }) => end), highlight.end);
    const pauseStartCandidates = nearest(gaps.map(({ after }) => after.start), highlight.start);
    const pauseEndCandidates = nearest(gaps.map(({ before }) => before.end), highlight.end);

    // Prefer punctuation-defined complete-thought boundaries; use pause snaps
    // only when no nearby sentence edge exists.
    const possibleStarts = [startCandidates[0] ?? pauseStartCandidates[0], highlight.start]
      .filter((time): time is number => time !== undefined);
    const possibleEnds = [endCandidates[0] ?? pauseEndCandidates[0], highlight.end]
      .filter((time): time is number => time !== undefined);
    const validPairs = possibleStarts.flatMap((start) => possibleEnds.flatMap((end) => {
      if (start < 0 || end > transcript.duration || start >= end) return [];
      if (previous && start < previous.end) return [];
      if (next && end > next.start) return [];
      return [{ start, end }];
    }));
    const { start, end } = validPairs.sort((a, b) => {
      const movedA = Number(a.start !== highlight.start) + Number(a.end !== highlight.end);
      const movedB = Number(b.start !== highlight.start) + Number(b.end !== highlight.end);
      return movedB - movedA ||
        (Math.abs(a.start - highlight.start) + Math.abs(a.end - highlight.end)) -
        (Math.abs(b.start - highlight.start) + Math.abs(b.end - highlight.end));
    })[0] ?? highlight;
    if (start === highlight.start && end === highlight.end) {
      snapped.push(highlight);
      continue;
    }

    const wordIds = transcript.words.length
      ? transcript.words.filter((word) => word.start >= start && word.end <= end).map((word) => word.id)
      : transcript.segments.filter((segment) => segment.start >= start && segment.end <= end).flatMap((segment) => segment.wordIds);
    snapped.push({ ...highlight, start, end, wordIds });
  }
  return snapped;
}
