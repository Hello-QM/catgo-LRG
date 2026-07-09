import { describe, expect, test } from 'vitest'
import type { Vec3 } from '$lib/math'
import type { ElementSymbol } from '$lib'
import type { BondPair, PymatgenStructure, PymatgenLattice, Site } from '$lib/structure'
import type { ShowBonds } from '$lib/settings'

// --- visibility.ts ---
import {
  should_show_bonds,
  filter_bonds_during_drag,
  filter_bond_pairs,
  build_cutting_visibility_map,
  compute_atom_span_radius,
  compute_show_bulk_atoms,
  get_lattice,
  compute_structure_size,
  get_frozen_info,
} from '$lib/structure/scene/visibility'

// --- picking.ts ---
import {
  toggle_site_selection,
  clean_measured_sites,
  is_atom_pickable,
  build_highlight_entries,
} from '$lib/structure/scene/picking'

// --- render-data.ts ---
import {
  desaturate_color,
  get_element_fingerprint,
  get_position_hash,
  get_structure_fingerprint,
  compute_force_data,
  compute_magmom_data,
  get_majority_element,
  get_majority_color,
} from '$lib/structure/scene/render-data'

// ── helpers ──

function make_site(xyz: Vec3, element = `C`, props: Record<string, unknown> = {}): Site {
  return {
    xyz,
    abc: [0, 0, 0],
    species: [{ element: element as ElementSymbol, occu: 1, oxidation_state: 0 }],
    label: element,
    properties: props,
  }
}

function make_lattice(a = 5, b = 5, c = 5): PymatgenLattice {
  return {
    matrix: [
      [a, 0, 0],
      [0, b, 0],
      [0, 0, c],
    ],
    pbc: [true, true, true],
    volume: a * b * c,
    a,
    b,
    c,
    alpha: 90,
    beta: 90,
    gamma: 90,
  }
}

function make_bond_pair(
  idx1: number,
  idx2: number,
  length = 2.0,
): BondPair {
  return {
    pos_1: [0, 0, 0],
    pos_2: [1, 0, 0],
    site_idx_1: idx1,
    site_idx_2: idx2,
    bond_length: length,
    strength: 1,
    transform_matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  }
}

// ════════════════════════════════════════════════════
//  visibility.ts
// ════════════════════════════════════════════════════

describe(`should_show_bonds`, () => {
  const lattice = make_lattice()

  test(`always → true regardless of lattice`, () => {
    expect(should_show_bonds(`always`, lattice)).toBe(true)
    expect(should_show_bonds(`always`, null)).toBe(true)
  })

  test(`never → false regardless of lattice`, () => {
    expect(should_show_bonds(`never`, lattice)).toBe(false)
    expect(should_show_bonds(`never`, null)).toBe(false)
  })

  test(`crystals → true only when lattice present`, () => {
    expect(should_show_bonds(`crystals`, lattice)).toBe(true)
    expect(should_show_bonds(`crystals`, null)).toBe(false)
  })

  test(`molecules → true only when no lattice`, () => {
    expect(should_show_bonds(`molecules`, null)).toBe(true)
    expect(should_show_bonds(`molecules`, lattice)).toBe(false)
  })
})

describe(`filter_bonds_during_drag`, () => {
  const bonds = [
    { site_idx_1: 0, site_idx_2: 1 },
    { site_idx_1: 0, site_idx_2: 2 },
    { site_idx_1: 1, site_idx_2: 2 },
  ]

  test(`keeps bonds where both atoms selected`, () => {
    const result = filter_bonds_during_drag(bonds, [0, 1, 2])
    expect(result).toHaveLength(3)
  })

  test(`keeps bonds where neither atom selected`, () => {
    const result = filter_bonds_during_drag(bonds, [])
    expect(result).toHaveLength(3)
  })

  test(`removes cross-bonds`, () => {
    // select only atom 0 → bond 0-1 is cross, 0-2 is cross, 1-2 stays
    const result = filter_bonds_during_drag(bonds, [0])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ site_idx_1: 1, site_idx_2: 2 })
  })
})

describe(`filter_bond_pairs`, () => {
  const sites = [
    make_site([0, 0, 0], `Si`),
    make_site([1, 0, 0], `O`),
    make_site([2, 0, 0], `Si`),
  ]
  const get_bond_key = (a: number, b: number) => `${Math.min(a, b)}-${Math.max(a, b)}`

  const base_opts = {
    bond_struct_sites: sites,
    hidden_elements: new Set<ElementSymbol>(),
    hidden_sites: new Set<number>(),
    hidden_prop_vals: new Set<number | string>(),
    deleted_bond_keys: new Set<string>(),
    bond_distance_rules: [] as { element_1: string; element_2: string; min_dist: number; max_dist: number }[],
    property_colors: null,
    get_bond_key,
  }

  test(`passes valid bonds through`, () => {
    const bonds = [make_bond_pair(0, 1), make_bond_pair(1, 2)]
    const result = filter_bond_pairs({ ...base_opts, bond_pairs: bonds })
    expect(result).toHaveLength(2)
  })

  test(`filters bonds with invalid transform_matrix`, () => {
    const bad_bond = make_bond_pair(0, 1)
    bad_bond.transform_matrix = new Float32Array([NaN, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    const result = filter_bond_pairs({ ...base_opts, bond_pairs: [bad_bond] })
    expect(result).toHaveLength(0)
  })

  test(`filters deleted bonds`, () => {
    const bonds = [make_bond_pair(0, 1)]
    const result = filter_bond_pairs({
      ...base_opts,
      bond_pairs: bonds,
      deleted_bond_keys: new Set([`0-1`]),
    })
    expect(result).toHaveLength(0)
  })

  test(`filters bonds with hidden elements`, () => {
    const bonds = [make_bond_pair(0, 1)]
    const result = filter_bond_pairs({
      ...base_opts,
      bond_pairs: bonds,
      hidden_elements: new Set([`Si` as ElementSymbol]),
    })
    expect(result).toHaveLength(0)
  })

  test(`filters bonds with hidden sites`, () => {
    const bonds = [make_bond_pair(0, 1)]
    const result = filter_bond_pairs({
      ...base_opts,
      bond_pairs: bonds,
      hidden_sites: new Set([0]),
    })
    expect(result).toHaveLength(0)
  })

  test(`filters by element-pair distance rules`, () => {
    const bonds = [make_bond_pair(0, 1, 3.0)] // Si-O at 3.0 Å
    const result = filter_bond_pairs({
      ...base_opts,
      bond_pairs: bonds,
      bond_distance_rules: [{ element_1: `O`, element_2: `Si`, min_dist: 1.0, max_dist: 2.5 }],
    })
    expect(result).toHaveLength(0) // 3.0 > 2.5
  })

  test(`keeps bonds within distance rules`, () => {
    const bonds = [make_bond_pair(0, 1, 2.0)] // Si-O at 2.0 Å
    const result = filter_bond_pairs({
      ...base_opts,
      bond_pairs: bonds,
      bond_distance_rules: [{ element_1: `O`, element_2: `Si`, min_dist: 1.0, max_dist: 2.5 }],
    })
    expect(result).toHaveLength(1)
  })
})

describe(`build_cutting_visibility_map`, () => {
  test(`returns empty map when not active`, () => {
    const map = build_cutting_visibility_map(false, [
      { site_idx: 0, inside_slab: true, opacity: 1, saturation: 1 },
    ])
    expect(map.size).toBe(0)
  })

  test(`returns empty map when visibility array empty`, () => {
    const map = build_cutting_visibility_map(true, [])
    expect(map.size).toBe(0)
  })

  test(`populates map when active with entries`, () => {
    const map = build_cutting_visibility_map(true, [
      { site_idx: 0, inside_slab: true, opacity: 0.8, saturation: 0.5 },
      { site_idx: 3, inside_slab: false, opacity: 0.2, saturation: 0.1 },
    ])
    expect(map.size).toBe(2)
    expect(map.get(0)).toEqual({ inside: true, opacity: 0.8, saturation: 0.5 })
    expect(map.get(3)).toEqual({ inside: false, opacity: 0.2, saturation: 0.1 })
  })
})

describe(`compute_show_bulk_atoms`, () => {
  test(`true when show_atoms is true and not slab preview`, () => {
    expect(compute_show_bulk_atoms(true, false, `full`)).toBe(true)
    expect(compute_show_bulk_atoms(true, true, `full`)).toBe(true)
  })

  test(`false when show_atoms is false`, () => {
    expect(compute_show_bulk_atoms(false, false, `slab`)).toBe(false)
  })

  test(`false in slab preview mode when cutting active`, () => {
    expect(compute_show_bulk_atoms(true, true, `slab`)).toBe(false)
  })
})

describe(`get_lattice`, () => {
  test(`returns lattice from structure with lattice`, () => {
    const lattice = make_lattice()
    const structure: PymatgenStructure = { sites: [], lattice }
    expect(get_lattice(structure)).toBe(lattice)
  })

  test(`returns null for molecule (no lattice)`, () => {
    expect(get_lattice({ sites: [] })).toBeNull()
  })

  test(`returns null for undefined`, () => {
    expect(get_lattice(undefined)).toBeNull()
  })
})

describe(`compute_structure_size`, () => {
  test(`returns 10 for null lattice`, () => {
    expect(compute_structure_size(null)).toBe(10)
  })

  test(`computes from lattice parameters a, b, c`, () => {
    const lattice = make_lattice(4, 6, 8)
    expect(compute_structure_size(lattice)).toBe((4 + 6 + 8) / 2)
  })

  test(`computes from matrix when a/b/c undefined`, () => {
    const lattice = {
      matrix: [
        [3, 0, 0],
        [0, 4, 0],
        [0, 0, 5],
      ] as [Vec3, Vec3, Vec3],
      pbc: [true, true, true] as const,
      volume: 60,
    } as unknown as PymatgenLattice
    // a=undefined so falls through to matrix: (3+4+5)/2 = 6
    // But our make_lattice sets a/b/c. We need a lattice without a/b/c:
    delete (lattice as any).a
    delete (lattice as any).b
    delete (lattice as any).c
    expect(compute_structure_size(lattice)).toBe(6)
  })

  test(`returns 10 when lattice has no params or matrix`, () => {
    const lattice = { pbc: [true, true, true] } as unknown as PymatgenLattice
    expect(compute_structure_size(lattice)).toBe(10)
  })
})

describe(`compute_atom_span_radius`, () => {
  test(`returns null for undefined / empty structure`, () => {
    expect(compute_atom_span_radius(undefined)).toBeNull()
    expect(compute_atom_span_radius({ sites: [] } as unknown as PymatgenStructure))
      .toBeNull()
  })

  test(`half of the largest atom bbox axis, ignoring the lattice/vacuum box`, () => {
    // Molecule-like: atoms span 2 Å in x, 1 Å in y, 0 in z. Even if dropped in a
    // huge vacuum lattice, the span radius reflects the ATOMS, not the box.
    const sites = [
      make_site([0, 0, 0], `O`),
      make_site([2, 1, 0], `H`),
      make_site([1, 0, 0], `H`),
    ]
    const structure = { sites, lattice: make_lattice(20, 20, 20) } as
      unknown as PymatgenStructure
    // max axis span = x: 2 → radius 1
    expect(compute_atom_span_radius(structure)).toBeCloseTo(1)
  })

  test(`single atom → 0 span`, () => {
    const structure = { sites: [make_site([5, 5, 5])] } as unknown as PymatgenStructure
    expect(compute_atom_span_radius(structure)).toBe(0)
  })
})

describe(`get_frozen_info`, () => {
  test(`returns null when no selective_dynamics`, () => {
    const site = make_site([0, 0, 0])
    expect(get_frozen_info(site)).toBeNull()
  })

  test(`detects fully frozen`, () => {
    const site = make_site([0, 0, 0], `C`, {
      selective_dynamics: [false, false, false],
    })
    const info = get_frozen_info(site)
    expect(info).toEqual({
      is_fully_frozen: true,
      is_partially_frozen: false,
      frozen_axes: `x, y, z`,
    })
  })

  test(`detects partially frozen`, () => {
    const site = make_site([0, 0, 0], `C`, {
      selective_dynamics: [true, false, true],
    })
    const info = get_frozen_info(site)
    expect(info).toEqual({
      is_fully_frozen: false,
      is_partially_frozen: true,
      frozen_axes: `y`,
    })
  })

  test(`detects fully free (all true)`, () => {
    const site = make_site([0, 0, 0], `C`, {
      selective_dynamics: [true, true, true],
    })
    const info = get_frozen_info(site)
    expect(info).toEqual({
      is_fully_frozen: false,
      is_partially_frozen: false,
      frozen_axes: ``,
    })
  })
})

// ════════════════════════════════════════════════════
//  picking.ts
// ════════════════════════════════════════════════════

describe(`toggle_site_selection`, () => {
  test(`adds site when not already selected`, () => {
    expect(toggle_site_selection(3, [0, 1])).toEqual([0, 1, 3])
  })

  test(`removes site when already selected`, () => {
    expect(toggle_site_selection(1, [0, 1, 2])).toEqual([0, 2])
  })

  test(`returns null when limit reached`, () => {
    // MAX_SELECTED_SITES is 100
    const sites = Array.from({ length: 100 }, (_, i) => i)
    expect(toggle_site_selection(200, sites)).toBeNull()
  })

  test(`allows deselection even at limit`, () => {
    const sites = Array.from({ length: 100 }, (_, i) => i)
    const result = toggle_site_selection(50, sites)
    expect(result).not.toBeNull()
    expect(result).toHaveLength(99)
  })
})

describe(`clean_measured_sites`, () => {
  test(`removes out-of-bounds indices`, () => {
    expect(clean_measured_sites([0, 5, 10], 6)).toEqual([0, 5])
  })

  test(`removes negative indices`, () => {
    expect(clean_measured_sites([-1, 0, 2], 5)).toEqual([0, 2])
  })

  test(`returns empty for zero site_count`, () => {
    expect(clean_measured_sites([0, 1], 0)).toEqual([])
  })

  test(`keeps all valid indices`, () => {
    expect(clean_measured_sites([0, 1, 2], 10)).toEqual([0, 1, 2])
  })
})

describe(`is_atom_pickable`, () => {
  test(`returns true when cutting not active`, () => {
    expect(is_atom_pickable(0, false, new Map())).toBe(true)
  })

  test(`returns true when visibility map empty`, () => {
    expect(is_atom_pickable(0, true, new Map())).toBe(true)
  })

  test(`returns true when atom not in map`, () => {
    const map = new Map([[1, { inside: false, opacity: 0, saturation: 0 }]])
    expect(is_atom_pickable(0, true, map)).toBe(true)
  })

  test(`returns true when inside slab`, () => {
    const map = new Map([[0, { inside: true, opacity: 1, saturation: 1 }]])
    expect(is_atom_pickable(0, true, map)).toBe(true)
  })

  test(`returns false when outside slab`, () => {
    const map = new Map([[0, { inside: false, opacity: 0.2, saturation: 0.1 }]])
    expect(is_atom_pickable(0, true, map)).toBe(false)
  })
})

describe(`build_highlight_entries`, () => {
  const sites = [make_site([0, 0, 0], `Si`), make_site([1, 0, 0], `O`)]

  test(`creates entries for selected sites`, () => {
    const entries = build_highlight_entries([0], [], sites, 0.5, `#ff0000`, `#00ff00`)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      kind: `selected`,
      site: sites[0],
      site_idx: 0,
      opacity: 0.5,
      color: `#ff0000`,
    })
  })

  test(`creates entries for active sites`, () => {
    const entries = build_highlight_entries([], [1], sites, 0.8, `#ff0000`, `#00ff00`)
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe(`active`)
    expect(entries[0].color).toBe(`#00ff00`)
  })

  test(`combines selected and active`, () => {
    const entries = build_highlight_entries([0], [1], sites, 0.5, `#ff0000`, `#00ff00`)
    expect(entries).toHaveLength(2)
    expect(entries[0].kind).toBe(`selected`)
    expect(entries[1].kind).toBe(`active`)
  })

  test(`handles undefined structure_sites`, () => {
    const entries = build_highlight_entries([0], [], undefined, 0.5, `#ff0000`, `#00ff00`)
    expect(entries).toHaveLength(1)
    expect(entries[0].site).toBeNull()
  })
})

// ════════════════════════════════════════════════════
//  render-data.ts
// ════════════════════════════════════════════════════

describe(`desaturate_color`, () => {
  test(`factor 1 returns approximately original color`, () => {
    const result = desaturate_color(`#ff0000`, 1)
    expect(result).toBe(`#ff0000`)
  })

  test(`factor 0 returns grayscale`, () => {
    const result = desaturate_color(`#ff0000`, 0)
    // Pure red → grayscale: all channels should be equal
    const hex = result.replace(`#`, ``)
    const r = parseInt(hex.substring(0, 2), 16)
    const g = parseInt(hex.substring(2, 4), 16)
    const b = parseInt(hex.substring(4, 6), 16)
    expect(r).toBe(g)
    expect(g).toBe(b)
  })

  test(`handles white`, () => {
    expect(desaturate_color(`#ffffff`, 0.5)).toBe(`#ffffff`)
  })

  test(`handles black`, () => {
    expect(desaturate_color(`#000000`, 0.5)).toBe(`#000000`)
  })

  test(`returns valid hex format`, () => {
    const result = desaturate_color(`#3388cc`, 0.5)
    expect(result).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe(`get_element_fingerprint`, () => {
  test(`small list encodes all species`, () => {
    const sites = [make_site([0, 0, 0], `Si`), make_site([1, 0, 0], `O`)]
    expect(get_element_fingerprint(sites)).toBe(`Si;O`)
  })

  test(`multi-species site uses comma separator`, () => {
    const site: Site = {
      xyz: [0, 0, 0],
      abc: [0, 0, 0],
      species: [
        { element: `Fe` as ElementSymbol, occu: 0.5, oxidation_state: 0 },
        { element: `Ni` as ElementSymbol, occu: 0.5, oxidation_state: 0 },
      ],
      label: `Fe/Ni`,
      properties: {},
    }
    expect(get_element_fingerprint([site])).toBe(`Fe,Ni`)
  })

  test(`large list (>200) uses compact format`, () => {
    const sites = Array.from({ length: 201 }, (_, i) =>
      make_site([i, 0, 0], i === 0 ? `Si` : i === 100 ? `O` : `C`),
    )
    const fp = get_element_fingerprint(sites)
    expect(fp).toBe(`201:Si:O:C`)
  })
})

describe(`get_position_hash`, () => {
  test(`returns 0 for empty array`, () => {
    expect(get_position_hash([])).toBe(0)
  })

  test(`different positions give different hashes`, () => {
    const a = [make_site([1, 0, 0])]
    const b = [make_site([0, 1, 0])]
    expect(get_position_hash(a)).not.toBe(get_position_hash(b))
  })

  test(`deterministic`, () => {
    const sites = [make_site([1, 2, 3]), make_site([4, 5, 6])]
    expect(get_position_hash(sites)).toBe(get_position_hash(sites))
  })
})

describe(`get_structure_fingerprint`, () => {
  test(`combines element and position info`, () => {
    const sites = [make_site([1, 2, 3], `Si`)]
    const fp = get_structure_fingerprint(sites)
    expect(fp).toContain(`Si`)
    expect(fp).toContain(`|`)
  })
})

describe(`compute_force_data`, () => {
  test(`returns empty for sites without forces`, () => {
    const sites = [make_site([0, 0, 0])]
    const result = compute_force_data(sites, 1, `#ff0000`, `custom`, `all`, undefined)
    expect(result).toHaveLength(0)
  })

  test(`extracts force data from sites`, () => {
    const sites = [
      make_site([0, 0, 0], `Si`, { force: [1, 0, 0] }),
      make_site([1, 0, 0], `O`, { force: [0, 2, 0] }),
    ]
    const result = compute_force_data(sites, 2.0, `#ff0000`, `custom`, `all`, undefined)
    expect(result).toHaveLength(2)
    expect(result[0].scale).toBe(2.0)
    expect(result[0].color).toBe(`#ff0000`)
    expect(result[0].magnitude).toBeCloseTo(1)
    expect(result[1].magnitude).toBeCloseTo(2)
  })

  test(`max_only returns single largest force`, () => {
    const sites = [
      make_site([0, 0, 0], `Si`, { force: [1, 0, 0] }),
      make_site([1, 0, 0], `O`, { force: [0, 3, 0] }),
    ]
    const result = compute_force_data(sites, 1, `#ff0000`, `custom`, `max_only`, undefined)
    expect(result).toHaveLength(1)
    expect(result[0].magnitude).toBeCloseTo(3)
  })

  test(`element color mode uses element colors`, () => {
    const sites = [make_site([0, 0, 0], `Si`, { force: [1, 0, 0] })]
    const elem_colors = { Si: `#aabbcc` }
    const result = compute_force_data(sites, 1, `#ff0000`, `element`, `all`, elem_colors)
    expect(result[0].color).toBe(`#aabbcc`)
  })

  test(`element color mode falls back to force_color`, () => {
    const sites = [make_site([0, 0, 0], `Si`, { force: [1, 0, 0] })]
    const result = compute_force_data(sites, 1, `#ff0000`, `element`, `all`, {})
    expect(result[0].color).toBe(`#ff0000`)
  })
})

describe(`get_majority_element`, () => {
  test(`returns element with highest occupancy`, () => {
    const site: Site = {
      xyz: [0, 0, 0],
      abc: [0, 0, 0],
      species: [
        { element: `Fe` as ElementSymbol, occu: 0.3, oxidation_state: 0 },
        { element: `Ni` as ElementSymbol, occu: 0.7, oxidation_state: 0 },
      ],
      label: `Fe/Ni`,
      properties: {},
    }
    expect(get_majority_element(site)).toBe(`Ni`)
  })

  test(`returns null for undefined site`, () => {
    expect(get_majority_element(undefined)).toBeNull()
  })

  test(`returns null for site with empty species`, () => {
    const site = { ...make_site([0, 0, 0]), species: [] as any }
    expect(get_majority_element(site)).toBeNull()
  })
})

describe(`get_majority_color`, () => {
  const site = make_site([0, 0, 0], `Si`)

  test(`returns element color when available`, () => {
    expect(get_majority_color(site, { Si: `#aabb00` }, `#000000`)).toBe(`#aabb00`)
  })

  test(`returns fallback when element not in colors`, () => {
    expect(get_majority_color(site, {}, `#000000`)).toBe(`#000000`)
  })

  test(`returns fallback for undefined site`, () => {
    expect(get_majority_color(undefined, { Si: `#aabb00` }, `#123456`)).toBe(`#123456`)
  })
})

describe(`compute_magmom_data`, () => {
  const UP = `#e0524a`, DOWN = `#4a6fe0`

  test(`returns empty for sites without magmom`, () => {
    expect(compute_magmom_data([make_site([0, 0, 0])], 1, UP, DOWN)).toHaveLength(0)
  })

  test(`scalar collinear magmom → z arrow, coloured by sign`, () => {
    const sites = [
      make_site([0, 0, 0], `Fe`, { magmom: 2.5 }),
      make_site([1, 0, 0], `Fe`, { magmom: -2.5 }),
    ]
    const r = compute_magmom_data(sites, 1.5, UP, DOWN)
    expect(r).toHaveLength(2)
    expect(r[0].vector).toEqual([0, 0, 2.5])
    expect(r[0].color).toBe(UP)
    expect(r[0].scale).toBe(1.5)
    expect(r[1].vector).toEqual([0, 0, -2.5])
    expect(r[1].color).toBe(DOWN)
  })

  test(`non-collinear 3-vector magmom passes through with magnitude`, () => {
    const sites = [make_site([0, 0, 0], `Ni`, { magmom: [0, 3, 4] })]
    const r = compute_magmom_data(sites, 1, UP, DOWN)
    expect(r).toHaveLength(1)
    expect(r[0].vector).toEqual([0, 3, 4])
    expect(r[0].magnitude).toBeCloseTo(5)
    expect(r[0].color).toBe(UP) // z-component >= 0
  })

  test(`skips effectively-zero moments`, () => {
    const sites = [
      make_site([0, 0, 0], `O`, { magmom: 0 }),
      make_site([1, 0, 0], `O`, { magmom: 0.0001 }),
      make_site([2, 0, 0], `Fe`, { magmom: 1.2 }),
    ]
    expect(compute_magmom_data(sites, 1, UP, DOWN)).toHaveLength(1)
  })
})
