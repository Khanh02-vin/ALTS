import { isActiveHighlight, type Highlight } from "../../../../packages/contracts/highlight.ts";
import type { Transcript } from "../../../../packages/contracts/transcript.ts";
import type { RenderPlan, EditVariant } from "../../../../packages/contracts/render-plan.ts";

// Shared between the Studio workbench, the Editor and the YouTube Studio.
// Runes-based mutable module store (`$state` works in .svelte.ts).
export const studioState = $state<{
  sourcePath: string;
  sourceName: string;
  sourceDuration: number;
  highlights: Highlight[];
  transcript: Transcript | null;
  selectedId: string;
  selectedIds: string[];
  plan: RenderPlan | null;
  projectId: string;
  projectRevision: number;
  plans: Record<string, RenderPlan>;
  variants: EditVariant[];
  summaryVariants: EditVariant[];
  scriptOutline: Array<{ id: string; start: number; end: number; text: string }>;
  selectedVariantId: string;
  editingVariantId: string;
  speakerFaceMatches: Record<string, string>;
  speakerFaceConfirmed: boolean;
}>({
  sourcePath: "",
  sourceName: "",
  sourceDuration: 816,
  highlights: [],
  transcript: null,
  selectedId: "clip-1",
  selectedIds: ["clip-1"],
  plan: null,
  projectId: "",
  projectRevision: 1,
  plans: {
    "clip-1": {
      version: 1,
      sourceArtifactId: "real-source",
      ranges: [{ start: 25.24, end: 29.24 }],
      aspectRatio: "9:16",
      cropMode: "track",
      captions: [],
      outputProfile: { container: "mp4", codec: "h264" },
      speakerMap: { A: "face-1" },
      cropKeyframes: [
        { time: 25.24, centerX: 0.2, centerY: 0.5, speakerId: "A", sourceFaceId: "face-1", confidence: 0.9, confirmed: true, sourceArtifactId: "real-source" },
        { time: 29.24, centerX: 0.2, centerY: 0.5, speakerId: "A", sourceFaceId: "face-1", confidence: 0.9, confirmed: true, sourceArtifactId: "real-source" },
      ],
      compositionLayouts: [
        { start: 25.24, end: 29.24, confidence: 0.9, confirmed: true, sourceArtifactId: "real-source", personBox: { left: 0.3095, right: 0.4652, top: 0.1285, bottom: 0.4715 }, textBox: { left: 0.128, right: 0.82, top: 0.708, bottom: 0.822 } },
      ],
    },
  },
  variants: [],
  summaryVariants: [],
  scriptOutline: [],
  selectedVariantId: "",
  editingVariantId: "",
  speakerFaceMatches: { speakerA: "face-1" },
  speakerFaceConfirmed: true,
});

// Active highlights are the non-discarded subset; selection/render/export
// must derive from these so discarding removes a clip from the export set
// without deleting its data or plan.
export function activeHighlights(): Highlight[] {
  return studioState.highlights.filter(isActiveHighlight);
}

export function activeSelectedIds(): string[] {
  const active = new Set(activeHighlights().map((highlight) => highlight.id));
  return studioState.selectedIds.filter((id) => active.has(id));
}

export function activeSelectedId(): string {
  const active = new Set(activeHighlights().map((highlight) => highlight.id));
  if (active.has(studioState.selectedId)) return studioState.selectedId;
  return activeHighlights()[0]?.id ?? "";
}
