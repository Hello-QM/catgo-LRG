// Durable, module-level stashes for CatBot's conversational heterostructure flow.
//
// Building a heterostructure is a multi-step workflow that spans several tool
// calls: `set_film` marks the current viewer structure as the FILM, then
// `heterostructure_search` finds candidate lattice-matched interfaces, then
// `build_heterostructure` picks one and builds it. The intermediate state
// (the film structure, and the list of candidate matches) must survive between
// those tool calls — but it should NOT be threaded through the LLM (transform
// matrices are large and error-prone for a model to copy).
//
// These stashes mirror `current-structure.svelte.ts`: module-level Svelte 5
// `$state` so the values persist for the whole session, independent of which
// pane is visible.

import type { AnyStructure } from '$lib'
import type { HeterostructureMatch, LateralMatch } from '$lib/api/heterostructure'

const _state = $state<{
  film: AnyStructure | null
  matches: HeterostructureMatch[]
  lateral_matches: LateralMatch[]
  bulk: AnyStructure | null
}>({ film: null, matches: [], lateral_matches: [], bulk: null })

/** Stash the FILM structure for the next heterostructure search/build. */
export function set_film_stash(s: AnyStructure): void {
  _state.film = s
}

/** The stashed FILM structure, or null if `set_film` was never called. */
export function get_film_stash(): AnyStructure | null {
  return _state.film
}

/** Stash the candidate matches from the most recent heterostructure search. */
export function set_hetero_matches(m: HeterostructureMatch[]): void {
  _state.matches = m
}

/** The candidate matches from the most recent search (empty if none yet). */
export function get_hetero_matches(): HeterostructureMatch[] {
  return _state.matches
}

/** Stash the candidate matches from the most recent LATERAL (in-plane) search. */
export function set_lateral_matches(m: LateralMatch[]): void {
  _state.lateral_matches = m
}

/** The candidate LATERAL matches from the most recent search (empty if none yet). */
export function get_lateral_matches(): LateralMatch[] {
  return _state.lateral_matches
}

/** Stash the BULK reference crystal for surface passivation (pseudo-hydrogen).
 *  Used to compute reference coordination numbers when capping a slab. */
export function set_bulk_stash(s: AnyStructure | null): void {
  _state.bulk = s
}

/** The stashed BULK reference, or null if `set_bulk_reference` was never called. */
export function get_bulk_stash(): AnyStructure | null {
  return _state.bulk
}
