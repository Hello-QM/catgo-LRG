import type { NodeDefinition } from '../../workflow-types'

export const QE_SCF_NODE: NodeDefinition = {
  type: `qe_scf`,
  label: `QE SCF`,
  color: `#0891b2`,
  icon: `\u269B`,
  category: `Calculation`,
  description: `Quantum ESPRESSO self-consistent field calculation`,
  inputs: [`structure`],
  outputs: [`energy`, `charge_density`],
  default_params: { ecutwfc: 60, ecutrho: 480, kpoints: `4 4 4`, pseudopotentials: `SSSP`, smearing: `gaussian`, degauss: 0.01, occupations: `smearing`, charge: 0, nspin: 1 },
  help_text: `**Quantum ESPRESSO SCF** \u2014 Self-consistent field calculation using pw.x.

Computes the ground-state electron density and total energy for a fixed atomic geometry.

**Pseudopotentials:** SSSP (Standard Solid-State) or PseudoDojo libraries are recommended.
**Smearing:** Use Gaussian or Methfessel-Paxton for metals; fixed occupations for insulators.`,
  param_schema: [
    {
      key: `ecutwfc`, label: `Wavefunction Cutoff (Ry)`, type: `number`, default: 60, group: `Basis`,
      min: 20, max: 200, step: 5,
      help: `Plane-wave kinetic energy cutoff for wavefunctions. Higher = more accurate. 60 Ry is typical for SSSP.`,
    },
    {
      key: `ecutrho`, label: `Charge Density Cutoff (Ry)`, type: `number`, default: 480, group: `Basis`,
      min: 100, max: 1600, step: 20,
      help: `Cutoff for charge density / potential. Typically 8\u00D7ecutwfc for NC pseudopotentials, 12\u00D7 for US/PAW.`,
    },
    {
      key: `kpoints`, label: `K-Points Grid`, type: `string`, default: `4 4 4`, group: `K-Points`,
      help: `Monkhorst-Pack k-point mesh (e.g. "4 4 4"). Denser grids for metals/small cells.`,
    },
    {
      key: `pseudopotentials`, label: `Pseudopotential Library`, type: `select`, default: `SSSP`, group: `Basis`,
      options: [
        { label: `SSSP Efficiency`, value: `SSSP` },
        { label: `SSSP Precision`, value: `SSSP_precision` },
        { label: `PseudoDojo Standard`, value: `PseudoDojo` },
        { label: `PseudoDojo Stringent`, value: `PseudoDojo_stringent` },
      ],
      help: `Pseudopotential library. SSSP is well-tested for solids; PseudoDojo offers broader element coverage.`,
    },
    {
      key: `occupations`, label: `Occupations`, type: `select`, default: `smearing`, group: `Electronic`,
      options: [
        { label: `Smearing (metals)`, value: `smearing` },
        { label: `Fixed (insulators)`, value: `fixed` },
        { label: `Tetrahedra (accurate DOS)`, value: `tetrahedra` },
      ],
      help: `Occupation scheme. Use smearing for metals, fixed for insulators, tetrahedra for accurate total energies.`,
    },
    {
      key: `smearing`, label: `Smearing Type`, type: `select`, default: `gaussian`, group: `Electronic`,
      options: [
        { label: `Gaussian`, value: `gaussian` },
        { label: `Marzari-Vanderbilt (cold)`, value: `mv` },
        { label: `Methfessel-Paxton`, value: `mp` },
      ],
      show_if: { key: `occupations`, values: [`smearing`] },
      help: `Smearing function. Marzari-Vanderbilt (cold smearing) recommended for metals.`,
    },
    {
      key: `degauss`, label: `Smearing Width (Ry)`, type: `number`, default: 0.01, group: `Electronic`,
      min: 0.001, max: 0.1, step: 0.005,
      show_if: { key: `occupations`, values: [`smearing`] },
      help: `Gaussian broadening parameter in Ry. 0.01\u20130.02 Ry typical for metals.`,
    },
    {
      key: `nspin`, label: `Spin Polarization`, type: `select`, default: 1, group: `Electronic`,
      options: [
        { label: `Non-spin-polarized (1)`, value: 1 },
        { label: `Spin-polarized (2)`, value: 2 },
      ],
      help: `nspin=2 for magnetic systems. Requires starting_magnetization in species cards.`,
    },
    {
      key: `charge`, label: `Total Charge`, type: `number`, default: 0, group: `System`,
      min: -10, max: 10, step: 1,
      help: `Net charge of the system. 0=neutral, positive=cation, negative=anion.`,
    },
  ],
}
