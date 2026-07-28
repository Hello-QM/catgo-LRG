#!/usr/bin/env bash
set -euo pipefail

TAG="${1:?usage: ensure-v1.4.6-release-body.sh v1.4.6}"
if [ "$TAG" != "v1.4.6" ]; then
  echo "refusing to apply v1.4.6 release notes to $TAG" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
NOTES=".github/release-notes/v1.4.6.md"
GH_BIN="${CATGO_GH_BIN:-gh}"
cd "$ROOT"

if ! "$GH_BIN" release view "$TAG" >/dev/null 2>&1; then
  # Another matrix or asset workflow may create the draft after our view.
  # A failed create is acceptable only if that exact release now exists.
  "$GH_BIN" release create "$TAG" --draft \
    --title "CatGo $TAG" --notes-file "$NOTES" \
    || "$GH_BIN" release view "$TAG" >/dev/null
fi

# Always edit, including the existing-release path. This is the deterministic
# finalizer that removes timing dependence between tauri-action and asset jobs.
"$GH_BIN" release edit "$TAG" \
  --title "CatGo $TAG" \
  --notes-file "$NOTES"
