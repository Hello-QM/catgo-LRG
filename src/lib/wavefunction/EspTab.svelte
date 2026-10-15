<script lang="ts">
  import type { CubeMesh } from '$lib/cube'
  import { surface_extrema, type SurfaceExtremum } from '$lib/cube/vertex-colors'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { GridQuality, WavefunctionInfo } from './api'
  import { ESP_SURFACE_RHO, exact_esp, local_esp } from './local-analyses'
  import { cube_file, type AnalysisOverlayData, type CubeDisplayOptions } from './overlay'

  load_i18n_module('structure')

  let {
    wavefunction,
    grid,
    surface_mesh = null,
    on_cube,
    on_overlay,
  }: {
    wavefunction: WavefunctionInfo
    grid: GridQuality
    /** The ESP-mapped isosurface (per-vertex ESP in `values`), when it is the one shown */
    surface_mesh?: CubeMesh | null
    on_cube: (file: File, options: CubeDisplayOptions) => void
    on_overlay: (overlay: AnalysisOverlayData | null) => void
  } = $props()

  const HARTREE_TO_KCAL = 627.5094740631
  const MIN_COLOR = `#1d4ed8`
  const MAX_COLOR = `#dc2626`

  let loading = $state(false)
  let error = $state(``)
  let extrema = $state.raw<SurfaceExtremum[]>([])

  let stats = $derived.by(() => {
    const values = surface_mesh?.values
    if (!values || values.length === 0) return null
    let min = Infinity
    let max = -Infinity
    for (const v of values) {
      if (v < min) min = v
      if (v > max) max = v
    }
    return { min, max }
  })

  async function run() {
    loading = true
    error = ``
    extrema = []
    on_overlay(null)
    const base = wavefunction.filename.replace(/\.[^.]+$/, ``)
    try {
      const r = await local_esp(wavefunction, grid)
      on_cube(cube_file(r.density_cube, `${base}_density.cub`), {
        color_file: cube_file(r.esp_cube, `${base}_ESP.cub`),
        color_scale: { name: `esp`, min: -0.05, max: 0.05 },
        color_label: `ESP (a.u.)`,
        isovalue: ESP_SURFACE_RHO,
      })
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  async function find_extrema() {
    const mesh = surface_mesh
    if (!mesh?.values) return
    const found = surface_extrema(mesh, mesh.values)
    // the mesh colours come from an interpolated grid; report exact values
    try {
      const exact = await exact_esp(wavefunction, found.map((e) => e.position))
      extrema = found.map((e, k) => ({ ...e, value: exact[k] }))
    } catch {
      extrema = found
    }
    on_overlay({
      markers: extrema.map((e) => ({
        position: e.position,
        color: e.kind === `min` ? MIN_COLOR : MAX_COLOR,
        radius: 0.12,
      })),
      lines: [],
    })
  }

  const kcal = (v: number) => (v * HARTREE_TO_KCAL).toFixed(2)
</script>

<div class="wfa-tab">
  <p class="wfa-hint">{t('structure.wfa_esp_hint')}</p>
  <button class="wfa-run" onclick={run} disabled={loading}>
    {loading ? t('structure.wfa_running') : t('structure.wfa_esp_run')}
  </button>
  {#if error}<div class="wfa-error">{error}</div>{/if}

  {#if stats}
    <div class="wfa-stats">
      <span>{t('structure.wfa_esp_surface_min')}: <b>{kcal(stats.min)}</b> kcal/mol</span>
      <span>{t('structure.wfa_esp_surface_max')}: <b>{kcal(stats.max)}</b> kcal/mol</span>
    </div>
    <button class="wfa-link" onclick={find_extrema}>{t('structure.wfa_esp_find_extrema')}</button>
  {/if}

  {#if extrema.length > 0}
    <div class="wfa-table">
      <table>
        <thead>
          <tr><th></th><th class="num">kcal/mol</th><th class="num">x</th><th class="num">y</th><th class="num">z</th></tr>
        </thead>
        <tbody>
          {#each extrema as e}
            <tr>
              <td style:color={e.kind === `min` ? MIN_COLOR : MAX_COLOR}>
                {e.kind === `min` ? t('structure.wfa_min') : t('structure.wfa_max')}
              </td>
              <td class="num">{kcal(e.value)}</td>
              {#each e.position as c}<td class="num">{c.toFixed(2)}</td>{/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <button class="wfa-link" onclick={() => { extrema = []; on_overlay(null) }}>
      {t('structure.wfa_clear_markers')}
    </button>
  {/if}
</div>

<style>
  .wfa-tab { display: flex; flex-direction: column; gap: 6px; }
  .wfa-hint { margin: 0; font-size: 11px; color: var(--text-color-muted, #94a3b8); line-height: 1.4; }
  .wfa-run {
    align-self: flex-start; padding: 4px 14px; font-size: 12px; font-weight: 600; border-radius: 5px; cursor: pointer;
    border: 1px solid var(--accent-color, #3b82f6); background: var(--accent-color, #3b82f6); color: #fff; font-family: inherit;
  }
  .wfa-run:disabled { opacity: 0.6; cursor: default; }
  .wfa-link { align-self: flex-start; background: none; border: none; padding: 0; color: var(--accent-color, #3b82f6); cursor: pointer; font-size: 11px; font-family: inherit; }
  .wfa-error { color: #ef4444; font-size: 11px; white-space: pre-wrap; max-height: 8em; overflow-y: auto; }
  .wfa-stats { display: flex; flex-direction: column; gap: 2px; font-size: 11px; }
  .wfa-table { max-height: 14em; overflow-y: auto; border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { position: sticky; top: 0; background: var(--surface-bg, light-dark(#fff, #1e1e1e)); font-size: 9px; text-transform: uppercase; color: var(--text-color-dim, #999); padding: 3px 5px; text-align: left; }
  td { padding: 2px 5px; }
  .num { text-align: right; font-family: 'SF Mono', 'Cascadia Code', monospace; }
</style>
