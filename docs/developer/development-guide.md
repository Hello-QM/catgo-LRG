# CatGO Development Guide

This guide helps developers (and AI assistants like Claude) understand the architecture decisions for CatGO development.

## Architecture Overview

CatGO uses a hybrid architecture:

- **Frontend**: SvelteKit + Three.js for visualization
- **WASM (Rust)**: High-performance crystallographic computations in the browser
- **Backend (FastAPI)**: Server-side operations, database access, external APIs

---

## When to Use Rust + WASM

Use Rust/WASM for **computationally intensive operations** that:

1. Run frequently in the browser
2. Benefit from parallelization or low-level optimization
3. Don't require network access or database operations

### Implemented WASM Functions

Located in `extensions/rust/src/wasm.rs`:

| Category              | Functions                                                                       | Description                         |
| --------------------- | ------------------------------------------------------------------------------- | ----------------------------------- |
| **Structure Parsing** | `parse_structure`, `parse_cif`, `parse_poscar`                                  | Parse crystallographic file formats |
| **Supercell**         | `make_supercell_diag`, `make_supercell`                                         | Create supercells                   |
| **Neighbor List**     | `get_neighbor_list`, `get_all_neighbors`, `get_distance`, `get_distance_matrix` | PBC-aware distance calculations     |
| **Symmetry**          | `get_spacegroup_number`, `get_primitive_cell`                                   | Symmetry analysis via moyo          |
| **Slab Generation**   | `generate_slab`, `compute_d_spacing`, `miller_to_normal`, `detect_layers`       | Surface/slab cutting                |
| **Ewald Summation**   | `compute_ewald`, `compute_ewald_auto`, `compute_ewald_from_species`             | Electrostatic energy                |
| **Properties**        | `get_volume`, `get_density`, `get_composition`, `get_reduced_formula`           | Structure properties                |
| **Coordinates**       | `get_cart_coords`, `get_frac_coords`, `wrap_to_unit_cell`                       | Coordinate transformations          |

### When to Add New WASM Functions

Add to Rust/WASM when:

- Operation involves matrix math, lattice transformations, or geometry
- Needs to run in real-time (e.g., during user interactions)
- Pure computation with no I/O requirements
- Performance is critical (>10ms on typical hardware)

**Examples of good WASM candidates:**

- Bond detection algorithms
- Coordination number calculation
- Structure interpolation (NEB images)
- Phonon mode visualization
- Charge density isosurface generation

---

## When to Use FastAPI Backend

Use FastAPI for operations that:

1. Require database access
2. Need external API calls (Materials Project, AFLOW, ICSD)
3. Involve authentication/authorization
4. Process large files or datasets
5. Need persistent storage

### Backend Responsibilities

| Category             | Operations                                                       |
| -------------------- | ---------------------------------------------------------------- |
| **Database**         | Store/retrieve structures, user preferences, calculation results |
| **External APIs**    | Query Materials Project, AFLOW, COD, ICSD                        |
| **File Storage**     | Store trajectory files, large datasets                           |
| **Authentication**   | User login, API keys, permissions                                |
| **Batch Processing** | Large-scale structure matching, database deduplication           |
| **ML Inference**     | Run ML models (if GPU required)                                  |

**Examples of backend candidates:**

- Search structures by composition/property
- Store calculation results
- User workspace management
- Integration with VASP/QE job submission
- ML potential inference (if not WASM-compatible)

---

## Rust/WASM Development Guide

### Project Structure

```
extensions/
├── rust/                    # Main Rust crate
│   ├── src/
│   │   ├── lib.rs          # Module exports
│   │   ├── wasm.rs         # WASM bindings (wasm-bindgen)
│   │   ├── structure.rs    # Structure type
│   │   ├── lattice.rs      # Lattice operations
│   │   ├── slab.rs         # Slab generation
│   │   ├── ewald.rs        # Ewald summation
│   │   └── ...
│   ├── Cargo.toml
│   └── pkg/                # wasm-pack output (auto-generated)
│
└── rust-wasm/              # WASM package for npm
    ├── pkg/                # Copied from rust/pkg
    ├── package.json        # ferrox-wasm
    └── test-wasm.mjs       # Node.js test script
```

### Adding a New WASM Function

#### Step 1: Implement in Rust

Add your function in `extensions/rust/src/wasm.rs`:

```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn my_new_function(structure_json: &str, param: f64) -> Result<String, JsError> {
    // Parse input structure
    let structure = parse_structure_json(structure_json)
        .map_err(|e| JsError::new(&format!("Error parsing structure: {e}")))?;

    // Do computation
    let result = compute_something(&structure, param);

    // Return JSON string
    serde_json::to_string(&result)
        .map_err(|e| JsError::new(&format!("Error serializing result: {e}")))
}
```

#### Step 2: Build WASM

```bash
cd extensions/rust
wasm-pack build --target web --features wasm --no-default-features

# Copy to rust-wasm package
cp -r pkg ../rust-wasm/
```

#### Step 3: Add TypeScript Wrapper

Edit `src/lib/structure/ferrox-wasm.ts`:

```typescript
// 1. Add to FerroxWasmModule interface
interface FerroxWasmModule {
  // ... existing functions
  my_new_function: (structure_json: string, param: number) => string
}

// 2. Add typed wrapper function
export async function my_new_function(
  structure: Crystal,
  param: number,
): Promise<WasmResult<MyResultType>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  return wrapWasmCall(() =>
    JSON.parse(mod.my_new_function(json, param) as unknown as string)
  )
}
```

#### Step 4: Add Types (if needed)

Edit `src/lib/structure/ferrox-wasm-types.ts`:

```typescript
export interface MyResultType {
  field1: number
  field2: string[]
}
```

### Build Commands

```bash
# Build WASM (from project root)
cd extensions/rust && wasm-pack build --target web --features wasm --no-default-features

# Copy to rust-wasm
cp -r extensions/rust/pkg extensions/rust-wasm/

# Test with Node.js
cd extensions/rust-wasm && node test-wasm.mjs

# Run Rust tests
cd extensions/rust && cargo test
```

### Desktop Build (Tauri)

For desktop builds, WASM is configured in `vite.desktop.config.ts`:

```bash
# Development
pnpm tauri:dev

# Production build
pnpm tauri:build
```

---

## Naming Conventions

### WASM Functions with TypeScript Conflicts

When a WASM function name conflicts with an existing TypeScript implementation:

- Prefix with `wasm_` (e.g., `wasm_generate_slab`, `wasm_detect_layers`)
- The TypeScript version in `miller-slab.ts` is kept for backwards compatibility
- WASM versions provide better performance

### Type Naming

When types conflict:

- Prefix with `Wasm` (e.g., `WasmGrowthMode`, `WasmAtomLayer`)
- Defined in `ferrox-wasm-types.ts`

---

## Performance Guidelines

### WASM Performance Tips

1. **Minimize JSON serialization**: Structure parsing is expensive
2. **Batch operations**: Combine multiple operations when possible
3. **Use typed arrays**: Prefer `Float64Array` over `number[]` for large data
4. **Lazy initialization**: WASM loads on first use via `ensure_ferrox_wasm_ready()`

### When NOT to Use WASM

- Simple calculations (< 1ms) - overhead exceeds benefit
- Operations requiring DOM access
- Async operations with network requests
- Operations on very small data (< 100 atoms)

---

## Testing

### Rust Tests

```bash
cd extensions/rust
cargo test
```

### WASM Tests (Node.js)

```bash
cd extensions/rust-wasm
node test-wasm.mjs
```

### TypeScript Tests

```bash
pnpm test
```

---

## Troubleshooting

### WASM Build Errors

**Error: `--out-dir` flag is unstable**

```bash
# Build in rust directory, then copy
cd extensions/rust
wasm-pack build --target web --features wasm --no-default-features
cp -r pkg ../rust-wasm/
```

**Error: WASM module not found in browser**

- Ensure `extensions/rust-wasm/pkg/` exists
- Check `vite.config.ts` alias for `ferrox-wasm`

### TypeScript Errors

**Export conflicts**

- Rename WASM functions with `wasm_` prefix
- Rename types with `Wasm` prefix

---

## Related Files

- `extensions/rust/src/wasm.rs` - WASM bindings
- `extensions/rust/src/lib.rs` - Module exports
- `src/lib/structure/ferrox-wasm.ts` - TypeScript wrapper
- `src/lib/structure/ferrox-wasm-types.ts` - Type definitions
- `vite.config.ts` - Web build config
- `vite.desktop.config.ts` - Desktop build config
- `extensions/rust-wasm/test-wasm.mjs` - Node.js tests

---

## Quick Reference for Claude

When user asks to implement a new feature:

1. **Determine location**:
   - Geometry/math/structure operations → Rust/WASM
   - Database/API/auth operations → FastAPI backend
   - UI/visualization → SvelteKit frontend

2. **For WASM development**:
   - Add Rust function in `extensions/rust/src/wasm.rs`
   - Build with `wasm-pack build --target web --features wasm --no-default-features`
   - Copy `pkg/` to `extensions/rust-wasm/`
   - Add TypeScript wrapper in `src/lib/structure/ferrox-wasm.ts`
   - Add types in `src/lib/structure/ferrox-wasm-types.ts`
   - Test with `node test-wasm.mjs`

3. **Avoid naming conflicts**:
   - Check `miller-slab.ts`, `pbc.ts`, `composition/parse.ts` for existing names
   - Use `wasm_` prefix for conflicting function names
   - Use `Wasm` prefix for conflicting type names
