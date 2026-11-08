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

export type Highlight = {
  version: typeof CONTRACT_VERSION;
  id: string;
  sourceArtifactId: string;
  start: Timestamp;
  end: Timestamp;
  wordIds: string[];
  title: string;
  hook?: string;
  score: number;
  /** Optional only for compatibility with highlights persisted before axis scoring. */
  scores?: HighlightScores;
  /** Optional only for compatibility with highlights persisted before axis scoring. */
  dominantAxis?: HighlightAxis;
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
    if (highlight.status !== undefined && highlight.status !== "active" && highlight.status !== "saved" && highlight.status !== "discarded") {
      throw new Error("Invalid highlight status");
    }
    if (highlight.start < previousEnd) throw new Error("Highlights overlap");
    previousEnd = highlight.end;
  }
}
