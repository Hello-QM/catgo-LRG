<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import {
    type AimResult,
    type CpKind,
    type CriticalPoint,
    type WavefunctionInfo,
  } from './api'
  import { local_aim } from './local-analyses'
  import { CP_COLORS, type AnalysisOverlayData } from './overlay'

  load_i18n_module('structure')

  let {
    wavefunction,
    on_overlay,
  }: {
    wavefunction: WavefunctionInfo
    on_overlay: (overlay: AnalysisOverlayData | null) => void
  } = $props()

  const KINDS: CpKind[] = [`NCP`, `BCP`, `RCP`, `CCP`]

  let loading = $state(false)
  let error = $state(``)
  let result = $state.raw<AimResult | null>(null)
  let shown = $state<Record<CpKind, boolean>>({ NCP: false, BCP: true, RCP: true, CCP: true })
  let show_paths = $state(true)
  let table_kind = $state<CpKind>(`BCP`)

  let rows = $derived(result ? result.critical_points.filter((cp) => cp.kind === table_kind) : [])

  function atom_label(n: number) {
    const a = wavefunction.atoms[n - 1]
    return a ? `${a.symbol}${n}` : String(n)
  }

  function cp_label(cp: CriticalPoint) {
    if (cp.atoms) return `${atom_label(cp.atoms[0])}–${atom_label(cp.atoms[1])}`
    if (cp.nucleus) return atom_label(cp.nucleus)
    return `#${cp.index}`
  }

  function publish() {
    if (!result) return on_overlay(null)
    on_overlay({
      markers: result.critical_points
        .filter((cp) => shown[cp.kind])
        .map((cp) => ({ position: cp.position, color: CP_COLORS[cp.kind], radius: cp.kind === `NCP` ? 0.15 : 0.1 })),
      lines: show_paths
        ? result.bond_paths.map((p) => ({ points: p.points, color: CP_COLORS.BCP }))
        : [],
    })
  }

  async function run() {
    loading = true
    error = ``
    try {
      result = await local_aim(wavefunction)
      publish()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  const fmt = (v: number | undefined, d = 4) => (v === undefined ? `—` : v.toFixed(d))
</script>

<div class="wfa-tab">
  <p class="wfa-hint">{t('structure.wfa_aim_hint')}</p>
  <button class="wfa-run" onclick={run} disabled={loading}>
    {loading ? t('structure.wfa_running') : t('structure.wfa_aim_run')}
  </button>
  {#if error}<div class="wfa-error">{error}</div>{/if}

  {#if result}
    <div class="wfa-kinds">
      {#each KINDS as kind}
        <label>
          <input type="checkbox" bind:checked={shown[kind]} onchange={publish} />
          <span class="dot" style:background={CP_COLORS[kind]}></span>
          {kind} ({result.counts[kind] ?? 0})
        </label>
      {/each}
      <label><input type="checkbox" bind:checked={show_paths} onchange={publish} /> {t('structure.wfa_bond_paths')}</label>
    </div>

    <label class="wfa-field">
      <span>{t('structure.wfa_table')}</span>
      <select bind:value={table_kind}>
        {#each KINDS as kind}<option value={kind}>{kind}</option>{/each}
      </select>
    </label>
    <div class="wfa-table">
      <table>
        <thead>
          <tr>
            <th></th>
            <th class="num">ρ</th>
            <th class="num">∇²ρ</th>
            <th class="num">H</th>
            {#if table_kind === `BCP`}<th class="num">ε</th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each rows as cp (cp.index)}
            <tr>
              <td>{cp_label(cp)}</td>
              <td class="num">{fmt(cp.rho)}</td>
              <td class="num">{fmt(cp.laplacian)}</td>
              <td class="num">{fmt(cp.H)}</td>
              {#if table_kind === `BCP`}<td class="num">{fmt(cp.ellipticity, 3)}</td>{/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="wfa-hint">{t('structure.wfa_aim_units')}</p>
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
  .wfa-error { color: #ef4444; font-size: 11px; white-space: pre-wrap; max-height: 8em; overflow-y: auto; }
  .wfa-kinds { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; }
  .wfa-kinds label { display: flex; align-items: center; gap: 3px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .wfa-field { display: flex; flex-direction: column; gap: 2px; }
  .wfa-field span { font-size: 10px; font-weight: 600; text-transform: uppercase; color: var(--text-color-dim, #999); }
  .wfa-field select { padding: 3px 6px; font-size: 11px; border-radius: 4px; font-family: inherit; color: inherit; background: transparent; border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); }
  .wfa-table { max-height: 16em; overflow-y: auto; border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { position: sticky; top: 0; background: var(--surface-bg, light-dark(#fff, #1e1e1e)); font-size: 9px; color: var(--text-color-dim, #999); padding: 3px 5px; text-align: left; }
  td { padding: 2px 5px; white-space: nowrap; }
  .num { text-align: right; font-family: 'SF Mono', 'Cascadia Code', monospace; }
</style>
