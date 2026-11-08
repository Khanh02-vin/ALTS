import type { Highlight, HighlightAxis } from "../../packages/contracts/highlight.ts";
import type { Transcript } from "../../packages/contracts/transcript.ts";
import type { EditVariant } from "../../packages/contracts/render-plan.ts";
import { mapEditVariantProposals } from "./variants.ts";

export type ScriptOutlineItem = { id: string; start: number; end: number; text: string };

export function buildScriptOutline(transcript: Transcript): ScriptOutlineItem[] {
  const words = transcript.words;
  if (!words.length) return [];
  const sentences: Array<{ first: number; last: number }> = [];
  let first = 0;
  for (let i = 0; i < words.length; i++) {
    if (/[.!?]["')\]]*$/.test(words[i]!.text)) {
      sentences.push({ first, last: i });
      first = i + 1;
    }
  }
  if (first < words.length) sentences.push({ first, last: words.length - 1 });
  const groups: Array<{ first: number; last: number }> = [];
  for (const sentence of sentences) {
    const last = groups.at(-1);
    if (last && sentence.last - last.first + 1 <= 48 && words[sentence.last]!.end - words[last.first]!.start <= 20) last.last = sentence.last;
    else groups.push({ ...sentence });
  }
  return groups.map(({ first: from, last: to }, index) => {
    const selected = words.slice(from, to + 1);
    return { id: `outline-${index + 1}`, start: selected[0]!.start, end: selected.at(-1)!.end, text: selected.map(word => word.text).join(" ").slice(0, 600) };
  });
}

export function associateHighlightsWithOutline<T extends Highlight>(highlights: T[], outline: ScriptOutlineItem[]): Array<T & { outlineId?: string }> {
  return highlights.map(highlight => {
    const best = outline.map(item => ({ item, overlap: Math.max(0, Math.min(item.end, highlight.end) - Math.max(item.start, highlight.start)) }))
      .sort((a, b) => b.overlap - a.overlap || a.item.start - b.item.start)[0];
    return { ...highlight, ...(best && best.overlap > 0 ? { outlineId: best.item.id } : {}) };
  });
}

export type SummaryVariant = EditVariant & { axis: HighlightAxis; scores: Record<HighlightAxis, number>; dominantAxis: HighlightAxis };

export function buildSummaryVariants(transcript: Transcript): SummaryVariant[] {
  const length = transcript.words.length;
  if (length < 12) return [];
  const variants = [];
  for (let candidate = 0; candidate < 2; candidate++) {
    const count = candidate === 0 ? 4 : 3;
    const width = Math.floor(length / count);
    const shift = candidate === 0 ? 0 : Math.floor(width / 3);
    const ranges = Array.from({ length: count }, (_, index) => {
      const start = Math.min(length - 1, index * width + shift);
      const end = index === count - 1 ? length - 1 : Math.min(length - 1, (index + 1) * width - 1 + shift);
      return { from: start, to: end };
    }).filter(range => range.to >= range.from);
    const mapped = mapEditVariantProposals(transcript, { variants: [{ title: `Summary ${candidate + 1}`, reason: "Coverage across the full transcript", ranges }] });
    if (mapped[0]?.ranges.length >= 3 && mapped[0].ranges.length <= 4) {
      const summaryScore = Math.max(25, Math.min(100, Math.round(50 + mapped[0].ranges.length * 10 + length / 20)));
      const score = summaryAxisScore(summaryScore);
      variants.push({ ...mapped[0]!, axis: "summary", ...score });
    }
  }
  return variants;
}

export function summaryAxisScore(score: number): { scores: Record<HighlightAxis, number>; dominantAxis: HighlightAxis } {
  const bounded = Math.max(0, Math.min(100, Math.round(score)));
  return { scores: { hook: 25, summary: bounded, impact: 25 }, dominantAxis: "summary" };
}
