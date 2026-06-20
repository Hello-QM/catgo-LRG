# STT GPU Accelerator (whisper.cpp Vulkan/Metal)

The default backend ships **faster-whisper** (CPU int8 everywhere, auto-CUDA on
NVIDIA). Users on **AMD/Intel iGPU** (Vulkan) or **Apple Silicon** (Metal) can
opt into a GPU build of whisper.cpp from inside the app — it is **not** bundled
in the installer (the Vulkan shader lib alone is ~60 MB).

## How it works

- App (`src/lib/gesture/stt-accel.ts` + the voice menu) calls the backend
  `/api/stt/accel/*` endpoints to detect the GPU, download the platform binary +
  the selected GGML model, and switch the engine at runtime
  (`catgo.stt.engine_state`, persisted).
- Binaries are downloaded from a GitHub Release, selected via a manifest
  (`stt-accel-manifest.json`) keyed `"<os>-<arch>-<api>"`
  (e.g. `linux-x64-vulkan`, `macos-arm64-metal`, `windows-x64-vulkan`).
- Everything lands in `~/.catgo/stt-accel/{bin,models}` — never the app bundle.
  Downloads are sha256-verified and extracted with Zip/Tar-Slip guards.

## Cutting a release

The `Build STT accelerator` workflow (`.github/workflows/build-stt-accel.yml`)
builds `whisper-cli` per platform and attaches the archives + manifest to a
Release. Run it manually:

```
gh workflow run "Build STT accelerator" -f tag=stt-accel-v1
```

or push a tag matching `stt-accel-v*`. The app's default manifest URL
(`accel.DEFAULT_MANIFEST_URL`, overridable via `CATGO_STT_MANIFEST_URL`) points
at the `stt-accel-v1` release — bump both together when publishing a new line.

## Local build (dev / testing)

```
scripts/build-whispercpp.sh vulkan ./dist/linux-x64-vulkan      # Linux/Win (AMD/Intel)
scripts/build-whispercpp.sh metal  ./dist/macos-arm64-metal     # macOS
```
Toolchain: Linux Vulkan → `cmake glslc glslang-tools spirv-headers
libvulkan-dev`; Windows → Vulkan SDK; macOS Metal → Xcode only.

To point a running backend at a local build without the download UI:

```
CATGO_STT_ENGINE=whispercpp \
CATGO_WHISPERCPP_BIN=$PWD/dist/linux-x64-vulkan/whisper-cli \
CATGO_WHISPERCPP_MODELS=$PWD/models   # contains ggml-<size>.bin
```

## Notes

- NVIDIA GPUs do **not** need this — faster-whisper auto-uses CUDA (the sidecar
  bundles a CUDA-capable ctranslate2; it falls back to CPU when the user lacks
  cuBLAS/cuDNN). Out-of-box NVIDIA GPU still requires shipping those libs (~2 GB,
  not done — separate decision).
- Trust anchor for downloads is HTTPS to GitHub Releases + the per-asset sha256
  in the manifest. Signing the manifest itself is a possible future hardening.
