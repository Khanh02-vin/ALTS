/** Parse timestamps emitted by FFmpeg's scdet metadata filter. */
export function parseSceneCutMetadata(metadata: string, duration: number, threshold = 20): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(threshold)) return [];
  const cuts = new Set<number>();
  for (const block of metadata.split(/(?=frame:\s*\d+)/)) {
    const timeMatch = /lavfi\.scd\.time=(-?\d+(?:\.\d+)?)/.exec(block);
    const scoreMatch = /lavfi\.scd\.score=(-?\d+(?:\.\d+)?)/.exec(block);
    if (!timeMatch || !scoreMatch || Number(scoreMatch[1]) < threshold) continue;
    const time = Number(timeMatch[1]);
    if (Number.isFinite(time) && time > 0 && time < duration) cuts.add(time);
  }
  return [...cuts].sort((a, b) => a - b);
}
