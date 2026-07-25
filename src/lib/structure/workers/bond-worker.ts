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

import { position_texture_shape } from '../gpu/position-texture-layout'
import {
  assert_trajectory_bond_frame_length,
  TrajectoryBondFrameLengthError,
} from '../trajectory-bond-session'

interface BondWorkerBondTableGlue {
  pairs: Uint32Array
  images: Int8Array
  lengths: Float32Array
  strengths: Float32Array
  free(): void
}

export interface BondWorkerTrajectorySessionGlue {
  compute_frame(
    positions: Float32Array,
    lattice: Float64Array,
    frame_idx: number,
  ): BondWorkerBondTableGlue
  diagnostics_json(): string
  free(): void
}

/** The wasm-bindgen glue surface both ferrox artifacts share. `initThreadPool`
 *  only exists on the threaded artifact (wasm-bindgen-rayon). */
export interface BondWorkerGlue {
  initSync: (opts: { module: WebAssembly.Module }) => unknown
  initThreadPool?: (num_threads: number) => Promise<unknown>
  create_trajectory_bond_session(
    session_id: number,
    atomic_numbers: Uint8Array,
    pbc: Uint8Array,
    options_json?: string,
  ): BondWorkerTrajectorySessionGlue
  detect_bonds_radii: (structure_json: string, options_json?: string) => string
  detect_bonds_radii_typed: (
    positions: Float32Array,
    atomic_numbers: Uint8Array,
    lattice: Float64Array,
    pbc: Uint8Array,
    options_json?: string,
  ) => BondWorkerBondTableGlue
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

function pack_positions_rgba(positions: Float32Array): Float32Array {
  if (positions.length % 3 !== 0) {
    throw new Error(
      `Trajectory positions length ${positions.length} must be divisible by 3`,
    )
  }
  const atom_count = positions.length / 3
  const shape = position_texture_shape(atom_count)
  const gpu_positions_rgba = new Float32Array(shape.float_count)
  for (let src = 0, dst = 0; src < positions.length; src += 3, dst += 4) {
    gpu_positions_rgba[dst] = positions[src]
    gpu_positions_rgba[dst + 1] = positions[src + 1]
    gpu_positions_rgba[dst + 2] = positions[src + 2]
    gpu_positions_rgba[dst + 3] = 1
  }
  return gpu_positions_rgba
}

function finite_elapsed_ms(started_ms: number, finished_ms: number): number {
  const elapsed_ms = finished_ms - started_ms
  return Number.isFinite(elapsed_ms) && elapsed_ms >= 0 ? elapsed_ms : 0
}

export function install_bond_worker(scope: BondWorkerScope, glue: BondWorkerGlue): void {
  let initialized = false
  let trajectory_session: {
    id: number
    topology_fingerprint: string
    atom_count: number
    rust: BondWorkerTrajectorySessionGlue
  } | null = null
  let trajectory_session_initializations = 0
  let active_thread_count = 1

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
        active_thread_count = Math.max(1, thread_count)
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
      if (type === `trajectory_session_init`) {
        trajectory_session?.rust.free()
        trajectory_session = null
        const rust = glue.create_trajectory_bond_session(
          e.data.session_id,
          e.data.atomic_numbers,
          e.data.pbc,
          e.data.options_json ?? undefined,
        )
        trajectory_session = {
          id: e.data.session_id,
          topology_fingerprint: e.data.topology_fingerprint,
          atom_count: e.data.atomic_numbers.length,
          rust,
        }
        trajectory_session_initializations += 1
        scope.postMessage({ id, type: `trajectory_session_ready` })
        return
      }
      if (type === `trajectory_frame_typed`) {
        if (
          !trajectory_session ||
          trajectory_session.id !== e.data.session_id ||
          trajectory_session.topology_fingerprint !==
            e.data.topology_fingerprint
        ) {
          throw new Error(`Unknown trajectory bond session ${e.data.session_id}`)
        }
        const positions = e.data.positions as Float32Array
        assert_trajectory_bond_frame_length(
          trajectory_session.id,
          trajectory_session.atom_count,
          positions.length,
          e.data.frame_idx,
        )
        const worker_started_ms = performance.now()
        const table = trajectory_session.rust.compute_frame(
          positions,
          e.data.lattice,
          e.data.frame_idx,
        )
        const wasm_finished_ms = performance.now()
        const gpu_positions_rgba = pack_positions_rgba(positions)
        const position_pack_finished_ms = performance.now()
        const pairs = table.pairs
        const images = table.images
        const lengths = table.lengths
        const strengths = table.strengths
        table.free()
        const table_copy_finished_ms = performance.now()
        const session_diagnostics = {
          ...JSON.parse(trajectory_session.rust.diagnostics_json()),
          session_initializations: trajectory_session_initializations,
          thread_count: active_thread_count,
        }
        const worker_finished_ms = performance.now()
        const worker_timings = {
          wasm_compute_ms: finite_elapsed_ms(
            worker_started_ms,
            wasm_finished_ms,
          ),
          position_pack_ms: finite_elapsed_ms(
            wasm_finished_ms,
            position_pack_finished_ms,
          ),
          table_copy_ms: finite_elapsed_ms(
            position_pack_finished_ms,
            table_copy_finished_ms,
          ),
          worker_total_ms: finite_elapsed_ms(
            worker_started_ms,
            worker_finished_ms,
          ),
        }
        const dt = worker_timings.worker_total_ms.toFixed(1)
        scope.postMessage(
          {
            id,
            pairs,
            images,
            lengths,
            strengths,
            gpu_positions_rgba,
            session_diagnostics,
            worker_timings,
            dt,
          },
          [
            pairs.buffer,
            images.buffer,
            lengths.buffer,
            strengths.buffer,
            gpu_positions_rgba.buffer,
          ],
        )
        return
      }
      if (type === `trajectory_positions_rgba`) {
        const gpu_positions_rgba = pack_positions_rgba(e.data.positions)
        scope.postMessage(
          { id, gpu_positions_rgba },
          [gpu_positions_rgba.buffer],
        )
        return
      }
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
      if (
        err instanceof TrajectoryBondFrameLengthError ||
        (
          typeof err === `object` &&
          err !== null &&
          `name` in err &&
          err.name === `TrajectoryBondFrameLengthError`
        )
      ) {
        const typed = err as TrajectoryBondFrameLengthError
        scope.postMessage({
          id,
          error: typed.message,
          error_name: typed.name,
          session_id: typed.session_id,
          expected_atom_count: typed.expected_atom_count,
          expected_float_count: typed.expected_float_count,
          actual_float_count: typed.actual_float_count,
          frame_idx: typed.frame_idx,
        })
      } else {
        scope.postMessage({ id, error: (err as Error).message || String(err) })
      }
    }
  }
}
