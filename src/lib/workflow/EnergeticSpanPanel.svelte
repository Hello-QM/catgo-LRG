<script lang="ts">
  import { API_BASE } from '$lib/api/config'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import EnergyDiagramPlot from './EnergyDiagramPlot.svelte'

  load_i18n_module('workflow')

  interface Step { label: string; energy: number; is_ts: boolean }
  interface Pathway { name: string; color: string; steps: Step[] }

  let { pathways = [] }: { pathways?: Pathway[] } = $props()

  let path_idx = $state(0)
  let temperature = $state(298.15)
  let unit = $state(`eV`)
  // true: the last step is the regenerated catalyst and sets ΔGr
  let closes_cycle = $state(true)
  let reaction_energy = $state(-0.5)

  let loading = $state(false)
  let error = $state(``)
  let result: any = $state.raw(null)

  let selected = $derived(pathways[Math.min(path_idx, pathways.length - 1)])

  function fmt(v: number, digits = 3) {
    return Number.isFinite(v) ? v.toFixed(digits) : `—`
  }

  function fmt_tof(v: number) {
    return Number.isFinite(v) ? v.toExponential(3) : `—`
  }

  async function run() {
    if (!selected) return
    loading = true
    error = ``
    try {
      const res = await fetch(`${API_BASE}/workflow/catalysis/energetic-span`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify({
          steps: selected.steps,
          reaction_energy: closes_cycle ? null : reaction_energy,
          temperature,
          unit,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.detail ?? res.statusText)
      }
      result = await res.json()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      result = null
    } finally {
      loading = false
    }
  }
</script>

<div class="es-panel">
  <p class="es-intro">{t('workflow.es_intro')}</p>

  {#if pathways.length === 0}
    <div class="es-note">{t('workflow.es_no_pathways')}</div>
  {/if}

  <div class="es-form">
    <label>
      <span>{t('workflow.es_pathway')}</span>
      <select bind:value={path_idx}>
        {#each pathways as p, i}
          <option value={i}>{p.name}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>{t('workflow.es_temperature')}</span>
      <input type="number" min="1" step="1" bind:value={temperature} />
    </label>
    <label>
      <span>{t('workflow.es_unit')}</span>
      <select bind:value={unit}>
        <option value="eV">eV</option>
        <option value="kcal/mol">kcal/mol</option>
        <option value="kJ/mol">kJ/mol</option>
      </select>
    </label>
  </div>

  <div class="es-form">
    <label class="es-check">
      <input type="checkbox" bind:checked={closes_cycle} />
      <span>{t('workflow.es_closes_cycle')}</span>
    </label>
    {#if !closes_cycle}
      <label>
        <span>{t('workflow.es_reaction_energy')}</span>
        <input type="number" step="0.01" bind:value={reaction_energy} />
      </label>
    {/if}
  </div>

  <button class="es-run" onclick={run} disabled={loading || !selected}>
    {loading ? t('workflow.es_running') : t('workflow.es_run')}
  </button>

  {#if error}
    <div class="es-error">{error}</div>
  {/if}

  {#if result}
    <div class="es-summary">
      <div class="es-stat">
        <span class="es-stat-label">δE</span>
        <span class="es-stat-value">{fmt(result.energetic_span)} {result.unit}</span>
      </div>
      <div class="es-stat">
        <span class="es-stat-label">TOF</span>
        <span class="es-stat-value">{fmt_tof(result.tof)} s⁻¹</span>
      </div>
      <div class="es-stat">
        <span class="es-stat-label">TDI</span>
        <span class="es-stat-value">{result.tdi.label}</span>
      </div>
      <div class="es-stat">
        <span class="es-stat-label">TDTS</span>
        <span class="es-stat-value">{result.tdts.label}</span>
      </div>
      <div class="es-stat">
        <span class="es-stat-label">ΔG<sub>r</sub></span>
        <span class="es-stat-value">{fmt(result.reaction_energy)} {result.unit}</span>
      </div>
    </div>
    {#if result.tdts_before_tdi}
      <div class="es-note">{t('workflow.es_tdts_before_tdi')}</div>
    {/if}
    {#each result.warnings as w}
      <div class="es-error">{w}</div>
    {/each}

    <table class="es-table">
      <thead>
        <tr>
          <th>{t('workflow.es_state')}</th>
          <th class="num">{t('workflow.es_rel_energy', { unit: result.unit })}</th>
          <th class="num">{t('workflow.es_tof_control')}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each result.states as s}
          <tr class:es-ts={s.is_ts} class:es-key={s.role}>
            <td>{s.label}</td>
            <td class="num">{fmt(s.energy)}</td>
            <td class="num">{fmt(s.degree_of_tof_control * 100, 1)}%</td>
            <td>{s.role ?? ``}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    <div class="es-plot">
      <EnergyDiagramPlot plotly_data={result.plotly_data} height={320} editable={false} />
    </div>
    <div class="es-cite">{t('workflow.es_citation')}</div>
  {/if}
</div>

<style>
  .es-panel { display: flex; flex-direction: column; gap: 10px; font-size: 12px; }
  .es-intro { margin: 0; color: var(--text-color-muted, #94a3b8); line-height: 1.5; }
  .es-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
  .es-form label { display: flex; flex-direction: column; gap: 3px; min-width: 120px; }
  .es-form label span { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; color: var(--text-color-dim, #999); }
  .es-form label.es-check { flex-direction: row; align-items: center; gap: 6px; }
  .es-form label.es-check span { text-transform: none; font-size: 12px; font-weight: 400; color: var(--text-color, #eee); letter-spacing: 0; }
  .es-form input[type="number"], .es-form select {
    padding: 4px 6px; font-size: 12px; font-family: inherit; border-radius: 4px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
    color: var(--text-color, #eee);
  }
  .es-run {
    align-self: flex-start; padding: 6px 18px; font-size: 12px; font-weight: 600; border-radius: 5px;
    border: 1px solid var(--accent-color, #3b82f6); background: var(--accent-color, #3b82f6);
    color: #fff; cursor: pointer; font-family: inherit;
  }
  .es-run:disabled { opacity: 0.6; cursor: default; }
  .es-error { color: #ef4444; font-size: 11px; }
  .es-note { font-size: 11px; color: var(--text-color-muted, #94a3b8); font-style: italic; }
  .es-summary { display: flex; flex-wrap: wrap; gap: 8px; }
  .es-stat {
    display: flex; flex-direction: column; gap: 2px; padding: 6px 10px; border-radius: 6px; min-width: 90px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .es-stat-label { font-size: 10px; color: var(--text-color-dim, #999); }
  .es-stat-value { font-size: 13px; font-weight: 600; font-family: 'SF Mono', 'Cascadia Code', monospace; overflow-wrap: anywhere; }
  .es-table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .es-table th { text-align: left; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-color-dim, #999); padding: 3px 6px; border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #333)); }
  .es-table td { padding: 3px 6px; border-bottom: 1px solid light-dark(rgba(0,0,0,0.05), rgba(255,255,255,0.05)); }
  .es-table .num { text-align: right; font-family: 'SF Mono', 'Cascadia Code', monospace; }
  .es-ts td { font-style: italic; }
  .es-key td { font-weight: 600; }
  .es-plot { border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); border-radius: 6px; overflow: hidden; }
  .es-cite { font-size: 10px; color: var(--text-color-dim, #999); }
</style>
