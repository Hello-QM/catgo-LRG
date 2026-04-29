import type { NodeDefinition } from '../../workflow-types'

export const charge_analysis: NodeDefinition = {
  type: `charge_analysis`,
  label: `Charge Analysis`,
  color: `#fb7185`,
  icon: `\u26A1`,
  category: `Analysis`,
  description: `Bader/DDEC charge analysis`,
  inputs: [`data`],
  outputs: [`result`],
  default_params: { method: `bader`, reference: `aeccar` },
  help_text: `**Charge Analysis** — Atomic charge decomposition.`,
  param_schema: [
    { key: `method`, label: `Charge Method`, type: `select`, default: `bader`, group: `Charge`,
      options: [
        { label: `Bader (QTAIM)`, value: `bader` },
        { label: `DDEC6`, value: `ddec6` },
      ],
      help: `Bader requires CHGCAR + AECCAR0 + AECCAR2 (set LAECHG=True in parent VASP static calculation).`,
    },
    { key: `reference`, label: `Reference Charges`, type: `select`, default: `aeccar`, group: `Charge`,
      options: [
        { label: `AECCAR (all-electron, recommended)`, value: `aeccar` },
        { label: `None (use CHGCAR only)`, value: `none` },
      ],
      show_if: { key: `method`, values: [`bader`] },
      help: `Reference charge density for Bader partitioning. AECCAR = AECCAR0 + AECCAR2.`,
    },
  ],
}
