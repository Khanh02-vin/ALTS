# Local-first AI Video Studio

Desktop app that turns a long video into a short, vertical clip **without uploading
the media anywhere**. Import a local file (or a YouTube/Facebook/TikTok link),
transcribe it, pick highlights, edit the cut, render an MP4 — all on the machine.

```text
Svelte UI → Tauri commands → SQLite / filesystem
  → captions or local Whisper → highlight analysis
  → Rust render engine → FFmpeg → MP4 9:16
```

## Requirements

| Component | Version | Notes |
|---|---|---|
| Node.js | ≥ 22 | CI uses 24 |
| Rust | stable | needed for the desktop shell **and** the render tests |
| Tauri prerequisites | — | Linux: `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` |
| FFmpeg / ffprobe | — | bundled into the app by `scripts/fetch-bundled-assets.sh` |
| Python 3 + venv | optional | only for the Python Whisper engine; the default engine is whisper.cpp |

## Quick start

```bash
# 1. Frontend (two builds: static for the app, node for the RAG sidecar)
cd apps/web && npm ci && npm run build && npm run build:node && cd ../..

# 2. Bundled binaries/weights (git-ignored; downloads node/ffmpeg/whisper)
bash scripts/fetch-bundled-assets.sh

# 3. Run the desktop app
cd apps/desktop && npm ci && npm run tauri dev
```

`LIGHTWEIGHT=1 bash scripts/fetch-bundled-assets.sh` creates only the paths that
`tauri-build` validates, which is what CI uses.

## Testing

```bash
npm test          # ~47 suites; `pretest` builds the lfai-render CLI first
npm run test:scoring        # run one suite without building the engine
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run check --prefix apps/web      # svelte-check
```

`npm test` runs `scripts/ensure-render-engine.sh` first: the render suites drive
the Rust engine through `target/debug/lfai-render`, so a stale binary would test
old renderer code. CI does the same build step explicitly.

## CLI helpers

```bash
node --experimental-strip-types scripts/run-local-demo.ts <input.mp4> [out.mp4]
node --experimental-strip-types scripts/analyze-video.ts <input.mp4>
node --experimental-strip-types scripts/local-render.ts <input.mp4> <out.mp4>
```

## Configuration

There is no `.env` file. Settings live in `runtime.env` under the app state
directory (`LOCAL_FIRST_STATE_DIR` overrides everything), written by the Settings
UI and by `scripts/setup-machine.sh`. The environment variables that matter:

| Group | Variables |
|---|---|
| State | `LOCAL_FIRST_STATE_DIR`, `LOCAL_FIRST_CACHE_DIR`, `LOCAL_FIRST_VENV` |
| Transcription | `WHISPER_ENGINE` (`cpp` default, `python`, `openai-audio`), `WHISPER_MODEL`, `WHISPER_MODEL_PATH`, `WHISPER_COMMAND`, `WHISPER_CHUNK_SECONDS`, `WHISPER_OVERLAP_SECONDS` |
| Media | `FFMPEG_PATH`, `FFPROBE_PATH`, `FFMPEG_COMMAND`, `LF_AI_RENDER_BIN` |
| AI providers (BYOK) | `HIGHLIGHT_STRATEGY`, `ACTIVE_PROVIDER_*`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL` |
| Cloud STT (BYOK) | `STT_REMOTE_BASE_URL`, `STT_API_KEY`, `STT_REMOTE_MODEL` |

Credentials are only handed to the analysis worker, never to `curl`/`yt-dlp`
helpers (see `helper_env` vs `analysis_helper_env` in `apps/desktop/src-tauri/src/paths.rs`).

## Layout

```text
apps/web                    SvelteKit UI (static build + node-adapter RAG sidecar)
apps/desktop/src-tauri      Tauri shell, app commands, Rust crates
  crates/render-engine      the one final renderer (ADR-002)
  crates/lfai-render        CLI used by tests and the Node adapter
  crates/ai-engine          ONNX face/VAD/OCR
packages/contracts          shared TS contracts (partly generated from Rust)
packages/editor-core        RenderPlan editing
packages/media-engine       probe / reframe / validation
services/ai-pipeline        transcription, highlight selection, scoring
adapters/local              Whisper, job store, analysis store, engine client
scripts/                    setup, asset fetch, CLI helpers
docs/decisions/             ADR-001 … ADR-009
```

## Further reading

- [`PLAN.md`](PLAN.md) — MVP scope and deferred work
- [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) — what is actually implemented, and the limits of the verification
- [`docs/backlog.md`](docs/backlog.md), [`docs/user-stories.md`](docs/user-stories.md), [`docs/kpi.md`](docs/kpi.md)
- [`docs/decisions/`](docs/decisions/) — architecture decision records
- [`docs/local-llm.md`](docs/local-llm.md) — optional offline LLM setup
- [`docs/codesigning-runbook.md`](docs/codesigning-runbook.md) — release signing

## Licence and redistribution

FFmpeg and model weights have their own licences; review them before bundling.
Local licence signing keys (`keys/`) are git-ignored and must never be committed.
