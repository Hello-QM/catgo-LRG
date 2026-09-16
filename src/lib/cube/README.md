# Browser Cube processing

`CubePanel` owns a `CubeClient`. Parsing and Marching Cubes extraction run in a
persistent scalar ferrox WASM Worker, including browsers without cross-origin
isolation. The parsed grid stays in WASM memory across isovalue changes; a copy
is returned for slice views. Positive and negative surfaces are extracted
sequentially in that worker. Each viewer owns its worker and releases it on
unmount.

If WASM compilation or the Rust Worker fails, the client logs the explicit
TypeScript Worker fallback. Invalid scientific input remains an
error. `dispose()` cancels pending and queued operations. Existing
`extract_isosurface_client` callers remain supported; external mutable grids
are copied before transfer so their buffers stay attached.

## Format

- Coordinates, origin and voxel axes are converted from Bohr to Angstroms.
- Negative `NATOMS` introduces orbital metadata, not different coordinate units.
  One orbital ID is read before the voxel values, including wrapped records.
- Single density and single orbital datasets are supported. `NVAL != 1` and
  multiple orbital datasets are explicitly rejected until dataset selection is
  supported.
- Truncated records, invalid dimensions, non-finite values, Float32 overflow,
  and extra voxel data are rejected. Fortran `D` exponents are accepted.

The browser Rust API reuses `tools/cube-processor` with its CLI and Rayon
features disabled. The existing CLI retains its default features. Rust meshes
use Cartesian face normals, including rotated/skewed voxel axes. The Rust
backend returns the native unsmoothed Marching Cubes surface; the TypeScript
fallback retains its existing two Taubin smoothing iterations, so curved
surfaces need not have identical vertices across backends.

## Verification

Build the generated bindings before running browser or WASM-dependent tests:

```sh
pnpm build:wasm
pnpm verify:wasm
pnpm exec vitest run tests/vitest/cube tests/vitest/trajectory --maxWorkers=2
node --test tests/browser/cube-worker.test.mjs
```

The browser test needs Playwright Chromium (`pnpm exec playwright install chromium`).
It builds real Vite inline Workers and loads the real scalar binary on a local
HTTP origin without COOP/COEP. It checks orbital coordinates/data, repeated dual
isosurfaces, rotated/skewed mesh geometry/normals, and the real TypeScript
fallback after a failed WASM fetch. Worker unit tests separately cover input
errors, buffer ownership, cancellation and independent viewer lifetimes.
