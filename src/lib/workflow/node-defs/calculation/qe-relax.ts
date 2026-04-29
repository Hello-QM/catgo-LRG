import type { NodeDefinition } from '../../workflow-types'

export const QE_RELAX_NODE: NodeDefinition = {
  type: `qe_relax`,
  label: `QE Relaxation`,
  color: `#0891b2`,
  icon: `\u269B`,
  category: `Calculation`,
  description: `Quantum ESPRESSO ionic/cell relaxation`,
  inputs: [`structure`],
  outputs: [`structure`, `energy`],
  default_params: { ecutwfc: 60, ecutrho: 480, kpoints: `4 4 4`, pseudopotentials: `SSSP`, smearing: `gaussian`, degauss: 0.01, occupations: `smearing`, charge: 0, nspin: 1, forc_conv_thr: 1e-3, press_conv_thr: 0.5, cell_dofree: `all` },
  help_text: `**Quantum ESPRESSO Relaxation** \u2014 Optimize atomic positions and optionally cell parameters.

Use \`relax\` for ions-only or \`vc-relax\` (variable-cell) for full optimization including lattice vectors.

**cell_dofree** controls which cell degrees of freedom are relaxed during vc-relax.`,
  param_schema: [
    {
      key: `ecutwfc`, label: `Wavefunction Cutoff (Ry)`, type: `number`, default: 60, group: `Basis`,
      min: 20, max: 200, step: 5,
      help: `Plane-wave kinetic energy cutoff for wavefunctions.`,
    },
    {
      key: `ecutrho`, label: `Charge Density Cutoff (Ry)`, type: `number`, default: 480, group: `Basis`,
      min: 100, max: 1600, step: 20,
      help: `Cutoff for charge density. Typically 8\u201312\u00D7 ecutwfc.`,
    },
    {
      key: `kpoints`, label: `K-Points Grid`, type: `string`, default: `4 4 4`, group: `K-Points`,
      help: `Monkhorst-Pack k-point mesh (e.g. "4 4 4").`,
    },
    {
      key: `pseudopotentials`, label: `Pseudopotential Library`, type: `select`, default: `SSSP`, group: `Basis`,
      options: [
        { label: `SSSP Efficiency`, value: `SSSP` },
        { label: `SSSP Precision`, value: `SSSP_precision` },
        { label: `PseudoDojo Standard`, value: `PseudoDojo` },
        { label: `PseudoDojo Stringent`, value: `PseudoDojo_stringent` },
      ],
      help: `Pseudopotential library.`,
    },
    {
      key: `occupations`, label: `Occupations`, type: `select`, default: `smearing`, group: `Electronic`,
      options: [
        { label: `Smearing (metals)`, value: `smearing` },
        { label: `Fixed (insulators)`, value: `fixed` },
        { label: `Tetrahedra (accurate DOS)`, value: `tetrahedra` },
      ],
      help: `Occupation scheme.`,
    },
    {
      key: `smearing`, label: `Smearing Type`, type: `select`, default: `gaussian`, group: `Electronic`,
      options: [
        { label: `Gaussian`, value: `gaussian` },
        { label: `Marzari-Vanderbilt (cold)`, value: `mv` },
        { label: `Methfessel-Paxton`, value: `mp` },
      ],
      show_if: { key: `occupations`, values: [`smearing`] },
      help: `Smearing function for partial occupations.`,
    },
    {
      key: `degauss`, label: `Smearing Width (Ry)`, type: `number`, default: 0.01, group: `Electronic`,
      min: 0.001, max: 0.1, step: 0.005,
      show_if: { key: `occupations`, values: [`smearing`] },
      help: `Gaussian broadening parameter in Ry.`,
    },
    {
      key: `nspin`, label: `Spin Polarization`, type: `select`, default: 1, group: `Electronic`,
      options: [
        { label: `Non-spin-polarized (1)`, value: 1 },
        { label: `Spin-polarized (2)`, value: 2 },
      ],
      help: `nspin=2 for magnetic systems.`,
    },
    {
      key: `charge`, label: `Total Charge`, type: `number`, default: 0, group: `System`,
      min: -10, max: 10, step: 1,
      help: `Net charge of the system.`,
    },
    {
      key: `forc_conv_thr`, label: `Force Convergence (Ry/bohr)`, type: `number`, default: 1e-3, group: `Convergence`,
      min: 1e-5, max: 0.1, step: 1e-4,
      help: `Convergence threshold on forces (Ry/bohr). Default 1e-3.`,
    },
    {
      key: `press_conv_thr`, label: `Pressure Convergence (kbar)`, type: `number`, default: 0.5, group: `Convergence`,
      min: 0.01, max: 10, step: 0.1,
      help: `Convergence threshold on pressure (kbar) for variable-cell relaxation.`,
    },
    {
      key: `cell_dofree`, label: `Cell DOF`, type: `select`, default: `all`, group: `Cell`,
      options: [
        { label: `all`, value: `all` },
        { label: `ibrav`, value: `ibrav` },
        { label: `x`, value: `x` },
        { label: `y`, value: `y` },
        { label: `z`, value: `z` },
        { label: `xy`, value: `xy` },
        { label: `xz`, value: `xz` },
        { label: `yz`, value: `yz` },
        { label: `xyz`, value: `xyz` },
        { label: `shape`, value: `shape` },
        { label: `volume`, value: `volume` },
        { label: `2Dxy`, value: `2Dxy` },
        { label: `2Dshape`, value: `2Dshape` },
      ],
      help: `Which cell degrees of freedom to relax. "all" = full vc-relax, "2Dxy"/"2Dshape" for 2D materials.`,
    },
  ],
}
