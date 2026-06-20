# In-App STT GPU Accelerator (whisper.cpp Vulkan/Metal) — Design

**Goal:** Let users opt into GPU-accelerated voice dictation from inside CatGo —
a "GPU acceleration" control that downloads the right whisper.cpp binary for
their platform/GPU (Vulkan on Linux/Windows, Metal on macOS) plus the chosen
GGML model, then switches the STT backend to it at runtime. No 60 MB bundled
into the default installer; NVIDIA users keep the auto-CUDA faster-whisper path.

**Builds on:** PR #379 (native backend STT, pluggable `CATGO_STT_ENGINE`
faster-whisper | whispercpp). This spec makes the `whispercpp` engine
**user-installable and runtime-switchable** instead of env-var only.

## Why

- Default engine faster-whisper: CPU int8 everywhere + auto-CUDA on NVIDIA. Good
  baseline, ships in the sidecar (~60 MB ctranslate2).
- AMD/Intel iGPU (Vulkan) and Apple Silicon (Metal) get no GPU from CTranslate2
  (CUDA-only). whisper.cpp covers them but its Vulkan shader lib is ~60 MB and
  models are a separate format — too heavy to bundle for everyone.
- So: ship nothing extra by default; let the ~minority who want iGPU/Metal GPU
  download it on demand.

## User experience

In the terminal voice menu (`TerminalWindow.svelte`), a new **GPU 加速 / GPU
Acceleration** section, shown only when the platform can benefit (not Windows
NVIDIA-CUDA-already-working — see detection):

1. Status line: detected GPU + API, e.g. "AMD Radeon (Vulkan) — 未安装" /
   "Apple M3 (Metal) — 已启用".
2. **Download & enable** button → downloads the accelerator binary (~30 MB
   compressed) with a progress bar, then prompts to download the selected
   model's GGML file (e.g. small ~488 MB) with progress.
3. Once installed, a toggle: **GPU (whisper.cpp)** vs **CPU (faster-whisper)**.
4. Errors degrade gracefully back to CPU; never blocks dictation.

## Architecture

### Components / file layout

```
server/catgo/routers/stt.py            # extend: runtime engine state + new endpoints
server/catgo/stt/accel.py    (new)     # download/install manager (binary + model)
server/catgo/stt/engine_state.py (new) # runtime engine selection + persistence
src/lib/gesture/stt-accel.ts (new)     # client: status/install/model/switch API + progress
src/lib/structure/TerminalWindow.svelte# extend: GPU acceleration menu section
src/lib/i18n/{en,zh}/*.ts              # new keys (parity)
.github/workflows/build-stt-accel.yml (new)  # build whisper.cpp per platform → Release
scripts/build-whispercpp.sh  (new)     # reusable build (Vulkan/Metal), used by CI + local
```

Install destination (per-user, not in the app bundle):
```
<catgo-data>/stt-accel/<platform>/whisper-cli(+libs)     # downloaded binary
<catgo-data>/stt-accel/models/ggml-<size>.bin            # downloaded models
```
`<catgo-data>` = platform config/cache dir (reuse CatGo's existing data dir helper).

### Backend

**Runtime engine state** (`engine_state.py`): replace the load-time-only
`_ENGINE` constant with a mutable selection persisted to
`<catgo-data>/stt-accel/state.json` (`{"engine": "...", "model": "..."}`).
`stt.py` reads it per request. `CATGO_STT_ENGINE` env, if set, is the initial
default and an override.

**New endpoints** (under existing `/api/stt`):

- `GET  /accel/status` → `{platform, arch, gpu_api: "vulkan"|"metal"|null,
  gpu_name, binary_installed: bool, engine: "faster-whisper"|"whispercpp",
  models_installed: [size,...], download: {active, kind, pct} | null}`
- `POST /accel/install` → start binary download+extract from the release
  manifest for this platform/gpu; returns immediately, progress via status.
- `POST /accel/model?size=small` → start GGML model download (HF + hf-mirror
  fallback); progress via status.
- `POST /accel/engine` `{engine}` → switch + persist; validates binary present
  when selecting whispercpp.
- (downloads run in a background task; `status.download.pct` polled by client.)

**Manifest:** a release asset `stt-accel-manifest.json`:
```json
{ "version": "1",
  "binaries": {
    "linux-x64-vulkan":  {"url": "...whisper-cli-linux-x64-vulkan.tar.zst", "sha256": "..."},
    "windows-x64-vulkan":{"url": "...", "sha256": "..."},
    "macos-arm64-metal": {"url": "...", "sha256": "..."}
  } }
```
App fetches the manifest from a pinned Release tag (e.g. `stt-accel-v1`), picks
its `<os>-<arch>-<api>` entry, downloads, verifies sha256, extracts to the
install dir, marks `_WHISPERCPP_BIN`/`_WHISPERCPP_MODELS` to the install paths.

**GPU detection:** Linux/Windows → probe Vulkan (try `vulkaninfo`/loader, or
assume offer-able and let install/run validate). macOS → Metal always present on
Apple Silicon. Report `gpu_api=null` (hide the section) when no usable GPU API
(e.g. headless Linux without a GPU) — best-effort; the feature is opt-in so a
false-positive just fails the first run gracefully.

### Frontend

`stt-accel.ts`: typed wrappers for the endpoints + a small polling helper for
download progress. `TerminalWindow.svelte` voice menu gains the GPU section
(status, download button + progress, engine toggle), gated on
`status.gpu_api != null`. New i18n keys in en + zh (parity enforced).

When the user picks a model size that isn't installed for whispercpp, prompt to
download it first.

### CI / hosting

`build-stt-accel.yml` (manual `workflow_dispatch` + on tag `stt-accel-v*`):
matrix over `ubuntu-latest` (Vulkan), `windows-latest` (Vulkan SDK),
`macos-latest` (Metal). Each:
1. install toolchain (Linux: cmake glslc glslang-tools spirv-headers
   libvulkan-dev; Windows: Vulkan SDK; macOS: native Metal).
2. `scripts/build-whispercpp.sh` → build `whisper-cli` + required `.so/.dll/.dylib`.
3. package (tar.zst / zip) + compute sha256.
4. upload as Release assets + (last job) assemble & upload `stt-accel-manifest.json`.

`scripts/build-whispercpp.sh` clones a pinned whisper.cpp commit, configures
`-DGGML_VULKAN=1` or `-DGGML_METAL=1`, builds the `whisper-cli` target, and
collects the binary + libs into a staging dir. Reused by CI and for local dev.

## Error handling / safety

- All downloads: sha256-verified, atomic (download to tmp, rename on success),
  resumable-not-required (small enough; restart on failure).
- Selecting whispercpp without an installed binary or model → 400 with a clear
  message; client keeps faster-whisper.
- whisper-cli run failure at request time → log + 500; the client's
  `BackendWhisperEngine` already swallows non-OK and skips injection (no crash).
- Engine switch is per-process state; persisted so it survives restart.
- Never auto-download; always explicit user action.

## Testing

- Backend: unit-test `engine_state` (default/override/persist), `_resolve_size`
  unchanged, manifest selection (`os/arch/api` → entry), and `/accel/engine`
  validation (reject whispercpp when binary absent). Download manager: test the
  sha256-verify + atomic-rename path with a local fixture server (no network).
- Frontend: `stt-accel.ts` unit tests with mocked fetch (status parse, install
  trigger, progress poll, engine switch); menu gating on `gpu_api`.
- CI build: dry-run the build script locally on Linux (already proven in the
  spike: builds + runs on AMD RADV, ~2.5 min, correct output).

## Out of scope (separate follow-ups)

- Bundling NVIDIA cuBLAS/cuDNN for out-of-box CUDA GPU (~2 GB) — keep relying on
  the user's system CUDA libs (auto-detect + CPU fallback already shipped).
- MLX (Apple) engine — Metal via whisper.cpp covers Apple Silicon GPU.
- Auto-selecting GPU without a user click.

## Open decisions (resolved as defaults unless changed)

- Release tag for assets: `stt-accel-v1` (manifest-versioned, decoupled from app
  version so the app doesn't need a matching app release to fetch accel).
- Default model offered for download: match the user's current picker selection;
  recommend `small` for GPU (where the GPU win is clear).
- Compression: `tar.zst` (Linux/macOS), `zip` (Windows).
