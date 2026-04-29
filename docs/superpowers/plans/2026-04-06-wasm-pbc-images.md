# WASM PBC Image Generation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move PBC image atom generation from JavaScript to Rust/WASM for 100K+ atom performance (OVITO-level).

**Architecture:** Add a `find_pbc_images` function in Rust that does both Phase 1 (translational images within fractional range) and Phase 2 (bond-completion using existing cell-list neighbor search). Export via `wasm.rs` as `find_pbc_image_sites`. JS transform controller calls WASM with JS fallback. The existing `neighbors.rs` cell-list and `element.rs` covalent radii are reused — no new dependencies.

**Tech Stack:** Rust (nalgebra, wasm-bindgen, tsify, serde, rayon), existing `ferrox` crate architecture

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `extensions/rust/src/pbc.rs` | Modify | Add `find_pbc_images()` — Phase 1 translational + Phase 2 bond completion |
| `extensions/rust/src/wasm.rs` | Modify | Add `#[wasm_bindgen] find_pbc_image_sites()` entry point |
| `extensions/rust/src/wasm_types.rs` | Modify | Add `JsPbcImageResult` return type |
| `src/lib/structure/ferrox-wasm.ts` | Modify | Add `wasm_find_pbc_images()` JS wrapper |
| `src/lib/structure/pbc.ts` | Modify | Keep as JS fallback, add `find_pbc_images_wasm()` that calls WASM with fallback |
| `src/lib/structure/controllers/transform-controller.svelte.ts` | Modify | Call new unified `find_pbc_images_wasm()` instead of `get_pbc_image_sites()` |

---

### Task 1: Add `JsPbcImageResult` type to wasm_types.rs

**Files:**
- Modify: `extensions/rust/src/wasm_types.rs`

- [ ] **Step 1: Add the result type**

Append to the end of `wasm_types.rs` (before any closing brackets):

```rust
/// Result of PBC image generation.
/// Contains arrays of image atom data aligned by index.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi)]
pub struct JsPbcImageResult {
    /// Index of the parent atom in the original structure for each image
    pub parent_indices: Vec<usize>,
    /// Cartesian positions [x, y, z] of each image atom
    pub positions_xyz: Vec<[f64; 3]>,
    /// Fractional positions [a, b, c] of each image atom
    pub positions_abc: Vec<[f64; 3]>,
    /// Number of Phase 1 (translational) images (the rest are bond-completion)
    pub num_translational: usize,
}
```

- [ ] **Step 2: Commit**

```bash
git add extensions/rust/src/wasm_types.rs
git commit -m "feat(wasm): add JsPbcImageResult type for PBC image generation"
```

---

### Task 2: Implement `find_pbc_images` in Rust pbc.rs

**Files:**
- Modify: `extensions/rust/src/pbc.rs`

This is the core algorithm. It reuses `CellList` patterns from `neighbors.rs` but operates in Cartesian space (not fractional) for the spatial grid, since image atoms can be outside [0,1].

- [ ] **Step 1: Add the function**

Add to `pbc.rs`:

```rust
use crate::element::Element;
use crate::structure::Structure;
use nalgebra::{Matrix3, Vector3};

/// Configuration for PBC image generation.
pub struct PbcImageConfig {
    /// Minimum fractional coordinate for display range (default: -0.05)
    pub range_min: f64,
    /// Maximum fractional coordinate for display range (default: 1.05)
    pub range_max: f64,
    /// Whether to do bond-completion (Phase 2)
    pub bond_completion: bool,
    /// Bond tolerance multiplier for covalent radii (default: 1.25)
    pub bond_tolerance: f64,
}

impl Default for PbcImageConfig {
    fn default() -> Self {
        Self {
            range_min: -0.05,
            range_max: 1.05,
            bond_completion: true,
            bond_tolerance: 1.25,
        }
    }
}

/// Result of PBC image generation.
pub struct PbcImageResult {
    /// Index of the parent atom in the original structure
    pub parent_indices: Vec<usize>,
    /// Cartesian positions of image atoms
    pub positions_xyz: Vec<Vector3<f64>>,
    /// Fractional positions of image atoms
    pub positions_abc: Vec<Vector3<f64>>,
    /// How many images came from Phase 1 (translational)
    pub num_translational: usize,
}

/// Generate PBC image atoms for display (VESTA-like).
///
/// Phase 1: Translational images — shift each atom by 26 neighbor cell offsets,
/// keep images within [range_min, range_max] fractional range, deduplicate.
///
/// Phase 2: Bond completion — for each image atom, ensure its bonded neighbors
/// (within covalent radii * tolerance) also have images at the same offset.
///
/// Uses Cartesian spatial grid (cell-list) for O(n) dedup and neighbor search.
pub fn find_pbc_images(structure: &Structure, config: &PbcImageConfig) -> PbcImageResult {
    let n = structure.num_sites();
    let lattice = &structure.lattice;
    let pbc = lattice.pbc;
    let matrix = lattice.matrix();
    let lattice_vecs: [Vector3<f64>; 3] = [
        matrix.row(0).transpose(),
        matrix.row(1).transpose(),
        matrix.row(2).transpose(),
    ];

    // Lattice transpose for frac→cart conversion
    let lat_t = Matrix3::new(
        lattice_vecs[0][0], lattice_vecs[1][0], lattice_vecs[2][0],
        lattice_vecs[0][1], lattice_vecs[1][1], lattice_vecs[2][1],
        lattice_vecs[0][2], lattice_vecs[1][2], lattice_vecs[2][2],
    );

    // Skip trajectory data (>10% atoms outside cell)
    let outside_count = structure.frac_coords.iter()
        .filter(|f| f.iter().any(|&c| c < -0.1 || c > 1.1))
        .count();
    if outside_count > n / 10 {
        return PbcImageResult {
            parent_indices: vec![],
            positions_xyz: vec![],
            positions_abc: vec![],
            num_translational: 0,
        };
    }

    // Build 26 neighbor offsets (filtered by PBC flags)
    let mut offsets: Vec<[i32; 3]> = Vec::with_capacity(26);
    for dx in -1..=1i32 {
        for dy in -1..=1i32 {
            for dz in -1..=1i32 {
                if dx == 0 && dy == 0 && dz == 0 { continue; }
                if !pbc[0] && dx != 0 { continue; }
                if !pbc[1] && dy != 0 { continue; }
                if !pbc[2] && dz != 0 { continue; }
                offsets.push([dx, dy, dz]);
            }
        }
    }

    // ═══ Spatial grid for deduplication ═══
    let dedup_tol_sq: f64 = 0.01 * 0.01;
    let dedup_cell: f64 = 0.05;
    let dedup_inv = 1.0 / dedup_cell;

    // Use HashMap<(i64,i64,i64), Vec<Vector3<f64>>> for collision-free dedup
    use std::collections::HashMap;
    let mut dedup_grid: HashMap<(i64, i64, i64), Vec<Vector3<f64>>> = HashMap::new();

    let cart_coords = structure.cart_coords();

    // Seed with original atoms
    for xyz in &cart_coords {
        let key = (
            (xyz.x * dedup_inv).floor() as i64,
            (xyz.y * dedup_inv).floor() as i64,
            (xyz.z * dedup_inv).floor() as i64,
        );
        dedup_grid.entry(key).or_default().push(*xyz);
    }

    let is_duplicate = |xyz: &Vector3<f64>| -> bool {
        let cx = (xyz.x * dedup_inv).floor() as i64;
        let cy = (xyz.y * dedup_inv).floor() as i64;
        let cz = (xyz.z * dedup_inv).floor() as i64;
        for di in -1..=1i64 {
            for dj in -1..=1i64 {
                for dk in -1..=1i64 {
                    if let Some(cell) = dedup_grid.get(&(cx + di, cy + dj, cz + dk)) {
                        for exyz in cell {
                            let d = xyz - exyz;
                            if d.dot(&d) < dedup_tol_sq {
                                return true;
                            }
                        }
                    }
                }
            }
        }
        false
    };

    // ═══ Phase 1: Translational images ═══
    let mut parent_indices = Vec::new();
    let mut positions_xyz = Vec::new();
    let mut positions_abc = Vec::new();

    for idx in 0..n {
        let abc = &structure.frac_coords[idx];
        for offset in &offsets {
            let img_abc = Vector3::new(
                abc.x + offset[0] as f64,
                abc.y + offset[1] as f64,
                abc.z + offset[2] as f64,
            );

            // Range check
            if img_abc.x < config.range_min || img_abc.x > config.range_max { continue; }
            if img_abc.y < config.range_min || img_abc.y > config.range_max { continue; }
            if img_abc.z < config.range_min || img_abc.z > config.range_max { continue; }

            let img_xyz = lat_t * img_abc;

            if is_duplicate(&img_xyz) { continue; }

            // Add to dedup grid
            let key = (
                (img_xyz.x * dedup_inv).floor() as i64,
                (img_xyz.y * dedup_inv).floor() as i64,
                (img_xyz.z * dedup_inv).floor() as i64,
            );
            dedup_grid.entry(key).or_default().push(img_xyz);

            parent_indices.push(idx);
            positions_xyz.push(img_xyz);
            positions_abc.push(img_abc);
        }
    }

    let num_translational = parent_indices.len();

    // ═══ Phase 2: Bond completion ═══
    if config.bond_completion && num_translational > 0 {
        // Build adjacency using Cartesian spatial grid with adaptive covalent cutoff
        let mut max_radius: f64 = 0.0;
        let radii: Vec<f64> = (0..n).map(|i| {
            let el_sym = &structure.species[i].symbol;
            let r = Element::from_symbol(el_sym)
                .and_then(|e| e.covalent_radius())
                .unwrap_or(1.5);
            if r > max_radius { max_radius = r; }
            r
        }).collect();

        let max_bond = 2.0 * max_radius * config.bond_tolerance;
        let cell_size = max_bond.max(0.5);
        let grid_inv = 1.0 / cell_size;

        // Build Cartesian grid for adjacency
        let mut adj_grid: HashMap<(i64, i64, i64), Vec<usize>> = HashMap::new();
        for (i, xyz) in cart_coords.iter().enumerate() {
            let key = (
                (xyz.x * grid_inv).floor() as i64,
                (xyz.y * grid_inv).floor() as i64,
                (xyz.z * grid_inv).floor() as i64,
            );
            adj_grid.entry(key).or_default().push(i);
        }

        // Build adjacency list
        let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
        let bond_min_sq: f64 = 0.01;

        for (&(cx, cy, cz), cell) in &adj_grid {
            for di in -1..=1i64 {
                for dj in -1..=1i64 {
                    for dk in -1..=1i64 {
                        if let Some(ncell) = adj_grid.get(&(cx + di, cy + dj, cz + dk)) {
                            for &i in cell {
                                for &j in ncell {
                                    if j <= i { continue; }
                                    let d = cart_coords[i] - cart_coords[j];
                                    let d2 = d.dot(&d);
                                    if d2 < bond_min_sq { continue; }
                                    let bond_max = (radii[i] + radii[j]) * config.bond_tolerance;
                                    if d2 < bond_max * bond_max {
                                        adj[i].push(j);
                                        adj[j].push(i);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Track which (atom_idx, offset) pairs already have images
        use std::collections::HashSet;
        let mut image_set: HashSet<(usize, [i32; 3])> = HashSet::new();
        for (img_idx, &parent) in parent_indices.iter().enumerate() {
            let orig_abc = &structure.frac_coords[parent];
            let img_abc = &positions_abc[img_idx];
            let offset = [
                (img_abc.x - orig_abc.x).round() as i32,
                (img_abc.y - orig_abc.y).round() as i32,
                (img_abc.z - orig_abc.z).round() as i32,
            ];
            image_set.insert((parent, offset));
        }

        // For each existing image, add missing bonded neighbors at the same offset
        let n_trans = num_translational;
        for img_idx in 0..n_trans {
            let parent = parent_indices[img_idx];
            let orig_abc = &structure.frac_coords[parent];
            let img_abc_val = positions_abc[img_idx];
            let offset = [
                (img_abc_val.x - orig_abc.x).round() as i32,
                (img_abc_val.y - orig_abc.y).round() as i32,
                (img_abc_val.z - orig_abc.z).round() as i32,
            ];

            for &nb in &adj[parent] {
                if image_set.contains(&(nb, offset)) { continue; }
                let nb_abc = Vector3::new(
                    structure.frac_coords[nb].x + offset[0] as f64,
                    structure.frac_coords[nb].y + offset[1] as f64,
                    structure.frac_coords[nb].z + offset[2] as f64,
                );
                let nb_xyz = lat_t * nb_abc;
                image_set.insert((nb, offset));
                parent_indices.push(nb);
                positions_xyz.push(nb_xyz);
                positions_abc.push(nb_abc);
            }
        }
    }

    PbcImageResult {
        parent_indices,
        positions_xyz,
        positions_abc,
        num_translational,
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add extensions/rust/src/pbc.rs
git commit -m "feat(rust): add find_pbc_images with spatial grid dedup + bond completion"
```

---

### Task 3: Add WASM entry point in wasm.rs

**Files:**
- Modify: `extensions/rust/src/wasm.rs`

- [ ] **Step 1: Add the WASM function**

Add at the end of `wasm.rs` (before the last `}`):

```rust
/// Generate PBC image atoms for display.
///
/// Takes a JsCrystal and optional config JSON:
/// ```json
/// {
///   "range_min": -0.05,
///   "range_max": 1.05,
///   "bond_completion": true,
///   "bond_tolerance": 1.25
/// }
/// ```
///
/// Returns JsPbcImageResult with parallel arrays of parent indices and positions.
#[wasm_bindgen]
pub fn find_pbc_image_sites(
    crystal: JsCrystal,
    options_json: Option<String>,
) -> WasmResult<JsPbcImageResult> {
    use crate::pbc::{PbcImageConfig, find_pbc_images};

    let result: Result<JsPbcImageResult, String> = (|| {
        let structure = crate::structure::Structure::from_js_crystal(&crystal)
            .map_err(|e| e.to_string())?;

        let config = match options_json {
            Some(ref json) if !json.is_empty() => {
                let v: serde_json::Value = serde_json::from_str(json)
                    .map_err(|e| format!("Invalid PBC config: {e}"))?;
                PbcImageConfig {
                    range_min: v.get("range_min").and_then(|v| v.as_f64()).unwrap_or(-0.05),
                    range_max: v.get("range_max").and_then(|v| v.as_f64()).unwrap_or(1.05),
                    bond_completion: v.get("bond_completion").and_then(|v| v.as_bool()).unwrap_or(true),
                    bond_tolerance: v.get("bond_tolerance").and_then(|v| v.as_f64()).unwrap_or(1.25),
                }
            }
            _ => PbcImageConfig::default(),
        };

        let result = find_pbc_images(&structure, &config);

        Ok(JsPbcImageResult {
            parent_indices: result.parent_indices,
            positions_xyz: result.positions_xyz.iter().map(|v| [v.x, v.y, v.z]).collect(),
            positions_abc: result.positions_abc.iter().map(|v| [v.x, v.y, v.z]).collect(),
            num_translational: result.num_translational,
        })
    })();
    result.into()
}
```

Also add `JsPbcImageResult` to the imports at the top of `wasm.rs`:

Add `JsPbcImageResult` to the `use crate::wasm_types::{...}` import.

- [ ] **Step 2: Build WASM**

```bash
cd extensions/rust && wasm-pack build --target web --out-dir ../rust-wasm/pkg --features wasm
```

Expected: Successful compilation, new `.wasm` file in `extensions/rust-wasm/pkg/`

- [ ] **Step 3: Commit**

```bash
git add extensions/rust/src/wasm.rs extensions/rust-wasm/pkg/
git commit -m "feat(wasm): expose find_pbc_image_sites WASM entry point"
```

---

### Task 4: Add JS wrapper in ferrox-wasm.ts

**Files:**
- Modify: `src/lib/structure/ferrox-wasm.ts`

- [ ] **Step 1: Add the WASM wrapper function**

Add near the other WASM wrapper functions (after `detect_bonds_solid_angle` etc.):

```typescript
/**
 * Generate PBC image atoms using WASM (fast path for large structures).
 * Returns null if WASM is not ready.
 */
export async function wasm_find_pbc_images(
  structure: PymatgenStructure,
  options?: { range_min?: number; range_max?: number; bond_completion?: boolean; bond_tolerance?: number },
): Promise<{
  parent_indices: number[]
  positions_xyz: [number, number, number][]
  positions_abc: [number, number, number][]
  num_translational: number
} | null> {
  const wasm = await ensure_ferrox_wasm_ready()
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
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/structure/ferrox-wasm.ts
git commit -m "feat: add wasm_find_pbc_images JS wrapper"
```

---

### Task 5: Update pbc.ts to use WASM with JS fallback

**Files:**
- Modify: `src/lib/structure/pbc.ts`

- [ ] **Step 1: Add async WASM entry point**

Add a new exported function at the end of `pbc.ts`:

```typescript
import { wasm_find_pbc_images } from './ferrox-wasm'

/**
 * Generate PBC image sites using WASM (fast) with JS fallback.
 * For 100K+ atoms, WASM is ~10-50x faster than JS.
 */
export async function find_pbc_images_fast(
  structure: ParsedStructure,
  options?: { range_min?: number; range_max?: number; bond_completion?: boolean; bond_tolerance?: number },
): Promise<ParsedStructure & { num_original_sites?: number; image_to_original_map?: number[] }> {
  if (!structure?.sites?.length || !structure.lattice) return structure

  // Try WASM first
  const wasm_result = await wasm_find_pbc_images(
    structure as any,
    options ?? { range_min: -0.05, range_max: 1.05, bond_completion: true, bond_tolerance: 1.25 },
  )

  if (wasm_result && wasm_result.parent_indices.length > 0) {
    // Build displayed structure from WASM result
    const num_original_sites = structure.sites.length
    const image_to_original_map: number[] = wasm_result.parent_indices
    const imaged_struct = {
      ...structure,
      sites: [...structure.sites],
      num_original_sites,
      image_to_original_map,
    }

    for (let i = 0; i < wasm_result.parent_indices.length; i++) {
      const site_idx = wasm_result.parent_indices[i]
      const orig_site = structure.sites[site_idx]
      imaged_struct.sites.push({
        ...orig_site,
        abc: wasm_result.positions_abc[i] as Vec3,
        xyz: wasm_result.positions_xyz[i] as Vec3,
        properties: { ...orig_site.properties, orig_site_idx: site_idx },
      })
    }

    return imaged_struct
  }

  // JS fallback
  return get_pbc_image_sites(structure)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/structure/pbc.ts
git commit -m "feat: add find_pbc_images_fast with WASM + JS fallback"
```

---

### Task 6: Wire transform controller to use WASM PBC

**Files:**
- Modify: `src/lib/structure/controllers/transform-controller.svelte.ts`

- [ ] **Step 1: Update the PBC effect to use async WASM**

Replace the synchronous `get_pbc_image_sites(ss)` call with `find_pbc_images_fast(ss)`:

```typescript
import { get_pbc_image_sites, get_periodic_repeat_sites, find_pbc_images_fast } from '$lib/structure'
```

Update the PBC $effect to use the async version:

```typescript
  // PBC generation counter to discard stale async results
  let pbc_gen = 0

  $effect(() => {
    const show_image_atoms = deps.get_show_image_atoms()
    const repeats = deps.get_periodic_repeats()
    const ss = supercell_structure

    if (show_image_atoms && ss && 'lattice' in ss && ss.lattice) {
      const has_repeats = repeats[0] > 0 || repeats[1] > 0 || repeats[2] > 0
      if (has_repeats) {
        // Synchronous periodic repeat (not PBC images)
        deps.set_displayed_structure(get_periodic_repeat_sites(ss, repeats))
      } else {
        // Async WASM PBC with generation guard
        const gen = ++pbc_gen
        find_pbc_images_fast(ss).then((result) => {
          if (gen === pbc_gen) {
            deps.set_displayed_structure(result)
          }
        })
        // Show structure immediately (without images) while WASM computes
        deps.set_displayed_structure(ss)
      }
    } else {
      deps.set_displayed_structure(ss)
    }
  })
```

Remove the old `pbc_cache_*` variables (WASM is fast enough to not need caching).

- [ ] **Step 2: Commit**

```bash
git add src/lib/structure/controllers/transform-controller.svelte.ts
git commit -m "feat: wire transform controller to async WASM PBC generation"
```

---

### Task 7: Build, test end-to-end, clean up

- [ ] **Step 1: Build WASM**

```bash
cd extensions/rust && wasm-pack build --target web --out-dir ../rust-wasm/pkg --features wasm
```

- [ ] **Step 2: Test with small structure (H2O)**

Load H2O, verify no regressions. Check console for WASM PBC messages.

- [ ] **Step 3: Test with MOF-808 CIF (576 atoms)**

Load I-3.cif, verify PBC images at boundary, verify boundary bonds work.

- [ ] **Step 4: Test with 2×2×2 supercell (4608 atoms)**

Expand to 2×2×2, verify no freezing, verify boundary bonds. Compare timing with JS fallback.

- [ ] **Step 5: Test with large structure if available (10K+ atoms)**

If available, test with a large supercell to verify WASM handles 10K+ atoms smoothly.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete WASM PBC image generation with JS fallback

Moves PBC image atom generation from JavaScript to Rust/WASM for
100K+ atom performance. The Rust implementation uses:
- Spatial grid (cell-list) for O(n) dedup and neighbor search
- Adaptive covalent radii for bond completion cutoffs
- HashMap-based collision-free dedup

Falls back to JS implementation when WASM is unavailable.
The transform controller now uses async WASM with immediate
display (structure without images shown while WASM computes)."
git push
```

---

## Notes

- The `pbc=[false,false,false]` hack in `bond-computation-controller.svelte.ts` is still needed — it's about the BOND computation, not PBC image generation. The WASM bonding strategies still handle PBC internally, so we disable it when images are present.
- The JS fallback in `pbc.ts` (`get_pbc_image_sites`) is kept for cases where WASM hasn't loaded yet (first render) or fails.
- The `Structure::from_js_crystal` conversion in Rust already exists and handles the JsCrystal→Structure conversion.
- `Element::from_symbol` + `covalent_radius()` is already available in `element.rs`.
