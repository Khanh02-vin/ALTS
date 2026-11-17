// Shared text-boundary rules.
//
// These were duplicated in heuristic.ts, semantic-units.ts and narrative-arc.ts.
// Three copies meant a fix to sentence detection (e.g. adding Vietnamese "…" or
// CJK terminators) could land in one feature and not the others, which silently
// changes segmentation between them. One definition keeps them in step.

/** True when the word/segment text ends a sentence. */
export const SENTENCE_END = /[.!?]["')\]]?$/;

/** A gap at least this long counts as a natural cut point. */
export const PAUSE_SECONDS = 0.7;
