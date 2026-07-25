# Fast Bond Backends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WebGPU the primary large-system bond detector, prevent quadratic GPU work and silent truncation, and provide a genuinely multi-threaded Rust-WASM fallback with a scalar compatibility tier.

**Architecture:** A pure dispatch policy chooses WebGPU grid compute, threaded WASM, scalar WASM, or an explicit disabled state. WebGPU publishes only complete candidate graphs after overflow validation. The Rust fallback ships separate threaded and scalar artifacts behind one typed-array API; large systems never fall back to main-thread JavaScript.

**Tech Stack:** TypeScript, Svelte 5, WebGPU/WGSL, Rust, wasm-bindgen, wasm-bindgen-rayon, Web Workers, Vitest, Playwright.

## Global Constraints

- Preserve the last complete graph and scene on every compute or device failure.
- A visual replica-factor change must not invalidate the base bond graph.
- N ≥ 4096 must never execute main-thread JavaScript bond detection.
- All typed outputs are deterministic: pairs, jimages, lengths, and strengths have identical ordering across scalar and threaded builds.
- Do not start or stop the shared `:8000` backend.

---

## Task 1: Add a pure bond backend and dispatch policy

**Files:**

- Create: `src/lib/structure/workers/bond-backend-policy.ts`
- Create: `src/lib/structure/workers/wasm-thread-capability.ts`
- Modify: `src/lib/structure/gpu/bond-grid.ts`
- Test: `tests/vitest/structure/workers/bond-backend-policy.test.ts`
- Test: `tests/vitest/structure/gpu/bond-grid.test.ts`

**Interfaces produced:**

```ts
export type BondBackendKind =
  | 'webgpu-grid'
  | 'rust-wasm-threads'
  | 'rust-wasm-scalar'
  | 'disabled'

export type BondDispatchPlan =
  | { kind: 'direct'; reason: 'small-n' }
  | { kind: 'gpu-grid'; grid: GridPlan }
  | { kind: 'rust-wasm'; reason: 'periodic-thin-cell' | 'grid-storage-limit' }

export interface BondBackendCapabilities {
  cross_origin_isolated: boolean
  shared_array_buffer: boolean
  wasm_atomics: boolean
  hardware_concurrency: number
}

export function plan_bond_dispatch(input: GridInput & {
  atom_count: number
  direct_limit: number
  max_storage_bytes: number
}): BondDispatchPlan

export function select_rust_bond_backend(
  caps: BondBackendCapabilities,
  atom_count: number,
): { kind: 'rust-wasm-threads' | 'rust-wasm-scalar'; thread_count: number; reason: string }
```

- [ ] Write failing tests named `routes periodic grid dimensions 1 and 2 to rust wasm`, `never selects all-pairs for 19_968 atoms`, `selects threads only with coi sab atomics and two cores`, and `leaves one ui core and caps the pool at eight`.
- [ ] Run `pnpm exec vitest run tests/vitest/structure/workers/bond-backend-policy.test.ts tests/vitest/structure/gpu/bond-grid.test.ts --reporter=verbose`; verify missing policy exports and the old thin-cell `use_grid=false` behavior fail.
- [ ] Implement the pure policy. Direct all-pairs is allowed only when `atom_count <= 1024`; large periodic dimensions 1 or 2 route to Rust rather than WGSL all-pairs.
- [ ] Re-run the targeted tests and verify all pass.
- [ ] Commit with `test(bonds): define backend dispatch policy`.

## Task 2: Remove large-N all-pairs WGSL and add lossless overflow publication

**Files:**

- Modify: `src/lib/structure/gpu/bond-compute.wgsl.ts`
- Modify: `src/lib/structure/gpu/bond-compute.ts`
- Modify: `src/lib/structure/gpu/large-system-renderer.ts`
- Create: `src/lib/structure/gpu/bond-diagnostics.ts`
- Modify: `tests/vitest/structure/gpu/bond-compute.wgsl.test.ts`
- Modify: `tests/vitest/structure/gpu/bond-compute.test.ts`
- Create: `tests/vitest/structure/gpu/bond-overflow.test.ts`
- Modify: `tests/vitest/structure/gpu/large-system-renderer.test.ts`

**Interfaces produced:**

```ts
export type BondDirtyKind = 'graph' | 'replica' | 'visual'

export interface BondGpuDiagnostics {
  graph_version: number
  dispatches: { clear: number; bin: number; detect: number }
  grid: { dims: [number, number, number]; cell_stride: number; max_observed_occupancy: number }
  pairs: { raw: number; capacity: number }
  overflow: { cells: boolean; pairs: boolean; retries: number }
  timing_ms?: { clear: number; bin: number; detect: number; draw: number }
}
```

- [ ] Add failing tests named `large-n shader path contains no all-pairs loop`, `retries cell overflow without publishing the candidate graph`, `grows pair capacity and publishes the complete rerun`, `reports allocation-limit instead of clamping`, and `supercell changes only replica state`.
- [ ] Run `pnpm exec vitest run tests/vitest/structure/gpu/bond-compute.wgsl.test.ts tests/vitest/structure/gpu/bond-overflow.test.ts tests/vitest/structure/gpu/large-system-renderer.test.ts --reporter=verbose`; verify the old shader loop, ignored cell overflow, pair clamp, and `set_supercell()` dirty flag fail.
- [ ] Make `cell_stride` a uniform, record maximum occupancy/raw pair count/overflow flags, and keep active and candidate graph buffers separate.
- [ ] On cell overflow, grow stride to `nextPow2(max_observed_occupancy)` and rerun. On pair overflow, grow capacity to `nextPow2(raw_count)` and rerun. Publish only the complete candidate; report an allocation-limit error without replacing the active graph.
- [ ] Split invalidation: positions/lattice/topology/rules/options are `graph`; supercell/image policy is `replica`; camera/background/selection/hover is `visual`.
- [ ] Remove `bonds_dirty = true` from replica-only updates and expose `debug_bond_state()`.
- [ ] Re-run the targeted tests and verify all pass.
- [ ] Commit with `fix(webgpu): prevent incomplete bond graphs`.

## Task 3: Ship scalar and threaded ferrox WASM artifacts

**Files:**

- Modify: `extensions/rust/Cargo.toml`
- Modify: `extensions/rust/.cargo/config.toml`
- Modify: `extensions/rust-wasm/package.json`
- Modify: `scripts/build-wasm.mjs`
- Create: `scripts/verify-wasm-artifacts.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/tauri-build.yml`

**Interfaces produced:**

```toml
wasm-scalar = ["wasm"]
wasm-threaded = ["wasm", "rayon", "dep:wasm-bindgen-rayon"]
```

Artifacts:

```text
extensions/rust-wasm/pkg-scalar/
extensions/rust-wasm/pkg-threaded/
```

- [ ] Add verifier assertions that both JS/WASM/d.ts sets exist, threaded glue exports `initThreadPool`, and scalar glue does not.
- [ ] Run `node scripts/verify-wasm-artifacts.mjs`; verify it fails because the dual artifacts do not exist.
- [ ] Add pinned optional `wasm-bindgen-rayon = 1.3.0`, features `wasm-scalar` and `wasm-threaded`, and explicit scalar/threaded build targets. Threaded flags must include atomics, bulk-memory, and SIMD; scalar must retain portable SIMD.
- [ ] Make both CI workflows call only root `pnpm build:wasm`; remove direct builds that could accidentally enable default Rayon without thread initialization.
- [ ] Run `pnpm build:wasm` and `node scripts/verify-wasm-artifacts.mjs`; verify both succeed.
- [ ] Commit with `build(wasm): ship scalar and threaded ferrox`.

## Task 4: Make Rust bond collection deterministic under Rayon

**Files:**

- Modify: `extensions/rust/src/bonding.rs`
- Modify: `extensions/rust/src/wasm.rs`
- Test: existing Rust test modules in those files

**Interface consumed:** Existing `detect_bonds_atom_radii(...) -> Result<Vec<Bond>, BondError>`.

**Internal seam produced:**

```rust
fn evaluate_bond_center_range(
    input: &BondEvalInput<'_>,
    centers: Range<usize>,
) -> Vec<Bond>
```

- [ ] Add failing tests `typed_bonds_scalar_and_rayon_are_byte_identical`, `rayon_bond_order_is_stable_across_runs`, and `thin_cell_self_images_are_preserved`.
- [ ] Run `cargo test --manifest-path extensions/rust/Cargo.toml --no-default-features --features rayon typed_bonds_scalar_and_rayon_are_byte_identical`; verify the new test fails or does not compile.
- [ ] Split center indices into deterministic contiguous ranges, evaluate them in Rayon, collect ordered chunks, and flatten in center-range order. Re-export `wasm_bindgen_rayon::init_thread_pool` only for `wasm-threaded`.
- [ ] Run both scalar and Rayon test configurations and compare normalized typed bytes.
- [ ] Commit with `perf(rust): parallelize deterministic bond detection`.

## Task 5: Orchestrate threaded/scalar workers and forbid large JS fallback

**Files:**

- Create: `src/lib/structure/workers/bond-worker-runtime.ts`
- Create: `src/lib/structure/workers/bond-worker-scalar.ts`
- Create: `src/lib/structure/workers/bond-worker-threaded.ts`
- Modify: `src/lib/structure/workers/bond-worker.ts`
- Modify: `src/lib/structure/workers/bond-worker-api.ts`
- Modify: `src/lib/structure/ferrox-wasm.ts`
- Test: `tests/vitest/structure/workers/bond-worker-selection.test.ts`

**Interface produced:**

```ts
export async function compute_bonds_typed(input: TypedBondInput): Promise<{
  backend: BondBackendKind
  table: TypedBondTable
  elapsed_ms: number
}>
```

- [ ] Add failing tests `falls back from threaded init to scalar exactly once`, `disables large-system bonds when both rust workers fail`, and `never invokes main-thread javascript for large systems`.
- [ ] Run `pnpm exec vitest run tests/vitest/structure/workers/bond-worker-selection.test.ts --reporter=verbose`; verify current single-worker/main-thread fallback behavior fails.
- [ ] Probe COI, SharedArrayBuffer, WASM atomics, cores, and N. Initialize the Rayon pool with `clamp(hardwareConcurrency - 1, 2, 8)`. Retry scalar once after threaded failure.
- [ ] For N ≥ 4096, throw `BondBackendUnavailableError` when both workers fail; do not call synchronous WASM or JavaScript. Keep small-system compatibility behavior unchanged.
- [ ] Re-run the targeted tests and verify all pass.
- [ ] Commit with `perf(bonds): add threaded wasm fallback`.

## Task 6: Handle WebGPU routing and device loss transactionally

**Files:**

- Modify: `src/lib/structure/gpu/webgpu-context.ts`
- Modify: `src/lib/structure/gpu/large-system-renderer.ts`
- Modify: `src/lib/structure/gpu/LargeSystemOverlay.svelte`
- Modify: `src/lib/structure/Structure.svelte`
- Modify: `tests/vitest/structure/gpu/webgpu-context.test.ts`
- Modify: `tests/vitest/structure/gpu/large-system-renderer.test.ts`

**Interfaces produced:**

```ts
export interface WebGpuLease { device: GPUDevice; generation: number; lost: Promise<GPUDeviceLostInfo> }
export async function get_webgpu_lease(): Promise<WebGpuLease | null>
export function invalidate_webgpu_lease(generation: number): void
```

- [ ] Write failing tests `invalidates only the lost device generation`, `submits no commands after device loss`, `notifies fallback exactly once`, and `retains the last valid graph owner during fallback`.
- [ ] Run the WebGPU context/renderer tests and verify failure.
- [ ] Listen to `device.lost` once, stop submissions, retain the packet/graph owner, and build the WebGL2+WASM candidate before atomically swapping renderer visibility.
- [ ] Route Task 1 `rust-wasm` dispatches through `compute_bonds_typed()` and upload the returned typed graph without changing the owner.
- [ ] Re-run tests and commit with `fix(render): retain scene across webgpu fallback`.

## Task 7: Benchmark and exact trajectory backend acceptance

**Files:**

- Modify: `extensions/rust-wasm/bench-bonds.mjs`
- Create: `src/lib/structure/render-backend-policy.ts`
- Create: `tests/e2e/dump-traj-bond-backends.spec.ts`
- Modify: `playwright.config.ts`

- [ ] Add forced URL policies `?catgo_renderer=webgpu` and `?catgo_renderer=webgl2-wasm` plus read-only diagnostics.
- [ ] Benchmark the existing 27³ = 19,683 fixture with two warmups and seven samples. Assert scalar/threaded normalized bytes match; on an isolated ≥4-core host, assert threaded median ≤ 0.75 × scalar median.
- [ ] Add gated real-file browser checks using `DUMP_TRAJ`; verify 100 frames, N=19,968, seek 5→99→5, play/pause/scrub, factor 1/2/8, stable graph dispatch/buffer capacities, one visible canvas, and no stale/OOB/context-loss console errors.
- [ ] Run `pnpm --dir extensions/rust-wasm bench` and `DUMP_TRAJ=/home/james0001/Downloads/dump.traj pnpm exec playwright test tests/e2e/dump-traj-bond-backends.spec.ts --workers=1`.
- [ ] Commit with `test(bonds): cover real trajectory backends`.

