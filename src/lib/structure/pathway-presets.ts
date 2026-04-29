import type { PathwayPreset } from './pathway-types'

export const PATHWAY_PRESETS: PathwayPreset[] = [
  {
    id: `her`,
    name: `HER`,
    category: `HER`,
    steps: [
      { name: `*`, description: `Clean surface` },
      { name: `*H`, description: `Adsorbed hydrogen` },
    ],
  },
  {
    id: `oer`,
    name: `OER`,
    category: `OER`,
    steps: [
      { name: `*`, description: `Clean surface` },
      { name: `*OH`, description: `Hydroxyl` },
      { name: `*O`, description: `Atomic oxygen` },
      { name: `*OOH`, description: `Peroxo` },
    ],
  },
  {
    id: `orr`,
    name: `ORR`,
    category: `ORR`,
    steps: [
      { name: `*`, description: `Clean surface` },
      { name: `*OOH`, description: `Hydroperoxo` },
      { name: `*O`, description: `Atomic oxygen` },
      { name: `*OH`, description: `Hydroxyl` },
    ],
  },
  {
    id: `nrr_distal`,
    name: `NRR (Distal)`,
    category: `NRR`,
    steps: [
      { name: `*`, description: `Clean surface` },
      { name: `*N₂`, description: `End-on N₂ adsorption` },
      { name: `*NNH`, description: `First protonation (distal N)` },
      { name: `*NNH₂`, description: `Second protonation (distal N)` },
      { name: `*N+NH₃`, description: `N-N cleavage, first NH₃ released` },
      { name: `*NH`, description: `Imido` },
      { name: `*NH₂`, description: `Amido` },
      { name: `*NH₃`, description: `Ammonia, ready to desorb` },
    ],
  },
  {
    id: `nrr_alternating`,
    name: `NRR (Alternating)`,
    category: `NRR`,
    steps: [
      { name: `*`, description: `Clean surface` },
      { name: `*N₂`, description: `End-on N₂ adsorption` },
      { name: `*NNH`, description: `First protonation (distal N)` },
      { name: `*NHNH`, description: `Second protonation (proximal N)` },
      { name: `*NHNH₂`, description: `Third protonation (distal N)` },
      { name: `*NH₂NH₂`, description: `Hydrazine intermediate` },
      { name: `*NH₂+NH₃`, description: `First NH₃ released` },
      { name: `*NH₃`, description: `Second ammonia, ready to desorb` },
    ],
  },
  {
    id: `co2rr_co`,
    name: `CO₂RR → CO`,
    category: `CO₂RR`,
    steps: [
      { name: `*`, description: `Clean surface` },
      { name: `*COOH`, description: `Carboxyl` },
      { name: `*CO`, description: `Carbon monoxide` },
    ],
  },
  {
    id: `co2rr_ch4`,
    name: `CO₂RR → CH₄`,
    category: `CO₂RR`,
    steps: [
      { name: `*`, description: `Clean surface` },
      { name: `*COOH`, description: `Carboxyl` },
      { name: `*CO`, description: `Carbon monoxide` },
      { name: `*CHO`, description: `Formyl` },
      { name: `*CH₂O`, description: `Formaldehyde` },
      { name: `*CH₃O`, description: `Methoxy` },
      { name: `*O+CH₄`, description: `CH₄ released` },
      { name: `*OH`, description: `Hydroxyl` },
    ],
  },
]
