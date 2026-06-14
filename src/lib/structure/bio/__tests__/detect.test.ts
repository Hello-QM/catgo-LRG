import { describe, expect, it } from 'vitest'
import { detect_bio } from '../detect'

const PROTEIN_PDB = `HEADER    OXYGEN TRANSPORT
SEQRES   1 A    3  VAL LEU SER
ATOM      1  N   VAL A   1      11.104  13.207  10.000  1.00 20.00           N
ATOM      2  CA  VAL A   1      12.560  13.100  10.100  1.00 20.00           C
ATOM      3  N   LEU A   2      13.000  14.000  10.200  1.00 20.00           N
ATOM      4  CA  SER A   3      14.000  15.000  10.300  1.00 20.00           C
END`

const NUCLEIC_PDB = `ATOM      1  P    DA A   1      11.000  13.000  10.000  1.00 20.00           P
ATOM      2  P    DT A   2      12.000  13.000  10.100  1.00 20.00           P
ATOM      3  P    DG A   3      13.000  14.000  10.200  1.00 20.00           P
END`

const LIGAND_PDB = `HETATM    1  C1  LIG A   1      11.000  13.000  10.000  1.00 20.00           C
HETATM    2  O1  LIG A   1      12.000  13.000  10.100  1.00 20.00           O
END`

const PROTEIN_MMCIF = `data_1ABC
loop_
_entity_poly.entity_id
_entity_poly.type
1 'polypeptide(L)'`

const CRYSTAL_CIF = `data_NaCl
_cell_length_a   5.64
_cell_length_b   5.64
_symmetry_space_group_name_H-M 'Fm-3m'
loop_
_atom_site_label
Na1 0 0 0`

describe('detect_bio', () => {
  it('flags a protein PDB (SEQRES + amino residues)', () => {
    const r = detect_bio(PROTEIN_PDB, 'prot.pdb')
    expect(r.isBio).toBe(true)
    expect(r.kind).toBe('protein')
    expect(r.format).toBe('pdb')
  })

  it('flags a nucleic-acid PDB', () => {
    const r = detect_bio(NUCLEIC_PDB, 'dna.pdb')
    expect(r.isBio).toBe(true)
    expect(r.kind).toBe('nucleic')
    expect(r.format).toBe('pdb')
  })

  it('does NOT flag a small-molecule/ligand-only PDB', () => {
    expect(detect_bio(LIGAND_PDB, 'lig.pdb').isBio).toBe(false)
  })

  it('flags a polypeptide mmCIF', () => {
    const r = detect_bio(PROTEIN_MMCIF, 'prot.cif')
    expect(r.isBio).toBe(true)
    expect(r.kind).toBe('protein')
    expect(r.format).toBe('mmcif')
  })

  it('does NOT flag a crystal CIF', () => {
    expect(detect_bio(CRYSTAL_CIF, 'nacl.cif').isBio).toBe(false)
  })

  it('does NOT flag a non-candidate extension (POSCAR)', () => {
    expect(detect_bio('Si\n1.0\n...', 'POSCAR').isBio).toBe(false)
  })
})
