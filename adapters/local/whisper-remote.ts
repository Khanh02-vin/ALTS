import { readFile } from "node:fs/promises";
import type { Transcript, TranscriptSegment, Word } from "../../packages/contracts/transcript.ts";
import { validateTranscript } from "../../packages/contracts/transcript.ts";

/// Cloud STT for any OpenAI-audio-compatible endpoint (Groq `whisper-large-v3-turbo`
/// is the intended default). BYOK: the endpoint and key come from the app's
/// settings, flattened into the worker env as STT_REMOTE_BASE_URL / STT_API_KEY /
/// STT_REMOTE_MODEL. Every failure carries the REMOTE_STT_FAILED marker so the
/// worker can fall back to the local whisper.cpp engine without masking the cause.

export const REMOTE_STT_FAILED = "REMOTE_STT_FAILED";
export const REMOTE_STT_DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
export const REMOTE_STT_DEFAULT_MODEL = "whisper-large-v3-turbo";

export type RemoteSttOptions = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  language?: string;
  timeoutMs?: number;
  shouldAbort?: () => boolean;
};

function remoteSettings(options: RemoteSttOptions) {
  const apiKey = options.apiKey ?? process.env.STT_API_KEY ?? "";
  if (!apiKey.trim()) throw new Error(`${REMOTE_STT_FAILED}: no API key configured`);
  return {
    apiKey: apiKey.trim(),
    baseUrl: (options.baseUrl ?? process.env.STT_REMOTE_BASE_URL ?? REMOTE_STT_DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: options.model ?? process.env.STT_REMOTE_MODEL ?? REMOTE_STT_DEFAULT_MODEL,
  };
}

export type RemoteSttResult = { language: string; segments: Array<{ start: number; end: number; text: string }> };

export async function transcribeWavWithRemoteStt(wavPath: string, options: RemoteSttOptions = {}): Promise<RemoteSttResult> {
  const { apiKey, baseUrl, model } = remoteSettings(options);
  const bytes = await readFile(wavPath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/wav" }), wavPath.split(/[\\/]/).pop() ?? "chunk.wav");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  const language = options.language ?? process.env.WHISPER_LANGUAGE ?? "";
  if (language && language !== "und") form.append("language", language);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(options.timeoutMs ?? 240_000),
    });
  } catch (error) {
    throw new Error(`${REMOTE_STT_FAILED}:${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`${REMOTE_STT_FAILED}:${response.status} ${detail.error?.message ?? response.statusText}`);
  }
  const payload = (await response.json()) as { language?: string; duration?: number; segments?: Array<{ start: number; end: number; text: string }> };
  const segments = (payload.segments ?? [])
    .map((segment) => ({ start: Number(segment.start), end: Number(segment.end), text: String(segment.text ?? "") }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text.trim());
  if (!segments.length) throw new Error(`${REMOTE_STT_FAILED}: endpoint returned no segments`);
  return { language: payload.language?.trim() || "und", segments };
}

/// Chunk-level surface matching transcribeWithWhisperCpp: returns a Transcript
/// whose timestamps are already offset into source time, so the chunk merger
/// in chunked-whisper.ts can consume it unchanged.
export async function transcribeWithRemoteStt(
  wavPath: string,
  sourceArtifactId: string,
  duration: number,
  options: RemoteSttOptions & { timestampOffset?: number; idPrefix?: string } = {},
): Promise<Transcript> {
  const result = await transcribeWavWithRemoteStt(wavPath, options);
  const offset = options.timestampOffset ?? 0;
  const words: Word[] = [];
  const segments: TranscriptSegment[] = [];
  for (const [index, segment] of result.segments.entries()) {
    const start = Math.max(0, offset + segment.start);
    const end = offset + segment.end;
    if (end <= start) continue;
    const tokens = segment.text.replace(/\s+/g, " ").trim().split(" ");
    const totalChars = tokens.reduce((sum, token) => sum + token.length, 0) || 1;
    const wordIds: string[] = [];
    let at = start;
    for (const [tokenIndex, token] of tokens.entries()) {
      const wordEnd = tokenIndex === tokens.length - 1 ? end : at + (end - start) * (token.length / totalChars);
      if (wordEnd <= at) continue;
      const id = `${options.idPrefix ?? ""}w${index}-${tokenIndex}`;
      words.push({ id, text: token, start: at, end: wordEnd });
      wordIds.push(id);
      at = wordEnd;
    }
    if (!wordIds.length) continue;
    segments.push({ id: `${options.idPrefix ?? ""}s${index}`, text: tokens.join(" "), start, end, wordIds });
  }
  const transcript: Transcript = {
    version: 1,
    sourceArtifactId,
    language: result.language === "und" ? (options.language ?? "und") : result.language,
    duration,
    words,
    segments,
    provider: `remote-stt:${remoteSettings(options).model}`,
  };
  validateTranscript(transcript);
  return transcript;
}
