/**
 * Web Worker: expand a logical GPU supercell and serialize it OFF the main
 * thread so exporting a million-atom supercell doesn't freeze the UI.
 *
 * Protocol (main → worker):
 *   { id, base_structure, factors:[nx,ny,nz], format:'poscar'|'xyz'|'extxyz' }
 * Reply (worker → main):
 *   { id, ok:true, text, atom_count } | { id, ok:false, error }
 *
 * The heavy work (N× site replication + string build) is all in the pure
 * `supercell-export-core` module, which has no DOM/WASM deps and runs here.
 */

import {
  type CoreStructure,
  expand_and_serialize,
  expanded_atom_count,
  type SupercellExportFormat,
  type Vec3,
} from './supercell-export-core'

export interface SupercellExportRequest {
  id: number
  base_structure: CoreStructure
  factors: Vec3
  format: SupercellExportFormat
}

export type SupercellExportResponse =
  | { id: number; ok: true; text: string; atom_count: number }
  | { id: number; ok: false; error: string }

self.onmessage = (event: MessageEvent<SupercellExportRequest>) => {
  const { id, base_structure, factors, format } = event.data
  try {
    const atom_count = expanded_atom_count(base_structure, factors)
    const text = expand_and_serialize(base_structure, factors, format)
    const reply: SupercellExportResponse = { id, ok: true, text, atom_count }
    ;(self as unknown as Worker).postMessage(reply)
  } catch (error) {
    const reply: SupercellExportResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
    ;(self as unknown as Worker).postMessage(reply)
  }
}
