// Local, transcript-derived check for whether a candidate carries a whole arc.
// The LLM is asked to confirm this, but never trusted as the only source: it
// reported "cuts off mid-thought" on a real clip whose final sentence was
// genuinely unfinished, which this module detects without any network call.

const DANGLING_START = /^(so|because|and|but|then|this|that|it|they|which|also|however|therefore|which is why|as i said|like i said|for that|vì vậy|do đó|vì thế|điều này|cái đó|như vừa nói|nên|rồi)\b/i;
const NON_SPEECH = /^[(\[]|\b(upbeat music|music|applause|laughter|silence|subtitles)\b/i;
const SENTENCE_END = /[.!?]["')\]]?$/;
const SETUP_CUE = /(\?|\b(imagine|for example|last week|the problem|when we|when i|we had|i was|picture this|here is what)\b)/i;
const CORE_CUE = /\b(mistake|key|solution|rule|never|always|should|must|because|the point|turns out|lesson|reason|the trick)\b/i;

const INCOMPLETE_END = /\b(and|but|because|or|so|to|is|are|was|were|the|a|an|that|which|with|of|for|in|on|at)\s*[.!?]?$/i;

export type NarrativeArc = {
  hasClearSubject: boolean;
  hasSetup: boolean;
  hasCore: boolean;
  hasPayoff: boolean;
  complete: boolean;
  missing: Array<"subject" | "setup" | "core" | "payoff">;
};

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}

/** Derive the 3-part narrative state from transcript text alone. */
export function assessNarrativeArc(text: string): NarrativeArc {
  const sentences = splitSentences(text.trim());
  const first = sentences[0] ?? "";
  const last = sentences.at(-1) ?? "";
  const firstTokens = first.split(/\s+/).filter(Boolean).length;
  const lastTokens = last.split(/\s+/).filter(Boolean).length;

  const hasClearSubject = Boolean(first) && !NON_SPEECH.test(first) && !DANGLING_START.test(first) && firstTokens >= 3;
  const hasSetup = hasClearSubject && sentences.length >= 2 && (SETUP_CUE.test(first) || sentences.length >= 3);
  const hasCore = CORE_CUE.test(text);
  const hasPayoff = Boolean(last)
    && !NON_SPEECH.test(last)
    && SENTENCE_END.test(last)
    && !(lastTokens <= 5 && INCOMPLETE_END.test(last))
    && lastTokens >= 4;

  const missing: NarrativeArc["missing"] = [];
  if (!hasClearSubject) missing.push("subject");
  if (!hasSetup) missing.push("setup");
  if (!hasCore) missing.push("core");
  if (!hasPayoff) missing.push("payoff");
  return { hasClearSubject, hasSetup, hasCore, hasPayoff, complete: missing.length === 0, missing };
}
