import type { NodeDefinition } from '../../workflow-types'

export const QE_BANDS_NODE: NodeDefinition = {
  type: `qe_bands`,
  label: `QE Band Structure`,
  color: `#0891b2`,
  icon: `\u269B`,
  category: `Calculation`,
  description: `Quantum ESPRESSO band structure calculation`,
  inputs: [`structure`, `charge_density`],
  outputs: [`band`],
  default_params: { ecutwfc: 60, ecutrho: 480, nbnd: 0 },
  help_text: `**Quantum ESPRESSO Bands** \u2014 Non-self-consistent band structure along high-symmetry k-path.

Requires a prior SCF calculation to provide the converged charge density. The k-path is automatically determined from the crystal symmetry (via SeeK-path or manually specified).

Set **nbnd=0** to use the default number of bands (auto).`,
  param_schema: [
    {
      key: `ecutwfc`, label: `Wavefunction Cutoff (Ry)`, type: `number`, default: 60, group: `Basis`,
      min: 20, max: 200, step: 5,
      help: `Plane-wave cutoff. Must match the preceding SCF calculation.`,
    },
    {
      key: `ecutrho`, label: `Charge Density Cutoff (Ry)`, type: `number`, default: 480, group: `Basis`,
      min: 100, max: 1600, step: 20,
      help: `Charge density cutoff. Must match the preceding SCF calculation.`,
    },
    {
      key: `nbnd`, label: `Number of Bands`, type: `number`, default: 0, group: `Bands`,
      min: 0, max: 500, step: 1,
      help: `Number of bands to compute. 0 = automatic (use QE default). Increase to see unoccupied states.`,
    },
  ],
}
