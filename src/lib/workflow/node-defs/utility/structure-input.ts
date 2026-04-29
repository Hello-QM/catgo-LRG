import type { NodeDefinition } from '../../workflow-types'

export const structure_input: NodeDefinition = {
  type: `structure_input`,
  label: `Structure Input`,
  color: `#64748b`,
  icon: `\u{1F4C2}`,
  category: `Input`,
  description: `Load structure from file or database`,
  inputs: [],
  outputs: [`structure`],
  default_params: {},
  help_text: `**Structure Input** — Starting point for your workflow.

Load a crystal structure from:
- **File**: POSCAR, CIF, XYZ, LAMMPS data (.data/.lammps/.lmp), or any format supported by pymatgen
- **Materials Project**: Search by formula or MP-ID
- **ASE Database**: Load from previous calculations
- **Editor**: Draw or modify structure in CatGo's 3D viewer

The structure is passed to downstream nodes as input for calculations.`,
  param_schema: [],
}
