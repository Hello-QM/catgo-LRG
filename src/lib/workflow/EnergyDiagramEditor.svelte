<script lang="ts">
  import { API_BASE } from '$lib/api/config'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { lazy_load_plotly, base_layout, base_config, make_target_writable } from './plotly-utils'
  import { download } from '$lib/io/fetch'

  load_i18n_module('common')
  load_i18n_module('workflow')

  // Pre-load Plotly so it's ready when user clicks Preview
  let Plotly: any = null
  lazy_load_plotly().then(p => { Plotly = p })

  let {
    initial_pathways = [],
    onchange,
  }: {
    initial_pathways?: any[]
    onchange?: (pathways: any[]) => void
  } = $props()

  interface Step { label: string; energy: number; is_ts: boolean }
  interface Pathway { name: string; color: string; steps: Step[] }

  const COLORS = [`#3b82f6`, `#ef4444`, `#22c55e`, `#f59e0b`, `#8b5cf6`, `#ec4899`, `#06b6d4`, `#84cc16`]

  // Plain data — NOT $state to avoid Svelte 5 deep proxy overhead
  let pathways: Pathway[] = initial_pathways.length > 0
    ? JSON.parse(JSON.stringify(initial_pathways))
    : [{ name: t('workflow.energy_path_n', { n: 1 }), color: COLORS[0], steps: [
        { label: t('workflow.reactant'), energy: 0, is_ts: false },
        { label: t('workflow.product'), energy: -0.5, is_ts: false },
      ]}]

  // Manual render trigger — increment to force Svelte to re-render the {#each} blocks
  let version = $state(0)

  function refresh() { version++ }

  function save() {
    onchange?.(JSON.parse(JSON.stringify(pathways)))
  }

  function add_pathway() {
    pathways.push({
      name: t('workflow.energy_path_n', { n: pathways.length + 1 }),
      color: COLORS[pathways.length % COLORS.length],
      steps: [
        { label: t('workflow.reactant'), energy: 0, is_ts: false },
        { label: t('workflow.product'), energy: -0.5, is_ts: false },
      ],
    })
    refresh()
    save()
  }

  function remove_pathway(idx: number) {
    pathways.splice(idx, 1)
    refresh()
    save()
  }

  function add_step(p_idx: number) {
    const steps = pathways[p_idx].steps
    const last_e = steps.length > 0 ? steps[steps.length - 1].energy : 0
    steps.push({ label: t('workflow.step_n', { n: steps.length + 1 }), energy: last_e, is_ts: false })
    refresh()
    save()
  }

  function remove_step(p_idx: number, s_idx: number) {
    pathways[p_idx].steps.splice(s_idx, 1)
    refresh()
    save()
  }

  function on_ts_toggle(p_idx: number, s_idx: number, checked: boolean) {
    pathways[p_idx].steps[s_idx].is_ts = checked
    refresh()
    save()
    schedule_preview()
  }

  // Read values from DOM on blur — no reactive binding during typing
  function on_step_blur(e: FocusEvent, p_idx: number, s_idx: number, field: 'label' | 'energy') {
    const val = (e.target as HTMLInputElement).value
    if (field === `energy`) pathways[p_idx].steps[s_idx].energy = Number(val) || 0
    else pathways[p_idx].steps[s_idx].label = val
    save()
    schedule_preview()
  }

  function on_name_blur(e: FocusEvent, p_idx: number) {
    pathways[p_idx].name = (e.target as HTMLInputElement).value
    save()
  }

  function on_color_change(e: Event, p_idx: number) {
    pathways[p_idx].color = (e.target as HTMLInputElement).value
    save()
    schedule_preview()
  }

  // Paste handler
  function handle_paste(e: ClipboardEvent, p_idx: number) {
    const text = e.clipboardData?.getData(`text/plain`)
    if (!text || !text.includes(`\t`)) return
    e.preventDefault()
    const rows = text.trim().split(`\n`).map(r => r.split(`\t`))
    const new_steps: Step[] = []
    for (const row of rows) {
      const label = (row[0] ?? ``).trim()
      const energy = parseFloat((row[1] ?? ``).trim())
      if (!label || isNaN(energy)) continue
      const ts_str = (row[2] ?? ``).trim().toLowerCase()
      new_steps.push({ label, energy, is_ts: [`true`, `ts`, `1`, `yes`].includes(ts_str) })
    }
    if (new_steps.length > 0) {
      pathways[p_idx].steps = new_steps
      refresh()
      save()
      schedule_preview()
    }
  }

  // Preview
  let preview_error = $state(``)
  let preview_loading = $state(false)
  let preview_ready = $state(false)
  let plot_div: HTMLDivElement | undefined = $state()
  let _preview_timer: ReturnType<typeof setTimeout> | undefined

  function schedule_preview() {
    clearTimeout(_preview_timer)
    _preview_timer = setTimeout(fetch_preview, 500)
  }

  async function fetch_preview() {
    const valid = pathways.filter(p => p.steps.length >= 2)
    if (valid.length === 0) return
    preview_loading = true
    preview_error = ``
    try {
      const res = await fetch(`${API_BASE}/workflow/catalysis/energy-diagram`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify({ pathways: JSON.parse(JSON.stringify(valid)) }),
      })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      // Render directly into the div — no Svelte reactivity involved
      if (plot_div && Plotly) {
        const layout = { ...base_layout(), ...data.layout, height: 300, annotations: data.annotations }
        const config = { ...base_config(), edits: { annotationPosition: true, annotationText: true } }
        Plotly.react(plot_div, data.traces, layout, config)
        preview_ready = true
      } else if (!Plotly) {
        preview_error = t('workflow.plotly_loading_retry')
      }
    } catch (e) {
      preview_error = String(e)
    } finally {
      preview_loading = false
    }
  }

  async function export_diagram(format: 'png' | 'svg') {
    if (!Plotly || !plot_div) return
    const url = await Plotly.toImage(plot_div, { format, width: 1200, height: 600, scale: 2 })
    const blob = await (await fetch(url)).blob()
    download(blob, `energy_diagram.${format}`, format === 'png' ? 'image/png' : 'image/svg+xml')
  }
</script>

<!-- Use version as key dependency to force re-render when pathways mutate -->
{#key version}
<div class="ed-editor">
  {#each pathways as pathway, p_idx}
    <div class="ed-pathway">
      <div class="ed-pathway-header">
        <input type="color" class="ed-color" value={pathway.color}
          onchange={(e) => on_color_change(e, p_idx)} />
        <input type="text" class="ed-name" value={pathway.name}
          onblur={(e) => on_name_blur(e, p_idx)} placeholder={t('workflow.pathway_name')} />
        {#if pathways.length > 1}
          <button class="ed-remove-path" onclick={() => remove_pathway(p_idx)} title={t('workflow.remove_pathway')}>&times;</button>
        {/if}
      </div>

      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="ed-table-wrap" onpaste={(e) => handle_paste(e, p_idx)}>
        <table class="ed-table">
          <thead><tr>
            <th class="col-label">{t('common.label')}</th>
            <th class="col-energy">{t('workflow.energy_ev')}</th>
            <th class="col-ts">TS</th>
            <th class="col-action"></th>
          </tr></thead>
          <tbody>
            {#each pathway.steps as step, s_idx}
              <tr class:ts-row={step.is_ts}>
                <td><input type="text" class="ed-input" value={step.label}
                  onblur={(e) => on_step_blur(e, p_idx, s_idx, 'label')} /></td>
                <td><input type="number" class="ed-input ed-energy" value={step.energy} step="0.01"
                  onblur={(e) => on_step_blur(e, p_idx, s_idx, 'energy')} /></td>
                <td class="td-center"><input type="checkbox" checked={step.is_ts}
                  onchange={(e) => on_ts_toggle(p_idx, s_idx, e.currentTarget.checked)} title={t('workflow.transition_state')} /></td>
                <td class="td-center"><button class="ed-remove-step"
                  onclick={() => remove_step(p_idx, s_idx)} title={t('common.remove')}>&times;</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <button class="ed-add-step" onclick={() => add_step(p_idx)}>{t('workflow.add_step')}</button>
        <div class="ed-paste-hint">{t('workflow.energy_paste_hint')}</div>
      </div>
    </div>
  {/each}

  <button class="ed-add-pathway" onclick={add_pathway}>{t('workflow.add_pathway')}</button>
</div>
{/key}

<!-- Preview: persistent div, Plotly renders directly into it (no reactive component) -->
<div class="ed-preview">
  <div bind:this={plot_div} class="ed-plot-div" class:ed-hidden={!preview_ready}></div>
  {#if preview_loading}
    <div class="ed-preview-msg">{t('workflow.updating_preview')}</div>
  {:else if preview_error}
    <div class="ed-preview-msg ed-error">{preview_error}</div>
  {:else if !preview_ready}
    <button class="ed-preview-btn" onclick={fetch_preview}>{t('workflow.preview_diagram')}</button>
  {/if}
  {#if preview_ready}
    <div class="export-bar">
      <button class="export-btn" onclick={() => export_diagram('png')}>PNG</button>
      <button class="export-btn" onclick={() => export_diagram('svg')}>SVG</button>
    </div>
  {/if}
</div>

<style>
  .ed-editor { padding: 4px 0; display: flex; flex-direction: column; gap: 8px; }
  .ed-pathway { border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); border-radius: 6px; overflow: hidden; }
  .ed-pathway-header { display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05))); border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); }
  .ed-color { width: 24px; height: 24px; padding: 0; border: 1px solid var(--dialog-border, #555); border-radius: 4px; cursor: pointer; background: none; }
  .ed-name { flex: 1; padding: 2px 6px; font-size: 12px; font-weight: 600; border: none; background: transparent; color: var(--text-color, #eee); font-family: inherit; }
  .ed-name:focus { outline: none; }
  .ed-remove-path { background: none; border: none; color: var(--text-color-dim, #999); cursor: pointer; font-size: 16px; padding: 0 4px; line-height: 1; }
  .ed-remove-path:hover { color: #ef4444; }
  .ed-table-wrap { padding: 4px; }
  .ed-table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .ed-table th { text-align: left; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-color-dim, #999); padding: 2px 4px; border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #333)); }
  .col-label { width: 45%; } .col-energy { width: 30%; } .col-ts { width: 12%; text-align: center; } .col-action { width: 13%; text-align: center; }
  .td-center { text-align: center; }
  .ed-table td { padding: 1px 2px; }
  .ed-input { width: 100%; padding: 3px 6px; border: 1px solid transparent; border-radius: 3px; background: transparent; color: var(--text-color, #eee); font-size: 11px; font-family: inherit; box-sizing: border-box; }
  .ed-input:focus { outline: none; border-color: var(--accent-color, #3b82f6); background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05))); }
  .ed-energy { font-family: 'SF Mono', 'Cascadia Code', monospace; text-align: right; }
  .ts-row { opacity: 0.7; font-style: italic; }
  .ed-table input[type="checkbox"] { accent-color: var(--accent-color, #3b82f6); cursor: pointer; }
  .ed-remove-step { background: none; border: none; color: var(--text-color-dim, #666); cursor: pointer; font-size: 14px; padding: 0; line-height: 1; }
  .ed-remove-step:hover { color: #ef4444; }
  .ed-add-step { margin-top: 2px; padding: 2px 8px; font-size: 10px; border: 1px dashed var(--dialog-border, light-dark(#d1d5db, #555)); border-radius: 3px; background: transparent; color: var(--accent-color, #3b82f6); cursor: pointer; font-family: inherit; width: 100%; }
  .ed-add-step:hover { background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05))); }
  .ed-paste-hint { font-size: 9px; color: var(--text-color-dim, light-dark(#b0b0b0, #555)); padding: 2px 4px; font-style: italic; }
  .ed-add-pathway { padding: 4px 12px; font-size: 11px; font-weight: 500; border: 1px dashed var(--accent-color, #3b82f6); border-radius: 5px; background: transparent; color: var(--accent-color, #3b82f6); cursor: pointer; font-family: inherit; }
  .ed-add-pathway:hover { background: color-mix(in srgb, var(--accent-color, #3b82f6) 8%, transparent); }
  .ed-preview { border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); border-radius: 6px; overflow: hidden; min-height: 80px; margin-top: 8px; }
  .ed-preview-msg { padding: 12px; font-size: 11px; color: var(--text-color-dim, #999); text-align: center; }
  .ed-error { color: #ef4444; }
  .ed-preview-btn { display: block; margin: 12px auto; padding: 6px 20px; font-size: 12px; font-weight: 600; border: 1px solid var(--accent-color, #3b82f6); border-radius: 5px; background: var(--accent-color, #3b82f6); color: #fff; cursor: pointer; font-family: inherit; }
  .ed-preview-btn:hover { filter: brightness(1.1); }
  .ed-plot-div { width: 100%; min-height: 250px; }
  .ed-hidden { display: none; }
  .export-bar { display: flex; gap: 4px; justify-content: flex-end; padding: 4px 8px; }
  .export-btn { font-size: 10px; padding: 2px 8px; border: 1px solid var(--dialog-border, #555); border-radius: 3px; background: transparent; color: var(--text-color-dim, #999); cursor: pointer; }
  .export-btn:hover { border-color: var(--accent-color, #3b82f6); }
</style>
