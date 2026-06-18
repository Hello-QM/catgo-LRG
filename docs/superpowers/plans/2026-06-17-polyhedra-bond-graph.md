# Polyhedra Bond-Graph Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute coordination polyhedra from the perceived bond graph instead of a raw 27-cell distance search, fixing the post-#355 non-display regression and adopting matterviz's per-vertex anion + distance-trim approach.

**Architecture:** New `compute_polyhedra_from_bonds(structure, bonds, options)` in `polyhedra.ts` builds an adjacency map (carrying each neighbour's `bond.pos`, which already has the PBC `jimage` applied), keeps anion vertices per-vertex, trims over-long bonds, gates on CN, then reuses the existing `apply_framework_filters` + geometry. `StructureScene` feeds it `filtered_bond_pairs`. Legacy distance functions are removed.

**Tech Stack:** TypeScript, Svelte 5 runes, vitest.

## Global Constraints

- Code style (hand-written, no formatter in this env): **single quotes, no semicolons, 2-space indent**. Match existing `polyhedra.ts`.
- Svelte 5 runes only (`$state` / `$derived`).
- All new polyhedra logic stays in `src/lib/structure/polyhedra.ts`; tests in `tests/vitest/structure/`.
- `PolyhedronData` shape is fixed (`{ center_idx, center_element, neighbor_indices, vertices }`) — downstream (`merge_polyhedra_geometry`, `get_polyhedra_hidden_atoms`, `get_polyhedra_hidden_bond_keys`) depends on it; do not change it.
- Reuse existing internal helpers in `polyhedra.ts`: `is_anion_vertex(center_en, center_is_metal, neighbor_element, margin)`, `get_site_element(structure, idx)`, `get_electronegativity(el)`, `is_metal(el)`, `apply_framework_filters(structure, candidates)`.

---

### Task 1: `build_bond_adjacency` helper

**Files:**
- Modify: `src/lib/structure/polyhedra.ts` (add exported helper near other exports)
- Test: `tests/vitest/structure/polyhedra-bonds.test.ts` (create)

**Interfaces:**
- Produces: `build_bond_adjacency(bonds: readonly BondPair[]): Map<number, { idx: number; pos: Vec3 }[]>` — site_idx → list of bonded neighbours with the neighbour's Cartesian position taken from the bond endpoint (PBC-correct). Both directions added; self-bonds skipped; duplicate cross-cell bonds intentionally produce multiple entries (each image is a distinct vertex).

- [ ] **Step 1: Write the failing test**

Create `tests/vitest/structure/polyhedra-bonds.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { build_bond_adjacency } from '$lib/structure/polyhedra'
import type { BondPair, Vec3 } from '$lib/structure'

function bond(
  i: number,
  j: number,
  pos_i: Vec3,
  pos_j: Vec3,
  jimage: [number, number, number] = [0, 0, 0],
): BondPair {
  const len = Math.hypot(pos_j[0] - pos_i[0], pos_j[1] - pos_i[1], pos_j[2] - pos_i[2])
  return {
    pos_1: pos_i,
    pos_2: pos_j,
    site_idx_1: i,
    site_idx_2: j,
    bond_length: len,
    strength: 1,
    transform_matrix: new Float32Array(16),
    jimage,
  } as BondPair
}

describe(`build_bond_adjacency`, () => {
  it(`links both directions with neighbour positions from bond endpoints`, () => {
    const bonds = [
      bond(0, 1, [0, 0, 0], [2, 0, 0]),
      bond(0, 2, [0, 0, 0], [0, 2, 0]),
    ]
    const adj = build_bond_adjacency(bonds)
    expect(adj.get(0)?.map((n) => n.idx).sort()).toEqual([1, 2])
    expect(adj.get(1)?.[0]).toEqual({ idx: 0, pos: [0, 0, 0] })
    expect(adj.get(0)?.find((n) => n.idx === 1)?.pos).toEqual([2, 0, 0])
  })

  it(`skips self-bonds`, () => {
    const adj = build_bond_adjacency([bond(0, 0, [0, 0, 0], [0, 0, 0])])
    expect(adj.get(0)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/structure/polyhedra-bonds.test.ts`
Expected: FAIL — `build_bond_adjacency` is not exported / not a function.

- [ ] **Step 3: Add the implementation**

In `src/lib/structure/polyhedra.ts`, add (after the interfaces, before `compute_polyhedra_fast`):

```ts
// Site index -> bonded neighbours, each carrying the neighbour's Cartesian
// position taken from the bond endpoint. CatGo bonds already apply the PBC
// `jimage` to pos_1/pos_2, so cross-cell neighbours come back at their image
// position and polyhedra close across boundaries with no structure expansion.
export function build_bond_adjacency(
  bonds: readonly BondPair[],
): Map<number, { idx: number; pos: Vec3 }[]> {
  const adj = new Map<number, { idx: number; pos: Vec3 }[]>()
  const link = (from: number, to: number, pos: Vec3) => {
    const list = adj.get(from)
    if (list) list.push({ idx: to, pos })
    else adj.set(from, [{ idx: to, pos }])
  }
  for (const b of bonds) {
    if (b.site_idx_1 === b.site_idx_2) continue
    link(b.site_idx_1, b.site_idx_2, b.pos_2)
    link(b.site_idx_2, b.site_idx_1, b.pos_1)
  }
  return adj
}
```

Ensure `BondPair` and `Vec3` are imported at the top of `polyhedra.ts` (check existing imports from `$lib/structure` / `./index`; add `BondPair` if missing).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vitest/structure/polyhedra-bonds.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/polyhedra.ts tests/vitest/structure/polyhedra-bonds.test.ts
git commit -m "feat(polyhedra): add build_bond_adjacency (bond graph -> neighbours+pos)"
```

---

### Task 2: `compute_polyhedra_from_bonds` — core (per-vertex anion + CN gate)

**Files:**
- Modify: `src/lib/structure/polyhedra.ts`
- Test: `tests/vitest/structure/polyhedra-bonds.test.ts`

**Interfaces:**
- Consumes: `build_bond_adjacency` (Task 1); existing `is_anion_vertex`, `get_site_element`, `get_electronegativity`, `is_metal`.
- Produces: `compute_polyhedra_from_bonds(structure: AnyStructure, bonds: readonly BondPair[], options?: PolyhedraBondOptions): PolyhedronData[]` and `interface PolyhedraBondOptions { center_elements?: string[]; min_coordination?: number; max_neighbors?: number; metals_only?: boolean; distance_factor?: number }`. This task ships everything EXCEPT the distance trim (added in Task 3) and framework-filter wiring (Task 4): centers gated by metals_only/explicit, vertices kept per-vertex via `is_anion_vertex`, CN gated by `min_coordination`/`max_neighbors`, vertex positions from `bond.pos`.

- [ ] **Step 1: Write the failing test**

Append to `tests/vitest/structure/polyhedra-bonds.test.ts`:

```ts
import { compute_polyhedra_from_bonds } from '$lib/structure/polyhedra'
import type { AnyStructure, Site } from '$lib/structure'

function site(element: string, xyz: Vec3): Site {
  return {
    species: [{ element, occu: 1, oxidation_state: 0 }],
    xyz,
    abc: xyz,
    label: element,
    properties: {},
  } as unknown as Site
}

function struct(sites: Site[]): AnyStructure {
  return { sites } as unknown as AnyStructure
}

// Ti at origin (idx 0) octahedrally coordinated by 6 O at ±2 Å (idx 1..6)
const OCTA_OFFSETS: Vec3[] = [
  [2, 0, 0], [-2, 0, 0], [0, 2, 0], [0, -2, 0], [0, 0, 2], [0, 0, -2],
]
function octahedron_sites(): Site[] {
  return [site(`Ti`, [0, 0, 0]), ...OCTA_OFFSETS.map((o) => site(`O`, o))]
}
function octahedron_bonds(): BondPair[] {
  return OCTA_OFFSETS.map((o, k) => bond(0, k + 1, [0, 0, 0], o))
}

describe(`compute_polyhedra_from_bonds — core`, () => {
  it(`forms one CN-6 octahedron around a metal center`, () => {
    const polys = compute_polyhedra_from_bonds(
      struct(octahedron_sites()),
      octahedron_bonds(),
    )
    expect(polys).toHaveLength(1)
    expect(polys[0].center_element).toBe(`Ti`)
    expect(polys[0].center_idx).toBe(0)
    expect(polys[0].neighbor_indices).toHaveLength(6)
  })

  it(`keeps the polyhedron when one neighbour is non-anion (per-vertex, not per-poly veto)`, () => {
    // add a 7th neighbour Na (idx 7) bonded to Ti — non-anion, dropped per-vertex
    const sites = [...octahedron_sites(), site(`Na`, [3, 0, 0])]
    const bonds = [...octahedron_bonds(), bond(0, 7, [0, 0, 0], [3, 0, 0])]
    const polys = compute_polyhedra_from_bonds(struct(sites), bonds)
    expect(polys).toHaveLength(1)
    expect(polys[0].neighbor_indices).toHaveLength(6) // Na excluded, 6 O kept
  })

  it(`drops centers below min_coordination`, () => {
    const sites = [site(`Ti`, [0, 0, 0]), site(`O`, [2, 0, 0]), site(`O`, [0, 2, 0])]
    const bonds = [bond(0, 1, [0, 0, 0], [2, 0, 0]), bond(0, 2, [0, 0, 0], [0, 2, 0])]
    expect(compute_polyhedra_from_bonds(struct(sites), bonds)).toHaveLength(0) // CN 2 < 4
  })

  it(`closes across PBC using image positions carried on the bond`, () => {
    // Ti at a corner; 6 O reached only via image bonds (pos_2 already image-shifted)
    const polys = compute_polyhedra_from_bonds(
      struct(octahedron_sites()),
      OCTA_OFFSETS.map((o, k) => bond(0, k + 1, [0, 0, 0], o, [1, 0, 0])),
    )
    expect(polys[0].neighbor_indices).toHaveLength(6)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/structure/polyhedra-bonds.test.ts`
Expected: FAIL — `compute_polyhedra_from_bonds` not exported.

- [ ] **Step 3: Add the implementation**

In `polyhedra.ts`, add after `build_bond_adjacency`:

```ts
export interface PolyhedraBondOptions {
  center_elements?: string[] // force-include allow-list; bypasses anion + CN cap
  min_coordination?: number // default 4
  max_neighbors?: number // skip CN above this (e.g. CN-12); default 8
  metals_only?: boolean // default true: only metal centers in auto mode
  distance_factor?: number // trim vertices beyond min_bond*(1+factor); default 0.3
}

// Bond-graph coordination polyhedra. Vertices are bonded anion neighbours taken
// straight from the rendered bond graph (positions already PBC-correct via
// bond.pos), classified per-vertex by is_anion_vertex.
export function compute_polyhedra_from_bonds(
  structure: AnyStructure,
  bonds: readonly BondPair[],
  options: PolyhedraBondOptions = {},
): PolyhedronData[] {
  const {
    center_elements = [],
    min_coordination = 4,
    max_neighbors = 8,
    metals_only = true,
  } = options
  if (!structure?.sites?.length || bonds.length === 0) return []

  const explicit = center_elements.length > 0
  const allow = new Set(center_elements)
  const adjacency = build_bond_adjacency(bonds)
  const candidates: PolyhedronData[] = []

  for (const [center_idx, neighbors] of adjacency) {
    const c_element = get_site_element(structure, center_idx)
    if (!c_element) continue
    if (explicit) {
      if (!allow.has(c_element)) continue
    } else if (metals_only && !is_metal(c_element)) {
      continue
    }
    const c_pos = structure.sites[center_idx]?.xyz
    if (!c_pos) continue

    const c_en = get_electronegativity(c_element)
    const c_is_metal = is_metal(c_element)

    const kept_idx: number[] = []
    const kept_pos: number[][] = []
    for (const n of neighbors) {
      const n_el = get_site_element(structure, n.idx)
      if (!explicit && !is_anion_vertex(c_en, c_is_metal, n_el, 0)) continue
      kept_idx.push(n.idx)
      kept_pos.push([n.pos[0], n.pos[1], n.pos[2]])
    }
    if (kept_idx.length < min_coordination) continue
    if (!explicit && kept_idx.length > max_neighbors) continue

    candidates.push({
      center_idx,
      center_element: c_element,
      neighbor_indices: kept_idx,
      vertices: kept_pos,
    })
  }

  return candidates
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vitest/structure/polyhedra-bonds.test.ts`
Expected: PASS (core describe block green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/polyhedra.ts tests/vitest/structure/polyhedra-bonds.test.ts
git commit -m "feat(polyhedra): compute_polyhedra_from_bonds core (per-vertex anion + CN gate)"
```

---

### Task 3: Distance-factor trim

**Files:**
- Modify: `src/lib/structure/polyhedra.ts` (inside `compute_polyhedra_from_bonds`)
- Test: `tests/vitest/structure/polyhedra-bonds.test.ts`

**Interfaces:**
- Consumes/extends `compute_polyhedra_from_bonds` (Task 2). Adds: after the anion filter, drop vertices farther than `min_kept_bond × (1 + distance_factor)`; re-check CN min after trim.

- [ ] **Step 1: Write the failing test**

Append:

```ts
describe(`compute_polyhedra_from_bonds — distance trim`, () => {
  it(`trims an over-long 7th bond relative to the shortest`, () => {
    // 6 O at 2 Å + 1 O at 3.5 Å (idx 7); factor 0.3 -> cutoff 2.6, so the long one drops
    const sites = [...octahedron_sites(), site(`O`, [3.5, 0, 0])]
    const bonds = [...octahedron_bonds(), bond(0, 7, [0, 0, 0], [3.5, 0, 0])]
    const polys = compute_polyhedra_from_bonds(struct(sites), bonds)
    expect(polys[0].neighbor_indices).toHaveLength(6)
    expect(polys[0].neighbor_indices).not.toContain(7)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/structure/polyhedra-bonds.test.ts -t "distance trim"`
Expected: FAIL — CN is 7 (no trim yet).

- [ ] **Step 3: Implement the trim**

In `compute_polyhedra_from_bonds`, replace the per-center vertex loop + CN gate (from `const kept_idx` through the `if (!explicit && kept_idx.length > max_neighbors) continue`) with:

```ts
    const { distance_factor = 0.3 } = options
    // collect anion vertices with distances
    const vtx: { idx: number; pos: Vec3; dist: number }[] = []
    let min_dist = Infinity
    for (const n of neighbors) {
      const n_el = get_site_element(structure, n.idx)
      if (!explicit && !is_anion_vertex(c_en, c_is_metal, n_el, 0)) continue
      const dist = Math.hypot(
        n.pos[0] - c_pos[0], n.pos[1] - c_pos[1], n.pos[2] - c_pos[2],
      )
      vtx.push({ idx: n.idx, pos: n.pos, dist })
      if (dist < min_dist) min_dist = dist
    }
    if (vtx.length < min_coordination) continue

    // VESTA-like local cutoff: drop bonds far longer than the shortest kept bond
    const cutoff = min_dist * (1 + distance_factor)
    const kept = vtx.filter((v) => v.dist <= cutoff)
    if (kept.length < min_coordination) continue
    if (!explicit && kept.length > max_neighbors) continue

    candidates.push({
      center_idx,
      center_element: c_element,
      neighbor_indices: kept.map((v) => v.idx),
      vertices: kept.map((v) => [v.pos[0], v.pos[1], v.pos[2]]),
    })
```

(Move the `distance_factor` default up into the top-level destructure if preferred; keep one source.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vitest/structure/polyhedra-bonds.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/polyhedra.ts tests/vitest/structure/polyhedra-bonds.test.ts
git commit -m "feat(polyhedra): distance-factor trim of over-long bonds"
```

---

### Task 4: Framework filters + metals_only/explicit wiring

**Files:**
- Modify: `src/lib/structure/polyhedra.ts`
- Test: `tests/vitest/structure/polyhedra-bonds.test.ts`

**Interfaces:**
- Consumes: existing `apply_framework_filters(structure, candidates)`.
- Produces: `compute_polyhedra_from_bonds` returns `apply_framework_filters`-filtered results in auto mode; explicit mode returns raw candidates (force-include bypass).

- [ ] **Step 1: Write the failing test**

Append (BaTiO₃-style: Ba is a spectator A-site cation, hidden when Ti framework exists):

```ts
describe(`compute_polyhedra_from_bonds — framework filters`, () => {
  it(`hides spectator Ba but keeps Ti octahedra`, () => {
    // Ti(0) octahedron of 6 O (1..6); Ba(7) also "coordinated" by the same 6 O
    const sites = [...octahedron_sites(), site(`Ba`, [4, 0, 0])]
    const ba_bonds = OCTA_OFFSETS.map((o, k) => bond(7, k + 1, [4, 0, 0], o))
    const bonds = [...octahedron_bonds(), ...ba_bonds]
    const polys = compute_polyhedra_from_bonds(struct(sites), bonds)
    const elems = polys.map((p) => p.center_element)
    expect(elems).toContain(`Ti`)
    expect(elems).not.toContain(`Ba`)
  })

  it(`explicit center_elements bypasses anion + framework filters`, () => {
    // force O as a center: normally excluded (non-metal), explicit keeps it
    const polys = compute_polyhedra_from_bonds(
      struct(octahedron_sites()),
      octahedron_bonds(),
      { center_elements: [`Ti`], min_coordination: 6 },
    )
    expect(polys).toHaveLength(1)
    expect(polys[0].center_element).toBe(`Ti`)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/structure/polyhedra-bonds.test.ts -t "framework filters"`
Expected: FAIL — Ba still present (no framework filter applied yet).

- [ ] **Step 3: Wire the framework filter**

In `compute_polyhedra_from_bonds`, change the final `return candidates` to:

```ts
  if (explicit) return candidates
  return apply_framework_filters(structure, candidates)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vitest/structure/polyhedra-bonds.test.ts`
Expected: PASS (all blocks).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/polyhedra.ts tests/vitest/structure/polyhedra-bonds.test.ts
git commit -m "feat(polyhedra): apply framework filters + explicit bypass"
```

---

### Task 5: Wire StructureScene to the bond-graph compute

**Files:**
- Modify: `src/lib/structure/StructureScene.svelte:2577-2588`

**Interfaces:**
- Consumes: `compute_polyhedra_from_bonds` (Tasks 2-4), the existing `filtered_bond_pairs` ($derived, `BondPair[]`), and the existing `polyhedra_*` props.

- [ ] **Step 1: Replace the derived call**

In `StructureScene.svelte`, replace the `polyhedra_data` block (currently lines ~2577-2588) with:

```ts
let polyhedra_data = $derived.by(() => {
  if (!show_polyhedra || !structure?.sites) return []
  try {
    return compute_polyhedra_from_bonds(structure, filtered_bond_pairs, {
      center_elements: polyhedra_center_elements ?? [],
      min_coordination: polyhedra_min_coordination ?? 4,
      max_neighbors: polyhedra_max_neighbors ?? 8,
      metals_only: polyhedra_metals_only ?? true,
    })
  } catch (err) {
    console.warn(`[CatGo] Polyhedra computation failed:`, err)
    return []
  }
})
```

- [ ] **Step 2: Update the import**

In `StructureScene.svelte`, change the import (line ~77) from `compute_polyhedra_fast` to `compute_polyhedra_from_bonds`. Leave `merge_polyhedra_geometry`, `get_polyhedra_hidden_atoms`, `get_polyhedra_hidden_bond_keys` imports intact.

- [ ] **Step 3: Type-check**

Run: `pnpm check`
Expected: 0 errors (warnings about unused CSS are pre-existing and fine). If it reports `compute_polyhedra_fast` unused elsewhere, that's resolved in Task 6.

- [ ] **Step 4: Manual smoke (dev stack already runs on :3100)**

Open the app, load a periodic oxide (e.g. a TiO₂ / perovskite sample), enable **Show Polyhedra**. Expected: octahedra render and close across the cell. (No automated step — this is a visual confirmation.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/StructureScene.svelte
git commit -m "feat(polyhedra): drive viewer from bond graph (filtered_bond_pairs)"
```

---

### Task 6: Remove legacy distance-search functions

**Files:**
- Modify: `src/lib/structure/polyhedra.ts` (delete `compute_polyhedra_fast`, `compute_polyhedra_with_pbc`, and any now-unused helper exclusively used by them)

**Interfaces:**
- Removes: `compute_polyhedra_fast`, `compute_polyhedra_with_pbc`. Confirm no other consumers first.

- [ ] **Step 1: Confirm no remaining callers**

Run: `rg -n "compute_polyhedra_fast|compute_polyhedra_with_pbc" src tests`
Expected: only the definitions in `polyhedra.ts` and possibly old tests. If a test references them, delete that test (the new `polyhedra-bonds.test.ts` supersedes it). If any non-test source still calls them, STOP and report.

- [ ] **Step 2: Delete the functions**

Remove `compute_polyhedra_fast` (lines ~133-175) and `compute_polyhedra_with_pbc` (lines ~242-335) from `polyhedra.ts`. Keep `apply_framework_filters`, `is_anion_vertex`, and all helpers (still used by the new path). If `WEAK_BOND_NORM` / framework helpers were only used by `apply_framework_filters`, keep them.

- [ ] **Step 3: Run the full unit suite + type-check**

Run: `pnpm check && npx vitest run tests/vitest/structure/`
Expected: type-check 0 errors; all structure tests pass (including `polyhedra-bonds.test.ts`).

- [ ] **Step 4: Verify nothing else broke**

Run: `npx vitest run`
Expected: PASS (no new failures vs. baseline).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/polyhedra.ts tests
git commit -m "refactor(polyhedra): remove legacy distance-search compute path"
```

---

## Self-Review

**Spec coverage:**
- Bond-graph adjacency → Task 1. ✓
- Per-vertex anion (replaces per-poly veto) → Task 2. ✓
- Vertex pos from `bond.pos`, PBC closure no expansion → Task 2 (PBC test). ✓
- distance_factor trim → Task 3. ✓
- CN min/max gate → Task 2. ✓
- Reuse `apply_framework_filters` + explicit bypass → Task 4. ✓
- StructureScene feeds `filtered_bond_pairs` → Task 5. ✓
- Remove legacy distance path → Task 6. ✓
- Tests: TiO₂ octahedron, PBC closure, BaTiO₃ spectator hide, CN/trim → Tasks 2-4. ✓
- `show_polyhedra` default stays false → unchanged (no task needed). ✓

**Placeholder scan:** none — every code step has real code.

**Type consistency:** `PolyhedraBondOptions` fields, `compute_polyhedra_from_bonds` signature, and `build_bond_adjacency` return type are consistent across Tasks 1-5. `PolyhedronData` output shape unchanged so `merge_polyhedra_geometry` / hidden-atom / hidden-bond consumers stay compatible.

**Risk note (from spec):** JS bond fallback isn't PBC-aware — cross-cell polyhedra won't close on the JS path. Acceptable; ferrox WASM is the normal path.
