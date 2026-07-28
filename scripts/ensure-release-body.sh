#!/usr/bin/env bash
set -euo pipefail

TAG="${1:?usage: ensure-release-body.sh vX.Y.Z}"
if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "release tag must match vX.Y.Z: $TAG" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
NOTES=".github/release-notes/${TAG}.md"
GH_BIN="${CATGO_GH_BIN:-gh}"
cd "$ROOT"

if [ ! -f "$NOTES" ]; then
  echo "canonical release notes do not exist: $NOTES" >&2
  exit 2
fi

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
