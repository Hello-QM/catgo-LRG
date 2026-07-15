<script lang="ts">
  // Modal dialog driving one offline path-traced still render.
  // Pattern follows HpcUploadDialog: fixed overlay + self-contained panel.
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { detect_render_still_capability } from './capability'
  import type { RenderStillCapability } from './capability'
  import { RenderStillSession } from './session'
  import type { RenderStillStatus, SphereDetail } from './session'

  load_i18n_module('structure')

  let {
    show = $bindable(false),
    // The wrapper div around the live viewer canvas (ExportPane's `wrapper`).
    wrapper = undefined,
    structure_name = 'structure',
  }: {
    show?: boolean
    wrapper?: HTMLDivElement
    structure_name?: string
  } = $props()

  interface ResolutionPreset {
    key: string
    width: number
    height: number
  }
  const RESOLUTION_PRESETS: ResolutionPreset[] = [
    { key: 'hd', width: 1920, height: 1080 },
    { key: 'qhd', width: 2560, height: 1440 },
    { key: 'uhd', width: 3840, height: 2160 },
    { key: 'square', width: 2048, height: 2048 },
  ]

  let capability = $state<RenderStillCapability | null>(null)
  let resolution_key = $state('hd')
  let custom_width = $state(1920)
  let custom_height = $state(1080)
  let samples = $state(100)
  let bounces = $state(5)
  let sphere_detail = $state<SphereDetail>('standard')

  let session = $state<RenderStillSession | null>(null)
  let status = $state<RenderStillStatus>('idle')
  let sample_count = $state(0)
  let sample_target = $state(1)
  let error_message = $state<string | null>(null)
  let saving = $state(false)
  let render_started_at = 0
  let elapsed_s = $state(0)
  let preview_host = $state<HTMLDivElement | null>(null)

  const rendering = $derived(
    status === 'baking' || status === 'building-bvh' || status === 'sampling',
  )
  const has_image = $derived(sample_count >= 1)
  const progress_pct = $derived(
    status === 'done' ? 100 : Math.min(100, (sample_count / sample_target) * 100),
  )

  const target_size = $derived.by((): { width: number; height: number } => {
    if (resolution_key === 'custom') {
      return {
        width: clamp_dim(custom_width),
        height: clamp_dim(custom_height),
      }
    }
    if (resolution_key === 'view') {
      const canvas = wrapper?.querySelector('canvas')
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        return { width: canvas.width, height: canvas.height }
      }
      return { width: 1920, height: 1080 }
    }
    const preset = RESOLUTION_PRESETS.find((p) => p.key === resolution_key)
    return preset
      ? { width: preset.width, height: preset.height }
      : { width: 1920, height: 1080 }
  })

  function clamp_dim(v: number): number {
    if (!Number.isFinite(v)) return 64
    return Math.max(16, Math.min(8192, Math.round(v)))
  }

  // Probe GPU capability when the dialog opens (memoized in the module).
  $effect(() => {
    if (show) capability = detect_render_still_capability()
  })

  function teardown_session(): void {
    session?.dispose()
    session = null
    status = 'idle'
    sample_count = 0
    error_message = null
  }

  function close(): void {
    teardown_session()
    show = false
  }

  // Full cleanup if the component unmounts with a live session.
  $effect(() => () => session?.dispose())

  async function start(): Promise<void> {
    const canvas = wrapper?.querySelector('canvas') as HTMLCanvasElement | null
    if (!canvas) {
      error_message = t('structure.render_still_no_canvas')
      return
    }
    teardown_session()
    const { width, height } = target_size
    sample_target = Math.max(1, Math.round(samples))
    render_started_at = performance.now()
    elapsed_s = 0
    try {
      const next = RenderStillSession.from_canvas(canvas, {
        width,
        height,
        samples: sample_target,
        bounces: Math.max(1, Math.min(16, Math.round(bounces))),
        sphere_detail,
        on_status: (next_status) => {
          status = next_status
        },
        on_progress: (done) => {
          sample_count = done
          elapsed_s = (performance.now() - render_started_at) / 1000
        },
        on_error: (message) => {
          error_message = message
        },
      })
      session = next
      // Mount the pathtracer's own canvas as the live progressive preview.
      if (preview_host) {
        preview_host.replaceChildren(next.preview_canvas)
        next.preview_canvas.style.maxWidth = '100%'
        next.preview_canvas.style.height = 'auto'
        next.preview_canvas.style.display = 'block'
        next.preview_canvas.style.borderRadius = '4px'
      }
      await next.start()
    } catch (err) {
      status = 'error'
      error_message = err instanceof Error ? err.message : String(err)
    }
  }

  function cancel(): void {
    session?.cancel()
  }

  async function save(): Promise<void> {
    if (!session || saving) return
    saving = true
    try {
      const { width, height } = target_size
      const name = `${structure_name || 'structure'}-still-${width}x${height}-${
        Math.max(1, sample_count)
      }spp.png`
      await session.save_png(name)
    } finally {
      saving = false
    }
  }

  function status_label(current: RenderStillStatus): string {
    if (current === 'baking') return t('structure.render_still_status_baking')
    if (current === 'building-bvh') return t('structure.render_still_status_bvh')
    if (current === 'sampling') {
      return t('structure.render_still_status_sampling', {
        n: sample_count,
        total: sample_target,
      })
    }
    if (current === 'done') return t('structure.render_still_status_done')
    if (current === 'cancelled') return t('structure.render_still_status_cancelled')
    if (current === 'error') return t('structure.render_still_status_error')
    return ''
  }
</script>

{#if show}
  <div
    class="render-still-overlay"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) close()
    }}
  >
    <div class="render-still-dialog" role="dialog" aria-modal="true">
      <header>
        <h3>{t('structure.render_still_title')}</h3>
        <button class="close-x" onclick={close} title={t('common.close')}>✕</button>
      </header>

      {#if capability && !capability.supported}
        <p class="unsupported">
          {capability.reason === 'no-webgl2'
            ? t('structure.render_still_no_webgl2')
            : t('structure.render_still_no_float')}
        </p>
      {:else}
        {#if capability?.software}
          <p class="software-warning">{t('structure.render_still_software_warning')}</p>
        {/if}

        <div class="controls" class:disabled={rendering}>
          <label class="field">
            <span>{t('structure.render_still_resolution')}</span>
            <select bind:value={resolution_key} disabled={rendering}>
              <option value="view">{t('structure.render_still_current_view')}</option>
              {#each RESOLUTION_PRESETS as preset (preset.key)}
                <option value={preset.key}>{preset.width} × {preset.height}</option>
              {/each}
              <option value="custom">{t('structure.render_still_custom')}</option>
            </select>
          </label>
          {#if resolution_key === 'custom'}
            <label class="field num">
              <span>W</span>
              <input type="number" min="16" max="8192" bind:value={custom_width} disabled={rendering} />
            </label>
            <label class="field num">
              <span>H</span>
              <input type="number" min="16" max="8192" bind:value={custom_height} disabled={rendering} />
            </label>
          {/if}
          <label class="field num">
            <span>{t('structure.render_still_samples')}</span>
            <input type="number" min="1" max="5000" bind:value={samples} disabled={rendering} />
          </label>
          <label class="field num">
            <span>{t('structure.render_still_bounces')}</span>
            <input type="number" min="1" max="16" bind:value={bounces} disabled={rendering} />
          </label>
          <label class="field">
            <span>{t('structure.render_still_quality')}</span>
            <select bind:value={sphere_detail} disabled={rendering}>
              <option value="standard">{t('structure.render_still_quality_standard')}</option>
              <option value="high">{t('structure.render_still_quality_high')}</option>
            </select>
          </label>
        </div>

        <div class="actions">
          {#if rendering}
            <button class="primary" onclick={cancel}>{t('common.cancel')}</button>
          {:else}
            <button class="primary" onclick={start}>
              {status === 'done' || status === 'cancelled'
                ? t('structure.render_still_rerender')
                : t('structure.render_still_start')}
            </button>
          {/if}
          <button disabled={!has_image || saving} onclick={save}>
            {saving ? '…' : t('structure.render_still_save_png')}
          </button>
        </div>

        {#if status !== 'idle'}
          <div class="progress-row">
            <div class="progress-bar">
              <div class="progress-fill" style="width: {progress_pct}%"></div>
            </div>
            <span class="status-text">
              {status_label(status)}
              {#if elapsed_s > 0 && (status === 'sampling' || status === 'done' || status === 'cancelled')}
                · {elapsed_s.toFixed(1)}s
              {/if}
            </span>
          </div>
        {/if}
        {#if error_message}
          <p class="error">{error_message}</p>
        {/if}

        <div class="preview" bind:this={preview_host}></div>
        <p class="hint">{t('structure.render_still_hint')}</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .render-still-overlay {
    position: fixed;
    inset: 0;
    z-index: 2000;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    overflow: auto;
    box-sizing: border-box;
  }
  .render-still-dialog {
    width: min(640px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
    background: var(--surface-bg, #1e1e1e);
    color: var(--text-color, #ddd);
    border: 1px solid var(--border-color, #444);
    border-radius: 8px;
    padding: 14px 16px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-sizing: border-box;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  header h3 {
    margin: 0;
    font-size: 1.05em;
  }
  .close-x {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 1.1em;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    align-items: flex-end;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 0.85em;
  }
  .field select,
  .field input {
    background: var(--bg-color, #2a2a2a);
    color: inherit;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    padding: 3px 6px;
  }
  .field.num input {
    width: 5.5em;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .actions button {
    padding: 4px 14px;
    border-radius: 4px;
    border: 1px solid var(--border-color, #444);
    background: var(--bg-color, #2a2a2a);
    color: inherit;
    cursor: pointer;
  }
  .actions button.primary {
    background: var(--accent-color, #1a73e8);
    border-color: transparent;
    color: white;
  }
  .actions button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .progress-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .progress-bar {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: var(--border-color, #444);
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: var(--accent-color, #1a73e8);
    transition: width 0.15s linear;
  }
  .status-text {
    font-size: 0.8em;
    color: var(--text-color-dim, #999);
    white-space: nowrap;
  }
  .preview {
    min-height: 40px;
    background: repeating-conic-gradient(#2224 0% 25%, transparent 0% 50%) 0 0 / 16px 16px;
    border-radius: 4px;
  }
  .hint,
  .unsupported {
    font-size: 0.8em;
    color: var(--text-color-dim, #999);
    margin: 0;
  }
  .software-warning {
    font-size: 0.82em;
    color: #e6a23c;
    margin: 0;
  }
  .error {
    font-size: 0.82em;
    color: #e05252;
    margin: 0;
  }
  .controls.disabled {
    opacity: 0.7;
  }
</style>
