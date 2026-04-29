/**
 * Test constants for Playwright e2e tests.
 * These are duplicated here to avoid importing from $lib which triggers Svelte parsing.
 * Keep in sync with the source values if they change.
 */

// Number of chemical elements (from element_data.length)
export const ELEMENT_COUNT = 118

// Test element data (from $lib/element/data)
export const TEST_ELEMENTS = {
  hydrogen: {
    name: `Hydrogen`,
    number: 1,
    symbol: `H`,
    summary:
      `Hydrogen is a chemical element with chemical symbol H and atomic number 1. With an atomic weight of 1.00794 u, hydrogen is the lightest element on the periodic table. Its monatomic form (H) is the most abundant chemical substance in the Universe, constituting roughly 75% of all baryonic mass.`,
  },
  carbon: {
    name: `Carbon`,
    number: 6,
    symbol: `C`,
    summary: `Carbon is a chemical element with symbol C and atomic number 6.`,
  },
}

// Default structure settings (from $lib/settings DEFAULTS.structure)
export const STRUCTURE_DEFAULTS = {
  camera_projection: `perspective` as const,
  bonding_strategy: `auto` as const,
}

// Theme options (from $lib/theme THEME_OPTIONS)
export const THEME_OPTIONS = [
  { value: `light`, label: `Light`, icon: `☀️` },
  { value: `dark`, label: `Dark`, icon: `🌙` },
  { value: `white`, label: `White`, icon: `⚪` },
  { value: `black`, label: `Black`, icon: `⚫` },
  { value: `auto`, label: `Auto`, icon: `🔄` },
] as const

// XyObj type (from $lib/plot/types)
export type XyObj = { x: number; y: number }

// Element categories (from $lib/labels)
export const element_categories = [
  `actinide`,
  `alkali metal`,
  `alkaline earth metal`,
  `diatomic nonmetal`,
  `lanthanide`,
  `metalloid`,
  `noble gas`,
  `polyatomic nonmetal`,
  `post-transition metal`,
  `transition metal`,
] as const

// Category counts (from $lib/labels)
export const category_counts: Record<string, number> = {
  'actinide': 15,
  'alkali metal': 6,
  'alkaline earth metal': 6,
  'diatomic nonmetal': 7,
  'lanthanide': 15,
  'metalloid': 7,
  'noble gas': 7,
  'polyatomic nonmetal': 3,
  'post-transition metal': 13,
  'transition metal': 40,
}

// Heatmap labels for periodic table (from $lib/labels)
export const heatmap_labels: Record<string, string> = {
  'Atomic mass (u)': `atomic_mass`,
  'Atomic radius (Å)': `atomic_radius`,
  'Covalent radius (Å)': `covalent_radius`,
  'Electronegativity': `electronegativity`,
  'Density (g/cm³)': `density`,
  'Melting point (K)': `melting_point`,
  'Boiling point (K)': `boiling_point`,
  'First ionization (eV)': `first_ionization`,
  'Electron affinity (eV)': `electron_affinity`,
  'Specific heat (J/g·K)': `specific_heat`,
  'Molar heat (J/mol·K)': `molar_heat`,
  'Number of shells': `n_shells`,
  'Number of valence e⁻': `n_valence`,
}

// Heatmap keys (from $lib/labels)
export const heatmap_keys = [
  `atomic_mass`,
  `atomic_radius`,
  `covalent_radius`,
  `electronegativity`,
  `density`,
  `melting_point`,
  `boiling_point`,
  `first_ionization`,
  `electron_affinity`,
  `specific_heat`,
  `molar_heat`,
  `n_shells`,
  `n_valence`,
] as const

// Format number utility (simplified from $lib/labels)
export function format_num(num: number): string {
  if (num === null || num === undefined) return ``
  // Simple formatting - use fixed precision for small numbers
  if (Math.abs(num) >= 1) {
    return num.toLocaleString(`en-US`, { maximumFractionDigits: 2 })
  }
  return num.toLocaleString(`en-US`, { maximumSignificantDigits: 3 })
}
