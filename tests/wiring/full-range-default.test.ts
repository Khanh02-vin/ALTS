/// Full-range analysis: the 600-second default cap is gone. Every analysis
/// runs over the whole verified video by default — no Start/End inputs in the
/// setup step, and applyDefaultRange must map the full duration, so a 30-minute
/// video is scored in full instead of only its first 10 minutes.
///
/// The manual fallback (no-Whisper hand-picked range) keeps its own Start/End.
///
/// Run: node --experimental-strip-types tests/wiring/full-range-default.test.ts
import { strict as assert } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const studio = readFileSync(join(here, "..", "..", "apps", "web", "src", "lib", "pages", "Studio.svelte"), "utf8");

const applyDefaultRange = studio.match(/function applyDefaultRange\([\s\S]*?\n  \}/)?.[0] ?? "";
assert.ok(applyDefaultRange.length > 0, "applyDefaultRange must exist");
assert.doesNotMatch(applyDefaultRange, /Math\.min\(600/, "the 600-second default cap must be gone");
assert.match(applyDefaultRange, /analyzeEnd = Math\.floor\(Math\.max\(0, seconds\)\)/, "the default range must cover the full video duration");
assert.match(applyDefaultRange, /manualEnd = Math\.floor\(Math\.max\(0, seconds\)\)/, "the manual fallback default must cover the full duration too");

assert.doesNotMatch(studio, /Range \(seconds/, "the Range setup card must be removed");
assert.doesNotMatch(studio, /bind:value=\{analyzeStart\}/, "the analysis Start input must be removed");
assert.doesNotMatch(studio, /bind:value=\{analyzeEnd\}/, "the analysis End input must be removed");
assert.match(studio, /bind:value=\{manualStart\}/, "the manual fallback keeps its own Start input");
assert.match(studio, /Analyze the full video/, "the setup card must say what now happens by default");

assert.match(studio, /invoke<string>\("start_analysis", \{ path: inputPath, start: analyzeStart, end: analyzeEnd \}\)/, "analysis must still send the (full) range to the backend");

console.log("full-range default tests: ok");
