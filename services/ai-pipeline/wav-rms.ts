export type Pcm16WavRmsWindow = {
  start: number;
  end: number;
  rms: number;
};

export type Pcm16WavRms = {
  sampleRate: 16_000;
  channels: 1;
  bitsPerSample: 16;
  duration: number;
  windows: Pcm16WavRmsWindow[];
  query(start: number, end: number): number;
};

export type Pcm16WavRmsOptions = {
  /** Window duration in milliseconds. The default is 100 ms. */
  windowMs?: number;
};

const REQUIRED_SAMPLE_RATE = 16_000;
const REQUIRED_CHANNELS = 1;
const REQUIRED_BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = 2;
const DEFAULT_WINDOW_MS = 100;

/** Parse an extracted mono 16 kHz PCM16 RIFF/WAVE buffer into time-indexed RMS. */
export function parsePcm16WavRms(input: Uint8Array, options: Pcm16WavRmsOptions = {}): Pcm16WavRms {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const readId = (offset: number) => String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3),
  );
  const invalid = (message: string): never => { throw new Error(`Invalid PCM16 WAV: ${message}`); };

  if (input.byteLength < 12 || readId(0) !== "RIFF" || readId(8) !== "WAVE") {
    invalid("expected a RIFF/WAVE header");
  }
  const riffEnd = 8 + view.getUint32(4, true);
  if (riffEnd < 12 || riffEnd > input.byteLength) invalid("RIFF size exceeds available data");

  let format: { channels: number; sampleRate: number; byteRate: number; blockAlign: number; bitsPerSample: number } | undefined;
  let pcmOffset: number | undefined;
  let pcmLength: number | undefined;
  for (let offset = 12; offset < riffEnd;) {
    if (riffEnd - offset < 8) invalid("truncated chunk header");
    const id = readId(offset);
    const size = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + size;
    const paddedEnd = dataEnd + (size % 2);
    if (dataEnd > riffEnd || paddedEnd > riffEnd) invalid(`truncated ${id} chunk`);

    if (id === "fmt ") {
      if (format) invalid("duplicate fmt chunk");
      if (size < 16) invalid("fmt chunk is shorter than the PCM format header");
      const audioFormat = view.getUint16(dataOffset, true);
      const channels = view.getUint16(dataOffset + 2, true);
      const sampleRate = view.getUint32(dataOffset + 4, true);
      const byteRate = view.getUint32(dataOffset + 8, true);
      const blockAlign = view.getUint16(dataOffset + 12, true);
      const bitsPerSample = view.getUint16(dataOffset + 14, true);
      if (audioFormat !== 1) invalid("only integer PCM encoding is supported");
      if (channels !== REQUIRED_CHANNELS) invalid(`expected ${REQUIRED_CHANNELS} channel`);
      if (sampleRate !== REQUIRED_SAMPLE_RATE) invalid(`expected ${REQUIRED_SAMPLE_RATE} Hz sample rate`);
      if (bitsPerSample !== REQUIRED_BITS_PER_SAMPLE) invalid(`expected ${REQUIRED_BITS_PER_SAMPLE}-bit samples`);
      if (blockAlign !== BYTES_PER_SAMPLE) invalid("inconsistent block alignment");
      if (byteRate !== sampleRate * blockAlign) invalid("inconsistent byte rate");
      format = { channels, sampleRate, byteRate, blockAlign, bitsPerSample };
    } else if (id === "data") {
      if (pcmOffset !== undefined) invalid("duplicate data chunk");
      pcmOffset = dataOffset;
      pcmLength = size;
    }
    offset = paddedEnd;
  }

  if (!format) invalid("missing fmt chunk");
  if (pcmOffset === undefined || pcmLength === undefined) invalid("missing data chunk");
  if (pcmLength % BYTES_PER_SAMPLE !== 0) invalid("data chunk ends with an incomplete sample");

  const sampleCount = pcmLength / BYTES_PER_SAMPLE;
  const duration = sampleCount / format.sampleRate;
  const squares = new Float64Array(sampleCount);
  const prefixSquares = new Float64Array(sampleCount + 1);
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = view.getInt16(pcmOffset + i * BYTES_PER_SAMPLE, true) / 32_768;
    const square = sample * sample;
    squares[i] = square;
    prefixSquares[i + 1] = prefixSquares[i]! + square;
  }

  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError("windowMs must be a finite number greater than zero");
  const samplesPerWindow = Math.max(1, Math.round(windowMs * format.sampleRate / 1000));
  if (!Number.isSafeInteger(samplesPerWindow)) throw new RangeError("windowMs is too large");

  const integralAt = (samplePosition: number): number => {
    const wholeSamples = Math.floor(samplePosition);
    const fractionalSample = samplePosition - wholeSamples;
    return prefixSquares[wholeSamples]! + (wholeSamples < sampleCount ? fractionalSample * squares[wholeSamples]! : 0);
  };
  const query = (start: number, end: number): number => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > duration) {
      throw new RangeError(`query interval must satisfy 0 <= start <= end <= ${duration}`);
    }
    if (start === end) return 0;
    const startSample = start * format.sampleRate;
    const endSample = end * format.sampleRate;
    const meanSquare = (integralAt(endSample) - integralAt(startSample)) / (endSample - startSample);
    return Math.sqrt(Math.max(0, meanSquare));
  };

  const windows: Pcm16WavRmsWindow[] = [];
  for (let firstSample = 0; firstSample < sampleCount; firstSample += samplesPerWindow) {
    const lastSample = Math.min(sampleCount, firstSample + samplesPerWindow);
    const start = firstSample / format.sampleRate;
    const end = lastSample / format.sampleRate;
    windows.push({ start, end, rms: query(start, end) });
  }

  return { sampleRate: REQUIRED_SAMPLE_RATE, channels: REQUIRED_CHANNELS, bitsPerSample: REQUIRED_BITS_PER_SAMPLE, duration, windows, query };
}
