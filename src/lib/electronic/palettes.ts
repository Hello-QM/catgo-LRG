// src/lib/electronic/palettes.ts
/** Shared color palettes for electronic-structure plots (DOS / COHP / band). */

export const PALETTE_PRESETS = {
  default: [
    '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
    '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
  ],
  npg: [
    '#E64B35', '#4DBBD5', '#00A087', '#3C5488', '#F39B7F',
    '#8491B4', '#91D1C2', '#DC0000', '#7E6148', '#B09C85',
  ],
  aaas: [
    '#3B4992', '#EE0000', '#008B45', '#631879', '#008280',
    '#BB0021', '#5F559B', '#A20056', '#808180', '#1B1919',
  ],
  lancet: [
    '#00468B', '#ED0000', '#42B540', '#0099B4', '#925E9F',
    '#FDAF91', '#AD002A', '#ADB6B6', '#1B1919',
  ],
  nejm: [
    '#BC3C29', '#0072B5', '#E18727', '#20854E', '#7876B1',
    '#6F99AD', '#FFDC91', '#EE4C97',
  ],
  grayscale: [
    '#000000', '#595959', '#7f7f7f', '#a6a6a6', '#bfbfbf', '#d9d9d9',
  ],
} as const

export type PaletteName = keyof typeof PALETTE_PRESETS

/** Preset order for dropdowns. */
export const PALETTE_ORDER: PaletteName[] = [
  'default', 'npg', 'aaas', 'lancet', 'nejm', 'grayscale',
]

/** i18n key per preset; resolved by the caller via t(). */
export const PALETTE_LABEL_KEY: Record<PaletteName, string> = {
  default: 'structure.palette_default',
  npg: 'structure.palette_npg',
  aaas: 'structure.palette_aaas',
  lancet: 'structure.palette_lancet',
  nejm: 'structure.palette_nejm',
  grayscale: 'structure.palette_grayscale',
}

/** Assign a color to each label in order, cycling when labels outnumber colors. */
export function apply_palette(
  labels: string[],
  preset: PaletteName,
): Record<string, string> {
  const colors = PALETTE_PRESETS[preset]
  const out: Record<string, string> = {}
  labels.forEach((label, i) => {
    out[label] = colors[i % colors.length]
  })
  return out
}
