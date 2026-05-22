import type { AnyStructure, ElementSymbol, Vec3 } from '$lib'
import { seed_i18n_for_tests } from '$lib/i18n/index.svelte'
import common_en from '$lib/i18n/en/common'
import app_en from '$lib/i18n/en/app'
import sidebar_en from '$lib/i18n/en/sidebar'
import structure_en from '$lib/i18n/en/structure'
import workflow_en from '$lib/i18n/en/workflow'
import chat_en from '$lib/i18n/en/chat'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import type { Pbc, PymatgenStructure, Site } from '$lib/structure'
import { beforeEach, vi } from 'vitest'

beforeEach(() => {
  document.body.innerHTML = ``
  seed_i18n_for_tests(`en`, {
    common: common_en,
    app: app_en,
    sidebar: sidebar_en,
    structure: structure_en,
    workflow: workflow_en,
    chat: chat_en,
  })
})

export function doc_query<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector(selector)
  if (!node) throw new Error(`No element found for selector: ${selector}`)
  return node as T
}

// Test data factory for creating mock structures
export const get_dummy_structure = (
  element = `H`,
  atoms = 3,
  with_lattice = false,
) => {
  const structure = {
    sites: Array.from({ length: atoms }, (_, idx) => ({
      species: [{ element, occu: 1, oxidation_state: 0 }],
      abc: [0, 0, 0],
      xyz: [idx, 0, 0],
      label: `${element}${idx + 1}`,
      properties: {},
    })),
    charge: 0,
  }

  if (with_lattice) {
    const matrix = [[5.0, 0.0, 0.0], [0.0, 5.0, 0.0], [0.0, 0.0, 5.0]]
    const pbc = [true, true, true]
    const lengths = { a: 5.0, b: 5.0, c: 5.0 }
    const angles = { alpha: 90.0, beta: 90.0, gamma: 90.0 }
    const lattice = { ...lengths, ...angles, volume: 125.0, matrix, pbc }
    return { ...structure, lattice }
  }

  return structure
}

// Helper to create test crystal structures with proper lattice handling
// Supports two modes:
// 1. Fractional coordinates: create_test_structure(lattice, elements, frac_coords)
// 2. Cartesian coordinates: create_test_structure(lattice, sites_data)
export function create_test_structure(
  lattice: Matrix3x3 | number,
  elements_or_sites:
    | ElementSymbol[]
    | {
      species: { element: string; occu: number; oxidation_state: number }[]
      xyz: number[]
    }[],
  frac_coords?: Vec3[],
): PymatgenStructure {
  const lattice_matrix: Matrix3x3 = typeof lattice === `number`
    ? [
      [lattice, 0.0, 0.0],
      [0.0, lattice, 0.0],
      [0.0, 0.0, lattice],
    ]
    : lattice

  // Calculate lattice parameters from matrix
  const { a, b, c, alpha, beta, gamma, volume } = math.calc_lattice_params(lattice_matrix)

  let sites: Site[]

  // Mode 1: Fractional coordinates (original behavior)
  if (frac_coords) {
    const elements = elements_or_sites as ElementSymbol[]
    sites = frac_coords.map((frac_coord, idx) => ({
      xyz: math.mat3x3_vec3_multiply(lattice_matrix, frac_coord),
      abc: frac_coord,
      species: [{ element: elements[idx], occu: 1, oxidation_state: 0 }],
      label: elements[idx],
      properties: {},
    }))
  } // Mode 2: Cartesian coordinates (new behavior for RDF tests)
  else {
    const sites_data = elements_or_sites as {
      species: { element: string; occu: number; oxidation_state: number }[]
      xyz: number[]
    }[]
    sites = sites_data.map((site, idx) => ({
      species: site.species.map((sp) => ({
        ...sp,
        element: sp.element as ElementSymbol,
      })),
      xyz: site.xyz as Vec3,
      // Calculate fractional coordinates: abc = inverse(lattice_matrix) · xyz
      abc: math.mat3x3_vec3_multiply(
        math.matrix_inverse_3x3(lattice_matrix),
        site.xyz as Vec3,
      ),
      label: `${site.species[0].element}${idx}`,
      properties: {},
    }))
  }

  const lattice_params = { a, b, c, alpha, beta, gamma, pbc: [true, true, true] as Pbc }
  return {
    lattice: { matrix: lattice_matrix, ...lattice_params, volume },
    sites,
  }
}

// localStorage polyfill — Node 25+ has a native localStorage (getter/setter on
// globalThis) that lacks getItem/setItem methods.  happy-dom provides a proper
// Web Storage implementation, but the native getter may shadow it.  Override
// with a spec-compliant in-memory implementation so tests behave like a browser.
if (typeof globalThis.localStorage === `undefined` || typeof globalThis.localStorage?.getItem !== `function`) {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() { return store.size },
    key: (index: number) => [...store.keys()][index] ?? null,
  }
  Object.defineProperty(globalThis, `localStorage`, {
    value: storage,
    writable: true,
    configurable: true,
  })
}

// Clear localStorage between tests so theme preference tests don't leak state
beforeEach(() => {
  try { localStorage.clear() } catch { /* ignore */ }
})

// ResizeObserver mock
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.matchMedia = vi.fn().mockImplementation((query) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
}))

// Mock clipboard API for testing
Object.defineProperty(navigator, `clipboard`, {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  writable: true,
})

// Test structure fixtures
export const simple_structure: AnyStructure = {
  id: `test_h2o`,
  sites: [
    {
      species: [{ element: `H`, occu: 1, oxidation_state: 1 }],
      xyz: [0.757, 0.586, 0.0],
      abc: [0.0757, 0.0586, 0.0],
      label: `H`,
      properties: {},
    },
    {
      species: [{ element: `O`, occu: 1, oxidation_state: -2 }],
      xyz: [0.0, 0.0, 0.0],
      abc: [0.0, 0.0, 0.0],
      label: `O`,
      properties: {},
    },
    {
      species: [{ element: `H`, occu: 1, oxidation_state: 1 }],
      xyz: [-0.757, 0.586, 0.0],
      abc: [-0.0757, 0.0586, 0.0],
      label: `H`,
      properties: {},
    },
  ],
  lattice: {
    matrix: [[10.0, 0.0, 0.0], [0.0, 10.0, 0.0], [0.0, 0.0, 10.0]],
    pbc: [true, true, true],
    ...{ a: 10.0, b: 10.0, c: 10.0, alpha: 90.0, beta: 90.0, gamma: 90.0 },
    volume: 1000.0,
  },
}

export const complex_structure: AnyStructure = {
  id: `test_complex`,
  sites: [
    {
      species: [{ element: `Li`, occu: 1, oxidation_state: 1 }],
      xyz: [0.0, 0.0, 0.0],
      abc: [0.0, 0.0, 0.0],
      label: `Li`,
      properties: {},
    },
    {
      species: [{ element: `Fe`, occu: 1, oxidation_state: 2 }],
      xyz: [2.5, 0.0, 0.0],
      abc: [0.5, 0.0, 0.0],
      label: `Fe`,
      properties: {},
    },
    {
      species: [{ element: `P`, occu: 1, oxidation_state: 5 }],
      xyz: [0.0, 2.5, 0.0],
      abc: [0.0, 0.5, 0.0],
      label: `P`,
      properties: {},
    },
    {
      species: [{ element: `O`, occu: 1, oxidation_state: -2 }],
      xyz: [1.25, 1.25, 0.0],
      abc: [0.25, 0.25, 0.0],
      label: `O`,
      properties: {},
    },
    {
      species: [{ element: `O`, occu: 1, oxidation_state: -2 }],
      xyz: [3.75, 1.25, 0.0],
      abc: [0.75, 0.25, 0.0],
      label: `O`,
      properties: {},
    },
    {
      species: [{ element: `O`, occu: 1, oxidation_state: -2 }],
      xyz: [1.25, 3.75, 0.0],
      abc: [0.25, 0.75, 0.0],
      label: `O`,
      properties: {},
    },
    {
      species: [{ element: `O`, occu: 1, oxidation_state: -2 }],
      xyz: [3.75, 3.75, 0.0],
      abc: [0.75, 0.75, 0.0],
      label: `O`,
      properties: {},
    },
  ],
  lattice: {
    matrix: [[5.0, 0.0, 0.0], [0.0, 5.0, 0.0], [0.0, 0.0, 5.0]],
    pbc: [true, true, true],
    ...{ a: 5.0, b: 5.0, c: 5.0, alpha: 90.0, beta: 90.0, gamma: 90.0 },
    volume: 125.0,
  },
}
