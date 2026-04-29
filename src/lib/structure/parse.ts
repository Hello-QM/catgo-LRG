// This file re-exports all parsing functionality from the parsers/ directory.
// The actual parser implementations live in parsers/*.ts for maintainability.

export type { ParsedStructure } from './parsers/common'
export {
  normalize_scientific_notation,
  parse_coordinate,
  parse_coordinate_line,
  validate_element_symbol,
} from './parsers/common'

export { parse_poscar, parse_vasprun_xml, count_vasprun_ionic_steps, parse_vasprun_trajectory } from './parsers/vasp'
export { parse_xyz } from './parsers/xyz'
export { parse_cif } from './parsers/cif'
export { parse_pdb } from './parsers/pdb'
export { parse_mol2 } from './parsers/mol2'
export { parse_lammps_data } from './parsers/lammps'
export { parse_cp2k } from './parsers/cp2k'
export { parse_phonopy_yaml } from './parsers/phonopy'
export type { PhonopyCell, PhonopyData, CellType } from './parsers/phonopy'

export {
  parse_optimade_json,
  parse_optimade_from_raw,
  is_optimade_json,
  is_optimade_raw,
  parse_pubchem_json,
  parsed_to_pymatgen,
  optimade_to_pymatgen,
  pubchem_to_pymatgen,
} from './parsers/json-formats'

export { parse_structure_file, parse_any_structure, is_structure_file, detect_structure_type } from './parsers/dispatch'
