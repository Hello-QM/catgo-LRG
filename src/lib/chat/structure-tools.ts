import type { AnyStructure } from '$lib'
import type { ClientTool, ToolKind } from './types'
import { get_current_structure, set_current_structure } from '$lib/structure/current-structure.svelte'
import { relay_fetch } from './provider-routing'

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
    const limit = Number(input.limit ?? 5)
    const filter = `chemical_formula_reduced="${String(input.formula)}"`
    const url = `${base}/v1/structures?page_limit=${limit}&filter=${encodeURIComponent(filter)}`
    const resp = await relay_fetch(url, { headers: { Accept: `application/vnd.api+json` } })
    if (!resp.ok) throw new Error(`OPTIMADE error ${resp.status}`)
    const data = (await resp.json()) as { data?: { id: string; attributes?: Record<string, unknown> }[] }
    return {
      results: (data.data ?? []).map((d) => ({ id: d.id, formula: d.attributes?.chemical_formula_reduced })),
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
