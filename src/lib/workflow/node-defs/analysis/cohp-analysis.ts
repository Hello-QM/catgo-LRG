import type { NodeDefinition } from '../../workflow-types'

export const cohp_analysis: NodeDefinition = {
  type: `cohp_analysis`,
  label: `COHP Analysis`,
  color: `#c026d3`,
  icon: `\u{1F517}`,
  category: `Analysis`,
  description: `Crystal Orbital Hamilton Population analysis`,
  inputs: [`data`],
  outputs: [`result`],
  default_params: { source: `parent_step`, bond_pairs: ``, include_orbitals: false, max_bonds: 20 },
  help_text: `**COHP Analysis** — Chemical bonding analysis.`,
  param_schema: [
    { key: `source`, label: `Data Source`, type: `select`, default: `parent_step`, group: `Analysis`,
      options: [
        { label: `From parent step output`, value: `parent_step` },
        { label: `From remote file`, value: `remote` },
      ],
    },
    { key: `bond_pairs`, label: `Bond Pairs`, type: `string`, default: ``, group: `COHP`,
      help: `Specific bond pairs to analyze (e.g. "Fe-N,Fe-O"). Empty = all pairs.`,
    },
    { key: `include_orbitals`, label: `Include Orbital Decomposition`, type: `boolean`, default: false, group: `COHP`,
      help: `Show orbital-resolved COHP (s-s, p-d, etc.). Increases output size.`,
    },
    { key: `max_bonds`, label: `Max Bonds`, type: `number`, default: 20, group: `COHP`,
      min: 1, max: 100, step: 5,
      help: `Limit the number of bonds to analyze (sorted by distance).`,
    },
  ],
}
