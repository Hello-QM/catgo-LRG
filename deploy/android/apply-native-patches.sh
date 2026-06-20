#!/usr/bin/env bash
# Re-apply the Android native patches that `tauri android init` drops.
#
# `src-tauri/gen/android/` is gitignored and regenerated from stock Tauri
# templates on every `pnpm tauri android init`. Two edits required for correct
# window-inset behaviour (status bar not covering the top, soft keyboard not
# covering the terminal keybar / chat composer) live in that generated tree and
# are therefore lost on each init:
#
#   1. AndroidManifest.xml — `android:windowSoftInputMode="adjustResize"` on
#      the .MainActivity <activity>.
#   2. MainActivity.kt — enableEdgeToEdge() + a WindowInsets listener that pads
#      the content view by the status-bar (top) and IME/nav-bar (bottom) insets.
#
# Run this AFTER `tauri android init` and BEFORE `tauri android build`. It is
# idempotent. See deploy/android/README.md and plan/mobile-input-issues.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GEN="$REPO_ROOT/src-tauri/gen/android/app/src/main"
MANIFEST="$GEN/AndroidManifest.xml"
ACTIVITY="$GEN/java/com/catgo/app/MainActivity.kt"
OVERRIDE="$REPO_ROOT/deploy/android/overrides/MainActivity.kt"

if [ ! -d "$GEN" ]; then
  echo "::error::$GEN not found — run 'pnpm tauri android init' first." >&2
  exit 1
fi

# (1) MainActivity.kt — full replace with the canonical copy.
cp "$OVERRIDE" "$ACTIVITY"
echo "patched: MainActivity.kt (inset listener)"

# (2) AndroidManifest.xml — insert windowSoftInputMode if absent (idempotent).
if grep -q 'windowSoftInputMode' "$MANIFEST"; then
  echo "skip: AndroidManifest.xml already has windowSoftInputMode"
else
  # Insert the attribute immediately before the unique .MainActivity name attr.
  sed -i.bak 's#\(android:name=".MainActivity"\)#android:windowSoftInputMode="adjustResize"\n            \1#' "$MANIFEST"
  rm -f "$MANIFEST.bak"
  grep -q 'windowSoftInputMode' "$MANIFEST" || {
    echo "::error::failed to insert windowSoftInputMode into AndroidManifest.xml" >&2
    exit 1
  }
  echo "patched: AndroidManifest.xml (windowSoftInputMode=adjustResize)"
fi

echo "Android native patches applied."
