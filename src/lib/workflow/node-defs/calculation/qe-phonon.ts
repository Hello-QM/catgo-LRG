import type { NodeDefinition } from '../../workflow-types'

export const QE_PHONON_NODE: NodeDefinition = {
  type: `qe_phonon`,
  label: `QE Phonon`,
  color: `#0891b2`,
  icon: `\u269B`,
  category: `Calculation`,
  description: `Quantum ESPRESSO phonon calculation (ph.x)`,
  inputs: [`structure`, `charge_density`],
  outputs: [`displacement_forces`, `phonon_band`, `phonon_dos`],
  default_params: { ecutwfc: 60, ecutrho: 480, tr2_ph: 1e-12, ldisp: true, nq1: 2, nq2: 2, nq3: 2 },
  help_text: `**Quantum ESPRESSO Phonon** \u2014 Compute phonon frequencies using density-functional perturbation theory (ph.x).

Requires a prior SCF calculation. Can compute phonons at \u0393 only or on a regular q-point grid (ldisp=true).

**ldisp:** Enable q-point grid for full phonon dispersion. Set nq1/nq2/nq3 for the q-mesh.
**tr2_ph:** Self-consistency threshold for the phonon calculation (smaller = tighter).`,
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
      key: `tr2_ph`, label: `Convergence Threshold`, type: `number`, default: 1e-12, group: `Phonon`,
      min: 1e-16, max: 1e-8, step: 1e-13,
      help: `Self-consistency threshold for the phonon calculation. Default 1e-12; tighter values for accurate frequencies.`,
    },
    {
      key: `ldisp`, label: `Q-Point Grid`, type: `boolean`, default: true, group: `Phonon`,
      help: `If true, compute phonons on a regular q-point grid (for dispersion). If false, \u0393-point only.`,
    },
    {
      key: `nq1`, label: `nq1`, type: `number`, default: 2, group: `Q-Grid`,
      min: 1, max: 12, step: 1,
      show_if: { key: `ldisp`, values: [true, `true`] },
      help: `Number of q-points along first reciprocal lattice vector.`,
    },
    {
      key: `nq2`, label: `nq2`, type: `number`, default: 2, group: `Q-Grid`,
      min: 1, max: 12, step: 1,
      show_if: { key: `ldisp`, values: [true, `true`] },
      help: `Number of q-points along second reciprocal lattice vector.`,
    },
    {
      key: `nq3`, label: `nq3`, type: `number`, default: 2, group: `Q-Grid`,
      min: 1, max: 12, step: 1,
      show_if: { key: `ldisp`, values: [true, `true`] },
      help: `Number of q-points along third reciprocal lattice vector.`,
    },
  ],
}
