<script lang="ts">
  import { onMount } from 'svelte'
  import type { AnyStructure } from '$lib'
  import { DEFAULTS } from '$lib/settings'
  import type { BondingStrategy } from '$lib/structure/bonding'
  import { compute_bonds_sync } from '$lib/structure/workers/bond-worker-api'
  import { render_svg } from './catrender-wasm'
  import {
    merge_bonds, prune_overrides,
    type Bond, type BondOverride,
  } from './bond-merge'
  import {
    merge_atoms, prune_atom_overrides,
    type AtomOverride,
  } from './atom-merge'

  let { structure = undefined as AnyStructure | undefined } = $props()

  // Full 12-preset set (spec §"13 presets"; overlay is internal but exposed).
  const PRESETS = [
    `default`, `flat`, `paton`, `skeletal`, `bubble`, `tube`, `mtube`,
    `btube`, `wire`, `graph`, `pmol`, `overlay`,
  ] as const

  // Axis gizmo colours — default.json `axis_colors` [firebrick,forestgreen,
  // royalblue] (X red, Y green, Z blue).
  const AXIS_COLORS = [`firebrick`, `forestgreen`, `royalblue`] as const

  let preset = $state<(typeof PRESETS)[number]>(`default`)
  let show_h = $state(true)
  let show_cell = $state(false)

  // --- The OPEN live-knob override map (locked decision: ANY default.json
  // knob is live-tunable; sent as style.overrides; empty = inherit preset).
  // Dedicated controls below + an advanced raw-JSON textarea feed the pure
  // `overrides` $derived ({ map, err }) defined further down.

  // Dedicated-control backing state. Each is gated by an `*_on` toggle so an
  // untouched control does NOT pin a value into the override map (unset =
  // inherit preset). Touching the control flips its toggle.
  type Knob = { on: boolean }
  let k_atom_scale = $state({ on: false, v: 2.5 })
  let k_bond_width = $state({ on: false, v: 20 })
  let k_atom_stroke_width = $state({ on: false, v: 8 })
  let k_hue = $state({ on: false, v: 0.1 })
  let k_light = $state({ on: false, v: 0.15 })
  let k_sat = $state({ on: false, v: 0.15 })
  let k_fog_strength = $state({ on: false, v: 1.2 })
  let k_label_font_size = $state({ on: false, v: 40 })
  let k_gradient = $state({ on: false, v: true })
  let k_fog = $state({ on: false, v: true })
  let k_bond_orders = $state({ on: false, v: true })
  let k_bond_color_by_element = $state({ on: false, v: false })
  let k_bond_gradient = $state({ on: false, v: false })
  let k_atoms_above_bonds = $state({ on: false, v: false })
  let k_bond_color = $state({ on: false, v: `#000000` })
  let k_background = $state({ on: false, v: `#ffffff` })
  let k_cell_color = $state({ on: false, v: `#808080` })

  // Advanced: raw JSON the power-user/AI uses for ANY knob not given a
  // dedicated control. Merged LAST onto the dedicated knobs.
  let advanced_json = $state(``)

  // Derived open override map: dedicated (only `on` knobs) ← advanced JSON.
  // PURE projection — returns `{ map, err }`; no external $state writes (a
  // Svelte 5 footgun). Malformed advanced JSON → `err` set + `map` is the
  // last-good dedicated-knob map (advanced merge skipped). Consumers read
  // `overrides.map` for the payload and `overrides.err` for the inline error.
  const overrides = $derived.by((): {
    map: Record<string, unknown>
    err: string
  } => {
    const o: Record<string, unknown> = {}
    let err = ``
    if (k_atom_scale.on) o.atom_scale = k_atom_scale.v
    if (k_bond_width.on) o.bond_width = k_bond_width.v
    if (k_atom_stroke_width.on) o.atom_stroke_width = k_atom_stroke_width.v
    if (k_hue.on) o.hue_shift_factor = k_hue.v
    if (k_light.on) o.light_shift_factor = k_light.v
    if (k_sat.on) o.saturation_shift_factor = k_sat.v
    if (k_fog_strength.on) o.fog_strength = k_fog_strength.v
    if (k_label_font_size.on) o.label_font_size = k_label_font_size.v
    if (k_gradient.on) o.gradient = k_gradient.v
    if (k_fog.on) o.fog = k_fog.v
    if (k_bond_orders.on) o.bond_orders = k_bond_orders.v
    if (k_bond_color_by_element.on)
      o.bond_color_by_element = k_bond_color_by_element.v
    if (k_bond_gradient.on) o.bond_gradient = k_bond_gradient.v
    if (k_atoms_above_bonds.on) o.atoms_above_bonds = k_atoms_above_bonds.v
    if (k_bond_color.on) o.bond_color = k_bond_color.v
    if (k_background.on) o.background = k_background.v
    if (k_cell_color.on) o.cell_color = k_cell_color.v
    if (advanced_json.trim()) {
      try {
        const parsed = JSON.parse(advanced_json)
        if (parsed && typeof parsed === `object` && !Array.isArray(parsed))
          Object.assign(o, parsed)
        else err = `advanced JSON must be an object`
      } catch (e) {
        err = `advanced JSON: ${String(e)}`
      }
    }
    return { map: o, err }
  })

  function reset_to_preset() {
    for (
      const kk of [
        k_atom_scale, k_bond_width, k_atom_stroke_width, k_hue, k_light,
        k_sat, k_fog_strength, k_label_font_size, k_gradient, k_fog,
        k_bond_orders, k_bond_color_by_element, k_bond_gradient,
        k_atoms_above_bonds, k_bond_color, k_background, k_cell_color,
      ] as { on: boolean }[]
    ) kk.on = false
    advanced_json = ``
  }

  // --- Bond-edit override layer (existing bond-merge plumbing) ------------
  let bond_overrides = $state<BondOverride[]>([])
  let be_i = $state(0)
  let be_j = $state(1)
  let be_order = $state(1)
  function bond_add() {
    bond_overrides = [
      ...bond_overrides,
      { op: `add`, i: be_i, j: be_j, order: be_order },
    ]
  }
  function bond_remove() {
    bond_overrides = [
      ...bond_overrides,
      { op: `remove`, i: be_i, j: be_j },
    ]
  }
  function bond_setorder() {
    bond_overrides = [
      ...bond_overrides,
      { op: `setorder`, i: be_i, j: be_j, order: be_order },
    ]
  }
  function bond_clear() {
    bond_overrides = []
  }

  // --- Atom-edit override layer (atom-merge; render-only, NO write-back) --
  let atom_overrides = $state<AtomOverride[]>([])
  let selected_atom = $state<number | null>(null)
  let recolor_hex = $state(`#ff0000`)
  function atom_hide(idx: number) {
    atom_overrides = [...atom_overrides, { op: `hide`, idx }]
  }
  function atom_recolor(idx: number) {
    atom_overrides = [
      ...atom_overrides,
      { op: `recolor`, idx, hex: recolor_hex },
    ]
  }
  function atom_clear() {
    atom_overrides = []
  }

  // --- Drag-rotate overlay (extra rotation applied AFTER PCA by the core) -
  // Accumulated intrinsic XYZ euler deltas (degrees) → style.drag_rotation.
  let drag_rot = $state<[number, number, number]>([0, 0, 0])
  let dragging = $state(false)
  let last_xy: [number, number] | null = null
  function on_pointer_down(e: PointerEvent) {
    dragging = true
    last_xy = [e.clientX, e.clientY]
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  function on_pointer_move(e: PointerEvent) {
    if (!dragging || !last_xy) return
    const dx = e.clientX - last_xy[0]
    const dy = e.clientY - last_xy[1]
    last_xy = [e.clientX, e.clientY]
    // horizontal drag → yaw (Y), vertical drag → pitch (X). 0.5°/px.
    drag_rot = [
      (drag_rot[0] + dy * 0.5) % 360,
      (drag_rot[1] + dx * 0.5) % 360,
      drag_rot[2],
    ]
  }
  function on_pointer_up(e: PointerEvent) {
    dragging = false
    last_xy = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
  }
  function reset_view() {
    drag_rot = [0, 0, 0]
  }

  let svg = $state(`<svg/>`)
  let render_err = $state(``)
  let preview_el: HTMLDivElement | undefined = $state()

  // --- Mirror: read-only structure + connectivity ------------------------
  // Bonds aligned to the app-wide bonding default (DEFAULTS.structure.*),
  // NOT a hardcoded `electroneg_ratio` (spec §Frontend). The per-panel live
  // strategy lives in each Structure component's scene_props (not a global
  // store the pane can subscribe to); the app default is the honest,
  // non-hardcoded source available to a prop-only pane.
  const BOND_STRATEGY =
    (DEFAULTS.structure.bonding_strategy ?? `electroneg_ratio`) as BondingStrategy
  const BOND_OPTIONS =
    (DEFAULTS.structure.bonding_options ?? {}) as Record<string, number>

  const mirror = $derived.by(() => {
    if (!structure || !(`sites` in structure)) return null
    const atoms = structure.sites.map((s) => ({
      el: s.species?.[0]?.element ?? s.label ?? `X`,
      xyz: s.xyz as [number, number, number],
    }))
    // compute_bonds_sync(structure, strategy, options) -> BondPair[] | null
    // (RT5 API; site_idx_1/2 endpoints). null = WASM not ready / too big.
    const pairs = compute_bonds_sync(
      structure as AnyStructure,
      BOND_STRATEGY,
      BOND_OPTIONS,
    ) ?? []
    const base: Bond[] = pairs.map((p) => ({
      i: p.site_idx_1, j: p.site_idx_2, order: 1,
    }))
    const lattice =
      (`lattice` in structure ? structure.lattice?.matrix : null) ?? null
    return { atoms, base, lattice, n: atoms.length }
  })

  // --- Atom-edit selection helpers ---------------------------------------
  // Hit-test: map a preview click to the nearest projected atom centre by
  // reading the rendered <circle cx cy> list out of the SVG DOM. Render-only.
  function pick_atom(e: MouseEvent) {
    const svg_el = preview_el?.querySelector(`svg`)
    if (!svg_el) return
    const circles = svg_el.querySelectorAll(`circle`)
    if (!circles.length) return
    const rect = svg_el.getBoundingClientRect()
    const vb = svg_el.viewBox.baseVal
    const sx = vb.width / rect.width
    const sy = vb.height / rect.height
    const px = (e.clientX - rect.left) * sx + vb.x
    const py = (e.clientY - rect.top) * sy + vb.y
    let best = -1
    let best_d = Infinity
    circles.forEach((c, idx) => {
      const cx = parseFloat(c.getAttribute(`cx`) ?? `NaN`)
      const cy = parseFloat(c.getAttribute(`cy`) ?? `NaN`)
      if (Number.isNaN(cx) || Number.isNaN(cy)) return
      const d = (cx - px) ** 2 + (cy - py) ** 2
      if (d < best_d) {
        best_d = d
        best = idx
      }
    })
    if (best < 0) return
    // `best` is the DOM/paint ordinal of the picked <circle>. svg.rs emits one
    // circle per VISIBLE atom in ORIGINAL atom order, skipping hidden atoms —
    // so the Nth rendered circle is the Nth non-hidden atom. Reconstruct that
    // visible→original map via merge_atoms (this is what makes merge_atoms
    // load-bearing): build the hidden set off the same pruned overrides the
    // render uses, list the non-hidden original indices in order, and look up
    // the picked ordinal. Without this, hidden atoms shift the DOM index and
    // a click selects the wrong ORIGINAL atom.
    const m = mirror
    if (!m) return
    const a_ov = prune_atom_overrides($state.snapshot(atom_overrides), m.n)
    const { hidden } = merge_atoms(m.n, a_ov)
    const visible_idx: number[] = []
    for (let i = 0; i < m.n; i++) if (!hidden.has(i)) visible_idx.push(i)
    selected_atom = best < visible_idx.length ? visible_idx[best] : best
  }
  function on_preview_click(e: MouseEvent) {
    // a plain click (not the end of a drag) selects an atom
    if (!dragging) pick_atom(e)
  }

  // --- xyz axis gizmo: parse the core-surfaced (PCA·drag) basis ----------
  // svg.rs emits `data-gizmo-basis="r00,r01,..,r22"` (row-major; row k = the
  // post-transform world direction of input axis k). We project columns to
  // 2-D (x→right, y→down screen) for a 64-px corner triad — EXACT renderer
  // orientation, no client re-derivation.
  const gizmo = $derived.by(() => {
    const m = svg.match(/data-gizmo-basis="([^"]+)"/)
    const vals = m
      ? m[1].split(`,`).map(Number)
      : [1, 0, 0, 0, 1, 0, 0, 0, 1]
    if (vals.length !== 9 || vals.some((v) => Number.isNaN(v)))
      return [
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 0, z: 1 },
      ]
    // Column j = screen image of input axis j. Row-major rot: rot[r][c]
    // maps input col c. Screen: +x right, +y down (SVG y is down).
    const col = (j: number) => ({
      x: vals[0 * 3 + j],
      y: vals[1 * 3 + j],
      z: vals[2 * 3 + j],
    })
    return [col(0), col(1), col(2)]
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  let render_seq = 0
  // NOTE: Svelte 5 tracks only synchronous reads in the effect *body*.
  // Reads inside the setTimeout callback are NOT tracked — the `void [...]`
  // line below is the dependency manifest and MUST list every reactive
  // value the render depends on. Add new controls there too.
  // [C1 — LOCKED: render_seq + cancelled + teardown preserved exactly.]
  $effect(() => {
    const m = mirror
    void [
      preset, show_h, show_cell, overrides, bond_overrides, atom_overrides,
      drag_rot, m,
    ]
    if (!m) return
    clearTimeout(timer)
    let cancelled = false
    const seq = ++render_seq
    timer = setTimeout(async () => {
      const pruned = prune_overrides($state.snapshot(bond_overrides), m.n)
      const bonds = merge_bonds(m.base, pruned)
      const a_ov = prune_atom_overrides($state.snapshot(atom_overrides), m.n)
      const ov = $state.snapshot(overrides.map) as Record<string, unknown>
      const input = JSON.stringify({
        atoms: m.atoms,
        bonds,
        lattice: m.lattice,
        atom_overrides: a_ov,
        style: {
          preset, show_h,
          drag_rotation: drag_rot,
          cell: { show: show_cell, supercell: [1, 1, 1], pbc_wrap: false },
          ...(Object.keys(ov).length ? { overrides: ov } : {}),
        },
      })
      try {
        const out = await render_svg(input)
        if (!cancelled && seq === render_seq) { svg = out; render_err = `` }
      } catch (e) {
        if (!cancelled && seq === render_seq) render_err = String(e)
      }
    }, 16)
    return () => { cancelled = true; clearTimeout(timer) }
  })

  // --- AI export bridge poll loop -----------------------------------------
  // Mirrors the poll_screenshot 2s loop in tool-handler.ts: while this pane
  // is mounted it fulfils pending /catrender/request signals by rendering
  // the CURRENT mirror + interactive bond overrides with the AI-requested
  // style merged in. Independent of the C1-guarded debounced $effect above.
  const API_BASE = `/api`

  onMount(() => {
    let stopped = false
    ;(async () => {
      while (!stopped) {
        try {
          // Intentionally NOT panel-scoped: any open Render pane is a valid
          // responder for an AI export request. If two panes are mounted both
          // may answer; the server's /result done()-guard 409s the loser
          // (swallowed below). Do not add panel_id scoping — it breaks
          // headless-style requests that target "whatever pane is open".
          const r = await fetch(`${API_BASE}/view/catrender/pending`)
          if (r.ok) {
            const { pending } = await r.json()
            for (const item of pending as {
              request_id: string
              style: any
              format: string
            }[]) {
              const m = mirror
              if (!m) continue
              const pruned = prune_overrides(
                $state.snapshot(bond_overrides), m.n,
              )
              const bonds = merge_bonds(m.base, pruned)
              const a_ov = prune_atom_overrides(
                $state.snapshot(atom_overrides), m.n,
              )
              const ov = { ...overrides.map }
              const out = await render_svg(
                JSON.stringify({
                  atoms: m.atoms,
                  bonds,
                  lattice: m.lattice,
                  atom_overrides: a_ov,
                  style: {
                    preset,
                    show_h,
                    drag_rotation: drag_rot,
                    ...(Object.keys(ov).length ? { overrides: ov } : {}),
                    ...item.style,
                  },
                }),
              )
              await fetch(`${API_BASE}/view/catrender/result`, {
                method: `POST`,
                headers: { 'Content-Type': `application/json` },
                body: JSON.stringify({
                  request_id: item.request_id,
                  svg: out,
                  format: item.format,
                }),
              })
            }
          }
        } catch (e) {
          console.debug(`[catrender] poll error`, e)
        }
        await new Promise((res) => setTimeout(res, 2000))
      }
    })()
    return () => {
      stopped = true
    }
  })

  function download(name: string, blob: Blob) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement(`a`)
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  function export_svg() {
    download(`catrender.svg`, new Blob([svg], { type: `image/svg+xml` }))
  }

  // TODO(followup): export_png hardcodes 1200x1200, ignores viewBox aspect
  async function export_png() {
    const img = new Image()
    img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`
    await img.decode()
    const c = document.createElement(`canvas`)
    c.width = 1200
    c.height = 1200
    const ctx = c.getContext(`2d`)!
    ctx.drawImage(img, 0, 0, 1200, 1200)
    c.toBlob((b) => b && download(`catrender.png`, b), `image/png`)
  }
</script>

<div class="catrender-pane">
  <div class="controls">
    <label>Preset
      <select bind:value={preset}>
        {#each PRESETS as p}<option value={p}>{p}</option>{/each}
      </select>
    </label>
    <label><input type="checkbox" bind:checked={show_h} /> H</label>
    <label><input type="checkbox" bind:checked={show_cell} /> Cell</label>
    <button onclick={reset_view} title="clear drag-rotate (back to pure PCA)">
      Reset view
    </button>
    <button onclick={reset_to_preset} title="clear all knob overrides">
      Reset to preset
    </button>
    <button onclick={export_svg}>Export SVG</button>
    <button onclick={export_png}>Export PNG</button>
  </div>

  <details class="panel" open>
    <summary>Knobs (override preset live — unchecked = inherit)</summary>
    <div class="knobs">
      <label class:active={k_atom_scale.on}>
        <input type="checkbox" bind:checked={k_atom_scale.on} /> atom_scale
        <input type="range" min="0" max="8" step="0.05"
          bind:value={k_atom_scale.v}
          oninput={() => (k_atom_scale.on = true)} />
        <span>{k_atom_scale.v}</span>
      </label>
      <label class:active={k_bond_width.on}>
        <input type="checkbox" bind:checked={k_bond_width.on} /> bond_width
        <input type="range" min="0" max="60" step="1"
          bind:value={k_bond_width.v}
          oninput={() => (k_bond_width.on = true)} />
        <span>{k_bond_width.v}</span>
      </label>
      <label class:active={k_atom_stroke_width.on}>
        <input type="checkbox" bind:checked={k_atom_stroke_width.on} />
        atom_stroke_width
        <input type="range" min="0" max="20" step="0.5"
          bind:value={k_atom_stroke_width.v}
          oninput={() => (k_atom_stroke_width.on = true)} />
        <span>{k_atom_stroke_width.v}</span>
      </label>
      <label class:active={k_hue.on}>
        <input type="checkbox" bind:checked={k_hue.on} /> hue_shift
        <input type="range" min="0" max="1" step="0.01" bind:value={k_hue.v}
          oninput={() => (k_hue.on = true)} />
        <span>{k_hue.v}</span>
      </label>
      <label class:active={k_light.on}>
        <input type="checkbox" bind:checked={k_light.on} /> light_shift
        <input type="range" min="0" max="1" step="0.01"
          bind:value={k_light.v} oninput={() => (k_light.on = true)} />
        <span>{k_light.v}</span>
      </label>
      <label class:active={k_sat.on}>
        <input type="checkbox" bind:checked={k_sat.on} /> sat_shift
        <input type="range" min="0" max="1" step="0.01" bind:value={k_sat.v}
          oninput={() => (k_sat.on = true)} />
        <span>{k_sat.v}</span>
      </label>
      <label class:active={k_fog_strength.on}>
        <input type="checkbox" bind:checked={k_fog_strength.on} />
        fog_strength
        <input type="range" min="0" max="3" step="0.05"
          bind:value={k_fog_strength.v}
          oninput={() => (k_fog_strength.on = true)} />
        <span>{k_fog_strength.v}</span>
      </label>
      <label class:active={k_label_font_size.on}>
        <input type="checkbox" bind:checked={k_label_font_size.on} />
        label_font_size
        <input type="number" min="0" max="120" step="1"
          bind:value={k_label_font_size.v}
          oninput={() => (k_label_font_size.on = true)} />
      </label>
      <label class:active={k_gradient.on}>
        <input type="checkbox" bind:checked={k_gradient.on} />
        gradient
        <input type="checkbox" bind:checked={k_gradient.v}
          onchange={() => (k_gradient.on = true)} />
      </label>
      <label class:active={k_fog.on}>
        <input type="checkbox" bind:checked={k_fog.on} /> fog
        <input type="checkbox" bind:checked={k_fog.v}
          onchange={() => (k_fog.on = true)} />
      </label>
      <label class:active={k_bond_orders.on}>
        <input type="checkbox" bind:checked={k_bond_orders.on} />
        bond_orders
        <input type="checkbox" bind:checked={k_bond_orders.v}
          onchange={() => (k_bond_orders.on = true)} />
      </label>
      <label class:active={k_bond_color_by_element.on}>
        <input type="checkbox" bind:checked={k_bond_color_by_element.on} />
        bond_color_by_element
        <input type="checkbox" bind:checked={k_bond_color_by_element.v}
          onchange={() => (k_bond_color_by_element.on = true)} />
      </label>
      <label class:active={k_bond_gradient.on}>
        <input type="checkbox" bind:checked={k_bond_gradient.on} />
        bond_gradient
        <input type="checkbox" bind:checked={k_bond_gradient.v}
          onchange={() => (k_bond_gradient.on = true)} />
      </label>
      <label class:active={k_atoms_above_bonds.on}>
        <input type="checkbox" bind:checked={k_atoms_above_bonds.on} />
        atoms_above_bonds
        <input type="checkbox" bind:checked={k_atoms_above_bonds.v}
          onchange={() => (k_atoms_above_bonds.on = true)} />
      </label>
      <label class:active={k_bond_color.on}>
        <input type="checkbox" bind:checked={k_bond_color.on} /> bond_color
        <input type="color" bind:value={k_bond_color.v}
          oninput={() => (k_bond_color.on = true)} />
      </label>
      <label class:active={k_background.on}>
        <input type="checkbox" bind:checked={k_background.on} /> background
        <input type="color" bind:value={k_background.v}
          oninput={() => (k_background.on = true)} />
      </label>
      <label class:active={k_cell_color.on}>
        <input type="checkbox" bind:checked={k_cell_color.on} /> cell_color
        <input type="color" bind:value={k_cell_color.v}
          oninput={() => (k_cell_color.on = true)} />
      </label>
    </div>
    <label class="advanced">
      Advanced overrides (raw JSON — ANY default.json knob):
      <textarea
        rows="3"
        placeholder={'{ "vdw_opacity": 0.4, "label_color": "#333" }'}
        bind:value={advanced_json}></textarea>
    </label>
    {#if overrides.err}<p class="err">{overrides.err}</p>{/if}
  </details>

  <details class="panel">
    <summary>Bond edit (render-only)</summary>
    <div class="edit-row">
      <label>i <input type="number" min="0" bind:value={be_i} /></label>
      <label>j <input type="number" min="0" bind:value={be_j} /></label>
      <label>order
        <input type="number" min="0" step="0.5" bind:value={be_order} />
      </label>
      <button onclick={bond_add}>Add</button>
      <button onclick={bond_remove}>Remove</button>
      <button onclick={bond_setorder}>Set order</button>
      <button onclick={bond_clear}>Clear ({bond_overrides.length})</button>
    </div>
  </details>

  <details class="panel">
    <summary>Atom edit (render-only — no write-back)</summary>
    <div class="edit-row">
      <label>atom
        <select bind:value={selected_atom}>
          <option value={null}>— select —</option>
          {#each (mirror?.atoms ?? []) as a, idx}
            <option value={idx}>{idx}: {a.el}</option>
          {/each}
        </select>
      </label>
      <span class="hint">or click an atom in the preview</span>
      <button
        disabled={selected_atom === null}
        onclick={() => selected_atom !== null && atom_hide(selected_atom)}>
        Hide / delete
      </button>
      <input type="color" bind:value={recolor_hex} />
      <button
        disabled={selected_atom === null}
        onclick={() => selected_atom !== null && atom_recolor(selected_atom)}>
        Recolor
      </button>
      <button onclick={atom_clear}>Clear ({atom_overrides.length})</button>
    </div>
  </details>

  {#if render_err}<p class="err">{render_err}</p>{/if}

  <div class="preview-wrap">
    <!-- Pointer-driven 3D manipulation surface (drag-rotate + click-pick);
         keyboard equivalents are the index <select> + numeric edit rows. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="preview"
      bind:this={preview_el}
      role="application"
      onpointerdown={on_pointer_down}
      onpointermove={on_pointer_move}
      onpointerup={on_pointer_up}
      onpointerleave={on_pointer_up}
      onclick={on_preview_click}
      style:cursor={dragging ? `grabbing` : `grab`}>
      {@html svg}
    </div>
    <!-- xyz axis gizmo: corner triad from the core (PCA·drag) basis -->
    <svg class="gizmo" viewBox="-1.2 -1.2 2.4 2.4" width="64" height="64">
      {#each gizmo as ax, i}
        <line
          x1="0" y1="0"
          x2={ax.x} y2={ax.y}
          stroke={AXIS_COLORS[i]} stroke-width="0.12"
          stroke-linecap="round" />
        <text
          x={ax.x * 1.15} y={ax.y * 1.15}
          font-size="0.42" fill={AXIS_COLORS[i]}
          text-anchor="middle" dominant-baseline="middle">
          {[`x`, `y`, `z`][i]}
        </text>
      {/each}
    </svg>
  </div>
</div>

<style>
  .catrender-pane { display: flex; flex-direction: column; gap: 8px; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .panel { border: 1px solid #ddd; border-radius: 6px; padding: 4px 8px; }
  .panel summary { cursor: pointer; font-weight: 600; font-size: 13px; }
  .knobs {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 4px 14px;
    max-height: 240px;
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
  .advanced { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
  .advanced textarea { font-family: monospace; font-size: 12px; }
  .edit-row {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    font-size: 12px; padding: 6px 0;
  }
  .edit-row input[type='number'] { width: 70px; }
  .hint { color: #888; font-style: italic; }
  .preview-wrap { position: relative; flex: 1; min-height: 320px; }
  .preview {
    flex: 1; min-height: 320px; display: grid; place-items: center;
    touch-action: none; user-select: none;
  }
  .preview :global(svg) { max-width: 100%; max-height: 70vh; }
  .gizmo {
    position: absolute; right: 8px; bottom: 8px;
    background: rgba(255, 255, 255, 0.7); border-radius: 6px;
    pointer-events: none;
  }
  .err { color: #c00; font-size: 13px; }
</style>
