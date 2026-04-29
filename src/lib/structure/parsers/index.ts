// Re-export types and common utilities
export type { ParsedStructure } from './common'
export {
  normalize_scientific_notation,
  parse_coordinate,
  parse_coordinate_line,
  validate_element_symbol,
} from './common'

// Re-export format-specific parsers
export { parse_poscar, parse_vasprun_xml, count_vasprun_ionic_steps, parse_vasprun_trajectory } from './vasp'
export { parse_xyz } from './xyz'
export { parse_cif } from './cif'
export { parse_pdb } from './pdb'
export { parse_mol2 } from './mol2'
export { parse_lammps_data } from './lammps'
export { parse_cp2k } from './cp2k'
export { parse_phonopy_yaml } from './phonopy'
export type { PhonopyCell, PhonopyData, CellType } from './phonopy'

// Re-export JSON format parsers and converters
export {
  parse_optimade_json,
  parse_optimade_from_raw,
  is_optimade_json,
  is_optimade_raw,
  parse_pubchem_json,
  parsed_to_pymatgen,
  optimade_to_pymatgen,
  pubchem_to_pymatgen,
  find_structure_in_json,
} from './json-formats'

// Re-export dispatcher functions
export { parse_structure_file, parse_any_structure, is_structure_file, detect_structure_type } from './dispatch'
