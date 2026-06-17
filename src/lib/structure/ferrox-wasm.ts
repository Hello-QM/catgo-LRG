// TypeScript wrapper for @catgo/ferrox-wasm WASM bindings
//
// Provides lazy initialization, typed wrappers, and result handling utilities
// for the ferrox structure matching library compiled to WebAssembly.

import type { Crystal } from '$lib/structure'
export type { Crystal }
import { ensure_slab_right_handed } from './miller-slab'
import type {
  AtomRadiiBondingOptions,
  CompositionResult,
  ElectronegBondingOptions,
  EwaldAutoResult,
  EwaldResult,
  MatcherOptions,
  NanoscrollInfo,
  NanoscrollParams,
  NeighborListResult,
  ReductionAlgorithm,
  SolidAngleBondingOptions,
  StructureFormat,
  UFFOptimizationResult,
  UFFOptimizerConfig,
  UFFStepResult,
  VSEPROptimizerConfig,
  VSEPROptimizationResult,
  WasmAtomLayer,
  WasmBond,
  WasmGrowthMode,
  WasmHBondOptions,
  WasmHydrogenBond,
  WasmResult,
} from './ferrox-wasm-types'
import { is_ok } from './ferrox-wasm-types'

// Re-export all types and utilities (no WASM side effects)
export * from './ferrox-wasm-types'

// Helper to wrap WASM calls that may throw exceptions
// WASM functions return values directly or throw JsError
// This converts to WasmResult format
function wrapWasmCall<T>(fn: () => T): WasmResult<T> {
  try {
    return { ok: fn() }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: message }
  }
}

async function wrapWasmCallAsync<T>(fn: () => Promise<T>): Promise<WasmResult<T>> {
  try {
    return { ok: await fn() }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: message }
  }
}

// JsCrystal type for WASM interop (matches Rust JsCrystal struct)
interface JsCrystal {
  lattice: {
    matrix: [[number, number, number], [number, number, number], [number, number, number]]
    pbc: [boolean, boolean, boolean]
  }
  sites: Array<{
    species: Array<{ element: string; occu: number; oxidation_state?: number }>
    abc: [number, number, number]
    xyz?: [number, number, number]
    label?: string
    properties?: Record<string, unknown>
  }>
  properties?: Record<string, unknown>
}

// Convert pymatgen structure to JsCrystal format for WASM
// Ensures all fields are properly typed for serde_wasm_bindgen deserialization
// For molecules without lattice, creates a dummy bounding box with pbc=[false, false, false]
function pymatgen_to_jscrystal(structure: Crystal): JsCrystal {
  // Handle structures without lattice (molecules/XYZ files without PBC)
  const hasLattice = structure.lattice && structure.lattice.matrix

  let normalizedMatrix: [[number, number, number], [number, number, number], [number, number, number]]
  let pbc: [boolean, boolean, boolean]

  if (hasLattice) {
    const matrix = structure.lattice.matrix
    normalizedMatrix = [
      [matrix[0][0], matrix[0][1], matrix[0][2]],
      [matrix[1][0], matrix[1][1], matrix[1][2]],
      [matrix[2][0], matrix[2][1], matrix[2][2]],
    ]
    // Explicitly extract pbc values to avoid Svelte Proxy issues
    const rawPbc = structure.lattice.pbc
    pbc = rawPbc ? [Boolean(rawPbc[0]), Boolean(rawPbc[1]), Boolean(rawPbc[2])] : [true, true, true]
  } else {
    // No lattice - create a dummy bounding box from atom positions
    // This allows WASM to process molecules without periodic boundaries
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

    for (const site of structure.sites) {
      const xyz = site.xyz ?? site.abc ?? [0, 0, 0]
      minX = Math.min(minX, xyz[0])
      minY = Math.min(minY, xyz[1])
      minZ = Math.min(minZ, xyz[2])
      maxX = Math.max(maxX, xyz[0])
      maxY = Math.max(maxY, xyz[1])
      maxZ = Math.max(maxZ, xyz[2])
    }

    // Add padding around the bounding box (10 Angstroms)
    const padding = 10
    const sizeX = Math.max(maxX - minX + 2 * padding, 20)
    const sizeY = Math.max(maxY - minY + 2 * padding, 20)
    const sizeZ = Math.max(maxZ - minZ + 2 * padding, 20)

    // Simple orthogonal box
    normalizedMatrix = [
      [sizeX, 0, 0],
      [0, sizeY, 0],
      [0, 0, sizeZ],
    ]
    pbc = [false, false, false]
  }

  const result: JsCrystal = {
    lattice: {
      matrix: normalizedMatrix,
      pbc,
    },
    sites: structure.sites.map((site) => {
      // Defensive: ensure abc coordinates exist and are valid
      const abc = site.abc ?? site.xyz ?? [0, 0, 0]
      const xyz = site.xyz ?? site.abc ?? [0, 0, 0]

      return {
        species: site.species.map((s) => ({
          element: String(s.element),
          occu: Number(s.occu) || 1.0,
          // Only include oxidation_state if it's a valid number and not 0
          ...(s.oxidation_state && s.oxidation_state !== 0 ? { oxidation_state: s.oxidation_state } : {}),
        })),
        // Ensure abc is a plain array of numbers
        abc: [Number(abc[0]) || 0, Number(abc[1]) || 0, Number(abc[2]) || 0] as [number, number, number],
        // Always include xyz for WASM
        xyz: [Number(xyz[0]) || 0, Number(xyz[1]) || 0, Number(xyz[2]) || 0] as [number, number, number],
        // Only include label if it exists
        ...(site.label ? { label: String(site.label) } : {}),
        // Only include properties if it exists and is not empty
        ...(site.properties && Object.keys(site.properties).length > 0 ? { properties: site.properties } : {}),
      }
    }),
    // Only include structure properties if they exist
    ...((structure as Record<string, unknown>).properties &&
      Object.keys((structure as Record<string, unknown>).properties as object).length > 0
      ? { properties: (structure as Record<string, unknown>).properties as Record<string, unknown> }
      : {}),
  }

  return result
}

// Convert JsCrystal from WASM back to pymatgen structure format
function jscrystal_to_pymatgen(jsCrystal: unknown): Crystal {
  const js = jsCrystal as JsCrystal
  const matrix = js.lattice.matrix
  // Calculate lattice parameters from matrix
  const a = Math.sqrt(matrix[0][0] ** 2 + matrix[0][1] ** 2 + matrix[0][2] ** 2)
  const b = Math.sqrt(matrix[1][0] ** 2 + matrix[1][1] ** 2 + matrix[1][2] ** 2)
  const c = Math.sqrt(matrix[2][0] ** 2 + matrix[2][1] ** 2 + matrix[2][2] ** 2)
  const dot_ab = matrix[0][0] * matrix[1][0] + matrix[0][1] * matrix[1][1] + matrix[0][2] * matrix[1][2]
  const dot_ac = matrix[0][0] * matrix[2][0] + matrix[0][1] * matrix[2][1] + matrix[0][2] * matrix[2][2]
  const dot_bc = matrix[1][0] * matrix[2][0] + matrix[1][1] * matrix[2][1] + matrix[1][2] * matrix[2][2]
  const clamp = (x: number) => Math.max(-1, Math.min(1, x))
  const alpha = (Math.acos(clamp(dot_bc / (b * c))) * 180) / Math.PI
  const beta = (Math.acos(clamp(dot_ac / (a * c))) * 180) / Math.PI
  const gamma = (Math.acos(clamp(dot_ab / (a * b))) * 180) / Math.PI
  // Calculate volume
  const cross = [
    matrix[0][1] * matrix[1][2] - matrix[0][2] * matrix[1][1],
    matrix[0][2] * matrix[1][0] - matrix[0][0] * matrix[1][2],
    matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0],
  ]
  const volume = Math.abs(matrix[2][0] * cross[0] + matrix[2][1] * cross[1] + matrix[2][2] * cross[2])

  return {
    lattice: {
      matrix,
      pbc: js.lattice.pbc,
      a, b, c, alpha, beta, gamma, volume,
    },
    sites: js.sites.map((site) => ({
      species: site.species.map((s) => ({
        element: s.element as any,
        occu: s.occu,
        oxidation_state: s.oxidation_state ?? 0,
      })),
      abc: site.abc,
      xyz: site.xyz ?? [0, 0, 0],
      label: site.label ?? site.species[0]?.element ?? ``,
      properties: site.properties ?? {},
    })) as any,
    properties: js.properties ?? {},
  }
}

// WASM Module Types (from wasm-bindgen generated types)
interface WasmStructureMatcherClass {
  new (): WasmStructureMatcherInstance
}

interface WasmStructureMatcherInstance {
  with_latt_len_tol(tol: number): WasmStructureMatcherInstance
  with_site_pos_tol(tol: number): WasmStructureMatcherInstance
  with_angle_tol(tol: number): WasmStructureMatcherInstance
  with_primitive_cell(val: boolean): WasmStructureMatcherInstance
  with_scale(val: boolean): WasmStructureMatcherInstance
  with_element_comparator(val: boolean): WasmStructureMatcherInstance
  fit(struct1: unknown, struct2: unknown): WasmResult<boolean>
  fit_anonymous(struct1: unknown, struct2: unknown): WasmResult<boolean>
  get_rms_dist(
    struct1: unknown,
    struct2: unknown,
  ): WasmResult<{ rms: number; max_dist: number } | null>
  deduplicate(structures: unknown[]): WasmResult<number[]>
  find_matches(
    new_structures: unknown[],
    existing: unknown[],
  ): WasmResult<(number | null)[]>
}

// WASM module exports
// All functions that take a structure expect structure_json: string (JSON serialized)
// and return Result<T, JsError> which becomes T or throws
interface FerroxWasmModule {
  default: (options?: { module_or_path?: string | URL }) => Promise<void>
  WasmStructureMatcher: WasmStructureMatcherClass
  // Parsing (returns JSON string)
  parse_structure: (json: string) => string
  parse_cif: (content: string) => string
  parse_poscar: (content: string) => string
  // Supercell (takes JsCrystal object, returns WasmResult<JsCrystal>)
  make_supercell_diag: (structure: unknown, nx: number, ny: number, nz: number) => WasmResult<unknown>
  make_supercell: (structure: unknown, matrix: number[][]) => WasmResult<unknown>
  // Heterostructure (SLAB mode) — takes JsCrystal objects, returns WasmResult
  hetero_search: (
    substrate: unknown,
    film: unknown,
    params: unknown,
  ) => WasmResult<unknown>
  build_hetero: (
    substrate: unknown,
    film: unknown,
    match_id: number,
    gap: number,
    vacuum: number,
    twist_angle: number,
    params: unknown,
  ) => WasmResult<unknown>
  hetero_search_bulk: (
    substrate: unknown,
    film: unknown,
    substrate_miller: Int32Array | number[],
    film_miller: Int32Array | number[],
    substrate_layers: number,
    film_layers: number,
    substrate_termination: number,
    film_termination: number,
    params: unknown,
  ) => WasmResult<unknown>
  build_hetero_bulk: (
    substrate: unknown,
    film: unknown,
    substrate_miller: Int32Array | number[],
    film_miller: Int32Array | number[],
    substrate_layers: number,
    film_layers: number,
    substrate_termination: number,
    film_termination: number,
    match_id: number,
    gap: number,
    vacuum: number,
    twist_angle: number,
    params: unknown,
  ) => WasmResult<unknown>
  lateral_search: (
    slab_a: unknown,
    slab_b: unknown,
    params: unknown,
  ) => WasmResult<unknown>
  build_lateral: (
    slab_a: unknown,
    slab_b: unknown,
    match_id: number,
    interface_axis: number,
    width_a: number,
    width_b: number,
    buffer: number,
    vacuum: number,
    max_length: number,
    max_strain: number,
  ) => WasmResult<unknown>
  build_hetero_manual: (
    substrate: unknown,
    film: unknown,
    substrate_transform: Int32Array | number[],
    film_transform: Int32Array | number[],
    gap: number,
    vacuum: number,
    xy_shift_a: number,
    xy_shift_b: number,
  ) => WasmResult<unknown>
  build_hetero_registry: (
    substrate: unknown,
    film: unknown,
    match_id: number,
    n_shift: number,
    gap: number,
    vacuum: number,
    step_angstrom: number,
    target_z: number,
    params: unknown,
  ) => WasmResult<unknown>
  build_hetero_grid_scan: (
    heterostructure: unknown,
    film: unknown,
    n_atoms_substrate: number,
    n_grid_x: number,
    n_grid_y: number,
    symprec: number,
  ) => WasmResult<unknown>
  // Reorientation (takes JsCrystal object, returns WasmResult<JsCrystal>)
  reorient_lattice: (structure: unknown) => WasmResult<unknown>
  // Symmetry (takes JsCrystal object, returns WasmResult)
  get_primitive: (structure: unknown, symprec: number) => WasmResult<unknown>
  get_spacegroup_number: (structure: unknown, symprec: number) => WasmResult<number>
  // Physical properties (takes JsCrystal)
  get_volume: (structure: unknown) => WasmResult<number>
  get_num_sites: (structure: unknown) => WasmResult<number>
  get_total_mass: (structure: unknown) => WasmResult<number>
  get_density: (structure: unknown) => WasmResult<number>
  // Neighbor finding (takes JsCrystal, returns WasmResult)
  get_neighbor_list: (
    structure: unknown,
    r: number,
    numerical_tol: number,
    exclude_self: boolean,
  ) => WasmResult<unknown>
  get_all_neighbors: (structure: unknown, r: number) => WasmResult<unknown>
  get_distance: (structure: unknown, i: number, j: number) => WasmResult<number>
  get_distance_matrix: (structure: unknown) => WasmResult<unknown>
  // Coordinates (takes JsCrystal, returns WasmResult)
  get_cart_coords: (structure: unknown) => WasmResult<unknown>
  get_frac_coords: (structure: unknown) => WasmResult<unknown>
  // Composition (takes JsCrystal)
  get_composition: (structure: unknown) => WasmResult<unknown>
  get_reduced_formula: (structure: unknown) => WasmResult<string>
  get_alphabetical_formula: (structure: unknown) => WasmResult<string>
  is_ordered: (structure: unknown) => WasmResult<boolean>
  // Element info (takes symbol string)
  get_atomic_mass: (symbol: string) => number
  get_electronegativity: (symbol: string) => number
  // Slab generation
  generate_slab: (
    structure_json: string,
    h: number,
    k: number,
    l: number,
    offset: number,
    thickness: number,
    vacuum: number,
    growth_mode: string,
    supercell_a: number,
    supercell_b: number,
  ) => WasmResult<string>  // Returns WasmResult with JSON string in ok field
  compute_d_spacing: (structure_json: string, h: number, k: number, l: number) => number
  miller_to_normal: (structure_json: string, h: number, k: number, l: number) => string  // Returns JSON string directly
  detect_layers: (structure_json: string, nx: number, ny: number, nz: number) => string  // Returns JSON string directly
  detect_layers_miller: (structure_json: string, h: number, k: number, l: number) => string  // Returns JSON string directly
  slab_termination_info: (structure_json: string, h: number, k: number, l: number) => string  // Returns JSON string directly
  generate_slab_layers: (
    structure_json: string,
    h: number, k: number, l: number,
    num_layers: number,
    termination_index: number,
    vacuum: number,
    supercell_a: number,
    supercell_b: number,
  ) => WasmResult<string>
  // Moiré (twisted-bilayer) construction (takes JSON string, returns WasmResult<string>)
  moire_search: (request_json: string) => WasmResult<string>
  build_moire: (request_json: string) => WasmResult<string>
  // Ewald summation (returns JSON strings)
  compute_ewald: (
    structure_json: string,
    charges_json: string,
    eta: number,
    real_cutoff: number,
    recip_cutoff: number,
  ) => string
  compute_ewald_from_species: (
    structure_json: string,
    eta: number,
    real_cutoff: number,
    recip_cutoff: number,
  ) => string
  compute_ewald_auto: (structure_json: string, charges_json: string, accuracy: number) => string
  // Bond detection (returns JSON strings)
  detect_bonds_radii: (structure_json: string, options_json?: string) => string
  detect_bonds_electronegativity: (structure_json: string, options_json?: string) => string
  detect_bonds_solid_angle: (structure_json: string, options_json?: string) => string
  detect_hydrogen_bonds: (structure_json: string, covalent_bonds_json: string, options_json?: string) => string
  // Optimizer (UFF/FIRE)
  optimize_structure_uff: (structure_json: string, options_json?: string) => string
  optimize_step_uff: (structure_json: string, options_json?: string) => string
  // VSEPR Optimizer
  optimize_structure_vsepr: (structure_json: string, options_json?: string) => string
  // XRD (takes JsCrystal object, returns WasmResult<JsXrdPattern>)
  compute_xrd: (structure: unknown, options?: unknown) => WasmResult<unknown>
  // Adsorption site finding (Alpha Shape V7 algorithm)
  adsorbate_find_sites: (slab: unknown, params_json: string) => WasmResult<string>
  // Nanoscroll builder (takes JsCrystal monolayer + params JSON, returns WasmResult<JsNanoscrollResult>)
  build_nanoscroll: (monolayer: unknown, params_json: string) => WasmResult<{
    structure: unknown
    info: NanoscrollInfo
  }>
  // MOF topology analysis
  detect_mof_sbus?: (structure_json: string, bonds_json: string) => string
  // MOF Phase 2: RAC descriptors, WL hash, cap replacement
  compute_rac_descriptors?: (structure_json: string, bonds_json: string, clusters_json: string) => string
  compute_wl_hashes?: (structure_json: string, bonds_json: string, clusters_json: string) => string
  replace_mof_caps?: (structure_json: string, bonds_json: string, clusters_json: string, fragment_json: string) => string
  // CrystalNN coordination analysis
  crystal_nn: (structure: unknown, site_index: number, config_json?: string | null) => WasmResult<string>
  crystal_nn_all: (structure: unknown, config_json?: string | null) => WasmResult<string>
  // PBC image site generation
  find_pbc_image_sites: (crystal: unknown, options_json?: string) => WasmResult<{
    parent_indices: number[]
    positions_xyz: [number, number, number][]
    positions_abc: [number, number, number][]
    num_translational: number
  }>
  // Nanotube builder (takes a 2D layer object + chiral indices)
  nanotube_info: (layer: unknown, n: number, m: number, nl: number) => WasmResult<unknown>
  build_nanotube: (
    layer: unknown,
    n: number,
    m: number,
    nl: number,
    vacuum: number,
    n_walls: number,
    interlayer_spacing: number,
  ) => WasmResult<unknown>
  // Pseudo-hydrogen passivation (returns JSON string of PseudoHydrogenResult)
  passivate_slab: (slab: unknown, bulk: unknown, params_json: string) => WasmResult<string>
}

// Lazy Initialization
import { browser } from '$app/environment'

let wasm_module: FerroxWasmModule | null = null
let init_promise: Promise<FerroxWasmModule> | null = null

/** One-shot listeners fired the moment the WASM module finishes initializing.
 *  See on_ferrox_wasm_ready below. */
const _ready_listeners = new Set<() => void>()

/** Cached WebAssembly.Module for Worker transfer via postMessage. */
let cached_wasm_compiled_module: WebAssembly.Module | null = null

/** Get the compiled WebAssembly.Module for Worker transfer.
 *  Fetches the WASM binary and compiles it independently of wasm-bindgen init.
 *
 *  vite-plugin-ferrox-wasm (in vite.desktop.config.ts) replaces the
 *  @catgo/ferrox-wasm/ferrox_bg.wasm?url import with an absolute filesystem path.
 *  fetch() can't use that directly, but Vite dev server serves files via /@fs/ prefix.
 *  We detect this case and prepend /@fs/ to make it a valid dev server URL. */
export async function compile_wasm_module(): Promise<WebAssembly.Module> {
  if (!browser) throw new Error(`WASM only in browser`)
  if (cached_wasm_compiled_module) return cached_wasm_compiled_module

  const wasm_url_module = await import(
    /* @vite-ignore */ `@catgo/ferrox-wasm/ferrox_bg.wasm?url`
  )
  let url = wasm_url_module.default as string

  // Dev only: vite-plugin-ferrox-wasm rewrites the import to an absolute
  // filesystem path like "/home/user/.../ferrox_bg.wasm". Prepend /@fs so the
  // Vite dev server can serve it. In production the same plugin emits a hashed
  // asset URL (/assets/ferrox_bg-XXX.wasm) which must be left untouched.
  if (import.meta.env.DEV && url.startsWith(`/`) && !url.startsWith(`/@`)) {
    url = `/@fs${url}`
  }

  console.log(`[ferrox-wasm] compile_wasm_module: fetching ${url}`)
  const response = await fetch(url)
  const bytes = await response.arrayBuffer()
  cached_wasm_compiled_module = await WebAssembly.compile(bytes)
  console.log(`[ferrox-wasm] compile_wasm_module: compiled ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB`)
  return cached_wasm_compiled_module
}

// Ensure the WASM module is loaded and initialized.
// Memoizes the init promise to prevent concurrent callers from racing and
// triggering duplicate WASM initialization.
export function ensure_ferrox_wasm_ready(wasm_url_or_binary?: string | Uint8Array): Promise<FerroxWasmModule> {
  // WASM only works in browser
  if (!browser) {
    return Promise.reject(new Error(`ferrox-wasm can only be used in the browser`))
  }

  // Fast path: already initialized
  if (wasm_module) return Promise.resolve(wasm_module)

  // Memoize the init promise to prevent race conditions where concurrent
  // callers both start initialization before the first one completes
  if (!init_promise) {
    init_promise = (async () => {
      try {
        // Dynamic import to avoid loading WASM until needed
        // @vite-ignore prevents Vite from trying to resolve this during SSR
        const mod = (await import(
          /* @vite-ignore */ `@catgo/ferrox-wasm`
        )) as unknown as FerroxWasmModule

        // Use provided binary data directly, or URL for web app
        if (wasm_url_or_binary instanceof Uint8Array) {
          // Pass ArrayBuffer directly to wasm-bindgen (e.g., from VSCode extension)
          // wasm-bindgen accepts BufferSource directly without needing a URL
          await mod.default({ module_or_path: wasm_url_or_binary as any })
        } else if (wasm_url_or_binary) {
          // Use provided URL string
          await mod.default({ module_or_path: wasm_url_or_binary })
        } else {
          // Fallback to Vite-bundled URL (for web app)
          const wasm_url_module = await import(
            /* @vite-ignore */ `@catgo/ferrox-wasm/ferrox_bg.wasm?url`
          )
          const url = wasm_url_module.default as string
          await mod.default({ module_or_path: url })
        }

        wasm_module = mod
        // Notify anything that ran the JS bond fallback while WASM was still
        // loading (popout windows / slow mobile cold-starts) so it can recompute.
        if (_ready_listeners.size > 0) {
          const cbs = [..._ready_listeners]
          _ready_listeners.clear()
          for (const cb of cbs) {
            try { cb() } catch { /* a listener throwing must not break init */ }
          }
        }
        return mod
      } catch (err) {
        // Clear the promise on failure so retry is possible
        init_promise = null
        throw new Error(
          `Failed to load ferrox-wasm. Make sure the WASM package is built: cd extensions/rust-wasm && pnpm build. Original error: ${err}`,
        )
      }
    })()
  }

  return init_promise
}

// Check if the module is already initialized
export function is_ferrox_wasm_ready(): boolean {
  return wasm_module !== null
}

/** Run `cb` once the ferrox WASM module is initialized. Fires immediately
 *  (synchronously) if it is already ready; otherwise fires once on first init
 *  and the listener is then dropped. Returns an unsubscribe function.
 *
 *  Used by the bond viewer: the first bond computation can race the eager WASM
 *  init (a popout window loads its structure at mount; mobile cold-starts are
 *  slow), in which case compute_bonds_sync falls back to the pure-JS path that
 *  produces NO cross-cell PBC bonds. This lets the viewer recompute once the
 *  real WASM detector is available. */
export function on_ferrox_wasm_ready(cb: () => void): () => void {
  if (wasm_module) {
    cb()
    return () => {}
  }
  _ready_listeners.add(cb)
  return () => { _ready_listeners.delete(cb) }
}

// Synchronously return the initialized WASM module, or null if not ready.
// Use this for paths that must run synchronously (e.g. compute_bonds_sync)
// — the WASM is initialized eagerly at app startup, so by the time the user
// loads a structure it's almost always ready. When not ready, callers fall
// back to the pure-JS path.
export function get_ferrox_wasm_sync(): FerroxWasmModule | null {
  return wasm_module
}

// Typed Wrapper Functions

// Create a configured matcher instance with builder pattern
function create_matcher(
  mod: FerroxWasmModule,
  opts?: MatcherOptions,
): WasmStructureMatcherInstance {
  let m = new mod.WasmStructureMatcher()
  if (!opts) return m
  if (opts.latt_len_tol !== undefined) m = m.with_latt_len_tol(opts.latt_len_tol)
  if (opts.site_pos_tol !== undefined) m = m.with_site_pos_tol(opts.site_pos_tol)
  if (opts.angle_tol !== undefined) m = m.with_angle_tol(opts.angle_tol)
  if (opts.primitive_cell !== undefined) m = m.with_primitive_cell(opts.primitive_cell)
  if (opts.scale !== undefined) m = m.with_scale(opts.scale)
  if (opts.element_only !== undefined) m = m.with_element_comparator(opts.element_only)
  return m
}

// Check if two structures are equivalent
export async function match_structures(
  struct1: Crystal,
  struct2: Crystal,
  options?: MatcherOptions,
): Promise<WasmResult<boolean>> {
  const mod = await ensure_ferrox_wasm_ready()
  const matcher = create_matcher(mod, options)
  return matcher.fit(struct1, struct2)
}

// Check if two structures match under any species permutation
export async function match_structures_anonymous(
  struct1: Crystal,
  struct2: Crystal,
  options?: MatcherOptions,
): Promise<WasmResult<boolean>> {
  const mod = await ensure_ferrox_wasm_ready()
  const matcher = create_matcher(mod, options)
  return matcher.fit_anonymous(struct1, struct2)
}

// Get RMS distance between two structures
export async function get_structure_rms_dist(
  struct1: Crystal,
  struct2: Crystal,
  options?: MatcherOptions,
): Promise<WasmResult<{ rms: number; max_dist: number } | null>> {
  const mod = await ensure_ferrox_wasm_ready()
  const matcher = create_matcher(mod, options)
  return matcher.get_rms_dist(struct1, struct2)
}

// Find a matching structure from a database
export async function find_matching_structure(
  query: Crystal,
  database: Crystal[],
  options?: MatcherOptions,
): Promise<WasmResult<number | null>> {
  const mod = await ensure_ferrox_wasm_ready()
  const matcher = create_matcher(mod, options)
  const results = matcher.find_matches([query], database)
  if (is_ok(results)) {
    return { ok: results.ok[0] ?? null }
  }
  return results
}

// Deduplicate a set of structures
export async function deduplicate_structures(
  structures: Crystal[],
  options?: MatcherOptions,
): Promise<WasmResult<number[]>> {
  const mod = await ensure_ferrox_wasm_ready()
  const matcher = create_matcher(mod, options)
  return matcher.deduplicate(structures)
}

// Parse structure from file content
export async function parse_structure_file(
  content: string,
  format: StructureFormat,
): Promise<WasmResult<Crystal>> {
  const mod = await ensure_ferrox_wasm_ready()
  switch (format) {
    case `cif`:
      return wrapWasmCall(() => JSON.parse(mod.parse_cif(content)) as Crystal)
    case `poscar`:
      return wrapWasmCall(() => JSON.parse(mod.parse_poscar(content)) as Crystal)
    case `json`: {
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch (exc) {
        const msg = exc instanceof Error ? exc.message : String(exc)
        return { error: `Invalid JSON: ${msg}` }
      }
      return wrapWasmCall(() => JSON.parse(mod.parse_structure(parsed as string)) as Crystal)
    }
    default:
      return { error: `Unknown structure format: ${format}` }
  }
}

// Create a supercell with diagonal scaling matrix
export async function create_supercell(
  structure: Crystal,
  nx: number,
  ny: number,
  nz: number,
): Promise<WasmResult<Crystal>> {
  const mod = await ensure_ferrox_wasm_ready()
  // Convert pymatgen structure to JsCrystal format for WASM
  const jsCrystal = pymatgen_to_jscrystal(structure)
  // Use JSON stringify/parse to ensure a clean plain object without prototype issues
  // This is necessary because serde_wasm_bindgen can be sensitive to object shapes
  const cleanCrystal = JSON.parse(JSON.stringify(jsCrystal))
  // Debug: log the converted structure to help diagnose serialization issues
  if (typeof window !== `undefined` && (window as unknown as Record<string, unknown>).__FERROX_DEBUG__) {
    console.log(`[ferrox-wasm] create_supercell input:`, JSON.stringify(cleanCrystal, null, 2))
  }
  // WASM returns WasmResult<JsCrystal>, need to convert back
  const result = mod.make_supercell_diag(cleanCrystal, nx, ny, nz)
  if (`error` in result) return result as { error: string }
  return { ok: jscrystal_to_pymatgen(result.ok) }
}

// Roll a 2D monolayer into an Archimedean-spiral nanoscroll.
// `monolayer` must be a single 2D layer (any composition); rolling a 3D bulk
// is meaningless. Returns the rolled (non-periodic) structure plus build
// metadata, including a curvature-strain `warning` when the inner radius is
// too small for the monolayer thickness.
export async function build_nanoscroll(
  monolayer: Crystal,
  params: NanoscrollParams = {},
): Promise<WasmResult<{ structure: Crystal; info: NanoscrollInfo }>> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(monolayer)
  const cleanCrystal = JSON.parse(JSON.stringify(jsCrystal))
  const result = mod.build_nanoscroll(cleanCrystal, JSON.stringify(params))
  if (`error` in result) return result as { error: string }
  return {
    ok: {
      structure: jscrystal_to_pymatgen(result.ok.structure),
      info: result.ok.info,
    },
  }
}

// Reduce lattice using Niggli or LLL algorithm
// NOTE: This function is not yet implemented in WASM backend
export async function reduce_lattice(
  _structure: Crystal,
  _algo: ReductionAlgorithm = `niggli`,
): Promise<WasmResult<Crystal>> {
  return { error: 'reduce_lattice is not yet implemented in WASM backend' }
}

// Get the primitive cell of a structure
export async function get_primitive_cell(
  structure: Crystal,
  symprec: number = 1e-4,
): Promise<WasmResult<Crystal>> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const result = mod.get_primitive(jsCrystal, symprec)
  if (`error` in result) return result as { error: string }
  return { ok: jscrystal_to_pymatgen(result.ok) }
}

// Get the spacegroup number of a structure
export async function get_spacegroup(
  structure: Crystal,
  symprec: number = 1e-4,
): Promise<WasmResult<number>> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const result = mod.get_spacegroup_number(jsCrystal, symprec)
  if (`error` in result) return result as { error: string }
  return { ok: result.ok }
}

// Serialize structure to pymatgen-compatible JSON string
// NOTE: This just returns the JSON stringified structure since parse_structure validates and returns JSON
export async function serialize_structure(
  structure: Crystal,
): Promise<WasmResult<string>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  // parse_structure validates and returns JSON string
  return wrapWasmCall(() => mod.parse_structure(json) as unknown as string)
}

// Physical Properties
export async function get_volume(structure: Crystal): Promise<WasmResult<number>> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const result = mod.get_volume(jsCrystal)
  if (`error` in result) return result as { error: string }
  return { ok: result.ok }
}

// Get total mass in atomic mass units (u)
export async function get_total_mass(structure: Crystal): Promise<WasmResult<number>> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const result = mod.get_total_mass(jsCrystal)
  if (`error` in result) return result as { error: string }
  return { ok: result.ok }
}

// Get density in g/cm^3
export async function get_density(structure: Crystal): Promise<WasmResult<number>> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const result = mod.get_density(jsCrystal)
  if (`error` in result) return result as { error: string }
  return { ok: result.ok }
}

// Neighbor Finding
export async function get_neighbor_list(
  structure: Crystal,
  cutoff_radius: number,
  numerical_tol: number = 1e-8,
  exclude_self: boolean = true,
): Promise<WasmResult<NeighborListResult>> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const result = mod.get_neighbor_list(jsCrystal, cutoff_radius, numerical_tol, exclude_self)
  if (`error` in result) return result as { error: string }
  return { ok: result.ok as NeighborListResult }
}

// Get minimum image distance between two sites
export async function get_distance(
  structure: Crystal,
  i: number,
  j: number,
): Promise<WasmResult<number>> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const result = mod.get_distance(jsCrystal, i, j)
  if (`error` in result) return result as { error: string }
  return { ok: result.ok }
}

// Get full NxN distance matrix
export async function get_distance_matrix(
  structure: Crystal,
): Promise<WasmResult<number[][]>> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const result = mod.get_distance_matrix(jsCrystal)
  if (`error` in result) return result as { error: string }
  return { ok: result.ok as number[][] }
}

// Sorting
// NOTE: These functions are not yet implemented in WASM backend
export async function get_sorted_structure(
  _structure: Crystal,
  _reverse: boolean = false,
): Promise<WasmResult<Crystal>> {
  return { error: 'get_sorted_structure is not yet implemented in WASM backend' }
}

// Get structure sorted by electronegativity
// NOTE: This function is not yet implemented in WASM backend
export async function get_sorted_by_electronegativity(
  _structure: Crystal,
  _reverse: boolean = false,
): Promise<WasmResult<Crystal>> {
  return { error: 'get_sorted_by_electronegativity is not yet implemented in WASM backend' }
}

// Interpolation
// NOTE: This function is not yet implemented in WASM backend
export async function interpolate_structures(
  _start: Crystal,
  _end: Crystal,
  _n_images: number,
  _options?: { interpolate_lattices?: boolean; use_pbc?: boolean },
): Promise<WasmResult<Crystal[]>> {
  return { error: 'interpolate_structures is not yet implemented in WASM backend' }
}

// Copy and Wrap
// NOTE: This function is not yet implemented in WASM backend
export async function copy_structure(
  _structure: Crystal,
  _sanitize: boolean = false,
): Promise<WasmResult<Crystal>> {
  return { error: 'copy_structure is not yet implemented in WASM backend' }
}

// Wrap all fractional coordinates to [0, 1) - WASM backend for entire structure
// NOTE: This function is not yet implemented in WASM backend
export async function wasm_wrap_to_unit_cell(
  _structure: Crystal,
): Promise<WasmResult<Crystal>> {
  return { error: 'wrap_to_unit_cell is not yet implemented in WASM backend' }
}

// Supercell with Full Matrix
export async function create_supercell_matrix(
  structure: Crystal,
  matrix: [[number, number, number], [number, number, number], [number, number, number]],
): Promise<WasmResult<Crystal>> {
  // Validate structure has required fields before processing
  if (!structure?.sites || structure.sites.length === 0) {
    return { error: `Cannot create supercell: structure has no sites` }
  }
  if (!structure?.lattice?.matrix) {
    return { error: `Cannot create supercell: structure has no lattice` }
  }

  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  // Use JSON stringify/parse to ensure a clean plain object without prototype issues
  const cleanCrystal = JSON.parse(JSON.stringify(jsCrystal))
  // Debug: log the converted structure to help diagnose serialization issues
  if (typeof window !== `undefined` && (window as unknown as Record<string, unknown>).__FERROX_DEBUG__) {
    console.log(`[ferrox-wasm] create_supercell_matrix input:`, JSON.stringify(cleanCrystal, null, 2))
  }
  // Validate input matrix values before processing
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const val = matrix[row][col]
      if (!Number.isFinite(val)) {
        return { error: `Invalid matrix value at [${row}][${col}]: ${val}. Matrix values must be finite numbers.` }
      }
    }
  }

  // Convert matrix to plain array of integers (remove any Proxy wrappers from Svelte reactivity)
  // The WASM backend expects JsIntMatrix3x3 which is [[i32; 3]; 3]
  // JavaScript numbers are always floats, so we need to convert to integers explicitly
  const plainMatrix: [[number, number, number], [number, number, number], [number, number, number]] = [
    [Math.round(matrix[0][0]), Math.round(matrix[0][1]), Math.round(matrix[0][2])],
    [Math.round(matrix[1][0]), Math.round(matrix[1][1]), Math.round(matrix[1][2])],
    [Math.round(matrix[2][0]), Math.round(matrix[2][1]), Math.round(matrix[2][2])],
  ]

  // Validate matrix determinant before calling WASM
  const det = plainMatrix[0][0] * (plainMatrix[1][1] * plainMatrix[2][2] - plainMatrix[1][2] * plainMatrix[2][1])
            - plainMatrix[0][1] * (plainMatrix[1][0] * plainMatrix[2][2] - plainMatrix[1][2] * plainMatrix[2][0])
            + plainMatrix[0][2] * (plainMatrix[1][0] * plainMatrix[2][1] - plainMatrix[1][1] * plainMatrix[2][0])
  if (Math.abs(det) < 0.5) {
    return { error: `Supercell matrix has zero or near-zero determinant (${det}). Cannot create supercell.` }
  }

  // WASM expects JsIntMatrix3x3 (3x3 array, not flattened)
  // Log input parameters for debugging
  console.log(`[ferrox-wasm] create_supercell_matrix: ${structure.sites.length} sites, matrix [[${plainMatrix[0].join(',')}], [${plainMatrix[1].join(',')}], [${plainMatrix[2].join(',')}]], pbc=[${cleanCrystal.lattice.pbc.join(',')}]`)
  try {
    const result = mod.make_supercell(cleanCrystal, plainMatrix)
    if (`error` in result) {
      console.error(`[ferrox-wasm] WASM returned error:`, result.error)
      return result as { error: string }
    }
    console.log(`[ferrox-wasm] create_supercell_matrix succeeded`)
    return { ok: jscrystal_to_pymatgen(result.ok) }
  } catch (err) {
    console.error(`[ferrox-wasm] create_supercell_matrix threw exception:`, err)
    console.error(`[ferrox-wasm] Input structure had ${structure.sites?.length ?? 0} sites`)
    console.error(`[ferrox-wasm] Matrix:`, plainMatrix)
    console.error(`[ferrox-wasm] Clean crystal pbc:`, cleanCrystal.lattice?.pbc)
    console.error(`[ferrox-wasm] Original structure pbc:`, structure.lattice?.pbc)
    return { error: `WASM supercell failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// Heterostructure (SLAB mode) — client-side ZSL search + coherent interface build

/** SLAB-mode ZSL search params (subset relevant to the WASM path). */
export interface WasmHeteroSearchParams {
  max_area?: number
  max_area_ratio_tol?: number
  max_length_tol?: number
  max_angle_tol?: number
  max_results?: number
}

/** SLAB-mode ZSL search between two slabs (substrate, film). Mirrors the
 *  backend `POST /api/heterostructure/search` with `params.mode = "slab"`. */
export async function wasm_hetero_search(
  substrate: Crystal,
  film: Crystal,
  params: WasmHeteroSearchParams = {},
): Promise<WasmResult<unknown>> {
  if (!substrate?.sites?.length || !film?.sites?.length) {
    return { error: `Heterostructure search: substrate and film must have sites` }
  }
  const mod = await ensure_ferrox_wasm_ready()
  const sub = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(substrate)))
  const flm = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(film)))
  const p = {
    max_area: params.max_area ?? 400.0,
    max_area_ratio_tol: params.max_area_ratio_tol ?? 0.09,
    max_length_tol: params.max_length_tol ?? 0.03,
    max_angle_tol: params.max_angle_tol ?? 0.01,
    max_results: params.max_results ?? 50,
  }
  try {
    const result = mod.hetero_search(sub, flm, p)
    return result as WasmResult<unknown>
  } catch (err) {
    return { error: `WASM hetero_search failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** SLAB-mode build for a selected ZSL match (by generation-order match_id).
 *  Mirrors the backend `POST /api/heterostructure/build` slab path. The
 *  returned `structure` is converted back to the pymatgen/Crystal JSON shape. */
export async function wasm_build_hetero(
  substrate: Crystal,
  film: Crystal,
  match_id: number,
  gap: number,
  vacuum: number,
  twist_angle: number,
  params: WasmHeteroSearchParams = {},
): Promise<WasmResult<unknown>> {
  const mod = await ensure_ferrox_wasm_ready()
  const sub = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(substrate)))
  const flm = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(film)))
  const p = {
    max_area: params.max_area ?? 400.0,
    max_area_ratio_tol: params.max_area_ratio_tol ?? 0.09,
    max_length_tol: params.max_length_tol ?? 0.03,
    max_angle_tol: params.max_angle_tol ?? 0.01,
    max_results: params.max_results ?? 50,
  }
  try {
    const result = mod.build_hetero(sub, flm, match_id, gap, vacuum, twist_angle, p)
    if (`error` in result) return result as { error: string }
    const out = result.ok as { structure: unknown; [k: string]: unknown }
    return { ok: { ...out, structure: jscrystal_to_pymatgen(out.structure) } }
  } catch (err) {
    return { error: `WASM build_hetero failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** BULK-mode ZSL search: cut surface slabs from two bulk crystals (Miller +
 *  layer count + termination) and ZSL-match them. Mirrors the backend
 *  `POST /api/heterostructure/search` bulk path. */
export async function wasm_hetero_search_bulk(
  substrate: Crystal,
  film: Crystal,
  substrate_miller: [number, number, number],
  film_miller: [number, number, number],
  substrate_layers: number,
  film_layers: number,
  substrate_termination: number,
  film_termination: number,
  params: WasmHeteroSearchParams = {},
): Promise<WasmResult<unknown>> {
  if (!substrate?.sites?.length || !film?.sites?.length) {
    return { error: `Heterostructure search: substrate and film must have sites` }
  }
  const mod = await ensure_ferrox_wasm_ready()
  const sub = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(substrate)))
  const flm = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(film)))
  const p = {
    max_area: params.max_area ?? 400.0,
    max_area_ratio_tol: params.max_area_ratio_tol ?? 0.09,
    max_length_tol: params.max_length_tol ?? 0.03,
    max_angle_tol: params.max_angle_tol ?? 0.01,
    max_results: params.max_results ?? 50,
  }
  try {
    const result = mod.hetero_search_bulk(
      sub,
      flm,
      Int32Array.from(substrate_miller),
      Int32Array.from(film_miller),
      substrate_layers,
      film_layers,
      substrate_termination,
      film_termination,
      p,
    )
    return result as WasmResult<unknown>
  } catch (err) {
    return { error: `WASM hetero_search_bulk failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** BULK-mode build for a selected ZSL match. Cuts slabs from the two bulk
 *  crystals then builds the chosen match. Mirrors the backend
 *  `POST /api/heterostructure/build` bulk path; the returned `structure` is
 *  converted back to the pymatgen/Crystal JSON shape. */
export async function wasm_build_hetero_bulk(
  substrate: Crystal,
  film: Crystal,
  substrate_miller: [number, number, number],
  film_miller: [number, number, number],
  substrate_layers: number,
  film_layers: number,
  substrate_termination: number,
  film_termination: number,
  match_id: number,
  gap: number,
  vacuum: number,
  twist_angle: number,
  params: WasmHeteroSearchParams = {},
): Promise<WasmResult<unknown>> {
  const mod = await ensure_ferrox_wasm_ready()
  const sub = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(substrate)))
  const flm = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(film)))
  const p = {
    max_area: params.max_area ?? 400.0,
    max_area_ratio_tol: params.max_area_ratio_tol ?? 0.09,
    max_length_tol: params.max_length_tol ?? 0.03,
    max_angle_tol: params.max_angle_tol ?? 0.01,
    max_results: params.max_results ?? 50,
  }
  try {
    const result = mod.build_hetero_bulk(
      sub,
      flm,
      Int32Array.from(substrate_miller),
      Int32Array.from(film_miller),
      substrate_layers,
      film_layers,
      substrate_termination,
      film_termination,
      match_id,
      gap,
      vacuum,
      twist_angle,
      p,
    )
    if (`error` in result) return result as { error: string }
    const out = result.ok as { structure: unknown; [k: string]: unknown }
    return { ok: { ...out, structure: jscrystal_to_pymatgen(out.structure) } }
  } catch (err) {
    return { error: `WASM build_hetero_bulk failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** SLAB-mode manual build with user-specified 2x2 integer transforms.
 *  Mirrors the backend `POST /api/heterostructure/build-manual`. `xy_shift`
 *  is the fractional (fa, fb) in-plane shift of the film (default (0, 0)). */
export async function wasm_build_hetero_manual(
  substrate: Crystal,
  film: Crystal,
  substrate_transform: number[][],
  film_transform: number[][],
  gap: number,
  vacuum: number,
  xy_shift: [number, number] = [0, 0],
): Promise<WasmResult<unknown>> {
  const mod = await ensure_ferrox_wasm_ready()
  const sub = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(substrate)))
  const flm = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(film)))
  // Flatten 2x2 -> row-major Int32Array of 4 ints.
  const st = Int32Array.from([
    Math.round(substrate_transform[0][0]), Math.round(substrate_transform[0][1]),
    Math.round(substrate_transform[1][0]), Math.round(substrate_transform[1][1]),
  ])
  const ft = Int32Array.from([
    Math.round(film_transform[0][0]), Math.round(film_transform[0][1]),
    Math.round(film_transform[1][0]), Math.round(film_transform[1][1]),
  ])
  try {
    const result = mod.build_hetero_manual(sub, flm, st, ft, gap, vacuum, xy_shift[0], xy_shift[1])
    if (`error` in result) return result as { error: string }
    const out = result.ok as { structure: unknown; [k: string]: unknown }
    return { ok: { ...out, structure: jscrystal_to_pymatgen(out.structure) } }
  } catch (err) {
    return { error: `WASM build_hetero_manual failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** SLAB-mode registry candidates: build the same ZSL match at a family of
 *  in-plane xy shifts. Mirrors the backend `POST /api/heterostructure/batch-build`
 *  (returns the built structures so the caller can assemble the same archive).
 *  Each returned candidate's `structure` is converted to pymatgen JSON. */
export async function wasm_build_hetero_registry(
  substrate: Crystal,
  film: Crystal,
  match_id: number,
  n_shift: number,
  gap: number,
  vacuum: number,
  step_angstrom: number,
  target_z: number,
  params: WasmHeteroSearchParams = {},
): Promise<WasmResult<unknown>> {
  const mod = await ensure_ferrox_wasm_ready()
  const sub = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(substrate)))
  const flm = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(film)))
  const p = {
    max_area: params.max_area ?? 400.0,
    max_area_ratio_tol: params.max_area_ratio_tol ?? 0.09,
    max_length_tol: params.max_length_tol ?? 0.03,
    max_angle_tol: params.max_angle_tol ?? 0.01,
    max_results: params.max_results ?? 50,
  }
  try {
    const result = mod.build_hetero_registry(
      sub,
      flm,
      match_id,
      n_shift,
      gap,
      vacuum,
      step_angstrom,
      target_z,
      p,
    )
    if (`error` in result) return result as { error: string }
    const out = result.ok as {
      candidates: { structure: unknown; [k: string]: unknown }[]
      [k: string]: unknown
    }
    const candidates = out.candidates.map((c) => ({
      ...c,
      structure: jscrystal_to_pymatgen(c.structure),
    }))
    return { ok: { ...out, candidates } }
  } catch (err) {
    return { error: `WASM build_hetero_registry failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** SLAB-mode grid scan: shift the film atoms of an already-built heterostructure
 *  across the irreducible wedge of the film slab. Mirrors the backend
 *  `POST /api/heterostructure/grid-scan`. Each entry/structure is converted to
 *  pymatgen JSON. */
export async function wasm_build_hetero_grid_scan(
  heterostructure: Crystal,
  film: Crystal,
  n_atoms_substrate: number,
  n_grid_x: number,
  n_grid_y: number,
  symprec: number,
): Promise<WasmResult<unknown>> {
  const mod = await ensure_ferrox_wasm_ready()
  const hetero = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(heterostructure)))
  const flm = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(film)))
  try {
    const result = mod.build_hetero_grid_scan(hetero, flm, n_atoms_substrate, n_grid_x, n_grid_y, symprec)
    if (`error` in result) return result as { error: string }
    const out = result.ok as {
      entries: { structure: unknown; [k: string]: unknown }[]
      structures: unknown[]
      [k: string]: unknown
    }
    const entries = out.entries.map((e) => ({
      ...e,
      structure: jscrystal_to_pymatgen(e.structure),
    }))
    const structures = out.structures.map((s) => jscrystal_to_pymatgen(s))
    return { ok: { ...out, entries, structures } }
  } catch (err) {
    return { error: `WASM build_hetero_grid_scan failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Lateral-search parameters for the WASM `lateral_search` export. */
export interface WasmLateralSearchParams {
  interface_axis?: number
  max_length?: number
  max_strain?: number
  max_results?: number
}

/** Lateral (in-plane) edge-match search between two 2D slabs. Mirrors the
 *  backend `POST /api/heterostructure/search-lateral`. */
export async function wasm_lateral_search(
  slab_A: Crystal,
  slab_B: Crystal,
  params: WasmLateralSearchParams = {},
): Promise<WasmResult<unknown>> {
  if (!slab_A?.sites?.length || !slab_B?.sites?.length) {
    return { error: `Lateral search: slab_A and slab_B must have sites` }
  }
  const mod = await ensure_ferrox_wasm_ready()
  const a = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(slab_A)))
  const b = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(slab_B)))
  const p = {
    interface_axis: params.interface_axis ?? 0,
    max_length: params.max_length ?? 100.0,
    max_strain: params.max_strain ?? 5.0,
    max_results: params.max_results ?? 50,
  }
  try {
    const result = mod.lateral_search(a, b, p)
    return result as WasmResult<unknown>
  } catch (err) {
    return { error: `WASM lateral_search failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Build a lateral heterojunction for a selected edge-match (by match_id).
 *  Mirrors the backend `POST /api/heterostructure/build-lateral`. The returned
 *  `structure` is converted back to the pymatgen/Crystal JSON shape. */
export async function wasm_build_lateral(
  slab_A: Crystal,
  slab_B: Crystal,
  match_id: number,
  interface_axis: number,
  width_A: number,
  width_B: number,
  buffer: number,
  vacuum: number,
  max_length: number,
  max_strain: number,
): Promise<WasmResult<unknown>> {
  const mod = await ensure_ferrox_wasm_ready()
  const a = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(slab_A)))
  const b = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(slab_B)))
  try {
    const result = mod.build_lateral(
      a,
      b,
      match_id,
      interface_axis,
      width_A,
      width_B,
      buffer,
      vacuum,
      max_length,
      max_strain,
    )
    if (`error` in result) return result as { error: string }
    const out = result.ok as { structure: unknown; [k: string]: unknown }
    return { ok: { ...out, structure: jscrystal_to_pymatgen(out.structure) } }
  } catch (err) {
    return { error: `WASM build_lateral failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Reorient lattice so a1 is along x-axis and a3 is in the xz-plane.
 * Uses Rodrigues' rotation (same algorithm as ASE).
 * Fractional coordinates are preserved; only wrapping to [0,1) is applied.
 */
export async function wasm_reorient_lattice(
  structure: Crystal,
): Promise<WasmResult<Crystal>> {
  if (!structure?.sites || structure.sites.length === 0) {
    return { error: `Cannot reorient lattice: structure has no sites` }
  }
  if (!structure?.lattice?.matrix) {
    return { error: `Cannot reorient lattice: structure has no lattice` }
  }

  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const cleanCrystal = JSON.parse(JSON.stringify(jsCrystal))

  try {
    const result = mod.reorient_lattice(cleanCrystal)
    if (`error` in result) {
      return result as { error: string }
    }
    return { ok: jscrystal_to_pymatgen(result.ok) }
  } catch (err) {
    return { error: `WASM reorient_lattice failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// Site Manipulation
// NOTE: This function is not yet implemented in WASM backend
export async function translate_sites(
  _structure: Crystal,
  _indices: number[],
  _vector: [number, number, number],
  _frac_coords: boolean = false,
): Promise<WasmResult<Crystal>> {
  return { error: 'translate_sites is not yet implemented in WASM backend' }
}

// Perturb all sites by random vectors
// NOTE: This function is not yet implemented in WASM backend
export async function perturb_structure(
  _structure: Crystal,
  _distance: number,
  _options?: { min_distance?: number; seed?: number },
): Promise<WasmResult<Crystal>> {
  return { error: 'perturb_structure is not yet implemented in WASM backend' }
}

// Element Information
export async function get_atomic_mass(symbol: string): Promise<WasmResult<number>> {
  const mod = await ensure_ferrox_wasm_ready()
  return wrapWasmCall(() => mod.get_atomic_mass(symbol))
}

// Get electronegativity of an element by symbol
export async function get_electronegativity(
  symbol: string,
): Promise<WasmResult<number>> {
  const mod = await ensure_ferrox_wasm_ready()
  return wrapWasmCall(() => mod.get_electronegativity(symbol))
}

// =============================================================================
// Coordinate Functions
// =============================================================================

// Get Cartesian coordinates of all sites
export async function get_cart_coords(
  structure: Crystal,
): Promise<WasmResult<[number, number, number][]>> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const result = mod.get_cart_coords(jsCrystal)
  if (`error` in result) return result as { error: string }
  return { ok: result.ok as [number, number, number][] }
}

// Get fractional coordinates of all sites
export async function get_frac_coords(
  structure: Crystal,
): Promise<WasmResult<[number, number, number][]>> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const result = mod.get_frac_coords(jsCrystal)
  if (`error` in result) return result as { error: string }
  return { ok: result.ok as [number, number, number][] }
}

// Get all neighbors for each site within radius r
export async function get_all_neighbors(
  structure: Crystal,
  r: number,
): Promise<WasmResult<[number, number, [number, number, number]][][]>> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const result = mod.get_all_neighbors(jsCrystal, r)
  if (`error` in result) return result as { error: string }
  return { ok: result.ok as [number, number, [number, number, number]][][] }
}

// =============================================================================
// Composition Functions (WASM)
// Note: Prefixed with 'wasm_' to avoid conflicts with TypeScript implementations
// =============================================================================

// Get the composition of a structure (element symbols -> counts) - WASM backend
export async function wasm_get_composition(
  structure: Crystal,
): Promise<WasmResult<CompositionResult>> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const result = mod.get_composition(jsCrystal)
  if (`error` in result) return result as { error: string }
  return { ok: result.ok as CompositionResult }
}

// Get the reduced formula (e.g., "NaCl" for Na4Cl4) - WASM backend
export async function wasm_get_reduced_formula(
  structure: Crystal,
): Promise<WasmResult<string>> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const result = mod.get_reduced_formula(jsCrystal)
  if (`error` in result) return result as { error: string }
  return { ok: result.ok }
}

// Get the alphabetical formula (e.g., "Cl4Na4") - WASM backend
export async function wasm_get_alphabetical_formula(
  structure: Crystal,
): Promise<WasmResult<string>> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const result = mod.get_alphabetical_formula(jsCrystal)
  if (`error` in result) return result as { error: string }
  return { ok: result.ok }
}

// Check if structure is ordered (single species per site) - WASM backend
export async function wasm_is_ordered(structure: Crystal): Promise<WasmResult<boolean>> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const result = mod.is_ordered(jsCrystal)
  if (`error` in result) return result as { error: string }
  return { ok: result.ok }
}

// =============================================================================
// Slab Generation Functions (WASM)
// Note: Prefixed with 'wasm_' to avoid conflicts with TypeScript implementations
// in miller-slab.ts. The WASM versions use Rust backend for better performance.
// =============================================================================

// Generate a slab from a bulk crystal structure (WASM backend)
export async function wasm_generate_slab(
  structure: Crystal,
  miller_index: [number, number, number],
  options?: {
    offset?: number
    thickness?: number
    vacuum?: number
    growth_mode?: WasmGrowthMode
    supercell?: [number, number]
  },
): Promise<WasmResult<Crystal>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  const [h, k, l] = miller_index
  const offset = options?.offset ?? 0
  const thickness = options?.thickness ?? 10
  const vacuum = options?.vacuum ?? 15
  const growth_mode = options?.growth_mode ?? `centered`
  const [supercell_a, supercell_b] = options?.supercell ?? [1, 1]

  // WASM generate_slab returns WasmResult<string> where ok contains JSON string
  try {
    const result = mod.generate_slab(
      json, h, k, l, offset, thickness, vacuum, growth_mode, supercell_a, supercell_b,
    )
    if (`error` in result) {
      return result as { error: string }
    }
    // Parse the JSON string from the ok field
    const slab = JSON.parse(result.ok) as Crystal

    // Enforce right-handed coordinate system for slab lattice.
    // The WASM backend may produce a left-handed lattice due to sign ambiguity
    // in the rotation matrix, causing axis flips in the 3D viewer.
    if (slab.lattice?.matrix) {
      const m = slab.lattice.matrix
      const a = m[0] as [number, number, number]
      const b = m[1] as [number, number, number]
      const [new_b, flipped] = ensure_slab_right_handed(a, b)
      if (flipped) {
        m[1] = new_b
        // Adjust fractional b-coordinates: negate and wrap to [0, 1)
        // Then recompute xyz from the new abc and new lattice to keep them consistent
        for (const site of slab.sites) {
          let fb = -(site.abc[1] as number)
          fb = fb - Math.floor(fb)
          if (fb >= 1.0) fb = 0.0
          site.abc[1] = fb
          // Recompute xyz from updated abc and lattice
          const [fa, fc] = [site.abc[0] as number, site.abc[2] as number]
          site.xyz = [
            fa * m[0][0] + fb * m[1][0] + fc * m[2][0],
            fa * m[0][1] + fb * m[1][1] + fc * m[2][1],
            fa * m[0][2] + fb * m[1][2] + fc * m[2][2],
          ]
        }
      }
    }

    return { ok: slab }
  } catch (err) {
    return { error: `Slab generation failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// Compute the d-spacing for a Miller index (WASM backend)
export async function wasm_compute_d_spacing(
  structure: Crystal,
  miller_index: [number, number, number],
): Promise<WasmResult<number>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  const [h, k, l] = miller_index
  return wrapWasmCall(() => mod.compute_d_spacing(json, h, k, l) as unknown as number)
}

// Convert Miller index to surface normal (WASM backend)
export async function wasm_miller_to_normal(
  structure: Crystal,
  miller_index: [number, number, number],
): Promise<WasmResult<[number, number, number]>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  const [h, k, l] = miller_index
  return wrapWasmCall(() => JSON.parse(mod.miller_to_normal(json, h, k, l)))
}

// Detect atomic layers along a given normal direction (WASM backend)
export async function wasm_detect_layers(
  structure: Crystal,
  normal: [number, number, number],
): Promise<WasmResult<WasmAtomLayer[]>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  const [nx, ny, nz] = normal
  return wrapWasmCall(() => JSON.parse(mod.detect_layers(json, nx, ny, nz)))
}

// Detect atomic layers along a Miller plane normal (WASM backend)
export async function wasm_detect_layers_miller(
  structure: Crystal,
  miller_index: [number, number, number],
): Promise<WasmResult<WasmAtomLayer[]>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  const [h, k, l] = miller_index
  return wrapWasmCall(() => JSON.parse(mod.detect_layers_miller(json, h, k, l)))
}

// Termination info for slab generation
export interface SlabTermination {
  height: number
  elements: string[]
}

// Get all unique surface terminations for a Miller index
export async function wasm_slab_termination_info(
  structure: Crystal,
  miller_index: [number, number, number],
): Promise<WasmResult<SlabTermination[]>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  const [h, k, l] = miller_index
  return wrapWasmCall(() => JSON.parse(mod.slab_termination_info(json, h, k, l)))
}

// Generate a slab with exact layer counting and termination selection
export async function wasm_generate_slab_layers(
  structure: Crystal,
  miller_index: [number, number, number],
  options?: {
    num_layers?: number
    termination_index?: number
    vacuum?: number
    supercell?: [number, number]
  },
): Promise<WasmResult<Crystal>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  const [h, k, l] = miller_index
  const num_layers = options?.num_layers ?? 4
  const termination_index = options?.termination_index ?? 0
  const vacuum = options?.vacuum ?? 15
  const [sc_a, sc_b] = options?.supercell ?? [1, 1]

  try {
    const result = mod.generate_slab_layers(
      json, h, k, l, num_layers, termination_index, vacuum, sc_a, sc_b,
    )
    if (`error` in result) return result as { error: string }
    const slab = JSON.parse(result.ok) as Crystal

    // Enforce right-handed coordinate system
    if (slab.lattice?.matrix) {
      const m = slab.lattice.matrix
      const a = m[0] as [number, number, number]
      const b = m[1] as [number, number, number]
      const [new_b, flipped] = ensure_slab_right_handed(a, b)
      if (flipped) {
        m[1] = new_b
        for (const site of slab.sites) {
          let fb = -(site.abc[1] as number)
          fb = fb - Math.floor(fb)
          if (fb >= 1.0) fb = 0.0
          site.abc[1] = fb
          // Recompute xyz from updated abc and lattice
          const [fa, fc] = [site.abc[0] as number, site.abc[2] as number]
          site.xyz = [
            fa * m[0][0] + fb * m[1][0] + fc * m[2][0],
            fa * m[0][1] + fb * m[1][1] + fc * m[2][1],
            fa * m[0][2] + fb * m[1][2] + fc * m[2][2],
          ]
        }
      }
    }

    return { ok: slab }
  } catch (err) {
    return { error: `generate_slab_layers failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// =============================================================================
// Moiré (twisted-bilayer) Functions (WASM)
// =============================================================================
//
// These mirror the /api/moire/search and /api/moire/build backend endpoints so
// they can run 100% client-side (STATIC_ONLY). Request/response JSON shapes
// match src/lib/api/moire.ts. The WASM exports take a JSON string request and
// return WasmResult<string> whose ok field is a JSON string of the response.

// Search for commensurate Moiré twist angles (WASM backend).
// `request` is the full { layer_a, layer_b, params } object (matches the
// backend request body). Returns the parsed MoireAngleSearchResult-shaped JSON.
export async function wasm_moire_search<TResult = unknown>(
  request: unknown,
): Promise<WasmResult<TResult>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(request)
  try {
    const result = mod.moire_search(json)
    if (`error` in result) return result as { error: string }
    return { ok: JSON.parse(result.ok) as TResult }
  } catch (err) {
    return { error: `Moiré search failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// Build a Moiré bilayer supercell from a candidate (WASM backend).
// `request` is the full { layer_a, layer_b, candidate, params } object.
// Returns the parsed MoireBuildResult-shaped JSON.
export async function wasm_build_moire<TResult = unknown>(
  request: unknown,
): Promise<WasmResult<TResult>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(request)
  try {
    const result = mod.build_moire(json)
    if (`error` in result) return result as { error: string }
    return { ok: JSON.parse(result.ok) as TResult }
  } catch (err) {
    return { error: `Moiré build failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// =============================================================================
// Ewald Summation Functions
// =============================================================================

// Compute Ewald energy with explicit charges
export async function compute_ewald(
  structure: Crystal,
  charges: number[],
  options?: {
    eta?: number
    real_cutoff?: number
    recip_cutoff?: number
  },
): Promise<WasmResult<EwaldResult>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  const eta = options?.eta ?? 0.3
  const real_cutoff = options?.real_cutoff ?? 15
  const recip_cutoff = options?.recip_cutoff ?? 2
  const charges_json = JSON.stringify(charges)
  return wrapWasmCall(() =>
    JSON.parse(mod.compute_ewald(json, charges_json, eta, real_cutoff, recip_cutoff) as unknown as string),
  )
}

// Compute Ewald energy using oxidation states as charges
export async function compute_ewald_from_species(
  structure: Crystal,
  options?: {
    eta?: number
    real_cutoff?: number
    recip_cutoff?: number
  },
): Promise<WasmResult<EwaldResult | null>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  const eta = options?.eta ?? 0.3
  const real_cutoff = options?.real_cutoff ?? 15
  const recip_cutoff = options?.recip_cutoff ?? 2
  return wrapWasmCall(() => {
    const result = mod.compute_ewald_from_species(json, eta, real_cutoff, recip_cutoff) as unknown as string
    return result === `null` ? null : JSON.parse(result)
  })
}

// Compute Ewald energy with automatic parameter optimization
export async function compute_ewald_auto(
  structure: Crystal,
  charges: number[],
  accuracy: number = 1e-6,
): Promise<WasmResult<EwaldAutoResult>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  const charges_json = JSON.stringify(charges)
  return wrapWasmCall(() =>
    JSON.parse(mod.compute_ewald_auto(json, charges_json, accuracy) as unknown as string),
  )
}

// ================== Bond Detection ==================

// Detect bonds using covalent radii sum algorithm
// Fast algorithm suitable for quick visualization
export async function detect_bonds_radii(
  structure: Crystal,
  options?: AtomRadiiBondingOptions,
): Promise<WasmResult<WasmBond[]>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  const options_json = options ? JSON.stringify(options) : undefined
  return wrapWasmCall(() =>
    JSON.parse(mod.detect_bonds_radii(json, options_json) as unknown as string),
  )
}

// Detect bonds using electronegativity-based algorithm
// More chemically accurate, considers metal/nonmetal properties
export async function detect_bonds_electronegativity(
  structure: Crystal,
  options?: ElectronegBondingOptions,
): Promise<WasmResult<WasmBond[]>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  const options_json = options ? JSON.stringify(options) : undefined
  return wrapWasmCall(() =>
    JSON.parse(mod.detect_bonds_electronegativity(json, options_json) as unknown as string),
  )
}

// Detect bonds using solid angle-based algorithm
// Geometry-only (no chemical preferences), inspired by Voronoi tessellation
export async function detect_bonds_solid_angle(
  structure: Crystal,
  options?: SolidAngleBondingOptions,
): Promise<WasmResult<WasmBond[]>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  const options_json = options ? JSON.stringify(options) : undefined
  return wrapWasmCall(() =>
    JSON.parse(mod.detect_bonds_solid_angle(json, options_json) as unknown as string),
  )
}

// Detect hydrogen bonds using Baker-Hubbard criteria
// Takes pre-computed covalent bonds as input
export async function detect_hydrogen_bonds_wasm(
  structure: Crystal,
  covalent_bonds: WasmBond[],
  options?: WasmHBondOptions,
): Promise<WasmResult<WasmHydrogenBond[]>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  const bonds_json = JSON.stringify(covalent_bonds)
  const options_json = options ? JSON.stringify(options) : undefined
  return wrapWasmCall(() =>
    JSON.parse(mod.detect_hydrogen_bonds(json, bonds_json, options_json) as unknown as string),
  )
}

// =============================================================================
// Optimizer Functions (UFF/FIRE)
// =============================================================================

/**
 * Optimize a structure using UFF (Universal Force Field) with FIRE algorithm.
 *
 * This is a lightweight optimizer suitable for small molecules that runs entirely
 * in the browser without needing a backend server.
 *
 * Note: This optimizer is designed for isolated molecules (non-periodic).
 * For periodic systems or accurate calculations, use a proper DFT/ML backend.
 *
 * @param structure - Input structure to optimize
 * @param options - Optimizer configuration options
 * @returns Optimization result with optimized structure and history
 */
export async function optimize_structure_uff(
  structure: Crystal,
  options?: UFFOptimizerConfig,
): Promise<WasmResult<UFFOptimizationResult>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  const options_json = options ? JSON.stringify(options) : undefined
  // WasmResult<String> from tsify returns { ok: "json_string" } or { error: "msg" }
  const result = mod.optimize_structure_uff(json, options_json) as unknown as
    { ok: string } | { error: string }
  if (`error` in result) return result as { error: string }
  return { ok: JSON.parse(result.ok) }
}

/**
 * Run a single optimization step (for interactive/animated optimization).
 *
 * This allows running optimization step-by-step for visualization purposes.
 *
 * @param structure - Current structure
 * @param options - Optimizer configuration options
 * @returns Single step result with updated structure and energy/forces
 */
export async function optimize_step_uff(
  structure: Crystal,
  options?: UFFOptimizerConfig,
): Promise<WasmResult<UFFStepResult>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  const options_json = options ? JSON.stringify(options) : undefined
  const result = mod.optimize_step_uff(json, options_json) as unknown as
    { ok: string } | { error: string }
  if (`error` in result) return result as { error: string }
  return { ok: JSON.parse(result.ok) }
}

// =============================================================================
// VSEPR Optimizer Functions
// =============================================================================

/**
 * Optimize a structure using VSEPR (Valence Shell Electron Pair Repulsion) model.
 *
 * This optimizer arranges ligands around central atoms based on VSEPR theory,
 * producing idealized molecular geometries. It runs entirely in the browser
 * via WASM without needing a backend server.
 *
 * @param structure - Input structure to optimize
 * @param options - VSEPR optimizer configuration options
 * @returns Optimization result with optimized structure
 */
export async function optimize_structure_vsepr(
  structure: Crystal,
  options?: VSEPROptimizerConfig,
): Promise<WasmResult<VSEPROptimizationResult>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  const options_json = options ? JSON.stringify(options) : undefined
  // WasmResult<String> from tsify returns { ok: "json_string" } or { error: "msg" }
  const result = mod.optimize_structure_vsepr(json, options_json) as unknown as
    { ok: string } | { error: string }
  if (`error` in result) return result as { error: string }
  return { ok: JSON.parse(result.ok) }
}

// =============================================================================
// XRD (X-ray Diffraction) Functions
// =============================================================================

// JsXrdPattern from WASM (field names differ from TS XrdPattern)
interface JsXrdPattern {
  two_theta: number[]
  intensities: number[]
  hkls: Array<Array<{ hkl: [number, number, number]; multiplicity: number }>>
  d_spacings: number[]
}

/**
 * Compute powder XRD pattern using WASM backend (Rust implementation).
 *
 * @param structure - Crystal structure with lattice
 * @param options - XRD options: wavelength (Å), two_theta_range, debye_waller_factors, scaled
 * @returns XRD pattern with 2theta angles, intensities, hkls, d-spacings
 */
export async function wasm_compute_xrd(
  structure: Crystal,
  options?: {
    wavelength?: number
    two_theta_range?: [number, number]
    debye_waller_factors?: Record<string, number>
    scaled?: boolean
  },
): Promise<WasmResult<{
  x: number[]
  y: number[]
  hkls: Array<Array<{ hkl: [number, number, number]; multiplicity: number }>>
  d_hkls: number[]
}>> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const cleanCrystal = JSON.parse(JSON.stringify(jsCrystal))

  const wasm_options = options ? {
    wavelength: options.wavelength,
    two_theta_range: options.two_theta_range,
    debye_waller_factors: options.debye_waller_factors ?? {},
    scaled: options.scaled ?? true,
  } : undefined

  try {
    const result = mod.compute_xrd(cleanCrystal, wasm_options)
    if (`error` in result) return result as { error: string }
    // Convert JsXrdPattern field names to match TS XrdPattern convention
    const pattern = result.ok as JsXrdPattern
    return {
      ok: {
        x: pattern.two_theta,
        y: pattern.intensities,
        hkls: pattern.hkls,
        d_hkls: pattern.d_spacings,
      },
    }
  } catch (err) {
    return { error: `WASM XRD computation failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ─── Adsorption Site Finding (Alpha Shape V7) ────────────────────────────────

import type {
  AdsorptionSiteFinderParams,
  AdsorptionSiteResult,
} from './ferrox-wasm-types'

/**
 * Find adsorption sites on a slab using the Alpha Shape V7 algorithm (no backend needed).
 * Returns top, bridge, hollow3, and hollow4 sites with normal vectors and neighbor info.
 */
export async function wasm_find_adsorption_sites(
  structure: Crystal,
  params: AdsorptionSiteFinderParams = {},
): Promise<AdsorptionSiteResult> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const cleanCrystal = JSON.parse(JSON.stringify(jsCrystal))
  const params_json = Object.keys(params).length > 0 ? JSON.stringify(params) : ``
  const result = mod.adsorbate_find_sites(cleanCrystal, params_json)
  if (`error` in result) throw new Error((result as { error: string }).error)
  return JSON.parse((result as { ok: string }).ok) as AdsorptionSiteResult
}

// =============================================================================
// CrystalNN — Voronoi-based near-neighbor analysis
// =============================================================================

/** CrystalNN configuration (matches pymatgen defaults when omitted). */
export interface CrystalNNConfig {
  weighted_cn?: boolean
  cation_anion?: boolean
  distance_cutoffs?: [number, number] | null
  x_diff_weight?: number
  porous_adjustment?: boolean
  search_cutoff?: number
  fingerprint_length?: number
}

/** Per-neighbor info returned by crystal_nn_all. */
export interface CrystalNNNeighbor {
  site_idx: number
  element: string
  image: [number, number, number]
  weight: number
  distance: number
}

/** Per-site result from crystal_nn_all. */
export interface CrystalNNSiteResult {
  site_idx: number
  cn: number
  neighbors: CrystalNNNeighbor[]
}

/**
 * Run CrystalNN on a single site. Use when only a few sites are needed
 * (e.g., metals-only polyhedra on a 500+ atom MOF).
 */
export async function crystal_nn_single(
  structure: Crystal,
  site_index: number,
  config?: CrystalNNConfig,
): Promise<CrystalNNSiteResult> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const clean = JSON.parse(JSON.stringify(jsCrystal))
  const config_json = config ? JSON.stringify(config) : null
  const result = mod.crystal_nn(clean, site_index, config_json)
  if (`error` in result) throw new Error((result as { error: string }).error)
  const data = JSON.parse((result as { ok: string }).ok) as {
    all_nninfo: CrystalNNNeighbor[]
    cn_weights: Record<string, number>
    cn_nninfo: Record<string, CrystalNNNeighbor[]>
  }
  const best_cn = Object.entries(data.cn_weights)
    .reduce((best, [cn, w]) => w > best[1] ? [cn, w] : best, [`0`, 0])[0]
  const neighbors = data.cn_nninfo[best_cn] ?? data.all_nninfo
  return { site_idx: site_index, cn: neighbors.length, neighbors }
}

/**
 * Run CrystalNN on all sites in a structure.
 * Returns per-site coordination info with neighbor lists.
 */
export async function crystal_nn_all(
  structure: Crystal,
  config?: CrystalNNConfig,
): Promise<CrystalNNSiteResult[]> {
  const mod = await ensure_ferrox_wasm_ready()
  const jsCrystal = pymatgen_to_jscrystal(structure)
  const clean = JSON.parse(JSON.stringify(jsCrystal))
  const config_json = config ? JSON.stringify(config) : null
  const result = mod.crystal_nn_all(clean, config_json)
  if (`error` in result) throw new Error((result as { error: string }).error)
  return JSON.parse((result as { ok: string }).ok) as CrystalNNSiteResult[]
}

// =============================================================================
// PBC Image Site Generation
// =============================================================================

/**
 * Generate PBC image atoms using WASM (fast path for large structures).
 * Returns null if WASM is not ready or fails.
 */
export async function wasm_find_pbc_images(
  structure: Crystal,
  options?: { range_min?: number; range_max?: number; bond_completion?: boolean; bond_tolerance?: number },
): Promise<{
  parent_indices: number[]
  positions_xyz: [number, number, number][]
  positions_abc: [number, number, number][]
  num_translational: number
} | null> {
  let wasm: FerroxWasmModule
  try {
    wasm = await ensure_ferrox_wasm_ready()
  } catch {
    return null
  }
  if (!wasm) return null

  try {
    const crystal = pymatgen_to_jscrystal(structure)
    const opts = options ? JSON.stringify(options) : undefined
    const result = wasm.find_pbc_image_sites(crystal, opts)
    if ('error' in result) {
      console.warn('[ferrox-wasm] find_pbc_image_sites failed:', result.error)
      return null
    }
    return result.ok
  } catch (e) {
    console.warn('[ferrox-wasm] find_pbc_image_sites error:', e)
    return null
  }
}

// =============================================================================
// Nanotube Builder (WASM)
// =============================================================================

/** 2D layer input for the nanotube builder (matches Rust JsNanotubeLayer). */
export interface WasmNanotubeLayer {
  lattice_vectors: [[number, number], [number, number]]
  elements: string[]
  basis_coords: [number, number][]
  z_coords?: number[]
}

/** Geometry-only result of nanotube_info (matches Rust JsNanotubeInfo). */
export interface WasmNanotubeInfo {
  chiral_angle_deg: number
  circumference: number
  diameter: number
  radius: number
  trans_length: number
  tube_length: number
  n_atoms_estimate: number
  t1: number
  t2: number
  chirality: string
  message: string
}

/** Per-wall info returned by the nanotube builder. */
export interface WasmNanotubeWall {
  n: number
  m: number
  radius: number
  n_atoms: number
}

/** Build result from build_nanotube (structure converted back to pymatgen). */
export interface WasmNanotubeBuild {
  structure: Crystal
  n_atoms: number
  chiral_angle_deg: number
  circumference: number
  diameter: number
  tube_length: number
  chirality: string
  n_walls: number
  walls: WasmNanotubeWall[]
  message: string
}

/** Compute nanotube geometry info entirely in the browser (no backend). */
export async function wasm_nanotube_info(
  layer: WasmNanotubeLayer,
  n: number,
  m: number,
  nl = 1,
): Promise<WasmResult<WasmNanotubeInfo>> {
  const mod = await ensure_ferrox_wasm_ready()
  // Clean plain object to avoid Svelte Proxy / prototype issues in serde.
  const cleanLayer = JSON.parse(JSON.stringify(layer))
  try {
    const result = mod.nanotube_info(cleanLayer, n, m, nl)
    if (`error` in result) return result as { error: string }
    return { ok: result.ok as WasmNanotubeInfo }
  } catch (err) {
    return { error: `nanotube_info failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Build a nanotube entirely in the browser (no backend). */
export async function wasm_build_nanotube(
  layer: WasmNanotubeLayer,
  n: number,
  m: number,
  options?: {
    nl?: number
    vacuum?: number
    n_walls?: number
    interlayer_spacing?: number
  },
): Promise<WasmResult<WasmNanotubeBuild>> {
  const mod = await ensure_ferrox_wasm_ready()
  const nl = options?.nl ?? 1
  const vacuum = options?.vacuum ?? 15.0
  const n_walls = options?.n_walls ?? 1
  const interlayer = options?.interlayer_spacing ?? 3.4
  const cleanLayer = JSON.parse(JSON.stringify(layer))
  try {
    const result = mod.build_nanotube(cleanLayer, n, m, nl, vacuum, n_walls, interlayer)
    if (`error` in result) return result as { error: string }
    const raw = result.ok as Record<string, unknown>
    return {
      ok: {
        structure: jscrystal_to_pymatgen(raw.structure),
        n_atoms: raw.n_atoms as number,
        chiral_angle_deg: raw.chiral_angle_deg as number,
        circumference: raw.circumference as number,
        diameter: raw.diameter as number,
        tube_length: raw.tube_length as number,
        chirality: raw.chirality as string,
        n_walls: raw.n_walls as number,
        walls: raw.walls as WasmNanotubeWall[],
        message: raw.message as string,
      },
    }
  } catch (err) {
    return { error: `build_nanotube failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// =============================================================================
// Pseudo-Hydrogen Passivation (client-side, no backend needed)
// =============================================================================

/**
 * Passivate slab surface dangling bonds with pseudo-hydrogen atoms.
 *
 * Faithful client-side port of `/api/pseudo-hydrogen/passivate`. Requires a
 * slab and a bulk reference structure. The result JSON matches the backend's
 * `PseudoHydrogenResult` shape exactly (structure, n_pseudo_h, pseudo_h_list,
 * bulk_coordination, valence_used, unique_potcars, bond_warnings, message).
 *
 * Returns the parsed result object. Throws on WASM error.
 */
export async function wasm_passivate_slab(
  slab: Crystal,
  bulk: Crystal,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const mod = await ensure_ferrox_wasm_ready()
  const slab_js = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(slab)))
  const bulk_js = JSON.parse(JSON.stringify(pymatgen_to_jscrystal(bulk)))
  const params_json = params && Object.keys(params).length > 0 ? JSON.stringify(params) : ``
  const result = mod.passivate_slab(slab_js, bulk_js, params_json)
  if (`error` in result) throw new Error((result as { error: string }).error)
  return JSON.parse((result as { ok: string }).ok)
}
