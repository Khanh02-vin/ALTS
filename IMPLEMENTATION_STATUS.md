# Implementation status — v0.1.5

Updated: 2026-11-17. Scope: the working tree built into the `v0.1.5` tag. These
results come from this checkout; they do not certify the CI-built installers or a
clean machine.

> **Delta since v0.1.4.** The `v0.1.4` tag points at `8e37279` (2026-11-08) and is
> unchanged; everything below describes v0.1.5. Changes since that tag:
>
> - Transcription default is **whisper.cpp** (`WHISPER_ENGINE` unset ⇒ `cpp`);
>   see the update note in ADR-009. Python remains available opt-in.
> - Highlight selection is a hybrid two-round shortlist with an LLM rerank pass
>   (`hybrid-highlights.ts`), plus rubric-based candidate grading and
>   setup/core/payoff validation. Multi-range jump-cut now uses locally validated
>   sentence ranges.
> - Scoring ranks candidates with RMS and speech-rate and snaps them to detected
>   scene cuts.
> - Cloud STT (BYOK) and subtitle-first transcription are wired.
> - Full-video analysis is the default; the 600 s UI default was removed (the
>   backend still caps one range at 1800 s).
> - Hardening pass on this revision: helper process timeouts, credential scoping
>   for spawned helpers, loopback-only sidecars, constant-time token compare,
>   pinned Python deps, and an `npm audit` step in CI that now audits the real
>   workspace lockfiles instead of failing with ENOLOCK at the repo root.


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

## Verification on this machine — 2026-11-17

Environment: Linux x64, Node.js v24.21.0, Rust 1.99.1, existing development dependencies/resources. Commands were run in this checkout, not against a downloaded installer or a published tag.

| Check | Observed result |
|---|---|
| `npm test` (47 suites, `pretest` builds the engine) | Passed, exit 0 |
| Desktop `cargo test` | 76 passed, 0 failed |
| `cargo fmt --check` | Passed |
| `cargo check` warnings | 0 |
| `npm run check --prefix apps/web` (svelte-check) | 0 errors, 0 warnings |
| `git diff --check` | Passed |
| `npm audit --omit=dev` (apps/web, apps/desktop) | 0 vulnerabilities |
| Sidecar bind (spawned wrapper) | `127.0.0.1` confirmed via `ss` |
| Dev-only advisories (`npm audit`, all deps) | 7, all in build tooling (vite/launch-editor); not shipped |

Not performed in this pass: live provider calls (no API key), a live Facebook/TikTok download, a clean-machine run, installer/signing verification, or a Windows/macOS run. Passing local checks is not evidence of release readiness.

### Highlight evaluation (last recorded run)

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
npm test   # pretest builds lfai-render first — no separate build step needed
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
npm run check --prefix apps/web
npm run build --prefix apps/web
git diff --check
```

`npm test` runs `scripts/ensure-render-engine.sh` before the suites (the `pretest`
hook), so the CLI can no longer be stale: the render tests always exercise the
current renderer source. CI performs the same build explicitly.

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
- Passing the local checks is not evidence of live-provider quality or installer readiness. Historical v0.1.0 run IDs, download sizes and signing claims must not be reused as v0.1.5 provenance.
- `release/linux-pilot-validation.md` remains historical v0.1.0 evidence until its checklist is rerun against a specific new artifact. No release was published by this maintenance pass.
