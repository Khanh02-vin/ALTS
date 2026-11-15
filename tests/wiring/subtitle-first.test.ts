/// Subtitle-first wiring: both workers gain a subtitle path that skips Whisper
/// when timed cues already exist — local embedded tracks (analyze-video) and
/// yt-dlp auto-subs in the YouTube fallback (analyze-youtube).
///
/// Run: node --experimental-strip-types tests/wiring/subtitle-first.test.ts
import { strict as assert } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const analyzeVideo = readFileSync(join(here, "..", "..", "scripts", "analyze-video.ts"), "utf8");
const analyzeYoutube = readFileSync(join(here, "..", "..", "scripts", "analyze-youtube.ts"), "utf8");

assert.match(analyzeVideo, /embeddedSubtitleTranscript\(mediaPath, duration/, "analyze-video must probe embedded subtitle tracks before Whisper");
assert.match(analyzeVideo, /"embedded-subs"/, "embedded subs must be labelled in the transcript provider");
assert.match(analyzeYoutube, /autoSubtitleTranscript\(url, duration/, "the YouTube fallback must attempt yt-dlp auto-subs before Whisper");
assert.match(analyzeYoutube, /"yt-dlp-subs"/, "yt-dlp subs must be labelled in the transcript provider");
assert.match(analyzeYoutube, /transcript: injectedTranscript/, "the fallback analysis must inject the parsed sub transcript");

console.log("subtitle-first wiring tests: ok");
