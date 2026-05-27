import type { AnyStructure } from '$lib'
import type { ClientTool, ToolKind } from './types'
import { get_current_structure, set_current_structure } from '$lib/structure/current-structure.svelte'
import { relay_fetch } from './provider-routing'
import { search_optimade_structures } from '$lib/api/optimade'
import {
  create_supercell,
  get_spacegroup as ferrox_spacegroup,
  get_distance as ferrox_distance,
  wasm_compute_xrd as ferrox_xrd,
} from '$lib/structure/ferrox-wasm'
import { generate_slab as ferrox_generate_slab } from '$lib/structure/miller-slab'
import { cartesian_to_fractional } from '$lib/structure/lattice-ops'

/** Minimal pymatgen-site shape the mutate executors read/write. */
interface MutSite {
  species: { element: string; occu?: number }[]
  abc?: number[]
  xyz?: number[]
  label?: string
}
interface MutStructure {
  sites: MutSite[]
  lattice?: { matrix: number[][] }
}

/** Deep-clone the current structure. `structuredClone` cannot handle the
 *  Svelte `$state` proxy the store holds ("could not be cloned"), so we use a
 *  JSON round-trip — safe for plain pymatgen structures (no functions/cycles).
 *  NOTE: requires JSON-safe `properties` (no functions, cycles, or class
 *  instances); anything not JSON-serializable is silently dropped. */
function clone_structure(): MutStructure {
  return JSON.parse(JSON.stringify(require_structure())) as MutStructure
}

type Executor = (input: Record<string, unknown>) => Promise<unknown> | unknown

interface ToolEntry {
  def: ClientTool
  run: Executor
}

const REGISTRY = new Map<string, ToolEntry>()

/**
 * Exported tool-schema list. Kept as a stable array reference (the test and
 * later tasks import it directly), but `register()` pushes into it on every
 * registration, so it always reflects ALL registered tools regardless of the
 * order in which `register(...)` calls appear in this file.
 */
export const CLIENT_TOOLS: ClientTool[] = []

function register(def: ClientTool, run: Executor): void {
  REGISTRY.set(def.name, { def, run })
  if (!CLIENT_TOOLS.some((t) => t.name === def.name)) CLIENT_TOOLS.push(def)
}

/** Require an active structure or throw a user-facing error. */
function require_structure(): AnyStructure {
  const s = get_current_structure()
  if (!s) throw new Error(`No structure is currently loaded in the viewer.`)
  return s
}

// ── get_structure_info (read) ──
register(
  {
    name: `get_structure_info`,
    description: `Get composition, formula, site count, and lattice of the currently loaded structure.`,
    kind: `read`,
    input_schema: { type: `object`, properties: {} },
  },
  () => {
    const s = require_structure() as {
      sites: { species: { element: string }[] }[]
      lattice?: { matrix: number[][] }
    }
    const elements = [...new Set(s.sites.map((site) => site.species[0]?.element).filter(Boolean))]
    return { num_sites: s.sites.length, elements, lattice: s.lattice?.matrix ?? null }
  },
)

const OPTIMADE_BASES: Record<string, string> = {
  mp: `https://optimade.materialsproject.org`,
  alexandria: `https://alexandria.icams.rub.de/pbe`,
  odbx: `https://optimade.odbx.science`,
}

// ── fetch_optimade (read) ──
register(
  {
    name: `fetch_optimade`,
    description: `Search an OPTIMADE crystal-structure database by chemical formula. Providers: mp (Materials Project), alexandria, odbx.`,
    kind: `read`,
    input_schema: {
      type: `object`,
      properties: {
        provider: { type: `string`, enum: [`mp`, `alexandria`, `odbx`], description: `Database provider id.` },
        formula: { type: `string`, description: `Reduced chemical formula, e.g. "NaCl".` },
        limit: { type: `integer`, description: `Max results (default 5).` },
      },
      required: [`provider`, `formula`],
    },
  },
  async (input) => {
    const provider = String(input.provider)
    const base = OPTIMADE_BASES[provider]
    if (!base) throw new Error(`Unknown OPTIMADE provider: ${provider}`)
    // Delegate to the shared search used by the Search-Database modal so the
    // formula is normalized correctly: element-only formulas like "NaCl" become
    // an `elements HAS ALL` query (chemical_formula_reduced is alphabetical+reduced,
    // i.e. "ClNa", so a literal "NaCl" match returns nothing). relay routing,
    // provider base_url resolution, and sorting are reused.
    const providers = [{
      id: provider, type: `links`,
      attributes: { name: provider, description: ``, base_url: base },
    }]
    const res = await search_optimade_structures(provider, providers as never, {
      formula: String(input.formula),
      limit: Number(input.limit ?? 5),
    })
    return {
      results: res.structures.map((s) => ({
        id: s.id,
        formula: (s.attributes as { chemical_formula_reduced?: string } | undefined)?.chemical_formula_reduced,
      })),
    }
  },
)

// ── fetch_pubchem (read) ──
register(
  {
    name: `fetch_pubchem`,
    description: `Look up a molecule by name in PubChem and return its CID and canonical SMILES.`,
    kind: `read`,
    input_schema: {
      type: `object`,
      properties: { name: { type: `string`, description: `Molecule name, e.g. "water".` } },
      required: [`name`],
    },
  },
  async (input) => {
    const name = encodeURIComponent(String(input.name))
    const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${name}/property/CanonicalSMILES/JSON`
    const resp = await relay_fetch(url)
    if (!resp.ok) throw new Error(`PubChem error ${resp.status}`)
    const data = (await resp.json()) as { PropertyTable?: { Properties?: { CID: number; CanonicalSMILES: string }[] } }
    const p = data.PropertyTable?.Properties?.[0]
    if (!p) throw new Error(`No PubChem match for "${input.name}"`)
    return { cid: p.CID, smiles: p.CanonicalSMILES }
  },
)

// ── make_supercell (mutate) ──
register(
  {
    name: `make_supercell`,
    description: `Replicate the current structure into an nx×ny×nz supercell.`,
    kind: `mutate`,
    input_schema: {
      type: `object`,
      properties: {
        nx: { type: `integer`, minimum: 1, description: `Repeats along a (≥1).` },
        ny: { type: `integer`, minimum: 1, description: `Repeats along b (≥1).` },
        nz: { type: `integer`, minimum: 1, description: `Repeats along c (≥1).` },
      },
      required: [`nx`, `ny`, `nz`],
    },
  },
  async (input) => {
    const nx = Math.trunc(Number(input.nx))
    const ny = Math.trunc(Number(input.ny))
    const nz = Math.trunc(Number(input.nz))
    if (!(nx >= 1 && ny >= 1 && nz >= 1)) throw new Error(`nx, ny, nz must be integers ≥ 1.`)
    const res = await create_supercell(require_structure() as never, nx, ny, nz)
    if (`error` in res) throw new Error(res.error)
    set_current_structure(res.ok as never)
    return { num_sites: (res.ok as unknown as MutStructure).sites.length }
  },
)

// ── substitute_element (mutate) ──
register(
  {
    name: `substitute_element`,
    description: `Replace every atom of one element with another element.`,
    kind: `mutate`,
    input_schema: {
      type: `object`,
      properties: {
        from: { type: `string`, description: `Element symbol to replace, e.g. "Na".` },
        to: { type: `string`, description: `Replacement element symbol, e.g. "K".` },
      },
      required: [`from`, `to`],
    },
  },
  (input) => {
    const from = String(input.from)
    const to = String(input.to)
    const next = clone_structure()
    let replaced = 0
    for (const site of next.sites) {
      if (site.species[0]?.element === from) {
        site.species[0].element = to
        if (site.label === from) site.label = to
        replaced++
      }
    }
    if (replaced === 0) throw new Error(`No atoms of element "${from}" found.`)
    set_current_structure(next as never)
    return { replaced }
  },
)

// ── generate_slab (mutate) ──
register(
  {
    name: `generate_slab`,
    description: `Cut a surface slab from the current bulk structure along a Miller plane (h,k,l) with given thickness and vacuum (Angstroms).`,
    kind: `mutate`,
    input_schema: {
      type: `object`,
      properties: {
        h: { type: `integer`, description: `Miller index h.` },
        k: { type: `integer`, description: `Miller index k.` },
        l: { type: `integer`, description: `Miller index l.` },
        thickness: { type: `number`, description: `Slab thickness in Angstroms (default 10).` },
        vacuum: { type: `number`, description: `Vacuum layer thickness in Angstroms (default 15).` },
      },
      required: [`h`, `k`, `l`],
    },
  },
  (input) => {
    const h = Math.trunc(Number(input.h))
    const k = Math.trunc(Number(input.k))
    const l = Math.trunc(Number(input.l))
    const thickness = input.thickness === undefined ? 10 : Number(input.thickness)
    const vacuum = input.vacuum === undefined ? 15 : Number(input.vacuum)
    const slab = ferrox_generate_slab(require_structure() as never, {
      miller_index: [h, k, l],
      offset: 0,
      thickness,
      vacuum,
    })
    set_current_structure(slab as never)
    return { num_sites: (slab as unknown as MutStructure).sites.length }
  },
)

// ── place_adsorbate (mutate) ──
register(
  {
    name: `place_adsorbate`,
    description: `Add a single adsorbate atom at a Cartesian position [x, y, z] in the current structure.`,
    kind: `mutate`,
    input_schema: {
      type: `object`,
      properties: {
        element: { type: `string`, description: `Adsorbate element symbol, e.g. "H".` },
        position: {
          type: `array`,
          items: { type: `number` },
          minItems: 3,
          maxItems: 3,
          description: `Cartesian position [x, y, z] in Angstroms.`,
        },
      },
      required: [`element`, `position`],
    },
  },
  (input) => {
    const element = String(input.element)
    const position = (input.position as number[]).map(Number)
    const next = clone_structure()
    const site: MutSite = { species: [{ element, occu: 1 }], xyz: [...position], label: element }
    // `abc` must be FRACTIONAL coordinates — downstream consumers (e.g.
    // lattice-ops) prefer `abc` over `xyz` when present. With a lattice,
    // convert the Cartesian position to fractional; without one (molecule),
    // omit `abc` so consumers derive it from `xyz`.
    if (next.lattice?.matrix) {
      site.abc = cartesian_to_fractional(
        position as [number, number, number],
        next.lattice.matrix as [[number, number, number], [number, number, number], [number, number, number]],
      )
    }
    next.sites.push(site)
    set_current_structure(next as never)
    return { num_sites: next.sites.length }
  },
)

// ── get_spacegroup (read) ──
register(
  {
    name: `get_spacegroup`,
    description: `Determine the international spacegroup number of the current structure (symmetry analysis).`,
    kind: `read`,
    input_schema: {
      type: `object`,
      properties: {
        symprec: { type: `number`, description: `Symmetry precision in Angstroms (default 1e-4).` },
      },
    },
  },
  async (input) => {
    const symprec = input.symprec === undefined ? 1e-4 : Number(input.symprec)
    const res = await ferrox_spacegroup(require_structure() as never, symprec)
    if (`error` in res) throw new Error(res.error)
    return { spacegroup_number: res.ok }
  },
)

// ── get_distance (read) ──
register(
  {
    name: `get_distance`,
    description: `Compute the minimum-image distance (Angstroms) between two atoms by site index.`,
    kind: `read`,
    input_schema: {
      type: `object`,
      properties: {
        i: { type: `integer`, minimum: 0, description: `First site index (0-based).` },
        j: { type: `integer`, minimum: 0, description: `Second site index (0-based).` },
      },
      required: [`i`, `j`],
    },
  },
  async (input) => {
    const i = Math.trunc(Number(input.i))
    const j = Math.trunc(Number(input.j))
    const res = await ferrox_distance(require_structure() as never, i, j)
    if (`error` in res) throw new Error(res.error)
    return { distance: res.ok }
  },
)

// ── compute_xrd (read) ──
register(
  {
    name: `compute_xrd`,
    description: `Compute the simulated powder X-ray diffraction (XRD) pattern of the current structure.`,
    kind: `read`,
    input_schema: { type: `object`, properties: {} },
  },
  async () => {
    const res = await ferrox_xrd(require_structure() as never)
    if (`error` in res) throw new Error(res.error)
    return res.ok
  },
)

export function tool_kind(name: string): ToolKind | undefined {
  return REGISTRY.get(name)?.def.kind
}

/** Execute a tool by name; always resolves to a JSON string (errors included). */
export async function execute_tool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const entry = REGISTRY.get(name)
  if (!entry) return JSON.stringify({ error: `Unknown tool: ${name}` })
  try {
    const result = await entry.run(input)
    return JSON.stringify(result ?? { ok: true })
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

// Re-export so later tasks can register mutating tools that write structures back.
export { set_current_structure, register }
