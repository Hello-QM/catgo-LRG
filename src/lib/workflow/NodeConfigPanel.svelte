<script lang="ts">
  import '$lib/dialog-shared.css'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { Snippet } from 'svelte'
  import type { NodeDefinition, ParamDef } from './workflow-types'
  import { STATUS_COLORS } from './workflow-types'
  import { SOFTWARE_PERIODICITY } from './node-definitions'
  import { API_BASE } from '$lib/api/config'

  // ─── Load workflow i18n on mount ───
  $effect(() => { load_i18n_module('workflow') })

  let {
    node,
    definition,
    status,
    workflow_id,
    onfreeze_edit,
    onparams_change,
    children,
  }: {
    node: { id: string; type: string; params: Record<string, unknown> }
    definition: NodeDefinition
    status?: string
    workflow_id?: string
    onfreeze_edit?: () => void
    onparams_change?: (params: Record<string, unknown>) => void
    children?: Snippet
  } = $props()

  // ─── Helpers ───
  function emit(params: Record<string, unknown>) {
    onparams_change?.(params)
  }

  // ─── Gibbs Energy: fetch computed result when completed ───
  interface GibbsResult {
    gibbs?: number
    energy?: number
    zpe?: number
    ts_correction?: number
    g_corr?: number
    phase?: string
    n_real_freqs?: number
    n_imag_freqs?: number
  }
  let gibbs_result = $state<GibbsResult | null>(null)
  let _gibbs_fetch_key = ``

  $effect(() => {
    const key = `${node.id}:${status}:${workflow_id}`
    if (key === _gibbs_fetch_key) return
    _gibbs_fetch_key = key

    if (node.type !== `gibbs_energy` || status !== `completed` || !workflow_id) {
      gibbs_result = null
      return
    }
    fetch(`${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/steps`)
      .then(r => r.ok ? r.json() : [])
      .then((steps: any[]) => {
        const step = steps.find((s: any) => s.id === node.id)
        if (step?.result_json) {
          const parsed = typeof step.result_json === `string` ? JSON.parse(step.result_json) : step.result_json
          gibbs_result = parsed
        }
      })
      .catch(() => { gibbs_result = null })
  })

  // ─── Local state ───
  let show_help = $state(false)
  let expanded_help_keys = $state(new Set<string>())

  // Groups that should start expanded (the rest collapse by default)
  const ALWAYS_OPEN_GROUPS = new Set([`Software`, `General`, `Model`, `Optimizer`, `Doping`, `Thermodynamics`, `Diagram`, `Freeze Atoms`])

  // Track user-explicit group toggles — survives param changes and re-renders.
  // Reset when switching to a different node.
  let user_group_overrides = $state<Record<string, boolean>>({})

  // ─── Helpers: conditional param visibility ───
  function is_param_visible(param: ParamDef, current_params: Record<string, unknown>): boolean {
    if (!param.show_if) return true
    const conditions = Array.isArray(param.show_if) ? param.show_if : [param.show_if]
    return conditions.every(cond => {
      const val = current_params[cond.key]
      return cond.values.map(v => String(v)).includes(String(val ?? ``))
    })
  }

  /** Filter options by system_type (software param) and by each option's own show_if condition */
  function get_filtered_options(param: ParamDef, current_params: Record<string, unknown>): ParamDef[`options`] {
    if (!param.options) return param.options
    let opts = param.options

    // Filter software options by system_type compatibility
    if (param.key === `software`) {
      const sys_type = String(current_params.system_type ?? ``)
      if (sys_type === `periodic` || sys_type === `molecular`) {
        opts = opts.filter(opt => {
          const allowed = SOFTWARE_PERIODICITY[String(opt.value)]
          return !allowed || allowed.includes(sys_type)
        })
      }
    }

    // Filter any option that has its own show_if condition
    opts = opts.filter(opt => {
      if (!opt.show_if) return true
      const val = current_params[opt.show_if.key]
      return opt.show_if.values.map(v => String(v)).includes(String(val ?? ``))
    })

    return opts
  }

  // ─── Auto-reset software when system_type changes and current selection becomes invalid ───
  $effect(() => {
    const schema = definition.param_schema ?? []
    const sw_param = schema.find(p => p.key === `software`)
    if (!sw_param?.options || !node.params.system_type) return
    const filtered = get_filtered_options(sw_param, node.params)
    if (!filtered || filtered.length === 0) return
    const current_sw = String(node.params.software ?? ``)
    const still_valid = filtered.some(o => String(o.value) === current_sw)
    if (!still_valid) {
      // Reset to first valid software
      emit({ ...node.params, software: filtered[0].value })
    }
  })

  // ─── Auto-populate schema defaults for visible params missing from node.params ───
  // Without this, params like method/basis only exist in the UI (via ?? param.default)
  // but never get written to node.params, so the backend never receives them.
  // Also resets select params whose current value is no longer among the filtered options.
  $effect(() => {
    const schema = definition.param_schema ?? []
    const updates: Record<string, unknown> = {}

    for (const p of schema) {
      if (!is_param_visible(p, node.params)) continue

      // Populate defaults for params that have no value yet
      if (node.params[p.key] === undefined && p.default !== undefined) {
        updates[p.key] = p.default
        continue
      }

      // For select params, reset to default if the current value is no longer valid
      if (p.type === `select` && node.params[p.key] !== undefined) {
        const filtered = get_filtered_options(p, node.params) ?? []
        const current = String(node.params[p.key])
        const still_valid = filtered.some(o => String(o.value) === current)
        if (!still_valid && filtered.length > 0) {
          updates[p.key] = filtered[0].value
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      emit({ ...node.params, ...updates })
    }
  })

  // ─── Derived: group the param_schema entries by group, filtering by show_if ───
  const grouped_params = $derived.by(() => {
    const schema = definition.param_schema ?? []
    const groups: { name: string; params: ParamDef[] }[] = []
    const group_map = new Map<string, ParamDef[]>()
    const order: string[] = []

    for (const p of schema) {
      if (!is_param_visible(p, node.params)) continue
      const g = p.group ?? `General`
      if (!group_map.has(g)) {
        group_map.set(g, [])
        order.push(g)
      }
      group_map.get(g)!.push(p)
    }

    for (const name of order) {
      groups.push({ name, params: group_map.get(name)! })
    }
    return groups
  })

  // Collapsed groups: derived from defaults + user overrides.
  // Non-essential groups start collapsed; user toggles override this.
  const collapsed_groups = $derived.by(() => {
    const result = new Set<string>()
    for (const g of grouped_params) {
      if (g.name in user_group_overrides) {
        // User explicitly toggled — respect their choice
        if (!user_group_overrides[g.name]) result.add(g.name)
      } else {
        // Default: collapse non-essential groups
        if (!ALWAYS_OPEN_GROUPS.has(g.name)) result.add(g.name)
      }
    }
    return result
  })

  // Reset user overrides and preset state when switching to a different node
  let _prev_node_id = ``
  $effect(() => {
    const id = node.id
    if (id !== _prev_node_id) {
      _prev_node_id = id
      user_group_overrides = {}
      _preset_loaded_type = ``
      selected_preset = ``
    }
  })

  // Check if a group has been modified from defaults
  function is_group_modified(group: { name: string; params: ParamDef[] }): boolean {
    for (const p of group.params) {
      const val = node.params[p.key]
      if (val !== undefined && val !== p.default && String(val) !== String(p.default)) return true
    }
    return false
  }

  /** Minimal markdown → HTML for help text: **bold**, *italic*, `code`, newlines */
  function render_help(text: string): string {
    return text
      .replace(/&/g, `&amp;`).replace(/</g, `&lt;`).replace(/>/g, `&gt;`)
      .replace(/\*\*(.+?)\*\*/g, `<strong>$1</strong>`)
      .replace(/\*(.+?)\*/g, `<em>$1</em>`)
      .replace(/`(.+?)`/g, `<code>$1</code>`)
      .replace(/\n/g, `<br>`)
  }

  const status_color = $derived(status ? STATUS_COLORS[status] ?? `#475569` : null)

  function update_param(key: string, value: unknown) {
    const next = { ...node.params, [key]: value }
    emit(next)
  }

  function toggle_group(name: string) {
    const is_collapsed = collapsed_groups.has(name)
    // Record user's explicit choice: true = expanded, false = collapsed
    user_group_overrides = { ...user_group_overrides, [name]: is_collapsed }
  }

  function reset_to_defaults() {
    emit({ ...definition.default_params })
  }

  // ─── VASP preset selector (context-aware sub-presets) ───
  const VASP_CALC_TYPES = new Set([`geo_opt`, `single_point`, `cell_opt`, `md`, `freq`])
  const is_vasp_node = $derived(
    VASP_CALC_TYPES.has(node.type) && String(node.params.software ?? ``) === `vasp`
  )
  let selected_preset = $state(``)
  let preset_loading = $state(false)
  let preset_options = $state<{ value: string; label: string }[]>([])
  let _preset_loaded_type = ``

  // Fetch sub-preset options when node type changes
  $effect(() => {
    const calc_type = node.type
    if (!VASP_CALC_TYPES.has(calc_type) || String(node.params.software ?? ``) !== `vasp`) {
      preset_options = []
      return
    }
    if (calc_type === _preset_loaded_type) return
    _preset_loaded_type = calc_type
    selected_preset = ``
    fetch(`${API_BASE}/workflow/vasp-presets/${calc_type}`)
      .then(r => r.ok ? r.json() : {})
      .then((subs: Record<string, { label: string }>) => {
        preset_options = Object.entries(subs).map(([k, v]) => ({ value: k, label: v.label }))
      })
      .catch(() => { preset_options = [] })
  })

  async function apply_preset(sub_name: string) {
    if (!sub_name) { selected_preset = ``; return }
    preset_loading = true
    try {
      const res = await fetch(`${API_BASE}/workflow/vasp-presets/${node.type}/${sub_name}`)
      if (!res.ok) throw new Error(`Failed to fetch preset`)
      const preset_params: Record<string, unknown> = await res.json()
      // Merge preset values into current params (user can still override after)
      const next = { ...node.params }
      for (const [k, v] of Object.entries(preset_params)) {
        next[k] = v
      }
      emit(next)
      selected_preset = sub_name
    } catch (e) {
      console.warn(`[NodeConfigPanel] Failed to load VASP preset:`, e)
      selected_preset = ``
    } finally {
      preset_loading = false
    }
  }

  // ─── Kpoints parsing ───
  function parse_kpoints(val: unknown): [number, number, number] {
    const str = String(val ?? `4\u00D74\u00D74`)
    // Handle both multiplication sign and x
    const parts = str.split(/[\u00D7xX,\s]+/).map(Number)
    return [parts[0] || 4, parts[1] || 4, parts[2] || 4]
  }

  function format_kpoints(a: number, b: number, c: number): string {
    return `${a}\u00D7${b}\u00D7${c}`
  }
</script>

<div class="config-panel dialog-modal">
  <!-- Header -->
  <div class="panel-header">
    <div class="header-row">
      <div class="node-icon" style="background:{definition.color}20;border-color:{definition.color}50">
        {definition.icon}
      </div>
      <div class="header-info">
        <div class="node-label">{definition.label}</div>
        <div class="node-id">{node.id.slice(0, 16)}</div>
      </div>
      <button
        class="help-btn"
        class:active={show_help}
        onclick={() => show_help = !show_help}
      title={t('workflow.config_toggle_help')}
      >?</button>
    </div>
    {#if show_help}
      <div class="node-desc">{definition.description}</div>
    {/if}
    {#if status && status_color}
      <div
        class="status-badge"
        style="background:{status_color}15;border-color:{status_color}40;color:{status_color}"
      >
        <span class="status-dot" style="background:{status_color}"></span>
        {status}
      </div>
    {/if}
  </div>

  <!-- Help text -->
  {#if show_help && definition.help_text}
    <div class="help-section">
      <div class="help-label">{t('workflow.config_documentation')}</div>
      <div class="help-text">{@html render_help(definition.help_text)}</div>
    </div>
  {/if}

  <!-- Slot: preview / input buttons injected by parent -->
  {#if children}
    {@render children()}
  {/if}

  <!-- Display Name (all node types) -->
  <div class="label-row">
    <label class="field-label">{t('workflow.config_display_name')}</label>
    <input
      type="text"
      class="field-input"
      placeholder={definition.label}
      value={node.params.label ?? ``}
      oninput={(e) => update_param(`label`, e.currentTarget.value || undefined)}
    />
  </div>

  <!-- VASP Preset Selector (context-aware per calc type) -->
  {#if is_vasp_node && preset_options.length > 0}
    <div class="preset-selector">
      <label class="field-label">{t('workflow.config_incar_preset')}</label>
      <select
        class="field-select"
        value={selected_preset}
        disabled={preset_loading}
        onchange={(e) => apply_preset(e.currentTarget.value)}
      >
        <option value="">{t('workflow.config_manual')}</option>
        {#each preset_options as opt}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </div>
  {/if}

  <!-- Frequency: freeze atoms section -->
  {#if node.type === `freq`}
    {#if !node.params.freeze_mode || node.params.freeze_mode === `none`}
      <div class="freeze-warning">
        <span class="freeze-warning-icon">!</span>
        <span class="freeze-warning-text">
          {t('workflow.config_freeze_warning')}
        </span>
        <div class="freeze-quick-actions">
          <button class="freeze-quick-btn" onclick={() => emit({ ...node.params, freeze_mode: `layers`, freeze_layers: node.params.freeze_layers || 4 })}>
            {t('workflow.config_freeze_by_layers')}
          </button>
          <button class="freeze-quick-btn" onclick={() => emit({ ...node.params, freeze_mode: `z_range`, freeze_z_below: node.params.freeze_z_below || 8.0 })}>
            {t('workflow.config_freeze_by_height')}
          </button>
          <button class="freeze-quick-btn" onclick={() => { emit({ ...node.params, freeze_mode: `manual` }); onfreeze_edit?.() }}>
            {t('workflow.config_select_in_3d')}
          </button>
        </div>
      </div>
    {/if}
    {#if node.params.freeze_mode === `layers`}
      <div class="freeze-edit-section">
        <label class="field-label">{t('workflow.config_freeze_bottom_layers')}</label>
        <input
          type="number"
          class="field-input field-number"
          value={node.params.freeze_layers ?? 4}
          min={0} max={20} step={1}
          oninput={(e) => {
            const v = e.currentTarget.valueAsNumber
            if (Number.isFinite(v)) emit({ ...node.params, freeze_layers: v })
          }}
        />
      </div>
    {/if}
    {#if node.params.freeze_mode === `z_range`}
      <div class="freeze-edit-section">
        <label class="field-label">{t('workflow.config_freeze_z_below')}</label>
        <input
          type="number"
          class="field-input field-number"
          value={node.params.freeze_z_below ?? 8.0}
          min={0} max={100} step={0.5}
          oninput={(e) => {
            const v = e.currentTarget.valueAsNumber
            if (Number.isFinite(v)) emit({ ...node.params, freeze_z_below: v })
          }}
        />
      </div>
    {/if}
    {#if node.params.freeze_mode === `manual`}
      <div class="freeze-edit-section">
        <button class="freeze-edit-btn" onclick={() => onfreeze_edit?.()}>
          {t('workflow.config_select_frozen_atoms')}
        </button>
        {#if node.params.freeze_indices}
          {@const count = String(node.params.freeze_indices).split(",").filter(s => s.trim()).length}
          <div class="freeze-count">{t('workflow.config_atoms_frozen', { n: count, s: count !== 1 ? `s` : `` })}</div>
        {:else}
          <div class="freeze-count freeze-count-empty">{t('workflow.config_no_atoms_frozen')}</div>
        {/if}
      </div>
    {/if}
    {#if node.params.freeze_mode && node.params.freeze_mode !== `none`}
      <div class="freeze-edit-section" style="padding-top: 0">
        <button class="freeze-quick-btn freeze-reset-btn" onclick={() => emit({ ...node.params, freeze_mode: `none`, freeze_layers: 0, freeze_z_below: 0, freeze_indices: `` })}>
          {t('workflow.config_clear_freeze')}
        </button>
      </div>
    {/if}
  {/if}

  <!-- Gibbs Energy formula + computed values -->
  {#if node.type === `gibbs_energy`}
    <div class="gibbs-formula-section">
      <div class="gibbs-formula-box">
        <span class="gibbs-formula">G = E<sub>DFT</sub> + ZPE − T×S</span>
      </div>

      <div class="gibbs-results">
        <div class="gibbs-result-row gibbs-result-main">
          <span class="gibbs-result-label">G</span>
          <span class="gibbs-result-value">{gibbs_result?.gibbs !== undefined ? `${gibbs_result.gibbs.toFixed(4)} eV` : `—`}</span>
        </div>
        <div class="gibbs-result-row">
          <span class="gibbs-result-label">E<sub>DFT</sub></span>
          <span class="gibbs-result-value">{gibbs_result?.energy !== undefined ? `${gibbs_result.energy.toFixed(4)} eV` : `—`}
            {#if gibbs_result?.energy === undefined}<span class="gibbs-hint">{t('workflow.config_gibbs_energy_input')}</span>{/if}
          </span>
        </div>
        <div class="gibbs-result-row">
          <span class="gibbs-result-label">ZPE</span>
          <span class="gibbs-result-value">{gibbs_result?.zpe !== undefined ? `+${gibbs_result.zpe.toFixed(4)} eV` : `—`}</span>
        </div>
        <div class="gibbs-result-row">
          <span class="gibbs-result-label">T×S</span>
          <span class="gibbs-result-value">{gibbs_result?.ts_correction !== undefined ? `−${gibbs_result.ts_correction.toFixed(4)} eV` : `—`}
            {#if gibbs_result?.ts_correction === undefined}<span class="gibbs-hint">{t('workflow.config_gibbs_freq_input')}</span>{/if}
          </span>
        </div>
        {#if gibbs_result?.n_real_freqs !== undefined}
          <div class="gibbs-result-row gibbs-result-meta">
            <span class="gibbs-result-label">Freq</span>
            <span class="gibbs-result-value">{gibbs_result.n_real_freqs} real{gibbs_result.n_imag_freqs ? `, ${gibbs_result.n_imag_freqs} imag` : ``}</span>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Parameter groups -->
  <div class="params-area">
    {#if grouped_params.length === 0}
      <div class="no-params">{t('workflow.config_no_params')}</div>
    {/if}

    {#each grouped_params as group}
      {@const is_collapsed = collapsed_groups.has(group.name)}
      {@const is_modified = is_group_modified(group)}
      <div class="param-group" class:group-collapsed={is_collapsed}>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="group-header"
          class:group-modified={is_modified}
          onclick={() => toggle_group(group.name)}
          style="border-left-color: {definition.color}"
        >
          <span class="group-chevron" class:collapsed={is_collapsed}>
            &#9662;
          </span>
          <span class="group-name">{group.name}</span>
          {#if is_collapsed && is_modified}
            <span class="group-modified-dot" title={t('workflow.config_modified_from_defaults')}></span>
          {/if}
          {#if is_collapsed}
            <span class="group-count">{group.params.length}</span>
          {/if}
        </div>

        {#if !collapsed_groups.has(group.name)}
          <div class="group-body">
            {#each group.params as param}
              <div class="field">
                <div class="field-label-row">
                  <label class="field-label" for="param-{param.key}">{param.label}</label>
                  {#if param.help}
                    <button class="field-help-btn" class:active={expanded_help_keys.has(param.key)}
                      onclick={() => { const s = new Set(expanded_help_keys); if (s.has(param.key)) s.delete(param.key); else s.add(param.key); expanded_help_keys = s }}
                      title={param.help}>?</button>
                  {/if}
                </div>

                {#if param.type === `number`}
                  <input
                    id="param-{param.key}"
                    class="field-input field-number"
                    type="number"
                    value={node.params[param.key] ?? param.default}
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    oninput={(e) => {
                      const v = e.currentTarget.valueAsNumber
                      if (Number.isFinite(v)) update_param(param.key, v)
                    }}
                  />

                {:else if param.type === `string`}
                  <input
                    id="param-{param.key}"
                    class="field-input"
                    type="text"
                    value={node.params[param.key] ?? param.default ?? ``}
                    oninput={(e) => update_param(param.key, e.currentTarget.value)}
                  />

                {:else if param.type === `boolean` || param.type === `checkbox`}
                  {@const checked = Boolean(node.params[param.key] ?? param.default)}
                  <div class="toggle-row">
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div
                      class="toggle-switch"
                      class:on={checked}
                      onclick={() => update_param(param.key, !checked)}
                      style="--accent: {definition.color}"
                    >
                      <div class="toggle-knob"></div>
                    </div>
                    <span class="toggle-label">{checked ? t('workflow.config_toggle_on') : t('workflow.config_toggle_off')}</span>
                  </div>

                {:else if param.type === `select`}
                  {@const options = get_filtered_options(param, node.params) ?? []}
                  <select
                    id="param-{param.key}"
                    class="field-select"
                    value={String(node.params[param.key] ?? param.default)}
                    onchange={(e) => {
                      const raw = e.currentTarget.value
                      // Try to preserve the original type from options
                      const match = options.find(o => String(o.value) === raw)
                      update_param(param.key, match ? match.value : raw)
                    }}
                  >
                    {#each options as opt}
                      <option value={String(opt.value)}>{opt.label}</option>
                    {/each}
                  </select>

                {:else if param.type === `kpoints`}
                  {@const kp = parse_kpoints(node.params[param.key] ?? param.default)}
                  <div class="kpoints-row">
                    <input
                      class="field-input kp-input"
                      type="number"
                      min={1}
                      max={20}
                      step={1}
                      value={kp[0]}
                      oninput={(e) => {
                        const v = e.currentTarget.valueAsNumber || kp[0]
                        update_param(param.key, format_kpoints(v, kp[1], kp[2]))
                      }}
                    />
                    <span class="kp-sep">&times;</span>
                    <input
                      class="field-input kp-input"
                      type="number"
                      min={1}
                      max={20}
                      step={1}
                      value={kp[1]}
                      oninput={(e) => {
                        const v = e.currentTarget.valueAsNumber || kp[1]
                        update_param(param.key, format_kpoints(kp[0], v, kp[2]))
                      }}
                    />
                    <span class="kp-sep">&times;</span>
                    <input
                      class="field-input kp-input"
                      type="number"
                      min={1}
                      max={20}
                      step={1}
                      value={kp[2]}
                      oninput={(e) => {
                        const v = e.currentTarget.valueAsNumber || kp[2]
                        update_param(param.key, format_kpoints(kp[0], kp[1], v))
                      }}
                    />
                  </div>

                {:else if param.type === `periodic`}
                  <div class="periodic-picker">
                    <input
                      id="param-{param.key}"
                      class="field-input periodic-input"
                      type="text"
                      value={String(node.params[param.key] ?? param.default ?? ``)}
                      placeholder="e.g. Fe"
                      oninput={(e) => update_param(param.key, e.currentTarget.value)}
                    />
                    <div class="element-chips">
                      {#each [`Fe`, `Co`, `Ni`, `Cu`, `Zn`, `Mn`, `Cr`, `V`, `Ti`, `Mo`, `W`, `Pt`, `Pd`, `Ru`, `Rh`, `N`, `S`, `P`, `B`] as el}
                        <button
                          class="element-chip"
                          class:active={String(node.params[param.key] ?? ``) === el}
                          onclick={() => update_param(param.key, el)}
                        >{el}</button>
                      {/each}
                    </div>
                  </div>

                {:else if param.type === `doping_groups`}
                  {@const groups_raw = node.params[param.key]}
                  {@const groups = (() => { try { return JSON.parse(typeof groups_raw === 'string' ? groups_raw : JSON.stringify(groups_raw ?? [])) } catch { return [] } })() as Array<{target: string; replacements: string[]}>}
                  <div class="doping-groups">
                    {#each groups as group, gi}
                      <div class="dg-card">
                        <div class="dg-header">
                          <span class="dg-label">{t('workflow.config_group_n', { n: gi + 1 })}</span>
                          <button class="dg-remove" onclick={() => {
                            const next = groups.filter((_: unknown, i: number) => i !== gi)
                            update_param(param.key, JSON.stringify(next))
                          }} title={t('workflow.config_remove_group')}>&times;</button>
                        </div>
                        <div class="dg-field">
                          <span class="dg-field-label">{t('workflow.config_group_replace')}</span>
                          <input class="field-input dg-input" type="text" placeholder="e.g. Ti"
                            value={group.target}
                            oninput={(e) => {
                              const next = [...groups]
                              next[gi] = { ...next[gi], target: e.currentTarget.value }
                              update_param(param.key, JSON.stringify(next))
                            }}
                          />
                        </div>
                        <div class="dg-field">
                          <span class="dg-field-label">{t('workflow.config_group_with')}</span>
                          <div class="dg-replacements">
                            {#each group.replacements as el, ri}
                              <span class="dg-el-chip">
                                {el}
                                <button class="dg-el-remove" onclick={() => {
                                  const next = [...groups]
                                  next[gi] = { ...next[gi], replacements: group.replacements.filter((_: string, i: number) => i !== ri) }
                                  update_param(param.key, JSON.stringify(next))
                                }}>&times;</button>
                              </span>
                            {/each}
                            <input class="dg-add-input" type="text" placeholder="+ element"
                              onkeydown={(e) => {
                                if (e.key === 'Enter') {
                                  const val = e.currentTarget.value.trim()
                                  if (val) {
                                    const next = [...groups]
                                    next[gi] = { ...next[gi], replacements: [...group.replacements, val] }
                                    update_param(param.key, JSON.stringify(next))
                                    e.currentTarget.value = ''
                                  }
                                }
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    {/each}
                    <button class="dg-add-group" onclick={() => {
                      const next = [...groups, { target: '', replacements: [] }]
                      update_param(param.key, JSON.stringify(next))
                    }}>{t('workflow.config_add_substitution_group')}</button>
                    {#if groups.length > 0}
                      {@const total = groups.reduce((acc: number, g: {replacements: string[]}) => acc * (g.replacements.length || 0), 1)}
                      <div class="dg-count">{t('workflow.config_total_configurations', { n: total })}</div>
                    {/if}
                  </div>

                {:else if param.type === `text`}
                  <textarea
                    id="param-{param.key}"
                    class="field-textarea"
                    value={String(node.params[param.key] ?? param.default ?? ``)}
                    oninput={(e) => update_param(param.key, e.currentTarget.value)}
                    rows={3}
                  ></textarea>
                {/if}

                {#if expanded_help_keys.has(param.key) && param.help}
                  <div class="field-help">{param.help}</div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <!-- Info section: Inputs / Outputs -->
  <div class="info-section">
    <div class="info-label">{t('workflow.config_inputs_outputs')}</div>
    <div class="io-row">
      <div class="io-col">
        <span class="io-heading">IN</span>
        {#if definition.inputs.length === 0}
          <span class="io-item io-none">none</span>
        {:else}
          {#each definition.inputs as inp}
            <span class="io-item">{inp}</span>
          {/each}
        {/if}
      </div>
      <div class="io-arrow">&rarr;</div>
      <div class="io-col">
        <span class="io-heading">OUT</span>
        {#if definition.outputs.length === 0}
          <span class="io-item io-none">none</span>
        {:else}
          {#each definition.outputs as out}
            <span class="io-item">{out}</span>
          {/each}
        {/if}
      </div>
    </div>
  </div>

  <!-- Reset button -->
  <div class="footer-actions">
    <button class="reset-btn" onclick={reset_to_defaults}>
      {t('workflow.config_reset_to_defaults')}
    </button>
  </div>
</div>

<style>
  .config-panel {
    display: flex;
    flex-direction: column;
    gap: 0;
    color: var(--text-color, light-dark(#374151, #eee));
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-size: 12px;
    background: var(--dialog-bg, light-dark(#fff, #1c1d21));
  }

  /* ─── Header ─── */
  .panel-header {
    padding: 12px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    background: var(--dialog-bg, light-dark(#fff, #1c1d21));
  }
  .header-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .node-icon {
    width: 34px;
    height: 34px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    border: 1px solid;
    flex-shrink: 0;
  }
  .header-info {
    flex: 1;
    min-width: 0;
  }
  .node-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-color, light-dark(#1f2937, #eee));
  }
  .node-id {
    font-size: 9px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    margin-top: 1px;
  }
  .help-btn {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all 0.15s;
    font-family: inherit;
  }
  .help-btn:hover,
  .help-btn.active {
    background: light-dark(rgba(0,0,0,0.06), #1a3050);
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }
  .node-desc {
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    line-height: 1.5;
  }
  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    border: 1px solid;
    margin-top: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* ─── Help section ─── */
  .help-section {
    padding: 10px 12px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    background: var(--dialog-bg, light-dark(#fff, #1c1d21));
  }
  .help-label {
    font-size: 9px;
    font-weight: 700;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    text-transform: uppercase;
    letter-spacing: 1.5px;
    margin-bottom: 6px;
  }
  .help-text {
    font-size: 11px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    line-height: 1.6;
    word-break: break-word;
    margin: 0;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    padding: 8px;
    border-radius: 4px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .help-text :global(strong) { color: var(--text-color, light-dark(#1f2937, #f3f4f6)); }
  .help-text :global(code) {
    font-family: 'SF Mono', 'Cascadia Code', monospace;
    font-size: 10px;
    padding: 1px 4px;
    border-radius: 3px;
    background: light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.08));
    max-height: 260px;
    overflow-y: auto;
  }

  /* ─── Display Name ─── */
  .label-row {
    padding: 6px 12px;
    border-bottom: 1px solid var(--border-color, light-dark(#e5e7eb, #2d333b));
  }
  .label-row .field-label {
    display: block;
    font-size: 10px;
    font-weight: 600;
    color: var(--text-color-muted, light-dark(#6b7280, #768390));
    margin-bottom: 3px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .label-row .field-input {
    width: 100%;
    box-sizing: border-box;
    padding: 4px 8px;
    font-size: 11px;
    font-family: inherit;
    border: 1px solid var(--border-color, light-dark(#d1d5db, #373e47));
    border-radius: 4px;
    background: var(--input-bg, light-dark(#f9fafb, #22272e));
    color: var(--text-color, light-dark(#374151, #adbac7));
  }

  /* ─── Preset selector ─── */
  .preset-selector {
    padding: 6px 12px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .preset-selector .field-label {
    display: block;
    font-size: 10px;
    font-weight: 600;
    color: var(--text-color-muted, light-dark(#6b7280, #768390));
    margin-bottom: 3px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* ─── Parameters area ─── */
  .params-area {
    padding: 4px 0;
    flex: 1;
  }
  .no-params {
    padding: 16px 12px;
    text-align: center;
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    font-style: italic;
  }

  /* ─── Group ─── */
  .param-group {
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .param-group.group-collapsed {
    opacity: 0.6;
  }
  .param-group.group-collapsed .group-header {
    background: transparent;
    border-left-color: var(--text-color-dim, light-dark(#d1d5db, #333)) !important;
  }
  .group-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    cursor: pointer;
    user-select: none;
    border-left: 3px solid;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    transition: background 0.12s, opacity 0.12s;
  }
  .group-header:hover {
    background: light-dark(rgba(0,0,0,0.06), #101828);
    opacity: 1;
  }
  .group-chevron {
    font-size: 9px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    transition: transform 0.15s;
    display: inline-block;
  }
  .group-chevron.collapsed {
    transform: rotate(-90deg);
  }
  .group-name {
    font-size: 10px;
    font-weight: 700;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    text-transform: uppercase;
    letter-spacing: 1px;
    flex: 1;
  }
  .group-modified-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #f59e0b;
    flex-shrink: 0;
  }
  .group-header.group-modified {
    border-left-color: #f59e0b !important;
  }
  .group-count {
    font-size: 9px;
    color: var(--text-color-dim, light-dark(#6b7280, #9ca3af));
    background: light-dark(rgba(0,0,0,0.06), rgba(255, 255, 255, 0.1));
    padding: 2px 6px;
    border-radius: 8px;
    margin-left: auto;
    font-weight: 600;
  }

  /* ─── Group body ─── */
  .group-body {
    padding: 6px 12px 8px;
  }

  /* ─── Field ─── */
  .field {
    margin-bottom: 8px;
  }
  .field:last-child {
    margin-bottom: 2px;
  }
  .field-label-row {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 3px;
  }
  .field-label {
    display: block;
    font-size: 11px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    font-weight: 500;
  }
  .field-help-btn {
    width: 16px; height: 16px; border-radius: 50%;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.06), rgba(255, 255, 255, 0.1)));
    border: 1px solid var(--text-color-dim, light-dark(#9ca3af, #555));
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    font-size: 10px; font-weight: 700; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    flex-shrink: 0; transition: all 0.15s; font-family: inherit;
    padding: 0; line-height: 1; margin-left: 2px;
  }
  .field-help-btn:hover, .field-help-btn.active {
    background: color-mix(in srgb, var(--accent-color, light-dark(#4f46e5, #3b82f6)) 20%, transparent);
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }
  .field-input {
    width: 100%;
    padding: 4px 6px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    color: var(--text-color, light-dark(#374151, #eee));
    font-size: 12px;
    font-family: inherit;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.15s;
  }
  .field-input:focus {
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }
  .field-select {
    width: 100%;
    padding: 4px 6px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    color: var(--text-color, light-dark(#374151, #eee));
    font-size: 12px;
    font-family: inherit;
    outline: none;
    cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%234a6a8a'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 6px center;
    padding-right: 20px;
    box-sizing: border-box;
    transition: border-color 0.15s;
  }
  .field-select:focus {
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }
  .field-select option {
    background: var(--dialog-bg, light-dark(#fff, #1c1d21));
    color: var(--text-color, light-dark(#374151, #eee));
  }
  .field-textarea {
    width: 100%;
    padding: 4px 6px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    color: var(--text-color, light-dark(#374151, #eee));
    font-size: 12px;
    font-family: inherit;
    outline: none;
    resize: vertical;
    min-height: 48px;
    box-sizing: border-box;
    transition: border-color 0.15s;
  }
  .field-textarea:focus {
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }
  /* ─── Periodic element picker ─── */
  .periodic-picker {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .periodic-input {
    font-weight: 600;
    font-size: 13px;
    letter-spacing: 0.5px;
  }
  .element-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }
  .element-chip {
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #333));
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    transition: all 0.12s;
  }
  .element-chip:hover {
    background: var(--accent-color, #3b82f6);
    color: #fff;
    border-color: var(--accent-color, #3b82f6);
  }
  .element-chip.active {
    background: var(--accent-color, #3b82f6);
    color: #fff;
    border-color: var(--accent-color, #3b82f6);
  }
  /* ─── Doping groups editor ─── */
  .doping-groups {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .dg-card {
    padding: 8px;
    border: 1px solid var(--dialog-border, #404040);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.02);
  }
  .dg-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }
  .dg-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--accent-color, #60a5fa);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .dg-remove {
    background: none;
    border: none;
    color: #64748b;
    cursor: pointer;
    font-size: 14px;
    padding: 0 4px;
    line-height: 1;
  }
  .dg-remove:hover { color: #ef4444; }
  .dg-field {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }
  .dg-field-label {
    font-size: 10px;
    color: var(--text-color-muted, #9ca3af);
    width: 50px;
    flex-shrink: 0;
  }
  .dg-input {
    flex: 1;
    font-weight: 600;
  }
  .dg-replacements {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    flex: 1;
    align-items: center;
  }
  .dg-el-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 6px;
    background: rgba(5, 150, 105, 0.15);
    border: 1px solid rgba(5, 150, 105, 0.3);
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    color: #10b981;
  }
  .dg-el-remove {
    background: none;
    border: none;
    color: #64748b;
    cursor: pointer;
    font-size: 11px;
    padding: 0;
    line-height: 1;
  }
  .dg-el-remove:hover { color: #ef4444; }
  .dg-add-input {
    width: 70px;
    padding: 2px 6px;
    background: var(--input-bg, rgba(255, 255, 255, 0.05));
    border: 1px dashed var(--dialog-border, #404040);
    border-radius: 4px;
    color: inherit;
    font-size: 10px;
    font-family: inherit;
  }
  .dg-add-input::placeholder { color: #475569; }
  .dg-add-group {
    padding: 6px;
    border: 1px dashed rgba(5, 150, 105, 0.3);
    border-radius: 5px;
    background: transparent;
    color: #10b981;
    font-size: 10px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  .dg-add-group:hover { background: rgba(5, 150, 105, 0.08); }
  .dg-count {
    font-size: 10px;
    color: #f59e0b;
    font-weight: 500;
    text-align: center;
    padding: 2px 0;
  }

  .field-help {
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    margin-top: 2px;
    line-height: 1.4;
  }

  /* ─── Boolean toggle ─── */
  .toggle-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .toggle-switch {
    width: 34px;
    height: 18px;
    border-radius: 9px;
    background: var(--dialog-border, light-dark(#d1d5db, #404040));
    cursor: pointer;
    position: relative;
    transition: background 0.2s;
    flex-shrink: 0;
  }
  .toggle-switch.on {
    background: var(--accent, #3b82f6);
  }
  .toggle-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--text-color, light-dark(#374151, #eee));
    transition: transform 0.2s, background 0.2s;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  }
  .toggle-switch.on .toggle-knob {
    transform: translateX(16px);
    background: #fff;
  }
  .toggle-label {
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.5px;
  }

  /* ─── Kpoints row ─── */
  .kpoints-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .kp-input {
    flex: 1;
    text-align: center;
    min-width: 0;
  }
  .kp-sep {
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    font-size: 12px;
    flex-shrink: 0;
  }

  /* ─── Info section ─── */
  .info-section {
    padding: 10px 12px;
    border-top: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
  }
  .info-label {
    font-size: 9px;
    font-weight: 700;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    text-transform: uppercase;
    letter-spacing: 1.5px;
    margin-bottom: 6px;
  }
  .io-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .io-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .io-heading {
    font-size: 9px;
    font-weight: 700;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    letter-spacing: 1px;
    margin-bottom: 2px;
  }
  .io-item {
    font-size: 10px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    padding: 1px 6px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border-radius: 3px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    display: inline-block;
    margin-bottom: 2px;
  }
  .io-item.io-none {
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    font-style: italic;
    border-color: transparent;
    background: none;
  }
  .io-arrow {
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    font-size: 14px;
    padding-top: 14px;
    flex-shrink: 0;
  }

  /* ─── Footer ─── */
  .footer-actions {
    padding: 10px 12px;
    border-top: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    background: var(--dialog-bg, light-dark(#fff, #1c1d21));
  }
  .reset-btn {
    width: 100%;
    padding: 5px 10px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 5px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
  }
  .reset-btn:hover {
    background: light-dark(rgba(0,0,0,0.08), #1a2540);
    border-color: var(--accent-hover-color, light-dark(#3730a3, #2563eb));
    color: var(--text-color, light-dark(#374151, #eee));
  }

  /* ─── Freeze warning ─── */
  .freeze-warning {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 12px;
    margin: 0;
    background: light-dark(rgba(234, 179, 8, 0.1), rgba(234, 179, 8, 0.1));
    border-bottom: 1px solid light-dark(rgba(234, 179, 8, 0.3), rgba(234, 179, 8, 0.25));
  }
  .freeze-quick-actions {
    display: flex;
    gap: 4px;
    width: 100%;
    margin-top: 4px;
  }
  .freeze-quick-btn {
    flex: 1;
    padding: 5px 6px;
    background: light-dark(rgba(192, 38, 211, 0.08), rgba(192, 38, 211, 0.12));
    border: 1px solid light-dark(rgba(192, 38, 211, 0.25), rgba(192, 38, 211, 0.25));
    border-radius: 4px;
    color: light-dark(#7c3aed, #c084fc);
    font-size: 10px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
  }
  .freeze-quick-btn:hover {
    background: light-dark(rgba(192, 38, 211, 0.18), rgba(192, 38, 211, 0.22));
    border-color: light-dark(rgba(192, 38, 211, 0.5), rgba(192, 38, 211, 0.5));
  }
  .freeze-reset-btn {
    flex: none;
    background: light-dark(rgba(239, 68, 68, 0.08), rgba(239, 68, 68, 0.1));
    border-color: light-dark(rgba(239, 68, 68, 0.25), rgba(239, 68, 68, 0.2));
    color: light-dark(#dc2626, #f87171);
  }
  .freeze-reset-btn:hover {
    background: light-dark(rgba(239, 68, 68, 0.15), rgba(239, 68, 68, 0.18));
  }
  .freeze-warning-icon {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: light-dark(#eab308, #ca8a04);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .freeze-warning-text {
    font-size: 10px;
    line-height: 1.4;
    color: light-dark(#854d0e, #fbbf24);
  }

  /* ─── Freeze edit section ─── */
  .freeze-edit-section {
    padding: 8px 12px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .freeze-edit-btn {
    width: 100%;
    padding: 8px 12px;
    background: light-dark(rgba(192, 38, 211, 0.1), rgba(192, 38, 211, 0.15));
    border: 1px solid light-dark(rgba(192, 38, 211, 0.3), rgba(192, 38, 211, 0.3));
    border-radius: 6px;
    color: light-dark(#9333ea, #c084fc);
    font-size: 11px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
  }
  .freeze-edit-btn:hover {
    background: light-dark(rgba(192, 38, 211, 0.18), rgba(192, 38, 211, 0.25));
    border-color: light-dark(rgba(192, 38, 211, 0.5), rgba(192, 38, 211, 0.5));
  }
  .freeze-count {
    margin-top: 6px;
    font-size: 10px;
    text-align: center;
    color: light-dark(#9333ea, #c084fc);
    font-weight: 500;
  }
  .freeze-count-empty {
    color: var(--text-color-muted, light-dark(#9ca3af, #6b7280));
  }

  /* ─── Gibbs Energy formula section ─── */
  .gibbs-formula-section {
    padding: 10px 12px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .gibbs-formula-box {
    background: light-dark(rgba(5, 150, 105, 0.08), rgba(52, 211, 153, 0.1));
    border: 1px solid light-dark(rgba(5, 150, 105, 0.25), rgba(52, 211, 153, 0.25));
    border-radius: 6px;
    padding: 8px 12px;
    text-align: center;
    margin-bottom: 8px;
  }
  .gibbs-formula {
    font-size: 13px;
    font-weight: 700;
    color: light-dark(#059669, #34d399);
    letter-spacing: 0.5px;
  }
  .gibbs-explanation {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .gibbs-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 2px 4px;
  }
  .gibbs-term {
    font-size: 11px;
    font-weight: 600;
    color: light-dark(#059669, #34d399);
    min-width: 42px;
  }
  .gibbs-desc {
    font-size: 10px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
  }
  .gibbs-results {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .gibbs-result-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 3px 6px;
    border-radius: 4px;
  }
  .gibbs-result-main {
    background: light-dark(rgba(5, 150, 105, 0.06), rgba(52, 211, 153, 0.08));
    padding: 5px 6px;
    margin-bottom: 2px;
  }
  .gibbs-result-main .gibbs-result-value {
    font-weight: 700;
    color: light-dark(#059669, #34d399);
  }
  .gibbs-result-label {
    font-size: 10px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    min-width: 32px;
  }
  .gibbs-result-value {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-color, light-dark(#374151, #e2e8f0));
    text-align: right;
  }
  .gibbs-result-meta {
    opacity: 0.7;
    margin-top: 2px;
  }
  .gibbs-hint {
    font-size: 9px;
    color: var(--text-color-muted, light-dark(#9ca3af, #6b7280));
    margin-left: 4px;
  }
</style>
