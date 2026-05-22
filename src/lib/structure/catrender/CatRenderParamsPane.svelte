<script lang="ts">
  // RT13: PARAMS pane — one of the two independent DraggablePanes. Writes
  // ONLY into the shared `catrender_state` module (single source of truth);
  // it does NOT render or preview. CatRenderViewPane reads the same state
  // and owns the wasm render. No prop-drilling, no duplicated state.
  import { DraggablePane } from '$lib'
  import { catrender_state as S, PRESETS } from './catrender-state.svelte'

  let { show = $bindable(false) } = $props()

  // RT13 UX-honesty: the Cell box only draws when the structure has a
  // lattice (Rust core is xyzrender-faithful — a no-lattice molecule draws
  // no cell). Read the shared mirror's `lattice` so the toggle disables
  // itself instead of silently doing nothing. NO render/Rust change.
  let has_lattice = $derived(S.mirror?.lattice != null)

  // RT13 overlap fix: DraggablePane's toggle-less fallback hard-codes BOTH
  // panes to left:50px/top:50px, so the View pane 100% occludes this Params
  // pane on first open and the user can't find the knobs. There is no
  // toggle-less absolute-position PROP, but DraggablePane DOES expose its
  // pane element as a bindable (`pane_div`). We seed a distinct default
  // position on it once it mounts — but ONLY while it's still sitting at
  // the untouched 50px fallback, so a user drag (which writes other px
  // values to the same inline style) is never snapped back. Independent
  // dragging is therefore preserved; we only relocate the *initial* spot.
  let pane_div = $state<HTMLDivElement>()
  $effect(() => {
    if (show && pane_div && pane_div.style.left === `50px` && pane_div.style.top === `50px`) {
      pane_div.style.left = `32px`
      pane_div.style.top = `64px`
    }
  })
</script>

<DraggablePane
  bind:show
  bind:pane_div
  show_toggle={false}
  close_on_click_outside={false}
  max_width="26em"
  pane_props={{ class: `catrender-params-pane` }}
>
  <h4 class="pane-title">Render — Parameters</h4>

  <div class="controls">
    <label>Preset
      <select bind:value={S.preset}>
        {#each PRESETS as p}<option value={p}>{p}</option>{/each}
      </select>
    </label>
    <label title="hides hydrogens bonded to carbon (xyzrender rule; e.g. water O–H is never hidden)">
      <input type="checkbox" bind:checked={S.show_h} /> H</label>
    <label
      title={has_lattice
        ? `draw the periodic cell box`
        : `structure has no lattice — cell box only for periodic structures`}
      class:inert={!has_lattice}
    >
      <input
        type="checkbox"
        bind:checked={S.show_cell}
        disabled={!has_lattice}
      /> Cell</label>
    <label
      title={has_lattice
        ? `show dim periodic ghost images of boundary atoms`
        : `structure has no lattice — PBC images only for periodic structures`}
      class:inert={!has_lattice}
    >
      <input
        type="checkbox"
        bind:checked={S.pbc_wrap}
        disabled={!has_lattice}
      /> PBC</label>
    <label title="OpenBabel-style auto bond-order perception (molecular only — not for slabs/ionic)">
      <input type="checkbox" bind:checked={S.perceive_orders} /> perceive bond orders</label>
    <label title="Drop bonds far longer than covalent-radii sum (removes spurious over-long bonds from distance-based connectivity)">
      <input type="checkbox" bind:checked={S.prune_long_bonds} /> prune long bonds
    </label>
    <label title="Hide bonds crossing a periodic-cell boundary (drawn as long cell-spanning lines)">
      <input type="checkbox" bind:checked={S.hide_cross_cell_bonds} /> hide cross-cell bonds
    </label>
    <button onclick={() => S.reset_to_preset()}
      title="clear all knob overrides">Reset to preset</button>
  </div>

  <details class="panel" open>
    <summary>Knobs (override preset live — unchecked = inherit)</summary>
    <div class="knobs">
      <label class:active={S.k_atom_scale.on}>
        <input type="checkbox" bind:checked={S.k_atom_scale.on} /> atom_scale
        <input type="range" min="0" max="8" step="0.05"
          bind:value={S.k_atom_scale.v}
          oninput={() => (S.k_atom_scale.on = true)} />
        <span>{S.k_atom_scale.v}</span>
      </label>
      <label class:active={S.k_bond_width.on}>
        <input type="checkbox" bind:checked={S.k_bond_width.on} /> bond_width
        <input type="range" min="0" max="60" step="1"
          bind:value={S.k_bond_width.v}
          oninput={() => (S.k_bond_width.on = true)} />
        <span>{S.k_bond_width.v}</span>
      </label>
      <label class:active={S.k_atom_stroke_width.on}>
        <input type="checkbox" bind:checked={S.k_atom_stroke_width.on} />
        atom_stroke_width
        <input type="range" min="0" max="20" step="0.5"
          bind:value={S.k_atom_stroke_width.v}
          oninput={() => (S.k_atom_stroke_width.on = true)} />
        <span>{S.k_atom_stroke_width.v}</span>
      </label>
      <label class:active={S.k_hue.on}>
        <input type="checkbox" bind:checked={S.k_hue.on} /> hue_shift
        <input type="range" min="0" max="1" step="0.01" bind:value={S.k_hue.v}
          oninput={() => (S.k_hue.on = true)} />
        <span>{S.k_hue.v}</span>
      </label>
      <label class:active={S.k_light.on}>
        <input type="checkbox" bind:checked={S.k_light.on} /> light_shift
        <input type="range" min="0" max="1" step="0.01"
          bind:value={S.k_light.v} oninput={() => (S.k_light.on = true)} />
        <span>{S.k_light.v}</span>
      </label>
      <label class:active={S.k_sat.on}>
        <input type="checkbox" bind:checked={S.k_sat.on} /> sat_shift
        <input type="range" min="0" max="1" step="0.01" bind:value={S.k_sat.v}
          oninput={() => (S.k_sat.on = true)} />
        <span>{S.k_sat.v}</span>
      </label>
      <label class:active={S.k_fog_strength.on}>
        <input type="checkbox" bind:checked={S.k_fog_strength.on} />
        fog_strength
        <input type="range" min="0" max="3" step="0.05"
          bind:value={S.k_fog_strength.v}
          oninput={() => (S.k_fog_strength.on = true)} />
        <span>{S.k_fog_strength.v}</span>
      </label>
      <label class:active={S.k_label_font_size.on}>
        <input type="checkbox" bind:checked={S.k_label_font_size.on} />
        label_font_size
        <input type="number" min="0" max="120" step="1"
          bind:value={S.k_label_font_size.v}
          oninput={() => (S.k_label_font_size.on = true)} />
      </label>
      <label class:active={S.k_gradient.on}>
        <input type="checkbox" bind:checked={S.k_gradient.on} />
        gradient
        <input type="checkbox" bind:checked={S.k_gradient.v}
          onchange={() => (S.k_gradient.on = true)} />
      </label>
      <label class:active={S.k_fog.on}>
        <input type="checkbox" bind:checked={S.k_fog.on} /> fog
        <input type="checkbox" bind:checked={S.k_fog.v}
          onchange={() => (S.k_fog.on = true)} />
      </label>
      <label class:active={S.k_bond_orders.on}>
        <input type="checkbox" bind:checked={S.k_bond_orders.on} />
        bond_orders
        <input type="checkbox" bind:checked={S.k_bond_orders.v}
          onchange={() => (S.k_bond_orders.on = true)} />
      </label>
      <label class:active={S.k_bond_color_by_element.on}>
        <input type="checkbox" bind:checked={S.k_bond_color_by_element.on} />
        bond_color_by_element
        <input type="checkbox" bind:checked={S.k_bond_color_by_element.v}
          onchange={() => (S.k_bond_color_by_element.on = true)} />
      </label>
      <label class:active={S.k_bond_gradient.on}>
        <input type="checkbox" bind:checked={S.k_bond_gradient.on} />
        bond_gradient
        <input type="checkbox" bind:checked={S.k_bond_gradient.v}
          onchange={() => (S.k_bond_gradient.on = true)} />
      </label>
      <label class:active={S.k_atoms_above_bonds.on}>
        <input type="checkbox" bind:checked={S.k_atoms_above_bonds.on} />
        atoms_above_bonds
        <input type="checkbox" bind:checked={S.k_atoms_above_bonds.v}
          onchange={() => (S.k_atoms_above_bonds.on = true)} />
      </label>
      <label class:active={S.k_bond_color.on}>
        <input type="checkbox" bind:checked={S.k_bond_color.on} /> bond_color
        <input type="color" bind:value={S.k_bond_color.v}
          oninput={() => (S.k_bond_color.on = true)} />
      </label>
      <label class:active={S.k_background.on}>
        <input type="checkbox" bind:checked={S.k_background.on} /> background
        <input type="color" bind:value={S.k_background.v}
          oninput={() => (S.k_background.on = true)} />
      </label>
      <label class:active={S.k_cell_color.on}>
        <input type="checkbox" bind:checked={S.k_cell_color.on} /> cell_color
        <input type="color" bind:value={S.k_cell_color.v}
          oninput={() => (S.k_cell_color.on = true)} />
      </label>
    </div>
  </details>
</DraggablePane>

<style>
  .pane-title { margin: 0 0 6px; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .controls label.inert { opacity: 0.45; cursor: not-allowed; }
  .panel { border: 1px solid #ddd; border-radius: 6px; padding: 4px 8px;
    margin-top: 8px; }
  .panel summary { cursor: pointer; font-weight: 600; font-size: 13px; }
  .knobs {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 4px 14px;
    max-height: 320px;
    overflow-y: auto;
    padding: 6px 0;
  }
  .knobs label {
    display: flex; align-items: center; gap: 6px; font-size: 12px;
    opacity: 0.6;
  }
  .knobs label.active { opacity: 1; font-weight: 600; }
  .knobs label input[type='range'] { flex: 1; min-width: 60px; }
  .knobs label span { min-width: 34px; text-align: right; }
</style>
