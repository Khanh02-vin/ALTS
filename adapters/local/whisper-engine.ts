import { basename } from "node:path";

/**
 * Resolves the executable for the selected transcription engine without allowing
 * a legacy Python runtime.env value to leak into the CPP CLI contract.
 */
export function resolveWhisperCommand(
  engine: "cpp" | "python",
  rawCommand: string | undefined,
  fallbackCpp = "whisper-cli",
): string | undefined {
  if (engine === "python") return rawCommand;
  const command = rawCommand?.trim();
  if (!command) return fallbackCpp;
  const legacyPython = command.includes(".venv") || command.includes("python") || /(^|[\\/])whisper(?:\.exe)?$/i.test(basename(command));
  const legacyPt = command.toLowerCase().endsWith(".pt");
  return legacyPython || legacyPt ? fallbackCpp : command;
}

/** Resolves the model path for CPP and rejects a legacy PyTorch .pt path. */
export function resolveWhisperModelPath(
  engine: "cpp" | "python",
  rawPath: string | undefined,
  fallbackCpp = "",
): string | undefined {
  if (engine === "python") return rawPath;
  const path = rawPath?.trim();
  if (!path || path.toLowerCase().endsWith(".pt")) return fallbackCpp;
  return path;
}

/// Resolves the transcription engine from a runtime.env / settings value.
/// "openai-audio" selects the BYOK cloud STT endpoint; anything else that is
/// not "python" falls back to the bundled whisper.cpp CLI.
export function resolveWhisperEngine(raw: string | undefined, fallback: "python" | "cpp" | "openai-audio" = "cpp"): "python" | "cpp" | "openai-audio" {
  const value = raw?.trim();
  if (value === "python" || value === "openai-audio") return value;
  return fallback;
}
