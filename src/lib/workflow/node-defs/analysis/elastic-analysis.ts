import type { NodeDefinition } from '../../workflow-types'

export const elastic_analysis: NodeDefinition = {
  type: `elastic_analysis`,
  label: `Elastic Analysis`,
  color: `#db2777`,
  icon: `\u{1F4CA}`,
  category: `Analysis`,
  description: `Elastic tensor analysis from deformation data`,
  inputs: [`deformation_data`],
  outputs: [`elastic_tensor`],
  default_params: { strain_magnitude: 0.01, symmetry_reduce: true },
  help_text: `**Elastic Analysis** \u2014 Compute the elastic tensor from stress-strain deformation data.

Derives the full elastic stiffness tensor (C\u1D62\u2C7C) from a set of deformed structures with computed stresses. Computes derived mechanical properties: bulk modulus (Voigt/Reuss/Hill), shear modulus, Young's modulus, and Poisson's ratio.

**symmetry_reduce:** Use crystal symmetry to reduce the number of independent deformations needed.`,
  param_schema: [
    {
      key: `strain_magnitude`, label: `Strain Magnitude`, type: `number`, default: 0.01, group: `Deformation`,
      min: 0.001, max: 0.1, step: 0.005,
      help: `Applied strain magnitude for each deformation. 0.01 (1%) is standard; smaller for stiff materials.`,
    },
    {
      key: `symmetry_reduce`, label: `Symmetry Reduction`, type: `boolean`, default: true, group: `Deformation`,
      help: `Use crystal symmetry to reduce independent deformations. Highly recommended for cubic/hexagonal systems.`,
    },
  ],
}
