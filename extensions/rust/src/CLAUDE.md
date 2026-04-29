# extensions/rust/src/ — Rust WASM Backend (ferrox)

## Why Rust WASM

Bond detection on 1000+ atoms in pure JS freezes the browser for seconds. Rust WASM runs 10-50x faster for the same algorithms. The name "ferrox" = ferro (iron) + ox (oxidation) — a materials science pun.

The WASM module is built separately from the main TypeScript codebase and linked as workspace package `@catgo/ferrox-wasm`. This separation means:
- Rust changes require explicit `wasm-pack build` — not auto-rebuilt by Vite
- The built WASM files are committed to `extensions/rust-wasm/pkg/` so collaborators don't need Rust toolchain

## Build

```bash
cd extensions/rust && wasm-pack build --target web --out-dir ../rust-wasm/pkg --features wasm
```

Output: `extensions/rust-wasm/pkg/` → npm package `@catgo/ferrox-wasm`

## Key Files

| File | Purpose |
|------|---------|
| **wasm.rs** | `#[wasm_bindgen]` entry points — ALL WASM-exposed functions |
| **wasm_types.rs** | JS-compatible types (JsCrystal, JsSite, JsLattice, etc.) |
| **bonding.rs** | Bond detection algorithms (atom_radii, electroneg_ratio, solid_angle) |
| **neighbors.rs** | Neighbor list construction (spatial grid) |
| **structure.rs** | Crystal structure types and operations |
| **lattice.rs** | Lattice operations, supercell matrix transforms |
| **element.rs** | Element data (radii, electronegativity, etc.) |
| **coordination.rs** | Coordination number analysis |
| **pbc.rs** | Periodic boundary condition utilities |
| **slab.rs** | Slab generation from bulk |
| **surfaces.rs** | Surface analysis |
| **matcher.rs** / **structure_matcher.rs** | Structure comparison |
| **cif.rs** | CIF file parsing |
| **io.rs** | Structure I/O (POSCAR, XYZ, etc.) |
| **xrd.rs** | X-ray diffraction pattern computation |
| **trajectory.rs** | MD trajectory handling |

## WASM Entry Points (wasm.rs)

### Bonding
- `detect_bonds_radii(structure_json, options_json?) -> String` (JSON Bond[])
- `detect_bonds_electronegativity(structure_json, options_json?) -> String` (JSON Bond[])
- `detect_bonds_solid_angle(structure_json, options_json?) -> String` (JSON Bond[])
- `detect_hydrogen_bonds(structure_json, covalent_bonds_json, options_json?) -> String`

### Structure Operations
- `make_supercell(crystal, matrix) -> JsResult` — Full 3x3 matrix supercell
- `make_supercell_diag(crystal, nx, ny, nz) -> JsResult` — Diagonal supercell
- `get_neighbor_list(structure_json, cutoff) -> String`
- `get_distance_matrix(crystal) -> JsResult`

### Symmetry (via moyo)
- `analyze_cell(cell_json, symprec?) -> String` — MoyoDataset

### I/O
- `parse_cif(content) -> String`
- `parse_poscar(content) -> String`
- `structure_to_poscar(structure_json) -> String`

## Bond Algorithm: atom_radii
```
for each pair within max_distance:
  bond if dist < (r1 + r2) * tolerance
  where r1, r2 = covalent radii
```

## Bond Algorithm: electroneg_ratio
```
for each pair within max_distance:
  electroneg_diff = |χ1 - χ2|
  metal_nonmetal bonus for M-X bonds
  strength = f(dist, radii, electroneg_diff)
  bond if strength > threshold (default 0.3)
```

## Bond Algorithm: solid_angle
```
for each pair within max_distance:
  avg_r = (covalent_r1 + covalent_r2) / 2
  face_area = π * avg_r²
  solid_angle = face_area / dist²
  dist_penalty = exp(-((dist/(r1+r2) - 1)² / 0.4))
  strength = min(solid_angle/4π, 1.0) * dist_penalty
  bond if strength > threshold (default 0.05)
```

## Data Flow: TypeScript ↔ Rust

```
TypeScript (PymatgenStructure)
  → pymatgen_to_jscrystal() [ferrox-wasm.ts:77]
    → JsCrystal { lattice: JsLattice, sites: JsSite[] }
  → JSON.stringify → WASM function(json_string)
    → serde deserialize → Rust Crystal
    → computation
    → Rust result → serde serialize → JSON string
  → JSON.parse → TypeScript result
  → jscrystal_to_pymatgen() [ferrox-wasm.ts:163]
    → PymatgenStructure { lattice, sites: [{species, abc, xyz, label, properties}] }
```

## Important Notes

- WASM `make_supercell` does NOT set `orig_unit_cell_idx` on output sites — TypeScript must tag `i % orig_n` after
- `jscrystal_to_pymatgen` sets `properties: site.properties ?? {}` — preserves whatever Rust side puts
- All WASM bonding functions are called from bond-worker-api.ts (Worker or main thread)
- `analyze_cell()` is synchronous and blocks — must be gated behind user action

## Build Pitfalls

- **`--features wasm` is required**: Without it, `#[wasm_bindgen]` functions are not compiled. The build succeeds but the WASM module has no exports
- **`--target web`**: Must use `web` target (not `bundler` or `nodejs`). The `web` target generates ES module exports and `initSync`/`init` functions compatible with Vite
- **Output directory**: `--out-dir ../rust-wasm/pkg` places output in the workspace package. If you forget `--out-dir`, output goes to `extensions/rust/pkg/` which is wrong
- **Vite cache after rebuild**: After `wasm-pack build`, Vite dev server may serve cached old .wasm. Restart dev server to pick up new WASM
- **Svelte proxy issues**: `create_supercell_matrix` in ferrox-wasm.ts uses `JSON.parse(JSON.stringify(jsCrystal))` to deep-copy before sending to WASM. Without this, Svelte 5 Proxy objects cause serialization errors in WASM

## Planned Additions

- `detect_hydrogen_bonds()` — currently pure JS. Needs covalent bonds as input (two-pass algorithm)

## Completed (formerly planned)

- `detect_bonds_solid_angle()` — Rust implementation done (bonding.rs:396), WASM binding (wasm.rs:5032), frontend wired (ferrox-wasm.ts:1087 → bond-worker.ts:51)
