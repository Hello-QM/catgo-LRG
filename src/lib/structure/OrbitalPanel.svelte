<script lang="ts">
  import { DraggablePane } from '$lib'
  import type { CubeMesh } from '$lib/cube'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { ComponentProps } from 'svelte'
  import type { HTMLAttributes } from 'svelte/elements'
  import AimTab from '$lib/wavefunction/AimTab.svelte'
  import EspTab from '$lib/wavefunction/EspTab.svelte'
  import NboTab from '$lib/wavefunction/NboTab.svelte'
  import WeakInteractionTab from '$lib/wavefunction/WeakInteractionTab.svelte'
  import {
    fetch_orbital_cube,
    frontier_label,
    get_saved_multiwfn_path,
    multiwfn_status,
    save_multiwfn_path,
    type GridQuality,
    type MultiwfnStatus,
    type NboResult,
    type Orbital,
    type OrbitalSpin,
    type WavefunctionInfo,
  } from '$lib/wavefunction/api'
  import { local_orbital_cube } from '$lib/wavefunction/local-analyses'
  import type { AnalysisOverlayData, CubeDisplayOptions } from '$lib/wavefunction/overlay'

  load_i18n_module('structure')

  type Tab = `orbitals` | `weak` | `esp` | `aim` | `nbo`

  let {
    pane_open = $bindable(false),
    wavefunction = null,
    nbo = $bindable(null),
    surface_mesh = null,
    on_cube,
    on_overlay = () => {},
    on_charges = () => {},
    toggle_props = {},
    pane_props = {},
    ...rest
  }: Omit<HTMLAttributes<HTMLDivElement>, `onclose`> & {
    pane_open?: boolean
    /** Loaded wavefunction file; null when only NBO results are shown */
    wavefunction?: WavefunctionInfo | null
    nbo?: NboResult | null
    /** The isosurface currently shown by the cube panel */
    surface_mesh?: CubeMesh | null
    /** Receives a generated cube file and how to display it. */
    on_cube: (file: File, options: CubeDisplayOptions) => void
    on_overlay?: (overlay: AnalysisOverlayData | null) => void
    on_charges?: (charges: number[]) => void
    toggle_props?: ComponentProps<typeof DraggablePane>[`toggle_props`]
    pane_props?: ComponentProps<typeof DraggablePane>[`pane_props`]
  } = $props()

  const WINDOW = 10

  let tab = $state<Tab>(`orbitals`)
  let spin = $state<OrbitalSpin>(`restricted`)
  let show_all = $state(false)
  let grid = $state<GridQuality>(`medium`)
  let multiwfn_path = $state(get_saved_multiwfn_path())
  let status = $state<MultiwfnStatus | null>(null)
  let status_error = $state(``)
  let busy_index = $state<number | null>(null)
  let active_index = $state<number | null>(null)
  let error = $state(``)
  // Which analysis produced the surface on screen (ESP stats only apply to its own map)
  let surface_kind = $state<Tab | null>(null)

  // Reset view state whenever a new file is loaded
  $effect(() => {
    const wf = wavefunction
    spin = wf?.unrestricted ? `alpha` : `restricted`
    show_all = false
    active_index = null
    error = ``
    surface_kind = null
    tab = wf ? `orbitals` : `nbo`
  })

  let spins = $derived(
    wavefunction?.unrestricted ? ([`alpha`, `beta`] as OrbitalSpin[]) : ([`restricted`] as OrbitalSpin[]),
  )
  let frontier = $derived(wavefunction?.frontier[spin])
  let spin_orbitals = $derived(wavefunction?.orbitals.filter((o) => o.spin === spin) ?? [])
  let visible = $derived.by(() => {
    if (show_all || !frontier || frontier.homo === null) return spin_orbitals
    const homo = frontier.homo
    const lumo = frontier.lumo ?? homo + 1
    return spin_orbitals.filter((o) => o.index >= homo - WINDOW && o.index <= lumo + WINDOW)
  })
  // Highest energy first, like an MO diagram
  let rows = $derived([...visible].reverse())

  const TABS: { id: Tab; label: string; needs_wavefunction: boolean }[] = [
    { id: `orbitals`, label: `structure.wfa_tab_orbitals`, needs_wavefunction: true },
    { id: `weak`, label: `structure.wfa_tab_weak`, needs_wavefunction: true },
    { id: `esp`, label: `structure.wfa_tab_esp`, needs_wavefunction: true },
    { id: `aim`, label: `structure.wfa_tab_aim`, needs_wavefunction: true },
    { id: `nbo`, label: `structure.wfa_tab_nbo`, needs_wavefunction: false },
  ]

  async function check_status() {
    status_error = ``
    try {
      status = await multiwfn_status(multiwfn_path.trim() || undefined)
    } catch (err) {
      status = null
      status_error = err instanceof Error ? err.message : String(err)
    }
  }

  // Multiwfn is only needed by the ESP / IGMH / AIM analyses
  $effect(() => {
    if (pane_open && wavefunction?.session_id && status === null && !status_error) check_status()
  })

  // Multiwfn's load-time check: Tr(P·S) should equal the electron count
  let inconsistent = $derived(
    wavefunction?.trace_ps != null && wavefunction.n_electrons != null &&
      Math.abs(wavefunction.trace_ps - wavefunction.n_electrons) > 0.01,
  )

  function on_path_change() {
    const path = multiwfn_path.trim()
    save_multiwfn_path(path)
    check_status()
  }

  function cube_for(kind: Tab) {
    return (file: File, options: CubeDisplayOptions) => {
      surface_kind = kind
      on_overlay(null)
      on_cube(file, options)
    }
  }

  async function show_orbital(orbital: Orbital) {
    if (busy_index !== null || !wavefunction) return
    busy_index = orbital.index
    error = ``
    try {
      const text = wavefunction.local_key
        ? await local_orbital_cube(wavefunction, orbital.index, grid)
        : await fetch_orbital_cube(
          wavefunction.session_id ?? ``,
          orbital.index,
          grid,
          multiwfn_path.trim() || undefined,
        )
      const base = wavefunction.filename.replace(/\.[^.]+$/, ``)
      const tag = orbital.spin === `restricted` ? `` : orbital.spin === `alpha` ? `a` : `b`
      const file = new File([text], `${base}_MO${orbital.number}${tag}.cub`, {
        type: `chemical/x-cube`,
      })
      active_index = orbital.index
      cube_for(`orbitals`)(file, {})
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy_index = null
    }
  }

  function fmt(v: number | null, digits: number) {
    return v === null || !Number.isFinite(v) ? `—` : v.toFixed(digits)
  }

  function occ_text(o: Orbital) {
    return Number.isInteger(o.occupation) ? String(o.occupation) : o.occupation.toFixed(3)
  }
</script>

<DraggablePane
  bind:show={pane_open}
  max_width="22em"
  close_on_click_outside={false}
  toggle_props={{
    class: `orbital-panel-toggle`,
    title: pane_open ? t('structure.orbital_close') : t('structure.orbital_open'),
    ...toggle_props,
  }}
  open_icon="Cross"
  closed_icon="ElectronShells"
  pane_props={{ ...pane_props, class: `orbital-panel ${pane_props?.class ?? ``}` }}
  {...rest}
>
  <div class="orb">
    <h4>{t('structure.wfa_title')}</h4>
    <div class="orb-tabs" role="tablist">
      {#each TABS as tb (tb.id)}
        <button
          role="tab"
          class:active={tab === tb.id}
          aria-selected={tab === tb.id}
          disabled={tb.needs_wavefunction && !wavefunction}
          onclick={() => (tab = tb.id)}
        >
          {t(tb.label)}
        </button>
      {/each}
    </div>

    {#if wavefunction}
    <div class="orb-file" title={wavefunction.title}>{wavefunction.filename}</div>
    <div class="orb-meta">
      {#if wavefunction.charge !== null}
        <span>{t('structure.orbital_charge')}: {wavefunction.charge}</span>
      {/if}
      {#if wavefunction.multiplicity !== null}
        <span>{t('structure.orbital_multiplicity')}: {wavefunction.multiplicity}</span>
      {/if}
      {#if wavefunction.energy !== null}
        <span>E = {wavefunction.energy.toFixed(6)} Ha</span>
      {/if}
    </div>
    {#if inconsistent}
      <div class="orb-error">
        {t('structure.wfa_inconsistent', {
          trace: wavefunction.trace_ps?.toFixed(4) ?? ``,
          n: wavefunction.n_electrons ?? ``,
        })}
      </div>
    {/if}

    {/if}

    <!-- Tabs stay mounted so their results survive switching -->
    <div class="orb-pane" class:hidden={tab !== `orbitals`}>
    {#if spins.length > 1}
      <div class="orb-spins" role="tablist">
        {#each spins as s}
          <button role="tab" class:active={spin === s} aria-selected={spin === s} onclick={() => (spin = s)}>
            {s === `alpha` ? `α` : `β`}
          </button>
        {/each}
      </div>
    {/if}

    {#if frontier?.gap_ev != null}
      <div class="orb-gap">{t('structure.orbital_gap')}: <b>{fmt(frontier.gap_ev, 3)} eV</b></div>
    {/if}

    {#if spin_orbitals.length === 0}
      <div class="orb-note">{t('structure.orbital_none')}</div>
    {:else}
      <div class="orb-list">
        <table>
          <thead>
            <tr>
              <th></th>
              <th class="num">#</th>
              <th class="num">E (eV)</th>
              <th class="num">{t('structure.orbital_occ')}</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as o (o.index)}
              {@const label = frontier_label(o, frontier)}
              <tr
                class:occupied={o.occupation > 1e-6}
                class:frontier={label === `HOMO` || label === `LUMO`}
                class:active={active_index === o.index}
                onclick={() => show_orbital(o)}
                onkeydown={(e) => {
                  if (e.key === `Enter` || e.key === ` `) {
                    e.preventDefault()
                    show_orbital(o)
                  }
                }}
                tabindex="0"
                role="button"
                title={t('structure.orbital_click_hint')}
              >
                <td class="lbl">{busy_index === o.index ? `…` : label}</td>
                <td class="num">{o.number}</td>
                <td class="num">{fmt(o.energy_ev, 3)}</td>
                <td class="num">{occ_text(o)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if frontier && frontier.homo !== null && spin_orbitals.length > visible.length}
        <button class="orb-link" onclick={() => (show_all = true)}>
          {t('structure.orbital_show_all', { n: spin_orbitals.length })}
        </button>
      {:else if show_all}
        <button class="orb-link" onclick={() => (show_all = false)}>
          {t('structure.orbital_show_frontier')}
        </button>
      {/if}
    {/if}

    {#if error}
      <div class="orb-error">{error}</div>
    {/if}
    </div>

    {#if wavefunction}
      <div class="orb-pane" class:hidden={tab !== `weak`}>
        <WeakInteractionTab {wavefunction} {grid} {multiwfn_path} on_cube={cube_for(`weak`)} />
      </div>
      <div class="orb-pane" class:hidden={tab !== `esp`}>
        <EspTab
          {wavefunction}
          {grid}
          {multiwfn_path}
          surface_mesh={surface_kind === `esp` ? surface_mesh : null}
          on_cube={cube_for(`esp`)}
          {on_overlay}
        />
      </div>
      <div class="orb-pane" class:hidden={tab !== `aim`}>
        <AimTab {wavefunction} {multiwfn_path} {on_overlay} />
      </div>
    {/if}
    <div class="orb-pane" class:hidden={tab !== `nbo`}>
      <NboTab bind:nbo {on_charges} />
    </div>

    {#if wavefunction && tab !== `nbo`}
    <section class="orb-settings">
      <label>
        <span>{t('structure.orbital_grid')}</span>
        <select bind:value={grid}>
          <option value="low">{t('structure.orbital_grid_low')}</option>
          <option value="medium">{t('structure.orbital_grid_medium')}</option>
          <option value="high">{t('structure.orbital_grid_high')}</option>
        </select>
      </label>
      {#if wavefunction.session_id}
      <label>
        <span>{t('structure.orbital_multiwfn_path')}</span>
        <input
          type="text"
          bind:value={multiwfn_path}
          onchange={on_path_change}
          placeholder={t('structure.orbital_multiwfn_placeholder')}
          spellcheck="false"
        />
      </label>
      <div class="orb-status">
        {#if status_error}
          <span class="bad">{status_error}</span>
        {:else if status?.found}
          <span class="good">✓ {status.path}</span>
        {:else if status}
          <span class="bad">{t('structure.orbital_multiwfn_missing')}</span>
        {/if}
      </div>
      {/if}
      <div class="orb-cite">{t('structure.wfa_engine_cite')}</div>
    </section>
    {/if}
  </div>
</DraggablePane>

<style>
  .orb { display: flex; flex-direction: column; gap: 6px; font-size: 12px; min-width: 16em; }
  h4 { margin: 0; font-size: 13px; }
  .orb-file { font-weight: 600; overflow-wrap: anywhere; }
  .orb-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--text-color-muted, #94a3b8); font-size: 11px; }
  .orb-tabs { display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); }
  .orb-tabs button {
    padding: 4px 7px; font-size: 11px; font-family: inherit; background: none; border: none; cursor: pointer;
    border-bottom: 2px solid transparent; color: var(--text-color-muted, #94a3b8);
  }
  .orb-tabs button.active { color: var(--text-color, #eee); border-bottom-color: var(--accent-color, #3b82f6); font-weight: 600; }
  .orb-tabs button:disabled { opacity: 0.4; cursor: default; }
  .orb-pane { display: flex; flex-direction: column; gap: 6px; }
  .orb-pane.hidden { display: none; }
  .orb-spins { display: flex; gap: 4px; }
  .orb-spins button {
    flex: 1; padding: 3px 0; font-size: 12px; cursor: pointer; border-radius: 4px; font-family: inherit;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); background: transparent; color: inherit;
  }
  .orb-spins button.active { background: var(--accent-color, #3b82f6); border-color: var(--accent-color, #3b82f6); color: #fff; }
  .orb-gap { font-size: 11px; }
  .orb-list { max-height: 18em; overflow-y: auto; border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { position: sticky; top: 0; background: var(--surface-bg, light-dark(#fff, #1e1e1e)); text-align: left; font-size: 9px; font-weight: 600; text-transform: uppercase; color: var(--text-color-dim, #999); padding: 3px 6px; }
  td { padding: 2px 6px; }
  .num { text-align: right; font-family: 'SF Mono', 'Cascadia Code', monospace; }
  tbody tr { cursor: pointer; }
  tbody tr:focus-visible { outline: 2px solid var(--accent-color, #3b82f6); outline-offset: -2px; }
  tbody tr:hover { background: light-dark(rgba(0,0,0,0.05), rgba(255,255,255,0.06)); }
  tr.occupied td.num:nth-child(3) { color: var(--accent-color, #3b82f6); }
  tr.frontier td { font-weight: 600; }
  tr.active { background: color-mix(in srgb, var(--accent-color, #3b82f6) 18%, transparent); }
  .lbl { font-size: 10px; color: var(--text-color-muted, #94a3b8); white-space: nowrap; }
  .orb-link { align-self: flex-start; background: none; border: none; padding: 0; color: var(--accent-color, #3b82f6); cursor: pointer; font-size: 11px; font-family: inherit; }
  .orb-note { color: var(--text-color-muted, #94a3b8); font-style: italic; }
  .orb-error { color: #ef4444; font-size: 11px; white-space: pre-wrap; max-height: 8em; overflow-y: auto; }
  .orb-settings { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); padding-top: 6px; }
  .orb-settings label { display: flex; flex-direction: column; gap: 2px; }
  .orb-settings label span { font-size: 10px; font-weight: 600; text-transform: uppercase; color: var(--text-color-dim, #999); }
  .orb-settings input, .orb-settings select {
    padding: 3px 6px; font-size: 11px; font-family: inherit; border-radius: 4px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05))); color: inherit;
  }
  .orb-status { font-size: 10px; overflow-wrap: anywhere; }
  .orb-cite { font-size: 9px; line-height: 1.35; color: var(--text-color-dim, #999); }
  .good { color: #16a34a; }
  .bad { color: #ef4444; }
</style>
