# Implementation status — v0.1.4

Updated: 2026-11-10. Scope: local working tree on `release/v0.1.4`, including uncommitted changes. These results do not certify a published installer or a clean machine.

## Local-first MVP decision

The production path is desktop/local:

```text
Svelte UI → Tauri commands → SQLite/filesystem
  → captions or local Whisper → highlight analysis → Rust render engine → FFmpeg → MP4
```

- The desktop UI uses the static SvelteKit build. The RAG sidecar uses the separate Node-adapter build; the webview calls it through `tauri-plugin-http`.
- RAG and llama sidecars use runtime-selected loopback ports and session authentication. Do not assume the historical fixed RAG port 4733. The YouTube preview shim has its own fixed-port/CSP constraint.
- Durable project/configuration data and regenerable caches use separate OS directories; test overrides can supply isolated roots.
- The desktop and `lfai-render` CLI share the Rust render engine. Node tests invoke a separately built CLI executable, not the desktop test binary.
- Progress uses commands, IPC channels and polling. There is no new general-purpose event bus.

## Implemented in the current working tree

### Input and analysis

- Local media import, metadata validation, persistent analysis jobs, retry/cancel/recovery and chunked local transcription.
- YouTube captions-first analysis with audio fallback. Supported public Facebook/TikTok URLs route through yt-dlp audio extraction and local Whisper.
- Analysis range cap: 1800 seconds. Long remote audio uses chunk boundaries informed by measured RMS windows when available.
- Settings can select an allowlisted browser for yt-dlp `--cookies-from-browser`; arbitrary profile/path/flag values are rejected.
- Heuristic/content highlight selection is available offline. Semantic providers are optional; provider failure can fall back to deterministic selection.
- `services/ai-pipeline/highlight-scoring.ts`: Hook/Summary/Impact axes, dominant-axis metadata and audio-aware scoring. Missing audio measurements are distinguished from measured silence.
- `services/ai-pipeline/wav-rms.ts`: PCM16 WAV RMS measurements.
- `services/ai-pipeline/pause-snap.ts`: clip-edge snapping using transcript word gaps and punctuation, with bounded movement. This is not Silero-based clip-edge trimming.
- `services/ai-pipeline/script-outline.ts`: script outline, highlight association and summary variants, wired into analysis enrichment.
- Semantic result caching and windowed processing for longer transcripts.

### Review, preview and rendering

- Candidate selection/discard state and project persistence; editor trim/crop/caption controls.
- Dominant-axis labels use a VI/EN mapping based on transcript language, not fixed marketing phrases such as “Tóm tắt chuẩn nhất”.
- Local preview can transcode a browser-compatible proxy per source. It is not a metadata-only operation or a final render per candidate.
- Preview cache cleanup is best-effort, oldest-modified-first, with a 5 GiB cap on published MP4 files. In-flight `*.tmp.mp4` files are excluded from both accounting and eviction. Cache hits do not refresh mtime, so this is not strict access-based LRU.
- Discarding the last active candidate requests deletion of the shared source proxy. Deletion failure must not prevent discard; this is not a guarantee that all temporary files are immediately removed.
- Render plans support the subtitle-burn toggle and selected ranges. Final output uses the shared Rust renderer.
- Crop tracking includes deadzone/smoothing and confirmed speaker/face mappings. Scene-layout proposals require user review; blur is a fill mode, not proof of slide/chart classification.

## Verification on this machine — 2026-11-10

Environment: Linux x64, Node.js v24.21.0, existing development dependencies/resources. Commands were run in this checkout, not against a downloaded installer.

| Check | Observed result |
|---|---|
| Quota regression before fix | Failed: in-flight temporary MP4 was deleted |
| Focused Rust preview tests after fix | 5 passed, 0 failed |
| Desktop `cargo test` | 76 passed, 0 failed, 19.78 s |
| `cargo build -p lfai-render` then `npm test` | Passed, including real MP4 render tests |
| Newly included npm suites | `test:wav-rms`, `test:script-outline`, `test:highlight-status` all passed through `npm test` |
| Command wiring | 54 UI invocations registered |
| `npm run check --prefix apps/web` | 0 errors, 0 warnings |
| `npm run build --prefix apps/web` | Passed; emitted layout warning about missing `<slot />` / `{@render ...}` |

The initial `npm test` failed in FFmpeg argument parsing because the existing debug CLI was stale. Rebuilding the CLI from current source, as CI does, resolved it without changing renderer source.

Rust reported four unused-import warnings. A formatting check initially flagged the new test assertion; that formatting was corrected. Final `cargo fmt --check` and `git diff --check` both passed (exit code 0) after the code and documentation changes.

The Rust total remains 76: the duplicate `#[test]` on the quota test was removed and the missing `#[test]` on the cache-key test was added. The total is not evidence that those two issues were absent.

### Highlight evaluation from this run

Dataset: 8 cases, 10 expected highlights, IoU threshold 0.3.

| Evaluation row | Mean IoU | Hit@5 |
|---|---:|---:|
| Heuristic | 0.56 | 63% |
| Content | 0.39 | 63% |
| Semantic oracle (mock) | 1.00 | 100% |
| Semantic oracle with jitter (mock) | 0.82 | 100% |
| Axis blends 4/3/3, 3/4/3, 3/3/4 over the same candidate set | 0.69 | 88% |

Oracle rows test the evaluation machinery, not a real model. Blend results do not establish an end-to-end production quality guarantee. `vlog-rambling` remains a zero-IoU case in the reported blend rows.

Live Gemini evaluation was skipped because `GEMINI_API_KEY` was not set. Live local-model evaluation was skipped because no llama-server answered at the evaluation endpoint. No fresh manual GUI session, live Facebook/TikTok download, clean-machine test, installer/signing check or Windows/macOS test was performed in this verification pass.

### Reproduce the checks

Run from the repository root:

```bash
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml -p lfai-render
npm test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
npm run check --prefix apps/web
npm run build --prefix apps/web
git diff --check
```

The CLI build is a prerequisite: `npm test` does not rebuild an existing `target/debug/lfai-render`. Both CI and release test jobs build it first.

## Deferred until measured demand

Consistent with `docs/backlog.md` and the local-first scope:

- PostgreSQL, Redis/BullMQ, S3/R2 and cloud workers.
- Hosted-user JWT/session/tenant isolation and network rate limiting. Local path validation, secret handling and sidecar authentication remain required now.
- CE.SDK: only revisit if the native editor demonstrably fails user requirements.
- Managed non-BYOK Gemini/OpenAI services.
- OAuth/social publishing, billing and team workspace.

## Known limits and release evidence

- Most Replayed/comments signals, lip-movement detection and automatic slide/chart classification are not implemented. An event-bus rewrite is not part of this work.
- Silero VAD is used in diarization; clip boundaries use transcript timing heuristics.
- Facebook/TikTok availability depends on upstream access restrictions and yt-dlp; there is no equivalent in-app YouTube embed for those sources.
- Best-effort preview quota does not bound temporary files during active transcodes or guarantee deletion when the OS denies it.
- Passing the local checks is not evidence of live-provider quality or installer readiness. Historical v0.1.0 run IDs, download sizes and signing claims must not be reused as v0.1.4 provenance.
- `release/linux-pilot-validation.md` remains historical v0.1.0 evidence until its checklist is rerun against a specific new artifact. No release was published by this maintenance pass.
