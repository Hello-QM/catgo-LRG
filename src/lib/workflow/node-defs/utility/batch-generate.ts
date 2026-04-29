import type { NodeDefinition } from '../../workflow-types'

export const batch_generate: NodeDefinition = {
  type: `batch_generate`,
  label: `Batch Generate`,
  color: `#8b5cf6`,
  icon: `\u{1F522}`,
  category: `Tools`,
  description: `Generate multiple candidate structures from a parameter space`,
  inputs: [`structure`],
  outputs: [`structures`],
  default_params: {
    mode: `substituent`,
    elements: `Ti, V, Cr, Mn, Fe, Co, Ni, Cu`,
    sites: `all`,
    miller_indices: `100, 110, 111, 211`,
    slab_thickness: 4,
    vacuum: 15.0,
    adsorbate: `OH`,
    param_range: `0.95, 1.05`,
    n_points: 11,
    composition_template: ``,
    custom_script: ``,
  },
  help_text: `**Batch Generate** — Create N candidate structures from a parameter space for high-throughput screening.

## Modes

### Element Substitution
Try different elements at specified sites in the parent structure.
- **Elements**: comma-separated list (e.g. \`Ti, V, Cr, Mn, Fe\`)
- **Sites**: \`all\` replaces the most common element, or specify 0-based indices (e.g. \`0, 3, 7\`)
- Example: screen 3d transition metals as dopants in a perovskite

### Surface Miller Indices
Generate surface slabs for multiple Miller index orientations.
- **Miller Indices**: comma-separated (e.g. \`100, 110, 111, 211\`)
- **Slab Thickness**: number of atomic layers
- **Vacuum**: vacuum layer in Angstroms
- Example: compare surface energies of FCC metal facets

### Adsorbate Sites
Find all symmetry-unique adsorption sites on a surface and place an adsorbate.
- **Adsorbate**: molecule formula (e.g. \`OH\`, \`CO\`, \`OOH\`, \`H\`)
- Automatically finds ontop, bridge, and hollow sites
- Example: screen all adsorption sites for OER intermediates

### Lattice Parameter Scan
Scale the lattice parameter across a range (equation of state).
- **Scale Range**: min and max scale factors (e.g. \`0.95, 1.05\`)
- **Number of Points**: how many points to sample
- Example: fit an equation of state curve

### Composition Scan
Generate structures with varying composition ratios.
- **Template**: composition template with ranges (e.g. \`A_xB_{1-x}O3, x=0.0:0.25:1.0\`)
- Example: screen perovskite compositions

### Custom Python
Execute a user-provided Python generator function.
- Function signature: \`def generate(structure) -> list[Structure]\`
- Has access to \`ase\` and \`pymatgen\` in a restricted namespace
- Example: custom enumeration logic for complex screening

## Output
Produces a list of structures with metadata labels. Connect to a **Map (Parallel)** node to run calculations on each candidate.

## Screening Workflow Pattern
\`\`\`
Structure Input \u2192 Batch Generate \u2192 Map (Parallel) \u2192 [your calculation] \u2192 Aggregate & Filter
\`\`\`

### Practical examples
- **Dopant screening**: Element Substitution mode with 3d metals \u2192 Map \u2192 Geo Opt + Static \u2192 Aggregate by energy
- **Catalyst screening**: Adsorbate Sites mode \u2192 Map \u2192 Geo Opt \u2192 Aggregate by adsorption energy
- **Surface study**: Surface Miller Indices mode \u2192 Map \u2192 Geo Opt + Static \u2192 Aggregate by surface energy

### Tips
- Start with an **MLP** (machine learning potential) for fast pre-screening of many candidates
- Use the Aggregate node's **Top N** filter to select the best candidates
- Then run **DFT** only on the top candidates (two-stage screening saves compute time)
- For large screens (50+ structures), set Max Parallel Jobs on the Map node to avoid overwhelming HPC`,
  param_schema: [
    {
      key: `mode`, label: `Generation Mode`, type: `select`, default: `substituent`, group: `Generation`,
      options: [
        { label: `Element Substitution`, value: `substituent` },
        { label: `Surface Miller Indices`, value: `surface` },
        { label: `Adsorbate Sites`, value: `adsorbate` },
        { label: `Lattice Parameter Scan`, value: `lattice_scan` },
        { label: `Composition Scan`, value: `composition` },
        { label: `Custom Python`, value: `custom` },
      ],
      help: `Choose what parameter space to explore.`,
    },
    // --- Substituent mode ---
    {
      key: `elements`, label: `Elements to Try`, type: `string`, default: `Ti, V, Cr, Mn, Fe, Co, Ni, Cu`,
      group: `Substituent`,
      show_if: { key: `mode`, values: [`substituent`] },
      help: `Comma-separated list of element symbols to substitute.`,
    },
    {
      key: `sites`, label: `Sites to Substitute`, type: `string`, default: `all`,
      group: `Substituent`,
      show_if: { key: `mode`, values: [`substituent`] },
      help: `"all" replaces the most common element, or specify 0-based site indices (e.g. "0, 3, 7").`,
    },
    // --- Surface mode ---
    {
      key: `miller_indices`, label: `Miller Indices`, type: `string`, default: `100, 110, 111, 211`,
      group: `Surface`,
      show_if: { key: `mode`, values: [`surface`] },
      help: `Comma-separated Miller indices (e.g. "100, 110, 111"). Each generates one slab.`,
    },
    {
      key: `slab_thickness`, label: `Slab Thickness (layers)`, type: `number`, default: 4,
      group: `Surface`, min: 2, max: 12, step: 1,
      show_if: { key: `mode`, values: [`surface`] },
      help: `Number of atomic layers in each slab.`,
    },
    {
      key: `vacuum`, label: `Vacuum (Å)`, type: `number`, default: 15.0,
      group: `Surface`, min: 8.0, max: 30.0, step: 1.0,
      show_if: { key: `mode`, values: [`surface`] },
      help: `Vacuum layer thickness above the surface.`,
    },
    // --- Adsorbate mode ---
    {
      key: `adsorbate`, label: `Adsorbate`, type: `string`, default: `OH`,
      group: `Adsorbate`,
      show_if: { key: `mode`, values: [`adsorbate`] },
      help: `Adsorbate molecule (e.g. "OH", "CO", "OOH", "H", "H2O", "COOH").`,
    },
    // --- Lattice scan mode ---
    {
      key: `param_range`, label: `Scale Range (min, max)`, type: `string`, default: `0.95, 1.05`,
      group: `Lattice Scan`,
      show_if: { key: `mode`, values: [`lattice_scan`] },
      help: `Min and max lattice scale factors (e.g. "0.95, 1.05").`,
    },
    {
      key: `n_points`, label: `Number of Points`, type: `number`, default: 11,
      group: `Lattice Scan`, min: 3, max: 51, step: 2,
      show_if: { key: `mode`, values: [`lattice_scan`] },
      help: `Number of evenly spaced points between min and max.`,
    },
    // --- Composition mode ---
    {
      key: `composition_template`, label: `Composition Template`, type: `string`, default: ``,
      group: `Composition`,
      show_if: { key: `mode`, values: [`composition`] },
      help: `Template with ranges, e.g. "A_xB_{1-x}O3, x=0.0:0.25:1.0".`,
    },
    // --- Custom mode ---
    {
      key: `custom_script`, label: `Generator Script`, type: `text`, default: ``,
      group: `Custom`,
      show_if: { key: `mode`, values: [`custom`] },
      help: `Python function: def generate(structure) -> list[dict]. Has access to ase and pymatgen.`,
    },
  ],
}
