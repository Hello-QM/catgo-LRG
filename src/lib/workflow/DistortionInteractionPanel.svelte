<script lang="ts">
  import { API_BASE } from '$lib/api/config'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import EnergyDiagramPlot from './EnergyDiagramPlot.svelte'

  load_i18n_module('common')
  load_i18n_module('workflow')

  type Num = number | null | undefined

  interface Entry {
    label: string
    coordinate: Num
    complex_energy: Num
    in_complex: Num[]
  }

  let fragments: string[] = $state([`A`, `B`])
  let relaxed: Num[] = $state([null, null])
  let entries: Entry[] = $state([
    { label: `TS`, coordinate: null, complex_energy: null, in_complex: [null, null] },
  ])
  let input_unit = $state(`hartree`)
  let output_unit = $state(`kcal/mol`)

  let loading = $state(false)
  let error = $state(``)
  let result: any = $state.raw(null)

  const UNITS = [`hartree`, `eV`, `kcal/mol`, `kJ/mol`]

  function is_num(v: Num): v is number {
    return typeof v === `number` && Number.isFinite(v)
  }

  function add_fragment() {
    fragments.push(String.fromCharCode(65 + fragments.length))
    relaxed.push(null)
    for (const e of entries) e.in_complex.push(null)
  }

  function remove_fragment(k: number) {
    if (fragments.length <= 2) return
    fragments.splice(k, 1)
    relaxed.splice(k, 1)
    for (const e of entries) e.in_complex.splice(k, 1)
  }

  function add_entry() {
    entries.push({
      label: t('workflow.di_entry_n', { n: entries.length + 1 }),
      coordinate: null,
      complex_energy: null,
      in_complex: fragments.map(() => null),
    })
  }

  function remove_entry(i: number) {
    if (entries.length > 1) entries.splice(i, 1)
  }

  // Paste rows from a spreadsheet: Label | Coordinate | E(complex) | E(frag 1) | …
  function handle_paste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData(`text/plain`)
    if (!text || !text.includes(`\t`)) return
    e.preventDefault()
    const parse = (s: string | undefined): Num => {
      const v = parseFloat((s ?? ``).trim())
      return Number.isFinite(v) ? v : null
    }
    const rows = text.trim().split(/\r?\n/).map((r) => r.split(`\t`))
    const parsed: Entry[] = []
    for (const row of rows) {
      const complex_energy = parse(row[2])
      if (!is_num(complex_energy)) continue
      parsed.push({
        label: (row[0] ?? ``).trim() || t('workflow.di_entry_n', { n: parsed.length + 1 }),
        coordinate: parse(row[1]),
        complex_energy,
        in_complex: fragments.map((_, k) => parse(row[3 + k])),
      })
    }
    if (parsed.length > 0) entries = parsed
  }

  async function run() {
    error = ``
    const names = fragments.map((f, k) => f.trim() || `F${k + 1}`)
    if (new Set(names).size !== names.length) {
      error = t('workflow.di_duplicate_fragments')
      return
    }
    if (!relaxed.every(is_num)) {
      error = t('workflow.di_missing_relaxed')
      return
    }
    const payload_entries = []
    for (const e of entries) {
      if (!is_num(e.complex_energy) || !e.in_complex.every(is_num)) {
        error = t('workflow.di_missing_entry', { label: e.label })
        return
      }
      payload_entries.push({
        label: e.label,
        ...(is_num(e.coordinate) ? { coordinate: e.coordinate } : {}),
        complex_energy: e.complex_energy,
        fragments: names.map((name, k) => ({ name, energy_in_complex: e.in_complex[k] })),
      })
    }

    loading = true
    try {
      const res = await fetch(`${API_BASE}/workflow/catalysis/distortion-interaction`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify({
          entries: payload_entries,
          fragment_references: Object.fromEntries(names.map((n, k) => [n, relaxed[k]])),
          input_unit,
          output_unit,
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

  function fmt(v: number) {
    return Number.isFinite(v) ? v.toFixed(2) : `—`
  }
</script>

<div class="di-panel">
  <p class="di-intro">{t('workflow.di_intro')}</p>

  <div class="di-form">
    <label>
      <span>{t('workflow.di_input_unit')}</span>
      <select bind:value={input_unit}>
        {#each UNITS as u}<option value={u}>{u}</option>{/each}
      </select>
    </label>
    <label>
      <span>{t('workflow.di_output_unit')}</span>
      <select bind:value={output_unit}>
        {#each UNITS as u}<option value={u}>{u}</option>{/each}
      </select>
    </label>
  </div>

  <section>
    <h4>{t('workflow.di_fragments')}</h4>
    <table class="di-table">
      <thead>
        <tr>
          <th>{t('workflow.di_fragment_name')}</th>
          <th>{t('workflow.di_relaxed_energy')}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each fragments as _, k}
          <tr>
            <td><input type="text" class="di-input" bind:value={fragments[k]} /></td>
            <td><input type="number" class="di-input num" step="any" bind:value={relaxed[k]} /></td>
            <td class="center">
              {#if fragments.length > 2}
                <button class="di-remove" onclick={() => remove_fragment(k)} title={t('common.remove')}>&times;</button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <button class="di-add" onclick={add_fragment}>{t('workflow.di_add_fragment')}</button>
  </section>

  <section>
    <h4>{t('workflow.di_entries')}</h4>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="di-scroll" onpaste={handle_paste}>
      <table class="di-table">
        <thead>
          <tr>
            <th>{t('common.label')}</th>
            <th>{t('workflow.di_coordinate')}</th>
            <th>{t('workflow.di_complex_energy')}</th>
            {#each fragments as f}
              <th>{t('workflow.di_fragment_in_complex', { name: f })}</th>
            {/each}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each entries as entry, i}
            <tr>
              <td><input type="text" class="di-input" bind:value={entry.label} /></td>
              <td><input type="number" class="di-input num" step="any" bind:value={entry.coordinate} /></td>
              <td><input type="number" class="di-input num" step="any" bind:value={entry.complex_energy} /></td>
              {#each fragments as _, k}
                <td><input type="number" class="di-input num" step="any" bind:value={entry.in_complex[k]} /></td>
              {/each}
              <td class="center">
                {#if entries.length > 1}
                  <button class="di-remove" onclick={() => remove_entry(i)} title={t('common.remove')}>&times;</button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <button class="di-add" onclick={add_entry}>{t('workflow.di_add_entry')}</button>
    <div class="di-hint">{t('workflow.di_paste_hint')}</div>
  </section>

  <button class="di-run" onclick={run} disabled={loading}>
    {loading ? t('workflow.es_running') : t('workflow.di_run')}
  </button>

  {#if error}
    <div class="di-error">{error}</div>
  {/if}

  {#if result}
    <div class="di-scroll">
      <table class="di-table di-results">
        <thead>
          <tr>
            <th>{t('common.label')}</th>
            {#each result.entries[0].fragments as f}
              <th class="num">ΔE<sub>dist</sub>({f.name})</th>
            {/each}
            <th class="num">ΔE<sub>dist</sub></th>
            <th class="num">ΔE<sub>int</sub></th>
            <th class="num">ΔE</th>
          </tr>
        </thead>
        <tbody>
          {#each result.entries as row}
            <tr>
              <td>{row.label}</td>
              {#each row.fragments as f}
                <td class="num">{fmt(f.distortion)}</td>
              {/each}
              <td class="num">{fmt(row.distortion)}</td>
              <td class="num">{fmt(row.interaction)}</td>
              <td class="num strong">{fmt(row.total)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="di-hint">{t('workflow.di_unit_note', { unit: result.unit })}</div>

    <div class="di-plot">
      <EnergyDiagramPlot plotly_data={result.plotly_data} height={340} editable={false} />
    </div>
    {#if result.profile_plotly_data}
      <div class="di-plot">
        <EnergyDiagramPlot plotly_data={result.profile_plotly_data} height={340} editable={false} />
      </div>
    {/if}
    <div class="di-cite">{t('workflow.di_citation')}</div>
  {/if}
</div>

<style>
  .di-panel { display: flex; flex-direction: column; gap: 10px; font-size: 12px; }
  .di-intro { margin: 0; color: var(--text-color-muted, #94a3b8); line-height: 1.5; }
  h4 { margin: 0 0 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-color-dim, #999); }
  .di-form { display: flex; flex-wrap: wrap; gap: 10px; }
  .di-form label { display: flex; flex-direction: column; gap: 3px; min-width: 120px; }
  .di-form label span { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; color: var(--text-color-dim, #999); }
  .di-form select {
    padding: 4px 6px; font-size: 12px; font-family: inherit; border-radius: 4px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
    color: var(--text-color, #eee);
  }
  .di-scroll { overflow-x: auto; }
  .di-table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .di-table th { text-align: left; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-color-dim, #999); padding: 3px 4px; border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #333)); white-space: nowrap; }
  .di-table th sub { text-transform: none; }
  .di-table td { padding: 1px 2px; }
  .di-results td { padding: 3px 6px; border-bottom: 1px solid light-dark(rgba(0,0,0,0.05), rgba(255,255,255,0.05)); }
  .di-table .num { text-align: right; font-family: 'SF Mono', 'Cascadia Code', monospace; }
  .di-table .strong { font-weight: 600; }
  .center { text-align: center; }
  .di-input { width: 100%; min-width: 80px; padding: 3px 6px; border: 1px solid transparent; border-radius: 3px; background: transparent; color: var(--text-color, #eee); font-size: 11px; font-family: inherit; box-sizing: border-box; }
  .di-input.num { font-family: 'SF Mono', 'Cascadia Code', monospace; text-align: right; }
  .di-input:focus { outline: none; border-color: var(--accent-color, #3b82f6); background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05))); }
  .di-remove { background: none; border: none; color: var(--text-color-dim, #666); cursor: pointer; font-size: 14px; padding: 0; line-height: 1; }
  .di-remove:hover { color: #ef4444; }
  .di-add { margin-top: 2px; padding: 2px 8px; font-size: 10px; border: 1px dashed var(--dialog-border, light-dark(#d1d5db, #555)); border-radius: 3px; background: transparent; color: var(--accent-color, #3b82f6); cursor: pointer; font-family: inherit; width: 100%; }
  .di-hint { font-size: 10px; color: var(--text-color-dim, #999); font-style: italic; padding: 2px 4px; }
  .di-run {
    align-self: flex-start; padding: 6px 18px; font-size: 12px; font-weight: 600; border-radius: 5px;
    border: 1px solid var(--accent-color, #3b82f6); background: var(--accent-color, #3b82f6);
    color: #fff; cursor: pointer; font-family: inherit;
  }
  .di-run:disabled { opacity: 0.6; cursor: default; }
  .di-error { color: #ef4444; font-size: 11px; }
  .di-plot { border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); border-radius: 6px; overflow: hidden; }
  .di-cite { font-size: 10px; color: var(--text-color-dim, #999); }
</style>
