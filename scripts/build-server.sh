#!/bin/bash
# Build the CatGo backend server as a standalone executable using PyInstaller.
#
# Usage:
#   ./scripts/build-server.sh [--install-deps]
#
# Options:
#   --install-deps    Install Python dependencies before building
#
# Output:
#   The executable will be placed in src-tauri/binaries/ with platform-specific naming
#   for Tauri sidecar support.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SERVER_DIR="$PROJECT_ROOT/server"
OUTPUT_DIR="$PROJECT_ROOT/src-tauri/binaries"

# Determine platform triple for Tauri sidecar naming
case "$(uname -s)" in
    Linux*)
        case "$(uname -m)" in
            x86_64)  PLATFORM="x86_64-unknown-linux-gnu" ;;
            aarch64) PLATFORM="aarch64-unknown-linux-gnu" ;;
            *)       PLATFORM="unknown-linux" ;;
        esac
        EXT=""
        ;;
    Darwin*)
        case "$(uname -m)" in
            x86_64)  PLATFORM="x86_64-apple-darwin" ;;
            arm64)   PLATFORM="aarch64-apple-darwin" ;;
            *)       PLATFORM="unknown-darwin" ;;
        esac
        EXT=""
        ;;
    MINGW*|MSYS*|CYGWIN*|Windows*)
        PLATFORM="x86_64-pc-windows-msvc"
        EXT=".exe"
        ;;
    *)
        echo "Unknown platform: $(uname -s)"
        exit 1
        ;;
esac

echo "Building CatGo server for platform: $PLATFORM"

# Install dependencies if requested
if [[ "$1" == "--install-deps" ]]; then
    echo "Installing Python dependencies..."
    pip install pyinstaller
    pip install -r "$SERVER_DIR/requirements.txt"
    # Try to install xtb-python (optional)
    pip install xtb || echo "Warning: xtb-python not available, will use CLI fallback"
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Build with PyInstaller
echo "Running PyInstaller..."
cd "$SERVER_DIR"
pyinstaller catgo_server.spec --distpath "$OUTPUT_DIR" --workpath "$PROJECT_ROOT/build/pyinstaller" --noconfirm

# Rename to Tauri sidecar format: catgo-server-{platform}{ext}
SIDECAR_NAME="catgo-server-$PLATFORM$EXT"
if [[ -f "$OUTPUT_DIR/catgo-server$EXT" ]]; then
    mv "$OUTPUT_DIR/catgo-server$EXT" "$OUTPUT_DIR/$SIDECAR_NAME"
    echo "Created sidecar: $OUTPUT_DIR/$SIDECAR_NAME"
else
    echo "Error: PyInstaller output not found"
    exit 1
fi

# Create a version info file
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUTPUT_DIR/catgo-server.version"

echo "Server build complete!"
echo "Sidecar binary: $OUTPUT_DIR/$SIDECAR_NAME"
