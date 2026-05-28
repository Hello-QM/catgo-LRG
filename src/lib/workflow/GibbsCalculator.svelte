<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import * as api from '$lib/api/workflow'
  import type { GibbsResult, GibbsRequest } from '$lib/api/workflow'

  load_i18n_module(`workflow`)

  let {
    workflow_id,
    step_id,
  }: {
    workflow_id: string
    step_id: string
  } = $props()

  let mode = $state<'adsorbed' | 'gas'>('adsorbed')
  let temperature = $state(298.15)
  let freq_cutoff = $state(50.0)
  let pressure_atm = $state(1.0)
  let n_unpaired = $state(0)

  let loading = $state(false)
  let result = $state<GibbsResult | null>(null)
  let error = $state<string | null>(null)
  let expanded = $state(false)

  async function calculate() {
    loading = true
    error = null
    try {
      const params: GibbsRequest = {
        mode,
        temperature,
        pressure: pressure_atm * 101325.0,
        freq_cutoff,
        n_unpaired,
      }
      result = await api.calculate_gibbs(workflow_id, step_id, params)
    } catch (err) {
      error = String(err)
    } finally {
      loading = false
    }
  }
</script>

<div class="gibbs-section">
  <button class="gibbs-toggle" onclick={() => expanded = !expanded}>
    <span class="gibbs-arrow">{expanded ? '▾' : '▸'}</span>
    {t(`workflow.gibbs_free_energy_correction`)}
  </button>

  {#if expanded}
    <div class="gibbs-body">
      <!-- Mode selector -->
      <div class="gibbs-row">
        <label class="gibbs-label">{t(`workflow.mode`)}</label>
        <div class="gibbs-radio-group">
          <label class="gibbs-radio">
            <input type="radio" bind:group={mode} value="adsorbed" />
            {t(`workflow.adsorbed`)}
          </label>
          <label class="gibbs-radio">
            <input type="radio" bind:group={mode} value="gas" />
            {t(`workflow.gas_phase`)}
          </label>
        </div>
      </div>

      <!-- Temperature -->
      <div class="gibbs-row">
        <label class="gibbs-label">T (K)</label>
        <input type="number" class="gibbs-input" bind:value={temperature} step="0.01" min="1" />
      </div>

      <!-- Adsorbed: freq cutoff -->
      {#if mode === 'adsorbed'}
        <div class="gibbs-row">
          <label class="gibbs-label">Freq cutoff (cm⁻¹)</label>
          <input type="number" class="gibbs-input" bind:value={freq_cutoff} step="1" min="0" />
        </div>
      {/if}

      <!-- Gas: pressure + unpaired -->
      {#if mode === 'gas'}
        <div class="gibbs-row">
          <label class="gibbs-label">P (atm)</label>
          <input type="number" class="gibbs-input" bind:value={pressure_atm} step="0.01" min="0" />
        </div>
        <div class="gibbs-row">
          <label class="gibbs-label">Unpaired e⁻</label>
          <input type="number" class="gibbs-input" bind:value={n_unpaired} step="1" min="0" />
        </div>
      {/if}

      <button class="gibbs-calc-btn" onclick={calculate} disabled={loading}>
        {loading ? t(`workflow.calculating`) : t(`workflow.calculate`)}
      </button>

      {#if error}
        <div class="gibbs-error">{error}</div>
      {/if}

      {#if result}
        <div class="gibbs-results">
          <div class="gibbs-result-row gibbs-highlight">
            <span>G_corr</span>
            <span class="mono">{result.g_corr_ev.toFixed(6)} eV</span>
            <span class="mono dim">({result.g_corr_kcal.toFixed(4)} kcal/mol)</span>
          </div>
          <div class="gibbs-result-row">
            <span>ZPE</span>
            <span class="mono">{result.zpe_ev.toFixed(6)} eV</span>
          </div>
          <div class="gibbs-result-row">
            <span>H(T) - E_elec</span>
            <span class="mono">{result.h_corr_ev.toFixed(6)} eV</span>
          </div>
          {#if mode === 'adsorbed' && result.ts_vib_ev !== undefined}
            <div class="gibbs-result-row">
              <span>T*S_vib</span>
              <span class="mono">{result.ts_vib_ev.toFixed(6)} eV</span>
            </div>
          {/if}
          {#if mode === 'gas'}
            <div class="gibbs-result-row">
              <span>T*S_total</span>
              <span class="mono">{result.ts_total_ev?.toFixed(6) ?? '-'} eV</span>
            </div>
            <div class="gibbs-result-divider"></div>
            <div class="gibbs-result-row dim">
              <span>{t(`workflow.mass`)}</span>
              <span class="mono">{result.molecular_mass_amu?.toFixed(4)} amu</span>
            </div>
            <div class="gibbs-result-row dim">
              <span>{t(`workflow.linear`)}</span>
              <span class="mono">{result.is_linear ? t(`workflow.yes`) : t(`workflow.no`)}</span>
            </div>
            <div class="gibbs-result-row dim">
              <span>σ (sym. number)</span>
              <span class="mono">{result.sigma}</span>
            </div>
            <div class="gibbs-result-divider"></div>
            <div class="gibbs-result-row dim">
              <span>U_trans</span>
              <span class="mono">{result.u_trans_ev?.toFixed(6)} eV</span>
            </div>
            <div class="gibbs-result-row dim">
              <span>U_rot</span>
              <span class="mono">{result.u_rot_ev?.toFixed(6)} eV</span>
            </div>
            <div class="gibbs-result-row dim">
              <span>dU_vib</span>
              <span class="mono">{result.du_vib_ev?.toFixed(6)} eV</span>
            </div>
            <div class="gibbs-result-row dim">
              <span>PV</span>
              <span class="mono">{result.pv_ev?.toFixed(6)} eV</span>
            </div>
          {/if}
          <div class="gibbs-hint">G_total = E_DFT + G_corr</div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .gibbs-section {
    margin-top: 8px;
    border-top: 1px solid var(--dialog-border, light-dark(#e5e7eb, #333));
    padding-top: 6px;
  }
  .gibbs-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    padding: 2px 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-color, light-dark(#374151, #eee));
    cursor: pointer;
    font-family: inherit;
  }
  .gibbs-toggle:hover { color: var(--accent-color, #3b82f6); }
  .gibbs-arrow { font-size: 10px; width: 12px; }
  .gibbs-body {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .gibbs-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .gibbs-label {
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#6b7280, #9ca3af));
    min-width: 90px;
    white-space: nowrap;
  }
  .gibbs-radio-group {
    display: flex;
    gap: 10px;
  }
  .gibbs-radio {
    display: flex;
    align-items: center;
    gap: 3px;
    font-size: 10px;
    color: var(--text-color, light-dark(#374151, #ddd));
    cursor: pointer;
  }
  .gibbs-radio input { margin: 0; }
  .gibbs-input {
    width: 80px;
    padding: 2px 4px;
    font-size: 10px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 3px;
    background: var(--input-bg, light-dark(#fff, #2a2b30));
    color: var(--text-color, light-dark(#374151, #eee));
    font-family: 'SF Mono', 'Monaco', monospace;
  }
  .gibbs-calc-btn {
    margin-top: 4px;
    padding: 3px 10px;
    font-size: 11px;
    font-weight: 600;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    background: var(--accent-color, #3b82f6);
    color: #fff;
    cursor: pointer;
    font-family: inherit;
    align-self: flex-start;
  }
  .gibbs-calc-btn:hover:not(:disabled) { filter: brightness(1.1); }
  .gibbs-calc-btn:disabled { opacity: 0.6; cursor: not-allowed; }

  .gibbs-error {
    padding: 4px 6px;
    font-size: 10px;
    color: #ef4444;
    background: rgba(239, 68, 68, 0.08);
    border-radius: 3px;
  }
  .gibbs-results {
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .gibbs-result-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 10px;
    padding: 1px 0;
  }
  .gibbs-result-row span:first-child {
    min-width: 80px;
    color: var(--text-color-dim, light-dark(#6b7280, #9ca3af));
  }
  .gibbs-highlight {
    font-weight: 600;
    color: #22c55e;
  }
  .gibbs-highlight span:first-child {
    color: #22c55e !important;
  }
  .gibbs-result-divider {
    height: 1px;
    background: var(--dialog-border, light-dark(#e5e7eb, #333));
    margin: 2px 0;
  }
  .dim { opacity: 0.7; }
  .mono {
    font-family: 'SF Mono', 'Monaco', monospace;
  }
  .gibbs-hint {
    margin-top: 4px;
    font-size: 9px;
    color: var(--text-color-dim, light-dark(#9ca3af, #6b7280));
    font-style: italic;
  }
</style>
