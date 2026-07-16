import type { PymatgenStructure, Vec3 } from '$lib'
import {
  execute_supercell_op_sync,
  type IntMatrix3,
  type SupercellOp,
  TRUE_SUPERCELL_MAX_ATOMS,
  validate_supercell_op,
} from '$lib/structure/supercell-operation'
import { describe, expect, it } from 'vitest'

// A cubic 2-atom cell with an explicit lattice. Cartesian coords match abc.
function make_cubic(a = 4): PymatgenStructure {
  return {
    lattice: {
      matrix: [[a, 0, 0], [0, a, 0], [0, 0, a]],
      pbc: [true, true, true],
      volume: a ** 3,
      a,
      b: a,
      c: a,
      alpha: 90,
      beta: 90,
      gamma: 90,
    },
    sites: [
      {
        species: [{ element: `Ba`, occu: 1 }],
        abc: [0, 0, 0],
        xyz: [0, 0, 0],
        label: `Ba`,
        properties: {},
      },
      {
        species: [{ element: `Ti`, occu: 1 }],
        abc: [0.5, 0.5, 0.5],
        xyz: [a / 2, a / 2, a / 2],
        label: `Ti`,
        properties: {},
      },
    ],
    charge: 0,
  } as PymatgenStructure
}

function op(matrix: IntMatrix3, reorient = false): SupercellOp {
  return { kind: `supercell`, matrix, reorient }
}

const DIAG_2: IntMatrix3 = [[2, 0, 0], [0, 2, 0], [0, 0, 2]]

describe(`validate_supercell_op`, () => {
  it(`accepts a valid integer transform and reports det + predicted count`, () => {
    const result = validate_supercell_op(make_cubic(), op(DIAG_2))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.det).toBe(8)
      expect(result.predicted_count).toBe(2 * 8) // N × |det|
    }
  })

  it(`rejects a non-3x3 matrix`, () => {
    const bad = validate_supercell_op(
      make_cubic(),
      op([[1, 0], [0, 1]] as unknown as IntMatrix3),
    )
    expect(bad.ok).toBe(false)
  })

  it(`rejects a non-integer matrix`, () => {
    const bad = validate_supercell_op(make_cubic(), op([[2.5, 0, 0], [0, 2, 0], [0, 0, 2]]))
    expect(bad.ok).toBe(false)
  })

  it(`rejects a non-finite matrix`, () => {
    const bad = validate_supercell_op(
      make_cubic(),
      op([[Infinity, 0, 0], [0, 2, 0], [0, 0, 2]]),
    )
    expect(bad.ok).toBe(false)
  })

  it(`rejects a singular (zero determinant) matrix`, () => {
    const bad = validate_supercell_op(make_cubic(), op([[1, 1, 0], [1, 1, 0], [0, 0, 1]]))
    expect(bad.ok).toBe(false)
  })

  it(`rejects a lattice-free source frame`, () => {
    const molecule = { sites: make_cubic().sites, charge: 0 } as unknown as PymatgenStructure
    const bad = validate_supercell_op(molecule, op(DIAG_2))
    expect(bad.ok).toBe(false)
  })

  it(`rejects an oversized transform above the default limit`, () => {
    const huge: IntMatrix3 = [[1000, 0, 0], [0, 1000, 0], [0, 0, 1000]]
    const bad = validate_supercell_op(make_cubic(), op(huge))
    expect(bad.ok).toBe(false)
    // 2 atoms × 1e9 cells far exceeds the 2,000,000 default
    expect(TRUE_SUPERCELL_MAX_ATOMS).toBe(2_000_000)
  })

  it(`honors an explicit max_atoms limit`, () => {
    const bad = validate_supercell_op(make_cubic(), op(DIAG_2), 10)
    expect(bad.ok).toBe(false) // predicted 16 > 10
    const ok = validate_supercell_op(make_cubic(), op(DIAG_2), 100)
    expect(ok.ok).toBe(true)
  })
})

describe(`execute_supercell_op_sync — output count = N × |det|`, () => {
  it(`produces N × |det| sites for a diagonal transform`, () => {
    const { structure } = execute_supercell_op_sync(make_cubic(), op(DIAG_2))
    expect(structure.sites).toHaveLength(2 * 8)
    expect(structure.lattice.volume).toBeCloseTo(8 * 64, 6)
  })

  it(`produces N × |det| sites for a general (sheared) integer transform`, () => {
    const shear: IntMatrix3 = [[2, 1, 0], [0, 2, 0], [0, 0, 2]] // det 8
    const { structure } = execute_supercell_op_sync(make_cubic(), op(shear))
    expect(structure.sites).toHaveLength(2 * 8)
  })

  it(`produces N × |det| sites for an anisotropic diagonal transform`, () => {
    const t: IntMatrix3 = [[2, 0, 0], [0, 3, 0], [0, 0, 1]] // det 6
    const { structure } = execute_supercell_op_sync(make_cubic(), op(t))
    expect(structure.sites).toHaveLength(2 * 6)
  })

  it(`throws on an invalid (singular) transform without mutating input`, () => {
    const src = make_cubic()
    expect(() => execute_supercell_op_sync(src, op([[1, 1, 0], [1, 1, 0], [0, 0, 1]]))).toThrow()
    expect(src.sites).toHaveLength(2)
  })

  it(`throws on a lattice-free source`, () => {
    const molecule = { sites: make_cubic().sites, charge: 0 } as unknown as PymatgenStructure
    expect(() => execute_supercell_op_sync(molecule, op(DIAG_2))).toThrow()
  })

  it(`throws when predicted count exceeds the limit`, () => {
    expect(() => execute_supercell_op_sync(make_cubic(), op(DIAG_2), 10)).toThrow()
  })

  it(`does not mutate the input structure`, () => {
    const src = make_cubic()
    const before_sites = src.sites.length
    const before_matrix = JSON.stringify(src.lattice.matrix)
    execute_supercell_op_sync(src, op(DIAG_2))
    expect(src.sites.length).toBe(before_sites)
    expect(JSON.stringify(src.lattice.matrix)).toBe(before_matrix)
  })
})

describe(`execute_supercell_op_sync — per-frame lattice`, () => {
  it(`scales each frame from its own lattice, not a shared one`, () => {
    const a4 = execute_supercell_op_sync(make_cubic(4), op(DIAG_2)).structure
    const a5 = execute_supercell_op_sync(make_cubic(5), op(DIAG_2)).structure
    // new a-vector length = 2 × source a
    expect(a4.lattice.matrix[0][0]).toBeCloseTo(8, 6)
    expect(a5.lattice.matrix[0][0]).toBeCloseTo(10, 6)
  })
})

describe(`execute_supercell_op_sync — reorientation rotates Cartesian vectors`, () => {
  // A cubic cell rotated 45° about z: a-vector points along (s, s, 0) with |a| = 4.
  const s = 2 * Math.SQRT2
  function make_rotated(): PymatgenStructure {
    return {
      lattice: {
        matrix: [[s, s, 0], [-s, s, 0], [0, 0, 4]],
        pbc: [true, true, true],
        volume: 64,
        a: 4,
        b: 4,
        c: 4,
        alpha: 90,
        beta: 90,
        gamma: 90,
      },
      sites: [
        {
          species: [{ element: `Fe`, occu: 1 }],
          abc: [0, 0, 0],
          xyz: [0, 0, 0],
          label: `Fe`,
          // force equals the source a-vector, so it must rotate to (4,0,0)
          properties: { force: [s, s, 0] },
        },
      ],
      charge: 0,
    } as PymatgenStructure
  }

  const IDENTITY: IntMatrix3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

  it(`rotates the lattice and a Cartesian force property consistently`, () => {
    const { structure } = execute_supercell_op_sync(make_rotated(), op(IDENTITY, true))
    // reorient puts a1 along +x
    expect(structure.lattice.matrix[0][0]).toBeCloseTo(4, 6)
    expect(structure.lattice.matrix[0][1]).toBeCloseTo(0, 6)
    expect(structure.lattice.matrix[0][2]).toBeCloseTo(0, 6)
    // force (which equalled the a-vector) must rotate identically
    const force = structure.sites[0].properties.force as Vec3
    expect(force[0]).toBeCloseTo(4, 6)
    expect(force[1]).toBeCloseTo(0, 6)
    expect(force[2]).toBeCloseTo(0, 6)
  })

  it(`leaves the force untouched when reorient is false`, () => {
    const { structure } = execute_supercell_op_sync(make_rotated(), op(IDENTITY, false))
    const force = structure.sites[0].properties.force as Vec3
    expect(force[0]).toBeCloseTo(s, 6)
    expect(force[1]).toBeCloseTo(s, 6)
    expect(force[2]).toBeCloseTo(0, 6)
  })

  it(`preserves the force magnitude under reorientation`, () => {
    const before = execute_supercell_op_sync(make_rotated(), op(IDENTITY, false)).structure
    const after = execute_supercell_op_sync(make_rotated(), op(IDENTITY, true)).structure
    const mag = (v: Vec3) => Math.hypot(v[0], v[1], v[2])
    expect(mag(after.sites[0].properties.force as Vec3)).toBeCloseTo(
      mag(before.sites[0].properties.force as Vec3),
      6,
    )
  })
})

describe(`execute_supercell_op_sync — deterministic provenance / physical-site map`, () => {
  it(`records source identity, matrix, cell order, and a bijective site map`, () => {
    const src = make_cubic()
    const n = src.sites.length
    const t: IntMatrix3 = [[2, 0, 0], [0, 2, 0], [0, 0, 1]] // det 4 → 4 cells
    const { structure, provenance } = execute_supercell_op_sync(src, op(t))

    expect(provenance.source_atom_count).toBe(n)
    expect(provenance.matrix).toEqual(t)
    expect(provenance.cell_count).toBe(4)
    expect(provenance.cell_order).toHaveLength(4)
    // origin cell is enumerated first
    expect(provenance.cell_order[0]).toEqual([0, 0, 0])

    // map has one entry per (base_site, cell)
    expect(provenance.physical_site_map.length).toBe(n * 4)

    // map is a bijection onto [0, N×cells)
    const sorted = [...provenance.physical_site_map].sort((x, y) => x - y)
    expect(sorted).toEqual(Array.from({ length: n * 4 }, (_, i) => i))

    // every (base, cell) → physical site keeps the base species
    for (let c = 0; c < 4; c++) {
      for (let b = 0; b < n; b++) {
        const phys = provenance.physical_site_map[c * n + b]
        expect(structure.sites[phys].species[0].element).toBe(src.sites[b].species[0].element)
      }
    }
  })

  it(`is deterministic across repeated executions`, () => {
    const t: IntMatrix3 = [[2, 0, 0], [0, 2, 0], [0, 0, 2]]
    const p1 = execute_supercell_op_sync(make_cubic(), op(t)).provenance
    const p2 = execute_supercell_op_sync(make_cubic(), op(t)).provenance
    expect([...p1.physical_site_map]).toEqual([...p2.physical_site_map])
    expect(p1.cell_order).toEqual(p2.cell_order)
  })
})
