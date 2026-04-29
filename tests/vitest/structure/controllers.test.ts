import { describe, expect, test } from 'vitest'

import {
  is_image_atom,
  has_original_atoms,
  get_original_atoms_only,
  get_import_position_outside,
  apply_charges,
} from '$lib/structure/controllers/transform-controller'

import {
  delete_measurement_from_list,
  prune_measurements,
  compute_unique_elements,
  has_any_charges,
  site_has_charge,
  prune_charge_labels,
} from '$lib/structure/controllers/analysis-controller'

import {
  build_constraints_section,
  build_charge_label_section,
  validate_bond_edits,
} from '$lib/structure/controllers/viewer-controller'

import type { AnyStructure } from '$lib/structure'
import type { Measurement, ManualBond } from '$lib/structure'

// ─── Helpers to build mock structures ───

function make_site(
  element: string,
  xyz: [number, number, number],
  properties: Record<string, any> = {},
) {
  return {
    species: [{ element, occu: 1 }],
    abc: [0, 0, 0] as [number, number, number],
    xyz,
    label: element,
    properties,
  }
}

function make_structure(
  sites: ReturnType<typeof make_site>[],
  extras: Record<string, any> = {},
): AnyStructure {
  return { sites, ...extras } as any
}

// ─── transform-controller ───

describe('is_image_atom', () => {
  test('returns false when structure is undefined', () => {
    expect(is_image_atom(undefined, 0)).toBe(false)
  })

  test('returns false when structure has no num_original_sites', () => {
    const s = make_structure([make_site('C', [0, 0, 0])])
    expect(is_image_atom(s, 0)).toBe(false)
  })

  test('returns false for original atom index', () => {
    const s = make_structure(
      [make_site('C', [0, 0, 0]), make_site('C', [1, 0, 0]), make_site('C', [2, 0, 0])],
      { num_original_sites: 2 },
    )
    expect(is_image_atom(s, 0)).toBe(false)
    expect(is_image_atom(s, 1)).toBe(false)
  })

  test('returns true for image atom index', () => {
    const s = make_structure(
      [make_site('C', [0, 0, 0]), make_site('C', [1, 0, 0]), make_site('C', [2, 0, 0])],
      { num_original_sites: 2 },
    )
    expect(is_image_atom(s, 2)).toBe(true)
  })

  test('boundary: index equal to num_original_sites is image', () => {
    const s = make_structure([make_site('O', [0, 0, 0])], { num_original_sites: 1 })
    expect(is_image_atom(s, 1)).toBe(true)
    expect(is_image_atom(s, 0)).toBe(false)
  })
})

describe('has_original_atoms', () => {
  const displayed = make_structure(
    [make_site('Si', [0, 0, 0]), make_site('Si', [1, 0, 0]), make_site('Si', [2, 0, 0])],
    { num_original_sites: 2 },
  )

  test('returns true when selection includes originals', () => {
    expect(has_original_atoms(displayed, [0, 2])).toBe(true)
  })

  test('returns false when selection is all image atoms', () => {
    expect(has_original_atoms(displayed, [2])).toBe(false)
  })

  test('returns false for empty selection', () => {
    expect(has_original_atoms(displayed, [])).toBe(false)
  })

  test('returns true when structure has no image metadata (all atoms are original)', () => {
    const plain = make_structure([make_site('C', [0, 0, 0])])
    expect(has_original_atoms(plain, [0])).toBe(true)
  })
})

describe('get_original_atoms_only', () => {
  const displayed = make_structure(
    [
      make_site('Fe', [0, 0, 0]),
      make_site('Fe', [1, 0, 0]),
      make_site('Fe', [2, 0, 0]), // image of 0
      make_site('Fe', [3, 0, 0]), // image of 1
    ],
    { num_original_sites: 2, image_to_original_map: [0, 1] },
  )
  const base = make_structure([make_site('Fe', [0, 0, 0]), make_site('Fe', [1, 0, 0])])

  test('maps image atoms back to originals', () => {
    const result = get_original_atoms_only(displayed, base, [2, 3])
    expect(result.sort()).toEqual([0, 1])
  })

  test('deduplicates when image and original both selected', () => {
    const result = get_original_atoms_only(displayed, base, [0, 2])
    expect(result).toEqual([0])
  })

  test('filters out indices beyond base structure', () => {
    const result = get_original_atoms_only(displayed, base, [0, 5])
    expect(result).toEqual([0])
  })

  test('handles undefined structures', () => {
    expect(get_original_atoms_only(undefined, undefined, [0])).toEqual([])
  })
})

describe('get_import_position_outside', () => {
  test('places imported structure above existing one', () => {
    const existing = make_structure([
      make_site('C', [0, 0, 0]),
      make_site('C', [2, 0, 4]),
    ])
    const imported = make_structure([
      make_site('N', [0, 0, 0]),
      make_site('N', [0, 0, 2]),
    ])
    const pos = get_import_position_outside(existing, imported)
    // existing max z = 4, padding = 3, so z >= 7
    expect(pos[2]).toBeGreaterThanOrEqual(7)
  })

  test('custom padding is respected', () => {
    const existing = make_structure([make_site('C', [0, 0, 5])])
    const imported = make_structure([make_site('N', [0, 0, 0])])
    const pos = get_import_position_outside(existing, imported, 10)
    expect(pos[2]).toBeGreaterThanOrEqual(15)
  })

  test('returns 3-element tuple', () => {
    const existing = make_structure([make_site('C', [1, 2, 3])])
    const imported = make_structure([make_site('N', [4, 5, 6])])
    const pos = get_import_position_outside(existing, imported)
    expect(pos).toHaveLength(3)
    pos.forEach((v) => expect(typeof v).toBe('number'))
  })
})

describe('apply_charges', () => {
  test('applies charges to each site', () => {
    const s = make_structure([
      make_site('O', [0, 0, 0]),
      make_site('H', [1, 0, 0]),
    ])
    const result = apply_charges(s, [6.5, 0.75])
    expect(result.sites[0].properties.bader_charge).toBe(6.5)
    expect(result.sites[1].properties.bader_charge).toBe(0.75)
  })

  test('preserves existing properties', () => {
    const s = make_structure([make_site('O', [0, 0, 0], { magmom: 1.5 })])
    const result = apply_charges(s, [6.0])
    expect(result.sites[0].properties.magmom).toBe(1.5)
    expect(result.sites[0].properties.bader_charge).toBe(6.0)
  })

  test('does not mutate original structure', () => {
    const s = make_structure([make_site('O', [0, 0, 0])])
    apply_charges(s, [6.0])
    expect(s.sites[0].properties.bader_charge).toBeUndefined()
  })
})

// ─── analysis-controller ───

describe('delete_measurement_from_list', () => {
  const measurements: Measurement[] = [
    { id: 'dist-1', type: 'distance', sites: [0, 1] },
    { id: 'legacy-angle', type: 'angle', sites: [0, 1, 2] },
    { id: 'dist-2', type: 'distance', sites: [2, 3] },
  ]

  test('removes measurement by id', () => {
    const result = delete_measurement_from_list(measurements, 'dist-1')
    expect(result.measurements).toHaveLength(2)
    expect(result.measurements.find((m) => m.id === 'dist-1')).toBeUndefined()
  })

  test('sets clear_legacy for legacy- prefixed ids', () => {
    const result = delete_measurement_from_list(measurements, 'legacy-angle')
    expect(result.clear_legacy).toBe(true)
  })

  test('does not set clear_legacy for non-legacy ids', () => {
    const result = delete_measurement_from_list(measurements, 'dist-1')
    expect(result.clear_legacy).toBe(false)
  })

  test('returns original array when id not found', () => {
    const result = delete_measurement_from_list(measurements, 'nonexistent')
    expect(result.measurements).toBe(measurements)
    expect(result.clear_legacy).toBe(false)
  })
})

describe('prune_measurements', () => {
  const measurements: Measurement[] = [
    { id: 'm1', type: 'distance', sites: [0, 1] },
    { id: 'm2', type: 'angle', sites: [0, 1, 5] },
    { id: 'm3', type: 'distance', sites: [3, 4] },
  ]

  test('keeps measurements with all valid indices', () => {
    const result = prune_measurements(measurements, 5)
    expect(result).toHaveLength(3)
  })

  test('removes sites beyond max_valid_index', () => {
    const result = prune_measurements(measurements, 2)
    // m1: [0,1] all valid, m2: [0,1] remain (5 removed), m3: [] all removed
    expect(result).toHaveLength(2)
    expect(result.find((m) => m.id === 'm3')).toBeUndefined()
  })

  test('drops measurement entirely if no sites remain valid', () => {
    const result = prune_measurements([{ id: 'x', type: 'distance', sites: [10, 11] }], 5)
    expect(result).toHaveLength(0)
  })

  test('handles empty measurements array', () => {
    expect(prune_measurements([], 10)).toEqual([])
  })
})

describe('compute_unique_elements', () => {
  test('returns sorted unique elements', () => {
    const s = make_structure([
      make_site('O', [0, 0, 0]),
      make_site('H', [1, 0, 0]),
      make_site('O', [2, 0, 0]),
      make_site('C', [3, 0, 0]),
    ])
    expect(compute_unique_elements(s)).toEqual(['C', 'H', 'O'])
  })

  test('returns empty for undefined structure', () => {
    expect(compute_unique_elements(undefined)).toEqual([])
  })

  test('returns empty for structure with no sites', () => {
    expect(compute_unique_elements(make_structure([]))).toEqual([])
  })
})

describe('has_any_charges', () => {
  test('returns true when at least one site has bader_charge', () => {
    const s = make_structure([
      make_site('O', [0, 0, 0], { bader_charge: 6.5 }),
      make_site('H', [1, 0, 0]),
    ])
    expect(has_any_charges(s)).toBe(true)
  })

  test('returns false when no sites have bader_charge', () => {
    const s = make_structure([make_site('O', [0, 0, 0]), make_site('H', [1, 0, 0])])
    expect(has_any_charges(s)).toBe(false)
  })

  test('returns false for undefined structure', () => {
    expect(has_any_charges(undefined)).toBe(false)
  })
})

describe('site_has_charge', () => {
  const s = make_structure([
    make_site('O', [0, 0, 0], { bader_charge: 6.5 }),
    make_site('H', [1, 0, 0]),
  ])

  test('returns true for site with charge', () => {
    expect(site_has_charge(s, 0)).toBe(true)
  })

  test('returns false for site without charge', () => {
    expect(site_has_charge(s, 1)).toBe(false)
  })

  test('returns false for null index', () => {
    expect(site_has_charge(s, null)).toBe(false)
  })

  test('returns false for undefined structure', () => {
    expect(site_has_charge(undefined, 0)).toBe(false)
  })
})

describe('prune_charge_labels', () => {
  test('removes labels for indices that no longer have charges', () => {
    const s = make_structure([
      make_site('O', [0, 0, 0], { bader_charge: 6.5 }),
      make_site('H', [1, 0, 0]),
    ])
    const labels = new Set([0, 1])
    const result = prune_charge_labels(s, labels)
    expect(result).not.toBeNull()
    expect(result!.has(0)).toBe(true)
    expect(result!.has(1)).toBe(false)
  })

  test('removes labels for out-of-range indices', () => {
    const s = make_structure([make_site('O', [0, 0, 0], { bader_charge: 6.5 })])
    const labels = new Set([0, 5])
    const result = prune_charge_labels(s, labels)
    expect(result).not.toBeNull()
    expect(result!.size).toBe(1)
    expect(result!.has(0)).toBe(true)
  })

  test('returns null when no pruning needed', () => {
    const s = make_structure([
      make_site('O', [0, 0, 0], { bader_charge: 6.5 }),
      make_site('H', [1, 0, 0], { bader_charge: 0.75 }),
    ])
    const labels = new Set([0, 1])
    expect(prune_charge_labels(s, labels)).toBeNull()
  })

  test('returns empty set when all labels pruned', () => {
    const s = make_structure([make_site('O', [0, 0, 0])])
    const labels = new Set([0, 1])
    const result = prune_charge_labels(s, labels)
    expect(result).not.toBeNull()
    expect(result!.size).toBe(0)
  })
})

// ─── viewer-controller ───

describe('build_constraints_section', () => {
  test('returns vacuum hint when has_vacuum is false', () => {
    const sections = build_constraints_section({
      has_vacuum: false,
      context_menu_target_site: null,
      selected_sites: [],
      displayed_structure: undefined,
      structure: undefined,
    })
    expect(sections).toHaveLength(1)
    expect(sections[0].title).toBe('Constraints')
    expect(sections[0].options[0].disabled).toBe(true)
    expect(sections[0].options[0].label).toContain('vacuum')
  })

  test('returns freeze toggles when has_vacuum is true', () => {
    const s = make_structure([make_site('Si', [0, 0, 0])])
    const sections = build_constraints_section({
      has_vacuum: true,
      context_menu_target_site: 0,
      selected_sites: [],
      displayed_structure: s,
      structure: s,
    })
    expect(sections).toHaveLength(1)
    const labels = sections[0].options.map((o) => o.label)
    expect(labels).toContain('X')
    expect(labels).toContain('Y')
    expect(labels).toContain('Z')
    expect(labels).toContain('Freeze all axes')
  })

  test('disables axis toggles when no target', () => {
    const s = make_structure([make_site('Si', [0, 0, 0])])
    const sections = build_constraints_section({
      has_vacuum: true,
      context_menu_target_site: null,
      selected_sites: [],
      displayed_structure: s,
      structure: s,
    })
    const xyz_options = sections[0].options.filter((o) => ['X', 'Y', 'Z'].includes(o.label))
    xyz_options.forEach((o) => expect(o.disabled).toBe(true))
  })

  test('reads selective_dynamics from structure site properties', () => {
    const s = make_structure([
      make_site('Si', [0, 0, 0], { selective_dynamics: [false, true, false] }),
    ])
    const sections = build_constraints_section({
      has_vacuum: true,
      context_menu_target_site: 0,
      selected_sites: [],
      displayed_structure: s,
      structure: s,
    })
    const x_opt = sections[0].options.find((o) => o.label === 'X')
    const y_opt = sections[0].options.find((o) => o.label === 'Y')
    const z_opt = sections[0].options.find((o) => o.label === 'Z')
    // checked means frozen (inverted from selective_dynamics)
    expect(x_opt!.checked).toBe(true) // sd[0]=false => frozen
    expect(y_opt!.checked).toBe(false) // sd[1]=true => free
    expect(z_opt!.checked).toBe(true) // sd[2]=false => frozen
  })
})

describe('build_charge_label_section', () => {
  test('returns charge label section', () => {
    const s = make_structure([make_site('O', [0, 0, 0], { bader_charge: 6.5 })])
    const sections = build_charge_label_section({
      context_menu_target_site: 0,
      displayed_structure: s,
      structure: s,
      visible_charge_labels: new Set(),
    })
    expect(sections).toHaveLength(1)
    expect(sections[0].title).toBe('Charge Label')
  })

  test('disables toggle when target has no charge', () => {
    const s = make_structure([make_site('O', [0, 0, 0])])
    const sections = build_charge_label_section({
      context_menu_target_site: 0,
      displayed_structure: s,
      structure: s,
      visible_charge_labels: new Set(),
    })
    const toggle = sections[0].options.find((o) => o.value === 'toggle_charge_label')
    expect(toggle!.disabled).toBe(true)
  })

  test('enables toggle when target has charge', () => {
    const s = make_structure([make_site('O', [0, 0, 0], { bader_charge: 6.5 })])
    const sections = build_charge_label_section({
      context_menu_target_site: 0,
      displayed_structure: s,
      structure: s,
      visible_charge_labels: new Set(),
    })
    const toggle = sections[0].options.find((o) => o.value === 'toggle_charge_label')
    expect(toggle!.disabled).toBe(false)
  })

  test('shows "Hide" label when charge label is visible', () => {
    const s = make_structure([make_site('O', [0, 0, 0], { bader_charge: 6.5 })])
    const sections = build_charge_label_section({
      context_menu_target_site: 0,
      displayed_structure: s,
      structure: s,
      visible_charge_labels: new Set([0]),
    })
    const toggle = sections[0].options.find((o) => o.value === 'toggle_charge_label')
    expect(toggle!.label).toContain('Hide')
    expect(toggle!.checked).toBe(true)
  })

  test('disables show_all when no charges exist', () => {
    const s = make_structure([make_site('O', [0, 0, 0])])
    const sections = build_charge_label_section({
      context_menu_target_site: null,
      displayed_structure: s,
      structure: s,
      visible_charge_labels: new Set(),
    })
    const show_all = sections[0].options.find((o) => o.value === 'show_all_charge_labels')
    expect(show_all!.disabled).toBe(true)
  })

  test('disables hide_all when no labels visible', () => {
    const s = make_structure([make_site('O', [0, 0, 0], { bader_charge: 6.5 })])
    const sections = build_charge_label_section({
      context_menu_target_site: 0,
      displayed_structure: s,
      structure: s,
      visible_charge_labels: new Set(),
    })
    const hide_all = sections[0].options.find((o) => o.value === 'hide_all_charge_labels')
    expect(hide_all!.disabled).toBe(true)
  })
})

describe('validate_bond_edits', () => {
  test('returns null when all bonds are valid', () => {
    const manual: ManualBond[] = [
      { site_idx_1: 0, site_idx_2: 1, id: 'b1' },
    ]
    const deleted = new Set(['0-2'])
    const result = validate_bond_edits(manual, deleted, 5)
    expect(result.manual_bonds).toBeNull()
    expect(result.deleted_bond_keys).toBeNull()
  })

  test('removes manual bonds with out-of-range sites', () => {
    const manual: ManualBond[] = [
      { site_idx_1: 0, site_idx_2: 1, id: 'b1' },
      { site_idx_1: 3, site_idx_2: 5, id: 'b2' },
    ]
    const result = validate_bond_edits(manual, new Set(), 4)
    expect(result.manual_bonds).not.toBeNull()
    expect(result.manual_bonds!).toHaveLength(1)
    expect(result.manual_bonds![0].id).toBe('b1')
  })

  test('removes deleted bond keys with out-of-range sites', () => {
    const deleted = new Set(['0-1', '3-10'])
    const result = validate_bond_edits([], deleted, 5)
    expect(result.deleted_bond_keys).not.toBeNull()
    expect(result.deleted_bond_keys!.has('0-1')).toBe(true)
    expect(result.deleted_bond_keys!.has('3-10')).toBe(false)
  })

  test('handles empty inputs', () => {
    const result = validate_bond_edits([], new Set(), 0)
    expect(result.manual_bonds).toBeNull()
    expect(result.deleted_bond_keys).toBeNull()
  })

  test('handles site count of zero removing all bonds', () => {
    const manual: ManualBond[] = [
      { site_idx_1: 0, site_idx_2: 1, id: 'b1' },
    ]
    const deleted = new Set(['0-1'])
    const result = validate_bond_edits(manual, deleted, 0)
    expect(result.manual_bonds).not.toBeNull()
    expect(result.manual_bonds!).toHaveLength(0)
    expect(result.deleted_bond_keys).not.toBeNull()
    expect(result.deleted_bond_keys!.size).toBe(0)
  })
})
