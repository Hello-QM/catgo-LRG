import type { NodeDefinition } from '../../workflow-types'

export const phonon_analysis: NodeDefinition = {
  type: `phonon_analysis`,
  label: `Phonon Analysis`,
  color: `#db2777`,
  icon: `\u{1F4CA}`,
  category: `Analysis`,
  description: `Phonon post-processing (phonopy wrapper)`,
  inputs: [`displacement_forces`],
  outputs: [`phonon_band`, `phonon_dos`, `thermodynamics`],
  default_params: { mesh: `20 20 20`, tmin: 0, tmax: 1000, tstep: 10, band_path: `auto` },
  help_text: `**Phonon Analysis** \u2014 Post-process displacement-force data to obtain phonon band structure, DOS, and thermodynamic properties.

Wraps phonopy for force-constant extraction and Fourier interpolation.

**mesh:** q-point mesh for phonon DOS integration.
**band_path:** High-symmetry path for phonon dispersion. "auto" uses SeeK-path to determine the standard path.
**Thermodynamics:** Computes Helmholtz free energy, entropy, and heat capacity from tmin to tmax.`,
  param_schema: [
    {
      key: `mesh`, label: `Q-Point Mesh`, type: `string`, default: `20 20 20`, group: `Phonon`,
      help: `Mesh for phonon DOS (e.g. "20 20 20"). Denser mesh gives smoother DOS.`,
    },
    {
      key: `band_path`, label: `Band Path`, type: `string`, default: `auto`, group: `Phonon`,
      help: `High-symmetry k-path for phonon dispersion. "auto" = determine from crystal symmetry via SeeK-path.`,
    },
    {
      key: `tmin`, label: `T min (K)`, type: `number`, default: 0, group: `Thermodynamics`,
      min: 0, max: 500, step: 10,
      help: `Minimum temperature for thermodynamic property calculation.`,
    },
    {
      key: `tmax`, label: `T max (K)`, type: `number`, default: 1000, group: `Thermodynamics`,
      min: 100, max: 3000, step: 100,
      help: `Maximum temperature for thermodynamic property calculation.`,
    },
    {
      key: `tstep`, label: `T step (K)`, type: `number`, default: 10, group: `Thermodynamics`,
      min: 1, max: 100, step: 5,
      help: `Temperature step for thermodynamic property calculation.`,
    },
  ],
}
