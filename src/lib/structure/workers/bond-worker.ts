// Shared bond-worker message loop — runs WASM off the main thread.
//
// This module is side-effect free: the actual Web Worker entry points are
// bond-worker-scalar.ts (pkg/ portable-SIMD artifact) and
// bond-worker-threaded.ts (pkg-threaded/ threads+SIMD+Rayon artifact), which
// each import their wasm-bindgen glue and call `install_bond_worker(self, glue)`.
//
// Architecture: the main thread compiles the artifact's WASM module via
// WebAssembly.compile, then sends the WebAssembly.Module to the Worker via
// postMessage (it's structured-cloneable). The Worker calls initSync({ module })
// from the wasm-bindgen glue, which synchronously instantiates the module
// without needing to fetch any files (the threaded glue creates its own shared
// WebAssembly.Memory). When `thread_count > 1` the threaded glue's
// `initThreadPool` is awaited BEFORE the ready signal, so a Rayon pool failure
// surfaces as an init failure the runtime can retry on the scalar artifact.
//
// This approach bypasses Vite/SvelteKit's IIFE worker bundling constraints:
// - initSync doesn't fetch the WASM binary (no code-splitting needed)
// - All wasm-bindgen glue code is statically imported and bundled inline

/** The wasm-bindgen glue surface both ferrox artifacts share. `initThreadPool`
 *  only exists on the threaded artifact (wasm-bindgen-rayon). */
export interface BondWorkerGlue {
  initSync: (opts: { module: WebAssembly.Module }) => unknown
  initThreadPool?: (num_threads: number) => Promise<unknown>
  detect_bonds_radii: (structure_json: string, options_json?: string) => string
  detect_bonds_radii_typed: (
    positions: Float32Array,
    atomic_numbers: Uint8Array,
    lattice: Float64Array,
    pbc: Uint8Array,
    options_json?: string,
  ) => {
    pairs: Uint32Array
    images: Int8Array
    lengths: Float32Array
    strengths: Float32Array
    free(): void
  }
  detect_bonds_electronegativity: (structure_json: string, options_json?: string) => string
  detect_bonds_solid_angle: (structure_json: string, options_json?: string) => string
  detect_hydrogen_bonds: (
    structure_json: string,
    covalent_bonds_json: string,
    options_json?: string,
  ) => string
}

/** Minimal worker-global surface (typed loosely because this file type-checks
 *  under the DOM lib where `self` is a Window). */
export interface BondWorkerScope {
  onmessage: ((e: MessageEvent) => void) | null
  postMessage: (msg: unknown, transfer?: Transferable[]) => void
}

export function install_bond_worker(scope: BondWorkerScope, glue: BondWorkerGlue): void {
  let initialized = false

  scope.onmessage = async (e: MessageEvent) => {
    const { id, type } = e.data

    if (type === `init`) {
      try {
        glue.initSync({ module: e.data.module })
        const thread_count = typeof e.data.thread_count === `number`
          ? e.data.thread_count
          : 0
        if (thread_count > 1) {
          if (typeof glue.initThreadPool !== `function`) {
            throw new Error(
              `thread pool of ${thread_count} requested but this artifact exports no initThreadPool`,
            )
          }
          await glue.initThreadPool(thread_count)
        }
        initialized = true
        scope.postMessage({ id, type: `ready` })
      } catch (err) {
        scope.postMessage({ id, error: (err as Error).message || String(err) })
      }
      return
    }

    if (!initialized) {
      scope.postMessage({ id, error: `Worker not initialized` })
      return
    }

    const { structure_json, strategy, options_json, covalent_bonds_json } = e.data

    try {
      if (type === `bonds_typed`) {
        // Typed-array fast path (atom_radii only): Float32Array positions in,
        // flat typed bond table out. Both directions use transfer lists — no
        // JSON, no structured-clone of large payloads.
        const t0 = performance.now()
        const table = glue.detect_bonds_radii_typed(
          e.data.positions,
          e.data.atomic_numbers,
          e.data.lattice,
          e.data.pbc,
          options_json ?? undefined,
        )
        const pairs = table.pairs
        const images = table.images
        const lengths = table.lengths
        const strengths = table.strengths
        table.free()
        const dt = (performance.now() - t0).toFixed(1)
        scope.postMessage(
          { id, pairs, images, lengths, strengths, dt },
          [pairs.buffer, images.buffer, lengths.buffer, strengths.buffer],
        )
        return
      }
      if (type === `bonds`) {
        const t0 = performance.now()
        let result: string
        if (strategy === `atom_radii`) {
          result = glue.detect_bonds_radii(structure_json, options_json)
        } else if (strategy === `electroneg_ratio`) {
          result = glue.detect_bonds_electronegativity(structure_json, options_json)
        } else if (strategy === `solid_angle`) {
          result = glue.detect_bonds_solid_angle(structure_json, options_json)
        } else {
          scope.postMessage({ id, error: `Unknown strategy: ${strategy}` })
          return
        }
        const dt = (performance.now() - t0).toFixed(1)
        scope.postMessage({ id, result, dt })
      } else if (type === `hbonds`) {
        const t0 = performance.now()
        const result = glue.detect_hydrogen_bonds(
          structure_json,
          covalent_bonds_json,
          options_json,
        )
        const dt = (performance.now() - t0).toFixed(1)
        scope.postMessage({ id, result, dt })
      }
    } catch (err) {
      scope.postMessage({ id, error: (err as Error).message || String(err) })
    }
  }
}
