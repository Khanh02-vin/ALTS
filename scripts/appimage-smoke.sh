#!/usr/bin/env bash
# Launch a packaged Linux AppImage under an existing X display and verify
# that its Tauri window and WebKit renderer survive startup.
set -euo pipefail

if [[ $# -ne 1 || ! -x "$1" ]]; then
  echo "usage: $0 /path/to/app.AppImage" >&2
  exit 2
fi
for tool in xdotool pgrep; do
  command -v "$tool" >/dev/null || { echo "missing smoke-test dependency: $tool" >&2; exit 2; }
done
[[ -n "${DISPLAY:-}" ]] || { echo 'DISPLAY is required (run under xvfb-run)' >&2; exit 2; }

appimage=$(realpath "$1")
tmp=$(mktemp -d "${TMPDIR:-/tmp}/local-first-appimage-smoke-XXXXXX")
log="$tmp/app.log"
mkdir -p "$tmp/state" "$tmp/cache"
export LOCAL_FIRST_STATE_DIR="$tmp/state"
export LOCAL_FIRST_CACHE_DIR="$tmp/cache"

cleanup() {
  if [[ -n "${app_pid:-}" ]]; then
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  rm -rf -- "$tmp"
}
trap cleanup EXIT INT TERM

find_webkit_process() {
  local parent child command
  local -a pending=("$app_pid")
  while ((${#pending[@]})); do
    parent=${pending[0]}
    pending=("${pending[@]:1}")
    while read -r child; do
      [[ -n "$child" ]] || continue
      command=$(tr '\0' ' ' <"/proc/$child/cmdline" 2>/dev/null || true)
      if [[ "$command" =~ (^|/)WebKitWebProcess([[:space:]]|$) ]]; then
        printf '%s' "$child"
        return 0
      fi
      pending+=("$child")
    done < <(pgrep -P "$parent" 2>/dev/null || true)
  done
}

"$appimage" >"$log" 2>&1 &
app_pid=$!
window_id=''
webkit_pid=''

for _ in $(seq 1 90); do
  if ! kill -0 "$app_pid" 2>/dev/null; then
    echo 'AppImage exited during startup' >&2
    break
  fi
  window_id=$(xdotool search --onlyvisible --name 'Local-first AI Video Studio' 2>/dev/null | head -n 1 || true)
  webkit_pid=$(find_webkit_process || true)
  [[ -n "$window_id" && -n "$webkit_pid" ]] && break
  sleep 1
done

if [[ -z "$window_id" || -z "$webkit_pid" ]] || ! kill -0 "$app_pid" 2>/dev/null; then
  echo "AppImage did not reach a healthy window + WebKit process (window=${window_id:-none}, WebKit=${webkit_pid:-none})" >&2
  cat "$log" >&2
  exit 1
fi

# Reject the specific renderer crash observed in the bundled v0.1.3 image.
if grep -Eiq 'EGL_BAD_PARAMETER|Could not create default EGL display|Aborting.*EGL' "$log"; then
  echo 'AppImage log contains the known EGL renderer failure:' >&2
  cat "$log" >&2
  exit 1
fi

sleep 5
if ! kill -0 "$app_pid" 2>/dev/null || ! kill -0 "$webkit_pid" 2>/dev/null; then
  echo 'AppImage or WebKit renderer exited shortly after startup' >&2
  cat "$log" >&2
  exit 1
fi

echo "AppImage smoke passed: window=$window_id WebKitWebProcess=$webkit_pid"
