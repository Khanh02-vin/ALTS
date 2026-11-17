import { spawnSync } from "node:child_process";

export function assertAudioTrack(path: string): void {
  const probe = spawnSync(
    process.env.FFPROBE_PATH ?? "ffprobe",
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", path],
    {
      encoding: "utf8",
      // A hung ffprobe (stalled network path, corrupt container) used to block the
      // analysis worker forever — the user's cancel button cannot reach a synchronous
      // wait. Bound it, and cap the buffer because the output is a single index.
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (probe.error) {
    if ((probe.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new Error("AUDIO_PROBE_TIMEOUT: ffprobe did not answer within 30s");
    }
    throw new Error(`AUDIO_PROBE_SPAWN: ${probe.error.message}`);
  }
  if (probe.status !== 0) throw new Error(`AUDIO_PROBE_FAILED: ${probe.stderr.trim() || `ffprobe exited with ${probe.status ?? "unknown status"}`}`);
  if (!probe.stdout.trim()) throw new Error("NO_AUDIO_TRACK: this video has no audio, so there is nothing to transcribe");
}
