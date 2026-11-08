import assert from "node:assert/strict";
import { parsePcm16WavRms } from "../../services/ai-pipeline/wav-rms.ts";

function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function chunk(id: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id), u32(data.length), data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

type WavOptions = {
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  audioFormat?: number;
  blockAlign?: number;
  byteRate?: number;
  samples?: number[];
  extraChunks?: Buffer[];
};

function makeWav(options: WavOptions = {}): Buffer {
  const channels = options.channels ?? 1;
  const sampleRate = options.sampleRate ?? 16_000;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const blockAlign = options.blockAlign ?? channels * bitsPerSample / 8;
  const byteRate = options.byteRate ?? sampleRate * blockAlign;
  const samples = options.samples ?? [-32_768, 0, 16_384, 32_767];
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2));
  const fmt = Buffer.concat([
    u16(options.audioFormat ?? 1), u16(channels), u32(sampleRate), u32(byteRate), u16(blockAlign), u16(bitsPerSample),
  ]);
  const body = Buffer.concat([...options.extraChunks ?? [], chunk("fmt ", fmt), chunk("data", pcm)]);
  return Buffer.concat([Buffer.from("RIFF"), u32(body.length + 4), Buffer.from("WAVE"), body]);
}

const input = makeWav({ extraChunks: [chunk("JUNK", Buffer.from([1, 2, 3]))] });
const parsed = parsePcm16WavRms(input, { windowMs: 0.125 });
const positiveFullScale = 32_767 / 32_768;

assert.equal(parsed.sampleRate, 16_000);
assert.equal(parsed.channels, 1);
assert.equal(parsed.bitsPerSample, 16);
assert.equal(parsed.duration, 4 / 16_000);
assert.deepEqual(parsed.windows.map(({ start, end }) => [start, end]), [
  [0, 2 / 16_000],
  [2 / 16_000, 4 / 16_000],
]);
assert.ok(Math.abs(parsed.windows[0]!.rms - Math.sqrt(0.5)) < 1e-12);
assert.ok(Math.abs(parsed.windows[1]!.rms - Math.sqrt((0.25 + positiveFullScale ** 2) / 2)) < 1e-12);
assert.ok(Math.abs(parsed.query(0, parsed.duration) - Math.sqrt((1 + 0.25 + positiveFullScale ** 2) / 4)) < 1e-12);
assert.ok(Math.abs(parsed.query(1 / 16_000, 3 / 16_000) - Math.sqrt(0.125)) < 1e-12);
assert.equal(parsed.query(0, 0), 0);
assert.throws(() => parsed.query(-0.01, 0.01), RangeError);
assert.throws(() => parsed.query(0.01, 0), RangeError);
assert.throws(() => parsed.query(0, parsed.duration + 0.01), RangeError);

// The parsed measurements remain stable if a caller later mutates the input.
input.fill(0);
assert.ok(Math.abs(parsed.query(0, parsed.duration) - Math.sqrt((1 + 0.25 + positiveFullScale ** 2) / 4)) < 1e-12);

for (const [label, invalid] of [
  ["not RIFF", Buffer.from("nope")],
  ["wrong form", Buffer.concat([Buffer.from("RIFF"), u32(4), Buffer.from("NOPE")])],
  ["truncated chunk", Buffer.concat([Buffer.from("RIFF"), u32(8), Buffer.from("WAVEfmt ")])],
  ["unsupported encoding", makeWav({ audioFormat: 3 })],
  ["stereo", makeWav({ channels: 2 })],
  ["wrong sample rate", makeWav({ sampleRate: 44_100 })],
  ["unsupported bit depth", makeWav({ bitsPerSample: 8 })],
  ["invalid block alignment", makeWav({ blockAlign: 4 })],
  ["invalid byte rate", makeWav({ byteRate: 1 })],
] as const) {
  assert.throws(() => parsePcm16WavRms(invalid), Error, label);
}

assert.throws(() => parsePcm16WavRms(makeWav(), { windowMs: 0 }), RangeError);
console.log("WAV RMS tests passed");
