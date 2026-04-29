#!/bin/bash
#===============================================================================
# Build script for CatGO Apptainer container
#
# Run this on a machine where you have sudo or fakeroot access.
# NOT on Expanse (no root on compute/login nodes).
#
# Prerequisites:
#   - Apptainer/Singularity installed (https://apptainer.org/docs/admin/main/installation.html)
#   - sudo access OR fakeroot configured
#   - ~10 GB free disk space for build layers
#   - Internet access (pulls base images + pip packages)
#
# Usage:
#   cd deploy/hpc
#   ./build.sh                    # Build with sudo
#   ./build.sh --fakeroot         # Build without sudo (if fakeroot configured)
#   ./build.sh --sandbox          # Build as sandbox dir (for debugging)
#===============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEF_FILE="$SCRIPT_DIR/catgo.def"
SIF_FILE="$SCRIPT_DIR/catgo.sif"

# Parse args
BUILD_MODE="sudo"
FORMAT="sif"
for arg in "$@"; do
    case "$arg" in
        --fakeroot) BUILD_MODE="fakeroot" ;;
        --sandbox)  FORMAT="sandbox" ;;
        --help|-h)
            echo "Usage: $0 [--fakeroot] [--sandbox]"
            echo "  --fakeroot  Build without sudo (requires fakeroot config)"
            echo "  --sandbox   Build as directory instead of .sif (for debugging)"
            exit 0
            ;;
    esac
done

echo "============================================"
echo "Building CatGO Apptainer container"
echo "  Definition: $DEF_FILE"
echo "  Output:     $SIF_FILE"
echo "  Mode:       $BUILD_MODE"
echo "  Repo root:  $REPO_ROOT"
echo "============================================"

# Verify definition file exists
if [[ ! -f "$DEF_FILE" ]]; then
    echo "ERROR: Definition file not found: $DEF_FILE"
    exit 1
fi

# Verify repo structure
for required in package.json pnpm-lock.yaml svelte.config.js vite.config.ts src server extensions/rust-wasm/pkg; do
    if [[ ! -e "$REPO_ROOT/$required" ]]; then
        echo "ERROR: Required path not found: $REPO_ROOT/$required"
        echo "       Run this script from the CatGO repository."
        exit 1
    fi
done

# Check WASM is pre-built
if [[ ! -f "$REPO_ROOT/extensions/rust-wasm/pkg/ferrox_bg.wasm" ]]; then
    echo "ERROR: WASM not built. Run from repo root:"
    echo "  cd extensions/rust && wasm-pack build --target web --out-dir ../rust-wasm/pkg --features wasm"
    exit 1
fi

# Build
cd "$REPO_ROOT"  # Apptainer %files paths are relative to CWD

if [[ "$FORMAT" == "sandbox" ]]; then
    OUTPUT="$SCRIPT_DIR/catgo-sandbox"
    echo "Building sandbox directory: $OUTPUT"
    if [[ "$BUILD_MODE" == "fakeroot" ]]; then
        apptainer build --fakeroot --sandbox "$OUTPUT" "$DEF_FILE"
    else
        sudo apptainer build --sandbox "$OUTPUT" "$DEF_FILE"
    fi
    echo ""
    echo "Sandbox built at: $OUTPUT"
    echo "Debug with: apptainer shell $OUTPUT"
else
    echo "Building .sif image: $SIF_FILE"
    if [[ "$BUILD_MODE" == "fakeroot" ]]; then
        apptainer build --fakeroot "$SIF_FILE" "$DEF_FILE"
    else
        sudo apptainer build "$SIF_FILE" "$DEF_FILE"
    fi

    SIZE=$(du -h "$SIF_FILE" | cut -f1)
    echo ""
    echo "============================================"
    echo "Build complete!"
    echo "  Image: $SIF_FILE ($SIZE)"
    echo ""
    echo "Transfer to Expanse:"
    echo "  scp $SIF_FILE \$USER@login.expanse.sdsc.edu:~/containers/"
    echo ""
    echo "Test locally:"
    echo "  apptainer test $SIF_FILE"
    echo "  apptainer run $SIF_FILE"
    echo "============================================"
fi
