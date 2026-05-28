<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module(`workflow`)

  interface FreqEntry {
    index: number
    frequency_cm: number
    thz?: number
    mev?: number
  }

  let {
    real_freqs,
    imag_freqs,
    eigenvectors,
    positions,
    onplay_vibration,
    onstop_vibration,
  }: {
    real_freqs: FreqEntry[]
    imag_freqs: FreqEntry[]
    eigenvectors: number[][][]
    positions: number[][]
    onplay_vibration?: (data: { eigenvector: number[][]; base_positions: number[][]; amplitude: number }) => void
    onstop_vibration?: () => void
  } = $props()

  // Combine all modes: imaginary first, then real
  const all_modes = $derived([
    ...imag_freqs.map(f => ({ ...f, imaginary: true })),
    ...real_freqs.map(f => ({ ...f, imaginary: false })),
  ])

  // Default to first imaginary mode, or first real mode
  let selected_index = $state(0)
  let amplitude = $state(0.5)
  let playing = $state(false)

  // Auto-select first imaginary mode when data changes
  $effect(() => {
    if (imag_freqs.length > 0) {
      selected_index = 0
    } else if (real_freqs.length > 0) {
      selected_index = imag_freqs.length  // first real mode
    }
  })

  function toggle_play() {
    if (playing) {
      stop()
    } else {
      play()
    }
  }

  function play() {
    if (!all_modes.length || !eigenvectors.length) return

    // Map selected dropdown index to eigenvector index
    // Eigenvectors are ordered: imag modes first (by their OUTCAR index), then real modes
    const mode = all_modes[selected_index]
    if (!mode) return

    // Find the eigenvector index: imaginary modes come before real in OUTCAR
    const eig_idx = mode.imaginary
      ? imag_freqs.findIndex(f => f.index === mode.index)
      : imag_freqs.length + real_freqs.findIndex(f => f.index === mode.index)

    if (eig_idx < 0 || eig_idx >= eigenvectors.length) return

    playing = true
    onplay_vibration?.({
      eigenvector: eigenvectors[eig_idx],
      base_positions: positions,
      amplitude,
    })
  }

  function stop() {
    playing = false
    onstop_vibration?.()
  }

  // Update amplitude while playing
  $effect(() => {
    if (playing && onplay_vibration) {
      const mode = all_modes[selected_index]
      if (!mode) return

      const eig_idx = mode.imaginary
        ? imag_freqs.findIndex(f => f.index === mode.index)
        : imag_freqs.length + real_freqs.findIndex(f => f.index === mode.index)

      if (eig_idx >= 0 && eig_idx < eigenvectors.length) {
        onplay_vibration({
          eigenvector: eigenvectors[eig_idx],
          base_positions: positions,
          amplitude,
        })
      }
    }
  })
</script>

<div class="vib-section">
  <div class="sp-section-title">{t(`workflow.vibration_modes`)}</div>

  <div class="vib-row">
    <select class="vib-select" bind:value={selected_index} onchange={() => { if (playing) play() }}>
      {#each all_modes as mode, i}
        <option value={i}>
          {mode.index}: {mode.frequency_cm.toFixed(1)} cm⁻¹{mode.imaginary ? ` (${t(`workflow.imag`)})` : ''}
        </option>
      {/each}
    </select>
  </div>

  <div class="vib-row">
    <label class="vib-label">{t(`workflow.amplitude`)}</label>
    <input
      type="range"
      class="vib-slider"
      min="0.1"
      max="2.0"
      step="0.1"
      bind:value={amplitude}
    />
    <span class="vib-amp-val mono">{amplitude.toFixed(1)} Å</span>
  </div>

  <div class="vib-row">
    <button class="vib-btn" class:vib-playing={playing} onclick={toggle_play}>
      {playing ? t(`workflow.stop_vibration`) : t(`workflow.play_vibration`)}
    </button>
  </div>
</div>

<style>
  .vib-section {
    margin-top: 8px;
    border-top: 1px solid var(--dialog-border, light-dark(#e5e7eb, #333));
    padding-top: 6px;
  }
  .vib-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
  }
  .vib-select {
    flex: 1;
    padding: 2px 4px;
    font-size: 10px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 3px;
    background: var(--input-bg, light-dark(#fff, #2a2b30));
    color: var(--text-color, light-dark(#374151, #eee));
    font-family: 'SF Mono', 'Monaco', monospace;
  }
  .vib-label {
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#6b7280, #9ca3af));
    white-space: nowrap;
    min-width: 55px;
  }
  .vib-slider {
    flex: 1;
    height: 14px;
    cursor: pointer;
  }
  .vib-amp-val {
    font-size: 10px;
    color: var(--text-color, light-dark(#374151, #ddd));
    min-width: 32px;
    text-align: right;
  }
  .vib-btn {
    padding: 3px 12px;
    font-size: 11px;
    font-weight: 600;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    background: var(--accent-color, #3b82f6);
    color: #fff;
    cursor: pointer;
    font-family: inherit;
  }
  .vib-btn:hover { filter: brightness(1.1); }
  .vib-playing {
    background: #ef4444;
  }
  .vib-playing:hover { filter: brightness(1.1); }
  .mono {
    font-family: 'SF Mono', 'Monaco', monospace;
  }
</style>
