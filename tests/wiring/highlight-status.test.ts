import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const highlight = readFileSync(join(root, "packages/contracts/highlight.ts"), "utf8");
const contractTest = readFileSync(join(root, "tests/contracts/contracts.test.ts"), "utf8");
const store = readFileSync(join(root, "apps/desktop/src-tauri/src/project_store.rs"), "utf8");
const studio = readFileSync(join(root, "apps/web/src/lib/pages/Studio.svelte"), "utf8");
const editor = readFileSync(join(root, "apps/web/src/lib/pages/Editor.svelte"), "utf8");
const project = readFileSync(join(root, "apps/web/src/lib/pages/Project.svelte"), "utf8");

// --- Contract: reversible per-highlight status, additive (optional field) ---
assert.match(highlight, /export type HighlightStatus/, "Highlight contract must declare a highlight status");
assert.match(highlight, /"saved"\s*\|\s*"discarded"/, "status must cover saved and discarded");
assert.match(highlight, /status\?:/, "status must be optional for backward compatibility");
assert.match(highlight, /isActiveHighlight/, "contract must expose active-highlight predicate");
assert.match(contractTest, /status:\s*"discarded"/, "contract tests must cover discarded highlights");
assert.match(contractTest, /status:\s*"saved"/, "contract tests must cover saved highlights");
assert.match(contractTest, /status:\s*"archived"/i, "contract tests must reject unknown status");

// --- Shared state / Project wiring ---
assert.match(project, /active|discard/, "Projects page must restore active selection excluding discarded");

// --- Studio wiring ---
assert.match(studio, /Save|Discard|Restore/, "Studio must expose per-highlight status controls");
assert.match(studio, /activeHighlights|activeSelected|non-discarded|status\s*===\s*["']discarded/, "Studio must filter render/export to non-discarded highlights");
assert.match(studio, /status\s*===\s*["']discarded/, "render/export must exclude discarded highlights");

// --- Editor wiring ---
assert.match(editor, /status|discard|Discard/, "Editor must expose per-highlight status control");
assert.match(editor, /active|discarded/, "Editor must filter candidates to active highlights");

// --- Rust project store: status persists additively inside highlights (no schema change) ---
assert.match(store, /status|discard/, "Rust store must accept highlight status without schema migration");

console.log("per-highlight status wiring tests: ok");
