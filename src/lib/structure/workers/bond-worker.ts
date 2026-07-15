// Bond computation Web Worker — runs WASM off the main thread.
//
// Architecture: Main thread compiles the WASM module via WebAssembly.compileStreaming,
// then sends the WebAssembly.Module to this Worker via postMessage (it's structured-
// cloneable). The Worker calls initSync({ module }) from the wasm-bindgen glue code,
// which synchronously instantiates the module without needing to fetch any files.
//
// This approach bypasses Vite/SvelteKit's IIFE worker bundling constraints because:
// - initSync doesn't fetch the WASM binary (no code-splitting needed)
// - All wasm-bindgen glue code is statically imported and bundled inline

import {
  initSync,
  detect_bonds_radii,
  detect_bonds_radii_typed,
  detect_bonds_electronegativity,
  detect_bonds_solid_angle,
  detect_hydrogen_bonds,
} from '@catgo/ferrox-wasm'

let initialized = false

self.onmessage = (e: MessageEvent) => {
  const { id, type } = e.data

  if (type === `init`) {
    try {
      initSync({ module: e.data.module })
      initialized = true
      self.postMessage({ id, type: `ready` })
    } catch (err) {
      self.postMessage({ id, error: (err as Error).message || String(err) })
    }
    return
  }

  if (!initialized) {
    self.postMessage({ id, error: `Worker not initialized` })
    return
  }

  const { structure_json, strategy, options_json, covalent_bonds_json } = e.data

  try {
    if (type === `bonds_typed`) {
      // Typed-array fast path (atom_radii only): Float32Array positions in,
      // flat typed bond table out. Both directions use transfer lists — no
      // JSON, no structured-clone of large payloads.
      const t0 = performance.now()
      const table = detect_bonds_radii_typed(
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
      // Worker-scope postMessage(message, transfer) overload — cast because
      // this file type-checks under the DOM lib where self is a Window.
      ;(self.postMessage as (msg: unknown, transfer: Transferable[]) => void)(
        { id, pairs, images, lengths, strengths, dt },
        [pairs.buffer, images.buffer, lengths.buffer, strengths.buffer],
      )
      return
    }
    if (type === `bonds`) {
      const t0 = performance.now()
      let result: string
      if (strategy === `atom_radii`) {
        result = detect_bonds_radii(structure_json, options_json)
      } else if (strategy === `electroneg_ratio`) {
        result = detect_bonds_electronegativity(structure_json, options_json)
      } else if (strategy === `solid_angle`) {
        result = detect_bonds_solid_angle(structure_json, options_json)
      } else {
        self.postMessage({ id, error: `Unknown strategy: ${strategy}` })
        return
      }
      const dt = (performance.now() - t0).toFixed(1)
      self.postMessage({ id, result, dt })
    } else if (type === `hbonds`) {
      const t0 = performance.now()
      const result = detect_hydrogen_bonds(structure_json, covalent_bonds_json, options_json)
      const dt = (performance.now() - t0).toFixed(1)
      self.postMessage({ id, result, dt })
    }
  } catch (err) {
    self.postMessage({ id, error: (err as Error).message || String(err) })
  }
}
