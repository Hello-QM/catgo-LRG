// Nanoscroll builder API.
//
// Unlike most builders, the nanoscroll has NO backend route: it runs 100%
// client-side in ferrox-wasm (so it works in STATIC_ONLY mode with no Python
// server). This module is therefore a thin, always-wasm wrapper — there is no
// dual server/wasm path to choose between.
//
// A nanoscroll is a 2D monolayer rolled into an Archimedean spiral
// `r(theta) = r0 + b*theta`, scroll axis along z (distinct from a
// constant-radius nanotube).

import type { PymatgenStructure } from '$lib/structure'
import {
  build_nanoscroll as build_nanoscroll_wasm,
  type NanoscrollInfo,
  type NanoscrollParams,
} from '$lib/structure/ferrox-wasm'

export type { NanoscrollInfo, NanoscrollParams }

export interface NanoscrollBuildResult {
  /** The rolled, non-periodic structure. */
  structure: PymatgenStructure
  /** Build metadata (turns, radii, length, supercell, strain warning, …). */
  info: NanoscrollInfo
}

/**
 * Build a nanoscroll by rolling a 2D monolayer into an Archimedean spiral.
 *
 * @param monolayer A single 2D layer (any composition). Rolling a 3D bulk is
 *   meaningless — extract/cut a monolayer first.
 * @param params Optional tunables (turns, inner_radius, length, roll_dir,
 *   interlayer_gap, strain_warn_threshold); all default sensibly.
 * @returns The rolled structure plus metadata.
 * @throws Error if the wasm builder reports a failure (e.g. degenerate
 *   in-plane lattice, zero roll extent).
 */
export async function buildNanoscroll(
  monolayer: PymatgenStructure,
  params: NanoscrollParams = {},
): Promise<NanoscrollBuildResult> {
  const result = await build_nanoscroll_wasm(monolayer, params)
  if (`error` in result) throw new Error(result.error)
  return { structure: result.ok.structure as PymatgenStructure, info: result.ok.info }
}
