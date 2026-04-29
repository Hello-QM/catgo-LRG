import type { NodeDefinition } from '../../workflow-types'
import { INCAR_COMMON, KPOINTS_PARAM, PARALLELIZATION_PARAMS } from '../common'

export const electronic: NodeDefinition = {
  type: `electronic`,
  label: `Electronic`,
  color: `#ec4899`,
  icon: `\u{1F52E}`,
  category: `Analysis`,
  description: `DOS, pCOHP, Bader charge analysis`,
  inputs: [`structure`],
  outputs: [`dos`, `cohp`, `charges`],
  default_params: { analysis: `dos,bader`, NEDOS: 3001 },
  help_text: `**Electronic Structure Analysis** — Run a static calculation with settings optimized for electronic analysis (DOS, Bader, pCOHP).`,
  param_schema: [
    ...INCAR_COMMON,
    {
      key: `analysis`, label: `Analysis Types`, type: `string`, default: `dos,bader`, group: `Analysis`,
      help: `Comma-separated: dos, bader, cohp.`,
    },
    {
      key: `NEDOS`, label: `DOS Points`, type: `number`, default: 3001, group: `INCAR`,
      min: 301, max: 10001, step: 500,
    },
    KPOINTS_PARAM,
    ...PARALLELIZATION_PARAMS,
  ],
}
