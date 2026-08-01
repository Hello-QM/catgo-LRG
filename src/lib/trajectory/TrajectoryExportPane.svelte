<script lang="ts">
  import { DraggablePane, SettingsSection } from '$lib'
  import {
    export_trajectory_video,
    export_trajectory_png_sequence,
    get_ffmpeg_conversion_command,
    type CropRegion,
  } from '$lib/io/export'
  import { download } from '$lib/io/fetch'
  import { structure_to_poscar_str } from '$lib/structure/export'
  import { select_active_render_canvas } from '$lib/structure/scene/render-surface'
  import type { TrajectoryFrame, TrajectoryFrameResolver, TrajectoryType } from '$lib/trajectory'
  import {
    create_poscar_frame_range_zip,
    poscar_frame_filename,
    serialize_extxyz_frame_range,
    trajectory_export_basename,
  } from '$lib/trajectory/file-export'
  import type { ComponentProps } from 'svelte'
  import { tooltip } from 'svelte-multiselect/attachments'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('structure')

  let {
    export_pane_open = $bindable(false),
    trajectory = undefined,
    wrapper = undefined,
    filename = `trajectory`,
    video_fps = $bindable(30),
    resolution_multiplier = $bindable(1),
    on_step_change = undefined,
    png_dpi = $bindable(150),
    crop_region = null,
    pane_props = {},
    toggle_props = {},
    flush_pending_ops = undefined,
    resolve_frame = undefined,
    current_frame_idx = 0,
    ...rest
  }: {
    // Control pane state
    export_pane_open?: boolean
    // Trajectory data for generating filename
    trajectory?: TrajectoryType
    // Canvas wrapper for video export
    wrapper?: HTMLDivElement
    // Filename for export
    filename?: string
    // Export settings
    video_fps?: number
    resolution_multiplier?: number
    // Function to change trajectory step during export
    on_step_change?: (step_idx: number) => Promise<void> | void
    // PNG sequence settings
    png_dpi?: number
    crop_region?: CropRegion | null
    // Pane customization
    pane_props?: ComponentProps<typeof DraggablePane>[`pane_props`]
    toggle_props?: ComponentProps<typeof DraggablePane>[`toggle_props`]
    max_height?: string
    // Flush any pending cross-frame edits before reading all frames.
    // Parent (Trajectory.svelte) passes this so we can materialize lazy ops
    // before serializing — otherwise exported frames would be stale.
    flush_pending_ops?: () => void
    // Fully resolve edited in-memory or streamed frames for structure exports.
    resolve_frame?: TrajectoryFrameResolver
    // The frame currently visible in the viewer (used by Current POSCAR).
    current_frame_idx?: number
  } = $props()

  let is_exporting = $state(false)
  let export_progress = $state(0)
  let export_format = $state<`webm` | `mp4`>(`webm`)
  let export_error = $state<string | null>(null)
  let is_exporting_structures = $state(false)
  let structure_export_progress = $state(0)

  let total_frames_available = $derived(
    trajectory?.total_frames || trajectory?.frames?.length || 0,
  )

  let start_frame = $state(0)
  let end_frame = $state(0)

  // The WebGL <canvas> mounts asynchronously — after the trajectory parses and
  // StructureScene initializes — which is AFTER `wrapper` is already bound. A
  // one-shot `wrapper.querySelector('canvas')` in $derived runs too early (canvas
  // doesn't exist yet) and never re-checks, since querySelector isn't reactive
  // and the wrapper reference never changes. Mirror the working pattern in
  // ExportPane.svelte: observe the subtree and update reactive $state.
  let canvas = $state<HTMLCanvasElement | null>(null)
  $effect(() => {
    if (!wrapper) {
      canvas = null
      return
    }
    // Visual T6: video capture must record the ACTIVE render canvas (WebGPU
    // overlay vs kept-warm WebGL), not blindly the first <canvas>.
    const check = () => (canvas = select_active_render_canvas(wrapper))
    check()
    const observer = new MutationObserver(check)
    observer.observe(wrapper, { childList: true, subtree: true })
    return () => observer.disconnect()
  })

  // Estimated file size in MB
  let file_size_mb = $derived.by(() => {
    if (!canvas) return 0
    const pixels = canvas.width * canvas.height * resolution_multiplier ** 2
    const bitrate = Math.max(1e6, Math.min(pixels * video_fps * 0.1, 2e8))
    return (bitrate * export_frame_count / video_fps) / 8 / 1024 / 1024
  })

  // Initialize end_frame when trajectory changes
  $effect(() => {
    if (total_frames_available > 0) {
      end_frame = total_frames_available - 1
    }
  })

  // Validate and constrain frame range
  $effect(() => {
    if (start_frame < 0) start_frame = 0
    if (start_frame >= total_frames_available) {
      start_frame = Math.max(0, total_frames_available - 1)
    }
    if (end_frame < start_frame) end_frame = start_frame
    if (end_frame >= total_frames_available) {
      end_frame = Math.max(0, total_frames_available - 1)
    }
  })

  let export_frame_count = $derived(
    end_frame >= start_frame ? end_frame - start_frame + 1 : 0,
  )

  async function handle_video_export(format: `webm` | `mp4` = `webm`) {
    export_error = null

    // Validate
    if (!trajectory || !on_step_change || !canvas || export_frame_count === 0) {
      export_error = !trajectory
        ? t('structure.no_trajectory')
        : !on_step_change
        ? t('structure.step_change_handler_missing')
        : !canvas
        ? t('structure.canvas_not_ready')
        : t('structure.invalid_frame_range')
      return
    }

    export_format = format
    is_exporting = true
    export_progress = 0

    try {
      await export_trajectory_video(canvas, `${filename}.webm`, {
        fps: video_fps,
        total_frames: export_frame_count,
        resolution_multiplier,
        on_progress: (progress) => (export_progress = progress),
        on_step: async (idx) => await on_step_change(start_frame + idx),
      })

      if (format === `mp4`) {
        navigator.clipboard
          .writeText(get_ffmpeg_conversion_command(`${filename}.webm`))
          .catch(console.warn)
      }

      export_progress = 100
      setTimeout(() => {
        is_exporting = false
        export_progress = 0
      }, 1000)
    } catch (error) {
      console.error(`Export failed:`, error)
      export_error = error instanceof Error ? error.message : String(error)
      is_exporting = false
      export_progress = 0
    }
  }

  let is_exporting_pngs = $state(false)
  let png_export_progress = $state(0)

  async function handle_png_sequence_export() {
    export_error = null

    if (!trajectory || !on_step_change || !canvas || export_frame_count === 0) {
      export_error = !trajectory
        ? t('structure.no_trajectory')
        : !on_step_change
        ? t('structure.step_change_handler_missing')
        : !canvas
        ? t('structure.canvas_not_ready')
        : t('structure.invalid_frame_range')
      return
    }

    is_exporting_pngs = true
    png_export_progress = 0

    try {
      await export_trajectory_png_sequence(canvas, filename, {
        frame_indices: Array.from({length: export_frame_count}, (_, i) => i),
        png_dpi,
        crop_region,
        on_progress: (progress) => (png_export_progress = progress),
        on_step: async (idx) => await on_step_change(start_frame + idx),
      })

      png_export_progress = 100
      setTimeout(() => {
        is_exporting_pngs = false
        png_export_progress = 0
      }, 1000)
    } catch (error) {
      console.error(`PNG sequence export failed:`, error)
      export_error = error instanceof Error ? error.message : String(error)
      is_exporting_pngs = false
      png_export_progress = 0
    }
  }

  async function export_frame(idx: number): Promise<TrajectoryFrame | null> {
    if (resolve_frame) return resolve_frame(idx)
    flush_pending_ops?.()
    return trajectory?.frames?.[idx] ?? null
  }

  async function handle_trajectory_text_export(extension: `xyz` | `extxyz`) {
    export_error = null
    if (!trajectory || export_frame_count === 0) {
      export_error = !trajectory ? t('structure.no_trajectory') : t('structure.invalid_frame_range')
      return
    }
    is_exporting_structures = true
    structure_export_progress = 0
    try {
      const content = await serialize_extxyz_frame_range(
        start_frame,
        end_frame,
        export_frame,
        (done, total) => (structure_export_progress = (done / total) * 100),
      )
      download(
        content,
        `${trajectory_export_basename(filename)}.${extension}`,
        `chemical/x-xyz`,
      )
    } catch (error) {
      export_error = error instanceof Error ? error.message : String(error)
    } finally {
      is_exporting_structures = false
      structure_export_progress = 0
    }
  }

  async function handle_current_poscar_export() {
    export_error = null
    if (!trajectory || total_frames_available === 0) {
      export_error = t('structure.no_trajectory')
      return
    }
    is_exporting_structures = true
    try {
      const idx = Math.max(0, Math.min(current_frame_idx, total_frames_available - 1))
      const frame = await export_frame(idx)
      if (!frame?.structure) throw new Error(`Trajectory frame ${idx} is not available for export`)
      const content = `${structure_to_poscar_str(frame.structure)}\n`
      download(
        content,
        poscar_frame_filename(filename, idx, total_frames_available),
        `chemical/x-vasp-poscar`,
      )
    } catch (error) {
      export_error = error instanceof Error ? error.message : String(error)
    } finally {
      is_exporting_structures = false
    }
  }

  async function handle_poscar_sequence_export() {
    export_error = null
    if (!trajectory || export_frame_count === 0) {
      export_error = !trajectory ? t('structure.no_trajectory') : t('structure.invalid_frame_range')
      return
    }
    is_exporting_structures = true
    structure_export_progress = 0
    try {
      const blob = await create_poscar_frame_range_zip(
        start_frame,
        end_frame,
        export_frame,
        filename,
        total_frames_available,
        (done, total) => (structure_export_progress = (done / total) * 100),
      )
      download(
        blob,
        `${trajectory_export_basename(filename)}_poscar_frames_${start_frame}-${end_frame}.zip`,
        `application/zip`,
      )
    } catch (error) {
      export_error = error instanceof Error ? error.message : String(error)
    } finally {
      is_exporting_structures = false
      structure_export_progress = 0
    }
  }

  let is_video_supported = $derived(
    typeof window !== `undefined` &&
      typeof MediaRecorder !== `undefined` &&
      MediaRecorder.isTypeSupported(`video/webm;codecs=vp9`),
  )

  let has_canvas = $state(false)

  $effect(() => {
    if (!wrapper) {
      has_canvas = false
      return
    }
    const check = () => (has_canvas = Boolean(wrapper.querySelector(`canvas`)))
    check()
    const observer = new MutationObserver(check)
    observer.observe(wrapper, { childList: true, subtree: true })
    return () => observer.disconnect()
  })
</script>

<DraggablePane
  bind:show={export_pane_open}
  open_icon="Cross"
  closed_icon="Export"
  pane_props={{ ...pane_props, class: `export-pane ${pane_props?.class ?? ``}` }}
  toggle_props={{
    title: export_pane_open ? `` : t('structure.export_trajectory'),
    ...toggle_props,
    class: `trajectory-export-toggle ${toggle_props?.class ?? ``}`,
  }}
  {...rest}
>
  <h4>{t('structure.export_trajectory')}</h4>

  <SettingsSection
    title={t('structure.export_settings')}
    current_values={{ video_fps, resolution_multiplier, png_dpi, start_frame, end_frame }}
    on_reset={() => {
      video_fps = 30
      resolution_multiplier = 1
      png_dpi = 150
      start_frame = 0
      end_frame = total_frames_available - 1
    }}
    >
      <label>
        {t('structure.frame_rate_fps')}
        <input type="number" min={10} max={60} bind:value={video_fps} />
        <input
          type="range"
          min={10}
          max={60}
          bind:value={video_fps}
          style="accent-color: var(--accent-color)"
        />
      </label>

      <label>
        {t('structure.resolution')}
        <div class="resolution-buttons">
          {#each [0.5, 1, 2, 4, 8] as multiplier (multiplier)}
            {@const w = canvas ? Math.round(canvas.width * multiplier) : 0}
            {@const h = canvas ? Math.round(canvas.height * multiplier) : 0}
            <button
              type="button"
              class:active={resolution_multiplier === multiplier}
              onclick={() => (resolution_multiplier = multiplier)}
              {@attach tooltip({
                content: canvas ? `${multiplier}x (${w}×${h})` : `${multiplier}x`,
              })}
            >
              {multiplier}x
            </button>
          {/each}
        </div>
      </label>

      <label>
        {t('structure.start_frame')}
        <input
          type="number"
          min={0}
          max={Math.max(0, total_frames_available - 1)}
          bind:value={start_frame}
        />
        <input
          type="range"
          min={0}
          max={Math.max(0, total_frames_available - 1)}
          bind:value={start_frame}
          style="accent-color: var(--accent-color)"
        />
      </label>

      <label>
        {t('structure.end_frame')}
        <input
          type="number"
          min={start_frame}
          max={Math.max(0, total_frames_available - 1)}
          bind:value={end_frame}
        />
        <input
          type="range"
          min={start_frame}
          max={Math.max(0, total_frames_available - 1)}
          bind:value={end_frame}
          style="accent-color: var(--accent-color)"
        />
      </label>

      <label>
        PNG DPI
        <input type="number" min={50} max={600} bind:value={png_dpi} />
        <input
          type="range"
          min={50}
          max={600}
          bind:value={png_dpi}
          style="accent-color: var(--accent-color)"
        />
      </label>
    </SettingsSection>

    <h4>{t('structure.export_formats')}</h4>

    {#if export_error}
      <div class="error-message">{export_error}</div>
    {/if}

    <div class="export-buttons">
      <div style="display: flex; align-items: center; gap: 4pt">
        XYZ
        <button
          class="trajectory-xyz-export"
          type="button"
          onclick={() => handle_trajectory_text_export(`xyz`)}
          disabled={is_exporting || is_exporting_pngs || is_exporting_structures || !trajectory}
          {@attach tooltip({ content: t('structure.export_xyz_hint', { start: start_frame, end: end_frame }) })}
        >
          ⬇
        </button>
      </div>

      <div style="display: flex; align-items: center; gap: 4pt">
        extXYZ
        <button
          class="trajectory-extxyz-export"
          type="button"
          onclick={() => handle_trajectory_text_export(`extxyz`)}
          disabled={is_exporting || is_exporting_pngs || is_exporting_structures || !trajectory}
          {@attach tooltip({ content: t('structure.export_extxyz_hint', { start: start_frame, end: end_frame }) })}
        >
          {#if is_exporting_structures && structure_export_progress > 0}
            {structure_export_progress.toFixed(0)}%
          {:else}⬇{/if}
        </button>
      </div>

      <div style="display: flex; align-items: center; gap: 4pt">
        {t('structure.current_poscar')}
        <button
          class="current-poscar-export"
          type="button"
          onclick={handle_current_poscar_export}
          disabled={is_exporting || is_exporting_pngs || is_exporting_structures || !trajectory}
          {@attach tooltip({ content: t('structure.export_current_poscar_hint', { frame: current_frame_idx }) })}
        >⬇</button>
      </div>

      <div style="display: flex; align-items: center; gap: 4pt">
        {t('structure.poscar_sequence')}
        <button
          class="poscar-sequence-export"
          type="button"
          onclick={handle_poscar_sequence_export}
          disabled={is_exporting || is_exporting_pngs || is_exporting_structures || !trajectory}
          {@attach tooltip({ content: t('structure.export_poscar_sequence_hint', { start: start_frame, end: end_frame }) })}
        >
          {#if is_exporting_structures && structure_export_progress > 0}
            {structure_export_progress.toFixed(0)}%
          {:else}⬇{/if}
        </button>
      </div>

      <div style="display: flex; align-items: center; gap: 4pt">
        {t('structure.png_sequence')}
        <button
          type="button"
          onclick={handle_png_sequence_export}
          disabled={is_exporting || is_exporting_pngs || is_exporting_structures || !trajectory || !has_canvas}
          {@attach tooltip({ content: t('structure.export_png_sequence_hint') })}
        >
          {#if is_exporting_pngs}
            {png_export_progress.toFixed(0)}%
          {:else}⬇{/if}
        </button>
      </div>

      {#if is_video_supported}
        {#each [
          { label: `WebM`, format: `webm`, hint: t('structure.export_webm_hint') },
          {
            label: `MP4*`,
            format: `mp4`,
            hint:
              t('structure.export_mp4_hint'),
          },
        ] as const as
          { label, format, hint }
          (format)
        }
          <div style="display: flex; align-items: center; gap: 4pt">
            {label}
            <button
              type="button"
              onclick={() => handle_video_export(format)}
              disabled={is_exporting || is_exporting_pngs || is_exporting_structures || !trajectory || !has_canvas}
              {@attach tooltip({ content: hint })}
            >
              {#if is_exporting && export_format === format}
                {export_progress.toFixed(0)}%
              {:else}⬇{/if}
            </button>
          </div>
        {/each}
      {/if}
    </div>

    <div class="export-info">
      {t('structure.export_info', { seconds: (export_frame_count / video_fps).toFixed(1), frames: export_frame_count, start: start_frame, end: end_frame })}
      {#if file_size_mb > 0}
        • ~{
          file_size_mb < 1
          ? `${(file_size_mb * 1024).toFixed(0)} KB`
          : `${file_size_mb.toFixed(1)} MB`
        }
      {/if}
    </div>

    {#if trajectory && !has_canvas}
      <div class="warning">{t('structure.waiting_for_canvas')}</div>
    {/if}
</DraggablePane>

<style>
  .warning, .error-message {
    padding: 8px;
    border-radius: 4px;
    font-size: 0.85em;
  }
  .warning {
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid var(--warning-color, #f59e0b);
  }
  .error-message {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.5);
    color: var(--error-color);
    margin-bottom: 8px;
  }
  .export-buttons {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .export-info {
    margin-top: 8px;
    padding: 8px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.05));
    border-radius: 4px;
    font-size: 0.85em;
    opacity: 0.8;
  }
  .resolution-buttons {
    display: flex;
    gap: 6px;
    margin: 4px;
  }
  .resolution-buttons button {
    flex: 1;
    padding: 2px 4px;
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    background: var(--btn-bg, light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.1)));
    color: var(--text-color);
    cursor: pointer;
    transition: all 0.2s;
  }
  .resolution-buttons button:hover {
    background: var(--btn-bg-hover, light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.15)));
  }
  .resolution-buttons button.active {
    background: var(--accent-color, #007acc);
    border-color: var(--accent-color, #007acc);
    color: white;
  }
</style>
