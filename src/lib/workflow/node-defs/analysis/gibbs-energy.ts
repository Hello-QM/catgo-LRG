import type { NodeDefinition } from '../../workflow-types'

export const gibbs_energy: NodeDefinition = {
  type: `gibbs_energy`,
  label: `Gibbs Energy`,
  color: `#059669`,
  icon: `🌡️`,
  category: `Analysis`,
  description: `Compute Gibbs free energy from DFT energy + vibrational frequencies`,
  inputs: [`energy`, `frequencies`],
  outputs: [`gibbs`, `zpe`],
  default_params: {
    system_name: ``,
    phase: `adsorbed`,
    temperature: 298.15,
    freq_cutoff: 50,
    pressure_atm: 1.0,
    n_unpaired: 0,
  },
  help_text: `**Gibbs Energy** — Compute thermodynamic corrections to DFT energy.

## Formula

**G = E_DFT + ZPE − T·S**

Where:
- **E_DFT**: Electronic energy from upstream geo_opt / single_point node
- **ZPE**: Zero-point energy = Σ ½hν (from frequency calculation)
- **T·S**: Entropy correction at temperature T

## Phase Modes

### Adsorbed (surface-bound)
For adsorbates on surfaces. Uses **harmonic approximation** — only vibrational contributions.
Low frequencies below the cutoff are replaced by the cutoff value to avoid divergent entropy terms
(frustrated translations/rotations on the surface have poorly defined frequencies).

### Gas Phase (ideal gas)
For free molecules. Includes **translation + rotation + vibration** contributions
using ideal gas + rigid rotor + harmonic oscillator approximations.
Requires pressure and spin state (unpaired electrons for rotational symmetry).

## Typical Workflow
\`\`\`
structure_input → geo_opt → freq → gibbs_energy
\`\`\`
Connect the \`energy\` output from geo_opt and \`frequencies\` output from freq to this node.`,
  param_schema: [
    {
      key: `system_name`, label: `System Name`, type: `string`, default: ``,
      group: `General`,
      help: `Name for this system in the free energy diagram (e.g. "*OH", "slab", "H₂O(g)"). Used as the step label in the downstream Free Energy Diagram node.`,
    },
    {
      key: `phase`, label: `Phase`, type: `select`, default: `adsorbed`,
      group: `Thermodynamics`,
      options: [
        { label: `Adsorbed (surface-bound)`, value: `adsorbed` },
        { label: `Gas Phase (ideal gas)`, value: `gas` },
      ],
      help: `Adsorbed: vibrational entropy only (harmonic approx). Gas: full ideal gas partition function (translation + rotation + vibration).`,
    },
    {
      key: `temperature`, label: `Temperature (K)`, type: `number`, default: 298.15,
      group: `Thermodynamics`, min: 1, max: 5000, step: 0.01,
      help: `Temperature for entropy correction. Standard: 298.15 K.`,
    },
    {
      key: `freq_cutoff`, label: `Freq Cutoff (cm⁻¹)`, type: `number`, default: 50,
      group: `Thermodynamics`, min: 0, max: 200, step: 1,
      show_if: { key: `phase`, values: [`adsorbed`] },
      help: `Frequencies below this value are replaced by the cutoff. Prevents divergent entropy from frustrated translations/rotations on surfaces. Typical: 50 cm⁻¹.`,
    },
    {
      key: `pressure_atm`, label: `Pressure (atm)`, type: `number`, default: 1.0,
      group: `Thermodynamics`, min: 0.001, max: 1000, step: 0.1,
      show_if: { key: `phase`, values: [`gas`] },
      help: `Pressure for translational entropy (ideal gas). Standard: 1 atm.`,
    },
    {
      key: `n_unpaired`, label: `Unpaired Electrons`, type: `number`, default: 0,
      group: `Thermodynamics`, min: 0, max: 10, step: 1,
      show_if: { key: `phase`, values: [`gas`] },
      help: `Number of unpaired electrons. Affects spin multiplicity for rotational partition function. 0 for closed-shell molecules.`,
    },
  ],
}
