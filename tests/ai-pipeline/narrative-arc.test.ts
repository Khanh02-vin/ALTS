import assert from "node:assert/strict";
import { assessNarrativeArc } from "../../services/ai-pipeline/narrative-arc.ts";

// A complete arc: concrete setup, a rule at the core, and a concluded payoff.
{
  const arc = assessNarrativeArc(
    "We rewrote working code last spring and lost two weeks. The biggest mistake is changing code without a refactoring reason. So finish what you started before moving on.",
  );
  assert.equal(arc.hasClearSubject, true);
  assert.equal(arc.hasSetup, true);
  assert.equal(arc.hasCore, true);
  assert.equal(arc.hasPayoff, true);
  assert.equal(arc.complete, true);
  assert.deepEqual(arc.missing, []);
}

// A unit that ends mid-thought: the exact failure the live model reported.
{
  const arc = assessNarrativeArc(
    "We rewrote working code last spring and lost two weeks. The biggest mistake is changing code without a refactoring reason, and because",
  );
  assert.equal(arc.hasPayoff, false, "an unfinished final sentence has no payoff");
  assert.equal(arc.complete, false);
  assert.ok(arc.missing.includes("payoff"));
}

// A dangling opener has no subject even when the rest looks complete.
{
  const arc = assessNarrativeArc("So we should finish our work. This is the key lesson for every developer. That is why it matters.");
  assert.equal(arc.hasClearSubject, false);
  assert.equal(arc.complete, false);
  assert.ok(arc.missing.includes("subject"));
}

// A unit made only of transcription noise must never count as a narrative.
{
  const music = assessNarrativeArc("(upbeat music) (upbeat music) (upbeat music)");
  assert.equal(music.complete, false);
  assert.ok(music.missing.includes("subject"));
}

// A sentence with terminal punctuation can still be truncated mid-thought:
// a final dangling connector or incomplete clause is not a payoff.
{
  const truncated = assessNarrativeArc("We had a problem with rewriting code. The mistake was clear. And because");
  assert.equal(truncated.hasPayoff, false, "a final connector is not a conclusion, punctuation or not");
  const clause = assessNarrativeArc("We had a problem with rewriting code. The mistake was clear. the team had to.");
  assert.equal(clause.hasPayoff, false, "a clause that ends on an auxiliary is not a payoff");
}

console.log("narrative arc: ok");
