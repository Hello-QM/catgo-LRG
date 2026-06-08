/**
 * Apply freeze params to a structure JSON, writing pymatgen-style
 * `selective_dynamics` onto every site so that the fixity flows through the
 * frontend workflow pipeline (issue #222).
 *
 * Site-property shape mirrors the backend:
 *   site.properties.selective_dynamics = [boolean, boolean, boolean]
 *   true = free   → [true, true, true]
 *   frozen        → [false, false, false]
 *
 * Pure function — no Svelte / DOM deps. Extracted verbatim from
 * WorkflowEditor.svelte so the same logic can be unit-tested and reused at
 * slab-generation time (SlabGenPreview) as well as in the run-time overlay.
 */
export function apply_freeze_to_structure(struct_json: string | null, params: Record<string, unknown>): string | null {
  if (!struct_json) return null
  // Tolerate every spelling: explicit freeze_mode, or a bare frozen_layers /
  // freeze_layers / freeze_n_layers (the geo_opt/slab convention) which implies
  // bottom-layer freezing. Mirrors the backend's _freeze_n_bottom_layers.
  const n_bottom = Number(params.frozen_layers ?? params.freeze_layers ?? params.freeze_n_layers ?? 0)
  let mode = params.freeze_mode as string
  if ((!mode || mode === `none`) && n_bottom > 0) mode = `layers`
  if (!mode || mode === `none`) return struct_json

  try {
    const struct = JSON.parse(struct_json)
    if (!struct.sites?.length) return struct_json
    const n = struct.sites.length
    const frozen = new Set<number>()

    if (mode === `z_range`) {
      const z_lo = Number(params.freeze_z_below ?? 0)
      for (let i = 0; i < n; i++) {
        const z = struct.sites[i].xyz?.[2] ?? 0
        if (z < z_lo) frozen.add(i)
      }
    } else if (mode === `element`) {
      const elems = new Set(String(params.freeze_elements ?? ``).split(`,`).map(s => s.trim()).filter(Boolean))
      for (let i = 0; i < n; i++) {
        const el = struct.sites[i].species?.[0]?.element ?? struct.sites[i].label ?? ``
        if (elems.has(el)) frozen.add(i)
      }
    } else if (mode === `indices` || mode === `manual`) {
      for (const part of String(params.freeze_indices ?? ``).split(`,`)) {
        const t = part.trim()
        if (!t) continue
        if (t.includes(`-`)) {
          const [a, b] = t.split(`-`).map(Number)
          for (let i = a; i <= b; i++) frozen.add(i)
        } else {
          const v = parseInt(t)
          if (!isNaN(v)) frozen.add(v)
        }
      }
    } else if (mode === `layers` || mode === `bottom`) {
      const n_layers = n_bottom > 0 ? n_bottom : Number(params.freeze_layers ?? 0)
      if (n_layers > 0) {
        const zs = ([...new Set(struct.sites.map((s: any) => Math.round((s.xyz?.[2] ?? 0) * 100) / 100))] as number[]).sort((a, b) => a - b)
        const threshold = n_layers < zs.length ? (zs[n_layers - 1] + zs[n_layers]) / 2 : zs[zs.length - 1] + 0.1
        for (let i = 0; i < n; i++) {
          if ((struct.sites[i].xyz?.[2] ?? 0) < threshold) frozen.add(i)
        }
      }
    }

    // Apply invert
    let final_frozen = frozen
    if (params.freeze_invert && mode !== `none`) {
      final_frozen = new Set(Array.from({ length: n }, (_, i) => i).filter(i => !frozen.has(i)))
    }

    // Set selective_dynamics on sites
    for (let i = 0; i < n; i++) {
      const free = !final_frozen.has(i)
      struct.sites[i].properties = {
        ...(struct.sites[i].properties ?? {}),
        selective_dynamics: [free, free, free],
      }
    }
    return JSON.stringify(struct)
  } catch {
    return struct_json
  }
}
