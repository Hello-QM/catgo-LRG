import type { NodeDefinition } from '../../workflow-types'

export const structure_list_input: NodeDefinition = {
  type: `structure_list_input`,
  label: `Structure List Input`,
  color: `#10b981`,
  icon: `📂`,
  category: `Input`,
  description: `Load multiple structures for parallel processing via Map node`,
  inputs: [],
  outputs: [`structures`],
  default_params: {
    source: `files`,
    structures_json: `[]`,
    count: 0,
  },
  param_schema: [
    {
      key: `source`,
      label: `Source`,
      type: `select`,
      default: `files`,
      options: [
        { label: `Upload Files`, value: `files` },
        { label: `From Database`, value: `database` },
        { label: `From Directory`, value: `directory` },
        { label: `SMILES List`, value: `smiles` },
      ],
      help: `How to load the structures.`,
    },
    {
      key: `count`,
      label: `Structures Loaded`,
      type: `number`,
      default: 0,
      help: `Number of structures currently loaded (read-only display).`,
    },
  ],
  help_text: `**Structure List Input** — Load multiple structures at once for batch processing.

### Usage
Connect this node's output to a **Map (Parallel)** node to run calculations on all structures simultaneously.

### Sources
- **Upload Files**: Drag & drop or browse for multiple structure files (POSCAR, CIF, XYZ, etc.)
- **From Database**: Select multiple structures from CatGo's local database
- **From Directory**: Load all structure files from a directory
- **SMILES List**: Enter SMILES strings (one per line) for molecular structures

### Example Workflow
\`\`\`
Structure List Input (100 files) → Map → [Geo Opt → Static] → Aggregate
\`\`\`

### Tips
- Supports all common formats: POSCAR, CIF, XYZ, PDB, extXYZ, LAMMPS data
- Structures can be a mix of different systems
- Check the "Structures Loaded" count before running`,
}
