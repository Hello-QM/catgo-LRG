<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import EnergyDiagramPlot from '$lib/workflow/EnergyDiagramPlot.svelte'
  import {
    parse_atom_ranges,
    run_igmh,
    run_iri,
    type GridQuality,
    type PlotlyData,
    type WavefunctionInfo,
  } from './api'
  import { local_iri } from './local-analyses'
  import { cube_file, type CubeDisplayOptions } from './overlay'

  load_i18n_module('structure')

  let {
    wavefunction,
    grid,
    multiwfn_path,
    on_cube,
  }: {
    wavefunction: WavefunctionInfo
    grid: GridQuality
    multiwfn_path: string
    on_cube: (file: File, options: CubeDisplayOptions) => void
  } = $props()

  const SL2R_SCALE = { name: `bgr` as const, min: -0.04, max: 0.02 }

  let method = $state<`iri` | `igmh`>(`iri`)
  let fragments = $state([``, ``])
  let loading = $state(false)
  let error = $state(``)
  let scatter = $state.raw<PlotlyData | null>(null)

  async function run() {
    loading = true
    error = ``
    const base = wavefunction.filename.replace(/\.[^.]+$/, ``)
    try {
      const body = { session_id: wavefunction.session_id, grid, multiwfn_path }
      if (method === `iri`) {
        const r = wavefunction.local_key ? await local_iri(wavefunction, grid) : await run_iri(body)
        scatter = r.scatter
        on_cube(cube_file(r.iri_cube, `${base}_IRI.cub`), {
          color_file: cube_file(r.sl2r_cube, `${base}_sl2r.cub`),
          color_scale: { ...SL2R_SCALE },
          color_label: `sign(λ₂)ρ (a.u.)`,
          isovalue: 1.0,
        })
      } else {
        const frags = fragments.filter((f) => f.trim()).map(parse_atom_ranges)
        if (frags.length < 2) throw new Error(t('structure.wfa_igmh_need_fragments'))
        const r = await run_igmh({ ...body, fragments: frags })
        scatter = r.scatter
        on_cube(cube_file(r.dg_inter_cube, `${base}_dg_inter.cub`), {
          color_file: cube_file(r.sl2r_cube, `${base}_sl2r.cub`),
          color_scale: { ...SL2R_SCALE },
          color_label: `sign(λ₂)ρ (a.u.)`,
          isovalue: 0.005,
        })
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  function fill_default_fragments() {
    // Split the molecule in two halves by atom index as a starting point
    const n = wavefunction.atoms.length
    const half = Math.max(1, Math.floor(n / 2))
    fragments = [`1-${half}`, `${half + 1}-${n}`]
  }
</script>

<div class="wfa-tab">
  <div class="wfa-methods" role="radiogroup">
    <label><input type="radio" bind:group={method} value="iri" /> IRI</label>
    <label><input type="radio" bind:group={method} value="igmh" /> IGMH</label>
  </div>
  <p class="wfa-hint">
    {method === `iri` ? t('structure.wfa_iri_hint') : t('structure.wfa_igmh_hint')}
  </p>

  {#if method === `igmh`}
    {#each fragments as _, k}
      <label class="wfa-field">
        <span>{t('structure.wfa_fragment_n', { n: k + 1 })}</span>
        <input type="text" bind:value={fragments[k]} placeholder="1-6,12" spellcheck="false" />
      </label>
    {/each}
    <div class="wfa-row">
      <button class="wfa-link" onclick={() => (fragments = [...fragments, ``])}>
        {t('structure.wfa_add_fragment')}
      </button>
      {#if wavefunction.atoms.length > 1}
        <button class="wfa-link" onclick={fill_default_fragments}>{t('structure.wfa_split_halves')}</button>
      {/if}
    </div>
  {/if}

  <button class="wfa-run" onclick={run} disabled={loading}>
    {loading ? t('structure.wfa_running') : t('structure.wfa_run')}
  </button>
  {#if error}<div class="wfa-error">{error}</div>{/if}

  {#if scatter}
    <div class="wfa-plot">
      <EnergyDiagramPlot plotly_data={scatter} height={260} editable={false} />
    </div>
    <p class="wfa-hint">{t('structure.wfa_sl2r_legend')}</p>
  {/if}
</div>

<style>
  .wfa-tab { display: flex; flex-direction: column; gap: 6px; }
  .wfa-methods { display: flex; gap: 12px; }
  .wfa-hint { margin: 0; font-size: 11px; color: var(--text-color-muted, #94a3b8); line-height: 1.4; }
  .wfa-field { display: flex; flex-direction: column; gap: 2px; }
  .wfa-field span { font-size: 10px; font-weight: 600; text-transform: uppercase; color: var(--text-color-dim, #999); }
  .wfa-field input {
    padding: 3px 6px; font-size: 11px; font-family: inherit; border-radius: 4px; color: inherit;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
  }
  .wfa-row { display: flex; gap: 10px; }
  .wfa-link { background: none; border: none; padding: 0; color: var(--accent-color, #3b82f6); cursor: pointer; font-size: 11px; font-family: inherit; }
  .wfa-run {
    align-self: flex-start; padding: 4px 14px; font-size: 12px; font-weight: 600; border-radius: 5px; cursor: pointer;
    border: 1px solid var(--accent-color, #3b82f6); background: var(--accent-color, #3b82f6); color: #fff; font-family: inherit;
  }
  .wfa-run:disabled { opacity: 0.6; cursor: default; }
  .wfa-error { color: #ef4444; font-size: 11px; white-space: pre-wrap; max-height: 8em; overflow-y: auto; }
  .wfa-plot { border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); border-radius: 4px; overflow: hidden; }
</style>
