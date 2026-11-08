/// The render engine is the single final renderer (ADR-002), so this test pins the
/// property that makes that claim true: the Node client and the desktop app go through
/// the same engine, and the engine's output is a real, playable MP4.
///
/// Before ADR-002 the Node side had its own FFmpeg argument builder (adapters/ffmpeg),
/// which silently drifted from the app's renderer — it could not render captions, hooks
/// or crop keyframes. These assertions are the guard against that coming back.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { probe, render, resolveEnginePath } from "../../adapters/local/engine.ts";
const execFile = promisify(execFileCb);
const root = await mkdtemp(join(tmpdir(), "lfai-engine-"));
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
const enginePath = resolveEnginePath();

/// Mean x position (0..1 of width) of the red subject box in one decoded frame, or
/// null when the box was cropped away entirely. Reading raw rgb24 needs no image
/// dependency, and the synthetic inputs below keep the boxes perfectly stationary.
async function subjectCentreX(file: string): Promise<number | null> {
  const { stdout } = await execFile(ffmpeg, [
    "-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { maxBuffer: 64 * 1024 * 1024, encoding: "buffer" }) as { stdout: Buffer };
  const frame = JSON.parse(
    (await execFile(ffprobe, ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", file])).stdout,
  ) as { streams: Array<{ width: number; height: number }> };
  const { width, height } = frame.streams[0];
  const stride = width * 3;
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const at = y * stride + x * 3;
      // The subject box is the only saturated red area; the tag is white, the blur is grey.
      if (stdout[at] > 120 && stdout[at + 1] < 80 && stdout[at + 2] < 80) {
        sum += x;
        count += 1;
      }
    }
  }
  return count > 0 ? sum / count / width : null;
}

try {
  const input = join(root, "input.mp4");
  await execFile(ffmpeg, [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=10:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=6",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    input,
  ]);

  // The engine reads the same ffprobe metadata the app's probe_video command returns.
  const metadata = await probe(input, { enginePath, ffprobePath: ffprobe });
  assert.ok(metadata.streams?.some((stream) => stream.codec_type === "video"), "probe must report a video stream");
  assert.ok(metadata.streams?.some((stream) => stream.codec_type === "audio"), "probe must report an audio stream");
  assert.ok(Number(metadata.format?.duration) > 5, "probe must report the container duration");
  assert.equal(metadata.format?.format_name?.includes("mp4"), true, "probe must report the container name");

  // A render through the engine produces a real 9:16 MP4 with audio, not just a file.
  const output = join(root, "output.mp4");
  const progress: number[] = [];
  await render(
    {
      input,
      output,
      plan: {
        version: 1,
        sourceArtifactId: "engine-test",
        ranges: [{ start: 0.5, end: 3.5 }],
        aspectRatio: "9:16",
      },
    },
    { enginePath, ffmpegPath: ffmpeg, ffprobePath: ffprobe, onProgress: (ratio) => progress.push(ratio) },
  );
  assert.ok((await stat(output)).size > 0, "the engine must write a non-empty output");
  const rendered = JSON.parse(
    (await execFile(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", output])).stdout,
  ) as { format: { duration: string }; streams: Array<{ codec_type: string; width?: number; height?: number }> };
  assert.deepEqual(rendered.streams.map((stream) => stream.codec_type), ["video", "audio"]);
  assert.equal(rendered.streams[0].width, 1080);
  assert.equal(rendered.streams[0].height, 1920);
  assert.ok(Math.abs(Number(rendered.format.duration) - 3) < 0.3, `expected the requested range, got ${rendered.format.duration}`);
  assert.ok(progress.length > 0, "the engine must report progress while rendering");
  assert.equal(progress[progress.length - 1], 1, "the last progress report must be the completed 100%");

  // A composition layout whose text box owns the frame (the containment rule: T contains
  // P) widens the crop window; the engine must keep the portrait canvas by scaling to
  // width and padding vertically — same 1080x1920 output, never a distorted frame.
  const zoomedOutput = join(root, "zoomed.mp4");
  await render(
    {
      input,
      output: zoomedOutput,
      plan: {
        version: 1,
        sourceArtifactId: "engine-test",
        ranges: [{ start: 0.5, end: 3.5 }],
        aspectRatio: "9:16",
        compositionLayouts: [
          {
            start: 0,
            end: 6,
            confidence: 0.9,
            confirmed: true,
            sourceArtifactId: "engine-test",
            personBox: { left: 0.3, right: 0.52, top: 0.1, bottom: 0.9 },
            textBox: { left: 0.02, right: 0.66, top: 0.02, bottom: 0.18 },
          },
        ],
      },
    },
    { enginePath, ffmpegPath: ffmpeg, ffprobePath: ffprobe },
  );
  const zoomed = JSON.parse(
    (await execFile(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=width,height", "-of", "json", zoomedOutput])).stdout,
  ) as { format: { duration: string }; streams: Array<{ width?: number; height?: number }> };
  assert.equal(zoomed.streams[0].width, 1080);
  assert.equal(zoomed.streams[0].height, 1920);
  assert.ok(Math.abs(Number(zoomed.format.duration) - 3) < 0.3, `expected the requested range, got ${zoomed.format.duration}`);

  // The engine refuses to overwrite its own input instead of corrupting the source.
  const sameOutput = join(root, "same.mp4");
  await writeFile(sameOutput, Buffer.alloc(4));
  await assert.rejects(
    render(
      {
        input,
        output: input,
        plan: { version: 1, sourceArtifactId: "engine-test", ranges: [{ start: 0, end: 1 }], aspectRatio: "9:16" },
      },
      { enginePath, ffmpegPath: ffmpeg, ffprobePath: ffprobe },
    ),
    /OUTPUT_MUST_DIFFER_FROM_INPUT/,
  );

  // An invalid plan is rejected before FFmpeg is ever started.
  await assert.rejects(
    render(
      {
        input,
        output: join(root, "never.mp4"),
        plan: { version: 0, sourceArtifactId: "", ranges: [], aspectRatio: "9:16" },
      },
      { enginePath, ffmpegPath: ffmpeg, ffprobePath: ffprobe },
    ),
    /INVALID_RENDER_PLAN/,
  );
  assert.equal(await stat(join(root, "never.mp4")).then(() => true, () => false), false, "a rejected plan must not leave an output behind");

  // A stable synthetic clip: a red subject box at 0.05..0.30 of the width and a white
  // OCR tag at 0.70..0.98. Both boxes are static, so where they land in the output
  // frame is a direct measurement of the crop the engine chose.
  const marked = join(root, "marked.mp4");
  await execFile(ffmpeg, [
    "-y", "-v", "error",
    "-f", "lavfi", "-i",
    "color=c=0x101418:s=640x360:d=6:r=10,drawbox=x=32:y=60:w=160:h=240:color=red:t=fill,drawbox=x=448:y=20:w=180:h=40:color=white:t=fill",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", marked,
  ]);
  const markedPlan = {
    version: 1,
    sourceArtifactId: "engine-test",
    ranges: [{ start: 0.5, end: 3.5 }],
    aspectRatio: "9:16",
    compositionLayouts: [
      {
        start: 0,
        end: 6,
        confidence: 0.9,
        confirmed: true,
        sourceArtifactId: "engine-test",
        personBox: { left: 0.05, right: 0.30, top: 0.1, bottom: 0.9 },
        textBox: { left: 0.70, right: 0.98, top: 0.02, bottom: 0.18 },
      },
    ],
  };

  // Person-first: the tag sits beside the subject, so it must not drag the crop away.
  // The old union rule centred the frame at 0.515 and the subject landed at ~0.15.
  const personFirst = join(root, "person-first.mp4");
  await render(
    { input: marked, output: personFirst, plan: markedPlan },
    { enginePath, ffmpegPath: ffmpeg, ffprobePath: ffprobe },
  );
  assert.ok(Math.abs((await subjectCentreX(personFirst))! - 0.5) < 0.05,
    `person-first composition must keep the subject centred, got ${await subjectCentreX(personFirst)}`);

  // The manual crop path wins: with confirmed keyframes pointing right of the subject,
  // the automatic layout is not applied at all (the subject is cropped out, not re-framed).
  const manualFirst = join(root, "manual-first.mp4");
  await render(
    {
      input: marked,
      output: manualFirst,
      plan: {
        ...markedPlan,
        speakerMap: { A: "face-1" },
        cropKeyframes: [
          { time: 0, centerX: 0.85, centerY: 0.5, speakerId: "A", sourceFaceId: "face-1", confidence: 0.9, confirmed: true, sourceArtifactId: "engine-test" },
        ],
      },
    },
    { enginePath, ffmpegPath: ffmpeg, ffprobePath: ffprobe },
  );
  assert.equal(await subjectCentreX(manualFirst), null,
    "a confirmed manual crop path must override the automatic composition");

  // A partial manual path (one keyframe, covering only part of the range) still wins
  // over the automatic layout instead of being silently dropped.
  const partialManual = join(root, "partial-manual.mp4");
  await render(
    {
      input: marked,
      output: partialManual,
      plan: {
        ...markedPlan,
        cropKeyframes: [
          { time: 0, centerX: 0.5, centerY: 0.5, speakerId: "A", sourceFaceId: "face-1", confidence: 0.6, confirmed: true, sourceArtifactId: "engine-test" },
        ],
      },
    },
    { enginePath, ffmpegPath: ffmpeg, ffprobePath: ffprobe },
  );
  const partialCentre = await subjectCentreX(partialManual);
  assert.ok(partialCentre !== null && Math.abs(partialCentre - 0.5) < 0.06,
    `a partial manual path must be followed, got ${partialCentre}`);

  // An untrusted tracking run (unconfirmed, low confidence) still leaves the automatic
  // composition in charge — it is not a manual crop.
  const tracked = join(root, "tracked.mp4");
  await render(
    {
      input: marked,
      output: tracked,
      plan: {
        ...markedPlan,
        cropKeyframes: [
          { time: 0, centerX: 0.85, centerY: 0.5, speakerId: "A", sourceFaceId: "face-1", confidence: 0.42, confirmed: false, sourceArtifactId: "engine-test" },
        ],
      },
    },
    { enginePath, ffmpegPath: ffmpeg, ffprobePath: ffprobe },
  );
  assert.ok(Math.abs((await subjectCentreX(tracked))! - 0.5) < 0.05,
    "an unconfirmed tracking path must not suppress the automatic composition");

  // Geometry guard: on a source taller than 9:16 the full-bleed window alone is wider
  // than the source, so the window clamps to `iw` and the render still succeeds
  // instead of failing the crop.
  const tall = join(root, "tall.mp4");
  await execFile(ffmpeg, [
    "-y", "-v", "error", "-f", "lavfi", "-i",
    "color=c=0x101418:s=1080x2400:d=2:r=10,drawbox=x=100:y=400:w=200:h=300:color=red:t=fill",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", tall,
  ]);
  const tallOutput = join(root, "tall-out.mp4");
  await render(
    {
      input: tall,
      output: tallOutput,
      plan: {
        version: 1,
        sourceArtifactId: "engine-test",
        ranges: [{ start: 0, end: 1 }],
        aspectRatio: "9:16",
        compositionLayouts: [
          {
            start: 0, end: 2, confidence: 0.9, confirmed: true, sourceArtifactId: "engine-test",
            personBox: { left: 0.09, right: 0.28, top: 0.1, bottom: 0.9 }, frameWidth: 1.0,
          },
        ],
      },
    },
    { enginePath, ffmpegPath: ffmpeg, ffprobePath: ffprobe },
  );
  const tallRendered = JSON.parse(
    (await execFile(ffprobe, ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", tallOutput])).stdout,
  ) as { streams: Array<{ width: number; height: number }> };
  assert.deepEqual([tallRendered.streams[0].width, tallRendered.streams[0].height], [1080, 1920]);
  assert.ok((await subjectCentreX(tallOutput)) !== null, "the subject must survive the tall-source clamp");

  console.log("render engine tests: ok (one renderer, real MP4 output)");
} finally {
  await rm(root, { recursive: true, force: true });
}
