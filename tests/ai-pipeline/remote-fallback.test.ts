/// Cloud STT integration + fallback:
/// - chunked transcription with engine "openai-audio" talks to the STT_REMOTE_*
///   endpoint and propagates the REMOTE_STT_FAILED marker on failure
/// - the worker falls back to the local whisper.cpp engine on that marker
///   (a bad key / offline endpoint must degrade to offline, never fail the job)
///
/// Run: node --experimental-strip-types tests/ai-pipeline/remote-fallback.test.ts
import { strict as assert } from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { transcribeChunkedWithWhisper } from "../../adapters/local/chunked-whisper.ts";
import { analyzeLocalVideoWithSttFallback } from "../../services/ai-pipeline/index.ts";

const here = dirname(fileURLToPath(import.meta.url));

// A 1-second silent WAV so the per-chunk ffmpeg cut has real audio to slice.
const audio = join(tmpdir(), `remote-fallback-${Date.now()}.wav`);
execFileSync("ffmpeg", ["-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "1", "-c:a", "pcm_s16le", audio]);

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid api key" } }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

// The chunked layer propagates the marker from the remote engine.
process.env.STT_API_KEY = "test";
process.env.STT_REMOTE_BASE_URL = baseUrl;
let chunkedError = "";
try {
  await transcribeChunkedWithWhisper(audio, "fallback-art", 1, { engine: "openai-audio" });
} catch (error) { chunkedError = String(error); }
assert.match(chunkedError, /REMOTE_STT_FAILED/, "chunked remote failure must carry the marker");

// The fallback wrapper re-runs locally: the final error is the LOCAL engine's
// (missing whisper binary), not the cloud marker — offline path was attempted.
process.env.STT_REMOTE_BASE_URL = baseUrl;
let wrapperError = "";
try {
  await analyzeLocalVideoWithSttFallback(audio, "fallback-art", 1, { engine: "openai-audio", command: "/definitely/not/whisper" });
} catch (error) { wrapperError = String(error); }
assert.doesNotMatch(wrapperError, /REMOTE_STT_FAILED/, "after fallback the failure must not be the cloud one");
assert.match(wrapperError, /whisper|ENOENT|spawn/i, "the retry must have attempted the local whisper engine");
delete process.env.STT_API_KEY;
delete process.env.STT_REMOTE_BASE_URL;

// The worker wires the fallback + engine resolver.
const worker = readFileSync(join(here, "..", "..", "scripts", "analyze-video.ts"), "utf8");
assert.match(worker, /REMOTE_STT_FAILED/, "the worker must detect cloud STT failures");
assert.match(worker, /attemptAnalysis\("cpp"\)/, "the worker retry must force the local engine");
assert.match(worker, /resolveWhisperEngine\(process\.env\.WHISPER_ENGINE\)/, "the worker must resolve the engine through the shared resolver");
const chunked = readFileSync(join(here, "..", "..", "adapters", "local", "chunked-whisper.ts"), "utf8");
assert.match(chunked, /engine === "openai-audio"/, "chunked transcription must branch on the cloud engine");

server.close();
console.log("remote stt fallback tests: ok");
