#!/usr/bin/env bash
# Builds the render engine CLI that the Node test suites invoke.
#
# `npm test` drives the Rust renderer through `target/debug/lfai-render`. CI
# builds it explicitly before running the tests; locally the binary was whatever
# happened to be on disk, so a stale build silently tested old renderer code.
# Running this from `pretest` makes local and CI behave the same way.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/apps/desktop/src-tauri/Cargo.toml"

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found — the render tests need the lfai-render CLI." >&2
  echo "       install a Rust toolchain (https://rustup.rs) or run the suites that" >&2
  echo "       do not need the engine individually (e.g. npm run test:scoring)." >&2
  exit 1
fi

echo "==> building lfai-render (render tests depend on this binary)"
cargo build --manifest-path "$MANIFEST" -p lfai-render
