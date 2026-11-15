/// Relink media: an opened project whose source file vanished (moved, renamed,
/// deleted) must offer a visible re-link affordance instead of only reporting
/// the problem, and a replacement file whose duration drifts from the saved cut
/// must be refused so saved highlights can never be grafted onto other footage.
///
/// Run: node --experimental-strip-types tests/wiring/relink-media.test.ts
import { strict as assert } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const studio = readFileSync(join(here, "..", "..", "apps", "web", "src", "lib", "pages", "Studio.svelte"), "utf8");

assert.match(studio, /async function relinkMedia\(/, "Studio must expose a relinkMedia handler");
const relink = studio.match(/async function relinkMedia\([\s\S]*?\n  \}/)?.[0] ?? "";
assert.ok(relink.length > 0, "relinkMedia body must be extractable for assertion");
assert.match(relink, /invoke<ProbeMetadata>\("probe_video"/, "relink must re-probe the replacement file like a fresh load does");
assert.match(relink, /MEDIA_NOT_VERIFIED/, "relink must reject files ffprobe cannot verify");
assert.match(relink, /Math\.abs\(duration - meta\.duration\) > 2/, "relink must refuse files whose duration drifts more than 2 s from the saved cut");
assert.match(relink, /Relink refused:/, "relink refusal must explain why the file was rejected");
assert.match(relink, /await persistProject\(\)/, "relink must persist the new source path into the same project via the save queue");
assert.match(relink, /Source relinked/, "relink success must be reported to the user");

assert.ok(studio.match(/onclick=\{relinkMedia\}/g)?.length === 2, "both the step-1 card and the missing-media banner must wire the relink handler");
assert.match(studio, /Missing media/, "the missing-media banner must be labelled so users know what happened");
assert.match(studio, /\{#if probeError && projectId\}/, "the banner must only appear for an opened project whose source probe failed");

console.log("relink media wiring tests: ok");
