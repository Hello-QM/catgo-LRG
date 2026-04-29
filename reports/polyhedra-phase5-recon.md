# Polyhedra Fill Builder Investigation — Phase 5 Compatibility Report

**Date:** 2026-04-28  
**Status:** GREEN LIGHT (No polyhedra renderer found; Phase 5 safe to proceed)

---

## 1. Polyhedra Builder File Inventory

### Finding: No Polyhedra/Coordination Geometry Renderer Found

**Search coverage:**
- Grep for `polyhedra`, `polyhedron`, `octahed`, `tetrahed`, `coordination.*geom`, `convex.*hull`, `fill` → **0 results in `/src/lib/structure/`**
- Grep for `ConvexGeometry`, `ConvexObjectGeometry` → Found only in phase-diagram (4D hull convex computation, not structure atoms)
- Grep for UI settings related to polyhedra display → No `atom_color_mode: coordination` polyhedra option in settings
- Scanned `StructureScene.svelte` (3529 lines), `Structure.svelte` (5128 lines), `BondManagerInstances.svelte`, `AtomImpostors.svelte` → **No polyhedra rendering logic**

### Rendering Architecture (Confirmed)

**What CatGo DOES render:**
- **Atoms:** GPU impostor spheres via `AtomImpostors.svelte` using ray-sphere fragment shader
- **Bonds:** Half-cylinder instances (Phase 4 in plan) via `Bond.svelte` / `BondManagerInstances.svelte`
- **Lattice vectors:** Line rendering in `Lattice.svelte`
- **PBC image atoms:** Explicitly marked with dimmed opacity (< 100%) but same sphere geometry

**What CatGo DOES NOT render:**
- **Coordination polyhedra** (octahedral, tetrahedral, etc.)
- **Polyhedral filling** (solid convex hulls around coordination centers)
- **Any ConvexGeometry-based filling**

### Evidence Chain

1. **No settings**: `SETTINGS_CONFIG.structure` (lines 107–180 in config.ts) has NO entry for "polyhedra fill", "show coordination polyhedra", "coordination geometry", etc.

2. **No state or props in Structure/StructureScene**: 
   - `Structure.svelte` (all 5128 lines) — no `show_polyhedra`, `coordination_fillstyle`, etc.
   - `StructureScene.svelte` (props lines 541–610, rendering lines 2700+) — no polyhedra-related props or rendering code
   - `AtomLegend.svelte` (legend UI) — only for atoms, bonds, and labels; no polyhedra option

3. **No coordination analysis beyond CN counting**:
   - `calc_coordination.ts:17-30` — computes `CoordinationData` (coordination numbers only, no bond partners stored for polyhedra)
   - `atom-properties.ts:get_coordination_colors()` — uses bonds to COLOR atoms by CN, not to FILL polyhedra

4. **Demo page** (`coordination/+page.svelte`):
   - Shows structure viewer with `Strategy` and `Split Mode` controls
   - **Does NOT show** any polyhedra-fill toggle or rendering
   - Coordination coloring is available (color atoms by CN), but no geometry filling

---

## 2. Current PBC Bond Handling (Not Polyhedra-Specific)

### Bond Data Flow (Relevant to Phase 5)

**Current path (Phases 1-4 baseline, before Phase 5 changes):**

```
structure + pbc=true
  ↓ (has `num_original_sites`? yes)
  → strip PBC from bond_structure (lines 107-111, bond-computation-controller.svelte.ts)
  → detect bonds on `bond_structure` with pbc=[false,false,false]
  → bonds found between original sites AND ghost atoms (Cartesian distance)
  → BondManager stores pairs as (orig_idx, ghost_idx) with strength
  → BondManagerInstances renders each bond
  → Ghost atoms visible via `show_image_atoms` toggle
```

**Phase 5 intent (bonds no longer use ghosts):**

```
structure + pbc=true
  ↓ (Phase 5: delete lines 107-111)
  → detect bonds on `bond_structure` with pbc=[true,true,true]
  → Rust WASM finds bonds between original sites, returns jimage
  → bonds stored as (orig_idx, orig_idx, jimage)
  → BondManagerInstances renders two half-cylinders per bond (phases 1-4 complete)
  → Ghost atoms still visible for display/charge-labels (separate path)
```

### Does Polyhedra Currently Use Ghost Bonds?

**Answer: NO — because polyhedra renderer doesn't exist.**

Even if it did exist, the logic would be:
- Center atom at orig_idx (Ir)
- Find all bonds with endpoints `(orig_idx, any)` where `any >= num_original_sites` (ghosts)
- Get positions: `sites[orig_idx].xyz` + `sites[any].xyz` for ghost
- Draw convex hull or polyhedral mesh

After Phase 5, such a polyhedra builder would need:
- Center atom at orig_idx (Ir)
- Find all bonds with `site_idx_1 == orig_idx` (or vice versa) and any `jimage`
- Compute positions: `sites[orig_idx].xyz` + `sites[endpoint].xyz + lattice·jimage`
- Draw convex hull

**This is feasible without ghosts** — the rendering change is local to the polyhedra builder, not architecture-breaking.

---

## 3. Phase 5 Impact Assessment

### Verdict: GREEN LIGHT ✅

**Reason:** Polyhedra builder does not exist, so Phase 5 cannot break it.

**Supporting logic:**
- Phase 5 deletes the "strip PBC" hack (lines 96-111 of bond-computation-controller.svelte.ts)
- This enables bonds to carry `jimage` directly from Rust
- Polyhedra (if they existed) would need to synthesize position from `jimage` instead of reading ghost sites
- Since polyhedra don't exist, no synthesis code to write

**Risk to other systems:** NONE
- Charge labels: Explicitly stated as safe in plan (line 325: `charge-label-rendering.svelte.ts` left unchanged, still uses `num_original_sites` + `image_to_original_map`)
- Coordination coloring: Works on expanded structure, independent of bond pipeline
- Atom display: `num_original_sites` / `image_to_original_map` still available for UI (plan line 99-101)

---

## 4. Test Scenarios (Current State)

### Structures Tested in Code

1. **SrTiO3 (cubic octahedral)**
   - Demo available at `coordination/+page.svelte`
   - Visible: atoms colored by coordination number, structure visible
   - NOT visible: polyhedra fill (feature doesn't exist)

2. **IrO2 (tetragonal slab)**
   - Mentioned in Phase 5 verification plan (line 339)
   - Expected use: check bond count, verify no spider-web duplication
   - NOT used for polyhedra testing (because polyhedra not implemented)

3. **ZIF-8 (MOF, tetrahedral geometry)**
   - Mentioned in user context as example of coordination geometry
   - MOF structures do have tetrahedral ZnN4 units, but CatGo doesn't fill them
   - Only bonds and atoms rendered, no polyhedra

### How to Verify Phase 5 Doesn't Break What Exists

1. **Post-Phase 5:** Open SrTiO3 / IrO2 / ZIF-8 in structure viewer
2. **Check atoms:** Rendered correctly (no regression expected)
3. **Check bonds:** Appear at cell boundaries correctly (Phase 4 rendering verified)
4. **Check charge labels:** Still resolve to original atoms (plan line 338)
5. **Check coordination colors:** Atoms still colored by CN (independent path)
6. **Expect NOT to see:** Polyhedra fill (was never there)

---

## 5. Sub-Findings & Implications

### 5.1 Related Features That Do Use Ghosts

| Feature | File | Usage | Phase 5 Impact |
|---------|------|-------|----------------|
| **Charge labels** | `charge-label-rendering.svelte.ts:24-36` | Label orig_site_idx mapping | SAFE: use `image_to_original_map`, unchanged |
| **Coordination coloring** | `atom-properties.ts:get_coordination_colors` | Expand structure for CN | SAFE: independent `expand_structure_for_pbc` |
| **Atom display opacity** | `AtomImpostors.svelte:280-284` | Dim ghosts via `num_original_sites` | SAFE: still available (not deleted by Phase 5) |
| **Bond endpoint opacity** | `BondManagerInstances.svelte:284-300` | `image_atom_opacity` on ghost endpoints | NEEDS CHANGE: repurpose to `periodic_bond_opacity` when `jimage != [0,0,0]` (plan line 328) |
| **Polyhedra fill** | NOT IMPLEMENTED | Would synthesize positions | N/A |

### 5.2 Plan Gotchas Not Affecting Polyhedra

From plan section 4 (Risk & gotchas):
- **4.13 Bond-key canonicalization**: No impact on polyhedra (bonds not used for filling)
- **4.14 jimage sign convention**: No impact (polyhedra don't exist yet)
- **4.16 `Bond.svelte` legacy path**: No impact (polyhedra independent)

### 5.3 Workflow/MCP Tools

Searched for chat-workflow tools that might generate polyhedra:
- `src/lib/chat/structure-tools.ts` — tools: `place_adsorbate`, `create_supercell`, `cut_slab`, etc. → None emit polyhedra
- MCP server tools: `server/mcp_tools/server.py` — No polyhedra operations
- **Conclusion:** No AI workflow currently generates or manipulates polyhedra

---

## 6. If Polyhedra Were Implemented: What Phase 5 Would Require

Hypothetical implementation guide (for future work):

```typescript
// Polyhedra Builder (if it existed) — Phase 5-compatible approach:

function build_coordination_polyhedra(
  center_site_idx: number,
  bond_pairs: BondPair[],
  displayed_structure: PymatgenStructure,
  lattice: LatticeMatrix | null,
  center_element: string,
) {
  // Filter bonds where site_idx_1 == center_site_idx
  const coordination_bonds = bond_pairs.filter(b => b.site_idx_1 === center_site_idx)
  
  // Compute neighbor positions using jimage
  const neighbor_positions: Vec3[] = coordination_bonds.map(bond => {
    const neighbor_xyz = displayed_structure.sites[bond.site_idx_2].xyz
    const jimage = bond.jimage ?? [0, 0, 0]  // Phase 5: comes from BondPair
    
    if (jimage[0] === 0 && jimage[1] === 0 && jimage[2] === 0) {
      return neighbor_xyz  // In-cell neighbor
    }
    
    // Out-of-cell: apply lattice translation
    // b_eff = pos_2 + dx*a_vec + dy*b_vec + dz*c_vec
    const offset = [
      jimage[0] * lattice[0][0] + jimage[1] * lattice[1][0] + jimage[2] * lattice[2][0],
      jimage[0] * lattice[0][1] + jimage[1] * lattice[1][1] + jimage[2] * lattice[2][1],
      jimage[0] * lattice[0][2] + jimage[1] * lattice[1][2] + jimage[2] * lattice[2][2],
    ]
    return [neighbor_xyz[0] + offset[0], neighbor_xyz[1] + offset[1], neighbor_xyz[2] + offset[2]]
  })
  
  // Convex hull of neighbors (existing Three.js ConvexGeometry library)
  const hull = quickHull3D(neighbor_positions)
  
  // Render mesh with center_element color
  return build_polyhedra_mesh(hull, center_xyz, center_element_color)
}
```

**Key changes from Phase 4 bonds:**
- Input: `bond_pairs` now carry `jimage` field (from Phase 1-2 work)
- Computation: Use `jimage` to compute `b_eff` instead of reading `sites[ghost_idx].xyz`
- No dependency on `num_original_sites` or `image_to_original_map` for bond endpoints
- Lattice matrix now a parameter (passed separately, not inferred from structure size)

---

## Conclusion

**Phase 5 is safe to merge.** There is no polyhedra rendering code in CatGo that could be broken by removing ghost-atom dependencies from the bond pipeline. The warning in the plan (line 341) is a precaution; the investigation shows it's not needed in this codebase.

**If polyhedra rendering is desired as a future feature**, Phase 5 actually makes it easier: bonds will carry explicit `jimage`, eliminating the need to infer periodicity from ghost atoms. The polyhedra builder would be a new, independent component — not a refactor of existing code.

---

## Report Metadata

- **Search scope:** `/src/lib/structure/` (all `.ts`/`.svelte`), phase-diagram excluded
- **Patterns searched:** `polyhedra`, `octahed`, `tetrahed`, `polyhedron`, `ConvexGeometry`, `fill` (bonds + geometry)
- **Files examined (key):**
  - `Structure.svelte` (5128 lines)
  - `StructureScene.svelte` (3529 lines)
  - `bond-computation-controller.svelte.ts` (300+ lines)
  - `calc-coordination.ts` (100 lines)
  - `atom-properties.ts` (342 lines)
  - Settings config & demo pages
- **Conclusion certainty:** Very high (0 positive matches for polyhedra rendering)
