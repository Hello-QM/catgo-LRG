#!/bin/bash
# Build script for CatGo backend server
# Builds PyInstaller bundle for the specified platform

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVER_DIR="$PROJECT_DIR/server"
BINARIES_DIR="$PROJECT_DIR/src-tauri/binaries"

# Determine target platform
TARGET="${1:-native}"

echo "Building CatGo backend server..."
echo "Target: $TARGET"
echo "Server directory: $SERVER_DIR"
echo "Output directory: $BINARIES_DIR"

# Create binaries directory if it doesn't exist
mkdir -p "$BINARIES_DIR"

cd "$SERVER_DIR"

# Determine output name based on target
case "$TARGET" in
  "x86_64-pc-windows-msvc"|"windows")
    OUTPUT_NAME="catgo-server-x86_64-pc-windows-msvc.exe"
    ;;
  "aarch64-apple-darwin"|"mac-arm"|"mac-m1"|"mac-m2")
    OUTPUT_NAME="catgo-server-aarch64-apple-darwin"
    ;;
  "x86_64-apple-darwin"|"mac-intel")
    OUTPUT_NAME="catgo-server-x86_64-apple-darwin"
    ;;
  "universal-apple-darwin"|"mac-universal")
    # Build for both architectures (will need lipo to combine)
    OUTPUT_NAME="catgo-server-universal-apple-darwin"
    ;;
  "x86_64-unknown-linux-gnu"|"linux")
    OUTPUT_NAME="catgo-server-x86_64-unknown-linux-gnu"
    ;;
  "native"|*)
    # Auto-detect current platform
    case "$(uname -s)" in
      Darwin)
        case "$(uname -m)" in
          arm64)
            OUTPUT_NAME="catgo-server-aarch64-apple-darwin"
            ;;
          *)
            OUTPUT_NAME="catgo-server-x86_64-apple-darwin"
            ;;
        esac
        ;;
      Linux)
        OUTPUT_NAME="catgo-server-x86_64-unknown-linux-gnu"
        ;;
      MINGW*|MSYS*|CYGWIN*)
        OUTPUT_NAME="catgo-server-x86_64-pc-windows-msvc.exe"
        ;;
      *)
        echo "Unknown platform: $(uname -s)"
        exit 1
        ;;
    esac
    ;;
esac

echo "Output filename: $OUTPUT_NAME"

# Check for Python and PyInstaller
if ! command -v python3 &> /dev/null; then
    echo "Error: python3 is required"
    exit 1
fi

if ! python3 -c "import PyInstaller" 2>/dev/null; then
    echo "Installing PyInstaller..."
    pip3 install pyinstaller
fi

# Build with PyInstaller
echo "Running PyInstaller..."
python3 -m PyInstaller catgo_server.spec --noconfirm

# Move output to binaries directory
if [[ "$OUTPUT_NAME" == *.exe ]]; then
    # Windows
    if [ -f "dist/catgo-server.exe" ]; then
        cp "dist/catgo-server.exe" "$BINARIES_DIR/$OUTPUT_NAME"
    elif [ -f "dist/catgo-server/catgo-server.exe" ]; then
        cp "dist/catgo-server/catgo-server.exe" "$BINARIES_DIR/$OUTPUT_NAME"
    fi
else
    # Unix
    if [ -f "dist/catgo-server" ]; then
        cp "dist/catgo-server" "$BINARIES_DIR/$OUTPUT_NAME"
        chmod +x "$BINARIES_DIR/$OUTPUT_NAME"
    elif [ -f "dist/catgo-server/catgo-server" ]; then
        cp "dist/catgo-server/catgo-server" "$BINARIES_DIR/$OUTPUT_NAME"
        chmod +x "$BINARIES_DIR/$OUTPUT_NAME"
    fi
fi

echo "Backend built successfully: $BINARIES_DIR/$OUTPUT_NAME"
ls -la "$BINARIES_DIR/"
