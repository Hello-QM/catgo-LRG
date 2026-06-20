#!/usr/bin/env bash
# Build whisper.cpp `whisper-cli` with a GPU backend and stage the binary plus
# its shared libs into an output dir, for the optional CatGo STT accelerator.
#
# Usage: build-whispercpp.sh <vulkan|metal> <out-dir> [whisper-ref]
#
# Mirrors the exact cmake invocation verified locally on AMD Radeon (RADV):
# configure with -DGGML_VULKAN=1 / -DGGML_METAL=1, build the whisper-cli target.
# Toolchain (install before running): Linux Vulkan → cmake glslc glslang-tools
# spirv-headers libvulkan-dev; Windows → Vulkan SDK; macOS Metal → Xcode only.
set -euo pipefail

BACKEND="${1:?usage: build-whispercpp.sh <vulkan|metal> <out-dir> [ref]}"
OUT="${2:?output dir required}"
# Pin a whisper.cpp ref for reproducible release builds; override per release.
REF="${3:-master}"

case "$BACKEND" in
  vulkan) FLAG="-DGGML_VULKAN=1" ;;
  metal)  FLAG="-DGGML_METAL=1" ;;
  *) echo "unknown backend: $BACKEND (expected vulkan|metal)" >&2; exit 1 ;;
esac

# Resolve OUT to an absolute path BEFORE cd-ing into the temp workdir — a relative
# OUT would otherwise land inside $WORK and be deleted by the trap below.
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone --depth 1 --branch "$REF" https://github.com/ggml-org/whisper.cpp "$WORK/src" \
  || git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$WORK/src"
cd "$WORK/src"

JOBS="$( (command -v nproc >/dev/null && nproc) || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
cmake -B build -DCMAKE_BUILD_TYPE=Release $FLAG
cmake --build build -j"$JOBS" --target whisper-cli

mkdir -p "$OUT"
# Binary (Release/ subdir on multi-config generators, bin/ otherwise).
found=""
for c in build/bin/whisper-cli build/bin/Release/whisper-cli.exe build/bin/whisper-cli.exe; do
  [ -f "$c" ] && cp "$c" "$OUT/" && found="$c" && break
done
[ -n "$found" ] || { echo "whisper-cli not found after build" >&2; exit 1; }
# Shared libs it links (ggml*, whisper) — copy whatever exists for this OS.
find build -maxdepth 4 \( -name '*.so' -o -name '*.so.*' -o -name '*.dylib' -o -name '*.dll' \) \
  -exec cp {} "$OUT/" \; 2>/dev/null || true

echo "Staged whisper.cpp ($BACKEND) to $OUT:"
ls -la "$OUT"
