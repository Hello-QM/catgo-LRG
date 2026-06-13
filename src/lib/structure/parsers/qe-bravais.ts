// Quantum ESPRESSO ibrav → lattice vectors (Å), the full standard table from
// the pw.x input documentation. Vectors are returned as row matrix in Å.
//
// Inputs (already resolved to Å / ratios / cosines by the caller):
//   a       : celldm(1) in Å (= celldm(1)·bohr, or `A`)
//   boa     : b/a   (celldm(2), or B/A)
//   coa     : c/a   (celldm(3), or C/A)
//   cd4/5/6 : celldm(4..6) cosines (meaning depends on ibrav)

import type { Matrix3x3 } from '$lib/math'
import type { Vec3 } from '$lib'

type N = number | null

export function lattice_from_ibrav(
  ibrav: number,
  a: N,
  boa: N,
  coa: N,
  cd4: N,
  cd5: N,
  cd6: N,
): Matrix3x3 | null {
  if (!a) return null
  const b = boa ? boa * a : null
  const c = coa ? coa * a : null
  const S3 = Math.sqrt(3)
  // helper: scale unit (alat) vectors by a
  const M = (rows: Vec3[]): Matrix3x3 => rows.map((r) => [r[0] * a, r[1] * a, r[2] * a] as Vec3) as Matrix3x3

  switch (ibrav) {
    case 1:
      return M([[1, 0, 0], [0, 1, 0], [0, 0, 1]])
    case 2:
      return M([[-0.5, 0, 0.5], [0, 0.5, 0.5], [-0.5, 0.5, 0]])
    case 3:
      return M([[0.5, 0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, -0.5, 0.5]])
    case -3:
      return M([[-0.5, 0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, -0.5]])
    case 4:
      if (!coa) return null
      return M([[1, 0, 0], [-0.5, S3 / 2, 0], [0, 0, coa]])
    case 5: { // trigonal R, 3-fold axis <111>; cd4 = cos(α)
      if (cd4 === null) return null
      const cc = cd4
      const tx = Math.sqrt((1 - cc) / 2)
      const ty = Math.sqrt((1 - cc) / 6)
      const tz = Math.sqrt((1 + 2 * cc) / 3)
      return M([[tx, -ty, tz], [0, 2 * ty, tz], [-tx, -ty, tz]])
    }
    case 6:
      if (!coa) return null
      return M([[1, 0, 0], [0, 1, 0], [0, 0, coa]])
    case 7: // body-centered tetragonal
      if (!coa) return null
      return M([[0.5, -0.5, coa / 2], [0.5, 0.5, coa / 2], [-0.5, -0.5, coa / 2]])
    case 8: // simple orthorhombic
      if (!boa || !coa) return null
      return M([[1, 0, 0], [0, boa, 0], [0, 0, coa]])
    case 9: // base-centered orthorhombic (C-type)
      if (!boa || !coa) return null
      return M([[0.5, boa / 2, 0], [-0.5, boa / 2, 0], [0, 0, coa]])
    case -9:
      if (!boa || !coa) return null
      return M([[0.5, -boa / 2, 0], [0.5, boa / 2, 0], [0, 0, coa]])
    case 10: // face-centered orthorhombic
      if (!boa || !coa) return null
      return M([[0.5, 0, coa / 2], [0.5, boa / 2, 0], [0, boa / 2, coa / 2]])
    case 11: // body-centered orthorhombic
      if (!boa || !coa) return null
      return M([[0.5, boa / 2, coa / 2], [-0.5, boa / 2, coa / 2], [-0.5, -boa / 2, coa / 2]])
    case 12: { // monoclinic P, unique axis c; cd4 = cos(γ)
      if (!boa || !coa || cd4 === null) return null
      const sg = Math.sqrt(1 - cd4 * cd4)
      return M([[1, 0, 0], [boa * cd4, boa * sg, 0], [0, 0, coa]])
    }
    case -12: { // monoclinic P, unique axis b; cd5 = cos(β)
      if (!boa || !coa || cd5 === null) return null
      const sb = Math.sqrt(1 - cd5 * cd5)
      return M([[1, 0, 0], [0, boa, 0], [coa * cd5, 0, coa * sb]])
    }
    case 13: { // base-centered monoclinic, unique axis c; cd4 = cos(γ)
      if (!boa || !coa || cd4 === null) return null
      const sg = Math.sqrt(1 - cd4 * cd4)
      return M([[0.5, 0, -coa / 2], [boa * cd4, boa * sg, 0], [0.5, 0, coa / 2]])
    }
    case 14: { // triclinic; cd4=cos(bc)=cosα, cd5=cos(ac)=cosβ, cd6=cos(ab)=cosγ
      if (!boa || !coa || cd4 === null || cd5 === null || cd6 === null) return null
      const ca = cd4, cb = cd5, cg = cd6
      const sg = Math.sqrt(1 - cg * cg)
      const v3z = Math.sqrt(1 + 2 * ca * cb * cg - ca * ca - cb * cb - cg * cg) / sg
      return M([
        [1, 0, 0],
        [boa * cg, boa * sg, 0],
        [coa * cb, coa * (ca - cb * cg) / sg, coa * v3z],
      ])
    }
    default:
      return null
  }
}
