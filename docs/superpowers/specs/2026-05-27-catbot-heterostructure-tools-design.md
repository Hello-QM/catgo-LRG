# CatBot Conversational Heterostructure Tools — Design

**Date:** 2026-05-27
**Depends on:** PR #144 (client-side builders, merged) + PR #145 (client-direct CatBot, open) — this work stacks **after** #145.
**Status:** Approved design, pending implementation plan

## Goal

Let the in-browser CatBot agent (client-direct, STATIC_ONLY, no Python backend) **build heterostructures conversationally** — gather two structures, search lattice-matched interfaces, pick one, build, and load into the viewer — wrapping PR #144's `api/heterostructure.ts` WASM path.

Heterostructure is a multi-step workflow (two structures, per-side Miller + thickness, area/strain match tolerances yielding a *list of candidate matches*, interface gap, vacuum, twist, optional xy-shift scan). The user chose **full conversational build** (not GUI hand-off), with the second structure supplied via a **stash** mechanism.

## Decisions (locked in brainstorming)
- **Conversational build** — CatBot runs search → pick → build → load via tools; the LLM fills params from natural language.
- **Film via stash** — a `set_film` tool stores the current viewer structure as the film; the substrate is the current structure at build time.
- **Match selection** — `heterostructure_search` stashes the candidate matches and returns a readable summary; `build_heterostructure` takes a `match_index` (default 0 = lowest strain) — transform matrices are never threaded through the LLM.
- **Manual slab cutting** is NOT a heterostructure feature — it's the existing `generate_slab` tool: cut → `set_film` → cut substrate → build. `build_heterostructure` documents that an already-cut slab can be used as-is.
- **grid_scan is Phase 2** — ship search/build first.

## Architecture

Two module-level stashes in a new `src/lib/chat/hetero-stash.svelte.ts` (mirrors `current-structure.svelte.ts`):
- `film` — the stashed PymatgenStructure (set by `set_film`).
- `last_matches` — the `HeterostructureMatch[]` from the most recent `heterostructure_search` (so `build` can resolve `match_index` → transforms without the LLM passing matrices).

Tools registered in `structure-tools.ts` (same registry as the other client-direct tools). All call `api/heterostructure.ts` functions, which already route to WASM under STATIC_ONLY.

```
set_film (current viewer structure → stash.film)
   │
heterostructure_search(substrate=current, film=stash.film, miller/tol params)
   │  → searchHeterostructureMatches() → stash.last_matches; return summary list
   │
build_heterostructure(match_index, gap, vacuum, twist, swap)
   │  → look up stash.last_matches[match_index] transforms
   │  → buildHeterostructureManual(substrate, film, sub_transform, film_transform, gap, vacuum, twist, xy_shift)
   │  → set_current_structure(result.structure)   (viewer reverse-syncs — PR #145)
```

## Tools

### 1. `set_film` (utility, kind `read`)
- Input: none.
- Stores `get_current_structure()` into `stash.film`. Errors if no current structure.
- Returns `{ film_formula, film_num_sites }`.
- Description tells the model: "Mark the currently-loaded structure as the FILM for a heterostructure. Then load/fetch the substrate and call heterostructure_search."

### 2. `heterostructure_search` (kind `read`)
- Inputs (all optional with defaults): `substrate_miller` ([h,k,l], default [0,0,1]), `film_miller` ([h,k,l], default [0,0,1]), `max_area` (default 400), `max_strain_pct` (→ `max_area_ratio_tol`/tolerances; default ~5), `max_results` (default 10).
- Requires `stash.film` set (else error: "call set_film first") and a current structure (substrate).
- Calls `searchHeterostructureMatches(substrate, film, params)`; stores `result.matches` in `stash.last_matches`; returns a compact list: `[{ index, strain, match_area, n_atoms_substrate, n_atoms_film, film_miller, substrate_miller }]` (index = position in matches, default-sorted by strain).
- Returns `{ n_matches, matches: [...summary] }`.

### 3. `build_heterostructure` (kind `mutate`)
- Inputs: `match_index` (integer, default 0), `gap` (Å, default 2.0), `vacuum` (Å, default 20.0), `twist_angle` (deg, default 0), `swap` (bool, default false — swap which structure is substrate vs film), `xy_shift` ([a_frac, b_frac], default [0,0]).
- Requires `stash.last_matches` non-empty (else error: "run heterostructure_search first"). Looks up `m = stash.last_matches[match_index]`.
- substrate = current structure, film = `stash.film` (swapped if `swap`).
- Calls `buildHeterostructureManual(substrate, film, m.substrate_transformation, m.film_transformation, gap, vacuum, twist_angle, xy_shift)`.
- `set_current_structure(result.structure)` → viewer loads it (PR #145 reverse-sync).
- Returns `{ num_sites, strain, match_area, formula }`.
- **Thickness note (resolve in plan):** `buildHeterostructureManual` takes transforms + gap/vacuum/twist/xy_shift but NOT explicit thickness, whereas `HeterostructureBuildParams` (used by the auto `buildHeterostructure`) has `substrate_thickness`/`film_thickness`. The plan must read both `buildHeterostructureManual` and `buildHeterostructure` (heterostructure.ts:118 and :201) and decide: either (a) use `buildHeterostructureManual` (manual transforms, thickness implicit/default — matches the stash-match flow), or (b) add thickness by routing through `buildHeterostructure` with the chosen match. Prefer (a) for the match-index flow; expose `substrate_thickness`/`film_thickness` only if (a) supports them. Do NOT invent a thickness arg that the chosen build fn ignores.

### 4. `grid_scan_heterostructure` (kind `read`) — **Phase 2, deferred**
Wrap `gridScanHeterostructure` (heterostructure.ts:588) — scan an N×N xy-shift grid (or symmetry-irreducible wedge), return per-shift metrics so the user picks a shift, then `build_heterostructure` with that `xy_shift`. Out of scope for the first PR.

## Requirement → param mapping (the user's enumerated options)
| User requirement | Mechanism |
|---|---|
| which on top / bottom | `swap` on build (default film-on-top) |
| cut each how thick | `substrate_thickness`/`film_thickness` IF the chosen build fn supports it (see thickness note); else slabs use default cut |
| cut yourself / push to viewer | use existing `generate_slab` tool first, then `set_film`/build — not a hetero param |
| layer distance | `gap` |
| vacuum | `vacuum` |
| twist | `twist_angle` |
| translate to scan combinations | `grid_scan_heterostructure` (Phase 2) → feeds `xy_shift` |
| how to translate | grid params (Phase 2) / explicit `xy_shift` on build |
| which candidate match | `heterostructure_search` list + `match_index` on build |

## Error handling
- `set_film` with no current structure → error.
- `heterostructure_search` with no `stash.film` → error pointing to `set_film`.
- `build_heterostructure` with empty `stash.last_matches` or out-of-range `match_index` → error pointing to `heterostructure_search`.
- Underlying API throw (no commensurate match, WASM failure) → propagates as `{error}` via `execute_tool`.
- `twist_angle` may be unsupported on the WASM path (heterostructure.ts notes it) — if so, document that twist requires the backend; default 0 works client-side.

## Testing
- `hetero-stash` unit: set/get film + matches round-trip.
- Tool kind assertions: `set_film`/`heterostructure_search` = read, `build_heterostructure` = mutate.
- `heterostructure_search` executor (vitest): mock `searchHeterostructureMatches` → assert matches stashed + summary shape.
- `build_heterostructure` executor: stash a fake match, mock `buildHeterostructureManual` → assert it's called with the stashed transforms + `set_current_structure` receives the result. (Full WASM not run in node — mock the api fn, matching how other builder tools are kind-only/mocked.)
- Run via `rtk proxy pnpm exec vitest`.

## Scope / delivery
- Files: `src/lib/chat/hetero-stash.svelte.ts` (new), `src/lib/chat/structure-tools.ts` (+3 tools), `src/lib/chat/__tests__/structure-tools.test.ts` (+tests), maybe a `hetero-stash.test.ts`.
- **Own branch + PR**, stacked after #145 (per PR-separation preference). Do not bundle into #145.
- Phase 2 (`grid_scan_heterostructure`) is a follow-up.

## Engineering constraints
- Branch off #145's head (so the builder API + client-direct loop are present); never work on main.
- Worktree dev-server caveat: stale-serve after edits → kill all worktree vite + `rm -rf node_modules/.vite` + relaunch `VITE_STATIC_ONLY=true PORT=3210 pnpm desktop:dev --force` + browser hard-refresh before verifying.
