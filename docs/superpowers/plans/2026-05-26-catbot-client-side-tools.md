# CatBot Client-Side Tool-Calling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let CatBot run an agentic tool-calling loop entirely in the browser (user-supplied API key, OpenAI-compat function-calling), executing structure operations via ferrox-wasm, so it works in `STATIC_ONLY` deploys with no Python backend.

**Architecture:** Add a third "client-direct" branch to `chat-state.send()` alongside the existing SDK and universal branches. The branch drives `tool-loop.ts`, which calls the provider directly through `client-llm.ts`, gates mutating tools via the existing `PermissionCard` UI, and executes tools from a `structure-tools.ts` registry backed by ferrox-wasm + the `current-structure` store. CORS-blocked targets (Materials Project OPTIMADE, some LLM endpoints) route through a thin host-allowlisted Cloudflare Worker relay.

**Tech Stack:** TypeScript, Svelte 5 runes, Vitest, ferrox-wasm (Rust→WASM), Cloudflare Workers (relay).

**Spec:** `docs/superpowers/specs/2026-05-26-catbot-client-side-tools-design.md`

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `src/lib/chat/types.ts` | Add `client_direct` flag to `ChatConfig`; add `ClientTool`, `ToolCall`, `ToolKind` types | Modify |
| `src/lib/chat/provider-routing.ts` | `is_client_direct(config)` decision + `needs_relay(url)` + `relay_url(url)` helpers | Create |
| `src/lib/chat/structure-tools.ts` | Tool registry: `ClientTool[]` schemas tagged read/mutate + `execute_tool(name, input)` dispatcher backed by ferrox-wasm / current-structure / fetch | Create |
| `src/lib/chat/client-llm.ts` | Browser-direct OpenAI function-calling transport: build request, stream, parse `tool_calls` + text deltas; route via relay when needed | Create |
| `src/lib/chat/tool-loop.ts` | Agentic loop: send → parse tool_calls → gate (auto reads / PermissionCard mutates) → execute → re-inject results → repeat until no tool calls; emit chat-state-compatible events | Create |
| `src/lib/chat/chat-state.svelte.ts` | Add third branch in `send()` calling `tool-loop`; reuse `active_tool_blocks`/`active_permission_blocks` | Modify (`:455-590`) |
| `workers/cors-relay/src/index.ts` | Cloudflare Worker: host-allowlisted pure passthrough, `ACAO:*`, preflight | Create |
| `workers/cors-relay/wrangler.relay.toml` | Worker config + `ALLOWED_HOSTS` var | Create |
| `workers/cors-relay/test/relay.test.ts` | Worker unit tests (allowlist, header forwarding, preflight) | Create |
| `src/lib/api/optimade.ts` | Route MP OPTIMADE through relay in static mode (`:592-621`) | Modify |

**Tool set delivered this plan** (extensible registry — adding more ferrox tools is a schema+executor+test triple following the same pattern):

- Reads (auto-run): `get_structure_info`, `fetch_optimade`, `fetch_pubchem`, `get_spacegroup`, `get_distance`, `compute_xrd`
- Mutations (PermissionCard): `make_supercell`, `generate_slab`, `place_adsorbate`, `substitute_element`

---

## Task 1: ChatConfig flag + provider routing helpers

**Files:**
- Modify: `src/lib/chat/types.ts`
- Create: `src/lib/chat/provider-routing.ts`
- Test: `src/lib/chat/provider-routing.test.ts`

- [ ] **Step 1: Add types to `types.ts`**

After the `ChatConfig` interface (`src/lib/chat/types.ts:54-65`), add the `client_direct` field and new tool types:

```typescript
// Add to ChatConfig interface (after `mode: ProviderMode`):
  client_direct?: boolean // run tool-calling loop in-browser (no backend); auto-on under STATIC_ONLY
```

Append at end of `types.ts`:

```typescript
export type ToolKind = `read` | `mutate`

export interface ClientTool {
  name: string
  description: string
  kind: ToolKind
  input_schema: Record<string, unknown>
}

/** A tool call parsed from the model's response. */
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}
```

- [ ] **Step 2: Write failing test for routing helpers**

Create `src/lib/chat/provider-routing.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { needs_relay, relay_url, RELAY_URL } from './provider-routing'

describe('needs_relay', () => {
  it('flags Materials Project OPTIMADE host', () => {
    expect(needs_relay('https://optimade.materialsproject.org/v1/structures')).toBe(true)
  })
  it('passes open CORS providers through directly', () => {
    expect(needs_relay('https://alexandria.icams.rub.de/pbe/v1/structures')).toBe(false)
    expect(needs_relay('https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound')).toBe(false)
  })
})

describe('relay_url', () => {
  it('wraps a target URL as a relay query param', () => {
    const wrapped = relay_url('https://optimade.materialsproject.org/v1/structures?x=1')
    expect(wrapped).toBe(`${RELAY_URL}/?url=${encodeURIComponent('https://optimade.materialsproject.org/v1/structures?x=1')}`)
  })
})
```

- [ ] **Step 3: Run test, verify it fails**

Run: `rtk proxy pnpm exec vitest run src/lib/chat/provider-routing.test.ts`
Expected: FAIL — `Cannot find module './provider-routing'`

- [ ] **Step 4: Implement `provider-routing.ts`**

Create `src/lib/chat/provider-routing.ts`:

```typescript
import { STATIC_ONLY } from '$lib/api/config'
import type { ChatConfig } from './types'
import { SDK_PROVIDERS } from './types'

/** Edge CORS relay base URL. Build-time injected; falls back to a default deploy. */
export const RELAY_URL: string =
  (typeof import.meta.env.VITE_CORS_RELAY_URL === `string` && import.meta.env.VITE_CORS_RELAY_URL) ||
  `https://catgo-cors-relay.workers.dev`

/** Hosts known to block browser CORS — fetches to these must go through the relay. */
const RELAY_HOSTS = new Set<string>([`optimade.materialsproject.org`])

export function needs_relay(url: string): boolean {
  try {
    return RELAY_HOSTS.has(new URL(url).host)
  } catch {
    return false
  }
}

export function relay_url(url: string): string {
  return `${RELAY_URL}/?url=${encodeURIComponent(url)}`
}

/** A fetch wrapper that transparently routes CORS-blocked hosts via the relay. */
export function relay_fetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(needs_relay(url) ? relay_url(url) : url, init)
}

/** True when the tool-calling loop should run in-browser (no backend proxy). */
export function is_client_direct(config: ChatConfig): boolean {
  if (SDK_PROVIDERS.has(config.provider)) return false // SDK agents always backend
  return STATIC_ONLY || config.client_direct === true
}
```

- [ ] **Step 5: Run test, verify it passes**

Run: `rtk proxy pnpm exec vitest run src/lib/chat/provider-routing.test.ts`
Expected: PASS (4 assertions)

- [ ] **Step 6: Commit**

```bash
git add src/lib/chat/types.ts src/lib/chat/provider-routing.ts src/lib/chat/provider-routing.test.ts
git commit -m "feat(catbot): client-direct routing + relay helpers"
```

---

## Task 2: structure-tools registry skeleton + first read tool

**Files:**
- Create: `src/lib/chat/structure-tools.ts`
- Test: `src/lib/chat/structure-tools.test.ts`

- [ ] **Step 1: Write failing test for `get_structure_info`**

Create `src/lib/chat/structure-tools.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { CLIENT_TOOLS, execute_tool, tool_kind } from './structure-tools'
import { set_current_structure } from '$lib/structure/current-structure.svelte'

const CUBIC_NACL = {
  '@module': 'pymatgen.core.structure',
  '@class': 'Structure',
  lattice: { matrix: [[5.6, 0, 0], [0, 5.6, 0], [0, 0, 5.6]] },
  sites: [
    { species: [{ element: 'Na', occu: 1 }], abc: [0, 0, 0], xyz: [0, 0, 0], label: 'Na' },
    { species: [{ element: 'Cl', occu: 1 }], abc: [0.5, 0.5, 0.5], xyz: [2.8, 2.8, 2.8], label: 'Cl' },
  ],
}

describe('structure-tools registry', () => {
  beforeEach(() => set_current_structure(CUBIC_NACL as never))

  it('registers get_structure_info as a read tool', () => {
    expect(CLIENT_TOOLS.find((t) => t.name === 'get_structure_info')).toBeTruthy()
    expect(tool_kind('get_structure_info')).toBe('read')
  })

  it('get_structure_info returns composition + site count', async () => {
    const out = JSON.parse(await execute_tool('get_structure_info', {}))
    expect(out.num_sites).toBe(2)
    expect(out.elements).toEqual(expect.arrayContaining(['Na', 'Cl']))
  })

  it('returns an error result for an unknown tool', async () => {
    const out = JSON.parse(await execute_tool('does_not_exist', {}))
    expect(out.error).toMatch(/unknown tool/i)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `rtk proxy pnpm exec vitest run src/lib/chat/structure-tools.test.ts`
Expected: FAIL — `Cannot find module './structure-tools'`

- [ ] **Step 3: Implement registry + `get_structure_info`**

Create `src/lib/chat/structure-tools.ts`:

```typescript
import type { AnyStructure } from '$lib'
import type { ClientTool, ToolKind } from './types'
import { get_current_structure, set_current_structure } from '$lib/structure/current-structure.svelte'

type Executor = (input: Record<string, unknown>) => Promise<unknown> | unknown

interface ToolEntry {
  def: ClientTool
  run: Executor
}

const REGISTRY = new Map<string, ToolEntry>()

function register(def: ClientTool, run: Executor): void {
  REGISTRY.set(def.name, { def, run })
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
    const s = require_structure() as { sites: { species: { element: string }[] }[]; lattice?: { matrix: number[][] } }
    const elements = [...new Set(s.sites.map((site) => site.species[0]?.element).filter(Boolean))]
    return { num_sites: s.sites.length, elements, lattice: s.lattice?.matrix ?? null }
  },
)

export const CLIENT_TOOLS: ClientTool[] = []
function rebuild_tool_list(): void {
  CLIENT_TOOLS.length = 0
  for (const { def } of REGISTRY.values()) CLIENT_TOOLS.push(def)
}
rebuild_tool_list()

export function tool_kind(name: string): ToolKind | undefined {
  return REGISTRY.get(name)?.def.kind
}

/** Execute a tool by name; always resolves to a JSON string (errors included). */
export async function execute_tool(name: string, input: Record<string, unknown>): Promise<string> {
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
export { set_current_structure, rebuild_tool_list }
```

- [ ] **Step 4: Run test, verify it passes**

Run: `rtk proxy pnpm exec vitest run src/lib/chat/structure-tools.test.ts`
Expected: PASS (3 assertions)

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat/structure-tools.ts src/lib/chat/structure-tools.test.ts
git commit -m "feat(catbot): client tool registry + get_structure_info"
```

---

## Task 3: Fetch tools (OPTIMADE + PubChem) with relay routing

**Files:**
- Modify: `src/lib/chat/structure-tools.ts`
- Test: `src/lib/chat/structure-tools.test.ts`

- [ ] **Step 1: Write failing test (mock fetch + relay routing)**

Append to `src/lib/chat/structure-tools.test.ts`:

```typescript
import { vi } from 'vitest'
import * as routing from './provider-routing'

describe('fetch_optimade tool', () => {
  it('is a read tool and routes MP through the relay', async () => {
    expect(routing.needs_relay('https://optimade.materialsproject.org/v1/structures')).toBe(true)
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'mp-1', attributes: { chemical_formula_reduced: 'NaCl' } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    )
    const out = JSON.parse(await execute_tool('fetch_optimade', { provider: 'mp', formula: 'NaCl', limit: 1 }))
    expect(out.results[0].id).toBe('mp-1')
    // The MP request must have gone through the relay URL, not direct.
    expect(spy.mock.calls[0][0]).toContain(routing.RELAY_URL)
    spy.mockRestore()
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `rtk proxy pnpm exec vitest run src/lib/chat/structure-tools.test.ts -t fetch_optimade`
Expected: FAIL — `Unknown tool: fetch_optimade` (assertion on `out.results` throws)

- [ ] **Step 3: Implement fetch tools**

Add to `src/lib/chat/structure-tools.ts` (after the `get_structure_info` block, before `export const CLIENT_TOOLS`):

```typescript
import { relay_fetch } from './provider-routing'

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
```

Move `rebuild_tool_list()` call to the very end of the file so all `register()` calls run first. (Delete the early `rebuild_tool_list()` invocation from Task 2 and keep the single call at file end.)

- [ ] **Step 4: Run test, verify it passes**

Run: `rtk proxy pnpm exec vitest run src/lib/chat/structure-tools.test.ts`
Expected: PASS (all assertions incl. fetch_optimade relay routing)

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat/structure-tools.ts src/lib/chat/structure-tools.test.ts
git commit -m "feat(catbot): fetch_optimade + fetch_pubchem tools (relay-routed)"
```

---

## Task 4: Mutating tools — supercell, slab, adsorbate, substitution

**Files:**
- Modify: `src/lib/chat/structure-tools.ts`
- Test: `src/lib/chat/structure-tools.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/lib/chat/structure-tools.test.ts`:

```typescript
describe('mutating tools', () => {
  beforeEach(() => set_current_structure(CUBIC_NACL as never))

  it('make_supercell is a mutate tool and grows site count', async () => {
    expect(tool_kind('make_supercell')).toBe('mutate')
    const out = JSON.parse(await execute_tool('make_supercell', { nx: 2, ny: 1, nz: 1 }))
    expect(out.num_sites).toBe(4) // 2 sites × 2
  })

  it('substitute_element replaces species and writes structure back', async () => {
    expect(tool_kind('substitute_element')).toBe('mutate')
    const out = JSON.parse(await execute_tool('substitute_element', { from: 'Na', to: 'K' }))
    expect(out.replaced).toBe(1)
    const info = JSON.parse(await execute_tool('get_structure_info', {}))
    expect(info.elements).toContain('K')
    expect(info.elements).not.toContain('Na')
  })

  it('generate_slab is a mutate tool', () => {
    expect(tool_kind('generate_slab')).toBe('mutate')
  })

  it('place_adsorbate is a mutate tool', () => {
    expect(tool_kind('place_adsorbate')).toBe('mutate')
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `rtk proxy pnpm exec vitest run src/lib/chat/structure-tools.test.ts -t "mutating tools"`
Expected: FAIL — `make_supercell` unknown / `tool_kind` returns undefined

- [ ] **Step 3: Implement mutating tools**

Add imports at top of `src/lib/chat/structure-tools.ts`:

```typescript
import { create_supercell } from '$lib/structure/ferrox-wasm'
import { generate_slab as ferrox_generate_slab } from '$lib/structure/miller-slab'
```

Add tool registrations (before the final `rebuild_tool_list()`):

```typescript
// ── make_supercell (mutate) ──
register(
  {
    name: `make_supercell`,
    description: `Expand the current structure into a supercell by integer repeats along a, b, c.`,
    kind: `mutate`,
    input_schema: {
      type: `object`,
      properties: {
        nx: { type: `integer`, minimum: 1 },
        ny: { type: `integer`, minimum: 1 },
        nz: { type: `integer`, minimum: 1 },
      },
      required: [`nx`, `ny`, `nz`],
    },
  },
  async (input) => {
    const s = require_structure()
    const res = await create_supercell(s as never, Number(input.nx), Number(input.ny), Number(input.nz))
    if (`error` in res) throw new Error(res.error)
    set_current_structure(res.ok as never)
    return { num_sites: (res.ok as { sites: unknown[] }).sites.length }
  },
)

// ── substitute_element (mutate) ──
register(
  {
    name: `substitute_element`,
    description: `Replace all atoms of one element with another (doping/substitution).`,
    kind: `mutate`,
    input_schema: {
      type: `object`,
      properties: {
        from: { type: `string`, description: `Element symbol to replace, e.g. "Na".` },
        to: { type: `string`, description: `New element symbol, e.g. "K".` },
      },
      required: [`from`, `to`],
    },
  },
  (input) => {
    const s = require_structure() as { sites: { species: { element: string; occu?: number }[]; label?: string }[] }
    const from = String(input.from)
    const to = String(input.to)
    let replaced = 0
    const next = structuredClone(s)
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
    description: `Cut a surface slab from the current bulk crystal along Miller indices (h,k,l).`,
    kind: `mutate`,
    input_schema: {
      type: `object`,
      properties: {
        h: { type: `integer` }, k: { type: `integer` }, l: { type: `integer` },
        thickness: { type: `number`, description: `Slab thickness in Å (default 10).` },
        vacuum: { type: `number`, description: `Vacuum padding in Å (default 15).` },
      },
      required: [`h`, `k`, `l`],
    },
  },
  (input) => {
    const s = require_structure()
    const slab = ferrox_generate_slab(s as never, {
      miller: [Number(input.h), Number(input.k), Number(input.l)],
      thickness: Number(input.thickness ?? 10),
      vacuum: Number(input.vacuum ?? 15),
    } as never)
    set_current_structure(slab as never)
    return { num_sites: (slab as { sites: unknown[] }).sites.length }
  },
)

// ── place_adsorbate (mutate) ──
register(
  {
    name: `place_adsorbate`,
    description: `Place an adsorbate atom/molecule on the current slab surface at a Cartesian position.`,
    kind: `mutate`,
    input_schema: {
      type: `object`,
      properties: {
        element: { type: `string`, description: `Adsorbate element symbol (single-atom), e.g. "H", "O".` },
        position: {
          type: `array`, items: { type: `number` }, minItems: 3, maxItems: 3,
          description: `Cartesian [x,y,z] in Å.`,
        },
      },
      required: [`element`, `position`],
    },
  },
  (input) => {
    const s = require_structure() as { sites: Record<string, unknown>[] }
    const pos = input.position as number[]
    const next = structuredClone(s)
    next.sites.push({
      species: [{ element: String(input.element), occu: 1 }],
      xyz: pos, abc: pos, label: String(input.element),
    })
    set_current_structure(next as never)
    return { num_sites: next.sites.length }
  },
)
```

> Note: `generate_slab`'s `SlabConfig` shape must match `miller-slab.ts:1179`. Before implementing, open that signature and align the option keys (`miller`, `thickness`, `vacuum`). If the real config differs, use the real keys — do not invent.

- [ ] **Step 4: Run test, verify it passes**

Run: `rtk proxy pnpm exec vitest run src/lib/chat/structure-tools.test.ts`
Expected: PASS (supercell num_sites=4, substitute replaced=1 + element swap, slab/adsorbate kinds)

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat/structure-tools.ts src/lib/chat/structure-tools.test.ts
git commit -m "feat(catbot): mutating tools — supercell, slab, adsorbate, substitution"
```

---

## Task 5: Read tools — spacegroup, distance, XRD

**Files:**
- Modify: `src/lib/chat/structure-tools.ts`
- Test: `src/lib/chat/structure-tools.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/lib/chat/structure-tools.test.ts`:

```typescript
describe('more read tools', () => {
  beforeEach(() => set_current_structure(CUBIC_NACL as never))
  it('get_distance returns a positive distance between two sites', async () => {
    expect(tool_kind('get_distance')).toBe('read')
    const out = JSON.parse(await execute_tool('get_distance', { i: 0, j: 1 }))
    expect(out.distance).toBeGreaterThan(0)
  })
  it('get_spacegroup is a read tool', () => {
    expect(tool_kind('get_spacegroup')).toBe('read')
  })
  it('compute_xrd is a read tool', () => {
    expect(tool_kind('compute_xrd')).toBe('read')
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `rtk proxy pnpm exec vitest run src/lib/chat/structure-tools.test.ts -t "more read tools"`
Expected: FAIL — tools unknown

- [ ] **Step 3: Implement read tools**

Add imports at top of `src/lib/chat/structure-tools.ts`:

```typescript
import { get_spacegroup as ferrox_spacegroup, get_distance as ferrox_distance, compute_xrd as ferrox_xrd } from '$lib/structure/ferrox-wasm'
```

> Before writing, confirm these wrappers exist with these signatures in `ferrox-wasm.ts` (`get_spacegroup(structure, symprec)`, `get_distance(structure, i, j)`, `compute_xrd(structure, options?)`). Adjust call sites to the real signatures if they differ.

Add registrations (before final `rebuild_tool_list()`):

```typescript
register(
  { name: `get_spacegroup`, description: `Get the international spacegroup number of the current structure.`, kind: `read`,
    input_schema: { type: `object`, properties: { symprec: { type: `number`, description: `Symmetry tolerance (default 1e-4).` } } } },
  async (input) => {
    const res = await ferrox_spacegroup(require_structure() as never, Number(input.symprec ?? 1e-4))
    if (`error` in res) throw new Error(res.error)
    return { spacegroup_number: res.ok }
  },
)

register(
  { name: `get_distance`, description: `Distance in Å between two atom sites by 0-based index.`, kind: `read`,
    input_schema: { type: `object`, properties: { i: { type: `integer` }, j: { type: `integer` } }, required: [`i`, `j`] } },
  async (input) => {
    const res = await ferrox_distance(require_structure() as never, Number(input.i), Number(input.j))
    if (`error` in res) throw new Error(res.error)
    return { distance: res.ok }
  },
)

register(
  { name: `compute_xrd`, description: `Compute a powder XRD pattern (Cu Kα) for the current structure.`, kind: `read`,
    input_schema: { type: `object`, properties: {} } },
  async () => {
    const res = await ferrox_xrd(require_structure() as never)
    if (`error` in res) throw new Error(res.error)
    return res.ok
  },
)
```

- [ ] **Step 4: Run test, verify it passes**

Run: `rtk proxy pnpm exec vitest run src/lib/chat/structure-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat/structure-tools.ts src/lib/chat/structure-tools.test.ts
git commit -m "feat(catbot): read tools — spacegroup, distance, xrd"
```

---

## Task 6: client-llm.ts — browser-direct function-calling transport

**Files:**
- Create: `src/lib/chat/client-llm.ts`
- Test: `src/lib/chat/client-llm.test.ts`

- [ ] **Step 1: Write failing test for streamed parsing**

Create `src/lib/chat/client-llm.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parse_openai_stream } from './client-llm'

function sse(lines: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const enc = new TextEncoder()
  const body = lines.map((l) => `data: ${l}\n\n`).join('') + 'data: [DONE]\n\n'
  const stream = new ReadableStream({ start(c) { c.enqueue(enc.encode(body)); c.close() } })
  return stream.getReader()
}

describe('parse_openai_stream', () => {
  it('assembles text deltas', async () => {
    const events: unknown[] = []
    for await (const e of parse_openai_stream(sse([
      JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
    ]))) events.push(e)
    const text = events.filter((e: any) => e.type === 'text').map((e: any) => e.text).join('')
    expect(text).toBe('Hello')
  })

  it('assembles tool_calls split across chunks', async () => {
    const events: any[] = []
    for await (const e of parse_openai_stream(sse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'make_supercell', arguments: '{"nx":2,' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ny":1,"nz":1}' } }] } }] }),
      JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] }),
    ]))) events.push(e)
    const tc = events.find((e) => e.type === 'tool_calls')
    expect(tc.calls[0]).toEqual({ id: 'c1', name: 'make_supercell', arguments: { nx: 2, ny: 1, nz: 1 } })
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `rtk proxy pnpm exec vitest run src/lib/chat/client-llm.test.ts`
Expected: FAIL — `Cannot find module './client-llm'`

- [ ] **Step 3: Implement `client-llm.ts`**

Create `src/lib/chat/client-llm.ts`:

```typescript
import type { ChatConfig, ChatMessage, ClientTool, ToolCall } from './types'
import { needs_relay, relay_url } from './provider-routing'

export type LlmEvent =
  | { type: `text`; text: string }
  | { type: `tool_calls`; calls: ToolCall[] }
  | { type: `done` }
  | { type: `error`; message: string }

interface AccTool { id: string; name: string; args: string }

/** Parse an OpenAI-compatible SSE chat stream into typed events. */
export async function* parse_openai_stream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<LlmEvent> {
  const decoder = new TextDecoder()
  let buffer = ``
  const acc = new Map<number, AccTool>()
  let saw_tool_calls = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(`\n`)
    buffer = lines.pop() ?? ``
    for (const line of lines) {
      if (!line.startsWith(`data: `)) continue
      const payload = line.slice(6).trim()
      if (payload === `[DONE]`) break
      let data: any
      try { data = JSON.parse(payload) } catch { continue }
      const choice = data.choices?.[0]
      const delta = choice?.delta
      if (delta?.content) yield { type: `text`, text: delta.content as string }
      if (delta?.tool_calls) {
        saw_tool_calls = true
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          const cur = acc.get(idx) ?? { id: ``, name: ``, args: `` }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name = tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
          acc.set(idx, cur)
        }
      }
    }
  }

  if (saw_tool_calls) {
    const calls: ToolCall[] = [...acc.values()].map((t) => ({
      id: t.id,
      name: t.name,
      arguments: t.args ? JSON.parse(t.args) : {},
    }))
    yield { type: `tool_calls`, calls }
  }
  yield { type: `done` }
}

/** Send one chat turn to an OpenAI-compatible provider, streaming events. */
export async function* stream_client_llm(
  messages: ChatMessage[],
  config: ChatConfig,
  system: string,
  tools: ClientTool[],
  signal?: AbortSignal,
): AsyncGenerator<LlmEvent> {
  const endpoint = `${config.base_url.replace(/\/$/, ``)}/chat/completions`
  const url = needs_relay(endpoint) ? relay_url(endpoint) : endpoint
  const openai_tools = tools.map((t) => ({
    type: `function`,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))
  const body = {
    model: config.model,
    stream: true,
    temperature: config.temperature,
    max_tokens: config.max_tokens,
    tools: openai_tools,
    messages: [{ role: `system`, content: system }, ...messages.map(to_openai_message)],
  }
  let resp: Response
  try {
    resp = await fetch(url, {
      method: `POST`,
      headers: { 'Content-Type': `application/json`, Authorization: `Bearer ${config.api_key}` },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    yield { type: `error`, message: err instanceof Error ? err.message : `Network error` }
    return
  }
  if (!resp.ok || !resp.body) {
    yield { type: `error`, message: `Provider error ${resp.status}: ${await resp.text().catch(() => ``)}` }
    return
  }
  yield* parse_openai_stream(resp.body.getReader())
}

/** Convert in-app ChatMessage (incl. tool results) to OpenAI wire format. */
function to_openai_message(m: ChatMessage): Record<string, unknown> {
  if (typeof m.content === `string`) return { role: m.role, content: m.content }
  // Content blocks: flatten tool_result blocks into role:"tool" messages is handled
  // by tool-loop; here we only stringify text blocks for assistant/user turns.
  const text = m.content.filter((b) => b.type === `text`).map((b) => (b as { text: string }).text).join(``)
  return { role: m.role, content: text }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `rtk proxy pnpm exec vitest run src/lib/chat/client-llm.test.ts`
Expected: PASS (text assembly + split tool_calls)

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat/client-llm.ts src/lib/chat/client-llm.test.ts
git commit -m "feat(catbot): browser-direct OpenAI function-calling transport"
```

---

## Task 7: tool-loop.ts — agentic loop with permission gating

**Files:**
- Create: `src/lib/chat/tool-loop.ts`
- Test: `src/lib/chat/tool-loop.test.ts`

- [ ] **Step 1: Write failing test (mock transport + executor)**

Create `src/lib/chat/tool-loop.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { run_tool_loop } from './tool-loop'
import type { LlmEvent } from './client-llm'

function gen(...batches: LlmEvent[][]): () => AsyncGenerator<LlmEvent> {
  let call = 0
  return async function* () {
    const batch = batches[call++] ?? [{ type: 'done' }]
    for (const e of batch) yield e
  }
}

describe('run_tool_loop', () => {
  it('executes a read tool then finishes on plain text', async () => {
    const transport = gen(
      [{ type: 'tool_calls', calls: [{ id: 't1', name: 'get_structure_info', arguments: {} }] }, { type: 'done' }],
      [{ type: 'text', text: 'Done.' }, { type: 'done' }],
    )
    const events: any[] = []
    await run_tool_loop({
      transport,
      execute: vi.fn().mockResolvedValue('{"num_sites":2}'),
      kind_of: () => 'read',
      request_permission: vi.fn(), // never called for reads
      on_event: (e) => events.push(e),
    })
    const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('')
    expect(text).toBe('Done.')
    expect(events.some((e) => e.type === 'tool_end' && e.name === 'get_structure_info')).toBe(true)
  })

  it('awaits permission for mutate tools and skips on deny', async () => {
    const execute = vi.fn().mockResolvedValue('{"num_sites":4}')
    const transport = gen(
      [{ type: 'tool_calls', calls: [{ id: 't1', name: 'make_supercell', arguments: { nx: 2, ny: 1, nz: 1 } }] }, { type: 'done' }],
      [{ type: 'text', text: 'ok' }, { type: 'done' }],
    )
    await run_tool_loop({
      transport, execute, kind_of: () => 'mutate',
      request_permission: vi.fn().mockResolvedValue(false), // user denies
      on_event: () => {},
    })
    expect(execute).not.toHaveBeenCalled() // denied → not executed
  })

  it('caps runaway loops', async () => {
    const transport = () => (async function* () {
      yield { type: 'tool_calls', calls: [{ id: 'x', name: 'get_structure_info', arguments: {} }] } as LlmEvent
      yield { type: 'done' } as LlmEvent
    })()
    const events: any[] = []
    await run_tool_loop({
      transport, execute: vi.fn().mockResolvedValue('{}'), kind_of: () => 'read',
      request_permission: vi.fn(), on_event: (e) => events.push(e), max_iterations: 3,
    })
    const toolEnds = events.filter((e) => e.type === 'tool_end').length
    expect(toolEnds).toBeLessThanOrEqual(3)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `rtk proxy pnpm exec vitest run src/lib/chat/tool-loop.test.ts`
Expected: FAIL — `Cannot find module './tool-loop'`

- [ ] **Step 3: Implement `tool-loop.ts`**

Create `src/lib/chat/tool-loop.ts`:

```typescript
import type { LlmEvent } from './client-llm'
import type { ToolCall, ToolKind } from './types'

export type LoopEvent =
  | { type: `text`; text: string }
  | { type: `tool_start`; id: string; name: string; input: Record<string, unknown> }
  | { type: `tool_end`; id: string; name: string; result: string; isError: boolean }
  | { type: `permission_request`; id: string; name: string; input: Record<string, unknown> }
  | { type: `error`; message: string }
  | { type: `done` }

export interface ToolLoopDeps {
  /** Each call starts a fresh provider turn with the accumulated message history. */
  transport: () => AsyncGenerator<LlmEvent>
  execute: (name: string, input: Record<string, unknown>) => Promise<string>
  kind_of: (name: string) => ToolKind | undefined
  /** Resolve true to run a mutating tool, false to skip it. */
  request_permission: (call: ToolCall) => Promise<boolean>
  on_event: (e: LoopEvent) => void
  max_iterations?: number
  signal?: AbortSignal
}

/** Run the agentic loop until the model returns no tool calls (or the cap is hit). */
export async function run_tool_loop(deps: ToolLoopDeps): Promise<void> {
  const max = deps.max_iterations ?? 25
  for (let i = 0; i < max; i++) {
    if (deps.signal?.aborted) { deps.on_event({ type: `done` }); return }
    let calls: ToolCall[] = []
    let any_text = false
    for await (const ev of deps.transport()) {
      if (ev.type === `text`) { any_text = true; deps.on_event({ type: `text`, text: ev.text }) }
      else if (ev.type === `tool_calls`) calls = ev.calls
      else if (ev.type === `error`) { deps.on_event({ type: `error`, message: ev.message }); return }
    }
    if (calls.length === 0) { deps.on_event({ type: `done` }); return }

    for (const call of calls) {
      const kind = deps.kind_of(call.name) ?? `mutate` // unknown → treat as mutate (safe)
      if (kind === `mutate`) {
        deps.on_event({ type: `permission_request`, id: call.id, name: call.name, input: call.arguments })
        const allowed = await deps.request_permission(call)
        if (!allowed) {
          deps.on_event({ type: `tool_end`, id: call.id, name: call.name, result: `{"skipped":"denied by user"}`, isError: false })
          continue
        }
      }
      deps.on_event({ type: `tool_start`, id: call.id, name: call.name, input: call.arguments })
      const result = await deps.execute(call.name, call.arguments)
      const isError = result.includes(`"error"`)
      deps.on_event({ type: `tool_end`, id: call.id, name: call.name, result, isError })
    }
    // Caller appends tool results to history (see chat-state wiring) before next transport() call.
  }
  deps.on_event({ type: `done` })
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `rtk proxy pnpm exec vitest run src/lib/chat/tool-loop.test.ts`
Expected: PASS (read executes, deny skips execute, cap respected)

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat/tool-loop.ts src/lib/chat/tool-loop.test.ts
git commit -m "feat(catbot): agentic tool loop with read/mutate gating + cap"
```

---

## Task 8: Wire client-direct branch into chat-state.send()

**Files:**
- Modify: `src/lib/chat/chat-state.svelte.ts` (`:455-590`)
- Test: manual + existing suite (no regression)

- [ ] **Step 1: Add imports**

At the top of `src/lib/chat/chat-state.svelte.ts` (with the other `./` imports near `:1-10`):

```typescript
import { is_client_direct } from './provider-routing'
import { stream_client_llm } from './client-llm'
import { run_tool_loop } from './tool-loop'
import { CLIENT_TOOLS, execute_tool, tool_kind } from './structure-tools'
import { build_sdk_system_prompt } from './llm-client'
```

(`build_sdk_system_prompt` is already exported and imported — reuse the existing import; do not duplicate.)

- [ ] **Step 2: Add the third branch**

In `send()`, the current shape is `if (agent) { …SDK… } else { …universal… }` (`:461`, `:573`). Change the `else` into `else if (is_client_direct(chat_config)) { …new… } else { …universal… }`. Insert this branch before the existing universal `else`:

```typescript
    } else if (is_client_direct(chat_config)) {
      // ── Client-direct path — browser-only tool-calling, no backend ──
      slice.active_tool_blocks.entries = {}
      slice.active_permission_blocks.entries = {}
      const combined_context = [
        slice.structure_context.value,
        slice.workflow_context.value,
        slice.paper_context.value,
      ].filter(Boolean).join(`\n\n`) || undefined
      const system = build_sdk_system_prompt(chat_config.provider, combined_context, false)

      // History the loop grows across turns (tool results re-injected as messages).
      const history: ChatMessage[] = slice.messages.list.slice(0, -1).concat(
        { role: `user`, content: content.trim(), timestamp: Date.now() },
      )
      let full_text = ``

      await run_tool_loop({
        signal: slice.abort_controller.signal,
        transport: () => stream_client_llm(history, chat_config, system, CLIENT_TOOLS, slice.abort_controller?.signal),
        execute: execute_tool,
        kind_of: tool_kind,
        request_permission: (call) =>
          new Promise<boolean>((resolve) => {
            if (slice.skip_permission.value) { resolve(true); return }
            const id = call.id
            slice.active_permission_blocks.entries[id] = {
              toolName: call.name, input: call.arguments, status: `pending`,
              resolve, // PermissionCard calls this on click — see Step 3
            } as never
          }),
        on_event: (e) => {
          if (e.type === `text`) { full_text += e.text; update_last_message(slice, full_text) }
          else if (e.type === `tool_start`) {
            slice.active_tool_blocks.entries[e.id] = { toolName: e.name, input: e.input, output: ``, status: `running`, elapsedSeconds: 0 }
          } else if (e.type === `tool_end`) {
            const te = slice.active_tool_blocks.entries[e.id]
            if (te) { te.output = e.result; te.status = e.isError ? `error` : `complete` }
            // Re-inject the tool result into history for the next provider turn.
            history.push({ role: `assistant`, content: [{ type: `tool_use`, id: e.id, name: e.name, input: {} }], timestamp: Date.now() })
            history.push({ role: `user`, content: [{ type: `tool_result`, tool_use_id: e.id, content: e.result }], timestamp: Date.now() })
          } else if (e.type === `error`) { slice.error.value = e.message }
          else if (e.type === `done`) { finalize_stream_indicators(slice) }
        },
      })
```

> Note: the OpenAI wire format for tool results differs from the Anthropic-style `tool_use`/`tool_result` content blocks used above. `client-llm.ts:to_openai_message` only forwards text today. Extend `to_openai_message` so an assistant `tool_use` block emits `{role:"assistant", tool_calls:[…]}` and a user `tool_result` block emits `{role:"tool", tool_call_id, content}`. Implement this mapping as part of this task (it is the OpenAI counterpart to the Anthropic blocks) and add a unit test in `client-llm.test.ts` asserting both conversions.

- [ ] **Step 3: Let PermissionCard resolve the loop promise**

The SDK permission flow resolves via backend round-trip; the client-direct flow resolves the stored `resolve` callback directly. In the permission-approval handler (where `active_permission_blocks.entries[id].status` is set to `allowed`/`denied` — search `ChatPane.svelte` / the approve handler), after setting status, call the stored resolver if present:

```typescript
const pb = slice.active_permission_blocks.entries[id] as { resolve?: (ok: boolean) => void; status: string }
if (pb?.resolve) pb.resolve(approved) // approved: boolean from the button
```

- [ ] **Step 4: Verify no regression in existing chat tests**

Run: `rtk proxy pnpm exec vitest run src/lib/chat`
Expected: PASS (existing suites green; new suites from Tasks 1-7 green)

- [ ] **Step 5: Type-check**

Run: `rtk proxy pnpm exec svelte-check --threshold error`
Expected: 0 errors (fix any type mismatches in the wiring)

- [ ] **Step 6: Commit**

```bash
git add src/lib/chat/chat-state.svelte.ts src/lib/chat/client-llm.ts src/lib/chat/client-llm.test.ts
git commit -m "feat(catbot): wire client-direct tool-calling branch into send()"
```

---

## Task 9: CORS relay Cloudflare Worker

**Files:**
- Create: `workers/cors-relay/src/index.ts`
- Create: `workers/cors-relay/wrangler.relay.toml`
- Create: `workers/cors-relay/package.json`
- Test: `workers/cors-relay/test/relay.test.ts`

- [ ] **Step 1: Write failing Worker test**

Create `workers/cors-relay/test/relay.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import worker from '../src/index'

const env = { ALLOWED_HOSTS: 'optimade.materialsproject.org' }

describe('cors-relay worker', () => {
  it('answers preflight with ACAO:*', async () => {
    const res = await worker.fetch(new Request('https://relay/?url=x', { method: 'OPTIONS' }), env as never)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('rejects non-allowlisted hosts', async () => {
    const res = await worker.fetch(new Request('https://relay/?url=' + encodeURIComponent('https://evil.example.com/x')), env as never)
    expect(res.status).toBe(403)
  })

  it('forwards allowlisted host and adds ACAO', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"data":[]}', { status: 200 }))
    const target = 'https://optimade.materialsproject.org/v1/structures'
    const res = await worker.fetch(new Request('https://relay/?url=' + encodeURIComponent(target)), env as never)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(spy.mock.calls[0][0]).toBe(target)
    spy.mockRestore()
  })
})
```

- [ ] **Step 2: Create package.json + wrangler config**

Create `workers/cors-relay/package.json`:

```json
{
  "name": "catgo-cors-relay",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "deploy": "wrangler deploy -c wrangler.relay.toml"
  },
  "devDependencies": { "vitest": "^2.0.0", "wrangler": "^3.0.0" }
}
```

Create `workers/cors-relay/wrangler.relay.toml`:

```toml
name = "catgo-cors-relay"
main = "src/index.ts"
compatibility_date = "2026-05-26"

[vars]
ALLOWED_HOSTS = "optimade.materialsproject.org"
```

- [ ] **Step 3: Run test, verify it fails**

Run: `cd workers/cors-relay && rtk proxy pnpm exec vitest run`
Expected: FAIL — `Cannot find module '../src/index'`

- [ ] **Step 4: Implement the Worker**

Create `workers/cors-relay/src/index.ts`:

```typescript
interface Env { ALLOWED_HOSTS: string }

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,X-Api-Key,Content-Type,Accept',
  'Access-Control-Max-Age': '86400',
}
const FORWARD_HEADERS = ['authorization', 'x-api-key', 'content-type', 'accept']

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })

    const target = new URL(request.url).searchParams.get('url')
    if (!target) return json({ error: 'missing ?url=' }, 400)

    let targetUrl: URL
    try { targetUrl = new URL(target) } catch { return json({ error: 'invalid url' }, 400) }

    const allowed = new Set(env.ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean))
    if (!allowed.has(targetUrl.host)) return json({ error: `host not allowed: ${targetUrl.host}` }, 403)

    const headers = new Headers()
    for (const h of FORWARD_HEADERS) {
      const v = request.headers.get(h)
      if (v) headers.set(h, v)
    }

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? await request.text() : undefined,
    })

    const out = new Headers(upstream.headers)
    for (const [k, v] of Object.entries(CORS_HEADERS)) out.set(k, v)
    return new Response(upstream.body, { status: upstream.status, headers: out })
  },
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } })
}
```

- [ ] **Step 5: Run test, verify it passes**

Run: `cd workers/cors-relay && rtk proxy pnpm exec vitest run`
Expected: PASS (preflight ACAO, 403 reject, forward+ACAO)

- [ ] **Step 6: Commit**

```bash
git add workers/cors-relay
git commit -m "feat(relay): host-allowlisted CORS relay Worker for MP OPTIMADE + LLM"
```

---

## Task 10: Route MP through relay in optimade.ts static path + manual integration

**Files:**
- Modify: `src/lib/api/optimade.ts` (`:592-621`)
- Test: `src/lib/api/optimade.test.ts` (create if absent)

- [ ] **Step 1: Write failing test**

Create or append to `src/lib/api/optimade.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { needs_relay } from '$lib/chat/provider-routing'

describe('optimade static MP routing', () => {
  it('MP base url needs relay; alexandria does not', () => {
    expect(needs_relay('https://optimade.materialsproject.org/v1/structures')).toBe(true)
    expect(needs_relay('https://alexandria.icams.rub.de/pbe/v1/structures')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test, verify it passes (helper already implemented in Task 1)**

Run: `rtk proxy pnpm exec vitest run src/lib/api/optimade.test.ts`
Expected: PASS

- [ ] **Step 3: Apply relay routing in the static branch**

In `src/lib/api/optimade.ts`, the static-mode branch (`:592-621`) builds `url` then calls `fetch(url, …)` twice. Import the relay helper and replace the two direct `fetch(url …)` / `fetch(fallback_url …)` calls with `relay_fetch`:

```typescript
import { relay_fetch } from '$lib/chat/provider-routing'
// …
      let response = await relay_fetch(url, { headers: { Accept: `application/vnd.api+json` } })
      if (!response.ok && sort) {
        const fallback_url = url.replace(/&sort=[^&]*/, ``)
        response = await relay_fetch(fallback_url, { headers: { Accept: `application/vnd.api+json` } })
      }
```

Apply the same `relay_fetch` substitution to the single-structure fetch path (`:286-319`, the `fetch_optimade_structure` static branch) so detail fetches also route MP through the relay.

- [ ] **Step 4: Run full chat + api suites**

Run: `rtk proxy pnpm exec vitest run src/lib/chat src/lib/api/optimade.test.ts`
Expected: PASS

- [ ] **Step 5: Manual integration check (documented, not automated)**

Build static mode and verify CatBot tool-calling end-to-end:

```bash
# Build with static-only + relay URL injected
VITE_CORS_RELAY_URL=https://catgo-cors-relay.workers.dev rtk proxy pnpm exec vite build --config vite.desktop.config.ts
```

Then, in a browser against the static build with a DeepSeek key set in CatBot settings:
1. Ask: "fetch NaCl from Materials Project" → expect a `fetch_optimade` tool call routed via relay, results returned (no CORS error in console).
2. Ask: "make a 2x2x1 supercell" → expect a `make_supercell` PermissionCard; approve; viewer updates, site count quadruples.
3. Ask: "what spacegroup is this?" → expect `get_spacegroup` auto-run (no card), number reported.

Record results in the PR description.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api/optimade.ts src/lib/api/optimade.test.ts
git commit -m "feat(optimade): route MP OPTIMADE through CORS relay in static mode"
```

---

## Self-Review Notes

- **Spec coverage:** client-direct branch (Task 8), client-llm transport (Task 6), structure-tools full-surface registry pattern + concrete read/mutate set (Tasks 2-5), tool-loop with PermissionCard reuse + read auto-approve (Task 7), CORS relay Worker + needs_relay routing + MP measured block (Tasks 1, 9, 10), STATIC_ONLY auto-enable (`is_client_direct`, Task 1). Testing strategy per spec covered in each task + Worker suite (Task 9).
- **Extensibility:** Additional ferrox tools (defects, strain, primitive, interpolate, perturb, bond detection, MOF, etc.) are added as a schema+executor+test triple in `structure-tools.ts` following Tasks 4/5 — no new architecture.
- **Known alignment risks flagged inline:** `miller-slab.ts:generate_slab` config keys (Task 4), ferrox-wasm read wrapper signatures (Task 5), OpenAI tool-result message mapping in `to_openai_message` (Task 8). Each says "verify the real signature; do not invent."
- **No regression:** SDK and universal branches untouched; client-direct is a new `else if`.
