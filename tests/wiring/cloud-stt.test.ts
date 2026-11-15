/// Cloud STT (BYOK) wiring: the Settings card saves/clears the endpoint via the
/// Rust commands, the worker resolves the engine through the shared resolver,
/// and every layer carries the REMOTE_STT_FAILED marker for local fallback.
///
/// Run: node --experimental-strip-types tests/wiring/cloud-stt.test.ts
import { strict as assert } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const settings = readFileSync(join(here, "..", "..", "apps", "web", "src", "lib", "pages", "Settings.svelte"), "utf8");
const worker = readFileSync(join(here, "..", "..", "scripts", "analyze-video.ts"), "utf8");
const chunked = readFileSync(join(here, "..", "..", "adapters", "local", "chunked-whisper.ts"), "utf8");
const remote = readFileSync(join(here, "..", "..", "adapters", "local", "whisper-remote.ts"), "utf8");
const mainRs = readFileSync(join(here, "..", "..", "apps", "desktop", "src-tauri", "src", "main.rs"), "utf8");

assert.match(settings, /Cloud transcription \(BYOK\)/, "Settings must expose the cloud STT card");
for (const command of ["save_cloud_stt", "clear_cloud_stt", "cloud_stt_status"]) {
  assert.ok(settings.includes(`"${command}"`), `Settings must invoke ${command}`);
  assert.ok(mainRs.includes(command), `main.rs must register ${command}`);
}
assert.match(settings, /automatically falls back to on-device Whisper/, "the card must document the local fallback");

assert.match(remote, /export const REMOTE_STT_FAILED/, "the marker must be exported");
assert.match(remote, /whisper-large-v3-turbo/, "Groq whisper-large-v3-turbo must be the default model");
assert.match(chunked, /engine === "openai-audio"/, "chunked transcription must branch on the cloud engine");
assert.match(worker, /attemptAnalysis\("cpp"\)/, "the worker must fall back to the local engine on cloud failure");

console.log("cloud stt wiring tests: ok");
