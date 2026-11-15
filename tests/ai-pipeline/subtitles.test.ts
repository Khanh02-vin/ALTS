/// Subtitle-first transcription:
/// - SRT/WebVTT cue parsing (tags stripped, NOTE blocks skipped, multiline joined)
/// - cue → Transcript conversion that satisfies the transcript contract
///   (words synthesized proportionally, ordered, non-overlapping)
/// - embedded subtitle track chooser prefers the configured language
///
/// Run: node --experimental-strip-types tests/ai-pipeline/subtitles.test.ts
import { strict as assert } from "node:assert/strict";
import { parseSrtVtt, transcriptFromSubtitles, pickSubtitleTrack } from "../../services/ai-pipeline/subtitles.ts";

const srt = `1
00:00:01,000 --> 00:00:03,500
Xin chào <c>tất cả</c> mọi người.

2
00:00:04,000 --> 00:00:06,000
Câu thứ hai
nhiều dòng.
`;

const vtt = `WEBVTT

NOTE this is a comment block
that spans lines.

00:01.000 --> 00:03.500 align:start line:0%
Xin chào tất cả mọi người.

00:00:04.000 --> 00:00:06.000
Câu thứ hai.
`;

for (const [label, cues] of [["srt", parseSrtVtt(srt)], ["vtt", parseSrtVtt(vtt)]] as const) {
  assert.equal(cues.length, 2, `${label}: two cues`);
  assert.equal(cues[0].start, 1, `${label}: first cue start`);
  assert.equal(cues[0].end, 3.5, `${label}: first cue end`);
  assert.equal(cues[0].text, "Xin chào tất cả mọi người.", `${label}: tags stripped and multiline joined`);
  assert.equal(cues[1].start, 4, `${label}: second cue start`);
}

const transcript = transcriptFromSubtitles("art-1", 8, "vi", parseSrtVtt(srt), "embedded-subs");
assert.equal(transcript.provider, "embedded-subs");
assert.equal(transcript.language, "vi");
assert.ok(transcript.words.length >= 6, "cues must synthesize word timings");
assert.ok(transcript.segments[0].wordIds.length > 0, "segments reference their words");
for (const word of transcript.words) {
  assert.ok(word.end > word.start, `word must span time: ${word.text}`);
  assert.ok(word.end <= 8, "words stay inside the media duration");
}

// Track chooser: language preference, then the first subtitle stream.
const streams = [
  { index: 0, codecType: "video" },
  { index: 1, codecType: "audio" },
  { index: 2, codecType: "subtitle", language: "eng" },
  { index: 3, codecType: "subtitle", language: "vie" },
];
assert.equal(pickSubtitleTrack(streams, "vi"), 3, "preferred language wins");
assert.equal(pickSubtitleTrack(streams, "en"), 2, "falls back to any subtitle track");
assert.equal(pickSubtitleTrack(streams.slice(0, 2), "vi"), undefined, "no subtitle stream → undefined");

console.log("subtitle-first tests: ok");
