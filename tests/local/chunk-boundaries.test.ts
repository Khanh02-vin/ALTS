/// Verifies the silence-aligned cut planner for long remote audio: cuts land near
/// a quiet RMS window when one exists, and fall back to the nominal multiple when
/// the audio never gets quiet (or the quiet stretch is too far from the cut).
///
/// Run: node --experimental-strip-types tests/local/chunk-boundaries.test.ts
import { strict as assert } from "node:assert/strict";
import { planChunkBoundaries } from "../../adapters/local/chunked-whisper.ts";

/// One window per second, with rms chosen per second index.
const windows = (rms: (second: number) => number, seconds: number) =>
  Array.from({ length: seconds }, (_, second) => ({ start: second, end: second + 1, rms: rms(second) }));

// No audio features at all: plain multiples of the chunk size.
assert.deepEqual(planChunkBoundaries(1800, 600), [600, 1200]);
assert.deepEqual(planChunkBoundaries(500, 600), []);
assert.deepEqual(planChunkBoundaries(1200, 600), [600]);

// A quiet dip inside the search window pulls the cut back to it.
const dip = windows((second) => (second >= 560 && second < 561 ? 0.004 : 0.25), 1800);
assert.deepEqual(planChunkBoundaries(1800, 600, dip), [560, 1200]);

// Continuous loud audio keeps the nominal cut — never cut mid-word for no reason.
const loud = windows(() => 0.3, 1800);
assert.deepEqual(planChunkBoundaries(1800, 600, loud), [600, 1200]);

// A quiet stretch further than the search window back is not worth a shorter chunk.
const farDip = windows((second) => (second >= 400 && second < 401 ? 0.004 : 0.25), 1800);
assert.deepEqual(planChunkBoundaries(1800, 600, farDip), [600, 1200]);

// Cuts must stay inside the audio and keep the ordering.
const edge = windows((second) => (second >= 599 && second < 600 ? 0.001 : 0.2), 1800);
assert.deepEqual(planChunkBoundaries(1800, 600, edge), [599, 1200]);

console.log("chunk-boundaries: ok");
