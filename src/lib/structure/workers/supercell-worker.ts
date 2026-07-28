// Supercell staging Web Worker — materializes large TRUE Build-supercell
// transforms off the main thread (trajectory-supercell design §9.4).
//
// Unlike bond-worker this is pure TypeScript math (no WASM), so there is no
// init handshake: messages posted before the script finishes evaluating are
// queued by the browser and processed as soon as `onmessage` is installed.
//
// Protocol (request):  { id, structure, op, max_atoms }
// Protocol (response): { id, structure, provenance }   on success
//                      { id, error }                   on rejection
// The provenance's physical_site_map buffer is passed via transfer list.

import type { PymatgenStructure } from '../index'
import {
  execute_supercell_op_sync,
  type SupercellOp,
} from '../supercell-operation'

self.onmessage = (e: MessageEvent) => {
  const { id, structure, op, max_atoms } = e.data as {
    id: number
    structure: PymatgenStructure
    op: SupercellOp
    max_atoms: number
  }
  try {
    const { structure: result, provenance } = execute_supercell_op_sync(
      structure,
      op,
      max_atoms,
    )
    // Worker-scope postMessage(message, transfer) overload — cast because this
    // file type-checks under the DOM lib where `self` is a Window.
    ;(self.postMessage as (msg: unknown, transfer: Transferable[]) => void)(
      { id, structure: result, provenance },
      [provenance.physical_site_map.buffer],
    )
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
