<script lang="ts">
  import type { AnyStructure } from '$lib'
  import { compute_bonds_sync } from '$lib/structure/workers/bond-worker-api'
  import { render_svg } from './catrender-wasm'
  import {
    merge_bonds, prune_overrides,
    type Bond, type BondOverride,
  } from './bond-merge'

  let { structure = undefined as AnyStructure | undefined } = $props()

  const PRESETS = [
    `default`, `flat`, `paton`, `skeletal`, `bubble`, `tube`, `wire`, `graph`,
  ] as const

  let preset = $state<(typeof PRESETS)[number]>(`default`)
  let show_h = $state(true)
  let rot_x = $state(0)
  let rot_y = $state(0)
  let rot_z = $state(0)
  let show_cell = $state(false)
  let overrides = $state<BondOverride[]>([])

  let svg = $state(`<svg/>`)
  let render_err = $state(``)

  const mirror = $derived.by(() => {
    if (!structure || !(`sites` in structure)) return null
    const atoms = structure.sites.map((s) => ({
      el: s.species?.[0]?.element ?? s.label ?? `X`,
      xyz: s.xyz as [number, number, number],
    }))
    // compute_bond_connectivity is void + store-driven (needs bond_state,
    // setters, strategies). The real return-value path is
    // compute_bonds_sync(structure, strategy, options) -> BondPair[] | null
    // with site_idx_1 / site_idx_2 endpoints. null = WASM not ready / too
    // big; treat as no bonds.
    const pairs = compute_bonds_sync(
      structure as AnyStructure,
      `electroneg_ratio`,
      {},
    ) ?? []
    const base: Bond[] = pairs.map((p) => ({
      i: p.site_idx_1, j: p.site_idx_2, order: 1,
    }))
    const lattice =
      (`lattice` in structure ? structure.lattice?.matrix : null) ?? null
    return { atoms, base, lattice, n: atoms.length }
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  let render_seq = 0
  // NOTE: Svelte 5 tracks only synchronous reads in the effect *body*.
  // Reads inside the setTimeout callback are NOT tracked — the `void [...]`
  // line below is the dependency manifest and MUST list every reactive
  // value the render depends on. Add new controls there too.
  $effect(() => {
    const m = mirror
    void [preset, show_h, rot_x, rot_y, rot_z, show_cell, overrides, m]
    if (!m) return
    clearTimeout(timer)
    let cancelled = false
    const seq = ++render_seq
    timer = setTimeout(async () => {
      const pruned = prune_overrides($state.snapshot(overrides), m.n)
      const bonds = merge_bonds(m.base, pruned)
      const input = JSON.stringify({
        atoms: m.atoms,
        bonds,
        lattice: m.lattice,
        style: {
          preset, show_h,
          rotation: [rot_x, rot_y, rot_z],
          cell: { show: show_cell, supercell: [1, 1, 1], pbc_wrap: false },
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
    <label>Rx <input type="range" min="0" max="360" bind:value={rot_x} /></label>
    <label>Ry <input type="range" min="0" max="360" bind:value={rot_y} /></label>
    <label>Rz <input type="range" min="0" max="360" bind:value={rot_z} /></label>
    <button onclick={export_svg}>Export SVG</button>
    <button onclick={export_png}>Export PNG</button>
  </div>
  {#if render_err}<p class="err">{render_err}</p>{/if}
  <div class="preview">{@html svg}</div>
</div>

<style>
  .catrender-pane { display: flex; flex-direction: column; gap: 8px; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .preview { flex: 1; min-height: 320px; display: grid; place-items: center; }
  .preview :global(svg) { max-width: 100%; max-height: 70vh; }
  .err { color: #c00; font-size: 13px; }
</style>
