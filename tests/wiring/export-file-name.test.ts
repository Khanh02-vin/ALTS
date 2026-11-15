import assert from "node:assert/strict";
import { exportFileName } from "../../apps/web/src/lib/export-file-name.ts";

assert.equal(exportFileName("Cảnh đẹp nhất", "short"), "Cảnh_đẹp_nhất.mp4");
assert.equal(exportFileName("Hanoi / street food: 12", "short"), "Hanoi_street_food_12.mp4");
assert.equal(exportFileName("", "short"), "short.mp4");
assert.equal(exportFileName("///", "variant"), "variant.mp4");
assert.equal(exportFileName("clip#1", "short"), "clip_1.mp4");
console.log("export file name tests: ok");
