import type { PymatgenStructure } from '$lib/structure'
import { SERVER_URL } from './config'

function format_error_detail(detail: unknown): string {
  if (typeof detail === `string`) return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        if (typeof d === `object` && d?.msg) {
          const loc = Array.isArray(d.loc) ? d.loc.join(`.`) : ``
          return loc ? `${d.msg} (${loc})` : d.msg
        }
        return JSON.stringify(d)
      })
      .join(`; `)
  }
  return JSON.stringify(detail)
}

/** A preset adsorbate molecule with xyz coordinates and default binding atom. */
export interface AdsorbatePreset {
  name: string
  formula: string
  atoms: { symbol: string; position: [number, number, number] }[]
  default_binding_index: number
  group?: string
}

// Helper to define presets concisely: [symbol, x, y, z]
type A = { symbol: string; position: [number, number, number] }
const _a = (s: string, x: number, y: number, z: number): A => ({ symbol: s, position: [x, y, z] })
const _p = (name: string, formula: string, group: string, atoms: A[], bind = 0): AdsorbatePreset =>
  ({ name, formula, group, atoms, default_binding_index: bind })

/** Grouped adsorbate presets for electrocatalysis screening. */
export const ADSORBATE_PRESET_GROUPS: { label: string; presets: AdsorbatePreset[] }[] = [
  {
    label: `Common`,
    presets: [
      _p(`Atomic hydrogen`, `H`, `Common`, [_a(`H`, 0, 0, 0)]),
      _p(`Atomic oxygen`, `O`, `Common`, [_a(`O`, 0, 0, 0)]),
      _p(`Hydroxyl`, `OH`, `Common`, [_a(`O`, 0, 0, 0), _a(`H`, 0, 0, 0.97)]),
      _p(`Water`, `H₂O`, `Common`, [_a(`O`, 0, 0, 0), _a(`H`, 0.757, 0, 0.586), _a(`H`, -0.757, 0, 0.586)]),
      _p(`Carbon monoxide`, `CO`, `Common`, [_a(`C`, 0, 0, 0), _a(`O`, 0, 0, 1.128)]),
      _p(`Nitric oxide`, `NO`, `Common`, [_a(`N`, 0, 0, 0), _a(`O`, 0, 0, 1.151)]),
      _p(`Nitrogen dioxide`, `NO₂`, `Common`, [_a(`N`, 0, 0, 0), _a(`O`, 1.098, 0, 0.465), _a(`O`, -1.098, 0, 0.465)]),
      _p(`Ammonia`, `NH₃`, `Common`, [_a(`N`, 0, 0, 0), _a(`H`, 0.939, 0, -0.381), _a(`H`, -0.470, 0.813, -0.381), _a(`H`, -0.470, -0.813, -0.381)]),
      _p(`Methyl`, `CH₃`, `Common`, [_a(`C`, 0, 0, 0), _a(`H`, 1.026, 0, -0.363), _a(`H`, -0.513, 0.889, -0.363), _a(`H`, -0.513, -0.889, -0.363)]),
    ],
  },
  {
    label: `OER / ORR`,
    presets: [
      _p(`Oxygen`, `O`, `OER`, [_a(`O`, 0, 0, 0)]),
      _p(`Hydroxyl`, `OH`, `OER`, [_a(`O`, 0, 0, 0), _a(`H`, 0, 0, 0.97)]),
      _p(`Hydroperoxyl`, `OOH`, `OER`, [_a(`O`, 0, 0, 0), _a(`O`, 1.28, 0, 0.70), _a(`H`, 1.28, 0.80, 1.20)]),
      _p(`Molecular oxygen`, `O₂`, `ORR`, [_a(`O`, 0, 0, 0), _a(`O`, 0, 0, 1.21)]),
      _p(`Hydrogen peroxide`, `H₂O₂`, `ORR`, [_a(`O`, 0, 0, 0), _a(`O`, 1.21, 0, 0.73), _a(`H`, -0.52, 0, -0.76), _a(`H`, 1.73, 0, -0.03)]),
    ],
  },
  {
    label: `CO₂RR / CORR`,
    presets: [
      // C1 pathway
      _p(`Carbon dioxide`, `CO₂`, `CO₂RR`, [_a(`C`, 0, 0, 0), _a(`O`, -1.16, 0, 0), _a(`O`, 1.16, 0, 0)]),
      _p(`Carboxyl`, `COOH`, `CO₂RR`, [_a(`C`, 0, 0, 0), _a(`O`, 1.208, 0, 0), _a(`O`, -0.396, 1.171, 0), _a(`H`, 0.164, 1.882, 0)]),
      _p(`Formate`, `OCHO`, `CO₂RR`, [_a(`O`, -1.08, 0, -0.63), _a(`C`, 0, 0, 0), _a(`H`, 0, 0, 1.10), _a(`O`, 1.08, 0, -0.63)], 1),
      _p(`Carbon monoxide`, `CO`, `CO₂RR`, [_a(`C`, 0, 0, 0), _a(`O`, 0, 0, 1.128)]),
      _p(`Formyl`, `CHO`, `CO₂RR`, [_a(`C`, 0, 0, 0), _a(`H`, 1.09, 0, 0.12), _a(`O`, -0.58, 0, 1.03)]),
      _p(`Hydroxymethylidyne`, `COH`, `CO₂RR`, [_a(`C`, 0, 0, 0), _a(`O`, 0, 0, 1.31), _a(`H`, 0, 0.87, 1.70)]),
      _p(`Hydroxymethylene`, `CHOH`, `CO₂RR`, [_a(`C`, 0, 0, 0), _a(`H`, 1.09, 0, -0.12), _a(`O`, -0.40, 0, 1.22), _a(`H`, -0.40, 0.76, 1.70)]),
      _p(`Formaldehyde`, `CH₂O`, `CO₂RR`, [_a(`C`, 0, 0, 0), _a(`H`, 0.93, 0, -0.56), _a(`H`, -0.93, 0, -0.56), _a(`O`, 0, 0, 1.20)]),
      _p(`Hydroxymethyl`, `CH₂OH`, `CO₂RR`, [_a(`C`, 0, 0, 0), _a(`H`, 0.93, 0, -0.56), _a(`H`, -0.93, 0, -0.56), _a(`O`, 0, 0, 1.43), _a(`H`, 0, 0.76, 1.85)]),
      _p(`Methoxy`, `OCH₃`, `CO₂RR`, [_a(`O`, 0, 0, 0), _a(`C`, 1.22, 0, 0.60), _a(`H`, 1.22, 0.89, 1.22), _a(`H`, 1.22, -0.89, 1.22), _a(`H`, 2.12, 0, 0.10)]),
      _p(`Methylidyne`, `CH`, `CO₂RR`, [_a(`C`, 0, 0, 0), _a(`H`, 0, 0, 1.09)]),
      _p(`Methylene`, `CH₂`, `CO₂RR`, [_a(`C`, 0, 0, 0), _a(`H`, 0.93, 0, 0.56), _a(`H`, -0.93, 0, 0.56)]),
      _p(`Methyl`, `CH₃`, `CO₂RR`, [_a(`C`, 0, 0, 0), _a(`H`, 1.026, 0, -0.363), _a(`H`, -0.513, 0.889, -0.363), _a(`H`, -0.513, -0.889, -0.363)]),
      // C2 pathway
      _p(`CO dimer`, `OCCO`, `CO₂RR`, [_a(`O`, -1.80, 0, 0.58), _a(`C`, -0.76, 0, 0), _a(`C`, 0.76, 0, 0), _a(`O`, 1.80, 0, 0.58)], 1),
      _p(`CO dimer + H`, `OCCOH`, `CO₂RR`, [_a(`O`, -1.80, 0, 0.58), _a(`C`, -0.76, 0, 0), _a(`C`, 0.76, 0, 0), _a(`O`, 1.80, 0, 0.58), _a(`H`, 2.30, 0, -0.22)], 1),
      _p(`Ketene`, `CH₂CO`, `CO₂RR`, [_a(`C`, 0, 0, 0), _a(`H`, 0.93, 0, -0.56), _a(`H`, -0.93, 0, -0.56), _a(`C`, 0, 0, 1.31), _a(`O`, 0, 0, 2.44)]),
      _p(`Acetaldehyde frag.`, `CH₃CHO`, `CO₂RR`, [_a(`C`, 0, 0, 0), _a(`H`, 0, 0, 1.09), _a(`O`, -0.58, 0, -0.95), _a(`C`, 1.50, 0, -0.20), _a(`H`, 1.50, 0.89, -0.82), _a(`H`, 1.50, -0.89, -0.82), _a(`H`, 2.40, 0, 0.40)]),
      _p(`Vinyl alkoxy`, `OCHCH₂`, `CO₂RR`, [_a(`O`, 0, 0, 0), _a(`C`, 1.22, 0, 0.40), _a(`H`, 1.22, 0, 1.50), _a(`C`, 2.38, 0, -0.20), _a(`H`, 2.38, 0.93, -0.80), _a(`H`, 2.38, -0.93, -0.80)]),
      _p(`Ethoxy`, `OCH₂CH₃`, `CO₂RR`, [_a(`O`, 0, 0, 0), _a(`C`, 1.24, 0, 0.60), _a(`H`, 1.24, 0.89, 1.22), _a(`H`, 1.24, -0.89, 1.22), _a(`C`, 2.48, 0, -0.26), _a(`H`, 2.48, 0.89, -0.88), _a(`H`, 2.48, -0.89, -0.88), _a(`H`, 3.38, 0, 0.34)]),
      _p(`Acetaldehyde`, `OCHCH₃`, `CO₂RR`, [_a(`O`, 0, 0, 0), _a(`C`, 1.22, 0, 0.40), _a(`H`, 1.22, 0, 1.50), _a(`C`, 2.48, 0, -0.26), _a(`H`, 2.48, 0.89, -0.88), _a(`H`, 2.48, -0.89, -0.88), _a(`H`, 3.38, 0, 0.34)]),
    ],
  },
  {
    label: `NRR`,
    presets: [
      _p(`Dinitrogen`, `N₂`, `NRR`, [_a(`N`, 0, 0, 0), _a(`N`, 0, 0, 1.10)]),
      _p(`Diazenyl`, `NNH`, `NRR`, [_a(`N`, 0, 0, 0), _a(`N`, 0, 0, 1.20), _a(`H`, 0.87, 0, 1.68)]),
      _p(`Diazenyl + H`, `NNH₂`, `NRR`, [_a(`N`, 0, 0, 0), _a(`N`, 0, 0, 1.20), _a(`H`, 0.80, 0, 1.75), _a(`H`, -0.80, 0, 1.75)]),
      _p(`Diazene`, `NHNH`, `NRR`, [_a(`N`, 0, 0, 0), _a(`H`, 0.87, 0, -0.48), _a(`N`, 0, 0, 1.24), _a(`H`, -0.87, 0, 1.72)]),
      _p(`Hydrazinyl`, `NH₂NH`, `NRR`, [_a(`N`, 0, 0, 0), _a(`H`, 0.87, 0, -0.48), _a(`H`, -0.87, 0, -0.48), _a(`N`, 0, 0, 1.40), _a(`H`, 0.87, 0, 1.88)]),
      _p(`Hydrazine`, `NH₂NH₂`, `NRR`, [_a(`N`, 0, 0, 0), _a(`H`, 0.87, 0, -0.48), _a(`H`, -0.87, 0, -0.48), _a(`N`, 0, 0, 1.45), _a(`H`, 0.87, 0, 1.93), _a(`H`, -0.87, 0, 1.93)]),
      _p(`NH₃—NH`, `NH₃NH`, `NRR`, [_a(`N`, 0, 0, 0), _a(`H`, 0.94, 0, -0.38), _a(`H`, -0.47, 0.81, -0.38), _a(`H`, -0.47, -0.81, -0.38), _a(`N`, 0, 0, 1.45), _a(`H`, 0.87, 0, 1.93)], 4),
      _p(`NH₃—NH₂`, `NH₃NH₂`, `NRR`, [_a(`N`, 0, 0, 0), _a(`H`, 0.94, 0, -0.38), _a(`H`, -0.47, 0.81, -0.38), _a(`H`, -0.47, -0.81, -0.38), _a(`N`, 0, 0, 1.45), _a(`H`, 0.87, 0, 1.93), _a(`H`, -0.87, 0, 1.93)], 4),
      _p(`Atomic nitrogen`, `N`, `NRR`, [_a(`N`, 0, 0, 0)]),
      _p(`Imido`, `NH`, `NRR`, [_a(`N`, 0, 0, 0), _a(`H`, 0, 0, 1.04)]),
      _p(`Amino`, `NH₂`, `NRR`, [_a(`N`, 0, 0, 0), _a(`H`, 0.80, 0, 0.60), _a(`H`, -0.80, 0, 0.60)]),
      _p(`Ammonia`, `NH₃`, `NRR`, [_a(`N`, 0, 0, 0), _a(`H`, 0.939, 0, -0.381), _a(`H`, -0.470, 0.813, -0.381), _a(`H`, -0.470, -0.813, -0.381)]),
    ],
  },
  {
    label: `NO₃RR`,
    presets: [
      _p(`Nitrate`, `NO₃`, `NO₃RR`, [_a(`N`, 0, 0, 0), _a(`O`, 1.08, 0, 0.63), _a(`O`, -0.54, 0.94, 0.63), _a(`O`, -0.54, -0.94, 0.63)]),
      _p(`Nitrite`, `NO₂`, `NO₃RR`, [_a(`N`, 0, 0, 0), _a(`O`, 1.098, 0, 0.465), _a(`O`, -1.098, 0, 0.465)]),
      _p(`Nitric oxide`, `NO`, `NO₃RR`, [_a(`N`, 0, 0, 0), _a(`O`, 0, 0, 1.151)]),
      _p(`Nitroxyl`, `NOH`, `NO₃RR`, [_a(`N`, 0, 0, 0), _a(`O`, 0, 0, 1.21), _a(`H`, 0, 0.76, 1.63)]),
      _p(`HNO`, `HNO`, `NO₃RR`, [_a(`H`, 0.95, 0, -0.40), _a(`N`, 0, 0, 0), _a(`O`, 0, 0, 1.21)], 1),
      _p(`NHOH`, `NHOH`, `NO₃RR`, [_a(`N`, 0, 0, 0), _a(`H`, 0.87, 0, -0.48), _a(`O`, 0, 0, 1.36), _a(`H`, 0, 0.76, 1.78)]),
      _p(`Hydroxylamine`, `NH₂OH`, `NO₃RR`, [_a(`N`, 0, 0, 0), _a(`H`, 0.87, 0, -0.48), _a(`H`, -0.87, 0, -0.48), _a(`O`, 0, 0, 1.40), _a(`H`, 0, 0.76, 1.82)]),
    ],
  },
  {
    label: `HER`,
    presets: [
      _p(`Hydrogen`, `H`, `HER`, [_a(`H`, 0, 0, 0)]),
    ],
  },
  {
    label: `PDH`,
    presets: [
      // Propane dehydrogenation: C₃H₈ → C₃H₆ + H₂
      _p(`Propyl`, `C₃H₇`, `PDH`, [_a(`C`, 0, 0, 0), _a(`H`, 0.89, 0, -0.63), _a(`H`, -0.89, 0, -0.63), _a(`C`, 0, 0, 1.54), _a(`H`, 0.89, 0, 2.17), _a(`H`, -0.89, 0, 2.17), _a(`C`, 0, 0, 3.08), _a(`H`, 0.89, 0, 3.71), _a(`H`, -0.89, 0, 3.71), _a(`H`, 0, 0, 3.71)]),
      _p(`Isopropyl`, `i-C₃H₇`, `PDH`, [_a(`C`, 0, 0, 0), _a(`H`, 0, 0, 1.09), _a(`C`, 1.26, 0.73, -0.51), _a(`H`, 1.26, 0.73, -1.60), _a(`H`, 2.12, 0.18, -0.12), _a(`H`, 1.26, 1.78, -0.18), _a(`C`, -1.26, 0.73, -0.51), _a(`H`, -1.26, 0.73, -1.60), _a(`H`, -2.12, 0.18, -0.12), _a(`H`, -1.26, 1.78, -0.18)]),
      _p(`Propylene`, `C₃H₆`, `PDH`, [_a(`C`, 0, 0, 0), _a(`H`, 0.93, 0, -0.56), _a(`C`, 0, 0, 1.34), _a(`H`, -0.93, 0, 1.90), _a(`C`, 1.26, 0, 2.08), _a(`H`, 1.26, 0.89, 2.70), _a(`H`, 1.26, -0.89, 2.70), _a(`H`, 2.16, 0, 1.48)]),
      _p(`Propylidyne`, `C₃H₅`, `PDH`, [_a(`C`, 0, 0, 0), _a(`C`, 0, 0, 1.34), _a(`H`, -0.93, 0, 1.90), _a(`C`, 1.26, 0, 2.08), _a(`H`, 1.26, 0.89, 2.70), _a(`H`, 1.26, -0.89, 2.70), _a(`H`, 2.16, 0, 1.48)]),
      _p(`Ethyl`, `C₂H₅`, `PDH`, [_a(`C`, 0, 0, 0), _a(`H`, 0.89, 0, -0.63), _a(`H`, -0.89, 0, -0.63), _a(`C`, 0, 0, 1.54), _a(`H`, 0.89, 0, 2.17), _a(`H`, -0.89, 0, 2.17), _a(`H`, 0, 0, 2.17)]),
      _p(`Ethylene`, `C₂H₄`, `PDH`, [_a(`C`, 0, 0, 0), _a(`H`, 0.93, 0, -0.56), _a(`H`, -0.93, 0, -0.56), _a(`C`, 0, 0, 1.34), _a(`H`, 0.93, 0, 1.90), _a(`H`, -0.93, 0, 1.90)]),
      _p(`Vinyl`, `C₂H₃`, `PDH`, [_a(`C`, 0, 0, 0), _a(`H`, 0.93, 0, -0.56), _a(`C`, 0, 0, 1.34), _a(`H`, 0.93, 0, 1.90), _a(`H`, -0.93, 0, 1.90)]),
      _p(`Acetylene`, `C₂H₂`, `PDH`, [_a(`C`, 0, 0, 0), _a(`H`, 0, 0, -1.06), _a(`C`, 0, 0, 1.20), _a(`H`, 0, 0, 2.26)]),
      _p(`Coke precursor`, `C`, `PDH`, [_a(`C`, 0, 0, 0)]),
    ],
  },
  {
    label: `FTS`,
    presets: [
      // Fischer-Tropsch synthesis: CO + H₂ → hydrocarbons
      _p(`Carbon monoxide`, `CO`, `FTS`, [_a(`C`, 0, 0, 0), _a(`O`, 0, 0, 1.128)]),
      _p(`Formyl`, `HCO`, `FTS`, [_a(`H`, 1.09, 0, 0.12), _a(`C`, 0, 0, 0), _a(`O`, -0.58, 0, 1.03)], 1),
      _p(`Hydroxymethylidyne`, `COH`, `FTS`, [_a(`C`, 0, 0, 0), _a(`O`, 0, 0, 1.31), _a(`H`, 0, 0.87, 1.70)]),
      _p(`Hydroxymethylene`, `CHOH`, `FTS`, [_a(`C`, 0, 0, 0), _a(`H`, 1.09, 0, -0.12), _a(`O`, -0.40, 0, 1.22), _a(`H`, -0.40, 0.76, 1.70)]),
      _p(`Formaldehyde`, `CH₂O`, `FTS`, [_a(`C`, 0, 0, 0), _a(`H`, 0.93, 0, -0.56), _a(`H`, -0.93, 0, -0.56), _a(`O`, 0, 0, 1.20)]),
      _p(`Hydroxymethyl`, `CH₂OH`, `FTS`, [_a(`C`, 0, 0, 0), _a(`H`, 0.93, 0, -0.56), _a(`H`, -0.93, 0, -0.56), _a(`O`, 0, 0, 1.43), _a(`H`, 0, 0.76, 1.85)]),
      _p(`Methylidyne`, `CH`, `FTS`, [_a(`C`, 0, 0, 0), _a(`H`, 0, 0, 1.09)]),
      _p(`Methylene`, `CH₂`, `FTS`, [_a(`C`, 0, 0, 0), _a(`H`, 0.93, 0, 0.56), _a(`H`, -0.93, 0, 0.56)]),
      _p(`Methyl`, `CH₃`, `FTS`, [_a(`C`, 0, 0, 0), _a(`H`, 1.026, 0, -0.363), _a(`H`, -0.513, 0.889, -0.363), _a(`H`, -0.513, -0.889, -0.363)]),
      _p(`Ethylene`, `C₂H₄`, `FTS`, [_a(`C`, 0, 0, 0), _a(`H`, 0.93, 0, -0.56), _a(`H`, -0.93, 0, -0.56), _a(`C`, 0, 0, 1.34), _a(`H`, 0.93, 0, 1.90), _a(`H`, -0.93, 0, 1.90)]),
      _p(`Acetylene (vinylidene)`, `CHCH`, `FTS`, [_a(`C`, 0, 0, 0), _a(`H`, 0, 0, -1.06), _a(`C`, 0, 0, 1.34), _a(`H`, 0, 0, 2.40)]),
      _p(`Ethylidyne`, `CCH₃`, `FTS`, [_a(`C`, 0, 0, 0), _a(`C`, 0, 0, 1.47), _a(`H`, 1.026, 0, 1.833), _a(`H`, -0.513, 0.889, 1.833), _a(`H`, -0.513, -0.889, 1.833)]),
      _p(`Ethyl`, `C₂H₅`, `FTS`, [_a(`C`, 0, 0, 0), _a(`H`, 0.89, 0, -0.63), _a(`H`, -0.89, 0, -0.63), _a(`C`, 0, 0, 1.54), _a(`H`, 0.89, 0, 2.17), _a(`H`, -0.89, 0, 2.17), _a(`H`, 0, 0, 2.17)]),
    ],
  },
  {
    label: `WGS / MeOH`,
    presets: [
      // Water-gas shift: CO + H₂O → CO₂ + H₂  /  Methanol synthesis: CO₂ + H₂ → CH₃OH
      _p(`Carbon monoxide`, `CO`, `WGS`, [_a(`C`, 0, 0, 0), _a(`O`, 0, 0, 1.128)]),
      _p(`Carbon dioxide`, `CO₂`, `WGS`, [_a(`C`, 0, 0, 0), _a(`O`, -1.16, 0, 0), _a(`O`, 1.16, 0, 0)]),
      _p(`Water`, `H₂O`, `WGS`, [_a(`O`, 0, 0, 0), _a(`H`, 0.757, 0, 0.586), _a(`H`, -0.757, 0, 0.586)]),
      _p(`Hydroxyl`, `OH`, `WGS`, [_a(`O`, 0, 0, 0), _a(`H`, 0, 0, 0.97)]),
      _p(`Carboxyl`, `COOH`, `WGS`, [_a(`C`, 0, 0, 0), _a(`O`, 1.208, 0, 0), _a(`O`, -0.396, 1.171, 0), _a(`H`, 0.164, 1.882, 0)]),
      _p(`Formate`, `HCOO`, `WGS`, [_a(`H`, 0, 0, 1.10), _a(`C`, 0, 0, 0), _a(`O`, 1.08, 0, -0.63), _a(`O`, -1.08, 0, -0.63)], 1),
      _p(`Dioxymethylene`, `H₂COO`, `MeOH`, [_a(`H`, 0.93, 0, 1.20), _a(`H`, -0.93, 0, 1.20), _a(`C`, 0, 0, 0.60), _a(`O`, 1.08, 0, -0.03), _a(`O`, -1.08, 0, -0.03)], 2),
      _p(`Methoxy`, `H₃CO`, `MeOH`, [_a(`O`, 0, 0, 0), _a(`C`, 1.22, 0, 0.60), _a(`H`, 1.22, 0.89, 1.22), _a(`H`, 1.22, -0.89, 1.22), _a(`H`, 2.12, 0, 0.10)]),
      _p(`Formaldehyde`, `H₂CO`, `MeOH`, [_a(`C`, 0, 0, 0), _a(`H`, 0.93, 0, -0.56), _a(`H`, -0.93, 0, -0.56), _a(`O`, 0, 0, 1.20)]),
      _p(`Methanol`, `CH₃OH`, `MeOH`, [_a(`C`, 0, 0, 0), _a(`H`, 1.026, 0, -0.363), _a(`H`, -0.513, 0.889, -0.363), _a(`H`, -0.513, -0.889, -0.363), _a(`O`, 0, 0, 1.43), _a(`H`, 0, 0.76, 1.85)]),
    ],
  },
  {
    label: `NH₃ Synth`,
    presets: [
      // Haber-Bosch / ammonia decomposition
      _p(`Dinitrogen`, `N₂`, `NH₃Syn`, [_a(`N`, 0, 0, 0), _a(`N`, 0, 0, 1.10)]),
      _p(`Atomic nitrogen`, `N`, `NH₃Syn`, [_a(`N`, 0, 0, 0)]),
      _p(`Imido`, `NH`, `NH₃Syn`, [_a(`N`, 0, 0, 0), _a(`H`, 0, 0, 1.04)]),
      _p(`Amino`, `NH₂`, `NH₃Syn`, [_a(`N`, 0, 0, 0), _a(`H`, 0.80, 0, 0.60), _a(`H`, -0.80, 0, 0.60)]),
      _p(`Ammonia`, `NH₃`, `NH₃Syn`, [_a(`N`, 0, 0, 0), _a(`H`, 0.939, 0, -0.381), _a(`H`, -0.470, 0.813, -0.381), _a(`H`, -0.470, -0.813, -0.381)]),
      _p(`Atomic hydrogen`, `H`, `NH₃Syn`, [_a(`H`, 0, 0, 0)]),
    ],
  },
  {
    label: `S / Other`,
    presets: [
      _p(`Sulfur`, `S`, `Other`, [_a(`S`, 0, 0, 0)]),
      _p(`Sulfhydryl`, `SH`, `Other`, [_a(`S`, 0, 0, 0), _a(`H`, 0, 0, 1.34)]),
      _p(`Sulfur monoxide`, `SO`, `Other`, [_a(`S`, 0, 0, 0), _a(`O`, 0, 0, 1.48)]),
      _p(`Sulfur dioxide`, `SO₂`, `Other`, [_a(`S`, 0, 0, 0), _a(`O`, 1.25, 0, 0.72), _a(`O`, -1.25, 0, 0.72)]),
      _p(`Cyanide`, `CN`, `Other`, [_a(`C`, 0, 0, 0), _a(`N`, 0, 0, 1.16)]),
      _p(`Thiocyanate`, `SCN`, `Other`, [_a(`S`, 0, 0, 0), _a(`C`, 0, 0, 1.68), _a(`N`, 0, 0, 2.84)]),
      _p(`Formate`, `HCOO`, `Other`, [_a(`H`, 0, 0, 1.10), _a(`C`, 0, 0, 0), _a(`O`, 1.08, 0, -0.63), _a(`O`, -1.08, 0, -0.63)], 1),
      _p(`Methanol`, `CH₃OH`, `Other`, [_a(`C`, 0, 0, 0), _a(`H`, 1.026, 0, -0.363), _a(`H`, -0.513, 0.889, -0.363), _a(`H`, -0.513, -0.889, -0.363), _a(`O`, 0, 0, 1.43), _a(`H`, 0, 0.76, 1.85)]),
      _p(`Ethanol`, `C₂H₅OH`, `Other`, [_a(`C`, 0, 0, 0), _a(`H`, 0.89, 0, -0.63), _a(`H`, -0.89, 0, -0.63), _a(`C`, 0, 0, 1.54), _a(`H`, 0.89, 0, 2.17), _a(`H`, -0.89, 0, 2.17), _a(`O`, 0, 0, 2.97), _a(`H`, 0, 0.76, 3.39)]),
    ],
  },
]

/** Flat list of all presets (for backward compatibility). */
export const ADSORBATE_PRESETS: AdsorbatePreset[] = ADSORBATE_PRESET_GROUPS.flatMap(g => g.presets)

export interface AdsorbatePlacementRequest {
  slab: PymatgenStructure
  adsorbate: PymatgenStructure
  binding_atom_indices: number[]
  site_position: [number, number, number]
  site_normal: [number, number, number]
  neighbor_positions?: [number, number, number][]
  height_offset?: number
  auto_rotate?: boolean
}

export interface AdsorbatePlacementResult {
  structure: PymatgenStructure
  slab_atom_count: number
  adsorbate_atom_count: number
  adsorbate_indices: number[]
  binding_atom_position: [number, number, number]
  message: string
}

/** Convert an AdsorbatePreset to a PymatgenStructure (molecule without lattice). */
export function preset_to_structure(preset: AdsorbatePreset): PymatgenStructure {
  return {
    sites: preset.atoms.map((atom) => ({
      species: [{ element: atom.symbol, occu: 1, oxidation_state: 0 }],
      abc: atom.position as [number, number, number],
      xyz: atom.position as [number, number, number],
      label: atom.symbol,
      properties: {},
    })),
    lattice: {
      matrix: [
        [10, 0, 0],
        [0, 10, 0],
        [0, 0, 10],
      ],
      pbc: [false, false, false],
      a: 10,
      b: 10,
      c: 10,
      alpha: 90,
      beta: 90,
      gamma: 90,
      volume: 1000,
    },
  } as PymatgenStructure
}

/** Call the backend to place an adsorbate at a surface site. */
export async function placeAdsorbate(
  request: AdsorbatePlacementRequest,
  server_url = SERVER_URL,
): Promise<AdsorbatePlacementResult> {
  const response = await fetch(`${server_url}/api/adsorption/place`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(err.detail) || `Server error: ${response.status}`)
  }

  return response.json()
}

// ─── Pure TypeScript placement (no backend) ──────────────────────────────────

type Vec3 = [number, number, number]

/** Invert a 3×3 matrix (rows are lattice vectors). */
function mat3_inverse(m: [Vec3, Vec3, Vec3]): [Vec3, Vec3, Vec3] {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-12) throw new Error(`Singular lattice matrix`)
  const inv = 1 / det
  return [
    [(e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv],
    [(f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv],
    [(d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv],
  ]
}

/** Convert Cartesian → fractional using inverse lattice matrix. */
function cart_to_frac(xyz: Vec3, inv_m: [Vec3, Vec3, Vec3]): Vec3 {
  return [
    xyz[0] * inv_m[0][0] + xyz[1] * inv_m[1][0] + xyz[2] * inv_m[2][0],
    xyz[0] * inv_m[0][1] + xyz[1] * inv_m[1][1] + xyz[2] * inv_m[2][1],
    xyz[0] * inv_m[0][2] + xyz[1] * inv_m[1][2] + xyz[2] * inv_m[2][2],
  ]
}

/** Rotate a set of 3D vectors so that `from_dir` maps to `to_dir` (both normalised first). */
function rotate_vectors(points: Vec3[], from_dir: Vec3, to_dir: Vec3): Vec3[] {
  const norm = (v: Vec3) => {
    const len = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
    return len < 1e-12 ? ([0, 0, 1] as Vec3) : ([v[0] / len, v[1] / len, v[2] / len] as Vec3)
  }
  const s = norm(from_dir)
  const t = norm(to_dir)
  const dot = s[0] * t[0] + s[1] * t[1] + s[2] * t[2]
  if (dot > 1 - 1e-9) return points // already aligned
  if (dot < -1 + 1e-9) {
    // 180° flip around x-axis
    return points.map((p) => [-p[0], -p[1], -p[2]] as Vec3)
  }
  // Rodrigues rotation
  const ax = norm([s[1] * t[2] - s[2] * t[1], s[2] * t[0] - s[0] * t[2], s[0] * t[1] - s[1] * t[0]])
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)))
  const c = Math.cos(angle)
  const ss = Math.sin(angle)
  const tc = 1 - c
  const [ax0, ax1, ax2] = ax
  const R: [Vec3, Vec3, Vec3] = [
    [tc * ax0 * ax0 + c,           tc * ax0 * ax1 - ss * ax2, tc * ax0 * ax2 + ss * ax1],
    [tc * ax0 * ax1 + ss * ax2,    tc * ax1 * ax1 + c,        tc * ax1 * ax2 - ss * ax0],
    [tc * ax0 * ax2 - ss * ax1,    tc * ax1 * ax2 + ss * ax0, tc * ax2 * ax2 + c],
  ]
  return points.map((p) => [
    R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2],
    R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2],
    R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2],
  ] as Vec3)
}

/**
 * Place an adsorbate at a surface site — pure TypeScript, no backend required.
 *
 * Algorithm:
 *  1. Translate molecule so binding centroid is at origin
 *  2. If auto_rotate: rotate molecule axis ([0,0,1]) to align with site_normal
 *  3. Translate binding atom to site_position + height_offset * normal
 *  4. Merge with slab and return combined structure
 */
export function place_adsorbate_local(
  slab: PymatgenStructure,
  adsorbate_atoms: { symbol: string; position: Vec3 }[],
  binding_atom_indices: number[],
  site_position: Vec3,
  site_normal: Vec3,
  height_offset: number,
  auto_rotate: boolean,
): AdsorbatePlacementResult {
  if (adsorbate_atoms.length === 0) throw new Error(`No adsorbate atoms provided`)

  // Normalize site normal
  const n_len = Math.sqrt(site_normal[0] ** 2 + site_normal[1] ** 2 + site_normal[2] ** 2)
  const n: Vec3 = n_len < 1e-9 ? [0, 0, 1] : [site_normal[0] / n_len, site_normal[1] / n_len, site_normal[2] / n_len]

  // Compute binding centroid
  const valid_binding = binding_atom_indices.filter((i) => i < adsorbate_atoms.length)
  const bi = valid_binding.length > 0 ? valid_binding : [0]
  const binding_c: Vec3 = [
    bi.reduce((s, i) => s + adsorbate_atoms[i].position[0], 0) / bi.length,
    bi.reduce((s, i) => s + adsorbate_atoms[i].position[1], 0) / bi.length,
    bi.reduce((s, i) => s + adsorbate_atoms[i].position[2], 0) / bi.length,
  ]

  // Center molecule at binding centroid
  let positions: Vec3[] = adsorbate_atoms.map((a) => [
    a.position[0] - binding_c[0],
    a.position[1] - binding_c[1],
    a.position[2] - binding_c[2],
  ] as Vec3)

  // Rotate molecule so its natural axis ([0,0,1]) aligns with surface normal
  if (auto_rotate) {
    positions = rotate_vectors(positions, [0, 0, 1], n)
  }

  // Translate to final position: site + height_offset along normal
  const target: Vec3 = [
    site_position[0] + height_offset * n[0],
    site_position[1] + height_offset * n[1],
    site_position[2] + height_offset * n[2],
  ]
  let final_positions: Vec3[] = positions.map((p) => [p[0] + target[0], p[1] + target[1], p[2] + target[2]] as Vec3)

  // --- Overlap detection: push adsorbate up along normal if too close to slab ---
  const OVERLAP_FACTOR = 0.7 // fraction of sum of covalent radii considered overlap
  const NUDGE_STEP = 0.2 // Å per step
  const MAX_NUDGES = 20
  // Covalent radii for common elements (Å)
  const COV_R: Record<string, number> = {
    H: 0.31, He: 0.28, Li: 1.28, Be: 0.96, B: 0.84, C: 0.76, N: 0.71, O: 0.66,
    F: 0.57, Ne: 0.58, Na: 1.66, Mg: 1.41, Al: 1.21, Si: 1.11, P: 1.07, S: 1.05,
    Cl: 1.02, Ar: 1.06, K: 2.03, Ca: 1.76, Ti: 1.60, V: 1.53, Cr: 1.39, Mn: 1.39,
    Fe: 1.32, Co: 1.26, Ni: 1.24, Cu: 1.32, Zn: 1.22, Ga: 1.22, Ge: 1.20, As: 1.19,
    Se: 1.20, Br: 1.20, Zr: 1.75, Nb: 1.64, Mo: 1.54, Ru: 1.46, Rh: 1.42, Pd: 1.39,
    Ag: 1.45, Pt: 1.36, Au: 1.36, Ir: 1.41, Os: 1.44, W: 1.62, Ta: 1.70, Hf: 1.75,
  }
  function cov_r(sym: string): number { return COV_R[sym] ?? 1.5 }

  for (let nudge = 0; nudge < MAX_NUDGES; nudge++) {
    let has_overlap = false
    for (let ai = 0; ai < final_positions.length; ai++) {
      const fp = final_positions[ai]
      const ads_sym = adsorbate_atoms[ai]?.symbol ?? `C`
      for (const slab_site of slab.sites) {
        const sxyz = slab_site.xyz ?? slab_site.abc
        if (!sxyz) continue
        const dx = fp[0] - sxyz[0], dy = fp[1] - sxyz[1], dz = fp[2] - sxyz[2]
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
        const slab_sym = slab_site.species?.[0]?.element ?? slab_site.label ?? `X`
        const min_dist = (cov_r(ads_sym) + cov_r(slab_sym)) * OVERLAP_FACTOR
        if (dist < min_dist) { has_overlap = true; break }
      }
      if (has_overlap) break
    }
    if (!has_overlap) break
    // Push all adsorbate atoms up along surface normal
    final_positions = final_positions.map((p) => [
      p[0] + NUDGE_STEP * n[0],
      p[1] + NUDGE_STEP * n[1],
      p[2] + NUDGE_STEP * n[2],
    ] as Vec3)
  }

  // Compute fractional coordinates for adsorbate atoms using slab lattice
  const lat = slab.lattice?.matrix as [Vec3, Vec3, Vec3] | undefined
  const inv_lat = lat ? mat3_inverse(lat) : null

  const slab_count = slab.sites.length
  const merged_sites = [
    ...slab.sites,
    ...adsorbate_atoms.map((atom, i) => {
      const xyz = final_positions[i]
      const abc = inv_lat ? cart_to_frac(xyz, inv_lat) : xyz
      return {
        species: [{ element: atom.symbol, occu: 1, oxidation_state: 0 }],
        abc,
        xyz,
        label: atom.symbol,
        properties: {} as Record<string, unknown>,
      }
    }),
  ]

  const binding_atom_position = final_positions[bi[0]]

  return {
    structure: { ...slab, sites: merged_sites } as PymatgenStructure,
    slab_atom_count: slab_count,
    adsorbate_atom_count: adsorbate_atoms.length,
    adsorbate_indices: adsorbate_atoms.map((_, i) => slab_count + i),
    binding_atom_position,
    message: `Placed ${adsorbate_atoms.length}-atom adsorbate at site`,
  }
}
