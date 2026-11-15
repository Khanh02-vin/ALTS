import type { Transcript } from "../../packages/contracts/transcript.ts";
import { transcriptFromCaptions } from "./youtube-transcript.ts";

/// Subtitle-first transcription: when a source already carries timed cues
/// (yt-dlp auto-subs for a link, an embedded SRT/ASS track in a local file),
/// parsing them replaces a full Whisper pass — 0% compute for the same text.

export type SubtitleCue = { start: number; end: number; text: string };

function parseTimestamp(raw: string): number {
  const value = raw.trim().replace(",", ".");
  const parts = value.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return NaN;
}

/// Parses SRT and WebVTT cues: timestamp lines, NOTE/STYLE blocks and inline
/// tags (<c>, </c>, <MM:SS.mmm>) are handled; multiline cue text is joined.
export function parseSrtVtt(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  const timing = /^(\d{1,3}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->?\s*(\d{1,3}:\d{2}(?::\d{2})?[.,]\d{1,3})/;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const match = line.match(timing);
    if (!match) { index += 1; continue; }
    index += 1;
    const cueLines: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() && !timing.test(lines[index] ?? "")) {
      cueLines.push((lines[index] ?? "").replace(/<[^>]*>/g, "").replace(/\{[^}]*\}/g, ""));
      index += 1;
    }
    const start = parseTimestamp(match[1] ?? "");
    const end = parseTimestamp(match[2] ?? "");
    const cueText = cueLines.join(" ").replace(/\s+/g, " ").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !cueText) continue;
    cues.push({ start, end, text: cueText });
  }
  return cues;
}

/// Builds a contract-valid Transcript from cues — the same word-synthesis the
/// YouTube captions path uses (proportional word timings inside each cue).
export function transcriptFromSubtitles(
  sourceArtifactId: string,
  duration: number,
  language: string,
  cues: SubtitleCue[],
  provider: string,
): Transcript {
  const transcript = transcriptFromCaptions({ videoId: sourceArtifactId, language, duration, segments: cues });
  transcript.provider = provider;
  return transcript;
}

/// Chooses one absolute ffmpeg stream index from ffprobe's `-show_streams`
/// output: a subtitle stream whose language tag matches `preferred` wins,
/// otherwise the first subtitle stream. No subtitle stream → undefined.
export function pickSubtitleTrack(
  streams: Array<{ index: number; codecType?: string; language?: string }>,
  preferred?: string,
): number | undefined {
  const wanted = preferred?.trim().toLowerCase();
  const subtitleStreams = streams.filter((stream) => stream.codecType === "subtitle");
  if (wanted) {
    const match = subtitleStreams.find((stream) => stream.language?.toLowerCase().startsWith(wanted));
    if (match) return match.index;
  }
  return subtitleStreams[0]?.index;
}
