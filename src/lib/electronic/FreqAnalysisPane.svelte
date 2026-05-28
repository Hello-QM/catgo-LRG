<script lang="ts">
  import { API_BASE } from '$lib/api/config'
  import type { VaspFrequencyData } from '$lib/api/workflow'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import FileSourceDialog from './FileSourceDialog.svelte'

  load_i18n_module('structure')
  load_i18n_module('common')

  let {
    on_play_vibration,
    on_stop_vibration,
  }: {
    on_play_vibration?: (data: { eigenvector: number[][]; base_positions: number[][]; amplitude: number }) => void
    on_stop_vibration?: () => void
  } = $props()

  let freq_data = $state<VaspFrequencyData | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)
  let show_source_dialog = $state(false)

  // Gibbs calculator state
  let gibbs_mode = $state<'adsorbed' | 'gas'>('adsorbed')
  let gibbs_temperature = $state(298.15)
  let gibbs_freq_cutoff = $state(50.0)
  let gibbs_pressure_atm = $state(1.0)
  let gibbs_n_unpaired = $state(0)
  let gibbs_loading = $state(false)
  let gibbs_result = $state<Record<string, unknown> | null>(null)
  let gibbs_error = $state<string | null>(null)

  // Vibration state
  let vib_selected = $state(0)
  let vib_amplitude = $state(0.5)
  let vib_playing = $state(false)

  async function handle_file_upload(file: File) {
    loading = true
    error = null
    freq_data = null
    try {
      const form = new FormData()
      form.append('file', file)
      const resp = await fetch(`${API_BASE}/freq-analysis/upload`, { method: 'POST', body: form })
      if (!resp.ok) throw new Error(await resp.text())
      const data = await resp.json()
      if (!data.success) throw new Error(data.message || t('structure.freq_parse_failed'))
      freq_data = data
    } catch (err: any) {
      error = err.message || String(err)
    } finally {
      loading = false
    }
  }

  async function handle_remote(session_id: string, path: string) {
    loading = true
    error = null
    freq_data = null
    show_source_dialog = false
    try {
      const resp = await fetch(`${API_BASE}/freq-analysis/from-directory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id, directory: path }),
      })
      if (!resp.ok) throw new Error(await resp.text())
      const data = await resp.json()
      if (!data.success) throw new Error(data.message || t('structure.freq_parse_failed'))
      freq_data = data
    } catch (err: any) {
      error = err.message || String(err)
    } finally {
      loading = false
    }
  }

  function handle_drop(e: DragEvent) {
    e.preventDefault()
    const file = e.dataTransfer?.files?.[0]
    if (file) handle_file_upload(file)
  }

  async function calculate_gibbs() {
    if (!freq_data) return
    gibbs_loading = true
    gibbs_error = null
    try {
      const real_cm = (freq_data.real_freqs ?? []).map(f =>
        typeof f === 'object' ? f.frequency_cm : f
      )
      const imag_cm = (freq_data.imag_freqs ?? []).map(f =>
        typeof f === 'object' ? f.frequency_cm : f
      )
      const resp = await fetch(`${API_BASE}/freq-analysis/gibbs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          real_freqs_cm: real_cm,
          imag_freqs_cm: imag_cm,
          positions: freq_data.positions ?? [],
          masses: freq_data.masses ?? [],
          atom_types: freq_data.atom_types ?? [],
          free_indices: freq_data.free_indices,
          mode: gibbs_mode,
          temperature: gibbs_temperature,
          pressure: gibbs_pressure_atm * 101325.0,
          freq_cutoff: gibbs_freq_cutoff,
          n_unpaired: gibbs_n_unpaired,
        }),
      })
      if (!resp.ok) throw new Error(await resp.text())
      gibbs_result = await resp.json()
    } catch (err: any) {
      gibbs_error = err.message || String(err)
    } finally {
      gibbs_loading = false
    }
  }

  // Vibration modes
  const all_modes = $derived(freq_data ? [
    ...(freq_data.imag_freqs ?? []).map(f => ({ ...f, imaginary: true })),
    ...(freq_data.real_freqs ?? []).map(f => ({ ...f, imaginary: false })),
  ] : [])

  function toggle_vibration() {
    if (vib_playing) {
      vib_playing = false
      on_stop_vibration?.()
    } else {
      play_vibration()
    }
  }

  function play_vibration() {
    if (!freq_data?.eigenvectors?.length || !freq_data?.positions?.length) return
    const mode = all_modes[vib_selected]
    if (!mode) return
    const imag_len = freq_data.imag_freqs?.length ?? 0
    const eig_idx = mode.imaginary
      ? (freq_data.imag_freqs ?? []).findIndex(f => f.index === mode.index)
      : imag_len + (freq_data.real_freqs ?? []).findIndex(f => f.index === mode.index)
    if (eig_idx < 0 || eig_idx >= freq_data.eigenvectors.length) return
    vib_playing = true
    on_play_vibration?.({
      eigenvector: freq_data.eigenvectors[eig_idx],
      base_positions: freq_data.positions,
      amplitude: vib_amplitude,
    })
  }
</script>

<div class="freq-pane">
  {#if !freq_data}
    <!-- File source -->
    <div
      class="freq-dropzone"
      ondragover={(e) => e.preventDefault()}
      ondrop={handle_drop}
    >
      {#if loading}
        <div class="freq-loading">{t('common.loading')}</div>
      {:else}
        <div class="freq-drop-text">
          <strong>{t('structure.freq_drop_outcar')}</strong>
          <span>{t('common.or')}</span>
        </div>
        <div class="freq-btn-row">
          <label class="freq-browse-btn">
            {t('structure.browse_local')}
            <input type="file" accept="*" hidden onchange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0]
              if (f) handle_file_upload(f)
            }} />
          </label>
          <button class="freq-browse-btn" onclick={() => show_source_dialog = true}>
            {t('structure.browse_remote')}
          </button>
        </div>
      {/if}
    </div>
    {#if error}
      <div class="freq-error">{error}</div>
    {/if}
  {:else}
    <!-- Frequency data display -->
    <div class="freq-header">
      <span class="freq-summary">
        {t('structure.freq_summary', { imaginary: freq_data.num_imaginary ?? 0, real: freq_data.real_freqs?.length ?? 0 })}
      </span>
      <button class="freq-reset-btn" onclick={() => { freq_data = null; gibbs_result = null; vib_playing = false; on_stop_vibration?.() }}>
        {t('structure.load_new')}
      </button>
    </div>

    <!-- Frequency table -->
    <div class="freq-table-section">
      {#if freq_data.imag_freqs?.length}
        <div class="freq-table-title">{t('structure.freq_imaginary_cm')}</div>
        <div class="freq-table">
          {#each freq_data.imag_freqs as f}
            <div class="freq-row freq-imag">
              <span>{f.index}:</span>
              <span class="mono">{f.frequency_cm.toFixed(1)} i</span>
              <span class="mono dim">{f.mev?.toFixed(2) ?? ''} meV</span>
            </div>
          {/each}
        </div>
      {/if}
      <div class="freq-table-title">{t('structure.freq_real_cm')}</div>
      <div class="freq-table">
        {#each (freq_data.real_freqs ?? []) as f}
          <div class="freq-row">
            <span>{f.index}:</span>
            <span class="mono">{f.frequency_cm.toFixed(1)}</span>
            <span class="mono dim">{f.mev?.toFixed(2) ?? ''} meV</span>
          </div>
        {/each}
      </div>
    </div>

    <!-- Gibbs Calculator -->
    <div class="freq-gibbs-section">
      <div class="freq-section-title">{t('structure.gibbs_free_energy_correction')}</div>
      <div class="freq-gibbs-form">
        <div class="freq-form-row">
          <label>{t('structure.mode')}</label>
          <div class="freq-radio-group">
            <label><input type="radio" bind:group={gibbs_mode} value="adsorbed" /> {t('structure.adsorbed')}</label>
            <label><input type="radio" bind:group={gibbs_mode} value="gas" /> {t('structure.gas')}</label>
          </div>
        </div>
        <div class="freq-form-row">
          <label>T (K)</label>
          <input type="number" bind:value={gibbs_temperature} step="0.01" min="1" />
        </div>
        {#if gibbs_mode === 'adsorbed'}
          <div class="freq-form-row">
            <label>{t('structure.freq_cutoff_cm')}</label>
            <input type="number" bind:value={gibbs_freq_cutoff} step="1" min="0" />
          </div>
        {:else}
          <div class="freq-form-row">
            <label>P (atm)</label>
            <input type="number" bind:value={gibbs_pressure_atm} step="0.01" min="0" />
          </div>
          <div class="freq-form-row">
            <label>{t('structure.unpaired_electrons')}</label>
            <input type="number" bind:value={gibbs_n_unpaired} step="1" min="0" />
          </div>
        {/if}
        <button class="freq-calc-btn" onclick={calculate_gibbs} disabled={gibbs_loading}>
          {gibbs_loading ? t('structure.calculating') : t('structure.calculate')}
        </button>
      </div>
      {#if gibbs_error}
        <div class="freq-error">{gibbs_error}</div>
      {/if}
      {#if gibbs_result}
        <div class="freq-gibbs-results">
          <div class="freq-gibbs-row freq-gibbs-highlight">
            <span>G_corr</span>
            <span class="mono">{(gibbs_result.g_corr_ev as number)?.toFixed(6)} eV</span>
            <span class="mono dim">({(gibbs_result.g_corr_kcal as number)?.toFixed(4)} kcal/mol)</span>
          </div>
          <div class="freq-gibbs-row">
            <span>ZPE</span>
            <span class="mono">{(gibbs_result.zpe_ev as number)?.toFixed(6)} eV</span>
          </div>
          <div class="freq-gibbs-row">
            <span>H(T) - E_elec</span>
            <span class="mono">{(gibbs_result.h_corr_ev as number)?.toFixed(6)} eV</span>
          </div>
          <div class="freq-gibbs-hint">{t('structure.gibbs_total_formula')}</div>
        </div>
      {/if}
    </div>

    <!-- Vibration mode selector -->
    {#if freq_data.eigenvectors?.length && freq_data.positions?.length}
      <div class="freq-vib-section">
        <div class="freq-section-title">{t('structure.vibration_modes')}</div>
        <div class="freq-form-row">
          <select class="freq-vib-select" bind:value={vib_selected} onchange={() => { if (vib_playing) play_vibration() }}>
            {#each all_modes as mode, i}
              <option value={i}>{mode.index}: {mode.frequency_cm.toFixed(1)} cm⁻¹{mode.imaginary ? ` (${t('structure.freq_imag_short')})` : ''}</option>
            {/each}
          </select>
        </div>
        <div class="freq-form-row">
          <label>{t('structure.amplitude')}</label>
          <input type="range" min="0.1" max="2.0" step="0.1" bind:value={vib_amplitude} class="freq-vib-slider" />
          <span class="mono">{vib_amplitude.toFixed(1)} Å</span>
        </div>
        <button class="freq-calc-btn" class:freq-stop-btn={vib_playing} onclick={toggle_vibration}>
          {vib_playing ? `■ ${t('common.stop')}` : `▶ ${t('structure.play')}`}
        </button>
      </div>
    {/if}
  {/if}
</div>

{#if show_source_dialog}
  <FileSourceDialog
    title={t('structure.load_outcar')}
    file_types={['.OUTCAR', 'OUTCAR']}
    onremote_path={handle_remote}
    onclose={() => show_source_dialog = false}
  />
{/if}

<style>
  .freq-pane {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    font-size: 12px;
  }
  .freq-dropzone {
    border: 2px dashed var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 6px;
    padding: 24px 16px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .freq-drop-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--text-color-dim, light-dark(#6b7280, #9ca3af));
  }
  .freq-btn-row {
    display: flex;
    gap: 8px;
  }
  .freq-browse-btn {
    padding: 4px 12px;
    font-size: 11px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    background: var(--input-bg, light-dark(#fff, #2a2b30));
    color: var(--text-color, light-dark(#374151, #eee));
    cursor: pointer;
    font-family: inherit;
  }
  .freq-browse-btn:hover { background: var(--hover-bg, light-dark(#f3f4f6, #333)); }
  .freq-loading { color: var(--accent-color, #3b82f6); }
  .freq-error {
    padding: 4px 8px;
    font-size: 11px;
    color: #ef4444;
    background: rgba(239, 68, 68, 0.08);
    border-radius: 4px;
  }
  .freq-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .freq-summary { font-weight: 600; }
  .freq-reset-btn {
    padding: 2px 8px;
    font-size: 10px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 3px;
    background: none;
    color: var(--text-color-dim);
    cursor: pointer;
    font-family: inherit;
  }
  .freq-table-section {
    max-height: 200px;
    overflow-y: auto;
  }
  .freq-table-title {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-color-dim, light-dark(#6b7280, #9ca3af));
    margin-top: 4px;
    margin-bottom: 2px;
  }
  .freq-table {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .freq-row {
    display: flex;
    gap: 8px;
    font-size: 11px;
    padding: 1px 4px;
    font-family: 'SF Mono', 'Monaco', monospace;
  }
  .freq-imag { color: #ef4444; }
  .freq-section-title {
    font-size: 11px;
    font-weight: 600;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#e5e7eb, #333));
    margin-bottom: 4px;
  }
  .freq-gibbs-section, .freq-vib-section {
    margin-top: 4px;
  }
  .freq-gibbs-form, .freq-gibbs-results {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .freq-form-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .freq-form-row label {
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#6b7280, #9ca3af));
    min-width: 75px;
  }
  .freq-form-row input[type="number"] {
    width: 80px;
    padding: 2px 4px;
    font-size: 10px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 3px;
    background: var(--input-bg, light-dark(#fff, #2a2b30));
    color: var(--text-color);
    font-family: 'SF Mono', 'Monaco', monospace;
  }
  .freq-radio-group {
    display: flex;
    gap: 10px;
    font-size: 10px;
  }
  .freq-radio-group label {
    display: flex;
    align-items: center;
    gap: 3px;
    min-width: auto;
    cursor: pointer;
  }
  .freq-radio-group input { margin: 0; }
  .freq-calc-btn {
    padding: 3px 12px;
    font-size: 11px;
    font-weight: 600;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    background: var(--accent-color, #3b82f6);
    color: #fff;
    cursor: pointer;
    font-family: inherit;
    align-self: flex-start;
    margin-top: 4px;
  }
  .freq-calc-btn:hover:not(:disabled) { filter: brightness(1.1); }
  .freq-calc-btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .freq-stop-btn { background: #ef4444; }
  .freq-gibbs-results { margin-top: 6px; }
  .freq-gibbs-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 11px;
  }
  .freq-gibbs-row span:first-child {
    min-width: 80px;
    color: var(--text-color-dim, light-dark(#6b7280, #9ca3af));
  }
  .freq-gibbs-highlight { font-weight: 600; color: #22c55e; }
  .freq-gibbs-highlight span:first-child { color: #22c55e !important; }
  .freq-gibbs-hint {
    margin-top: 4px;
    font-size: 9px;
    color: var(--text-color-dim);
    font-style: italic;
  }
  .freq-vib-select {
    flex: 1;
    padding: 2px 4px;
    font-size: 10px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 3px;
    background: var(--input-bg, light-dark(#fff, #2a2b30));
    color: var(--text-color);
    font-family: 'SF Mono', 'Monaco', monospace;
  }
  .freq-vib-slider {
    flex: 1;
    height: 14px;
    cursor: pointer;
  }
  .mono { font-family: 'SF Mono', 'Monaco', monospace; }
  .dim { opacity: 0.7; }
</style>
