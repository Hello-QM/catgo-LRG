<script lang="ts">
  import Icon from '$lib/Icon.svelte'
  import Spinner from '$lib/feedback/Spinner.svelte'
  import {
    CPU_SUPERCELL_CELL_WARN_THRESHOLD,
    GPU_SUPERCELL_MAX_INSTANCES,
    is_valid_supercell_input,
    parse_supercell_scaling,
  } from '$lib/structure/supercell'
  import type { CellType } from '$lib/symmetry'
  import type { MoyoDataset } from '@spglib/moyo-wasm'
  import { click_outside, tooltip } from 'svelte-multiselect/attachments'
  import { fade } from 'svelte/transition'

  let {
    supercell_scaling = $bindable(`1x1x1`),
    cell_type = $bindable(`original`),
    sym_data = null,
    loading = $bindable(false),
    direction = `down`,
    align = `right`,
    // WebGPU large-system overlay state. When ON, large factors route to the GPU
    // instancing path (no CPU expand, no freeze). When OFF, a large factor would
    // be built on the CPU and freeze the tab, so we warn / guard above a
    // threshold. Default false ⇒ preserves prior behaviour for embedders that
    // don't pass it.
    large_system_mode = false,
    // Base (unit) cell site count, used to estimate the effective GPU instance
    // count (base_site_count × cells) against the soft cap. 0 ⇒ unknown, skip
    // the cap check.
    base_site_count = 0,
    // Configurable thresholds (defaults from supercell.ts).
    cpu_warn_cells = CPU_SUPERCELL_CELL_WARN_THRESHOLD,
    gpu_max_instances = GPU_SUPERCELL_MAX_INSTANCES,
  }: {
    supercell_scaling: string
    cell_type?: CellType
    sym_data?: MoyoDataset | null
    loading?: boolean
    direction?: `up` | `down`
    align?: `left` | `right`
    large_system_mode?: boolean
    base_site_count?: number
    cpu_warn_cells?: number
    gpu_max_instances?: number
  } = $props()

  let menu_open = $state(false)
  let input_value = $state(supercell_scaling)
  let input_valid = $derived(is_valid_supercell_input(input_value))

  // Dedicated nx/ny/nz integer inputs. Seeded from the current scaling; kept in
  // sync when the prop changes externally (see $effect below).
  function parse_factors(scaling: string): [number, number, number] {
    try {
      return parse_supercell_scaling(scaling) as [number, number, number]
    } catch {
      return [1, 1, 1]
    }
  }
  let [init_nx, init_ny, init_nz] = parse_factors(supercell_scaling)
  let nx = $state(init_nx)
  let ny = $state(init_ny)
  let nz = $state(init_nz)

  // Coerce each axis to an integer ≥ 1 (number inputs can yield NaN / floats).
  let factors = $derived(
    [nx, ny, nz].map((v) => {
      const n = Math.floor(Number(v))
      return Number.isFinite(n) && n >= 1 ? n : 1
    }) as [number, number, number],
  )
  let factor_string = $derived(`${factors[0]}x${factors[1]}x${factors[2]}`)
  let cell_count = $derived(factors[0] * factors[1] * factors[2])
  let est_instances = $derived(base_site_count > 0 ? base_site_count * cell_count : 0)

  // Overlay OFF + large factor ⇒ a CPU build would freeze the tab. Warn + guard.
  let cpu_freeze_risk = $derived(!large_system_mode && cell_count > cpu_warn_cells)
  // Overlay ON but the effective GPU instance count blows past the soft cap.
  let gpu_over_cap = $derived(
    large_system_mode && est_instances > 0 && est_instances > gpu_max_instances,
  )
  // Block applying the factor inputs when it would freeze the CPU or exceed the
  // GPU cap. (Presets stay unconditionally clickable — they are all small.)
  let factor_blocked = $derived(cpu_freeze_risk || gpu_over_cap)

  function apply_factors() {
    if (gpu_over_cap) {
      console.warn(
        `[CellSelect] Refusing supercell ${factor_string}: ~${est_instances.toLocaleString()} ` +
          `GPU instances exceeds the soft cap of ${gpu_max_instances.toLocaleString()}. ` +
          `Reduce the factor to avoid a GPU hang.`,
      )
      return
    }
    if (cpu_freeze_risk) {
      console.warn(
        `[CellSelect] Refusing supercell ${factor_string} (${cell_count} cells): WebGPU ` +
          `large-system mode is OFF, so this would build on the CPU and freeze the tab.`,
      )
      return
    }
    supercell_scaling = factor_string
    input_value = factor_string
  }

  const supercell_presets = [`1x1x1`, `2x2x2`, `3x3x3`, `2x2x1`, `3x3x1`, `2x1x1`]

  // Always show all 3 cell types - Prim/Conv disabled without sym_data
  const cell_types: CellType[] = [`original`, `primitive`, `conventional`]
  const cell_labels: Record<CellType, string> = {
    original: `Orig`,
    primitive: `Prim`,
    conventional: `Conv`,
  }
  const cell_tooltips: Record<CellType, string> = {
    original: `Original unit cell (as provided)`,
    primitive: `Primitive cell (smallest repeating unit)`,
    conventional: `Conventional cell (standardized representation)`,
  }

  function apply_preset(preset: string) {
    supercell_scaling = preset
    input_value = preset
    menu_open = false
  }

  function handle_input_submit() {
    if (input_valid && input_value !== supercell_scaling) {
      supercell_scaling = input_value
      menu_open = false
    }
  }

  // Sync input value + nx/ny/nz when the external prop changes (e.g. a preset
  // applied elsewhere, or a reset). Only when the menu is closed so we don't
  // clobber a value the user is mid-edit.
  $effect(() => {
    if (!menu_open && supercell_scaling && supercell_scaling !== input_value) {
      input_value = supercell_scaling
      const [px, py, pz] = parse_factors(supercell_scaling)
      nx = px
      ny = py
      nz = pz
    }
  })
</script>

<div
  class="cell-select"
  role="group"
  {@attach click_outside({ callback: () => (menu_open = false) })}
  onmouseenter={() => (menu_open = true)}
  onmouseleave={() => (menu_open = false)}
  onfocusin={() => (menu_open = true)}
>
  <button
    type="button"
    onclick={() => (menu_open = !menu_open)}
    class="toggle-btn"
    class:active={menu_open}
    aria-expanded={menu_open}
    {@attach tooltip({ content: `Cell type & supercell` })}
  >
    {#if loading}
      <Spinner
        style="--spinner-border-width: 2px; --spinner-size: 1em; --spinner-margin: 0; display: inline-block; vertical-align: middle"
      />
    {:else}
      {cell_type !== `original` ? `${cell_labels[cell_type]} ` : ``}{supercell_scaling}
    {/if}
  </button>

  {#if menu_open}
    <div
      class="dropdown"
      class:open-up={direction === `up`}
      class:align-left={align === `left`}
      transition:fade={{ duration: 100 }}
    >
      <!-- Cell type selector -->
      <div class="cell-type-row">
        {#each cell_types as type (type)}
          {@const disabled = type !== `original` && !sym_data}
          {@const label = cell_labels[type]}
          {@const tooltip_text = disabled
          ? `${cell_tooltips[type]} - requires symmetry data`
          : cell_tooltips[type]}
          <button
            class="cell-type-btn"
            class:selected={cell_type === type}
            class:disabled
            {disabled}
            onclick={() => (cell_type = type)}
            title={tooltip_text}
            {@attach tooltip({ content: tooltip_text })}
          >
            {label}
          </button>
        {/each}
      </div>

      <!-- Supercell presets -->
      <div class="supercell-grid">
        {#each supercell_presets as preset (preset)}
          <button
            class="preset-btn"
            class:selected={supercell_scaling === preset}
            onclick={() => apply_preset(preset)}
          >
            {preset}
          </button>
        {/each}
      </div>

      <!-- Custom input -->
      <div class="custom-input-row">
        <input
          type="text"
          bind:value={input_value}
          placeholder="e.g. 2x2x2"
          class:invalid={!input_valid}
          onkeydown={(event) => event.key === `Enter` && handle_input_submit()}
        />
        <button
          class="apply-btn"
          disabled={!input_valid || input_value === supercell_scaling}
          onclick={handle_input_submit}
          title="Apply"
        >
          <Icon icon="Check" />
        </button>
      </div>

      <!-- Large custom factor: nx · ny · nz integer inputs. With the WebGPU
           large-system overlay ON, a big product routes to GPU instancing (no
           CPU expand, no freeze). With it OFF, a big product would freeze the
           CPU build, so we guard + warn below. -->
      <div class="factor-row">
        <input
          type="number"
          min="1"
          step="1"
          bind:value={nx}
          aria-label="supercell nx"
          onkeydown={(event) => event.key === `Enter` && apply_factors()}
        />
        <span class="factor-x">×</span>
        <input
          type="number"
          min="1"
          step="1"
          bind:value={ny}
          aria-label="supercell ny"
          onkeydown={(event) => event.key === `Enter` && apply_factors()}
        />
        <span class="factor-x">×</span>
        <input
          type="number"
          min="1"
          step="1"
          bind:value={nz}
          aria-label="supercell nz"
          onkeydown={(event) => event.key === `Enter` && apply_factors()}
        />
        <button
          class="apply-btn"
          disabled={factor_blocked || factor_string === supercell_scaling}
          onclick={apply_factors}
          title={cpu_freeze_risk
          ? `Enable large-system performance mode to apply`
          : gpu_over_cap
          ? `Exceeds GPU instance cap`
          : `Apply ${factor_string} (${cell_count} cells)`}
        >
          <Icon icon="Check" />
        </button>
      </div>

      {#if cpu_freeze_risk}
        <div class="factor-warn" role="alert">
          Large supercell ({cell_count} cells) — enable large-system performance mode to
          view without freezing.
        </div>
      {:else if gpu_over_cap}
        <div class="factor-warn" role="alert">
          ~{est_instances.toLocaleString()} instances exceeds the {gpu_max_instances.toLocaleString()}
          GPU cap — reduce the factor.
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .cell-select {
    position: relative;
    font-size: var(--struct-legend-font, clamp(9pt, 3.5cqmin, 12pt));
  }
  .toggle-btn {
    padding: var(--struct-legend-padding, 0 4pt);
    line-height: var(--struct-legend-line-height, 1.3);
    vertical-align: middle;
  }
  .dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 2px;
    background: var(--surface-bg, #222);
    padding: 5px;
    border-radius: var(--struct-border-radius, var(--border-radius, 3pt));
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    display: flex;
    flex-direction: column;
    gap: 4px;
    z-index: 100;
    min-width: 95px;
  }
  /* Invisible bridge to prevent menu closing when moving mouse from toggle to dropdown */
  .dropdown::before {
    content: '';
    position: absolute;
    top: -10px;
    left: 0;
    right: 0;
    height: 10px;
  }
  .dropdown.open-up {
    top: auto;
    bottom: 100%;
    margin-top: 0;
    margin-bottom: 2px;
  }
  .dropdown.open-up::before {
    top: auto;
    bottom: -10px;
  }
  .dropdown.align-left {
    right: auto;
    left: 0;
  }

  /* Cell type row - compact buttons with minimal padding */
  .cell-type-row {
    display: flex;
    gap: 1px;
    padding-bottom: 3px;
    border-bottom: 1px solid rgba(128, 128, 128, 0.3);
  }
  .cell-type-btn {
    flex: 1;
    padding: 1px 0;
    font-size: 0.9em;
    border-radius: var(--border-radius, 3pt);
    transition: background 0.15s ease;
    white-space: nowrap;
  }
  @media (hover: hover) {
    .cell-type-btn:hover:not(.disabled) {
      background: rgba(255, 255, 255, 0.15);
    }
  }
  .cell-type-btn.selected {
    background: rgba(0, 255, 255, 0.4);
    border-color: rgba(0, 255, 255, 0.5);
  }
  .cell-type-btn.disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Supercell grid */
  .supercell-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px;
  }
  .preset-btn {
    padding: 2px 4px;
    font-size: 0.9em;
    border-radius: var(--border-radius, 3pt);
  }
  @media (hover: hover) {
    .preset-btn:hover {
      background: rgba(255, 255, 255, 0.15);
    }
  }
  .preset-btn.selected {
    border-color: rgba(0, 255, 255, 0.5);
    background: rgba(0, 255, 255, 0.4);
  }

  /* Custom input row */
  .custom-input-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .custom-input-row input {
    max-width: 50px;
    padding: 2px 4px;
    margin-inline: 6px 0;
    font-size: 0.9em;
  }
  .custom-input-row input.invalid {
    border-color: rgba(255, 100, 100, 0.6);
  }
  .apply-btn {
    display: grid;
    place-items: center;
    padding: 2px 4px;
  }
  .apply-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Custom nx · ny · nz factor row */
  .factor-row {
    display: flex;
    align-items: center;
    gap: 2px;
    padding-top: 3px;
    border-top: 1px solid rgba(128, 128, 128, 0.3);
  }
  .factor-row input {
    width: 2.4em;
    min-width: 0;
    padding: 2px 3px;
    font-size: 0.9em;
    text-align: center;
    /* hide spinners to keep it compact */
    -moz-appearance: textfield;
    appearance: textfield;
  }
  .factor-row input::-webkit-outer-spin-button,
  .factor-row input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .factor-x {
    opacity: 0.7;
    font-size: 0.85em;
  }
  .factor-warn {
    font-size: 0.8em;
    line-height: 1.25;
    color: rgb(255, 180, 90);
    max-width: 160px;
    padding: 2px 1px 0;
  }
</style>
