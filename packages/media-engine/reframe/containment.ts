export type SpanBox = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type ContainmentAnchor = "person" | "text" | "union";

export type ContainmentResolution = {
  anchorType: ContainmentAnchor;
  centerX: number;
  centerY: number;
  frameWidth: number;
  needsZoomOut: boolean;
};

export const MIN_PORTRAIT_WIDTH = 0.316;
export const CONTAINMENT_PADDING = 0.04;

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function normalizeSpanBox(box: SpanBox): SpanBox {
  const left = Math.max(0, Math.min(1, finite(box.left, 0)));
  const right = Math.max(left, Math.min(1, finite(box.right, left)));
  const top = Math.max(0, Math.min(1, finite(box.top, 0)));
  const bottom = Math.max(top, Math.min(1, finite(box.bottom, top)));
  return { left, right, top, bottom };
}

export function contains(outer: SpanBox, inner: SpanBox): boolean {
  return outer.left <= inner.left && outer.right >= inner.right
    && outer.top <= inner.top && outer.bottom >= inner.bottom;
}

export function resolveFrameByContainment(person: SpanBox, text?: SpanBox | null): ContainmentResolution {
  const normalizedPerson = normalizeSpanBox(person);
  const normalizedText = text ? normalizeSpanBox(text) : null;
  // The person is the anchor. Text (OCR of burned-in titles, corner tags, subtitles) is
  // secondary composition information: it widens the frame only when it genuinely
  // contains the subject — a wide title the presenter stands in front of. A tag beside
  // the person never widens it, so the subject keeps the middle of the plate.
  let dominant = normalizedPerson;
  let anchorType: ContainmentAnchor = "person";

  if (normalizedText && contains(normalizedText, normalizedPerson)) {
    dominant = normalizedText;
    anchorType = "text";
  }

  const frameWidth = Math.min(1, Math.max(
    MIN_PORTRAIT_WIDTH,
    dominant.right - dominant.left + CONTAINMENT_PADDING,
  ));
  return {
    anchorType,
    centerX: (dominant.left + dominant.right) / 2,
    centerY: (dominant.top + dominant.bottom) / 2,
    frameWidth,
    needsZoomOut: frameWidth > MIN_PORTRAIT_WIDTH,
  };
}
