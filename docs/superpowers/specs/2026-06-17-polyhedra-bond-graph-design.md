# Coordination polyhedra: port matterviz's bond-graph algorithm

**Date:** 2026-06-17
**Branch:** `feat/polyhedra-bond-graph`
**Status:** implemented on `feat/polyhedra-bond-graph`.

> **CORRECTION (post-implementation):** the "BondPair already has `jimage` applied"
> claim below (Key insight section) was WRONG — `bond.pos_1`/`pos_2` are RAW in-cell
> base positions; the effective neighbour position is `pos + lattice·jimage`. The shift
> is applied explicitly in `build_bond_adjacency` (forward `+jimage`, reverse `−jimage`),
> which now takes the lattice matrix. PBC closure works, but via that explicit shift, not
> "automatically". See `.git/sdd/final-fix-report.md` / commit `d320ac2`.

## Problem

After PR #355 ("port matterviz 0.4.1 coordination-polyhedra features"), coordination
polyhedra stopped rendering in the 3D viewer for most structures.

Root cause: #355's port did **not** adopt matterviz's core idea. CatGo's
`compute_polyhedra_fast` (`src/lib/structure/polyhedra.ts:133`) is built on
`compute_polyhedra_with_pbc` (`polyhedra.ts:242`), which is a **distance search**: for
every center atom it loops over all atoms × 27 periodic images and keeps neighbours
within a fixed `max_bond_length` (3.5 Å) cutoff. It never touches the bond graph. Two
mechanisms in this path make polyhedra come out empty:

1. **Hard CN cap** (`polyhedra.ts:324`): `if (!explicit && neighbors.length > max_neighbors) continue`.
   With a 27-image distance search, the raw neighbour count easily exceeds
   `max_neighbors` (8), so the **whole polyhedron is skipped**.
2. **Per-polyhedron EN veto** (`polyhedra.ts:161`, inside `compute_polyhedra_fast`): a
   polyhedron is kept only if **every** neighbour is strictly more electronegative than
   the center; one non-anion neighbour discards the entire polyhedron.

(`show_polyhedra` also defaults to `false` — a toggle, not a bug.)

By contrast matterviz computes polyhedra from the **perceived bond graph**
(`build_adjacency(bonds)`), classifies each bonded neighbour individually via
`is_anion_vertex` (per-vertex, not per-polyhedron), trims over-long bonds relative to
the shortest bond, and applies spectator / weak-bond hiding as layered late filters.
Its vertices are always displayed bonded atoms — self-consistent with what's drawn.

## Goal & scope

Replace the raw-distance neighbour source with the **bond graph**, fixing the
non-display regression and aligning with matterviz's approach. Focused port:

- **Touch:** the compute chain in `src/lib/structure/polyhedra.ts` and the call site
  `src/lib/structure/StructureScene.svelte:2580`.
- **Reuse unchanged:** convex hull / `merge_polyhedra_geometry`, `apply_framework_filters`
  (spectator + weak-bond, already ported in #355), rendering, color modes, edges, UI
  controls.
- **Out of scope (YAGNI):** literal matterviz port via structure expansion + image-atom
  reindexing; any UI/visual change; color/edge logic.

## Key insight: CatGo's BondPair is richer than matterviz's

`BondPair` (`src/lib/structure/index.ts:135`):

```ts
{ pos_1: Vec3; pos_2: Vec3; site_idx_1: number; site_idx_2: number;
  bond_length: number; strength: number; jimage: [number, number, number]; ... }
```

`pos_1` / `pos_2` are Cartesian positions with the `jimage` (PBC cell-shift) **already
applied** (ferrox WASM is PBC-aware; the JS fallback is not — see Risks). So a
cross-cell bond already carries the correct image position of the far atom.

Consequence: we do **not** need matterviz's `find_image_atoms` + structure expansion +
bond reindexing. Vertex positions come straight from `bond.pos_*`, and PBC closure is
automatic. This is simpler than matterviz's own implementation.

## Design

New bond-based `compute_polyhedra(structure, bonds, options)`:

1. **Adjacency with positions.** Build `Map<center_site_idx, Array<{ neighbor_idx, neighbor_pos }>>`
   from `bonds`. For each bond, the neighbour of `site_idx_1` is `site_idx_2` at
   `pos_2`, and vice-versa at `pos_1`. (matterviz's `build_adjacency` only stores
   indices; we also store the position so PBC images need no lookup.)

2. **Per center site:**
   - Gather bonded neighbours from adjacency.
   - **Per-vertex anion filter:** keep a neighbour as a hull vertex only if
     `is_anion_vertex(center_en, center_is_metal, neighbor_el, margin=0)` (reuse the
     existing helper). One non-anion neighbour no longer discards the polyhedron.
   - **Distance-factor trim:** drop vertices farther than `min_anion_bond × (1 + distance_factor)`
     (`distance_factor = 0.3`, matterviz default) — keeps Jahn-Teller-distorted
     octahedra, rejects over-long bond-graph noise.
   - **CN gate:** keep if `min_coordination ≤ kept_vertices ≤ max_neighbors`; skip
     above the cap (e.g. CN-12 cuboctahedra). With trim + real bonds this no longer
     spuriously fires.
   - **Vertex positions = `bond.pos`** (PBC already correct).

3. **Layered late filters:** reuse `apply_framework_filters` (spectator A-site hiding +
   weak-bond hiding) unchanged.

4. **Geometry:** unchanged — feed `PolyhedronData[]` to the existing quickhull /
   `merge_polyhedra_geometry`.

### Integration

- `StructureScene.svelte:2580` passes the available `filtered_bond_pairs` (`$derived`,
  visibility-filtered bonds) into the new `compute_polyhedra`.
- Existing UI options (`metals_only`, `min_coordination`, `max_neighbors`, center
  allow-list, cutoff) remain; `metals_only` stays an extra center gate.
- `compute_polyhedra_with_pbc` (legacy distance version): remove (YAGNI), unless a
  no-bonds fallback proves necessary (decided during implementation).

## Testing

New vitest (`src/lib/structure/__tests__/`), TDD order — failing test first:

- Reproduce the regression: a periodic structure whose polyhedra currently come out
  empty asserts **non-empty** after the fix.
- TiO₂ (rutile): Ti octahedra, `CN = 6`, closing across the cell boundary.
- BaTiO₃ (perovskite): Ti octahedra visible, Ba (spectator A-site) hidden when the
  framework cation exists — exercises `apply_framework_filters`.
- Assert polyhedron count, per-center CN, and `face_count > 0`.

## Risks

- **JS bond fallback is not PBC-aware** (`jimage` always `[0,0,0]`). On structures that
  hit the JS fallback (no WASM), cross-cell polyhedra won't close — same limitation the
  old code papered over with its own 27-cell loop. Acceptable: ferrox WASM is the
  normal path; document the fallback gap.
- **Bond-graph quality drives polyhedra** — bad bond perception → bad polyhedra. This is
  matterviz's tradeoff too, and desirable (polyhedra match drawn bonds).
- Center sitting on a cell boundary: its own bonds reference it as `site_idx_1` or
  `site_idx_2`; take the *other* endpoint's position for each vertex.

## Open decisions

- `show_polyhedra` default stays **`false`** (manual toggle, avoids clutter). Flip to
  `true` later in one line if desired.
