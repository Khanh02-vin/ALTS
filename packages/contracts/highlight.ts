import { assertRange, CONTRACT_VERSION, type Timestamp } from "./transcript.ts";

export type HighlightAxis = "hook" | "summary" | "impact";
export type HighlightScores = Record<HighlightAxis, number>;
export type HighlightStatus = "active" | "saved" | "discarded";

export function isActiveHighlight(highlight: Pick<Highlight, "status">): boolean {
  return highlight.status !== "discarded";
}

export function activeHighlights<T extends Pick<Highlight, "id" | "status">>(highlights: T[]): T[] {
  return highlights.filter(isActiveHighlight);
}

export function activeHighlightIds(highlights: Highlight[]): Set<string> {
  return new Set(activeHighlights(highlights).map((highlight) => highlight.id));
}

export type HighlightRange = { start: Timestamp; end: Timestamp; wordIds: string[]; role?: "setup" | "core" | "payoff" };

export type Highlight = {
  version: typeof CONTRACT_VERSION;
  id: string;
  sourceArtifactId: string;
  /** Union span of ranges; for a legacy single-range highlight this is that range. */
  start: Timestamp;
  end: Timestamp;
  wordIds: string[];
  /** Optional for backward compatibility; when present, start/end/wordIds are their union. */
  ranges?: HighlightRange[];
  title: string;
  hook?: string;
  score: number;
  /** Optional only for compatibility with highlights persisted before axis scoring. */
  scores?: HighlightScores;
  /** Optional only for compatibility with highlights persisted before axis scoring. */
  dominantAxis?: HighlightAxis;
  /** False when hook/impact were scored from text alone; absent on highlights persisted before this flag. */
  scoreAudio?: boolean;
  reason?: string;
  /** Optional link to a transcript outline entry. */
  outlineId?: string;
  /** Reversible user state; omitted means the highlight is active. */
  status?: HighlightStatus;};

export function dominantHighlightAxis(scores: HighlightScores): HighlightAxis | undefined {
  const axis = (["hook", "summary", "impact"] as const).reduce(
    (best, candidate) => scores[candidate] > scores[best] ? candidate : best,
    "hook",
  );
  return scores[axis] >= 70 ? axis : undefined;
}

export function validateHighlights(highlights: Highlight[], duration: number): void {
  const ordered = [...highlights].sort((a, b) => a.start - b.start);
  let previousEnd = 0;
  for (const highlight of ordered) {
    if (highlight.version !== CONTRACT_VERSION || !highlight.id || !highlight.sourceArtifactId) {
      throw new Error("Invalid highlight metadata");
    }
    assertRange(highlight.start, highlight.end, duration);
    if (highlight.ranges?.length) {
      let previousRangeEnd = -1;
      let unionStart = Infinity;
      let unionEnd = -Infinity;
      const unionWordIds: string[] = [];
      for (const range of highlight.ranges) {
        assertRange(range.start, range.end, duration, "range");
        if (range.start < previousRangeEnd) throw new Error("Highlight ranges are not in chronological order");
        previousRangeEnd = range.end;
        unionStart = Math.min(unionStart, range.start);
        unionEnd = Math.max(unionEnd, range.end);
        unionWordIds.push(...range.wordIds);
      }
      assertRange(unionStart, unionEnd, duration, "union");
      if (highlight.start !== unionStart || highlight.end !== unionEnd) throw new Error("Highlight union does not match ranges");
      if (new Set(highlight.wordIds).size !== new Set(unionWordIds).size || highlight.wordIds.some((id) => !unionWordIds.includes(id))) throw new Error("Highlight wordIds do not match range union");
    }
    if (!Number.isFinite(highlight.score) || highlight.score < 0 || highlight.score > 100) {
      throw new Error("Invalid highlight score");
    }
    if (highlight.scores !== undefined) {
      for (const axis of ["hook", "summary", "impact"] as const) {
        const value = highlight.scores[axis];
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          throw new Error(`Invalid highlight ${axis} score`);
        }
      }
      if (highlight.dominantAxis !== dominantHighlightAxis(highlight.scores)) {
        throw new Error("Invalid highlight axis");
      }
    } else if (highlight.dominantAxis !== undefined) {
      throw new Error("Invalid highlight axis without component scores");
    }
    if (highlight.scoreAudio !== undefined && typeof highlight.scoreAudio !== "boolean") {
      throw new Error("Invalid highlight audio provenance");
    }
    if (highlight.status !== undefined && highlight.status !== "active" && highlight.status !== "saved" && highlight.status !== "discarded") {
      throw new Error("Invalid highlight status");
    }
    if (highlight.start < previousEnd) throw new Error("Highlights overlap");
    previousEnd = highlight.end;
  }
}
