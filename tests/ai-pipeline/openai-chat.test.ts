import assert from "node:assert/strict";
import type { Transcript } from "../../packages/contracts/transcript.ts";
import { GeminiHighlightProvider, HIGHLIGHT_OUTPUT_SCHEMA, OpenAIChatHighlightProvider, highlightPrompt, mapWordRangeProposals, RERANK_OUTPUT_SCHEMA } from "../../services/ai-pipeline/providers.ts";

/**
 * OpenAI-compatible chat highlight provider: POST {baseUrl}/chat/completions
 * with a bearer key, a configurable model, and a json_object response format.
 * Shared helpers (windowing, merge, proposal mapping, truncated-JSON repair,
 * circuit breaker) are reused from providers.ts — the same arrangement the
 * local llama.cpp provider already uses.
 */

const makeTranscript = (duration = 60): Transcript => ({
  version: 1,
  sourceArtifactId: "src",
  language: "en",
  duration,
  provider: "test",
  words: [
    { id: "w0", text: "This", start: 1, end: 1.4 },
    { id: "w1", text: "is", start: 1.4, end: 1.7 },
    { id: "w2", text: "a", start: 1.7, end: 1.9 },
    { id: "w3", text: "useful", start: 1.9, end: 2.4 },
    { id: "w4", text: "idea", start: 2.4, end: 3 },
    { id: "w5", text: "today", start: 10, end: 10.5 },
  ],
  segments: [],
});

const cannedBody = JSON.stringify({
  highlights: [
    { from: 0, to: 2, title: "Intro", score: 90 },
    { from: 3, to: 5, title: "Outro", score: 70 },
  ],
});

type Captured = { url: string; init: RequestInit };
function stubFetch(handler: (captured: Captured) => Response | Promise<Response>): Captured[] {
  const captured: Captured[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const entry = { url: String(url), init: init ?? {} };
    captured.push(entry);
    return handler(entry);
  }) as typeof fetch;
  return captured;
}

const okChoices = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status: 200 });

// 1. Request shape: URL, bearer auth, model, json response_format.
{
  const captured = stubFetch(() => okChoices(cannedBody));
  const provider = new OpenAIChatHighlightProvider("https://api.example.com/v1", "test-key", "my-model");
  const highlights = await provider.choose({ transcript: makeTranscript() });
  assert.equal(highlights.length, 2);
  assert.equal(highlights[0].title, "Intro");
  assert.equal(highlights[0].start, 1);
  assert.equal(highlights[1].end, 10.5);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "https://api.example.com/v1/chat/completions");
  const sent = JSON.parse(String(captured[0].init.body)) as { model: string; messages: Array<{ role: string }>; response_format: { type: string } };
  assert.equal(sent.model, "my-model");
  assert.equal(sent.messages[0].role, "user");
  assert.equal(sent.response_format.type, "json_object");
  const headers = new Headers(captured[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer test-key");
}

// 2. Trailing slashes on the base URL are trimmed.
{
  const captured = stubFetch(() => okChoices(cannedBody));
  const provider = new OpenAIChatHighlightProvider("https://api.example.com/v1///", "k", "m");
  await provider.choose({ transcript: makeTranscript() });
  assert.equal(captured[0].url, "https://api.example.com/v1/chat/completions");
}

// 3. Empty key omits the Authorization header (some gateways use IP allowlists).
{
  const captured = stubFetch(() => okChoices(cannedBody));
  const provider = new OpenAIChatHighlightProvider("https://api.example.com/v1", "", "m");
  await provider.choose({ transcript: makeTranscript() });
  const headers = new Headers(captured[0].init.headers);
  assert.equal(headers.get("authorization"), null);
}

// 4. Markdown-fenced JSON content parses.
{
  stubFetch(() => okChoices(`\`\`\`json\n${cannedBody}\n\`\`\``));
  const provider = new OpenAIChatHighlightProvider("https://api.example.com/v1", "k", "m");
  const highlights = await provider.choose({ transcript: makeTranscript() });
  assert.equal(highlights.length, 2);
}

// 5. Truncated JSON (cut off mid-title) is repaired like the llama provider does.
{
  const truncated = cannedBody.slice(0, cannedBody.indexOf('"Intro"') + 5);
  stubFetch(() => okChoices(truncated));
  const provider = new OpenAIChatHighlightProvider("https://api.example.com/v1", "k", "m");
  const highlights = await provider.choose({ transcript: makeTranscript() });
  assert.equal(highlights.length, 1);
  assert.equal(highlights[0].title, "Intr");
}

// 6. No word timings throws instead of sending an empty prompt.
{
  stubFetch(() => okChoices(cannedBody));
  const provider = new OpenAIChatHighlightProvider("https://api.example.com/v1", "k", "m");
  const empty: Transcript = { ...makeTranscript(), words: [] };
  await assert.rejects(() => provider.choose({ transcript: empty }), /SEMANTIC_REQUIRES_WORD_TIMESTAMPS/);
}

// 7. Non-OK status surfaces the status code.
{
  stubFetch(() => new Response("nope", { status: 500 }));
  const provider = new OpenAIChatHighlightProvider("https://api.example.com/v1", "k", "m");
  await assert.rejects(() => provider.choose({ transcript: makeTranscript() }), /OPENAI_CHAT_PROVIDER_500/);
}

// 8. Repeated failures open the circuit breaker.
{
  stubFetch(() => new Response("down", { status: 503 }));
  const provider = new OpenAIChatHighlightProvider("https://api.example.com/v1", "k", "m");
  for (let i = 0; i < 5; i++) await assert.rejects(() => provider.choose({ transcript: makeTranscript() }), /OPENAI_CHAT_PROVIDER_503/);
  await assert.rejects(() => provider.choose({ transcript: makeTranscript() }), /CIRCUIT_BREAKER_OPEN/);
}

// 9. Provider schemas/prompt request component scores, while legacy mappings remain accepted.
{
  const fields = HIGHLIGHT_OUTPUT_SCHEMA.properties.highlights.items.properties;
  assert.deepEqual(Object.keys(fields.scores.properties), ["hook", "summary", "impact"]);
  assert.ok(!("dominantAxis" in fields), "dominantAxis is derived locally");
  const prompt = highlightPrompt(makeTranscript());
  assert.match(prompt, /"scores":\{"hook":0-100,"summary":0-100,"impact":0-100\}/);
  assert.doesNotMatch(prompt, /dominantAxis/);

  const [legacy] = mapWordRangeProposals(makeTranscript(), [{ from: 0, to: 2, title: "Why this works?", score: 0.9 }]);
  assert.equal(legacy.score, 90, "aggregate score normalization remains unchanged");
  assert.ok(legacy.scores);
  assert.deepEqual(Object.keys(legacy.scores), ["hook", "summary", "impact"]);
  assert.equal(legacy.dominantAxis, undefined, "fallback components remain below the dominant-axis threshold where appropriate");

  const [scored] = mapWordRangeProposals(makeTranscript(), [{
    from: 0, to: 2, title: "Moment", score: 82,
    scores: { hook: 80, summary: 60, impact: 72 }, dominantAxis: "summary",
  }]);
  assert.equal(scored.score, 82);
  assert.deepEqual(scored.scores, { hook: 80, summary: 60, impact: 72 });
  assert.equal(scored.dominantAxis, "hook", "dominant axis is derived from locally normalized components");
}

// 10. Gemini sends the same component-score schema in its response configuration.
{
  let request: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: cannedBody }] } }] }), { status: 200 });
  }) as typeof fetch;
  const provider = new GeminiHighlightProvider("gemini-key");
  await provider.chooseTranscript(makeTranscript());
  const config = request?.generationConfig as { responseSchema: typeof HIGHLIGHT_OUTPUT_SCHEMA };
  const fields = config.responseSchema.properties.highlights.items.properties;
  assert.deepEqual(Object.keys(fields.scores.properties), ["hook", "summary", "impact"]);
  assert.ok(!("dominantAxis" in fields));
}

// 11. Hybrid rerank sends only candidate metadata and accepts candidate IDs.
{
  const captured = stubFetch(() => okChoices(JSON.stringify({ selections: [{ candidateId: "candidate-1", score: 94, title: "Top moment", reason: "clear payoff" }] })));
  const provider = new OpenAIChatHighlightProvider("https://api.example.com/v1", "key", "model");
  const candidates = [{ id: "candidate-1", start: 5, end: 12, text: "A concise explanation with payoff.", confidence: 80, energy: 0.24, silenceBoundary: true, componentScores: { hook: 80, summary: 70, impact: 75 } }];
  const result = await provider.rerank({ transcript: makeTranscript(), candidates, limit: 5 });
  assert.deepEqual(result.selections[0], { candidateId: "candidate-1", score: 94, title: "Top moment", reason: "clear payoff" });
  const sent = JSON.parse(String(captured[0].init.body)) as { messages: Array<{ content: string }>; response_format: { type: string; schema?: unknown } };
  assert.match(sent.messages[0].content, /silenceBoundary/);
  assert.match(sent.messages[0].content, /candidate-1/);
  assert.equal(sent.response_format.type, "json_object");
}

console.log("openai-chat provider tests passed");
