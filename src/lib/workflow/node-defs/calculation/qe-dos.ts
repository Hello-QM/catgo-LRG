import type { NodeDefinition } from '../../workflow-types'

export const QE_DOS_NODE: NodeDefinition = {
  type: `qe_dos`,
  label: `QE DOS`,
  color: `#0891b2`,
  icon: `\u269B`,
  category: `Calculation`,
  description: `Quantum ESPRESSO density of states calculation`,
  inputs: [`structure`, `charge_density`],
  outputs: [`dos`],
  default_params: { ecutwfc: 60, ecutrho: 480, degauss: 0.01, Emin: -20, Emax: 20, DeltaE: 0.01 },
  help_text: `**Quantum ESPRESSO DOS** \u2014 Compute the electronic density of states using dos.x.

Requires a prior SCF calculation with a dense k-point grid. The DOS is computed by tetrahedron integration or Gaussian broadening.`,
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
      key: `degauss`, label: `Broadening (Ry)`, type: `number`, default: 0.01, group: `DOS`,
      min: 0.001, max: 0.1, step: 0.005,
      help: `Gaussian broadening for DOS (Ry). Set to 0 for tetrahedron method.`,
    },
    {
      key: `Emin`, label: `Energy Min (eV)`, type: `number`, default: -20, group: `DOS`,
      min: -50, max: 0, step: 1,
      help: `Lower bound of energy window (eV, relative to Fermi level).`,
    },
    {
      key: `Emax`, label: `Energy Max (eV)`, type: `number`, default: 20, group: `DOS`,
      min: 0, max: 50, step: 1,
      help: `Upper bound of energy window (eV, relative to Fermi level).`,
    },
    {
      key: `DeltaE`, label: `Energy Step (eV)`, type: `number`, default: 0.01, group: `DOS`,
      min: 0.001, max: 0.5, step: 0.005,
      help: `Energy grid spacing for DOS output.`,
    },
  ],
}
