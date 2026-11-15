/// Cloud STT (Groq / any OpenAI-audio-compatible endpoint, BYOK):
/// - uploads the chunk WAV with model + response_format=verbose_json
/// - maps verbose_json segments onto the app transcript shape
/// - failures carry the REMOTE_STT_FAILED marker so the worker can fall
///   back to the local whisper.cpp engine
///
/// Run: node --experimental-strip-types tests/ai-pipeline/remote-stt.test.ts
import { strict as assert } from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcribeWavWithRemoteStt, REMOTE_STT_FAILED } from "../../adapters/local/whisper-remote.ts";

const tmp = mkdtempSync(join(tmpdir(), "remote-stt-"));
const wav = join(tmp, "chunk.wav");
writeFileSync(wav, Buffer.alloc(64, 1));

let lastRequest = { auth: "", model: "", format: "", bytes: 0, path: "" };
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body: Buffer[] = [];
  req.on("data", (chunk: Buffer) => body.push(chunk));
  req.on("end", () => {
    const text = Buffer.concat(body).toString("utf8");
    const field = (name: string) => { const m = text.match(new RegExp(`name="${name}"\\r?\\n\\r?\\n([^\\r\\n]+)`)); return m?.[1] ?? ""; };
    lastRequest = {
      auth: String(req.headers.authorization ?? ""),
      model: field("model"),
      format: field("response_format"),
      bytes: Buffer.concat(body).length,
      path: req.url ?? "",
    };
    if (lastRequest.auth === "Bearer bad") { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "invalid api key" } })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      language: "en",
      duration: 2.5,
      segments: [
        { start: 0, end: 1.2, text: "Hello from the cloud." },
        { start: 1.2, end: 2.5, text: "Second cue." },
      ],
    }));
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

// Happy path: posts multipart with model + verbose_json, maps segments.
const result = await transcribeWavWithRemoteStt(wav, { baseUrl, apiKey: "gsk_test", model: "whisper-large-v3-turbo" });
assert.equal(result.language, "en");
assert.equal(result.segments.length, 2);
assert.equal(result.segments[0].text, "Hello from the cloud.");
assert.equal(result.segments[1].end, 2.5);
assert.equal(lastRequest.auth, "Bearer gsk_test", "must authorize with the BYOK key");
assert.match(lastRequest.path, /\/audio\/transcriptions$/, "must hit the OpenAI audio transcriptions endpoint");
assert.ok(lastRequest.bytes > 64, "must upload the chunk file bytes as multipart");
assert.ok(lastRequest.format.includes("verbose_json"), "must request verbose_json segments");

// Failure path: HTTP error surfaces as the REMOTE_STT_FAILED marker.
let failed = "";
try {
  await transcribeWavWithRemoteStt(wav, { baseUrl, apiKey: "bad", model: "whisper-large-v3-turbo" });
} catch (error) { failed = String(error); }
assert.match(failed, new RegExp(REMOTE_STT_FAILED), "failures must carry the REMOTE_STT_FAILED marker");
assert.match(failed, /invalid api key/, "failure must carry the endpoint's message");

// Unreachable endpoint (fallback trigger in the worker).
let unreachable = "";
try {
  await transcribeWavWithRemoteStt(wav, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "gsk_test", model: "whisper-large-v3-turbo", timeoutMs: 800 });
} catch (error) { unreachable = String(error); }
assert.match(unreachable, new RegExp(REMOTE_STT_FAILED), "network errors must carry the marker too");

server.close();
console.log("remote stt adapter tests: ok");
