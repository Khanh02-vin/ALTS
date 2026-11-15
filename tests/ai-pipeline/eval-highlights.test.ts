import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Transcript } from "../../packages/contracts/transcript.ts";
import type { Highlight } from "../../packages/contracts/highlight.ts";
import { validateHighlights } from "../../packages/contracts/highlight.ts";
import { snapHighlightsToPauses } from "../../services/ai-pipeline/pause-snap.ts";
import { buildWindows, chooseHeuristicHighlights, nonMaximumSuppression, selectHeuristicWindows } from "../../services/ai-pipeline/heuristic.ts";
import { buildContentWindows, chooseContentHighlights } from "../../services/ai-pipeline/content-highlights.ts";
import { buildRerankCandidates, rerankCandidates } from "../../services/ai-pipeline/hybrid-highlights.ts";
import { scoreAggregateHighlight } from "../../services/ai-pipeline/highlight-scoring.ts";
import type { SemanticHighlightProvider } from "../../services/ai-pipeline/semantic.ts";
import { snapHighlightsToScenes } from "../../services/ai-pipeline/scene-snap.ts";
import { parseSceneCutMetadata } from "../../services/ai-pipeline/scene-cuts.ts";
import { generateSemanticHighlights, createMockSemanticProvider, SemanticProviderAdapter } from "../../services/ai-pipeline/semantic.ts";
import { GeminiHighlightProvider, LlamaCppHighlightProvider, OpenAIChatHighlightProvider, highlightPrompt, mapWordRangeProposals } from "../../services/ai-pipeline/providers.ts";

/**
 * Highlight-selection eval over curated fixtures (time-IoU + rank@k).
 *
 * Offline (CI): heuristic vs content vs two oracle semantic mocks. The exact
 * oracle validates the metric code (must score ~1.0); the jittered oracle
 * validates near-miss handling (IoU < 1 but hit@k = 1).
 *
 * Live rows (optional, auto-skipped when unavailable):
 *   GEMINI_API_KEY=...   → semantic-gemini row
 *   llama-server on LOCAL_LLM_BASE_URL (default 127.0.0.1:8080, probed via /health)
 *                        → semantic-local row (the bundled Qwen)
 *
 * That live comparison is the point of the harness: it answers whether the
 * bundled local model actually beats the heuristic on these transcripts.
 *
 * Run:  npm run test:eval-highlights
 */

type Expected = { start: number; end: number; title: string };
type Case = { id: string; note: string; segments: Array<{ start: number; end: number; text: string }>; expected: Expected[] };

const here = dirname(fileURLToPath(import.meta.url));
const dataset = JSON.parse(readFileSync(join(here, "fixtures", "highlight-eval.json"), "utf8")) as { iouThreshold: number; cases: Case[] };
const THRESHOLD = dataset.iouThreshold;
const LIMIT = 5;

// --- fixture → contract transcript ------------------------------------------
// Words are spread evenly inside each segment; deterministic, contract-valid.
function buildTranscript(item: Case): Transcript {
  const words: Transcript["words"] = [];
  const segments: Transcript["segments"] = [];
  let duration = 0;
  item.segments.forEach((segment, segIndex) => {
    const tokens = segment.text.trim().split(/\s+/).filter(Boolean);
    const step = (segment.end - segment.start) / tokens.length;
    const wordIds: string[] = [];
    tokens.forEach((token, wordIndex) => {
      const id = `w-${segIndex}-${wordIndex}`;
      words.push({ id, text: token, start: segment.start + wordIndex * step, end: segment.start + (wordIndex + 1) * step });
      wordIds.push(id);
    });
    segments.push({ id: `s-${segIndex}`, text: segment.text, start: segment.start, end: segment.end, wordIds });
    duration = Math.max(duration, segment.end);
  });
  const transcript: Transcript = { version: 1, sourceArtifactId: item.id, language: "en", duration, provider: "eval-fixture", words, segments };
  // Contract violations are fixture bugs — fail loudly.
  for (const word of transcript.words) { assert.ok(word.end > word.start, `${item.id}: bad word range`); }
  assert.ok(transcript.words.every((w, i) => i === 0 || w.start >= transcript.words[i - 1].end), `${item.id}: words not ordered`);
  return transcript;
}

// --- metrics ----------------------------------------------------------------
function timeIou(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const intersection = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const union = (a.end - a.start) + (b.end - b.start) - intersection;
  return union > 0 ? intersection / union : 0;
}

type CaseResult = { meanIou: number; hits: Record<number, boolean> };

type TargetRecall = { hits: number; total: number; recall: number };

function targetRecall(expected: Expected[], predictions: Array<{ start: number; end: number }>, k: number): TargetRecall {
  const ranked = predictions.slice(0, k);
  const hits = expected.filter((target) => ranked.some((prediction) => timeIou(target, prediction) >= THRESHOLD)).length;
  return { hits, total: expected.length, recall: expected.length ? hits / expected.length : 0 };
}

function targetMeanIou(expected: Expected[], predictions: Array<{ start: number; end: number }>): number {
  const sum = expected.reduce((total, target) => total + Math.max(0, ...predictions.map((prediction) => timeIou(target, prediction))), 0);
  return expected.length ? sum / expected.length : 0;
}

function scoreCase(expected: Expected[], predictions: Array<{ start: number; end: number; score: number }>, ks: number[]): CaseResult {
  const ranked = [...predictions].sort((a, b) => b.score - a.score || a.start - b.start);
  let sum = 0;
  const hits: Record<number, boolean> = {};
  for (const target of expected) {
    sum += Math.max(0, ...ranked.map((p) => timeIou(target, p)));
    for (const k of ks) hits[k] = (hits[k] ?? false) || ranked.slice(0, k).some((p) => timeIou(target, p) >= THRESHOLD);
  }
  return { meanIou: expected.length ? sum / expected.length : 0, hits };
}

function aggregateTargetRecall(results: Array<{ expected: Expected[]; predictions: Array<{ start: number; end: number }> }>, k: number): TargetRecall {
  const total = results.reduce((sum, result) => sum + result.expected.length, 0);
  const hits = results.reduce((sum, result) => sum + targetRecall(result.expected, result.predictions, k).hits, 0);
  return { hits, total, recall: total ? hits / total : 0 };
}

function aggregate(results: CaseResult[]): { meanIou: number; hitAt: Record<number, number> } {
  const ks = Object.keys(results[0]?.hits ?? { 1: false }).map(Number);
  const total = results.length;
  return {
    meanIou: results.reduce((sum, r) => sum + r.meanIou, 0) / total,
    hitAt: Object.fromEntries(ks.map((k) => [k, results.filter((r) => r.hits[k]).length / total])),
  };
}

// --- providers --------------------------------------------------------------
type Row = { name: string; run: (transcript: Transcript) => Promise<Highlight[]> | Highlight[]; live?: boolean };

function oracleProposals(item: Case, transcript: Transcript, jitter: boolean): Array<{ start: number; end: number; wordIds: string[]; title: string; score: number }> {
  return item.expected.map((expected, index) => {
    // Deterministic ±2s boundary jitter so the jittered oracle is reproducible.
    const d1 = jitter ? (((index + item.id.length) % 3) - 1) * 2 : 0;
    const d2 = jitter ? ((((index + 1) * 2 + item.id.length) % 3) - 1) * 2 : 0;
    const start = Math.max(0, expected.start + d1);
    const end = Math.min(transcript.duration, Math.max(start + 4, expected.end + d2));
    return {
      start, end,
      wordIds: transcript.words.filter((w) => w.start >= start && w.end <= end).map((w) => w.id),
      title: expected.title,
      score: 90 - index * 5,
    };
  });
}

async function main(): Promise<void> {
  const cases = dataset.cases;
  const transcripts = cases.map((item) => ({ item, transcript: buildTranscript(item) }));
  const expectedCount = cases.reduce((sum, item) => sum + item.expected.length, 0);
  const ks = [1, 3, 5];

  const detailedRows = transcripts.map(({ item, transcript }) => {
    const usesContent = transcript.duration > 120;
    const windows = usesContent ? buildContentWindows(transcript) : buildWindows(transcript);
    const legacyWindows = windows.map((window) => {
      const wordCount = window.wordIds.length || window.text.split(/\s+/).filter(Boolean).length;
      const score = usesContent
        ? Math.max(0, Math.min(100, Math.round(window.quality.completeness * .25 + window.quality.coherence * .2 + window.quality.hook * .2 + window.quality.value * .2 + window.quality.ending * .15 - window.quality.abruptCutPenalty * .25)))
        : Math.min(100, wordCount * 5 + (window.hook ? 25 : 0) + (window.complete ? 10 : 0) + (window.pauseBoundary ? 8 : 0));
      return { ...window, score };
    });
    const currentWindows = windows;
    const legacyTop = selectHeuristicWindows(legacyWindows, 15);
    const currentTop = selectHeuristicWindows(currentWindows, 15);
    const legacyTop5 = selectHeuristicWindows(legacyWindows, 5).map((window) => ({ start: window.start, end: window.end }));
    const currentTop5 = selectHeuristicWindows(currentWindows, 5).map((window) => ({ start: window.start, end: window.end }));
    const legacyPredictions = legacyTop.map((window) => ({ start: window.start, end: window.end }));
    const currentPredictions = currentTop.map((window) => ({ start: window.start, end: window.end }));
    const candidates = buildRerankCandidates(transcript, undefined, 15);
    assert.ok(candidates.length <= 15, `${item.id}: hybrid shortlist must be capped at 15`);
    if (item.id === "short-hook") {
      assert.ok(candidates.some((candidate) => timeIou(item.expected[0]!, candidate) >= THRESHOLD), "short-hook must be present in the real top-15 shortlist");
    }
    const provider: SemanticHighlightProvider = {
      async generate() { throw new Error("eval rerank must not call semantic generation"); },
      async rerank({ candidates: offered, limit }) {
        assert.equal(offered.length, candidates.length);
        return { selections: offered
          .map((candidate) => ({ candidateId: candidate.id, score: Math.max(0, ...item.expected.map((target) => timeIou(target, candidate))) * 100 }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit) };
      },
    };
    return (async () => ({
      item,
      transcript,
      legacyPredictions,
      currentPredictions,
      legacyTop5,
      currentTop5,
      hybridPredictions: await rerankCandidates(transcript, candidates, provider, 5),
    }))();
  });
  const detailed = await Promise.all(detailedRows);
  assert.equal(detailed.reduce((sum, row) => sum + row.item.expected.length, 0), expectedCount);
  const baselineRecall15 = aggregateTargetRecall(detailed.map((row) => ({ expected: row.item.expected, predictions: row.legacyPredictions })), 15);
  const currentRecall15 = aggregateTargetRecall(detailed.map((row) => ({ expected: row.item.expected, predictions: row.currentPredictions })), 15);
  const legacyTop5Recall = aggregateTargetRecall(detailed.map((row) => ({ expected: row.item.expected, predictions: row.legacyTop5 })), 5);
  const currentTop5Recall = aggregateTargetRecall(detailed.map((row) => ({ expected: row.item.expected, predictions: row.currentTop5 })), 5);
  const hybridRecall5 = aggregateTargetRecall(detailed.map((row) => ({ expected: row.item.expected, predictions: row.hybridPredictions })), 5);
  const meanTargetIou = (key: "legacyPredictions" | "currentPredictions" | "hybridPredictions") => detailed.reduce((sum, row) => sum + targetMeanIou(row.item.expected, row[key]), 0) / detailed.length;
  assert.equal(baselineRecall15.recall, currentRecall15.recall, "with no audio, current Tier-2 score should match legacy target recall");
  assert.equal(legacyTop5Recall.recall, currentTop5Recall.recall, "with no audio, current Tier-2 top-5 should match legacy top-5 recall");

  console.log("-- same-fixture ranking ablation (legacy/current use same candidate windows) --");
  console.log(`legacy baseline top-15 mean target IoU ${meanTargetIou("legacyPredictions").toFixed(2)} · recall@15 ${baselineRecall15.hits}/${baselineRecall15.total} ${(baselineRecall15.recall * 100).toFixed(0)}% · top-5 recall ${legacyTop5Recall.hits}/${legacyTop5Recall.total} ${(legacyTop5Recall.recall * 100).toFixed(0)}%`);
  console.log(`current Tier-2 top-15 mean target IoU ${meanTargetIou("currentPredictions").toFixed(2)} · recall@15 ${currentRecall15.hits}/${currentRecall15.total} ${(currentRecall15.recall * 100).toFixed(0)}% · top-5 recall ${currentTop5Recall.hits}/${currentTop5Recall.total} ${(currentTop5Recall.recall * 100).toFixed(0)}%`);
  console.log(`hybrid oracle top-5 mean target IoU ${meanTargetIou("hybridPredictions").toFixed(2)} · recall@5 ${hybridRecall5.hits}/${hybridRecall5.total} ${(hybridRecall5.recall * 100).toFixed(0)}% · source shortlist recall@15 ${currentRecall15.hits}/${expectedCount} (oracle ceiling; not model performance)`);
  console.log("   note: fixture has no RMS measurements and uses synthetic word timings; it cannot measure real audio-energy/speech-rate gains.");
  for (const row of detailed) {
    const baseline = targetRecall(row.item.expected, row.legacyPredictions, 15);
    const current = targetRecall(row.item.expected, row.currentPredictions, 15);
    const baseline5 = targetRecall(row.item.expected, row.legacyTop5, 5);
    const current5 = targetRecall(row.item.expected, row.currentTop5, 5);
    const hybrid = targetRecall(row.item.expected, row.hybridPredictions, 5);
    console.log(`   ${row.item.id.padEnd(20)} recall@15 legacy ${baseline.hits}/${baseline.total} current ${current.hits}/${current.total} · recall@5 legacy ${baseline5.hits}/${baseline5.total} current ${current5.hits}/${current5.total} hybrid-oracle ${hybrid.hits}/${hybrid.total}`);
  }

  const rows: Row[] = [
    { name: "heuristic", run: (t) => chooseHeuristicHighlights(t, LIMIT) },
    { name: "content", run: (t) => chooseContentHighlights(t, LIMIT) },
    {
      name: "semantic-oracle",
      run: (t) => {
        const item = cases.find((c) => c.id === t.sourceArtifactId)!;
        return generateSemanticHighlights(t, createMockSemanticProvider(oracleProposals(item, t, false)), { limit: LIMIT, minDuration: 10, maxDuration: 90 });
      },
    },
    {
      name: "semantic-oracle-jit",
      run: (t) => {
        const item = cases.find((c) => c.id === t.sourceArtifactId)!;
        return generateSemanticHighlights(t, createMockSemanticProvider(oracleProposals(item, t, true)), { limit: LIMIT, minDuration: 10, maxDuration: 90 });
      },
    },
  ];

  // Live rows — only when the backend is actually reachable.
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    rows.push({ name: "semantic-gemini", live: true, run: (t) => generateSemanticHighlights(t, new SemanticProviderAdapter(new GeminiHighlightProvider(geminiKey), "gemini"), { limit: LIMIT, minDuration: 10, maxDuration: 90 }) });
  }
  const llamaBase = (process.env.LOCAL_LLM_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
  let llamaUp = false;
  // Probe /v1/models, not /health — unrelated local services can answer /health.
  try { llamaUp = (await fetch(`${llamaBase}/v1/models`, { signal: AbortSignal.timeout(1500) })).ok; } catch { llamaUp = false; }
  if (llamaUp) {
    rows.push({ name: "semantic-local", live: true, run: (t) => generateSemanticHighlights(t, new SemanticProviderAdapter(new LlamaCppHighlightProvider(llamaBase), "llama-cpp"), { limit: LIMIT, minDuration: 10, maxDuration: 90 }) });
  }

  // Real hybrid rerank row: the production two-round path against a live
  // OpenAI-compatible endpoint. Opt in with HYBRID_EVAL_BASE_URL + HYBRID_EVAL_MODEL
  // (optionally HYBRID_EVAL_API_KEY) so CI never calls a remote model by accident.
  const hybridBase = process.env.HYBRID_EVAL_BASE_URL?.trim();
  const hybridModel = process.env.HYBRID_EVAL_MODEL?.trim();
  const hybridUp = Boolean(hybridBase && hybridModel);
  if (hybridUp) {
    const hybridProvider = new SemanticProviderAdapter(
      new OpenAIChatHighlightProvider(hybridBase!, process.env.HYBRID_EVAL_API_KEY ?? "", hybridModel!),
      `openai:${hybridBase}|${hybridModel}`,
    );
    rows.push({
      name: "hybrid-rerank",
      live: true,
      run: async (t) => {
        const candidates = buildRerankCandidates(t, undefined, 15);
        if (!candidates.length) return [];
        return rerankCandidates(t, candidates, hybridProvider, LIMIT);
      },
    });
  }

  console.log(`== highlight eval: ${cases.length} cases, ${expectedCount} expected, IoU threshold ${THRESHOLD} ==`);
  if (!geminiKey) console.log("   (semantic-gemini skipped: GEMINI_API_KEY not set)");
  if (!llamaUp) console.log(`   (semantic-local skipped: no llama-server at ${llamaBase}/v1/models)`);
  if (!hybridUp) console.log("   (hybrid-rerank skipped: HYBRID_EVAL_BASE_URL/HYBRID_EVAL_MODEL not set)");

  const aggregates = new Map<string, { meanIou: number; hitAt: Record<number, number>; failures: number; worst: { id: string; iou: number } }>();

  for (const row of rows) {
    const results: CaseResult[] = [];
    let failures = 0;
    let worst = { id: "", iou: Infinity };
    let aborted = false;
    for (const { item, transcript } of transcripts) {
      if (aborted) { failures += 1; continue; }
      try {
        const pending = row.run(transcript);
        const predictions = typeof (pending as Promise<Highlight[]>).then === "function"
          ? await Promise.race([pending, new Promise<Highlight[]>((_, reject) => setTimeout(() => reject(new Error("EVAL_CASE_TIMEOUT")), 240_000).unref())])
          : (pending as Highlight[]);
        for (const p of predictions) {
          validateHighlights([p], transcript.duration);
          assert.ok(p.scores, `${row.name} must emit component scores`);
          for (const axis of ["hook", "summary", "impact"] as const) {
            assert.ok(Number.isFinite(p.scores[axis]) && p.scores[axis] >= 0 && p.scores[axis] <= 100, `${row.name} emitted invalid ${axis} score`);
          }
          const dominant = (["hook", "summary", "impact"] as const).reduce((best, axis) => p.scores[axis] > p.scores[best] ? axis : best, "hook");
          assert.equal(p.dominantAxis, p.scores[dominant] >= 70 ? dominant : undefined, `${row.name} dominant axis must be the ≥70 component maximum`);
        }
        const result = scoreCase(item.expected, predictions, ks);
        results.push(result);
        if (result.meanIou < worst.iou) worst = { id: item.id, iou: result.meanIou };
      } catch (error) {
        failures += 1;
        if (row.live) { console.log(`   ${row.name}: aborting remaining cases (${String(error).slice(0, 80)})`); aborted = true; }
        else throw error; // offline rows must never fail a case
      }
    }
    if (!results.length) { console.log(`${row.name.padEnd(20)} all cases failed`); continue; }
    const agg = aggregate(results);
    aggregates.set(row.name, { ...agg, failures, worst });
    const hits = ks.map((k) => `${((agg.hitAt[k] ?? 0) * 100).toFixed(0)}%`.padStart(5)).join("  ");
    console.log(`${row.name.padEnd(20)} IoU ${agg.meanIou.toFixed(2)}   hit@1/3/5:${hits}   worst case ${worst.id} (${worst.iou.toFixed(2)})${failures ? `   failures ${failures}` : ""}`);
  }

  // Pause-boundary signal: fixtures are contiguous, so verify directly that a
  // ≥0.7s internal gap (Whisper word-timing derived) lifts a segment's score.
  // A gap marks the boundary BETWEEN two segments, so both sides earn the bonus;
  // compare against segments in a contiguous run (no bonus) and a sub-threshold gap.
  const mkPauseCase = (gapAfterC: number): Transcript => ({
    version: 1, sourceArtifactId: "gap-probe", language: "en", duration: 40, provider: "test",
    words: [],
    segments: [
      { id: "a", text: "We talked about the roadmap for a while.", start: 0, end: 6, wordIds: [] },
      { id: "b", text: "We talked about the roadmap for a while.", start: 6, end: 12, wordIds: [] },   // fully contiguous
      { id: "c", text: "We talked about the roadmap for a while.", start: 12, end: 18, wordIds: [] },  // gap after → pause
      { id: "d", text: "We talked about the roadmap for a while.", start: 18 + gapAfterC, end: 24 + gapAfterC, wordIds: [] },
    ],
  });
  const scoreOf = (t: Transcript, start: number) => chooseHeuristicHighlights(t, 5).find((h) => h.start === start)!.score;
  const gapped = mkPauseCase(3);      // 3s pause between c and d
  assert.ok(scoreOf(gapped, 12) > scoreOf(gapped, 6), `pause boundary must lift score (c adjacent to 3s gap vs contiguous b)`);
  assert.equal(scoreOf(gapped, 6), scoreOf(gapped, 0), "contiguous segments must not earn the pause bonus");
  const tight = mkPauseCase(0.2);     // 0.2s gap — below threshold
  assert.equal(scoreOf(tight, 12), scoreOf(tight, 6), "sub-threshold gap must not lift score");

  // Post-selection pause snapping moves only boundaries already selected by the
  // ranker, is bounded to 0.5s, and refreshes the associated word IDs.
  const snapTranscript: Transcript = {
    version: 1, sourceArtifactId: "snap", language: "en", duration: 32, provider: "test",
    words: [
      { id: "before", text: "before", start: 9.2, end: 9.8 },
      { id: "first", text: "first", start: 10.15, end: 12 },
      { id: "last", text: "last", start: 17, end: 19.8 },
      { id: "after", text: "after", start: 20.2, end: 21 },
      { id: "distant", text: "distant", start: 25, end: 26 },
    ],
    segments: [],
  };
  const selected: Highlight[] = [{
    version: 1, id: "selected", sourceArtifactId: "snap", start: 10.4, end: 19.9,
    wordIds: ["stale"], title: "Selected", score: 82,
  }];
  const snapped = snapHighlightsToPauses(selected, snapTranscript);
  assert.equal(snapped[0].start, 10.15, "a ≥0.3s pause can snap the start to the following word");
  assert.equal(snapped[0].end, 19.8, "a ≥0.3s pause can snap the end to the preceding word");
  assert.deepEqual(snapped[0].wordIds, ["first", "last"], "word IDs are refreshed after snapping");
  assert.equal(snapped[0].score, selected[0].score, "snapping must not change aggregate score");
  assert.equal(snapped[0].id, selected[0].id, "snapping must preserve selected identity/order");

  // Scene cuts adjust boundaries only when a cut is very close, and refresh word IDs.
  const sceneSnapped = snapHighlightsToScenes(selected, snapTranscript, [10.1, 20.25]);
  assert.equal(sceneSnapped[0].start, 10.1);
  assert.equal(sceneSnapped[0].end, 20.25);
  assert.deepEqual(sceneSnapped[0].wordIds, ["first", "last"]);
  assert.equal(sceneSnapped[0].score, selected[0].score);
  assert.deepEqual(snapHighlightsToScenes(selected, snapTranscript, [8, 22]), selected, "distant scene cuts must not move boundaries");
  assert.deepEqual(parseSceneCutMetadata("frame:1 lavfi.scd.time=10.1 lavfi.scd.score=22\nframe:2 lavfi.scd.time=20.25 lavfi.scd.score=25", 32), [10.1, 20.25]);
  const shortClip = { ...selected[0], start: 10.4, end: 14.2 };
  const partialSceneSnap = snapHighlightsToScenes([shortClip], snapTranscript, [10.1, 14.0]);
  assert.equal(partialSceneSnap[0].start, 10.1, "a valid start snap remains even when end snap would make the clip too short");
  assert.equal(partialSceneSnap[0].end, shortClip.end, "invalid short end snap is rejected independently");
  assert.deepEqual(parseSceneCutMetadata("lavfi.scd.time=0\nlavfi.scd.time=32", 32), [], "cuts at video edges must be ignored");

  const ineligibleTranscript: Transcript = {
    ...snapTranscript,
    words: [
      { id: "a", text: "a", start: 9.2, end: 9.8 },
      { id: "b", text: "b", start: 10, end: 12 }, // only a 0.2s pause
      { id: "c", text: "c", start: 17, end: 19.8 },
      { id: "d", text: "d", start: 20, end: 21 }, // only a 0.2s pause
    ],
  };
  assert.deepEqual(snapHighlightsToPauses(selected, ineligibleTranscript), selected, "gaps below 0.3s do not snap");
  const cappedTranscript: Transcript = {
    ...snapTranscript,
    words: [
      { id: "before", text: "before", start: 9.2, end: 9.8 },
      { id: "first", text: "first", start: 10.15, end: 12 },
      { id: "last", text: "last", start: 17, end: 19.8 },
      { id: "after", text: "after", start: 20.2, end: 21 },
    ],
  };
  const beyondCap = [{ ...selected[0], start: 10.8 }];
  assert.equal(snapHighlightsToPauses(beyondCap, cappedTranscript)[0].start, 10.8, "snaps beyond 0.5s are rejected");
  const blockedStart = snapHighlightsToPauses(
    [{ ...selected[0], start: 10.4 }],
    { ...snapTranscript, words: [
      { id: "before", text: "before", start: 9.2, end: 9.8 },
      { id: "first", text: "first", start: 10.15, end: 12 },
      { id: "last", text: "last", start: 17, end: 19.8 },
      { id: "after", text: "after", start: 20.2, end: 21 },
    ] },
  );
  // The preceding highlight makes only the proposed start invalid; keep the valid end snap.
  const withPrevious = snapHighlightsToPauses(
    [
      { ...selected[0], id: "previous", start: 9.8, end: 10.25, wordIds: ["before"] },
      { ...selected[0], start: 10.4 },
    ],
    { ...snapTranscript, words: [
      { id: "before", text: "before", start: 9.2, end: 9.8 },
      { id: "first", text: "first", start: 10.15, end: 12 },
      { id: "last", text: "last", start: 17, end: 19.8 },
      { id: "after", text: "after", start: 20.2, end: 21 },
    ] },
  );
  assert.equal(withPrevious[1]!.start, 10.4, "invalid start snap must retain its original boundary");
  assert.equal(withPrevious[1]!.end, 19.8, "a valid end snap should survive an invalid start snap");
  assert.equal(blockedStart[0]!.end, 19.8, "snapping remains valid without neighboring selections");

  const segmentOnly: Transcript = {
    version: 1, sourceArtifactId: "segment-only", language: "en", duration: 25, provider: "test", words: [],
    segments: [
      { id: "before-segment", text: "before", start: 9.2, end: 9.8, wordIds: ["before-word"] },
      { id: "first-segment", text: "first", start: 10.15, end: 12, wordIds: ["first-word"] },
      { id: "last-segment", text: "last", start: 17, end: 19.8, wordIds: ["last-word"] },
      { id: "after-segment", text: "after", start: 20.2, end: 21, wordIds: ["after-word"] },
    ],
  };
  const segmentSnapped = snapHighlightsToPauses([{ ...selected[0], sourceArtifactId: "segment-only" }], segmentOnly);
  assert.deepEqual(segmentSnapped[0]!.wordIds, ["first-word", "last-word"], "segment-only snapping refreshes segment word IDs");

  const sentenceTranscript: Transcript = {
    ...snapTranscript,
    words: [
      { id: "opening", text: "Opening", start: 0, end: 0.8 },
      { id: "sentence-end", text: "complete.", start: 0.85, end: 1.5 },
      { id: "next", text: "Next", start: 1.55, end: 2.1 },
      { id: "thought-end", text: "thought!", start: 2.15, end: 2.8 },
      { id: "tail", text: "Tail", start: 2.85, end: 3.5 },
    ],
  };
  const sentenceSnapped = snapHighlightsToPauses([{
    ...selected[0], start: 1.52, end: 2.84, wordIds: ["stale"],
  }], sentenceTranscript)[0]!;
  assert.equal(sentenceSnapped.start, 1.55, "sentence start should snap to the first word after punctuation");
  assert.equal(sentenceSnapped.end, 2.8, "sentence end should snap to a punctuation-ending word");
  assert.deepEqual(sentenceSnapped.wordIds, ["next", "thought-end"], "sentence snapping refreshes word IDs");

  // Snapping is a timestamp refinement, not another selector: evaluate the
  // selector's chosen set before/after on every fixture and protect aggregate IoU.
  const snapBaselines = transcripts.map(({ item, transcript }) => {
    const baseline = chooseHeuristicHighlights(transcript, LIMIT);
    return { expected: item.expected, baseline, snapped: snapHighlightsToPauses(baseline, transcript) };
  });
  const baselineMeanIou = aggregate(snapBaselines.map(({ expected, baseline }) => scoreCase(expected, baseline, ks))).meanIou;
  const snappedMeanIou = aggregate(snapBaselines.map(({ expected, snapped }) => scoreCase(expected, snapped, ks))).meanIou;
  assert.ok(snappedMeanIou >= baselineMeanIou, `pause snapping must not regress aggregate heuristic IoU (${snappedMeanIou} < ${baselineMeanIou})`);

  // --- CI assertions (offline rows only) ------------------------------------
  // Prompt shape: compact word lines, never full word-object JSON — this is
  // what keeps a 180s window inside the production llama-server context.
  const sample = transcripts[0].transcript;
  const prompt = highlightPrompt(sample);
  assert.ok(prompt.includes("0 ["), "prompt must use compact wordIndex [start-end] text lines");
  assert.ok(!prompt.includes('"words"'), "prompt must not embed full word JSON");
  assert.ok(prompt.length < JSON.stringify(sample).length, "compact prompt must be smaller than raw transcript JSON");
  // Mapping: word-index proposals re-derive times/wordIds; junk indices are dropped.
  const mapped = mapWordRangeProposals(sample, [{ from: 0, to: 2, title: "ok", score: 90 }, { from: 9999, to: 10000, title: "junk", score: 50 }, { from: "x", to: 2, title: "junk2", score: 50 }]);
  assert.equal(mapped.length, 1, "only in-range integer proposals survive");
  assert.equal(mapped[0].start, sample.words[0].start);
  assert.equal(mapped[0].end, sample.words[2].end);
  assert.deepEqual(mapped[0].wordIds, sample.words.slice(0, 3).map((w) => w.id));
  assert.equal(mapped[0].score, 90);
  // Probability-style scores rescale to the 0..100 contract.
  assert.equal(mapWordRangeProposals(sample, [{ from: 0, to: 1, title: "p", score: 0.9 }])[0].score, 90);

  const oracle = aggregates.get("semantic-oracle")!;
  const jittered = aggregates.get("semantic-oracle-jit")!;
  const heuristic = aggregates.get("heuristic")!;
  const content = aggregates.get("content")!;

  // --- P3 seam: the exported windowing + NMS must reproduce the shipped
  // selector exactly, so the blend probes below re-rank the same candidates.
  for (const { item, transcript } of transcripts) {
    const seam = nonMaximumSuppression(buildWindows(transcript), LIMIT);
    const shipped = chooseHeuristicHighlights(transcript, LIMIT);
    assert.deepEqual(
      seam.map((w) => [w.start, w.end, w.score]),
      shipped.map((h) => [h.start, h.end, h.score]),
      `${item.id}: exported seam must reproduce chooseHeuristicHighlights`,
    );
  }

  // --- Tier 1 probe: re-rank the identical candidate set with linear blends of
  // the three axes. Reported, never applied to the shipped formula — this is the
  // cheap test of whether re-weighting alone buys ranking quality. Measured
  // 2026-11-10: all three weightings tie exactly (IoU 0.69, hit@5 7/8) because
  // none of the axes penalises length, so no re-weighting can recover
  // vlog-rambling. That residual gap is the evidence for a tier-2 reranker.
  const blends: Array<{ name: string; weights: { hook: number; summary: number; impact: number } }> = [
    { name: "blend-h/s/i 4/3/3", weights: { hook: 0.4, summary: 0.3, impact: 0.3 } },
    { name: "blend-h/s/i 3/4/3", weights: { hook: 0.3, summary: 0.4, impact: 0.3 } },
    { name: "blend-h/s/i 3/3/4", weights: { hook: 0.3, summary: 0.3, impact: 0.4 } },
  ];
  console.log("-- tier-1 linear blends over the same candidate set --");
  for (const { name, weights } of blends) {
    const results = transcripts.map(({ item, transcript }) => {
      const ranked = nonMaximumSuppression(
        buildWindows(transcript).map((w) => ({
          start: w.start,
          end: w.end,
          score: weights.hook * w.scores.hook + weights.summary * w.scores.summary + weights.impact * w.scores.impact,
        })),
        LIMIT,
      );
      return { id: item.id, ...scoreCase(item.expected, ranked, ks) };
    });
    const agg = aggregate(results);
    console.log(
      `${name.padEnd(20)} IoU ${agg.meanIou.toFixed(2)}   hit@5 ${((agg.hitAt[5] ?? 0) * 100).toFixed(0)}%   [${results.map((r) => `${r.id} ${r.meanIou.toFixed(2)}`).join(", ")}]`,
    );
  }

  // --- Per-case floors: the measured heuristic baseline, case by case. Adding a
  // fixture without measuring it fails on "floor missing", so a new case cannot
  // slip in untracked. A 0 floor is a known miss the word-count score cannot
  // recover; it still has to be listed so the id cannot vanish from the map.
  const heuristicFloors: Record<string, number> = {
    "tutorial-export": 1,
    "podcast-revenue": 0,
    "cooking-pasta": 1,
    "gaming-review": 0.5,
    "lecture-memory": 1,
    "interview-founder": 1,
    "vlog-rambling": 0,
    "short-hook": 0,
  };
  const heuristicPerCase = transcripts.map(({ item, transcript }) => ({
    id: item.id,
    iou: scoreCase(item.expected, chooseHeuristicHighlights(transcript, LIMIT), ks).meanIou,
  }));
  console.log(`per-case heuristic: ${heuristicPerCase.map((r) => `${r.id} ${r.iou.toFixed(4)}`).join(", ")}`);
  for (const { id, iou } of heuristicPerCase) {
    const floor = heuristicFloors[id];
    assert.ok(floor !== undefined, `heuristic floor missing for fixture ${id}`);
    assert.ok(iou >= floor, `heuristic IoU ${iou.toFixed(2)} on ${id} below floor ${floor} — candidate selection regressed`);
  }

  // Metric sanity: exact oracle must be near-perfect; jittered oracle must
  // rank every expected inside top-3 while scoring clearly below 1.0.
  assert.ok(oracle.meanIou >= 0.99, `oracle IoU ${oracle.meanIou} — metric or fixture broken`);
  assert.equal(oracle.hitAt[3], 1, "oracle hit@3 must be 100%");
  assert.ok(jittered.meanIou > 0.4 && jittered.meanIou < 0.95, `jittered oracle IoU ${jittered.meanIou} outside plausible band`);
  assert.equal(jittered.hitAt[3], 1, "jittered oracle hit@3 must be 100%");

  // Regression gate: the documented heuristic baseline on this dataset is mean
  // IoU 0.5625 with hit@5 on 5 of 8 cases. The two length-bias probes are known
  // misses (the ratio below still includes them), so a candidate-selection
  // change that drops either number must fail CI instead of only printing a
  // lower score. The shipped score formula is unchanged since this baseline.
  assert.ok(heuristic.meanIou >= 0.5625, `heuristic IoU ${heuristic.meanIou} below baseline 0.5625 — candidate selection regressed`);
  assert.ok((heuristic.hitAt[5] ?? 0) >= 5 / 8, `heuristic hit@5 ${heuristic.hitAt[5]} below baseline 5/8 — candidate selection regressed`);
  assert.ok(content.meanIou > 0.2, `content IoU ${content.meanIou} too low — fixtures or content regressed`);

  console.log("eval highlight tests: ok");
}

await main();
