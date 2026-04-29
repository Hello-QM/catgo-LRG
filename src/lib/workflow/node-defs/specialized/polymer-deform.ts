import type { NodeDefinition } from '../../workflow-types'

export const polymer_deform: NodeDefinition = {
  type: `polymer_deform`,
  label: `Polymer Deform`,
  color: `#c026d3`,
  icon: `\u21C4`,
  category: `Tools`,
  description: `Apply deformation to polymer (stress-strain)`,
  inputs: [`structure`],
  outputs: [`trajectory`, `stress_strain`],
  default_params: {
    deformation_type: `uniaxial`,
    strain_rate: 1e8,
    max_strain: 1.0,
    temperature: 300,
    deform_axis: `x`,
  },
  help_text: `**Polymer Deformation** — Apply mechanical deformation for stress-strain curves.`,
  param_schema: [
    {
      key: `deformation_type`, label: `Deformation Type`, type: `select`, default: `uniaxial`, group: `Deformation`,
      options: [
        { label: `Uniaxial (tension)`, value: `uniaxial` },
        { label: `Biaxial`, value: `biaxial` },
        { label: `Shear (xy)`, value: `shear_xy` },
        { label: `Shear (xz)`, value: `shear_xz` },
        { label: `Compression`, value: `compression` },
      ],
    },
    {
      key: `strain_rate`, label: `Strain Rate (1/s)`, type: `number`, default: 1e8, group: `Deformation`,
      min: 1e6, max: 1e10, step: 1e7,
    },
    {
      key: `max_strain`, label: `Max Strain`, type: `number`, default: 1.0, group: `Deformation`,
      min: 0.1, max: 5.0, step: 0.1,
    },
    {
      key: `temperature`, label: `Temperature (K)`, type: `number`, default: 300, group: `MD`,
      min: 100, max: 600, step: 10,
    },
    {
      key: `deform_axis`, label: `Deform Axis`, type: `select`, default: `x`, group: `Deformation`,
      options: [
        { label: `X-axis`, value: `x` },
        { label: `Y-axis`, value: `y` },
        { label: `Z-axis`, value: `z` },
      ],
    },
  ],
}
