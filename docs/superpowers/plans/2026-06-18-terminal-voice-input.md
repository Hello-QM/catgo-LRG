# Terminal Voice Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a microphone button (+ model dropdown) to the desktop terminal so the user can dictate into the shell / Claude Code; speech is transcribed locally and typed at the cursor without auto-Enter.

**Architecture:** Reuse CatGo's existing in-browser STT pipeline (`local-whisper.ts`: Transformers.js + Silero VAD + IndexedDB-cached on-demand model download). Generalize the hardcoded model id into a selectable registry. A thin per-terminal controller bridges the engine's final transcripts to `panel_send_keys()`. No Web Speech, no voxpilot Node port, no new dependencies.

**Tech Stack:** Svelte 5 runes, TypeScript, `@huggingface/transformers` (already a dependency), Vitest.

## Global Constraints

- **Desktop only.** Do not touch `src/lib/mobile/MobileTerminal.svelte` or any mobile path.
- **No new runtime dependencies.** `@huggingface/transformers` is already present.
- **Do NOT use the Web Speech API** (`SpeechRecognition`) anywhere in this feature.
- **No auto-Enter.** Transcripts are typed into the PTY only; the user submits manually.
- **Pure dictation:** call the engine with `ai_enabled = false` (no voice-command matching).
- **Project style** (enforced by `deno fmt`, but `deno` is NOT installed here — write it by hand): single quotes, no semicolons, 2-space indent, ~90 col. `.svelte` files are excluded from `deno fmt`.
- **Only `is_final` transcripts are sent** — interim hypotheses must never reach the PTY (already-written bytes cannot be retracted).
- **i18n note:** `TerminalPanel.svelte` uses literal English strings for control `title`s (e.g. `title="Font settings"`). Follow that existing pattern — use literal strings, do NOT add i18n keys for this feature.
- Run tests with `pnpm test` (vitest) and type-check with `pnpm check` (svelte-check). Both run from the repo root.

---

### Task 1: Whisper model registry

A pure-data module listing selectable models plus a resolver. No engine/network code, so it is fully unit-testable.

**Files:**
- Create: `src/lib/gesture/whisper-models.ts`
- Test: `src/lib/gesture/whisper-models.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface WhisperModel { id: string; label: string; size_mb: number; multilingual: boolean }`
  - `const WHISPER_MODELS: WhisperModel[]`
  - `const DEFAULT_WHISPER_MODEL_ID: string` (= `'onnx-community/whisper-base'`)
  - `function resolve_model_id(explicit: string | undefined, language: string): string`
    — returns `explicit` if it is a known model id; else the English-only model for `language === 'en'`/`'en-US'`, otherwise the multilingual default.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/gesture/whisper-models.test.ts
import { describe, it, expect } from 'vitest'
import {
  WHISPER_MODELS,
  DEFAULT_WHISPER_MODEL_ID,
  resolve_model_id,
} from './whisper-models'

describe('whisper-models registry', () => {
  it('is non-empty and every id is namespaced under onnx-community', () => {
    expect(WHISPER_MODELS.length).toBeGreaterThan(0)
    for (const m of WHISPER_MODELS) {
      expect(m.id).toMatch(/^onnx-community\/whisper-/)
      expect(m.label.length).toBeGreaterThan(0)
      expect(m.size_mb).toBeGreaterThan(0)
    }
  })

  it('exposes a default id that exists in the registry', () => {
    expect(WHISPER_MODELS.some((m) => m.id === DEFAULT_WHISPER_MODEL_ID)).toBe(true)
  })

  it('resolve_model_id honors an explicit known id', () => {
    const known = WHISPER_MODELS[0].id
    expect(resolve_model_id(known, 'en')).toBe(known)
  })

  it('resolve_model_id ignores an unknown explicit id and falls back', () => {
    const out = resolve_model_id('totally/unknown', 'en')
    expect(WHISPER_MODELS.some((m) => m.id === out)).toBe(true)
  })

  it('resolve_model_id picks an English-only model for en and a multilingual one otherwise', () => {
    const en = resolve_model_id(undefined, 'en-US')
    const multi = resolve_model_id(undefined, 'zh-CN')
    expect(WHISPER_MODELS.find((m) => m.id === en)?.multilingual).toBe(false)
    expect(WHISPER_MODELS.find((m) => m.id === multi)?.multilingual).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/lib/gesture/whisper-models.test.ts`
Expected: FAIL — `Cannot find module './whisper-models'`.

- [ ] **Step 3: Verify the model ids actually exist (manual, one-time)**

For each id below, confirm the HuggingFace repo exists and has an ONNX build (open `https://huggingface.co/<id>/tree/main/onnx` in a browser, or `curl -sI https://huggingface.co/<id>/resolve/main/config.json` → expect `200`/`302`). Drop any id that 404s from the array in Step 4 and `console.warn` is NOT needed (it is compile-time data). These ids are known-good on `onnx-community` at time of writing:

```
onnx-community/whisper-tiny.en
onnx-community/whisper-tiny
onnx-community/whisper-base.en
onnx-community/whisper-base
onnx-community/whisper-small.en
onnx-community/whisper-small
onnx-community/whisper-large-v3-turbo
```

Note: a dedicated `whisper-medium` ONNX build may be absent on `onnx-community`. If `onnx-community/whisper-medium` 404s, ship `whisper-large-v3-turbo` (≈800 MB q4, multilingual, faster than medium) as the "Large (turbo)" entry instead of medium, and say so in the commit message. Do not invent an id that does not resolve.

- [ ] **Step 4: Write the implementation**

```ts
// src/lib/gesture/whisper-models.ts
/**
 * Selectable Whisper ASR models for local in-browser transcription.
 *
 * All run via Transformers.js (WebGPU/WASM); models download on demand from the
 * HuggingFace Hub and are cached in IndexedDB. Sizes are approximate q8/q4
 * download sizes, shown in the picker so the user knows what they are fetching.
 */

export interface WhisperModel {
  id: string // HuggingFace repo id
  label: string // short UI label
  size_mb: number // approx download size
  multilingual: boolean // false = English-only (.en)
}

export const WHISPER_MODELS: WhisperModel[] = [
  { id: `onnx-community/whisper-tiny.en`, label: `Tiny (English)`, size_mb: 40, multilingual: false },
  { id: `onnx-community/whisper-tiny`, label: `Tiny (multilingual)`, size_mb: 40, multilingual: true },
  { id: `onnx-community/whisper-base.en`, label: `Base (English)`, size_mb: 80, multilingual: false },
  { id: `onnx-community/whisper-base`, label: `Base (multilingual)`, size_mb: 80, multilingual: true },
  { id: `onnx-community/whisper-small.en`, label: `Small (English)`, size_mb: 250, multilingual: false },
  { id: `onnx-community/whisper-small`, label: `Small (multilingual)`, size_mb: 250, multilingual: true },
  { id: `onnx-community/whisper-large-v3-turbo`, label: `Large turbo (multilingual)`, size_mb: 800, multilingual: true },
]

export const DEFAULT_WHISPER_MODEL_ID = `onnx-community/whisper-base`

/** Resolve which model id to load given an optional explicit choice + language. */
export function resolve_model_id(explicit: string | undefined, language: string): string {
  if (explicit && WHISPER_MODELS.some((m) => m.id === explicit)) return explicit
  const is_en = language === `en` || language.startsWith(`en-`)
  if (is_en) {
    const en = WHISPER_MODELS.find((m) => !m.multilingual)
    if (en) return en.id
  }
  return DEFAULT_WHISPER_MODEL_ID
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- src/lib/gesture/whisper-models.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/gesture/whisper-models.ts src/lib/gesture/whisper-models.test.ts
git commit -m "feat(voice): selectable Whisper model registry"
```

---

### Task 2: Thread an explicit model id through the local-whisper pipeline

Generalize `get_pipeline` and `preload_whisper_model` (currently hardcoded to whisper-tiny) to accept any model id, and let `LocalWhisperEngine` take an optional `model_id`. Existing callers (gesture nav, chat) keep working via the language fallback. NOTE (recorded post-review): the multilingual default shifts from `whisper-tiny` to `whisper-base` (= `DEFAULT_WHISPER_MODEL_ID`), so the gesture/chat *non-English* path now loads the larger, more accurate base model on first use (English path unchanged). Accepted as an intentional accuracy upgrade.

**Files:**
- Modify: `src/lib/gesture/local-whisper.ts`
- Test: `src/lib/gesture/__tests__/local-whisper.test.ts` (repo convention: tests live in `__tests__/`)

**Interfaces:**
- Consumes: `resolve_model_id`, `DEFAULT_WHISPER_MODEL_ID` from `./whisper-models` (Task 1).
- Produces:
  - `get_pipeline(model_id: string, on_progress?: ModelProgressCallback): Promise<any>` (signature changes from `language` to `model_id`).
  - `preload_whisper_model(language?: string, on_progress?: ModelProgressCallback, model_id?: string): Promise<void>` (adds optional `model_id`).
  - `LocalWhisperEngine.start(callback, language?, ai_enabled?, on_error?, noise_suppression?, model_id?)` (adds trailing optional `model_id`).
  - `LocalWhisperEngine.current_model_id: string | null` (getter, for tests/UI).

- [ ] **Step 1: Write the failing test**

`@huggingface/transformers` is dynamically imported inside `get_pipeline`, so `vi.mock` it. `preload_whisper_model` does NOT touch the mic or VAD, so it is safe to call in jsdom.

```ts
// src/lib/gesture/__tests__/local-whisper.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const pipeline_spy = vi.fn(async () => async () => ({ text: `` }))

vi.mock('@huggingface/transformers', () => ({
  pipeline: (...args: any[]) => pipeline_spy(...args),
  env: { backends: { onnx: { wasm: {} } } },
}))

describe('local-whisper model id threading', () => {
  beforeEach(() => {
    pipeline_spy.mockClear()
    vi.resetModules()
  })

  it('preload uses an explicit model id verbatim', async () => {
    const { preload_whisper_model } = await import('../local-whisper')
    await preload_whisper_model('en', undefined, 'onnx-community/whisper-small')
    expect(pipeline_spy).toHaveBeenCalledWith(
      'automatic-speech-recognition',
      'onnx-community/whisper-small',
      expect.anything(),
    )
  })

  it('preload falls back to a registry model when no id given', async () => {
    const { preload_whisper_model } = await import('../local-whisper')
    const { WHISPER_MODELS } = await import('../whisper-models')
    await preload_whisper_model('zh-CN')
    const used = pipeline_spy.mock.calls[0][1]
    expect(WHISPER_MODELS.some((m) => m.id === used)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/lib/gesture/__tests__/local-whisper.test.ts`
Expected: FAIL — `preload_whisper_model` ignores the 3rd arg / pipeline called with `onnx-community/whisper-tiny`.

- [ ] **Step 3: Edit `local-whisper.ts`**

Replace the model constants + `get_pipeline` signature (lines ~22–77) and update `preload_whisper_model` and the engine. Concretely:

1. At the top, add the import:

```ts
import { resolve_model_id } from './whisper-models'
```

2. Delete the two `MODEL_EN` / `MODEL_MULTI` constants and change `get_pipeline` to take a model id:

```ts
async function get_pipeline(
  model_id: string,
  on_progress?: ModelProgressCallback,
): Promise<any> {
  // Return cached pipeline if same model
  if (pipeline_promise && current_model_id === model_id) {
    return pipeline_promise
  }

  // New model needed — reset
  pipeline_promise = null
  current_model_id = model_id

  on_progress?.(`loading`)

  pipeline_promise = (async () => {
    const { pipeline, env } = await import(`@huggingface/transformers`)

    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 1
    }

    on_progress?.(`downloading`, 0)

    const pipe = await pipeline(`automatic-speech-recognition`, model_id, {
      dtype: `q8`,
      device: `auto`,
      progress_callback: (data: any) => {
        if (data.status === `progress` && typeof data.progress === `number`) {
          on_progress?.(`downloading`, data.progress)
        }
      },
    })

    on_progress?.(`ready`)
    return pipe
  })()

  try {
    return await pipeline_promise
  } catch (err) {
    pipeline_promise = null
    current_model_id = null
    on_progress?.(`error`)
    throw err
  }
}
```

3. Update `preload_whisper_model` to accept and resolve a model id:

```ts
/** Pre-load a Whisper model (e.g. from settings UI). */
export async function preload_whisper_model(
  language = `en`,
  on_progress?: ModelProgressCallback,
  model_id?: string,
): Promise<void> {
  await get_pipeline(resolve_model_id(model_id, language), on_progress)
}
```

4. In `LocalWhisperEngine`, add a field and getter and thread the id:

```ts
  private model_id: string | null = null

  get current_model_id(): string | null {
    return this.model_id
  }
```

Change `start(...)` to accept a trailing `model_id?: string`, set `this.model_id = resolve_model_id(model_id, language)`, and replace the `await get_pipeline(this.language, this.on_progress)` call with `await get_pipeline(this.model_id, this.on_progress)`.

In `transcribe_local`, replace `const pipe = await get_pipeline(this.language, this.on_progress)` with `const pipe = await get_pipeline(this.model_id ?? resolve_model_id(undefined, this.language), this.on_progress)`.

In `set_language`, replace the `pipeline_promise = null; current_model_id = null` reset block so it also recomputes `this.model_id = resolve_model_id(undefined, new_lang)` (only when no explicit model was pinned — keep it simple: always recompute from language here, since `set_language` is the language-driven path).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/lib/gesture/__tests__/local-whisper.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify no regression in existing callers**

Run: `pnpm test` and `pnpm check`
Expected: full suite green; type-check shows no NEW errors (the repo has ~15 pre-existing `bond_scale` errors inherited from main — ignore those).

- [ ] **Step 6: Commit**

```bash
git add src/lib/gesture/local-whisper.ts src/lib/gesture/__tests__/local-whisper.test.ts
git commit -m "feat(voice): let local-whisper load any registry model id"
```

---

### Task 3: Terminal voice controller

A small per-terminal class that owns recording + model state and forwards only final transcripts to a `send` callback. The engine is injected via a factory so the controller is unit-testable without a mic.

**Files:**
- Create: `src/lib/structure/terminal-voice.svelte.ts`
- Test: `src/lib/structure/__tests__/terminal-voice.test.ts` (repo convention: tests live in `__tests__/`)

**Interfaces:**
- Consumes: `DEFAULT_WHISPER_MODEL_ID` from `$lib/gesture/whisper-models`; `LocalWhisperEngine`, `ModelStatus` from `$lib/gesture/local-whisper`; `VoiceEvent` from `$lib/gesture/gesture-types`.
- Produces:
  - `interface VoiceEngineLike { is_supported: boolean; start(cb, language, ai, onErr, noise, modelId): void | Promise<void>; stop(): void }`
  - `class TerminalVoice` with reactive fields `recording: boolean`, `model_status: ModelStatus`, `download_progress: number`, `model_id: string`; getter `is_supported`; methods `async toggle(send: (text: string) => void, language?: string): Promise<void>` and `stop(): void`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/structure/__tests__/terminal-voice.test.ts
import { describe, it, expect, vi } from 'vitest'
import { TerminalVoice } from '../terminal-voice.svelte'
import type { VoiceEvent } from '$lib/gesture/gesture-types'

function fake_event(text: string, is_final: boolean): VoiceEvent {
  return {
    action: { type: `none` } as any,
    raw_text: text,
    confidence: 0.9,
    is_final,
    match_score: 0,
    timestamp: 0,
  }
}

// A controllable fake engine that lets the test fire transcript events.
function make_fake() {
  let cb: ((e: VoiceEvent) => void) | null = null
  const engine = {
    is_supported: true,
    start: vi.fn((c: any) => { cb = c }),
    stop: vi.fn(() => { cb = null }),
  }
  return { engine, fire: (e: VoiceEvent) => cb?.(e) }
}

describe('TerminalVoice', () => {
  it('forwards only final transcripts to send, with a trailing space', async () => {
    const { engine, fire } = make_fake()
    const tv = new TerminalVoice(() => engine)
    const sent: string[] = []
    await tv.toggle((t) => sent.push(t))
    expect(tv.recording).toBe(true)

    fire(fake_event(`hello`, false)) // interim — ignored
    fire(fake_event(`hello world`, true)) // final — sent
    expect(sent).toEqual([`hello world `])
  })

  it('drops empty / whitespace-only final transcripts', async () => {
    const { engine, fire } = make_fake()
    const tv = new TerminalVoice(() => engine)
    const sent: string[] = []
    await tv.toggle((t) => sent.push(t))
    fire(fake_event(`   `, true))
    expect(sent).toEqual([])
  })

  it('toggle a second time stops and clears recording', async () => {
    const { engine } = make_fake()
    const tv = new TerminalVoice(() => engine)
    await tv.toggle(() => {})
    await tv.toggle(() => {})
    expect(engine.stop).toHaveBeenCalled()
    expect(tv.recording).toBe(false)
  })

  it('reports unsupported when the engine is unsupported', () => {
    const tv = new TerminalVoice(() => ({ is_supported: false, start: vi.fn(), stop: vi.fn() }))
    expect(tv.is_supported).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/lib/structure/__tests__/terminal-voice.test.ts`
Expected: FAIL — `Cannot find module './terminal-voice.svelte'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/structure/terminal-voice.svelte.ts
/**
 * Per-terminal voice-dictation controller.
 *
 * Bridges a local STT engine (LocalWhisperEngine by default) to the terminal:
 * only FINAL transcripts are forwarded to `send`, which the TerminalPanel wires
 * to panel_send_keys (no Enter). The engine is injected via a factory so this is
 * unit-testable without a microphone. Desktop only.
 */

import { LocalWhisperEngine, type ModelStatus } from '$lib/gesture/local-whisper'
import { DEFAULT_WHISPER_MODEL_ID } from '$lib/gesture/whisper-models'
import type { VoiceEvent } from '$lib/gesture/gesture-types'

export interface VoiceEngineLike {
  readonly is_supported: boolean
  start(
    cb: (e: VoiceEvent) => void,
    language?: string,
    ai_enabled?: boolean,
    on_error?: (err: string) => void,
    noise_suppression?: boolean,
    model_id?: string,
  ): void | Promise<void>
  stop(): void
}

const STORAGE_KEY = `catgo-terminal-voice-model`

export class TerminalVoice {
  recording = $state(false)
  model_status = $state<ModelStatus>(`idle`)
  download_progress = $state(0)
  model_id = $state(DEFAULT_WHISPER_MODEL_ID)
  error = $state<string | null>(null)

  private make_engine: () => VoiceEngineLike
  private engine: VoiceEngineLike | null = null

  constructor(make_engine?: () => VoiceEngineLike) {
    this.make_engine = make_engine
      ?? (() =>
        new LocalWhisperEngine((status, progress) => {
          this.model_status = status
          if (typeof progress === `number`) this.download_progress = progress
        }))
    if (typeof localStorage !== `undefined`) {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) this.model_id = saved
    }
  }

  get is_supported(): boolean {
    if (!this.engine) this.engine = this.make_engine()
    return this.engine.is_supported
  }

  set_model(id: string): void {
    this.model_id = id
    if (typeof localStorage !== `undefined`) localStorage.setItem(STORAGE_KEY, id)
  }

  async toggle(send: (text: string) => void, language = `en-US`): Promise<void> {
    if (this.recording) {
      this.stop()
      return
    }
    this.error = null
    if (!this.engine) this.engine = this.make_engine()

    const on_event = (e: VoiceEvent) => {
      if (!e.is_final) return
      const text = e.raw_text.trim()
      if (!text) return
      send(`${text} `)
    }
    const on_error = (err: string) => {
      this.error = err
      this.recording = false
    }

    this.recording = true
    try {
      await this.engine.start(on_event, language, false, on_error, false, this.model_id)
    } catch {
      this.recording = false
    }
  }

  stop(): void {
    this.recording = false
    this.engine?.stop()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/lib/structure/__tests__/terminal-voice.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/terminal-voice.svelte.ts src/lib/structure/__tests__/terminal-voice.test.ts
git commit -m "feat(voice): terminal voice-dictation controller"
```

---

### Task 4: Wire the mic button + model dropdown into TerminalPanel

Add the UI. Svelte component UI is not unit-tested in this repo, so this task is verified by type-check + a manual smoke test.

**Files:**
- Modify: `src/lib/structure/TerminalPanel.svelte`

**Interfaces:**
- Consumes: `TerminalVoice` from `./terminal-voice.svelte` (Task 3); `WHISPER_MODELS` from `$lib/gesture/whisper-models` (Task 1); existing `panel_send_keys` (line ~129) and `Icon` (`Mic` icon exists in `icons.ts`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add imports and controller instance**

Near the top imports (after the existing `import { Icon } from '$lib'` at line 6), add:

```ts
  import { TerminalVoice } from './terminal-voice.svelte'
  import { WHISPER_MODELS } from '$lib/gesture/whisper-models'
```

In the component's script state region (alongside other `$state` declarations, e.g. near `show_font_menu`), add:

```ts
  const voice = new TerminalVoice()
  let show_voice_menu = $state(false)
```

- [ ] **Step 2: Add the mic button + dropdown to the header controls**

Inside `<div class="terminal-panel-controls">` (opens at line ~762), add this block right after the font-settings `</div>` (the `.tp-dropdown-wrap` block ending ~line 813), before the `{#if on_cwd_change || session_id}` sync button:

```svelte
        <!-- Voice dictation: mic toggle + model picker -->
        <div class="tp-dropdown-wrap">
          <button
            class="terminal-voice-btn"
            class:active={voice.recording}
            disabled={!voice.is_supported}
            title={voice.is_supported
              ? (voice.recording ? `Stop dictation` : `Dictate into terminal`)
              : `Voice dictation needs microphone access (unsupported here)`}
            onclick={(e) => {
              e.stopPropagation()
              voice.toggle((t) => panel_send_keys(t))
            }}
          ><Icon icon="Mic" /></button>
          <button
            class="terminal-voice-caret"
            title="Choose speech model"
            onclick={(e) => { e.stopPropagation(); show_voice_menu = !show_voice_menu }}
          >▾</button>
          {#if show_voice_menu}
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div class="tp-font-dropdown" onclick={(e) => e.stopPropagation()}>
              <div class="tp-font-header">Speech model</div>
              {#each WHISPER_MODELS as m}
                <button
                  class="tp-voice-model"
                  class:selected={voice.model_id === m.id}
                  onclick={() => { voice.set_model(m.id); show_voice_menu = false }}
                >{m.label} · ~{m.size_mb}MB</button>
              {/each}
              {#if voice.model_status === `downloading`}
                <div class="tp-voice-progress">
                  Downloading… {Math.round(voice.download_progress)}%
                </div>
              {:else if voice.model_status === `error` || voice.error}
                <div class="tp-voice-progress error">Model failed — try again</div>
              {/if}
            </div>
          {/if}
        </div>
```

- [ ] **Step 3: Add minimal styles**

In the component `<style>` block, near the other `.terminal-*-btn` rules, add:

```css
  .terminal-voice-btn.active {
    color: #e5484d;
  }
  .terminal-voice-caret {
    padding: 0 2px;
    font-size: 10px;
    opacity: 0.7;
  }
  .tp-voice-model {
    display: block;
    width: 100%;
    text-align: left;
    padding: 4px 8px;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 12px;
  }
  .tp-voice-model.selected {
    font-weight: 600;
  }
  .tp-voice-model:hover {
    background: rgba(127, 127, 127, 0.15);
  }
  .tp-voice-progress {
    padding: 4px 8px;
    font-size: 11px;
    opacity: 0.8;
  }
  .tp-voice-progress.error {
    color: #e5484d;
  }
```

(If `.terminal-voice-btn` does not inherit base button styling, copy the selector list of an existing `.terminal-*-btn` rule to include `.terminal-voice-btn` so sizing/color match the neighbors.)

- [ ] **Step 4: Type-check**

Run: `pnpm check`
Expected: no NEW errors (ignore the ~15 pre-existing `bond_scale` errors from main).

- [ ] **Step 5: Manual smoke test (desktop)**

Run: `pnpm desktop:serve`, open a terminal pane.
- Click the mic → browser asks for mic permission → grant.
- First use of the selected model downloads (dropdown shows progress); speak a short phrase → the transcribed text appears at the shell prompt, **no Enter pressed**. Press Enter yourself → it runs.
- Open a Claude Code session in the terminal, dictate → text lands in Claude Code's input.
- Open the model dropdown, pick a different size → next dictation downloads/uses it.
- Confirm a second mic click stops listening.

- [ ] **Step 6: Commit**

```bash
git add src/lib/structure/TerminalPanel.svelte
git commit -m "feat(voice): mic button + model picker in the terminal toolbar"
```

---

## Self-Review

**Spec coverage:**
- On-demand model download + selection → Tasks 1, 2, 4. ✅
- Reuse local-whisper pipeline (no voxpilot Node) → Task 2 reuses it. ✅
- `LocalWhisperEngine`, not Web Speech → Task 3 default factory. ✅
- Transcript → `panel_send_keys`, no Enter → Task 3 (`send`) + Task 4 wiring. ✅
- Only `is_final`, drop empty, trailing-space normalize → Task 3 tests. ✅
- Desktop only, `MobileTerminal` untouched → Global Constraints; no task touches mobile. ✅
- Error handling (unsupported / permission / download / empty) → Task 3 (`error`, `is_supported`, empty-drop) + Task 4 (disabled button, progress/error UI). ✅
- Testing plan → Tasks 1–3 unit tests, Task 4 manual smoke. ✅
- **Deviations from spec (intentional):** (1) No i18n task — `TerminalPanel` uses literal English strings, so this feature follows that pattern (recorded in Global Constraints). (2) No separate language UI — passing `language='en'` makes Whisper auto-detect on multilingual models, so model choice alone covers Chinese/English. (3) Spec's `whisper-medium` may not have an ONNX build; Task 1 Step 3 substitutes `whisper-large-v3-turbo` if so.

**Placeholder scan:** No TBD/TODO; every code step has full code. ✅

**Type consistency:** `resolve_model_id`, `WHISPER_MODELS`, `DEFAULT_WHISPER_MODEL_ID`, `ModelStatus`, `VoiceEvent`, `TerminalVoice.toggle/stop/set_model/model_id/recording/model_status/download_progress`, `panel_send_keys` — names match across tasks. ✅
