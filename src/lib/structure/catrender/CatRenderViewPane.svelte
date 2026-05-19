<script lang="ts">
  // RT13: VIEW pane — the second independent DraggablePane. Owns the live
  // SVG preview, xyz gizmo, drag-rotate (via the FIX-1 `use:` direct-listener
  // action), bond/atom edit (with per-row direct delete), Export, AI-bridge
  // poll. Reads params from the shared `catrender_state` module — it does NOT
  // own preset/knob state. Render-only: reads the `structure` prop, never
  // writes back to the main viewer.
  import { onMount } from 'svelte'
  import type { AnyStructure } from '$lib'
  import { DraggablePane } from '$lib'
  import { DEFAULTS } from '$lib/settings'
  import type { BondingStrategy } from '$lib/structure/bonding'
  import { compute_bonds_sync } from '$lib/structure/workers/bond-worker-api'
  import { render_svg } from './catrender-wasm'
  import { merge_bonds, prune_overrides, type Bond } from './bond-merge'
  import { merge_atoms, prune_atom_overrides } from './atom-merge'
  import { catrender_state as S, AXIS_COLORS } from './catrender-state.svelte'
  import { drag_rotate, type DragRotateHandlers } from './drag-rotate-action'

  let {
    show = $bindable(false),
    structure = undefined as AnyStructure | undefined,
  } = $props()

  // --- Bond-edit override layer (existing bond-merge plumbing) ------------
  let be_i = $state(0)
  let be_j = $state(1)
  let be_order = $state(1)
  function bond_add() {
    S.bond_overrides = [
      ...S.bond_overrides, { op: `add`, i: be_i, j: be_j, order: be_order },
    ]
  }
  function bond_setorder() {
    S.bond_overrides = [
      ...S.bond_overrides,
      { op: `setorder`, i: be_i, j: be_j, order: be_order },
    ]
  }
  // RT13 #3: per-row DIRECT delete (user: "不能直接删 bond"). Removing a base
  // bond emits a `remove` override; removing an override row splices it out.
  function bond_remove_pair(i: number, j: number) {
    S.bond_overrides = [...S.bond_overrides, { op: `remove`, i, j }]
  }
  function bond_override_del(idx: number) {
    S.bond_overrides = S.bond_overrides.filter((_, k) => k !== idx)
  }
  function bond_clear() {
    S.bond_overrides = []
  }

  // --- Atom-edit override layer (atom-merge; render-only, NO write-back) --
  let selected_atom = $state<number | null>(null)
  let recolor_hex = $state(`#ff0000`)
  function atom_hide(idx: number) {
    S.atom_overrides = [...S.atom_overrides, { op: `hide`, idx }]
  }
  function atom_recolor(idx: number) {
    S.atom_overrides = [
      ...S.atom_overrides, { op: `recolor`, idx, hex: recolor_hex },
    ]
  }
  // RT13 #3: per-row DIRECT delete for the atom override list too.
  function atom_override_del(idx: number) {
    S.atom_overrides = S.atom_overrides.filter((_, k) => k !== idx)
  }
  function atom_clear() {
    S.atom_overrides = []
  }

  // --- Drag-rotate overlay (extra rotation applied AFTER PCA by core) -----
  // Accumulated intrinsic XYZ euler deltas (degrees) → style.drag_rotation.
  let dragging = $state(false)
  let last_xy: [number, number] | null = null
  function on_pointer_down(e: PointerEvent) {
    dragging = true
    last_xy = [e.clientX, e.clientY]
  }
  function on_pointer_move(e: PointerEvent) {
    if (!dragging || !last_xy) return
    const dx = e.clientX - last_xy[0]
    const dy = e.clientY - last_xy[1]
    last_xy = [e.clientX, e.clientY]
    // horizontal drag → yaw (Y), vertical drag → pitch (X). 0.5°/px.
    S.drag_rot = [
      (S.drag_rot[0] + dy * 0.5) % 360,
      (S.drag_rot[1] + dx * 0.5) % 360,
      S.drag_rot[2],
    ]
  }
  function on_pointer_up() {
    dragging = false
    last_xy = null
  }
  // The `use:` action drives these directly on the .preview node so the
  // pointer events fire BEFORE the ancestor DraggablePane stopPropagation.
  const drag_handlers: DragRotateHandlers = {
    down: on_pointer_down,
    move: on_pointer_move,
    up: on_pointer_up,
    pick: (e) => { if (!dragging) pick_atom(e) },
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

  // Local derived mirror; ALSO published into shared state so the AI-bridge
  // poll + render effect read one render-only snapshot (single source).
  const mirror = $derived.by(() => {
    if (!structure || !(`sites` in structure)) return null
    const atoms = structure.sites.map((s) => ({
      el: s.species?.[0]?.element ?? s.label ?? `X`,
      xyz: s.xyz as [number, number, number],
    }))
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
  $effect(() => { S.mirror = mirror })

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
    // visible→original map via merge_atoms so a hidden atom present does NOT
    // shift the click to the wrong ORIGINAL atom.
    const m = mirror
    if (!m) return
    const a_ov = prune_atom_overrides($state.snapshot(S.atom_overrides), m.n)
    const { hidden } = merge_atoms(m.n, a_ov)
    const visible_idx: number[] = []
    for (let i = 0; i < m.n; i++) if (!hidden.has(i)) visible_idx.push(i)
    selected_atom = best < visible_idx.length ? visible_idx[best] : best
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
      S.preset, S.show_h, S.show_cell, S.overrides, S.bond_overrides,
      S.atom_overrides, S.drag_rot, m,
    ]
    if (!m) return
    clearTimeout(timer)
    let cancelled = false
    const seq = ++render_seq
    timer = setTimeout(async () => {
      const pruned = prune_overrides($state.snapshot(S.bond_overrides), m.n)
      const bonds = merge_bonds(m.base, pruned)
      const a_ov = prune_atom_overrides($state.snapshot(S.atom_overrides), m.n)
      const ov = $state.snapshot(S.overrides.map) as Record<string, unknown>
      const input = JSON.stringify({
        atoms: m.atoms,
        bonds,
        lattice: m.lattice,
        atom_overrides: a_ov,
        style: {
          preset: S.preset, show_h: S.show_h,
          drag_rotation: S.drag_rot,
          cell: { show: S.show_cell, supercell: [1, 1, 1], pbc_wrap: false },
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
                $state.snapshot(S.bond_overrides), m.n,
              )
              const bonds = merge_bonds(m.base, pruned)
              const a_ov = prune_atom_overrides(
                $state.snapshot(S.atom_overrides), m.n,
              )
              const ov = { ...S.overrides.map }
              const out = await render_svg(
                JSON.stringify({
                  atoms: m.atoms,
                  bonds,
                  lattice: m.lattice,
                  atom_overrides: a_ov,
                  style: {
                    preset: S.preset,
                    show_h: S.show_h,
                    drag_rotation: S.drag_rot,
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

  // Visible base bonds (after current overrides) for the per-row delete list.
  const live_bonds = $derived.by(() => {
    const m = mirror
    if (!m) return [] as Bond[]
    const pruned = prune_overrides($state.snapshot(S.bond_overrides), m.n)
    return merge_bonds(m.base, pruned)
  })
</script>

<DraggablePane
  bind:show
  show_toggle={false}
  close_on_click_outside={false}
  max_width="none"
  pane_props={{ class: `catrender-view-pane` }}
>
  <h4 class="pane-title">Render — View</h4>

  <div class="controls">
    <button onclick={() => S.reset_view()}
      title="clear drag-rotate (back to pure PCA)">Reset view</button>
    <button onclick={export_svg}>Export SVG</button>
    <button onclick={export_png}>Export PNG</button>
  </div>

  <details class="panel">
    <summary>Bond edit (render-only — per-row delete)</summary>
    <div class="edit-row">
      <label>i <input type="number" min="0" bind:value={be_i} /></label>
      <label>j <input type="number" min="0" bind:value={be_j} /></label>
      <label>order
        <input type="number" min="0" step="0.5" bind:value={be_order} />
      </label>
      <button onclick={bond_add}>Add</button>
      <button onclick={bond_setorder}>Set order</button>
      <button onclick={bond_clear}>Clear ({S.bond_overrides.length})</button>
    </div>
    <ul class="row-list">
      {#each live_bonds as b}
        <li>
          <span>{b.i}–{b.j} (×{b.order})</span>
          <button class="del" title="delete this bond"
            onclick={() => bond_remove_pair(b.i, b.j)}>×</button>
        </li>
      {/each}
    </ul>
    {#if S.bond_overrides.length}
      <div class="ov-head">overrides</div>
      <ul class="row-list">
        {#each S.bond_overrides as ov, idx}
          <li>
            <span>{ov.op} {ov.i}–{ov.j}{'order' in ov ? ` ×${ov.order}` : ``}</span>
            <button class="del" title="remove this override"
              onclick={() => bond_override_del(idx)}>×</button>
          </li>
        {/each}
      </ul>
    {/if}
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
      <button onclick={atom_clear}>Clear ({S.atom_overrides.length})</button>
    </div>
    {#if S.atom_overrides.length}
      <ul class="row-list">
        {#each S.atom_overrides as ov, idx}
          <li>
            <span>
              {ov.op} atom {ov.idx}{ov.op === `recolor` ? ` → ${ov.hex}` : ``}
            </span>
            <button class="del" title="remove this override"
              onclick={() => atom_override_del(idx)}>×</button>
          </li>
        {/each}
      </ul>
    {/if}
  </details>

  {#if render_err}<p class="err">{render_err}</p>{/if}

  <div class="preview-wrap">
    <!-- Pointer-driven 3D manipulation surface (drag-rotate + click-pick).
         The `use:drag_rotate` action attaches DIRECT listeners on this node
         so they fire BEFORE the ancestor DraggablePane stopPropagation —
         this is the RT13 root-cause fix; keyboard equivalents are the index
         <select> + numeric edit rows. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="preview"
      bind:this={preview_el}
      role="application"
      use:drag_rotate={() => drag_handlers}
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
</DraggablePane>

<style>
  .pane-title { margin: 0 0 6px; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .panel { border: 1px solid #ddd; border-radius: 6px; padding: 4px 8px;
    margin-top: 8px; }
  .panel summary { cursor: pointer; font-weight: 600; font-size: 13px; }
  .edit-row {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    font-size: 12px; padding: 6px 0;
  }
  .edit-row input[type='number'] { width: 70px; }
  .hint { color: #888; font-style: italic; }
  .row-list {
    list-style: none; margin: 4px 0 0; padding: 0;
    max-height: 140px; overflow-y: auto; font-size: 12px;
  }
  .row-list li {
    display: flex; justify-content: space-between; align-items: center;
    gap: 8px; padding: 2px 4px; border-bottom: 1px solid #eee;
  }
  .row-list .del {
    color: #c00; font-weight: 700; border: none; background: none;
    cursor: pointer; padding: 0 6px; line-height: 1;
  }
  .ov-head { font-size: 11px; color: #888; margin-top: 4px; }
  .preview-wrap { position: relative; flex: 1; min-height: 360px; }
  .preview {
    flex: 1; min-height: 360px; display: grid; place-items: center;
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
