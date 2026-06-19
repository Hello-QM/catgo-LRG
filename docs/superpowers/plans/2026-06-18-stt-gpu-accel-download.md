# STT GPU Accelerator Download — Implementation Plan

> Execute with superpowers:subagent-driven-development or inline. Builds on PR
> #379 (pluggable `whispercpp` engine). Branch: `feat/stt-gpu-accel`.

**Goal:** in-app optional download + runtime-switch to whisper.cpp Vulkan/Metal STT.

## Global Constraints
- Project style: single quotes, no semicolons, 2-space (TS/Svelte); ruff/PEP8 (py).
- i18n en+zh key parity.
- Never auto-download; explicit user action. Downloads sha256-verified + atomic.
- Default stays faster-whisper; NVIDIA auto-CUDA untouched.
- `<catgo-data>` = existing CatGo data-dir helper (find + reuse, don't invent).

---

### Task 1: Runtime engine state (backend)
**Files:** Create `server/catgo/stt/__init__.py`, `server/catgo/stt/engine_state.py`;
Test `server/tests/test_stt_engine_state.py`.
- `engine_state.py`: module holding current `{engine, model}`, persisted to
  `<data>/stt-accel/state.json`. API: `get_engine()`, `set_engine(name)`,
  `get_state()/save`. Initial default from `CATGO_STT_ENGINE` env else
  `faster-whisper`. Data dir via a small `_data_dir()` (reuse CatGo's if present).
- Tests: default; env override; set+persist+reload; reject unknown engine.

### Task 2: Accelerator manager (backend)
**Files:** Create `server/catgo/stt/accel.py`; Test `server/tests/test_stt_accel.py`.
- `platform_key() -> "linux-x64-vulkan"|"windows-x64-vulkan"|"macos-arm64-metal"|None`
  (os+arch+gpu api; None when unsupported/no GPU).
- `detect_gpu() -> {gpu_api, gpu_name}` best-effort (vulkaninfo / platform.mac).
- `install_dir()`, `binary_path()`, `model_path(size)`.
- `download_file(url, dest, sha256, progress_cb)` — stream, verify, atomic rename.
- `install_binary(manifest_url, progress_cb)` — fetch manifest, pick platform_key,
  download+extract (tar.zst/zip), mark executable.
- `download_model(size, progress_cb)` — ggml-<size>.bin from HF (+hf-mirror fallback).
- A `Download` progress holder (active/kind/pct) shared with status.
- Tests (no network): sha256 verify pass/fail, atomic rename, platform_key matrix,
  manifest entry selection.

### Task 3: Endpoints + stt.py wiring (backend)
**Files:** Modify `server/catgo/routers/stt.py`; Test `server/tests/test_stt_accel_api.py`.
- stt.py reads engine/model from `engine_state` per request; whispercpp uses
  `accel.binary_path()/model_path()`.
- `GET /accel/status`, `POST /accel/install`, `POST /accel/model?size=`,
  `POST /accel/engine {engine}` (reject whispercpp if binary/model missing).
- Downloads run via FastAPI BackgroundTasks; progress in status.
- Tests: status shape; engine switch validation; (install/model mocked).

### Task 4: Client API (frontend)
**Files:** Create `src/lib/gesture/stt-accel.ts`; Test
`src/lib/gesture/__tests__/stt-accel.test.ts`.
- Typed wrappers: `accel_status()`, `accel_install()`, `accel_download_model(size)`,
  `accel_set_engine(engine)`, `poll_progress(cb)`.
- Tests: mocked fetch — status parse, install trigger, progress poll, switch.

### Task 5: Voice menu GPU section (frontend)
**Files:** Modify `src/lib/structure/TerminalWindow.svelte`,
`src/lib/i18n/{en,zh}/*.ts` (find the voice-menu namespace).
- GPU section gated on `status.gpu_api != null`: status line, Download&enable
  button + progress, engine toggle (GPU/CPU). i18n keys (en+zh parity).

### Task 6: Build script + CI
**Files:** Create `scripts/build-whispercpp.sh`, `.github/workflows/build-stt-accel.yml`.
- `build-whispercpp.sh <vulkan|metal> <out-dir>`: clone pinned whisper.cpp,
  cmake `-DGGML_VULKAN=1`/`-DGGML_METAL=1`, build `whisper-cli`, stage binary+libs.
- Workflow: `workflow_dispatch` + tag `stt-accel-v*`; matrix ubuntu(vulkan) /
  windows(vulkan SDK) / macos(metal); build, package (tar.zst/zip), sha256,
  upload Release assets; final job writes `stt-accel-manifest.json`.
- Verify build script locally on Linux (proven in spike).

### Task 7: Docs + verify
- Short note in deploy docs: how to cut an `stt-accel-v1` release + that the
  binary is opt-in. Run `pnpm test` + backend pytest green.
