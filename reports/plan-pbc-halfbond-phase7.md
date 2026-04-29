# Plan: Phase 7 — Crystaltoolkit-style Image Atom Decoration

**Audience:** another Claude session executing this plan end-to-end.
**Predecessor:** `reports/plan-pbc-halfbond-refactor.md` (Phases 1–6, all landed on `split-files`).
**Goal:** make CatGo's PBC visualization match crystaltoolkit / Materials Project — image atoms (the "ghosts" displayed when `show_image_atoms=true`) appear with their **full bond environment**, not as isolated decorative spheres.

---

## 0. Why this is needed

Phases 1–6 fixed the chemistry-correct half-bond model:
- WASM detects cross-cell bonds with `image: [i32; 3]` and emits them through to `BondManager.jimages_buffer`.
- Renderer paints two stubs per cross-cell bond, one anchored at each atom's cell-internal position (commit `65ab1a79`).
- Cell-list neighbor search no longer drops PBC wraps when `n_bins=1` (commit `59c9c5f4`) — short-axis cells like LGPS now emit jimage=[±1,0,0] correctly.

**Remaining visual gap:** when the user toggles `show_image_atoms=true`, `find_pbc_images_fast` puts decorative ghost atoms at cell faces/edges/corners, but those ghosts have **zero bonds attached**. Cell-internal atoms get their stubs (Phase 4-6), but the ghost atoms across the cell boundary appear orphaned, breaking the "complete neighborhood" illusion that VESTA / crystaltoolkit / MP achieve.

Crystaltoolkit's solution (`crystal_toolkit/renderables/structuregraph.py:_get_sites_to_draw + get_structure_graph_scene`):
1. Enumerate image atoms by combinatorial reflection of cell-edge atoms (frac coord ≈ 0 or ≈ 1).
2. Optionally extend the list by following cross-cell bonds (so every bond endpoint is a drawn site).
3. For each `(idx, jimage_img)` in `sites_to_draw`, render its **full bond list** at the image-shifted position. Bonds whose partner is not in `sites_to_draw` become incomplete-edge stubs (Phase 6 mode).

We're going to mirror that.

---

## 1. Investigation findings (anchors for executor)

### 1.1 Crystaltoolkit reference logic
Source: <https://raw.githubusercontent.com/materialsproject/crystaltoolkit/main/crystal_toolkit/renderables/structuregraph.py>

```python
def _get_sites_to_draw(self, draw_image_atoms=True, bonded_sites_outside_unit_cell=False):
    sites_to_draw = [(idx, (0, 0, 0)) for idx in range(len(self.structure))]
    if draw_image_atoms:
        for idx, site in enumerate(self.structure):
            zero_elements = [i for i, f in enumerate(site.frac_coords) if np.allclose(f, 0, atol=0.05)]
            # Reflect at frac=0 boundary into +1 image
            for perm in itertools.chain.from_iterable(combinations(zero_elements, r) for r in range(1, 4)):
                sites_to_draw.append((idx, (int(0 in perm), int(1 in perm), int(2 in perm))))
            # Reflect at frac=1 boundary into -1 image
            one_elements = [i for i, f in enumerate(site.frac_coords) if np.allclose(f, 1, atol=0.05)]
            for perm in itertools.chain.from_iterable(combinations(one_elements, r) for r in range(1, 4)):
                sites_to_draw.append((idx, (-int(0 in perm), -int(1 in perm), -int(2 in perm))))
    if bonded_sites_outside_unit_cell:
        for n, jimage in list(sites_to_draw):
            for cs in self.get_connected_sites(n, jimage=jimage):
                if cs.jimage != (0, 0, 0):
                    sites_to_draw.append((cs.index, cs.jimage))
    return set(sites_to_draw)
```

Then per-site rendering:
```python
for idx, jimage in sites_to_draw:
    site = self.structure[idx]
    if jimage != (0, 0, 0):
        site = PeriodicSite(site.species, np.add(site.frac_coords, jimage), site.lattice, properties=site.properties)
    connected_sites = [cs for cs in self.get_connected_sites(idx, jimage=jimage) if (cs.index, cs.jimage) in sites_to_draw]
    connected_sites_not_drawn = [cs for cs in self.get_connected_sites(idx, jimage=jimage) if (cs.index, cs.jimage) not in sites_to_draw]
    site_scene = site.get_scene(
        connected_sites=connected_sites,
        connected_sites_not_drawn=connected_sites_not_drawn,
        hide_incomplete_edges=hide_incomplete_edges,
        ...
    )
```

For each drawn site at `(idx, jimage_img)`:
- **Full bonds** for partners also in `sites_to_draw` (rendered at offset `lattice·jimage_img`).
- **Incomplete-edge stubs** for partners outside `sites_to_draw` — matches our Phase 6 mode.

### 1.2 Current CatGo state (post-Phase 6)

| Component | Behaviour |
|---|---|
| `pbc.ts:find_pbc_images_fast` | Calls Rust `wasm_find_pbc_images` (a custom heuristic, not crystaltoolkit-style). Returns ghost sites appended to displayed_structure with `num_original_sites` + `image_to_original_map`. |
| `extensions/rust/src/pbc.rs:find_pbc_images` | Rust impl. **TODO: read this file** to understand current behaviour and decide whether to extend it or replace from TS. |
| `bond-computation-controller.svelte.ts` | Phase 5 routes WASM bond detection through `bond_input_structure = supercell_structure` (no ghosts). BondManager stores `(site_idx_1, site_idx_2, jimage)` referenced to the pre-ghost structure. |
| `bond-instanced-renderer.ts:#write_slot` | Phase 4 paints 2 instances per BondManager slot. Cross-cell branch (Phase 6 patch in `65ab1a79`) emits paired stubs at `pos_a` and `pos_b` (cell-internal anchors). |
| `BondManagerInstances.svelte` | Owns the `<T.InstancedMesh>` with `max_capacity=1_000_000` instances. Phase 4 colors path was race-fixed in commit `2a8032f8`. |
| `StructureScene.svelte:filtered_bond_pairs` | Filters BondManager bonds by hidden_sites/elements/distance_rules; bond_hitbox emits 2 hitbox cylinders per bond (Phase 6 patch). |

### 1.3 What stays untouched

Plan v1 §1.7 still applies — **do not touch**:
- `charge-label-rendering.svelte.ts:24-36` — needs `num_original_sites + image_to_original_map`.
- `controllers/context-menu-actions.ts:124-143` — ghost→original index resolution for right-click.
- `atom-properties.ts:get_coordination_colors` — uses its own `expand_structure_for_pbc` for CN counting.
- `bond-computation-controller` — the bond input is still the pre-ghost structure (Phase 5 contract).

### 1.4 Mesh capacity arithmetic

After Phase 4: `mesh.count = 2 * BondManager.count`. Phase 7 adds image-atom decoration:
- `n_image_copies` per drawn image atom (typically 1–7 for cell-edge / face / corner atoms).
- For each `(idx, jimage_img)`, render every bond touching `idx` at offset `lattice·jimage_img`.
- Worst case: every cell-internal bond gets duplicated for every image_atom that touches one of its endpoints.

**Worst case estimate** for a typical 200-atom supercell:
- BondManager bonds: ~500–1000
- Image atoms per atom: avg ~2 (cell faces); corner atoms 7
- Total instances: `2 × bonds × (1 + avg_image_atoms_per_bond_endpoint)` ≈ `2 × 1000 × (1 + 4)` ≈ 10k
- Well under 1M capacity ceiling. Performance not a concern.

For pathological cases (1M atom MOF), need dynamic capacity. Plan §4.4 from v1 already covers this.

---

## 2. Target data model

### 2.1 New `sites_to_draw` derivation

Add `src/lib/structure/pbc-image-atoms.ts`:

```ts
/** Each entry: (original site index, lattice translation jimage_img). */
export type ImageSiteKey = `${number}-${number},${number},${number}`

export interface ImageSiteEntry {
  /** Original site index in pre-ghost structure (BondManager site space). */
  site_idx: number
  /** Lattice translation: this image atom sits at pos_orig + lattice·jimage_img. */
  jimage_img: [number, number, number]
}

export interface SitesToDrawConfig {
  draw_image_atoms: boolean
  bonded_sites_outside_unit_cell: boolean
  edge_tolerance: number  // frac coord proximity to 0/1 (default 0.05)
}

/**
 * Build the crystaltoolkit-style sites_to_draw set.
 * Returns a Map keyed by `${site_idx}-${jx},${jy},${jz}` → entry, so
 * `(idx, jimage_img) ∈ sites_to_draw` is O(1) lookup.
 */
export function build_sites_to_draw(
  structure: AnyStructure,
  bond_connectivity: Array<{ site_idx_1: number; site_idx_2: number; jimage: [number, number, number] }>,
  config: SitesToDrawConfig,
): Map<ImageSiteKey, ImageSiteEntry>
```

Implementation:
1. Seed with `(idx, [0,0,0])` for every original site.
2. If `draw_image_atoms`: for each cell-edge atom, enumerate non-empty subsets of axes where frac ≈ 0 (push into +1 image) or frac ≈ 1 (push into -1 image). 7 images per corner atom max.
3. If `bonded_sites_outside_unit_cell`: for each existing entry, walk `bond_connectivity` for bonds touching `entry.site_idx`. For each cross-cell bond `(a, b, jimage_bond)`:
   - Partner image_jimage = `entry.jimage_img + jimage_bond` (when entry's atom == a), or `entry.jimage_img - jimage_bond` (when entry's atom == b).
   - Add `(partner_idx, partner_image_jimage)` to set.

Idempotent — caller may invoke per-frame; cache by `(structure ref, bond_connectivity ref, config)` triple.

### 2.2 Renderer extension

Add a second InstancedMesh path: **image-bond decorator**. Two architectural choices:

#### Option A — single shared mesh, expanded capacity
Pros: one draw call, one shader path, simpler invalidation.
Cons: mesh capacity must scale with image atoms; coloring/picking decode needs a richer index.

#### Option B — separate "image bond" mesh
Pros: keeps `BondInstancedRenderer` as-is; image bonds are an additive layer.
Cons: two draw calls, two color buffers; pick-decode needs to dispatch on which mesh hit.

**Pick Option A.** Single mesh, single shader. The decode change is small (instance_id → (slot, half, image_atom_index)).

#### Option A details

`BondInstancedRenderer` gets a new constructor argument:

```ts
get_image_atom_offsets: (() => Float64Array | null) | null
```

The accessor returns a flat `Float64Array` of length `3 * n_image_atoms` carrying `[dx, dy, dz]` per image atom in `sites_to_draw`. The renderer also needs a parallel `Uint32Array` of length `2 * n_image_atoms` mapping each image atom to `(orig_site_idx, owns_first_n_bonds_count)` — but simpler: just pass:

```ts
interface ImageAtomLayout {
  /** Lattice offsets for each image atom: [dx0, dy0, dz0, dx1, dy1, dz1, ...]. */
  jimage_offsets: Int8Array  // length = 3 * n_image_atoms
  /** Original site index for each image atom. */
  orig_site_indices: Uint32Array  // length = n_image_atoms
  /** Per image atom, list of BondManager slot indices touching its orig_idx. */
  bonds_per_image_atom: Uint32Array  // CSR offsets
  bonds_csr: Uint32Array            // CSR values: BondManager slot indices
}
```

Build this layout from `sites_to_draw` × BondManager:
- For each image atom `(orig_idx, jimage_img)`:
  - Find BondManager slots where `pairs[2*slot]==orig_idx` or `pairs[2*slot+1]==orig_idx`.
  - Append slot indices to CSR.

Layout build cost: O(n_image_atoms × bonds_per_atom_avg). For 200 image atoms × 5 bonds/atom = 1000 ops. Sub-millisecond.

Layout is rebuilt only when:
- `sites_to_draw` topology changes (atoms hidden, ghost toggle).
- BondManager.version changes (bonds added/removed/reindexed).

Cache invalidation via a single `layout_version: number` counter that bumps on either trigger.

Renderer instance count:
```
mesh.count = (BondManager.count × 2) + (Σ bonds_per_image_atom × 2)
```

The first term is the Phase 4 cell-internal half-bonds. The second term is decorator instances.

#### Renderer iteration

```ts
sync(): void {
  // Phase 4: cell-internal slots
  for (let slot = 0; slot < bond_count; slot++) {
    write_slot(slot, /* offset_a */ [0,0,0], /* offset_b */ [0,0,0], /* base_instance */ slot * 2)
  }
  // Phase 7: image-atom decorator
  let instance_idx = bond_count * 2
  for (let img = 0; img < n_image_atoms; img++) {
    const orig_idx = orig_site_indices[img]
    const dx = jimage_offsets[img * 3], dy = ..., dz = ...
    const csr_lo = bonds_per_image_atom[img], csr_hi = bonds_per_image_atom[img + 1]
    for (let i = csr_lo; i < csr_hi; i++) {
      const slot = bonds_csr[i]
      // Rebuild bond at image position. Determine if A or B is the anchored atom.
      // Decide if partner is also in sites_to_draw → full half-bond.
      // Else → incomplete-edge stub (Phase 6 style).
      write_image_slot(slot, orig_idx, [dx,dy,dz], instance_idx)
      instance_idx += 2
    }
  }
  mesh.count = instance_idx
}
```

For the partner-membership check, the renderer needs an `is_in_sites_to_draw(idx, jimage_partner): boolean` callback. The caller (`StructureScene`) provides this via the same `sites_to_draw` Map — keyed lookup is O(1).

#### Picker decode

`gpu-picker.ts:158` decode after Phase 7:
- `id < atom_count`: atom hit.
- Else: bond instance index = `id - atom_count - 1`.
  - If `instance_idx < bond_count * 2`: cell-internal half. `slot = instance_idx >>> 1`.
  - Else: image-atom decorator instance. `decorator_idx = instance_idx - bond_count * 2`. `image_atom_idx = decorator_idx >>> 1` (after walking CSR offsets to find which image_atom and bond slot). Resolve back to `(orig_slot, image_atom)` via the layout.

For now, simplify: any decorator-instance hit just resolves to the underlying BondManager slot (lose image-atom-specific picking until a follow-up). Hover/click on a decorator stub highlights the original bond.

### 2.3 Color contract for image-bond decorators

Each decorator instance carries the same colors as the underlying BondManager slot's atom A / atom B (whichever end is anchored). The shader's existing `mix(vColorStart, vColorEnd, vYPosition + 0.5)` math stays — set `vColorStart == vColorEnd == anchor_atom_color`.

For incomplete-edge stubs, color the visible half with the anchor atom's color (matches Phase 6).

---

## 3. Phase plan

### Phase 7a — `sites_to_draw` derivation
**Files:**
- `src/lib/structure/pbc-image-atoms.ts` (new): `build_sites_to_draw`, `ImageSiteEntry`, `SitesToDrawConfig`.
- `tests/vitest/structure/pbc-image-atoms.test.ts` (new): unit-test boundary, corner, edge, bond-following cases.

**Verify:**
- `pnpm check` clean.
- New test suite green.
- Unit test: cubic primitive cell with 1 atom at (0,0,0) → 8 corners (`(0,[0,0,0])` + 7 image permutations).
- Unit test: orthorhombic with one atom at (0.5, 0.5, 0.5) → only 1 entry (no images, no edge atoms).
- Unit test: `bonded_sites_outside_unit_cell=true` follows a `(0, 1, [+1,0,0])` bond and adds `(1, [+1,0,0])`.

### Phase 7b — Image-atom layout build
**Files:**
- `src/lib/structure/bonding/image-atom-layout.ts` (new): `build_image_atom_layout(sites_to_draw, bond_manager) → ImageAtomLayout`.
- `tests/vitest/structure/bonding/image-atom-layout.test.ts` (new).

**Verify:**
- Unit tests: 5-atom cell with known bonds → layout has correct CSR offsets and slot indices.
- BondManager mutations (add/remove) properly invalidate.

### Phase 7c — Renderer extension (single-mesh option A)
**Files:**
- `src/lib/structure/bonding/bond-instanced-renderer.ts`: add `get_image_atom_layout` constructor arg, extend `sync()` and `force_full_resync()` to also write decorator instances. Add `#write_image_slot` helper. Update `mesh.count` math.
- `src/lib/structure/bonding/BondManagerInstances.svelte`: pass image atom layout through; bump `last_layout_version` for resync triggers.

**Verify:**
- `mesh.count` calculation matches actual layout (probe with logging, then strip).
- Visual: SrTiO3 unit cell with `show_image_atoms=true` — corner Sr atoms now have full Sr-O bond environment from all neighboring image cells. Match crystaltoolkit reference render.
- Performance: 4×4×4 SiC supercell with image atoms ON — frame time within 10% of pre-Phase-7 baseline.

### Phase 7d — Incomplete-edge dispatch
**Files:**
- `bond-instanced-renderer.ts:#write_image_slot`: accept `is_partner_drawn: bool`. If false, render only the anchor stub (Phase 6 style) using current `incomplete_edge` opts.
- `BondManagerInstances.svelte`: thread `partner_drawn_lookup: (idx, jimage) → bool` callback derived from `sites_to_draw`.

**Verify:**
- Visual: with `show_image_atoms=false`, decorator path emits zero instances — back to Phase 4-6 paired stubs.
- Visual: with `show_image_atoms=true`, decorator instances merge cleanly with original bonds; "incomplete edges" appear at the outer boundary of the image atom set.

### Phase 7e — Picker integration
**Files:**
- `gpu-picker-integration.svelte.ts`: extend `update_gpu_picker` to also emit decorator-instance transforms in the same order the renderer writes them.
- `gpu-picker.ts:158`: decode handles decorator instance range. For simplicity, decorator hits resolve to the underlying BondManager slot via layout lookup (no per-image-atom selection).

**Verify:**
- Click on a decorator stub → corresponding intra-cell bond gets selected/highlighted.

### Phase 7f — Hitbox + click handling
**Files:**
- `StructureScene.svelte` bond_hitbox effect: also emit hitbox instances for decorator bonds (mirror Phase 6 patch but in the layout's order).
- `handle_bond_hitbox_click` / `handle_bond_hitbox_pointer_enter`: decode decorator hits to underlying bond slot.

**Verify:**
- Hover / click works on decorator stubs.

---

## 4. Risk & gotchas

### 4.1 Layout cache invalidation chain
`sites_to_draw` depends on:
- `bond_connectivity` (when `bonded_sites_outside_unit_cell=true`)
- `structure.sites` (for frac coord lookup)
- `config.draw_image_atoms / bonded_sites_outside_unit_cell / edge_tolerance`

`image_atom_layout` additionally depends on:
- `BondManager.version` (bonds added/removed)
- `sites_to_draw`

Either input change must rebuild the layout. Use Svelte `$derived.by` keyed on a single counter (`layout_version`) that bumps on any input change.

### 4.2 Memory: image atom count blowup
Pathological structure: 1000-atom supercell where every atom is at frac ≈ 0 → 7000 image atoms × 5 bonds avg = 35k decorator instances × 2 halves = 70k extra instances. Still under 1M cap but consumes ~5 MB instance buffer. Acceptable.

For 100k+ atom MOFs with most atoms cell-internal (frac far from 0/1), image atom count is typically 1–5% of total — minimal overhead.

### 4.3 Color buffer growth
Color attribute is sized to `mesh.instanceMatrix.count * 3`. With max_capacity=1M, the colors buffer is 12 MB. Already OK.

### 4.4 Selection coherence
Selecting a bond in cell-internal space should also visually highlight all decorator copies of that bond. Implementation: when computing `selected_bond_keys`, the renderer applies the same opacity/highlight to every instance derived from a selected slot — both Phase 4 instances (cell-internal) and decorator instances.

This is automatic if the decorator's color/opacity write reads from the same BondManager slot's opacity / colors. Verify nothing breaks.

### 4.5 Trajectory playback
`build_trajectory_bond_pairs` doesn't currently emit image-atom layouts. For Phase 7, trajectory frames need:
- Cell-internal half-bonds (Phase 4): position-dependent, recomputed per frame.
- Image-atom decorator transforms: also position-dependent (atoms move).

The layout's CSR (which image atom owns which bonds) is **static** as long as topology doesn't change — no need to rebuild per frame. Only the decorator transforms recompute. Same fast path as cell-internal half-bonds.

### 4.6 hide_incomplete_edges UI toggle
Phase 6 already has `incomplete_periodic_edge_mode` setting (boolean, default off). Reuse it: when `hide_incomplete_edges=true` (= Phase 6's setting), image-atom decorators render only when partner is in `sites_to_draw`; otherwise the partner-not-drawn instances emit zero-scale matrices.

### 4.7 Don't break charge labels
`displayed_structure` still needs `num_original_sites + image_to_original_map` for `charge-label-rendering.svelte.ts`. Phase 7's image-atom-layout layer is **additive** — it does not replace `find_pbc_images_fast`'s data structure. Keep `find_pbc_images_fast` working as today (or refactor it to use crystaltoolkit-style under the hood, but expose the same `num_original_sites + image_to_original_map` shape).

### 4.8 Coordination color path independence
`atom-properties.ts:get_coordination_colors` does its own PBC expansion via `expand_structure_for_pbc` — does NOT consume image atom layout. Leave alone.

### 4.9 Don't double-count cell-internal bonds
A cell-internal atom (jimage_img=[0,0,0]) is in `sites_to_draw` AND has bonds in BondManager. Phase 4's renderer already paints these. The image-atom layout should iterate only entries with `jimage_img != [0,0,0]` to avoid drawing cell-internal bonds twice.

---

## 5. Acceptance checklist (gate to main)

- [ ] All Rust tests pass (`cargo test` under `extensions/rust`).
- [ ] All TS tests pass (`pnpm test`).
- [ ] `pnpm check` reports no new type errors over baseline.
- [ ] Visual regression on:
  - SrTiO3 unit cell with `show_image_atoms=true`: corner Sr atoms have full Sr-O octahedral environment from neighboring image cells.
  - SrTiO3 unit cell with `show_image_atoms=false`: paired stubs at cell edges (Phase 4-6 behavior unchanged).
  - LGPS 2×2×1 supercell: bonds at outer cell faces look "complete" (image atoms have bonds to the supercell interior).
  - Water molecule (no lattice): no decorator instances; behavior identical to before.
  - 4×4×4 SiC supercell with `show_image_atoms=true`: frame time within 10% of pre-Phase-7 baseline.
- [ ] Charge label test: SrTiO3 supercell, charge labels persist through ghost-on/off toggle.
- [ ] Polyhedra fill on IrO2 slab still draws octahedra correctly.
- [ ] Incomplete-edge mode toggle works (visual: stubs cap the outer image-atom boundary).
- [ ] Picker: hover and click work for decorator stubs (resolves to underlying bond).
- [ ] Selection: selecting a bond highlights all its decorator copies.
- [ ] Trajectory: a small AIMD playback doesn't flicker decorator bonds frame-to-frame.

---

## 6. Non-goals (out of scope)

- **Per-image-atom selection.** Decorator-instance picker hits resolve to the underlying BondManager slot. Selecting "this specific image atom" is a future enhancement.
- **Crystaltoolkit's `color_edges_by_edge_weight`.** CatGo doesn't expose bond weight in the UI yet.
- **Polyhedra extension to image atoms.** Phase 5 recon (`reports/polyhedra-phase5-recon.md`) confirmed CatGo has no polyhedra renderer; nothing to extend.
- **Hydrogen bonds at image atoms.** Phase 7 only handles covalent bonds. H-bonds remain Phase-4-style for now.
- **Replacing `find_pbc_images_fast`.** Keep it functional (charge labels depend on it). The new `sites_to_draw` is an additional layer on top.

---

## 7. Branch/commit strategy

1. Phase 7a → standalone commit, includes new test file. Smallest unit, easy to review.
2. Phase 7b → adds CSR layout. Ships unit tests.
3. Phase 7c → renderer extension. **Visual regression starts here** — make sure 7a + 7b ship green before 7c lands.
4. Phase 7d → incomplete-edge dispatch. Tied to Phase 6 toggle.
5. Phase 7e → picker. Quick.
6. Phase 7f → hitbox. Quick.
7. Final commit: cleanup, dev probe removal, docs update.

After each phase commit, push to `split-files` branch. PR-ready when all 7 phases land green.

---

## 8. Critical files for implementation

**New:**
- `src/lib/structure/pbc-image-atoms.ts`
- `src/lib/structure/bonding/image-atom-layout.ts`
- `tests/vitest/structure/pbc-image-atoms.test.ts`
- `tests/vitest/structure/bonding/image-atom-layout.test.ts`

**Modified:**
- `src/lib/structure/bonding/bond-instanced-renderer.ts`
- `src/lib/structure/bonding/BondManagerInstances.svelte`
- `src/lib/structure/StructureScene.svelte`
- `src/lib/structure/gpu-picker.ts`
- `src/lib/structure/gpu-picker-integration.svelte.ts`

**Read-only context:**
- `src/lib/structure/pbc.ts` — `find_pbc_images_fast` (don't replace; understand the shape it returns)
- `extensions/rust/src/pbc.rs` — Rust impl backing it
- `src/lib/structure/bonding/bond-manager.svelte.ts` — SoA bond store (no changes)
- `reports/plan-pbc-halfbond-refactor.md` — parent plan
- `https://raw.githubusercontent.com/materialsproject/crystaltoolkit/main/crystal_toolkit/renderables/structuregraph.py` — reference

---

## 9. Phase 4-6 status snapshot (for executor's reference)

Latest commits on `split-files`:

| Commit | Title |
|---|---|
| `04689d5b` | feat(bonding): Phase 4 — half-bond rendering with jimage offset |
| `8f9faa78` | feat(bonding): Phase 5 — remove ghost atoms from bond computation path |
| `7465c60f` | feat(bonding): Phase 6 — incomplete-edge stub mode for cross-cell bonds |
| `f27ce0de` | fix(bonding): emit cross-cell bonds with image vector (Phase 4-5 fix) |
| `a9bd84d4` | fix(bonding): route compute_bonds_sync through main-thread WASM |
| `64c767e3` | fix(bonding): make BondPair.transform_matrix jimage-aware |
| `65ab1a79` | fix(bonding): paired stubs anchored at cell-internal positions |
| `59c9c5f4` | fix(neighbors): emit PBC wrap when bin count is 1 along an axis |
| `2a8032f8` | fix(bonding): track bond color count independently from BondManager dirty state |

Acceptance status of v1 plan (pre-Phase-7):
- ✅ Cell-internal half-bonds with hard color step at midpoint.
- ✅ Cross-cell bonds emit jimage from Rust through to BondManager.
- ✅ Paired stubs at cell edges (Phase 4-6).
- ✅ `incomplete_periodic_edge_mode` toggle.
- ✅ cell-list `n_bins=1` fix (LGPS, IrO2 etc).
- ✅ Sync WASM path emits jimage for small structures.
- ✅ Hitbox + picker aligned with paired-stub geometry.
- ⚠️ Image atom decoration — **Phase 7 territory**.

When in doubt, read the tests in `tests/vitest/structure/bonding/` for the contract that BondManager / the renderer expect.

---

## 10. Phase 7 delivery (2026-04-29)

| Phase | Commit | Status |
|---|---|---|
| 7a — `sites_to_draw` derivation                 | `3a68071c` | ✅ Landed (14 unit tests) |
| 7b — image-atom layout (CSR build)              | `4fa1c907` | ✅ Landed (9 unit tests) |
| 7c — renderer extension (single-mesh option A)  | `fd6e55f4` | ✅ Landed |
| 7d — incomplete-edge dispatch                   | `512858e1` | ✅ Landed |
| 7e + 7f — decorator picker & hitbox             | `a1802dd9` | ✅ Landed |

7e + 7f shipped together because they share the same lookup table
(`slot_to_filtered_idx` derived in `StructureScene.svelte`). Decorator
hits — both GPU-picker (large structures) and raycast hitbox (small
structures) — decode through a per-instance index that maps each
`(image_atom × bond)` cylinder back to the same `filtered_bond_pairs`
row that its cell-internal half resolves to. Selection / hover therefore
converge: clicking a decorator stub highlights the same logical bond as
clicking the cell-internal copy.

Verification on this branch:
- `pnpm check` — 0 errors, 289 warnings (baseline parity with `94afcb27`).
- 67 + targeted bonding / PBC / image-atom-layout / scene / supercell
  tests pass.
- Pre-existing failures in `Structure.test.svelte.ts` and
  `StructureExportPane.test.ts` were verified to also fail on the
  pre-Phase-7 baseline — unrelated regression, not introduced here.

Visual regression checklist (§5) — manual confirmation on a running
dev build is still required for SrTiO3, LGPS 2×2×1, IrO2 slab, water
molecule, and the 4×4×4 SiC perf budget.

End of Plan.
