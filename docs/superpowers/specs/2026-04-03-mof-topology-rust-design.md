# MOF Topology Analysis — Rust/WASM Port of CrystalNets Phase 1

## Summary

Port CrystalNets.jl's SBU/Linker detection algorithm to Rust, compile to WASM, integrate into CatGo's frontend for automatic MOF decomposition and visualization.

## Goal

Given a MOF crystal structure, automatically identify:
- **Inorganic SBUs** (metal clusters + bridging oxygens)
- **Organic linkers** (connecting ligands)
- **Points of extension** (atoms bridging SBUs and linkers)

Output is used for polyhedra auto-coloring, Node Isolator, and future topology naming.

## Algorithm (from CrystalNets.jl clustering.jl)

### Input
- Crystal structure (lattice + sites with element types + xyz)
- Bond list with periodic image offsets (from existing `bonding.rs`)

### Pipeline

**Phase 1 — Element Classification**
Classify every atom into one of 5 categories:
- Class 1: Metals (transition metals, lanthanides, actinides) → **Inorganic**
- Class 2: Carbon → **Organic framework**
- Class 3: P, S → **Temporary** (reclassify based on neighbors)
- Class 4: Nonmetals (H, N, O, F, Cl...), metalloids, halogens → **Temporary**
- Class 5: Noble gases → **Ignored**

**Phase 2 — Temporary Class Reclassification**
For each temporary atom (Class 3, 4):
- Find connected components of same-class atoms
- Examine neighbors: if bonded to inorganic → assign inorganic; if bonded to organic → assign organic
- Special: P bonded to organic → mark as organic-P (`:Pc`); S bonded to organic → `:Ss`

**Phase 3 — Connected Component Grouping (BFS)**
- Group atoms of the same class connected by bonds into SBUs
- Track periodic offsets during BFS
- Mark SBUs as periodic if an atom appears at two different offsets within the same SBU

**Phase 4 — Paddle-Wheel Detection**
Recognize paddle-wheel patterns (common in MOFs like HKUST-1):
- SBU has 4-6 atoms, exactly 1 metal, no carbons
- Two such SBUs connected through carboxylate bridges (C atoms)
- Merge paired paddle-wheels into single SBU, add metal-metal bond

**Phase 5 — Periodic SBU Resolution**
Iteratively resolve SBUs that span cell boundaries:
- Single-element periodic SBUs: split at highest-degree atoms
- Multi-element periodic SBUs: separate by element type
- Repeat until no periodic SBUs remain

**Phase 6 — Points of Extension**
- Organic atoms bonded only to inorganic SBUs → mark as PointOfExtension
- These define the connection points between SBUs and linkers

### Output

```rust
struct MofClusters {
    sbus: Vec<Sbu>,
    attributions: Vec<usize>,     // atom_index → sbu_index
}

struct Sbu {
    atom_indices: Vec<usize>,
    sbu_type: SbuType,            // Inorganic | Organic | PointOfExtension
    is_periodic: bool,
}
```

## Rust Module Structure

All new code under `extensions/rust/src/mof/`:

| File | Responsibility | Est. Lines |
|------|---------------|------------|
| `mod.rs` | Module entry, public types (`MofClusters`, `Sbu`, `SbuType`) | ~50 |
| `periodic_graph.rs` | `PeriodicGraph` struct with adjacency lists + periodic offsets | ~150 |
| `classify.rs` | Element → class mapping, temporary class reclassification | ~200 |
| `clustering.rs` | BFS connected components, SBU grouping, periodic SBU resolution | ~400 |
| `paddlewheel.rs` | Paddle-wheel candidate detection and merging | ~250 |

**Total: ~1050 lines of Rust**

## Dependencies (all already in Cargo.toml or std)

- `serde` / `serde_json` — serialization (already used)
- `nalgebra` — vector math (already used)
- No new crate dependencies needed

## WASM Interface

Add to `extensions/rust/src/wasm.rs`:

```rust
#[wasm_bindgen]
pub fn detect_mof_sbus(structure_json: &str, bonds_json: &str) -> String
```

- Input: structure JSON + bonds JSON (with `image` offsets)
- Output: JSON `MofClusters`
- Frontend calls this after bond detection, uses result for visualization

## Frontend Integration (later, not this spec)

After WASM function is available:
1. Call `detect_mof_sbus()` after bond computation
2. Store `MofClusters` in StructureScene state
3. Use `sbu_type` to auto-assign polyhedra rendering to inorganic SBUs
4. Use `attributions` for Node Isolator (click atom → highlight its SBU + connected linkers)
5. Use `sbu_type` for per-SBU coloring

## Test Structures

Validate against CrystalNets.jl results on:
- **MOF-5** (Zn4O + BDC linker) — simple, well-known
- **HKUST-1** (Cu paddle-wheel + BTC) — tests paddle-wheel detection
- **UiO-66** (Zr6O4(OH)4 + BDC) — large inorganic SBU
- **ZIF-8** (Zn + methylimidazolate) — different coordination chemistry

## Out of Scope (Phase 2+)

- Topology genome computation (Systre algorithm)
- Topology database lookup (RCSR naming)
- Interpenetrating network detection
- Multiple clustering modes (SingleNodes, AllNodes, PE, PEM)
- Organic cycle detection (aromatic ring grouping)
- Frontend Node Isolator UI
- Sphere clipping feature
