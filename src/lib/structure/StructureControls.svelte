<script lang="ts">
  import type { AnyStructure } from '$lib'
  import { DraggablePane, format_num, Lattice, SettingsSection } from '$lib'
  import { PluginPanelHost } from '$lib/plugins'
  import type { ColorSchemeName } from '$lib/colors'
  import { axis_colors, element_color_schemes } from '$lib/colors'
  import { to_degrees, to_radians } from '$lib/math'
  import {
    DEFAULTS,
    LIGHTING_PROFILE_DEFAULTS,
    SETTINGS_CONFIG,
    BackendUrlSettings,
    ConnectWizard,
  } from '$lib/settings'
  import type { LightingProfile, RenderStyle } from '$lib/settings'
  import { check_tauri } from '$lib/io/tauri'
  import {
    DEFAULT_PANE_FONT_SIZE,
    pane_font_size_state,
    save_pane_font_size,
  } from '$lib/state.svelte'
  import { StructureScene } from '$lib/structure'
  import { is_valid_supercell_input } from '$lib/structure/supercell'
  import { untrack } from 'svelte'
  import type { ComponentProps } from 'svelte'
  import Select from 'svelte-multiselect'
  import { tooltip } from 'svelte-multiselect/attachments'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import LocaleSwitch from '$lib/i18n/LocaleSwitch.svelte'

  // Lazy-load structure translations
  load_i18n_module('structure')

  let {
    controls_open = $bindable(false),
    scene_props = $bindable({}),
    lattice_props = $bindable({
      show_cell_vectors: DEFAULTS.structure.show_cell_vectors,
      cell_edge_color: DEFAULTS.structure.cell_edge_color,
      cell_edge_opacity: DEFAULTS.structure.cell_edge_opacity,
      cell_surface_color: DEFAULTS.structure.cell_surface_color,
      cell_surface_opacity: DEFAULTS.structure.cell_surface_opacity,
      cell_edge_width: DEFAULTS.structure.cell_edge_width,
    }),
    show_image_atoms = $bindable(DEFAULTS.structure.show_image_atoms),
    image_atom_opacity = $bindable(1.0),
    periodic_repeats = $bindable<[number, number, number]>([0, 0, 0]),
    supercell_scaling = $bindable(`1x1x1`),
    background_color = $bindable(undefined),
    background_opacity = $bindable(DEFAULTS.background_opacity),
    color_scheme = $bindable(DEFAULTS.color_scheme),
    selection_opacity = $bindable(1.0),
    selected_sites = [] as number[],
    selected_bonds = [] as import('./index').SelectedBond[],
    atom_opacity_overrides = $bindable(new Map<number, number>()),
    bond_opacity_overrides = $bindable(new Map<string, number>()),
    structure = undefined,
    bond_distance_rules = $bindable<import('./index').BondDistanceRule[]>([]),
    large_system_mode = $bindable(false),
    webgpu_available = true,
    supercell_loading = false,
    pane_props = {},
    toggle_props = {},
    ...rest
  }: Omit<ComponentProps<typeof DraggablePane>, `children`> & {
    controls_open?: boolean // Control pane state
    scene_props?: ComponentProps<typeof StructureScene> & Record<string, any>
    lattice_props?: ComponentProps<typeof Lattice>
    show_image_atoms?: boolean
    image_atom_opacity?: number
    periodic_repeats?: [number, number, number]
    supercell_scaling?: string
    background_color?: string
    background_opacity?: number
    color_scheme?: string
    selection_opacity?: number
    selected_sites?: number[]
    selected_bonds?: import('./index').SelectedBond[]
    atom_opacity_overrides?: Map<number, number>
    bond_opacity_overrides?: Map<string, number>
    structure?: AnyStructure
    bond_distance_rules?: import('./index').BondDistanceRule[]
    large_system_mode?: boolean
    webgpu_available?: boolean
    supercell_loading?: boolean
    pane_props?: ComponentProps<typeof DraggablePane>[`pane_props`]
    toggle_props?: ComponentProps<typeof DraggablePane>[`toggle_props`]
  } = $props()

  // Only the VS Code / Antigravity extension webview sets `window.catgoData`
  // (injected by the extension's create_html). The desktop app and web build
  // don't, and they already expose a language switch in the top bar. So show
  // the in-panel language switch only inside the extension viewer.
  const in_vscode_webview = typeof window !== `undefined` &&
    !!(window as { catgoData?: unknown }).catgoData

  // Color scheme selection state
  let color_scheme_selected = $state([color_scheme])
  $effect(() => {
    if (color_scheme_selected.length > 0) {
      color_scheme = color_scheme_selected[0] as string
    }
  })

  // Atom label color management
  //
  // `scene_props.site_label_bg_color` is the *composed* value the renderer
  // consumes: `color-mix(in srgb, <picker color> <opacity%>, transparent)`.
  // The two $state vars below hold the *raw* inputs (color picker + opacity
  // slider) and the $effect recomposes them. Seeding the raw color directly
  // from the composed value re-wrapped it in another color-mix() on every
  // mount; the result persisted to localStorage, so the nesting depth grew by
  // one each session. A deeply nested color-mix() is O(2^depth) for the CSS
  // engine to resolve, so once site labels/indices became visible the main
  // thread froze (no JS error — pure style computation). Parse the composed
  // value back into its raw parts so the round-trip is idempotent.
  function parse_label_bg(raw: unknown): { color: string; opacity: number } {
    const fallback = { color: DEFAULTS.structure.site_label_bg_color, opacity: 0 }
    if (typeof raw !== `string` || raw === ``) return fallback
    const mix_count = (raw.match(/color-mix\(/g) ?? []).length
    if (mix_count === 0) return { color: raw, opacity: 0 } // legacy plain color
    if (mix_count > 1) return fallback // corrupted nested value → reset
    const m = raw.match(/^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%\s*,\s*transparent\)$/)
    if (!m) return fallback
    return { color: m[1], opacity: Number(m[2]) / 100 }
  }

  // untrack: intentional initial value capture from scene_props
  let site_label_hex_color = $state(
    untrack(() => scene_props.site_label_color) || DEFAULTS.structure.site_label_color,
  )
  const __label_bg_seed = untrack(() => parse_label_bg(scene_props.site_label_bg_color))
  let site_label_bg_hex_color = $state(__label_bg_seed.color)
  let site_label_background_opacity = $state(__label_bg_seed.opacity)

  $effect(() => {
    scene_props.site_label_color = site_label_hex_color
    scene_props.site_label_bg_color =
      `color-mix(in srgb, ${site_label_bg_hex_color} ${
        format_num(site_label_background_opacity, `.1~%`)
      }, transparent)`
  })

  // Ensure site_label_offset is always available
  untrack(() => { scene_props.site_label_offset ??= [...DEFAULTS.structure.site_label_offset] })

  // Detect if structure has force data
  let has_forces = $derived(
    structure?.sites?.some((site) =>
      site.properties?.force && Array.isArray(site.properties.force)
    ) ?? false,
  )

  // Detect per-atom magnetic moments (scalar collinear or 3-vector non-collinear).
  let has_magmom = $derived(
    structure?.sites?.some((site) => {
      const m = site.properties?.magmom
      return typeof m === `number` ? Math.abs(m) > 1e-3
        : Array.isArray(m) && m.length === 3
    }) ?? false,
  )

  // Detect if structure has lattice (can create supercells)
  let has_lattice = $derived(
    structure && `lattice` in structure && structure.lattice !== undefined,
  )

  // Validate supercell input
  let supercell_input_valid = $derived(is_valid_supercell_input(supercell_scaling))

  // Available elements in current structure (for bond distance rules)
  let available_elements = $derived(
    [...new Set(structure?.sites?.flatMap(s => s.species.map(sp => sp.element)) ?? [])].sort(),
  )

  function add_bond_rule() {
    const els = available_elements
    if (els.length < 2) return
    bond_distance_rules = [...bond_distance_rules, { element_1: els[0], element_2: els[1], min_dist: 0, max_dist: 3.0 }]
  }

  function remove_bond_rule(idx: number) {
    bond_distance_rules = bond_distance_rules.filter((_, i) => i !== idx)
  }

  function update_bond_rule(idx: number, field: string, value: string | number) {
    bond_distance_rules = bond_distance_rules.map((r, i) =>
      i === idx ? { ...r, [field]: value } : r,
    )
  }

  // Ensure rotation is always an array
  $effect(() => {
    scene_props.rotation ??= [...DEFAULTS.structure.rotation]
  })

  // ─── Per-render-style lighting profiles ───
  // The 5 Lighting-group sliders bind to the ACTIVE render_style's profile, so
  // each style remembers its own tuned values and switching styles swaps both
  // the sliders and the live render. Ensure the profile map + the active
  // style's profile always exist (old persisted scene_props, or tool-pushed
  // props, may lack them) so the binds below never hit undefined.
  $effect(() => {
    if (!scene_props.lighting_profiles) {
      scene_props.lighting_profiles = structuredClone(LIGHTING_PROFILE_DEFAULTS)
    }
    const style = (scene_props.render_style ?? DEFAULTS.structure.render_style) as RenderStyle
    scene_props.lighting_profiles[style] ??= {
      ...LIGHTING_PROFILE_DEFAULTS[style],
    }
  })

  // The active style's lighting profile — the object the 5 sliders bind into.
  // Falls back to a per-style default clone before the guard $effect runs (so
  // the first render never reads undefined).
  let active_lighting_profile = $derived<LightingProfile>(
    scene_props.lighting_profiles?.[
      (scene_props.render_style ?? DEFAULTS.structure.render_style) as RenderStyle
    ] ?? {
      ...LIGHTING_PROFILE_DEFAULTS[
        (scene_props.render_style ?? DEFAULTS.structure.render_style) as RenderStyle
      ],
    },
  )

  // Write one lighting param into the ACTIVE render_style's profile. Reassigns
  // both the style object AND the lighting_profiles map (new references) so the
  // controller's shallow-spread debounced-save $effect — which only reads the
  // top-level scene_props keys — re-runs and persists the change. Editing a
  // slider therefore writes profile[render_style].<param>, auto-persisted and
  // auto-remembered per style.
  function set_lighting_param(param: keyof LightingProfile, value: number) {
    const style = (scene_props.render_style ?? DEFAULTS.structure.render_style) as RenderStyle
    const map = scene_props.lighting_profiles ?? structuredClone(LIGHTING_PROFILE_DEFAULTS)
    const profile = map[style] ?? { ...LIGHTING_PROFILE_DEFAULTS[style] }
    scene_props.lighting_profiles = { ...map, [style]: { ...profile, [param]: value } }
  }

  // Reset ONLY the active render_style's lighting profile to its per-style
  // default (other styles keep their tuned values). Reassigns the map (new
  // top-level reference) so the debounced-save $effect re-runs.
  function reset_active_lighting_profile() {
    const style = (scene_props.render_style ?? DEFAULTS.structure.render_style) as RenderStyle
    const map = scene_props.lighting_profiles ?? structuredClone(LIGHTING_PROFILE_DEFAULTS)
    scene_props.lighting_profiles = { ...map, [style]: { ...LIGHTING_PROFILE_DEFAULTS[style] } }
  }

  let rotation_degrees = $derived(
    scene_props.rotation?.map((rad) => {
      const deg = to_degrees(rad)
      // Convert to [0, 360] range for UI display
      return ((deg % 360) + 360) % 360
    }) ?? [0, 0, 0],
  )

  function update_rotation(axis: `x` | `y` | `z`, degrees: number) {
    scene_props.rotation ??= [0, 0, 0]
    const axis_index = { x: 0, y: 1, z: 2 }[axis]
    const clamped = Math.max(0, Math.min(360, degrees))
    const norm = ((clamped % 360) + 360) % 360
    scene_props.rotation[axis_index] = to_radians(norm)
    // Trigger reactivity by creating new array
    scene_props.rotation = [...scene_props.rotation]
  }

  // Helper function to get example set of colors from an element color scheme
  function get_representative_colors(scheme_name: string): string[] {
    const scheme = element_color_schemes[scheme_name as ColorSchemeName]
    if (!scheme) return []

    // Get colors for common elements: H, C, N, O, Fe, Ca, Si, Al
    const sample_elements = [`H`, `C`, `N`, `O`, `Fe`, `Ca`, `Si`, `Al`]
    return sample_elements
      .slice(0, 4) // Take first 4
      .map((el) => scheme[el] || scheme.H || `#cccccc`)
      .filter(Boolean)
  }
</script>

<DraggablePane
  bind:show={controls_open}
  pane_props={{ ...pane_props, class: `controls-pane ${pane_props?.class ?? ``}` }}
  toggle_props={{
    title: controls_open ? `` : t('structure.controls'),
    ...toggle_props,
    class: `structure-controls-toggle ${toggle_props?.class ?? ``}`,
  }}
  {...rest}
>
  {#if in_vscode_webview}
    <!-- Language switch (extension webview only — desktop/web use the top bar) -->
    <div style="display: flex; align-items: center; gap: 8px; padding: 4px 2px 8px;">
      <span style="opacity: 0.7;">🌐</span>
      <LocaleSwitch style="flex: 1;" />
    </div>
  {/if}

  {#if !check_tauri()}
    <!-- Backend connection (web mode only — desktop Tauri uses the bundled sidecar) -->
    <div class="backend-connect-section">
      <BackendUrlSettings />
      <ConnectWizard />
    </div>
  {/if}

  <SettingsSection
    title={t('structure.visibility')}
    current_values={{
      show_atoms: scene_props.show_atoms,
      show_cell: scene_props.show_cell,
      show_bonds: scene_props.show_bonds,
      show_image_atoms,
      image_atom_opacity,
      show_site_labels: scene_props.show_site_labels,
      show_site_indices: scene_props.show_site_indices,
      show_force_vectors: scene_props.show_force_vectors,
      show_cell_vectors: lattice_props.show_cell_vectors,
    }}
    on_reset={() => {
      scene_props.show_atoms = DEFAULTS.structure.show_atoms
      scene_props.show_cell = DEFAULTS.structure.show_cell
      scene_props.show_bonds = DEFAULTS.structure.show_bonds
      scene_props.show_site_labels = DEFAULTS.structure.show_site_labels
      scene_props.show_site_indices = DEFAULTS.structure.show_site_indices
      scene_props.show_force_vectors = DEFAULTS.structure.show_force_vectors
      show_image_atoms = DEFAULTS.structure.show_image_atoms
      image_atom_opacity = 1.0
      periodic_repeats = [0, 0, 0]
      lattice_props.show_cell_vectors = DEFAULTS.structure.show_cell_vectors
    }}
  >
    <div class="visibility-grid">
      <label
        {@attach tooltip({ content: SETTINGS_CONFIG.structure.show_atoms.description })}
      >
        <input type="checkbox" bind:checked={scene_props.show_atoms} />
        {t('common.atoms')}
      </label>
      <label
        {@attach tooltip({
          content: SETTINGS_CONFIG.structure.show_image_atoms.description,
        })}
      >
        <input type="checkbox" bind:checked={show_image_atoms} />
        {t('structure.image_atoms')}
      </label>
      {#if show_image_atoms}
        <label>
          <span title="Opacity of periodic boundary condition image atoms" {@attach tooltip()}>{t('structure.image_opacity')}</span>
          <input type="number" min={0} max={1} step={0.05} bind:value={image_atom_opacity} />
          <input type="range" min={0} max={1} step={0.05} bind:value={image_atom_opacity} />
        </label>
        <div title="Number of periodic repeats in each direction (a, b, c)" style="grid-column: 1 / -1; display:flex; gap:6px; align-items:center; font-size:0.85em;">
          <span style="opacity:0.7">{t('structure.repeats')}</span>
          <span style="opacity:0.5">a</span><input type="number" min={0} max={5} step={1} style="width:2.5em" bind:value={periodic_repeats[0]} />
          <span style="opacity:0.5">b</span><input type="number" min={0} max={5} step={1} style="width:2.5em" bind:value={periodic_repeats[1]} />
          <span style="opacity:0.5">c</span><input type="number" min={0} max={5} step={1} style="width:2.5em" bind:value={periodic_repeats[2]} />
        </div>
      {/if}
      <label
        {@attach tooltip({
          content: SETTINGS_CONFIG.structure.show_site_labels.description,
        })}
      >
        <input type="checkbox" bind:checked={scene_props.show_site_labels} />
        {t('structure.site_labels')}
      </label>
      <label
        {@attach tooltip({
          content: SETTINGS_CONFIG.structure.show_site_indices.description,
        })}
      >
        <input type="checkbox" bind:checked={scene_props.show_site_indices} />
        {t('structure.site_indices')}
      </label>
      {#if scene_props.show_site_indices || scene_props.show_site_labels}
        <label
          style="grid-column: 1 / -1; display: flex; align-items: center; gap: 8px;"
          {@attach tooltip({
            content: `Distance of the label from the atom center (Å along Y).`,
          })}
        >
          <span style="white-space: nowrap;">{t('structure.label_offset')}</span>
          <input
            type="range"
            min="0"
            max="1.5"
            step="0.05"
            style="flex: 1;"
            value={scene_props.site_label_offset?.[1] ?? 0.25}
            oninput={(e) => {
              const v = +(e.currentTarget as HTMLInputElement).value
              const cur = scene_props.site_label_offset ?? [0, 0.25, 0]
              scene_props.site_label_offset = [cur[0], v, cur[2]]
            }}
          />
          <span style="min-width: 2.5em; text-align: right; font-variant-numeric: tabular-nums;">
            {(scene_props.site_label_offset?.[1] ?? 0.25).toFixed(2)}
          </span>
        </label>
      {/if}
      {#if has_forces}
        <label
          {@attach tooltip({
            content: SETTINGS_CONFIG.structure.show_force_vectors.description,
          })}
        >
          <input type="checkbox" bind:checked={scene_props.show_force_vectors} />
          {t('structure.force_vectors')}
        </label>
      {/if}
      {#if has_magmom}
        <label
          {@attach tooltip({
            content: SETTINGS_CONFIG.structure.show_magmom_vectors.description,
          })}
        >
          <input type="checkbox" bind:checked={scene_props.show_magmom_vectors} />
          {t('structure.magmom_vectors')}
        </label>
      {/if}
      <label
        {@attach tooltip({ content: SETTINGS_CONFIG.structure.show_cell.description })}
      >
        <input type="checkbox" bind:checked={scene_props.show_cell} />
        {t('structure.unit_cell')}
      </label>
      <label>
        <input type="checkbox" bind:checked={lattice_props.show_cell_vectors} />
        {t('structure.lattice_vectors')}
      </label>
    </div>
    <label
      {@attach tooltip({ content: SETTINGS_CONFIG.structure.show_bonds.description })}
    >
      {t('structure.bonds')}
      <select bind:value={scene_props.show_bonds}>
        {#each Object.entries(SETTINGS_CONFIG.structure.show_bonds.enum ?? {}) as
          [value, label]
          (value)
        }
          <option {value}>{label}</option>
        {/each}
      </select>
    </label>
    {#if available_elements.length >= 2}
      <div class="bond-rules">
        {#each bond_distance_rules as rule, idx (idx)}
          <div class="bond-rule-row">
            <select value={rule.element_1} onchange={(e) => update_bond_rule(idx, `element_1`, e.currentTarget.value)}>
              {#each available_elements as el}<option value={el}>{el}</option>{/each}
            </select>
            <span class="rule-sep">–</span>
            <select value={rule.element_2} onchange={(e) => update_bond_rule(idx, `element_2`, e.currentTarget.value)}>
              {#each available_elements as el}<option value={el}>{el}</option>{/each}
            </select>
            <input
              type="number" step="0.1" min="0" max="10"
              value={rule.min_dist}
              onchange={(e) => update_bond_rule(idx, `min_dist`, parseFloat(e.currentTarget.value) || 0)}
              class="dist-input"
            />
            <span class="rule-sep">~</span>
            <input
              type="number" step="0.1" min="0" max="10"
              value={rule.max_dist}
              onchange={(e) => update_bond_rule(idx, `max_dist`, parseFloat(e.currentTarget.value) || 3)}
              class="dist-input"
            />
            <span class="rule-unit">Å</span>
            <button type="button" class="rule-remove" onclick={(e) => { e.stopPropagation(); remove_bond_rule(idx) }} title="Remove rule">×</button>
          </div>
        {/each}
        <button type="button" class="add-rule-btn" onclick={add_bond_rule}>{t('structure.add_bond_rule')}</button>
      </div>
    {/if}
  </SettingsSection>

  <SettingsSection
    title={t('structure.camera')}
    current_values={{
      camera_projection: scene_props.camera_projection,
      auto_rotate: scene_props.auto_rotate,
      rotate_speed: scene_props.rotate_speed,
      zoom_speed: scene_props.zoom_speed,
      pan_speed: scene_props.pan_speed,
      zoom_to_cursor: scene_props.zoom_to_cursor,
      rotation_damping: scene_props.rotation_damping,
    }}
    on_reset={() => {
      scene_props.camera_projection = DEFAULTS.structure.camera_projection
      scene_props.auto_rotate = DEFAULTS.structure.auto_rotate
      scene_props.rotate_speed = DEFAULTS.structure.rotate_speed
      scene_props.zoom_speed = DEFAULTS.structure.zoom_speed
      scene_props.pan_speed = DEFAULTS.structure.pan_speed
      scene_props.zoom_to_cursor = DEFAULTS.structure.zoom_to_cursor
      scene_props.rotation_damping = DEFAULTS.structure.rotation_damping
    }}
  >
    <label>
      <span
        {@attach tooltip({
          content: SETTINGS_CONFIG.structure.camera_projection.description,
        })}
      >
        {t('structure.projection')}
      </span>
      <select bind:value={scene_props.camera_projection}>
        {#each Object.entries(
            SETTINGS_CONFIG.structure.camera_projection.enum ?? {},
          ) as
          [value, label]
          (value)
        }
          <option {value}>{label}</option>
        {/each}
      </select>
    </label>
    <label
      {@attach tooltip({ content: SETTINGS_CONFIG.structure.auto_rotate.description })}
    >
      {t('structure.auto_rotate_speed')}
      <input
        type="number"
        min={0}
        max={2}
        step={0.01}
        bind:value={scene_props.auto_rotate}
      />
      <input
        type="range"
        min={0}
        max={2}
        step={0.01}
        bind:value={scene_props.auto_rotate}
      />
    </label>
    <label
      {@attach tooltip({ content: SETTINGS_CONFIG.structure.rotate_speed.description })}
    >
      {t('structure.rotate_speed')}
      <input
        type="number"
        min={0}
        max={2}
        step={0.05}
        bind:value={scene_props.rotate_speed}
      />
      <input
        type="range"
        min={0}
        max={2}
        step={0.05}
        bind:value={scene_props.rotate_speed}
      />
    </label>
    <label
      {@attach tooltip({ content: SETTINGS_CONFIG.structure.zoom_speed.description })}
    >
      {t('structure.zoom_speed')}
      <input
        type="number"
        min={0.1}
        max={0.8}
        step={0.02}
        bind:value={scene_props.zoom_speed}
      />
      <input
        type="range"
        min={0.1}
        max={0.8}
        step={0.02}
        bind:value={scene_props.zoom_speed}
      />
    </label>
    <label
      {@attach tooltip({ content: SETTINGS_CONFIG.structure.pan_speed.description })}
    >
      {t('structure.pan_speed')}
      <input
        type="number"
        min={0}
        max={2}
        step={0.01}
        bind:value={scene_props.pan_speed}
      />
      <input
        type="range"
        min={0}
        max={2}
        step={0.01}
        bind:value={scene_props.pan_speed}
      />
    </label>
    <label
      {@attach tooltip({ content: SETTINGS_CONFIG.structure.zoom_to_cursor.description })}
    >
      <input type="checkbox" bind:checked={scene_props.zoom_to_cursor} />
      <span>{t('structure.zoom_to_cursor')}</span>
    </label>
    <label
      {@attach tooltip({ content: SETTINGS_CONFIG.structure.rotation_damping.description })}
    >
      {t('structure.rotation_damping')}
      <input
        type="number"
        min={0.01}
        max={0.3}
        step={0.01}
        bind:value={scene_props.rotation_damping}
      />
      <input
        type="range"
        min={0.01}
        max={0.3}
        step={0.01}
        bind:value={scene_props.rotation_damping}
      />
    </label>
  </SettingsSection>

  <SettingsSection
    title={t('structure.rotation')}
    current_values={{
      rotation: scene_props.rotation,
    }}
    on_reset={() => {
      scene_props.rotation = [...DEFAULTS.structure.rotation]
    }}
  >
    <div class="rotation-axes">
      {#each axis_colors as [axis, color], idx (axis)}
        <div>
          <div
            {@attach tooltip()}
            title="{axis}-axis rotation in degrees"
            style:color
          >
            <span>{axis.toUpperCase()} = </span>
            <input
              type="number"
              min={0}
              max={360}
              step={1}
              value={rotation_degrees[idx].toFixed(0)}
              oninput={(event) =>
              update_rotation(axis, Number(event.currentTarget.value))}
              style:color
              style="margin: 0"
            />
            °
          </div>
          <input
            type="range"
            min={0}
            max={360}
            step={1}
            value={rotation_degrees[idx].toFixed(0)}
            oninput={(event) => update_rotation(axis, Number(event.currentTarget.value))}
            style:--thumb-color={color}
            style="width: 100%"
          />
        </div>
      {/each}
    </div>
  </SettingsSection>

  <SettingsSection
    title={t('common.atoms')}
    current_values={{
      atom_radius: scene_props.atom_radius,
      same_size_atoms: scene_props.same_size_atoms,
      color_scheme,
    }}
    on_reset={() => {
      scene_props.atom_radius = DEFAULTS.structure.atom_radius
      scene_props.same_size_atoms = DEFAULTS.structure.same_size_atoms
      color_scheme = DEFAULTS.color_scheme
      color_scheme_selected = [DEFAULTS.color_scheme]
    }}
  >
    <label
      {@attach tooltip({ content: SETTINGS_CONFIG.structure.atom_radius.description })}
    >
      {t('structure.radius')}
      <input
        type="number"
        min={0.2}
        max={2}
        step={0.05}
        bind:value={scene_props.atom_radius}
      />
      <input
        type="range"
        min={0.2}
        max={2}
        step={0.05}
        bind:value={scene_props.atom_radius}
      />
    </label>
    <label
      {@attach tooltip({ content: SETTINGS_CONFIG.structure.same_size_atoms.description })}
    >
      {t('structure.same_size_atoms')}
      <input type="checkbox" bind:checked={scene_props.same_size_atoms} />
    </label>
    <label
      style="align-items: start"
      {@attach tooltip({ content: SETTINGS_CONFIG.color_scheme.description })}
    >
      {t('structure.color_scheme')}
      <Select
        options={Object.keys(element_color_schemes)}
        maxSelect={1}
        minSelect={1}
        bind:selected={color_scheme_selected}
        liOptionStyle="padding: 3pt 6pt;"
        style="width: 10em; border: none"
      >
        {#snippet children({ option })}
          {@const option_style =
            `display: flex; align-items: center; gap: 6pt; justify-content: space-between;`}
          <div style={option_style}>
            {option}
            <div style="display: flex; gap: 3pt">
              {#each get_representative_colors(String(option)) as color (color)}
                {@const color_style =
                `width: 15px; height: 15px; border-radius: 2px; background: ${color};`}
                <div style={color_style}></div>
              {/each}
            </div>
          </div>
        {/snippet}
      </Select>
    </label>
  </SettingsSection>

  {#if scene_props.show_site_labels || scene_props.show_site_indices}
    <SettingsSection
      title={t('structure.labels')}
      current_values={{
        site_label_size: scene_props.site_label_size,
        site_label_hex_color,
        site_label_bg_hex_color,
        site_label_background_opacity,
        site_label_padding: scene_props.site_label_padding,
        site_label_offset: scene_props.site_label_offset,
      }}
      on_reset={() => {
        scene_props.site_label_size = DEFAULTS.structure.site_label_size
        scene_props.site_label_padding = DEFAULTS.structure.site_label_padding
        scene_props.site_label_offset = [...DEFAULTS.structure.site_label_offset]
        site_label_hex_color = DEFAULTS.structure.site_label_color
        site_label_bg_hex_color = DEFAULTS.structure.site_label_bg_color
        site_label_background_opacity = 0
      }}
    >
      <div class="pane-row">
        <label>
          {t('structure.color')}
          <input type="color" bind:value={site_label_hex_color} />
        </label>
        <label>
          {t('structure.size')}
          <input
            type="range"
            min="0.5"
            max="2"
            step="0.1"
            bind:value={scene_props.site_label_size}
          />
        </label>
      </div>
      <div class="pane-row">
        <label>
          {t('structure.background')}
          <input type="color" bind:value={site_label_bg_hex_color} />
        </label>
        <label>
          {t('structure.opacity')}
          <input
            type="number"
            min="0"
            max="1"
            step="0.01"
            bind:value={site_label_background_opacity}
          />
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            bind:value={site_label_background_opacity}
          />
        </label>
      </div>
      <div class="pane-row">
        <label>
          {t('structure.padding')}
          <input
            type="number"
            min="0"
            max="10"
            step="1"
            bind:value={scene_props.site_label_padding}
          />
          <input
            type="range"
            min="0"
            max="10"
            step="1"
            bind:value={scene_props.site_label_padding}
          />
        </label>
      </div>
      <div class="pane-row">
        {t('structure.offset')}
        {#each [`X`, `Y`, `Z`] as axis, idx (axis)}
          <label>
            {axis}
            <input
              type="number"
              min="-1"
              max="1"
              step="0.1"
              bind:value={scene_props.site_label_offset![idx]}
            />
          </label>
        {/each}
      </div>
    </SettingsSection>
  {/if}

  {#if has_forces && scene_props.show_force_vectors}
    <SettingsSection
      title={t('structure.force_vectors')}
      current_values={{
        force_scale: scene_props.force_scale,
        force_color: scene_props.force_color,
        force_display_mode: scene_props.force_display_mode,
        force_color_mode: scene_props.force_color_mode,
      }}
      on_reset={() => {
        scene_props.force_scale = DEFAULTS.structure.force_scale
        scene_props.force_color = DEFAULTS.structure.force_color
        scene_props.force_display_mode = DEFAULTS.structure.force_display_mode
        scene_props.force_color_mode = DEFAULTS.structure.force_color_mode
        scene_props.force_range_min = DEFAULTS.structure.force_range_min
        scene_props.force_range_max = DEFAULTS.structure.force_range_max
      }}
    >
      <label>
        {t('structure.display_mode')}
        <select bind:value={scene_props.force_display_mode}>
          <option value="all">All Forces</option>
          <option value="max_only">Max Force Only</option>
          <option value="range">Range Filter</option>
        </select>
      </label>
      {#if scene_props.force_display_mode === 'range'}
        <div class="pane-row">
          <label>
            Min (eV/Å)
            <input type="number" min={0} step={0.01} bind:value={scene_props.force_range_min} />
          </label>
          <label>
            Max (eV/Å)
            <input type="number" min={0} step={0.01} bind:value={scene_props.force_range_max} />
          </label>
        </div>
      {/if}
      <label>
        {t('structure.scale')}
        <input
          type="number"
          min={0.001}
          max={5}
          step={0.001}
          bind:value={scene_props.force_scale}
        />
        <input
          type="range"
          min={0.001}
          max={5}
          step={0.001}
          bind:value={scene_props.force_scale}
        />
      </label>
      <div class="pane-row">
        <label>
          {t('structure.color_mode')}
          <select bind:value={scene_props.force_color_mode}>
            <option value="custom">Custom</option>
            <option value="element">Element</option>
          </select>
        </label>
        {#if scene_props.force_color_mode !== 'element'}
          <label>
            {t('structure.color')}
            <input type="color" bind:value={scene_props.force_color} />
          </label>
        {/if}
      </div>
    </SettingsSection>
  {/if}

  {#if has_lattice}
    <SettingsSection
      title={t('structure.cell')}
      current_values={{
        cell_edge_color: lattice_props.cell_edge_color,
        cell_edge_opacity: lattice_props.cell_edge_opacity,
        cell_edge_width: lattice_props.cell_edge_width,
        cell_surface_color: lattice_props.cell_surface_color,
        cell_surface_opacity: lattice_props.cell_surface_opacity,
        supercell_scaling,
      }}
      on_reset={() => {
        lattice_props.cell_edge_color = DEFAULTS.structure.cell_edge_color
        lattice_props.cell_edge_opacity = DEFAULTS.structure.cell_edge_opacity
        lattice_props.cell_edge_width = DEFAULTS.structure.cell_edge_width
        lattice_props.cell_surface_color = DEFAULTS.structure.cell_surface_color
        lattice_props.cell_surface_opacity = DEFAULTS.structure.cell_surface_opacity
        supercell_scaling = `1x1x1`
      }}
    >
      <label>
        <span
          {@attach tooltip({
            content:
              `Create supercells by repeating the unit cell. Examples: "2x2x2", "3x1x2", or "2"`,
          })}
        >
          {t('structure.supercell_scaling')}
        </span>
        <input
          type="text"
          bind:value={supercell_scaling}
          placeholder="1x1x1"
          style:border={supercell_input_valid ? undefined : `1px dashed red`}
          style:opacity={supercell_loading ? 0.5 : 1}
          disabled={supercell_loading}
          inputmode="text"
          autocomplete="off"
          spellcheck="false"
          pattern="^(\d+|\d+x\d+x\d+)$"
          aria-invalid={!supercell_input_valid}
          title={supercell_input_valid
          ? `Valid supercell scaling: ${supercell_scaling}`
          : `Invalid format. Use "2x2x2", "3x1x2", or "2"`}
        />
      </label>
      {#if supercell_loading}
        <div
          style="display: flex; align-items: center; gap: 8px; font-size: 0.85em; color: var(--accent-color); margin-top: 4pt"
        >
          <span
            class="spinner-icon"
            style="display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite"
          ></span>
          <span>{t('structure.generating_supercell')}</span>
        </div>
      {/if}

      {#if !supercell_input_valid}
        <div style="color: red; font-size: 0.8em; margin-top: 4pt">
          Invalid format. Use patterns like "2x2x2", "3x1x2", or "2".
        </div>
      {/if}

      {#each [
        {
          label: t('structure.edge_color'),
          color_prop: `cell_edge_color`,
          opacity_prop: `cell_edge_opacity`,
          step: 0.05,
        },
        {
          label: t('structure.surface_color'),
          color_prop: `cell_surface_color`,
          opacity_prop: `cell_surface_opacity`,
          step: 0.01,
        },
      ] as const as
        { label, color_prop, opacity_prop, step }
        (label)
      }
        <div class="pane-row">
          <label>
            {label}
            <input
              type="color"
              bind:value={lattice_props[color_prop]}
            />
          </label>
          <label>
            {t('structure.opacity')}
            <input
              type="number"
              min={0}
              max={1}
              {step}
              bind:value={lattice_props[opacity_prop]}
            />
            <input
              type="range"
              min={0}
              max={1}
              {step}
              bind:value={lattice_props[opacity_prop]}
            />
          </label>
        </div>
      {/each}
      <div class="pane-row">
        <label {@attach tooltip({
          content: SETTINGS_CONFIG.structure.cell_edge_width.description,
        })}>
          {t('structure.edge_width')}
          <input
            type="number"
            min={SETTINGS_CONFIG.structure.cell_edge_width.minimum}
            max={SETTINGS_CONFIG.structure.cell_edge_width.maximum}
            step={0.1}
            bind:value={lattice_props.cell_edge_width}
          />
          <input
            type="range"
            min={SETTINGS_CONFIG.structure.cell_edge_width.minimum}
            max={SETTINGS_CONFIG.structure.cell_edge_width.maximum}
            step={0.1}
            bind:value={lattice_props.cell_edge_width}
          />
        </label>
      </div>
    </SettingsSection>
  {/if}

  {#if scene_props.show_bonds && scene_props.show_bonds !== `never`}
    <SettingsSection
      title="Bonds"
      current_values={{
        bonding_strategy: scene_props.bonding_strategy,
        bond_color: scene_props.bond_color,
        bond_thickness: scene_props.bond_thickness,
        bond_scale: scene_props.bond_scale,
        incomplete_periodic_edge_mode: scene_props.incomplete_periodic_edge_mode,
        incomplete_edge_length_scale: scene_props.incomplete_edge_length_scale,
      }}
      on_reset={() => {
        scene_props.bonding_strategy = DEFAULTS.structure.bonding_strategy
        scene_props.bond_color = DEFAULTS.structure.bond_color
        scene_props.bond_thickness = DEFAULTS.structure.bond_thickness
        scene_props.bond_scale = DEFAULTS.structure.bond_scale
        scene_props.incomplete_periodic_edge_mode = DEFAULTS.structure.incomplete_periodic_edge_mode
        scene_props.incomplete_edge_length_scale = DEFAULTS.structure.incomplete_edge_length_scale
      }}
    >
      <label>
        {t('structure.strategy')} <select bind:value={scene_props.bonding_strategy}>
          {#each Object.entries(
            SETTINGS_CONFIG.structure.bonding_strategy.enum ?? {},
          ) as
            [value, label]
            (value)
          }
            <option {value}>{label}</option>
          {/each}
        </select>
      </label>
      {#if scene_props.bonding_strategy === `atom_radii`}
        <label
          {@attach tooltip({
            content: SETTINGS_CONFIG.structure.bond_scale.description,
          })}
        >
          {t('structure.bond_scale')}
          <input
            type="number"
            min={SETTINGS_CONFIG.structure.bond_scale.minimum}
            max={SETTINGS_CONFIG.structure.bond_scale.maximum}
            step={0.05}
            bind:value={scene_props.bond_scale}
          />
          <input
            type="range"
            min={SETTINGS_CONFIG.structure.bond_scale.minimum}
            max={SETTINGS_CONFIG.structure.bond_scale.maximum}
            step={0.05}
            bind:value={scene_props.bond_scale}
          />
        </label>
      {/if}
      <label>
        {t('structure.color')} <input type="color" bind:value={scene_props.bond_color} />
      </label>
      <label>
        {t('structure.thickness')}
        <input
          type="number"
          min={0.05}
          max={0.5}
          step={0.05}
          bind:value={scene_props.bond_thickness}
        />
        <input
          type="range"
          min={0.05}
          max={0.5}
          step={0.05}
          bind:value={scene_props.bond_thickness}
        />
      </label>
      <label
        {@attach tooltip({
          content: SETTINGS_CONFIG.structure.incomplete_periodic_edge_mode.description,
        })}
      >
        <input
          type="checkbox"
          bind:checked={scene_props.incomplete_periodic_edge_mode}
        />
        {t('structure.cell_edge_stub_bonds')}
      </label>
      {#if scene_props.incomplete_periodic_edge_mode}
        <label>
          {t('structure.stub_length')}
          <input
            type="number"
            min={0.05}
            max={1.0}
            step={0.05}
            bind:value={scene_props.incomplete_edge_length_scale}
          />
          <input
            type="range"
            min={0.05}
            max={1.0}
            step={0.05}
            bind:value={scene_props.incomplete_edge_length_scale}
          />
        </label>
      {/if}
      <label
        {@attach tooltip({
          content: SETTINGS_CONFIG.structure.bond_order_perception.description,
        })}
      >
        <input
          type="checkbox"
          bind:checked={scene_props.bond_order_perception}
        />
        {t('structure.bond_order_perception')}
      </label>
    </SettingsSection>
  {/if}

  <SettingsSection
    title={t('structure.clipping')}
    current_values={{
      clip_active: scene_props.clip_active,
      clip_radius: scene_props.clip_radius,
      clip_outside_mode: scene_props.clip_outside_mode,
    }}
    on_reset={() => {
      scene_props.clip_active = DEFAULTS.structure.clip_active
      scene_props.clip_radius = DEFAULTS.structure.clip_radius
      scene_props.clip_outside_mode = DEFAULTS.structure.clip_outside_mode
      scene_props.clip_outside_opacity = DEFAULTS.structure.clip_outside_opacity
    }}
  >
    <label>
      <input type="checkbox" bind:checked={scene_props.clip_active} />
      {t('structure.sphere_clipping')}
    </label>
    {#if scene_props.clip_active}
      <label>
        {t('structure.radius')}
        <input
          type="range"
          min="2"
          max="30"
          step="0.5"
          bind:value={scene_props.clip_radius}
        />
        <span>{scene_props.clip_radius}</span>
      </label>
      <label>
        {t('structure.outside_atoms')}
        <select bind:value={scene_props.clip_outside_mode}>
          <option value="hide">Hide</option>
          <option value="transparent">Semi-transparent</option>
        </select>
      </label>
      {#if scene_props.clip_outside_mode === `transparent`}
        <label>
          {t('structure.outside_opacity')}
          <input
            type="range"
            min="0"
            max="0.5"
            step="0.05"
            bind:value={scene_props.clip_outside_opacity}
          />
        </label>
      {/if}
    {/if}
  </SettingsSection>

  <SettingsSection
    title={t('structure.polyhedra')}
    current_values={{
      show_polyhedra: scene_props.show_polyhedra,
      polyhedra_opacity: scene_props.polyhedra_opacity,
      polyhedra_opacity_mode: scene_props.polyhedra_opacity_mode,
      polyhedra_color_mode: scene_props.polyhedra_color_mode,
      polyhedra_show_edges: scene_props.polyhedra_show_edges,
      polyhedra_max_neighbors: scene_props.polyhedra_max_neighbors,
      polyhedra_bond_scale: scene_props.polyhedra_bond_scale,
      polyhedra_edge_color: scene_props.polyhedra_edge_color,
      hide_polyhedra_center_atoms: scene_props.hide_polyhedra_center_atoms,
      hide_polyhedra_internal_bonds: scene_props.hide_polyhedra_internal_bonds,
    }}
    on_reset={() => {
      scene_props.show_polyhedra = DEFAULTS.structure.show_polyhedra
      scene_props.polyhedra_center_elements = DEFAULTS.structure.polyhedra_center_elements
      scene_props.polyhedra_min_coordination = DEFAULTS.structure.polyhedra_min_coordination
      scene_props.polyhedra_max_neighbors = DEFAULTS.structure.polyhedra_max_neighbors
      scene_props.polyhedra_bond_scale = DEFAULTS.structure.polyhedra_bond_scale
      scene_props.polyhedra_color_mode = DEFAULTS.structure.polyhedra_color_mode
      scene_props.polyhedra_color = DEFAULTS.structure.polyhedra_color
      scene_props.polyhedra_show_edges = DEFAULTS.structure.polyhedra_show_edges
      scene_props.polyhedra_opacity_mode = DEFAULTS.structure.polyhedra_opacity_mode
      scene_props.polyhedra_opacity = DEFAULTS.structure.polyhedra_opacity
      scene_props.polyhedra_opacity_near = DEFAULTS.structure.polyhedra_opacity_near
      scene_props.polyhedra_opacity_far = DEFAULTS.structure.polyhedra_opacity_far
      scene_props.polyhedra_edge_opacity = DEFAULTS.structure.polyhedra_edge_opacity
      scene_props.polyhedra_edge_color = DEFAULTS.structure.polyhedra_edge_color
      scene_props.polyhedra_color_overrides = DEFAULTS.structure.polyhedra_color_overrides
      scene_props.hide_polyhedra_center_atoms = DEFAULTS.structure.hide_polyhedra_center_atoms
      scene_props.hide_polyhedra_internal_bonds = DEFAULTS.structure.hide_polyhedra_internal_bonds
    }}
  >
    <label>
      <input type="checkbox" bind:checked={scene_props.show_polyhedra} />
      {t('structure.show_polyhedra')}
    </label>
    {#if scene_props.show_polyhedra}
      {#if available_elements.length}
        <div
          style="display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin:4px 0;"
        >
          <span>{t('structure.polyhedra_centers')}</span>
          {#if !scene_props.polyhedra_center_elements?.length}
            <em style="opacity:0.6;">{t('structure.polyhedra_centers_auto')}</em>
          {/if}
          {#each available_elements as el (el)}
            <label style="display:inline-flex; align-items:center; gap:2px;">
              <input
                type="checkbox"
                checked={scene_props.polyhedra_center_elements?.includes(el) ?? false}
                onchange={(e) => {
                  const cur = scene_props.polyhedra_center_elements ?? []
                  scene_props.polyhedra_center_elements = e.currentTarget.checked
                    ? [...cur, el]
                    : cur.filter((x) => x !== el)
                }}
              />
              {el}
            </label>
          {/each}
        </div>
      {/if}
      <label>
        {t('structure.min_coordination')}
        <input
          type="number"
          min="3"
          max="12"
          step="1"
          bind:value={scene_props.polyhedra_min_coordination}
        />
      </label>
      <label>
        {t(`structure.max_coordination`)}
        <input
          type="number"
          min="4"
          max="16"
          step="1"
          bind:value={scene_props.polyhedra_max_neighbors}
        />
        <input
          type="range"
          min="4"
          max="16"
          step="1"
          bind:value={scene_props.polyhedra_max_neighbors}
        />
      </label>
      <label
        {@attach tooltip({
          content: SETTINGS_CONFIG.structure.polyhedra_bond_scale.description,
        })}
      >
        {t(`structure.polyhedra_bond_scale`)}
        <input
          type="number"
          min={SETTINGS_CONFIG.structure.polyhedra_bond_scale.minimum}
          max={SETTINGS_CONFIG.structure.polyhedra_bond_scale.maximum}
          step={0.05}
          bind:value={scene_props.polyhedra_bond_scale}
        />
        <input
          type="range"
          min={SETTINGS_CONFIG.structure.polyhedra_bond_scale.minimum}
          max={SETTINGS_CONFIG.structure.polyhedra_bond_scale.maximum}
          step={0.05}
          bind:value={scene_props.polyhedra_bond_scale}
        />
      </label>
      <label>
        {t(`structure.polyhedra_color_label`)}
        <select bind:value={scene_props.polyhedra_color_mode}>
          <option value="vertex">{t(`structure.color_mode_vertex`)}</option>
          <option value="center">{t(`structure.color_mode_center`)}</option>
          <option value="uniform">{t(`structure.color_mode_uniform`)}</option>
        </select>
        {#if scene_props.polyhedra_color_mode === `uniform`}
          <input type="color" bind:value={scene_props.polyhedra_color} />
        {/if}
      </label>
      <label>
        {t('structure.opacity_mode')}
        <select bind:value={scene_props.polyhedra_opacity_mode}>
          <option value="uniform">Uniform</option>
          <option value="depth_gradient">Depth Gradient</option>
        </select>
      </label>
      {#if scene_props.polyhedra_opacity_mode === `uniform`}
        <label>
          {t('structure.face_opacity')}
          <input
            type="range"
            min="0.05"
            max="1"
            step="0.05"
            bind:value={scene_props.polyhedra_opacity}
          />
        </label>
      {:else}
        <label>
          {t('structure.near_opacity')}
          <input
            type="range"
            min="0.05"
            max="1"
            step="0.05"
            bind:value={scene_props.polyhedra_opacity_near}
          />
        </label>
        <label>
          {t('structure.far_opacity')}
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            bind:value={scene_props.polyhedra_opacity_far}
          />
        </label>
      {/if}
      <label>
        <input type="checkbox" bind:checked={scene_props.polyhedra_show_edges} />
        {t(`structure.show_edges`)}
        {#if scene_props.polyhedra_show_edges}
          <input type="color" bind:value={scene_props.polyhedra_edge_color} />
        {/if}
      </label>
      {#if scene_props.polyhedra_show_edges}
        <label>
          {t('structure.opacity')}
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            bind:value={scene_props.polyhedra_edge_opacity}
          />
        </label>
      {/if}
      <label>
        <input type="checkbox" bind:checked={scene_props.hide_polyhedra_center_atoms} />
        {t('structure.hide_center_atoms')}
      </label>
      <label>
        <input type="checkbox" bind:checked={scene_props.hide_polyhedra_internal_bonds} />
        {t('structure.hide_internal_bonds')}
      </label>
    {/if}
  </SettingsSection>

  <SettingsSection
    title={t('structure.hydrogen_bonds')}
    current_values={{
      show_hydrogen_bonds: scene_props.show_hydrogen_bonds,
      hbond_distance_cutoff: scene_props.hbond_distance_cutoff,
      hbond_angle_cutoff: scene_props.hbond_angle_cutoff,
      hbond_thickness: scene_props.hbond_thickness,
    }}
    on_reset={() => {
      scene_props.show_hydrogen_bonds = DEFAULTS.structure.show_hydrogen_bonds
      scene_props.hbond_distance_cutoff = DEFAULTS.structure.hbond_distance_cutoff
      scene_props.hbond_angle_cutoff = DEFAULTS.structure.hbond_angle_cutoff
      scene_props.hbond_thickness = DEFAULTS.structure.hbond_thickness
    }}
  >
    <label>
      <input type="checkbox" bind:checked={scene_props.show_hydrogen_bonds} />
      {t('structure.show_h_bonds')}
    </label>
    {#if scene_props.show_hydrogen_bonds}
      <label>
        {t('structure.distance_cutoff')}
        <input
          type="number"
          min={1.5}
          max={4.0}
          step={0.1}
          bind:value={scene_props.hbond_distance_cutoff}
        />
        <input
          type="range"
          min={1.5}
          max={4.0}
          step={0.1}
          bind:value={scene_props.hbond_distance_cutoff}
        />
      </label>
      <label>
        {t('structure.angle_cutoff')}
        <input
          type="number"
          min={90}
          max={180}
          step={5}
          bind:value={scene_props.hbond_angle_cutoff}
        />
        <input
          type="range"
          min={90}
          max={180}
          step={5}
          bind:value={scene_props.hbond_angle_cutoff}
        />
      </label>
      <label>
        {t('structure.thickness')}
        <input
          type="number"
          min={0.01}
          max={0.5}
          step={0.01}
          bind:value={scene_props.hbond_thickness}
        />
        <input
          type="range"
          min={0.01}
          max={0.5}
          step={0.01}
          bind:value={scene_props.hbond_thickness}
        />
      </label>
    {/if}
  </SettingsSection>

  <SettingsSection
    title={t('structure.appearance')}
    current_values={{
      background_color,
      background_opacity,
      // The 5 lighting params are PER render_style — track the ACTIVE profile so
      // the reset button reflects the active style's tuned-vs-default state.
      directional_light: active_lighting_profile.directional_light,
      ambient_light: active_lighting_profile.ambient_light,
      depth_cueing: scene_props.depth_cueing,
      depth_cue_start: scene_props.depth_cue_start,
      depth_cue_end: scene_props.depth_cue_end,
      atom_outline_strength: scene_props.atom_outline_strength,
      bond_outline_strength: scene_props.bond_outline_strength,
      render_style: scene_props.render_style,
      light_azimuth: active_lighting_profile.light_azimuth,
      light_elevation: active_lighting_profile.light_elevation,
      highlight_strength: active_lighting_profile.highlight_strength,
    }}
    on_reset={() => {
      background_color = undefined
      background_opacity = DEFAULTS.background_opacity
      scene_props.depth_cueing = DEFAULTS.structure.depth_cueing
      scene_props.depth_cue_start = DEFAULTS.structure.depth_cue_start
      scene_props.depth_cue_end = DEFAULTS.structure.depth_cue_end
      scene_props.atom_outline_strength = DEFAULTS.structure.atom_outline_strength
      scene_props.bond_outline_strength = DEFAULTS.structure.bond_outline_strength
      // Reset ONLY the currently-active render_style's lighting profile to its
      // per-style default — other styles keep their tuned values. Done BEFORE
      // resetting render_style so it targets the style the user is on.
      reset_active_lighting_profile()
      scene_props.render_style = DEFAULTS.structure.render_style
    }}
  >
    <h5>{t('structure.background')}</h5>
    <div class="pane-row">
      <label>
        {t('structure.color')}
        <!-- not using bind:value to not give a default value of #000000 to background_color, needs to stay undefined to not override --struct-bg theme color -->
        <input
          type="color"
          value={background_color}
          oninput={(event) => {
            background_color = (event.target as HTMLInputElement).value
          }}
        />
      </label>
      <label>
        {t('structure.opacity')}
        <input
          type="number"
          min={0}
          max={1}
          step={0.02}
          bind:value={background_opacity}
        />
        <input type="range" min={0} max={1} step={0.02} bind:value={background_opacity} />
      </label>
    </div>
    <h5>{t('structure.depth_cueing')}</h5>
    <label>
      <span title="Fades distant atoms toward background color to convey depth (0 = off, 1 = maximum)" {@attach tooltip()}>
        {t('structure.intensity')}
      </span>
      <input
        type="number"
        min={0}
        max={1}
        step={0.05}
        bind:value={scene_props.depth_cueing}
      />
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        bind:value={scene_props.depth_cueing}
      />
    </label>
    <label>
      <span title="Starting depth — atoms closer than this are unaffected (0 = front, 1 = back)" {@attach tooltip()}>
        {t('structure.start')}
      </span>
      <input
        type="number"
        min={0}
        max={1}
        step={0.05}
        bind:value={scene_props.depth_cue_start}
      />
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        bind:value={scene_props.depth_cue_start}
      />
    </label>
    <label>
      <span title="Ending depth — atoms beyond this are fully faded (0 = front, 1 = back)" {@attach tooltip()}>
        {t('structure.end')}
      </span>
      <input
        type="number"
        min={0}
        max={1}
        step={0.05}
        bind:value={scene_props.depth_cue_end}
      />
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        bind:value={scene_props.depth_cue_end}
      />
    </label>
    <label>
      <span title="Silhouette outline strength on atoms (0 = off). 3Dmol/PyMOL cartoon look." {@attach tooltip()}>
        {t('structure.atom_outline')}
      </span>
      <input
        type="number"
        min={0}
        max={1}
        step={0.05}
        bind:value={scene_props.atom_outline_strength}
      />
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        bind:value={scene_props.atom_outline_strength}
      />
    </label>
    <label>
      <span title="Silhouette outline strength on bonds. Independent of atom outline." {@attach tooltip()}>
        {t('structure.bond_outline')}
      </span>
      <input
        type="number"
        min={0}
        max={1}
        step={0.05}
        bind:value={scene_props.bond_outline_strength}
      />
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        bind:value={scene_props.bond_outline_strength}
      />
    </label>
    <label
      {@attach tooltip({ content: SETTINGS_CONFIG.structure.render_style.description })}
    >
      {t('structure.render_style')}
      <select bind:value={scene_props.render_style}>
        {#each Object.entries(
            SETTINGS_CONFIG.structure.render_style.enum ?? {},
          ) as
          [value, label]
          (value)
        }
          <option {value}>{t(`structure.render_style_${value}`) || label}</option>
        {/each}
      </select>
    </label>
    <h5>{t('structure.lighting')}</h5>
    <label
      {@attach tooltip({ content: SETTINGS_CONFIG.structure.light_azimuth.description })}
    >
      <span>{t('structure.light_azimuth')}</span>
      <input
        type="number"
        min={SETTINGS_CONFIG.structure.light_azimuth.minimum}
        max={SETTINGS_CONFIG.structure.light_azimuth.maximum}
        step={SETTINGS_CONFIG.structure.light_azimuth.step}
        value={active_lighting_profile.light_azimuth}
        oninput={(e) => set_lighting_param(`light_azimuth`, +e.currentTarget.value)}
      />
      <input
        type="range"
        min={SETTINGS_CONFIG.structure.light_azimuth.minimum}
        max={SETTINGS_CONFIG.structure.light_azimuth.maximum}
        step={SETTINGS_CONFIG.structure.light_azimuth.step}
        value={active_lighting_profile.light_azimuth}
        oninput={(e) => set_lighting_param(`light_azimuth`, +e.currentTarget.value)}
      />
    </label>
    <label
      {@attach tooltip({ content: SETTINGS_CONFIG.structure.light_elevation.description })}
    >
      <span>{t('structure.light_elevation')}</span>
      <input
        type="number"
        min={SETTINGS_CONFIG.structure.light_elevation.minimum}
        max={SETTINGS_CONFIG.structure.light_elevation.maximum}
        step={SETTINGS_CONFIG.structure.light_elevation.step}
        value={active_lighting_profile.light_elevation}
        oninput={(e) => set_lighting_param(`light_elevation`, +e.currentTarget.value)}
      />
      <input
        type="range"
        min={SETTINGS_CONFIG.structure.light_elevation.minimum}
        max={SETTINGS_CONFIG.structure.light_elevation.maximum}
        step={SETTINGS_CONFIG.structure.light_elevation.step}
        value={active_lighting_profile.light_elevation}
        oninput={(e) => set_lighting_param(`light_elevation`, +e.currentTarget.value)}
      />
    </label>
    <label
      {@attach tooltip({ content: SETTINGS_CONFIG.structure.highlight_strength.description })}
    >
      <span>{t('structure.highlight_strength')}</span>
      <input
        type="number"
        min={SETTINGS_CONFIG.structure.highlight_strength.minimum}
        max={SETTINGS_CONFIG.structure.highlight_strength.maximum}
        step={SETTINGS_CONFIG.structure.highlight_strength.step}
        value={active_lighting_profile.highlight_strength}
        oninput={(e) => set_lighting_param(`highlight_strength`, +e.currentTarget.value)}
      />
      <input
        type="range"
        min={SETTINGS_CONFIG.structure.highlight_strength.minimum}
        max={SETTINGS_CONFIG.structure.highlight_strength.maximum}
        step={SETTINGS_CONFIG.structure.highlight_strength.step}
        value={active_lighting_profile.highlight_strength}
        oninput={(e) => set_lighting_param(`highlight_strength`, +e.currentTarget.value)}
      />
    </label>
    <label>
      <span title="Intensity of the directional light" {@attach tooltip()}>
        {t('structure.directional_light')}
      </span>
      <input
        type="number"
        min={0}
        max={4}
        step={0.01}
        value={active_lighting_profile.directional_light}
        oninput={(e) => set_lighting_param(`directional_light`, +e.currentTarget.value)}
      />
      <input
        type="range"
        min={0}
        max={4}
        step={0.01}
        value={active_lighting_profile.directional_light}
        oninput={(e) => set_lighting_param(`directional_light`, +e.currentTarget.value)}
      />
    </label>
    <label>
      <span title="Intensity of the ambient light" {@attach tooltip()}>
        {t('structure.ambient_light')}
      </span>
      <input
        type="number"
        min={0.5}
        max={3}
        step={0.05}
        value={active_lighting_profile.ambient_light}
        oninput={(e) => set_lighting_param(`ambient_light`, +e.currentTarget.value)}
      />
      <input
        type="range"
        min={0.5}
        max={3}
        step={0.05}
        value={active_lighting_profile.ambient_light}
        oninput={(e) => set_lighting_param(`ambient_light`, +e.currentTarget.value)}
      />
    </label>
  </SettingsSection>

  {#if selected_sites.length > 0 || selected_bonds.length > 0 || atom_opacity_overrides.size > 0 || bond_opacity_overrides.size > 0}
    <SettingsSection
      title={t('structure.selection_opacity')}
      current_values={{ selection_opacity }}
      on_reset={() => {
        selection_opacity = 1.0
        atom_opacity_overrides = new Map()
        bond_opacity_overrides = new Map()
      }}
    >
      {#if selected_sites.length > 0 || selected_bonds.length > 0}
        <label>
          <span title="Adjust opacity of selected atoms/bonds. Changes persist after deselection." {@attach tooltip()}>
            {t('structure.opacity')}
          </span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            bind:value={selection_opacity}
          />
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            bind:value={selection_opacity}
          />
        </label>
        <small style="color: var(--text-color-muted, #888)">
          {selected_sites.length} atom{selected_sites.length !== 1 ? 's' : ''}{selected_bonds.length > 0 ? `, ${selected_bonds.length} bond${selected_bonds.length !== 1 ? 's' : ''}` : ''} selected
        </small>
      {/if}
      {#if atom_opacity_overrides.size > 0 || bond_opacity_overrides.size > 0}
        <small style="color: var(--text-color-muted, #888)">
          {atom_opacity_overrides.size} atom{atom_opacity_overrides.size !== 1 ? 's' : ''}, {bond_opacity_overrides.size} bond{bond_opacity_overrides.size !== 1 ? 's' : ''} with custom opacity
        </small>
      {/if}
    </SettingsSection>
  {/if}

  <SettingsSection
    title={t('structure.manipulation')}
    current_values={{
      keyboard_movement_step: scene_props.keyboard_movement_step,
    }}
    on_reset={() => {
      scene_props.keyboard_movement_step = DEFAULTS.structure.keyboard_movement_step
    }}
  >
    <label
      {@attach tooltip({
        content: SETTINGS_CONFIG.structure.keyboard_movement_step.description,
      })}
    >
      {t('structure.keyboard_step')}
      <input
        type="number"
        min={0.01}
        max={1}
        step={0.01}
        bind:value={scene_props.keyboard_movement_step}
      />
      <input
        type="range"
        min={0.01}
        max={1}
        step={0.01}
        bind:value={scene_props.keyboard_movement_step}
      />
    </label>
    <div style="font-size: 0.8em; color: var(--text-color-muted, #888); margin-top: 4pt">
      {t('structure.keyboard_step_hint')}
    </div>
  </SettingsSection>

  <SettingsSection
    title={t('structure.font_size')}
    current_values={{ pane_font_size: pane_font_size_state.size }}
    on_reset={() => {
      pane_font_size_state.size = DEFAULT_PANE_FONT_SIZE
      save_pane_font_size(DEFAULT_PANE_FONT_SIZE)
      document.documentElement.style.setProperty(`--pane-font-size`, `${DEFAULT_PANE_FONT_SIZE}em`)
    }}
  >
    <label>
      <span>{t('structure.pane_text_size')}</span>
      <span style="font-size: 0.85em; opacity: 0.7; min-width: 2.5em; text-align: right">
        {Math.round(pane_font_size_state.size * 100)}%
      </span>
    </label>
    <label>
      <select
        value={pane_font_size_state.size}
        onchange={(e) => {
          const v = parseFloat(e.currentTarget.value)
          if (!isNaN(v)) {
            pane_font_size_state.size = v
            save_pane_font_size(v)
            document.documentElement.style.setProperty(`--pane-font-size`, `${v}em`)
          }
        }}
      >
        {#each [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2, 1.3] as size}
          <option value={size}>{Math.round(size * 100)}%</option>
        {/each}
      </select>
    </label>
  </SettingsSection>

  <!-- Plugin Panels -->
  <PluginPanelHost
    location="structure-sidebar"
    {structure}
    onRequestRender={() => {
      // Trigger scene re-render by nudging rotation (temporary workaround)
      // TODO: Implement proper scene refresh mechanism for plugins
      if (scene_props.rotation) {
        scene_props.rotation = [...scene_props.rotation]
      }
    }}
  />
</DraggablePane>

<style>
  /* Backend connection block (web mode) — sits above the display settings */
  .backend-connect-section {
    display: flex;
    flex-direction: column;
    gap: 8pt;
    padding-bottom: 8pt;
    margin-bottom: 4pt;
    border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  }

  /* Visibility checkboxes in 2-column grid */
  .visibility-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px 12px;
  }

  .rotation-axes {
    display: flex;
    gap: 9pt;
    font-size: 0.8em;
  }
  .rotation-axes > div {
    display: grid;
    gap: 0.3em;
    place-items: center;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  /* Bond distance rules */
  .bond-rules {
    margin-top: 4px;
  }
  .bond-rule-row {
    display: flex;
    align-items: center;
    gap: 3px;
    margin-bottom: 3px;
  }
  .bond-rule-row select {
    width: 48px;
    padding: 1px 2px;
    font-size: 0.85em;
  }
  .dist-input {
    width: 46px;
    padding: 1px 3px;
    font-size: 0.85em;
    text-align: center;
  }
  .rule-sep {
    font-size: 0.85em;
    opacity: 0.6;
  }
  .rule-unit {
    font-size: 0.8em;
    opacity: 0.5;
  }
  .rule-remove {
    background: none;
    border: none;
    color: #e55;
    cursor: pointer;
    font-size: 1em;
    padding: 0 3px;
    line-height: 1;
  }
  .rule-remove:hover {
    color: #f77;
  }
  .add-rule-btn {
    background: none;
    border: 1px dashed rgba(255, 255, 255, 0.2);
    color: inherit;
    cursor: pointer;
    font-size: 0.82em;
    padding: 2px 8px;
    border-radius: 4px;
    opacity: 0.7;
    margin-top: 2px;
  }
  .add-rule-btn:hover {
    opacity: 1;
    border-color: rgba(255, 255, 255, 0.4);
  }
</style>
