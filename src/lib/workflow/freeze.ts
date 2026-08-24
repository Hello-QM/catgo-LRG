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
/**
 * Resolve the bottom-layer count across current and legacy parameter names.
 *
 * Workflow definitions inject `frozen_layers: 0` before recipe parameters are
 * merged. Older recipes use `freeze_n_layers: 2`, so nullish coalescing would
 * incorrectly stop at the injected zero and erase the upstream constraints in
 * the preview. Match the backend engine: use the first positive layer count.
 */
export function frozen_layer_count(params: Record<string, unknown>): number {
  for (const key of [`frozen_layers`, `freeze_layers`, `freeze_n_layers`]) {
    const value = Number(params[key])
    if (Number.isFinite(value) && value > 0) return Math.floor(value)
  }
  return 0
}

/** Convert legacy freeze aliases to the canonical parameter for each node. */
export function normalize_freeze_params(
  node_type: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (node_type !== `geo_opt` && node_type !== `freq`) return params

  const normalized = { ...params }
  const layers = frozen_layer_count(normalized)
  if (node_type === `geo_opt`) {
    normalized.frozen_layers = layers
    delete normalized.freeze_layers
  } else {
    normalized.freeze_layers = layers
    delete normalized.frozen_layers
  }
  delete normalized.freeze_n_layers
  return normalized
}

export function apply_freeze_to_structure(struct_json: string | null, params: Record<string, unknown>): string | null {
  if (!struct_json) return null
  // Tolerate every spelling: explicit freeze_mode, or a bare frozen_layers /
  // freeze_layers / freeze_n_layers (the geo_opt/slab convention) which implies
  // bottom-layer freezing. Mirrors the backend's _freeze_n_bottom_layers.
  const n_bottom = frozen_layer_count(params)
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
    } else if (mode === `adsorbate`) {
      // Surface-frequency methodology: fix the whole slab, free only the
      // adsorbate. Adsorbate atoms carry properties.is_adsorbate=true (set by
      // adsorbate_place). If nothing is tagged, freeze nothing (mirror backend).
      const any_tag = struct.sites.some((s: any) => s.properties?.is_adsorbate === true)
      if (any_tag) {
        for (let i = 0; i < n; i++) {
          if (struct.sites[i].properties?.is_adsorbate !== true) frozen.add(i)
        }
      }
    } else if (mode === `layers` || mode === `bottom`) {
      const n_layers = n_bottom
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

/** Return fully frozen atom indices from pymatgen selective_dynamics flags. */
export function frozen_indices_from_structure(struct_json: string | null): number[] {
  if (!struct_json) return []
  try {
    const struct = JSON.parse(struct_json)
    if (!Array.isArray(struct?.sites)) return []
    const frozen: number[] = []
    for (let i = 0; i < struct.sites.length; i++) {
      const sd = struct.sites[i]?.properties?.selective_dynamics
      if (Array.isArray(sd) && sd.length >= 3 && sd.every((v: unknown) => v === false)) {
        frozen.push(i)
      }
    }
    return frozen
  } catch {
    return []
  }
}

/** Stamp a manual frozen-index selection onto a structure for live preview. */
export function apply_manual_frozen_indices(
  struct_json: string | null,
  indices: Iterable<number>,
): string | null {
  if (!struct_json) return null
  try {
    const struct = JSON.parse(struct_json)
    if (!Array.isArray(struct?.sites)) return struct_json
    const frozen = new Set(indices)
    for (let i = 0; i < struct.sites.length; i++) {
      const free = !frozen.has(i)
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
