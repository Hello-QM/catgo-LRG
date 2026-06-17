/**
 * Content sniffer: decide whether a file is a biological macromolecule
 * (protein / nucleic acid) that should render in Mol* rather than the native
 * viewer. Pure function — no I/O, fully unit-tested.
 *
 * Only PDB and (mm)CIF extensions are candidates; within those we sniff content
 * (heuristic B). Conservative: when ambiguous, return isBio:false so the file
 * falls through to the native pipeline (the user can still force Mol* via the
 * manual override).
 */

export type BioKind = 'protein' | 'nucleic' | 'mixed'
export type BioFormat = 'pdb' | 'mmcif'

export interface BioDetectResult {
  isBio: boolean
  kind: BioKind | null
  /** Mol* BuiltInTrajectoryFormat string to feed loadStructureFromData. */
  format: BioFormat | null
  /** Human-readable explanation (drives the override hint + debugging). */
  reason: string
}

const AMINO = new Set([
  'ALA', 'ARG', 'ASN', 'ASP', 'CYS', 'GLN', 'GLU', 'GLY', 'HIS', 'ILE',
  'LEU', 'LYS', 'MET', 'PHE', 'PRO', 'SER', 'THR', 'TRP', 'TYR', 'VAL',
  'SEC', 'PYL', 'MSE', 'HSD', 'HSE', 'HSP',
])
const NUCLEIC = new Set([
  'DA', 'DT', 'DG', 'DC', 'DU', 'A', 'U', 'G', 'C', 'I',
  'RA', 'RU', 'RG', 'RC',
])

function ext_of(filename: string): string {
  return filename.replace(/\.(gz|bz2|xz|zst)$/i, '').split('.').pop()?.toLowerCase() || ''
}

function not_bio(format: BioFormat | null, reason: string): BioDetectResult {
  return { isBio: false, kind: null, format: null, reason }
}

function bio(kind: BioKind, format: BioFormat, reason: string): BioDetectResult {
  return { isBio: true, kind, format, reason }
}

function detect_pdb(text: string): BioDetectResult {
  const amino_res = new Set<string>()
  const nucleic_res = new Set<string>()
  let has_seqres = false
  let has_helix_sheet = false

  for (const ln of text.split(/\r?\n/)) {
    const rec = ln.slice(0, 6).trim()
    if (rec === 'SEQRES') has_seqres = true
    if (rec === 'HELIX' || rec === 'SHEET') has_helix_sheet = true
    if (rec === 'ATOM' || rec === 'HETATM') {
      const res = ln.slice(17, 20).trim().toUpperCase()
      const res_key = ln.slice(21, 26) // chainID + resSeq
      if (AMINO.has(res)) amino_res.add(res_key)
      else if (NUCLEIC.has(res)) nucleic_res.add(res_key)
    }
  }

  const protein_like = has_seqres || has_helix_sheet || amino_res.size >= 3
  const nucleic_like = nucleic_res.size >= 2

  if (protein_like && nucleic_like) {
    return bio('mixed', 'pdb', 'protein + nucleic residues present')
  }
  if (protein_like) {
    const why = has_seqres
      ? 'SEQRES record present'
      : has_helix_sheet
      ? 'HELIX/SHEET record present'
      : `${amino_res.size} amino-acid residues`
    return bio('protein', 'pdb', why)
  }
  if (nucleic_like) return bio('nucleic', 'pdb', `${nucleic_res.size} nucleotide residues`)
  return not_bio('pdb', `no polymer markers (amino=${amino_res.size}, nucleic=${nucleic_res.size})`)
}

function detect_cif(text: string): BioDetectResult {
  const t = text.toLowerCase()
  const protein = t.includes('polypeptide')
  const nucleic = t.includes('polyribonucleotide') || t.includes('polydeoxyribonucleotide')
  const has_conf = t.includes('_struct_conf') || t.includes('_struct_sheet')

  if (protein && nucleic) return bio('mixed', 'mmcif', '_entity_poly: protein + nucleic')
  if (protein) return bio('protein', 'mmcif', '_entity_poly polypeptide')
  if (nucleic) return bio('nucleic', 'mmcif', '_entity_poly polynucleotide')
  if (has_conf) return bio('protein', 'mmcif', '_struct_conf/_struct_sheet present')
  return not_bio('mmcif', 'no _entity_poly polypeptide/nucleotide markers')
}

export function detect_bio(text: string, filename: string): BioDetectResult {
  const ext = ext_of(filename)
  if (ext === 'pdb' || ext === 'ent') return detect_pdb(text)
  if (ext === 'cif' || ext === 'mmcif' || ext === 'mcif') return detect_cif(text)
  return not_bio(null, `.${ext} is not a bio-candidate extension`)
}
