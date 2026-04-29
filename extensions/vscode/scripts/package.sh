#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
SERVER_DIR="$(dirname "$(dirname "$EXT_DIR")")/server"

cd "$EXT_DIR"

# Build extension (webview + extension host)
echo "=== Building VS Code extension ==="
pnpm build

# Build backend binary
echo "=== Building catgo-server binary ==="
cd "$SERVER_DIR"
pyinstaller catgo_server.spec --noconfirm 2>&1 | tail -5

# Copy binary to extension bin/
mkdir -p "$EXT_DIR/bin"
PLATFORM="$(uname -s)-$(uname -m)"
case "$PLATFORM" in
  Linux-x86_64)  TARGET="linux-x64";   BIN_NAME="catgo-server-linux-x64" ;;
  Darwin-arm64)  TARGET="darwin-arm64"; BIN_NAME="catgo-server-darwin-arm64" ;;
  Darwin-x86_64) TARGET="darwin-x64";  BIN_NAME="catgo-server-darwin-x64" ;;
  MINGW*|MSYS*)  TARGET="win32-x64";   BIN_NAME="catgo-server-win-x64.exe" ;;
  *)             echo "Unknown platform: $PLATFORM"; exit 1 ;;
esac

cp "$SERVER_DIR/dist/catgo-server" "$EXT_DIR/bin/$BIN_NAME" 2>/dev/null || \
cp "$SERVER_DIR/dist/catgo-server.exe" "$EXT_DIR/bin/$BIN_NAME"
chmod +x "$EXT_DIR/bin/$BIN_NAME"

echo "=== Binary: bin/$BIN_NAME ($(du -h "$EXT_DIR/bin/$BIN_NAME" | cut -f1)) ==="

# Package .vsix for current platform
cd "$EXT_DIR"
npx vsce package --no-dependencies --target "$TARGET" -o "catgo-$TARGET.vsix"

echo "=== Done: catgo-$TARGET.vsix ==="
ls -lh "catgo-$TARGET.vsix"
