import type { HighlightRange } from "../contracts/highlight.ts";
import type { Transcript } from "../contracts/transcript.ts";
import type { Caption, RenderRange } from "../contracts/render-plan.ts";

export type SentenceRangeRequest = { startSentenceId: string; endSentenceId: string };
export type ExposedSentence = { id: string; start: number; end: number; text: string; wordIds: string[] };

export function unionHighlightRanges(ranges: Array<{ start: number; end: number; wordIds: string[] }>): { start: number; end: number; wordIds: string[] } {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const first = sorted[0];
  if (!first) return { start: 0, end: 0, wordIds: [] };
  const last = sorted[sorted.length - 1]!;
  return { start: first.start, end: last.end, wordIds: [...new Set(sorted.flatMap((range) => range.wordIds))] };
}

export function remapCaptionTimes(captions: Caption[], ranges: RenderRange[]): Caption[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const removedBefore = sorted.map((_, index) => sorted.slice(1, index + 1).reduce((sum, range, cutIndex) => sum + range.start - sorted[cutIndex]!.end, 0));
  const output: Caption[] = [];
  for (const caption of captions) {
    const index = sorted.findIndex((range) => caption.start >= range.start && caption.end <= range.end);
    if (index < 0) continue;
    const shift = removedBefore[index]!;
    const words = caption.words?.map((word) => ({ ...word, start: word.start - shift, end: word.end - shift }));
    output.push({ ...caption, start: caption.start - shift, end: caption.end - shift, ...(words ? { words } : {}) });
  }
  return output.sort((a, b) => a.start - b.start);
}

/**
 * Turn LLM sentence IDs into local ranges. The model never supplies seconds:
 * every timestamp and word ID comes from the transcript's sentence list.
 */
export function buildValidatedRanges(
  requests: SentenceRangeRequest[] | undefined,
  exposed: ExposedSentence[] | undefined,
  transcript: Transcript,
  fallback: { start: number; end: number; wordIds: string[] },
  options: { minTotal?: number; maxTotal?: number; mergeGap?: number } = {},
): HighlightRange[] | undefined {
  if (!requests?.length || !exposed?.length || requests.length > 3) return undefined;
  const sentences = new Map(exposed.map((sentence) => [sentence.id, sentence]));
  const wordById = new Map(transcript.words.map((word) => [word.id, word]));
  const candidateRanges: HighlightRange[] = [];

  for (const request of requests.slice(0, 3)) {
    const from = sentences.get(request.startSentenceId);
    const to = sentences.get(request.endSentenceId);
    if (!from || !to || from.start > to.start) return undefined;
    const span = exposed.filter((sentence) => sentence.start >= from.start && sentence.end <= to.end);
    if (!span.length) return undefined;
    const wordIds = span.flatMap((sentence) => sentence.wordIds ?? wordById.filter((word) => word.start >= sentence.start && word.end <= sentence.end).map((word) => word.id));
    candidateRanges.push({ start: from.start, end: to.end, wordIds });
  }
  candidateRanges.sort((a, b) => a.start - b.start);
  if (candidateRanges.some((range, index) => index > 0 && range.start < candidateRanges[index - 1]!.end)) return undefined;

  // Merge ranges closer than the gap threshold so a jump never cuts a word.
  const mergeGap = options.mergeGap ?? 1.5;
  const merged: HighlightRange[] = [];
  for (const range of candidateRanges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start - previous.end < mergeGap) {
      previous.end = range.end;
      previous.wordIds = [...new Set([...previous.wordIds, ...range.wordIds])];
    } else merged.push({ ...range });
  }
  if (merged.length < 2 || merged.length > 3) return undefined;
  const union = unionHighlightRanges(merged);
  const spoken = merged.reduce((sum, range) => sum + range.end - range.start, 0);
  if (spoken < (options.minTotal ?? 30) || spoken > (options.maxTotal ?? 120)) return undefined;
  if (union.start !== fallback.start && union.end !== fallback.end) {
    // A jump that leaves the original span is only safe when it stays in the source.
    if (union.start < 0 || union.end > transcript.duration) return undefined;
  }
  return merged.map((range, index) => ({ ...range, role: index === 0 ? "setup" : index === merged.length - 1 ? "payoff" : "core" }));
}

export function highlightRangesToRenderRanges(ranges?: HighlightRange[]): RenderRange[] {
  if (!ranges?.length) return [];
  return [...ranges].sort((a, b) => a.start - b.start).map(({ start, end }) => ({ start, end }));
}
