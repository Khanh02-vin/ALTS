import type { Highlight } from "../../packages/contracts/highlight.ts";
import type { Transcript } from "../../packages/contracts/transcript.ts";

const MAX_SNAP_SECONDS = 0.5;

/** Move highlight edges to a nearby visual cut; never stretch across another clip. */
export function snapHighlightsToScenes(highlights: Highlight[], transcript: Transcript, sceneCuts: number[]): Highlight[] {
  if (!sceneCuts.length) return highlights;
  const cuts = [...new Set(sceneCuts.filter((cut) => Number.isFinite(cut) && cut > 0 && cut < transcript.duration))].sort((a, b) => a - b);
  if (!cuts.length) return highlights;
  return highlights.map((highlight, index) => {
    const previous = highlights[index - 1];
    const next = highlights[index + 1];
    const nearest = (target: number) => cuts
      .filter((cut) => Math.abs(cut - target) <= MAX_SNAP_SECONDS)
      .sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b)[0];
    const start = nearest(highlight.start) ?? highlight.start;
    const end = nearest(highlight.end) ?? highlight.end;
    const validStart = start >= (previous?.end ?? 0) && start < highlight.end - 4 ? start : highlight.start;
    const validEnd = end <= (next?.start ?? transcript.duration) && end > highlight.start + 4 ? end : highlight.end;
    const startTime = validStart >= validEnd - 4 ? highlight.start : validStart;
    const endTime = validEnd <= startTime + 4 ? highlight.end : validEnd;
    const duration = endTime - startTime;
    if (duration < 4 || duration > 90 || startTime >= endTime) return highlight;
    if (startTime === highlight.start && endTime === highlight.end) return highlight;
    const wordIds = transcript.words.length
      ? transcript.words.filter((word) => word.start >= startTime && word.end <= endTime).map((word) => word.id)
      : transcript.segments.filter((segment) => segment.start >= startTime && segment.end <= endTime).flatMap((segment) => segment.wordIds);
    return { ...highlight, start: startTime, end: endTime, wordIds };
  });
}
