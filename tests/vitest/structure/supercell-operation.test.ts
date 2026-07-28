import type { PymatgenStructure, Vec3 } from '$lib'
import {
  apply_transform_matrix_supercell,
  enumerate_supercell_cells,
} from '$lib/structure/lattice-ops'
import {
  execute_supercell_op_sync,
  type IntMatrix3,
  type SupercellOp,
  TRUE_SUPERCELL_MAX_ATOMS,
  validate_supercell_op,
} from '$lib/structure/supercell-operation'
import { describe, expect, it } from 'vitest'

type M3 = [[number, number, number], [number, number, number], [number, number, number]]

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

describe(`enumerate_supercell_cells — full cell set for negative/mixed-sign transforms`, () => {
  const by_lex = (a: Vec3, b: Vec3) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

  // Wide-box brute-force reference: same interior criterion as production
  // (offset · matrix⁻¹ ∈ [0, 1)³) over a deliberately oversized scan range.
  function brute_force_cells(m: M3, range = 30): Vec3[] {
    const [r0, r1, r2] = m
    const det = r0[0] * (r1[1] * r2[2] - r1[2] * r2[1]) -
      r0[1] * (r1[0] * r2[2] - r1[2] * r2[0]) +
      r0[2] * (r1[0] * r2[1] - r1[1] * r2[0])
    const d = 1 / det
    const inv = [
      [
        (r1[1] * r2[2] - r1[2] * r2[1]) * d,
        (r0[2] * r2[1] - r0[1] * r2[2]) * d,
        (r0[1] * r1[2] - r0[2] * r1[1]) * d,
      ],
      [
        (r1[2] * r2[0] - r1[0] * r2[2]) * d,
        (r0[0] * r2[2] - r0[2] * r2[0]) * d,
        (r0[2] * r1[0] - r0[0] * r1[2]) * d,
      ],
      [
        (r1[0] * r2[1] - r1[1] * r2[0]) * d,
        (r0[1] * r2[0] - r0[0] * r2[1]) * d,
        (r0[0] * r1[1] - r0[1] * r1[0]) * d,
      ],
    ]
    const eps = 1e-8
    const cells: Vec3[] = []
    for (let i = -range; i <= range; i++) {
      for (let j = -range; j <= range; j++) {
        for (let k = -range; k <= range; k++) {
          const f0 = i * inv[0][0] + j * inv[1][0] + k * inv[2][0]
          const f1 = i * inv[0][1] + j * inv[1][1] + k * inv[2][1]
          const f2 = i * inv[0][2] + j * inv[1][2] + k * inv[2][2]
          if (
            f0 >= -eps && f0 < 1 - eps && f1 >= -eps && f1 < 1 - eps &&
            f2 >= -eps && f2 < 1 - eps
          ) cells.push([i, j, k])
        }
      }
    }
    return cells
  }

  it(`finds all |det| offsets for [[-3,1,0],[-3,0,1],[-3,1,1]] (det 3; (-5,1,1) lies outside naive boxes)`, () => {
    const m: M3 = [[-3, 1, 0], [-3, 0, 1], [-3, 1, 1]]
    const cells = enumerate_supercell_cells(m)
    expect(cells).toHaveLength(3)
    expect([...cells].sort(by_lex)).toEqual([[-5, 1, 1], [-4, 1, 1], [0, 0, 0]])
  })

  it(`matches a wide-box brute-force reference for a mixed-sign transform with |det| = 7`, () => {
    const m: M3 = [[-2, 1, 0], [0, -2, 1], [1, 0, -2]] // det = -7
    const cells = enumerate_supercell_cells(m)
    expect(cells).toHaveLength(7)
    expect([...cells].sort(by_lex)).toEqual(brute_force_cells(m).sort(by_lex))
  })
})

describe(`execute_supercell_op_sync — output count = N × |det|`, () => {
  it(`materializes N × |det| sites for a valid transform with large negative entries`, () => {
    // Reviewer counterexample: det 3, but a naive enumeration box misses cell
    // (-5,1,1) and silently produced 2N sites against a predicted 3N.
    const m: IntMatrix3 = [[-3, 1, 0], [-3, 0, 1], [-3, 1, 1]]
    const { structure, provenance } = execute_supercell_op_sync(make_cubic(), op(m))
    expect(structure.sites).toHaveLength(2 * 3)
    expect(provenance.cell_count).toBe(3)
    expect(provenance.cell_order).toHaveLength(3)
    expect(provenance.physical_site_map.length).toBe(2 * 3)
    const sorted = [...provenance.physical_site_map].sort((x, y) => x - y)
    expect(sorted).toEqual(Array.from({ length: 2 * 3 }, (_, i) => i))
  })

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
    // full deterministic cell order (lexicographic, origin cell first)
    expect(provenance.cell_order).toEqual([[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0]])

    // map has one entry per (base_site, cell)
    expect(provenance.physical_site_map.length).toBe(n * 4)

    // map is a bijection onto [0, N×cells)
    const sorted = [...provenance.physical_site_map].sort((x, y) => x - y)
    expect(sorted).toEqual(Array.from({ length: n * 4 }, (_, i) => i))

    // every (base, cell) → physical site keeps the base species AND sits at
    // base_xyz + cell_offset · L — a wrong-cell same-species pairing cannot pass
    const L = src.lattice.matrix
    for (let c = 0; c < 4; c++) {
      const [ci, cj, ck] = provenance.cell_order[c]
      for (let b = 0; b < n; b++) {
        const phys = provenance.physical_site_map[c * n + b]
        expect(structure.sites[phys].species[0].element).toBe(src.sites[b].species[0].element)
        for (let d = 0; d < 3; d++) {
          const expected = src.sites[b].xyz[d] + ci * L[0][d] + cj * L[1][d] + ck * L[2][d]
          expect(structure.sites[phys].xyz[d]).toBeCloseTo(expected, 6)
        }
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

describe(`apply_transform_matrix_supercell — uniform matrix·lattice convention`, () => {
  // Anisotropic lattice so the T·L and legacy L·T conventions differ.
  function make_aniso(): PymatgenStructure {
    return {
      lattice: {
        matrix: [[4, 0, 0], [0, 5, 0], [0, 0, 6]],
        pbc: [true, true, true],
        volume: 120,
        a: 4,
        b: 5,
        c: 6,
        alpha: 90,
        beta: 90,
        gamma: 90,
      },
      sites: [
        {
          species: [{ element: `Ba`, occu: 1 }],
          abc: [0.25, 0.25, 0.25],
          xyz: [1, 1.25, 1.5],
          label: `Ba`,
          properties: {},
        },
      ],
      charge: 0,
    } as PymatgenStructure
  }

  it(`det-1 non-orthogonal shear takes the corrected transform·lattice path`, () => {
    const shear: M3 = [[1, 1, 0], [0, 1, 0], [0, 0, 1]] // det 1: legal reshaping supercell
    const out = apply_transform_matrix_supercell(make_aniso(), shear)
    // new_lattice = transform · old_lattice → a' = a + b = [4, 5, 0]
    // (the legacy old_lattice · transform convention gave [4, 4, 0])
    expect(out.lattice.matrix[0][0]).toBeCloseTo(4, 9)
    expect(out.lattice.matrix[0][1]).toBeCloseTo(5, 9)
    expect(out.lattice.matrix[0][2]).toBeCloseTo(0, 9)
    expect(out.lattice.matrix[1][1]).toBeCloseTo(5, 9)
    expect(out.lattice.matrix[2][2]).toBeCloseTo(6, 9)
    // no replication, Cartesian geometry preserved (same crystal, redescribed)
    expect(out.sites).toHaveLength(1)
    expect(out.sites[0].xyz[0]).toBeCloseTo(1, 6)
    expect(out.sites[0].xyz[1]).toBeCloseTo(1.25, 6)
    expect(out.sites[0].xyz[2]).toBeCloseTo(1.5, 6)
  })

  it(`negative det keeps the left-handed lattice (no silent a/b swap)`, () => {
    const mirror: M3 = [[-1, 0, 0], [0, 1, 0], [0, 0, 1]] // det -1
    const out = apply_transform_matrix_supercell(make_aniso(), mirror)
    expect(out.lattice.matrix[0][0]).toBeCloseTo(-4, 9)
    expect(out.lattice.matrix[1][1]).toBeCloseTo(5, 9)
    expect(out.lattice.matrix[2][2]).toBeCloseTo(6, 9)
    expect(out.sites).toHaveLength(1)
    // site folds into the new cell along the mirrored axis: abc 0.25 → 0.75
    expect(out.sites[0].abc[0]).toBeCloseTo(0.75, 6)
    expect(out.sites[0].xyz[0]).toBeCloseTo(-3, 6)
  })

  it(`returns the structure unchanged for a singular transform`, () => {
    const src = make_aniso()
    const out = apply_transform_matrix_supercell(src, [[1, 1, 0], [1, 1, 0], [0, 0, 1]])
    expect(out).toBe(src)
  })
})
