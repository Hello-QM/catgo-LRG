# Terminal Voice Input — Design

**Date:** 2026-06-18
**Branch:** `feat/terminal-voice-input`
**Status:** Approved design, pending implementation plan

## Goal

Let the user dictate into the desktop terminal (the shell prompt, and any TUI
running in it such as Claude Code) by speaking. Spoken words are transcribed
locally and typed into the terminal at the cursor. Inspired by
[voxpilot](https://github.com/natearcher-ai/voxpilot), but built on CatGo's
existing in-browser STT pipeline rather than voxpilot's VS Code / Node engine.

## Scope

- **In scope:** Desktop `TerminalPanel`. Local-only speech-to-text. On-demand
  model download with model selection. Transcript inserted into the command
  line without auto-Enter.
- **Out of scope:** Mobile (`MobileTerminal` untouched). Web Speech API
  (`SpeechRecognition`) — explicitly NOT used (cloud-routed, Chrome-only).
  Porting voxpilot's Node/`onnxruntime-node`/native-CLI audio path. Voice
  command matching (this is pure dictation, `ai_enabled = false`). New runtime
  dependencies (`@huggingface/transformers` is already a dependency).

## Why not voxpilot directly

voxpilot is a VS Code extension (100% TypeScript) that captures audio via native
CLI tools (`arecord`/`sox`/`ffmpeg`) and runs ONNX ASR in Node via
`onnxruntime-node`. None of that fits CatGo's Tauri WKWebView. CatGo already has
the browser-native equivalent in `src/lib/gesture/local-whisper.ts`:
Transformers.js, on-demand model download from the HuggingFace Hub, IndexedDB
caching, WebGPU/WASM ONNX inference, and Silero VAD. The integration therefore
**reuses CatGo's pipeline** and only generalizes the hardcoded model choice.

## Key existing pieces (reused, not rebuilt)

| Piece | Location | Role |
| --- | --- | --- |
| `LocalWhisperEngine` | `src/lib/gesture/local-whisper.ts:89` | mic → VAD → ONNX transcribe → `VoiceCallback` |
| `get_pipeline()` | `src/lib/gesture/local-whisper.ts:28` | model load + download, IndexedDB cache (currently hardcoded to whisper-tiny) |
| Silero VAD | `src/lib/gesture/vad.ts` | speech-segment detection, emits final audio |
| `panel_send_keys()` | `src/lib/structure/TerminalPanel.svelte:129` | write raw bytes to the PTY |
| `<Icon>` / `icons.ts` | `src/lib/Icon.svelte`, `src/lib/icons.ts` | toolbar iconography |

## Architecture

```
[mic] → getUserMedia → Silero VAD → LocalWhisperEngine (chosen Whisper model, ONNX)
      → final transcript string → terminal-voice controller
      → panel_send_keys(text)  [NO Enter]  → PTY → xterm renders at cursor
```

Four units, each independently understandable:

### 1. Model registry — `src/lib/gesture/whisper-models.ts` (new)

A small pure-data module: the list of selectable models and a default.

```ts
export interface WhisperModel {
  id: string          // HF repo id, e.g. 'onnx-community/whisper-base'
  label: string       // UI label, e.g. 'Base'
  size_mb: number     // approx q8 download size, for the UI
  multilingual: boolean
}
export const WHISPER_MODELS: WhisperModel[]
export const DEFAULT_WHISPER_MODEL_ID: string
```

Models offered: Whisper **tiny / base / small / medium**, each in an English
(`.en`) and a multilingual variant. Exact `onnx-community/whisper-*` repo ids
are verified to exist with a q8 ONNX build during implementation; any size that
lacks a browser-runnable ONNX build is dropped from the list (logged, not
silently). `medium` (~1.5 GB q8) is included but clearly labelled as large.

### 2. Generalize `get_pipeline()` — `local-whisper.ts` (modified)

Today `get_pipeline(language)` maps language → one of two hardcoded ids. Change
it to take an explicit `model_id` (keeping a language→default fallback so
existing callers in the gesture/chat paths are unaffected). The cache key
becomes `model_id` (already is). `LocalWhisperEngine.start()` and
`set_language()` gain an optional `model_id` so the terminal can pass the chosen
model. No behavior change for current callers.

### 3. Terminal voice controller — `src/lib/structure/terminal-voice.svelte.ts` (new)

Thin glue between the engine and the terminal. Owns the recording/model state
for one terminal and isolates the engine choice (future swap = one file).

```ts
export class TerminalVoice {
  recording: boolean          // $state
  model_status: ModelStatus   // 'idle'|'loading'|'downloading'|'ready'|'error'
  download_progress: number   // 0..1
  model_id: string            // selected, persisted to localStorage

  get is_supported(): boolean // navigator.mediaDevices?.getUserMedia
  async toggle(send: (text: string) => void, language: string): Promise<void>
  stop(): void
}
```

On a final `VoiceEvent` it calls `send(raw_text)`. Only `is_final` events are
forwarded — interim hypotheses are never sent, because bytes already written to
the PTY cannot be retracted. A trailing space is normalized so consecutive
dictations don't run together. `ai_enabled` is hardcoded `false` (no command
matching). Selected `model_id` persists in `localStorage`
(`catgo-terminal-voice-model`).

### 4. Terminal UI — `TerminalPanel.svelte` (modified)

Add to the existing toolbar: a mic toggle button and an adjacent caret that
opens a small dropdown listing `WHISPER_MODELS` with the current download state
/ progress. Wiring:

- mic click → `terminal_voice.toggle((t) => panel_send_keys(t), voice_language)`
- recording state drives button styling (active/pulsing) via `$state`
- dropdown selection → `terminal_voice.model_id = id` (reloads on next start)
- download progress shown inline (reuses `ModelProgressCallback` 0..1)
- unsupported env (no `getUserMedia`) → button disabled + tooltip

`MobileTerminal.svelte` is not touched.

## Data flow (end to end)

1. User clicks mic. If chosen model not cached, Transformers.js downloads it
   (progress shown); subsequent uses load from IndexedDB.
2. `getUserMedia` prompts for mic permission (browser-handled).
3. Silero VAD slices speech; each segment is transcribed locally by the chosen
   Whisper model.
4. Final transcript → `panel_send_keys(text)` → PTY → xterm shows it at the
   cursor. **No Enter is sent.** The user edits/submits manually.
5. User clicks mic again to stop.

## Error handling

- **Unsupported browser** (no `getUserMedia`): button disabled, tooltip
  explains. No crash.
- **Mic permission denied** (`DOMException`): engine surfaces `not-allowed`;
  controller resets `recording=false` and shows a non-blocking message.
- **Model download/inference failure:** `model_status='error'`, recording stops,
  message shown; retry by clicking again.
- **Empty / whitespace transcript:** dropped (no `send_keys`).

## Testing

- **`whisper-models.ts`** — unit test: registry non-empty, ids well-formed,
  default id present in the list.
- **`terminal-voice.svelte.ts`** — unit test with a mocked engine: only
  `is_final` events forward to `send`; interim events are ignored; empty
  transcript dropped; trailing-space normalization; `stop()` clears state. The
  engine is injected/mockable so tests don't touch real audio/models.
- **`get_pipeline` generalization** — unit test that an explicit `model_id` is
  honored and the language fallback still resolves for existing callers.
- **TerminalPanel wiring** — manual smoke test on desktop (mic → speak → text
  appears at prompt, no Enter; model dropdown downloads + switches).

## File summary

| File | Change |
| --- | --- |
| `src/lib/gesture/whisper-models.ts` | new — model registry |
| `src/lib/gesture/local-whisper.ts` | modify — `get_pipeline`/engine accept explicit `model_id` |
| `src/lib/structure/terminal-voice.svelte.ts` | new — terminal voice controller |
| `src/lib/structure/TerminalPanel.svelte` | modify — mic button + model dropdown + wiring |
| `src/lib/i18n/{en,zh}/*.ts` | modify — labels: mic button, model names, unsupported/permission messages (en/zh parity) |
| test files | new — registry + controller + pipeline unit tests |

## Open questions / risks

- Exact `onnx-community/whisper-*` repo ids and which sizes have q8 ONNX builds
  must be confirmed at implementation time (drop unsupported sizes).
- `medium` is large (~1.5 GB); acceptable as an opt-in entry, surfaced with its
  size in the dropdown.
- WebGPU vs WASM performance varies; `device: 'auto'` already handles fallback.
