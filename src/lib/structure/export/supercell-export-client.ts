/**
 * Main-thread client for the supercell export worker.
 *
 * Spins up `supercell-export.worker.ts`, posts the BASE cell + factors + format,
 * awaits the serialized full supercell, and triggers a Blob download — all
 * without materializing millions of Site objects on the main thread.
 *
 * Used only when the WebGPU large-system overlay is active AND a >1 supercell is
 * requested (the displayed/saveable structure is then the BASE cell). The normal
 * synchronous export path is left untouched for everything else.
 */

import { download } from '$lib/io/fetch'
import {
  type CoreStructure,
  EXPORT_ATOM_CONFIRM_THRESHOLD,
  expanded_atom_count,
  type SupercellExportFormat,
  type Vec3,
} from './supercell-export-core'
import type { SupercellExportRequest, SupercellExportResponse } from './supercell-export.worker'

const FORMAT_EXT: Record<SupercellExportFormat, string> = {
  poscar: `poscar`,
  xyz: `xyz`,
  extxyz: `extxyz`,
}

/**
 * Extract a PLAIN, structured-cloneable `CoreStructure` POJO from `base`.
 *
 * `base` (= the displayed/base cell) is a Svelte 5 `$state` proxy and may carry
 * class instances / functions / reactive wrappers — none of which survive the
 * structured-clone algorithm `worker.postMessage` uses (it throws
 * "could not be cloned"). The worker core (`supercell-export-core`) only ever
 * reads the fields copied below, so we rebuild a fresh object made of plain
 * primitives / arrays / objects only. Built ONCE here, before posting.
 */
function sanitize_base(base: CoreStructure): CoreStructure {
  const sites = base.sites.map((site) => {
    const xyz = site.xyz
    const out: CoreStructure[`sites`][number] = {
      species: (site.species ?? []).map((sp) => ({
        element: sp.element,
        occu: sp.occu,
        oxidation_state: sp.oxidation_state,
      })),
      xyz: [xyz[0], xyz[1], xyz[2]],
    }
    if (site.abc) out.abc = [site.abc[0], site.abc[1], site.abc[2]]
    if (site.label !== undefined) out.label = site.label
    // The core only reads `selective_dynamics` (boolean[]) and `force`
    // (number[]). A defensive JSON round-trip strips any proxy/class wrapping
    // while keeping plain data; `$state.snapshot` is unnecessary here because
    // JSON serialization already unwraps the reactive proxy.
    if (site.properties) {
      out.properties = JSON.parse(JSON.stringify(site.properties)) as Record<string, unknown>
    }
    return out
  })

  const out: CoreStructure = { sites }
  if (base.lattice?.matrix) {
    const m = base.lattice.matrix
    out.lattice = {
      matrix: [
        [m[0][0], m[0][1], m[0][2]],
        [m[1][0], m[1][1], m[1][2]],
        [m[2][0], m[2][1], m[2][2]],
      ],
    }
    if (base.lattice.pbc) {
      out.lattice.pbc = [base.lattice.pbc[0], base.lattice.pbc[1], base.lattice.pbc[2]]
    }
  }
  if (base.charge !== undefined) out.charge = base.charge
  if (base.id !== undefined) out.id = base.id
  if (base.formula !== undefined) out.formula = base.formula
  return out
}

let _worker: Worker | undefined
let _next_id = 1

function get_worker(): Worker {
  if (!_worker) {
    _worker = new Worker(
      new URL(`./supercell-export.worker.ts`, import.meta.url),
      { type: `module` },
    )
  }
  return _worker
}

export interface SupercellExportOptions {
  // Build a download filename from the (expanded) structure. Defaults to a
  // formula/id-based name with the format extension.
  filename?: string
  // Asked when the expanded atom count exceeds EXPORT_ATOM_CONFIRM_THRESHOLD.
  // Return true to proceed. Defaults to window.confirm in the browser.
  confirm?: (atom_count: number) => boolean | Promise<boolean>
  // Optional busy/progress hooks for a lightweight UI indicator.
  on_start?: () => void
  on_done?: (atom_count: number) => void
  on_error?: (error: string) => void
}

function default_confirm(atom_count: number): boolean {
  if (typeof globalThis.confirm !== `function`) return true
  const millions = (atom_count / 1e6).toFixed(1)
  return globalThis.confirm(
    `This supercell expands to ${atom_count.toLocaleString()} atoms (~${millions}M). ` +
      `Serializing it to a file may take a while and use a lot of memory. Continue?`,
  )
}

/**
 * Expand `base` × `factors` in a worker, serialize to `format`, and download.
 * Resolves to the expanded atom count (or null if the user cancelled the
 * over-threshold confirm).
 */
export async function export_supercell_via_worker(
  base: CoreStructure,
  factors: Vec3,
  format: SupercellExportFormat,
  opts: SupercellExportOptions = {},
): Promise<number | null> {
  const atom_count = expanded_atom_count(base, factors)

  if (atom_count > EXPORT_ATOM_CONFIRM_THRESHOLD) {
    const confirm_fn = opts.confirm ?? default_confirm
    const proceed = await confirm_fn(atom_count)
    if (!proceed) return null
  }

  opts.on_start?.()

  const id = _next_id++
  const worker = get_worker()

  try {
    const text = await new Promise<string>((resolve, reject) => {
      const handle_message = (event: MessageEvent<SupercellExportResponse>) => {
        const msg = event.data
        if (msg.id !== id) return // not our reply (worker is shared)
        worker.removeEventListener(`message`, handle_message)
        worker.removeEventListener(`error`, handle_error)
        if (msg.ok) resolve(msg.text)
        else reject(new Error(msg.error))
      }
      const handle_error = (event: ErrorEvent) => {
        worker.removeEventListener(`message`, handle_message)
        worker.removeEventListener(`error`, handle_error)
        reject(new Error(event.message || `Supercell export worker error`))
      }
      worker.addEventListener(`message`, handle_message)
      worker.addEventListener(`error`, handle_error)
      // `base` is a Svelte $state proxy / may hold class instances — not
      // structured-cloneable. Post a plain POJO extracted ONCE (the worker core
      // only reads the fields `sanitize_base` copies). `factors` (number[]) and
      // `format` (string) are already cloneable primitives.
      const req: SupercellExportRequest = {
        id,
        base_structure: sanitize_base(base),
        factors: [factors[0], factors[1], factors[2]],
        format,
      }
      worker.postMessage(req)
    })

    const ext = FORMAT_EXT[format]
    const base_name = opts.filename ??
      `${base.id || base.formula || `structure`}_supercell.${ext}`
    download(new Blob([text], { type: `text/plain` }), base_name, `text/plain`)
    opts.on_done?.(atom_count)
    return atom_count
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    opts.on_error?.(message)
    throw error
  }
}
