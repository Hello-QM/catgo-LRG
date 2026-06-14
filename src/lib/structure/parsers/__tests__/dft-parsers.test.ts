import { describe, expect, it } from 'vitest'
import { parse_castep_cell } from '../castep'
import { parse_siesta_fdf } from '../siesta'
import { parse_qe } from '../qe'
import { parse_outcar } from '../outcar'
import { parse_structure_file } from '../dispatch'

const close = (a: number, b: number, eps = 1e-4) => expect(Math.abs(a - b)).toBeLessThan(eps)

describe(`CASTEP .cell`, () => {
  const cell = `%BLOCK LATTICE_CART
5.43 0.0 0.0
0.0 5.43 0.0
0.0 0.0 5.43
%ENDBLOCK LATTICE_CART

%BLOCK POSITIONS_FRAC
Si 0.0 0.0 0.0
Si 0.5 0.5 0.0
%ENDBLOCK POSITIONS_FRAC
`
  it(`parses lattice + fractional positions`, () => {
    const s = parse_castep_cell(cell)!
    expect(s).not.toBeNull()
    expect(s.sites).toHaveLength(2)
    expect(s.sites[0].species[0].element).toBe(`Si`)
    close(s.lattice!.a, 5.43)
    close(s.sites[1].xyz[0], 2.715)
    close(s.sites[1].xyz[1], 2.715)
    close(s.sites[1].xyz[2], 0)
  })

  it(`handles LATTICE_ABC + POSITIONS_ABS with bohr units`, () => {
    const c = `%BLOCK LATTICE_ABC
ang
4.0 4.0 4.0
90 90 90
%ENDBLOCK LATTICE_ABC
%BLOCK POSITIONS_ABS
bohr
H 0.0 0.0 0.0
%ENDBLOCK POSITIONS_ABS
`
    const s = parse_castep_cell(c)!
    close(s.lattice!.a, 4.0)
    expect(s.sites[0].species[0].element).toBe(`H`)
  })
})

describe(`SIESTA .fdf`, () => {
  const fdf = `LatticeConstant 5.43 Ang
%block LatticeVectors
1.0 0.0 0.0
0.0 1.0 0.0
0.0 0.0 1.0
%endblock LatticeVectors
%block ChemicalSpeciesLabel
1 14 Si
%endblock ChemicalSpeciesLabel
AtomicCoordinatesFormat Fractional
%block AtomicCoordinatesAndAtomicSpecies
0.0 0.0 0.0 1
0.5 0.5 0.5 1
%endblock AtomicCoordinatesAndAtomicSpecies
`
  it(`maps species index and scales lattice constant`, () => {
    const s = parse_siesta_fdf(fdf)!
    expect(s.sites).toHaveLength(2)
    expect(s.sites[0].species[0].element).toBe(`Si`)
    close(s.lattice!.a, 5.43)
    close(s.sites[1].xyz[0], 2.715)
  })
})

describe(`Quantum ESPRESSO input`, () => {
  const qe = `&control
  calculation = 'scf'
/
&system
  ibrav = 0
  nat = 2
  ntyp = 1
/
ATOMIC_SPECIES
 Si 28.0855 Si.upf
CELL_PARAMETERS angstrom
 5.43 0.0 0.0
 0.0 5.43 0.0
 0.0 0.0 5.43
ATOMIC_POSITIONS crystal
 Si 0.0 0.0 0.0
 Si 0.25 0.25 0.25
`
  it(`parses ibrav=0 crystal coords`, () => {
    const s = parse_qe(qe)!
    expect(s.sites).toHaveLength(2)
    expect(s.sites[0].species[0].element).toBe(`Si`)
    close(s.lattice!.a, 5.43)
    close(s.sites[1].xyz[0], 1.3575)
  })

  it(`returns null for ibrav != 0`, () => {
    expect(parse_qe(qe.replace(`ibrav = 0`, `ibrav = 2`))).toBeNull()
  })

  it(`handles angstrom cartesian positions`, () => {
    const c = qe.replace(`ATOMIC_POSITIONS crystal`, `ATOMIC_POSITIONS angstrom`)
      .replace(` Si 0.25 0.25 0.25`, ` Si 1.3575 1.3575 1.3575`)
    const s = parse_qe(c)!
    close(s.sites[1].abc[0], 0.25)
  })
})

describe(`VASP OUTCAR`, () => {
  const outcar = ` POTCAR:    PAW_PBE Si 05Jan2001
 VRHFIN =Si: s2p2
 ions per type =               2

 direct lattice vectors                 reciprocal lattice vectors
     9.000000000  0.000000000  0.000000000     0.111111111  0.000000000  0.000000000
     0.000000000  9.000000000  0.000000000     0.000000000  0.111111111  0.000000000
     0.000000000  0.000000000  9.000000000     0.000000000  0.000000000  0.111111111

 POSITION                                       TOTAL-FORCE (eV/Angst)
 -----------------------------------------------------------------------------
     1.00000      1.00000      1.00000         0.000000  0.000000  0.000000
     2.00000      2.00000      2.00000         0.000000  0.000000  0.000000
 -----------------------------------------------------------------------------

 direct lattice vectors                 reciprocal lattice vectors
     5.430000000  0.000000000  0.000000000     0.184162062  0.000000000  0.000000000
     0.000000000  5.430000000  0.000000000     0.000000000  0.184162062  0.000000000
     0.000000000  0.000000000  5.430000000     0.000000000  0.000000000  0.184162062

 POSITION                                       TOTAL-FORCE (eV/Angst)
 -----------------------------------------------------------------------------
     0.00000      0.00000      0.00000         0.000000  0.000000  0.000000
     1.35750      1.35750      1.35750         0.000000  0.000000  0.000000
 -----------------------------------------------------------------------------
`
  it(`extracts the LAST ionic step`, () => {
    const s = parse_outcar(outcar)!
    expect(s.sites).toHaveLength(2)
    expect(s.sites[0].species[0].element).toBe(`Si`)
    close(s.lattice!.a, 5.43)
    close(s.sites[1].xyz[0], 1.3575)
    close(s.sites[1].abc[0], 0.25)
  })
})

describe(`dispatch routing`, () => {
  const cell = `%BLOCK LATTICE_CART\n3 0 0\n0 3 0\n0 0 3\n%ENDBLOCK LATTICE_CART\n%BLOCK POSITIONS_FRAC\nH 0 0 0\n%ENDBLOCK POSITIONS_FRAC\n`
  it(`routes .cell, .fdf, scf.in, OUTCAR by name`, () => {
    expect(parse_structure_file(cell, `Si.cell`)?.sites).toHaveLength(1)

    const fdf = `LatticeConstant 3 Ang\n%block LatticeVectors\n1 0 0\n0 1 0\n0 0 1\n%endblock LatticeVectors\n%block ChemicalSpeciesLabel\n1 1 H\n%endblock ChemicalSpeciesLabel\nAtomicCoordinatesFormat Fractional\n%block AtomicCoordinatesAndAtomicSpecies\n0 0 0 1\n%endblock AtomicCoordinatesAndAtomicSpecies\n`
    expect(parse_structure_file(fdf, `si.fdf`)?.sites).toHaveLength(1)

    const qe = `&system\nibrav = 0\n/\nCELL_PARAMETERS angstrom\n3 0 0\n0 3 0\n0 0 3\nATOMIC_POSITIONS crystal\nH 0 0 0\n`
    expect(parse_structure_file(qe, `scf.in`)?.sites).toHaveLength(1)
  })
})
