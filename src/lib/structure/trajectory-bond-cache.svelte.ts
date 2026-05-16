/**
 * Per-frame bond connectivity cache for trajectory playback.
 *
 * Strategy:
 *  - Frame N requested → if cached, return immediately (`version` doesn't bump).
 *  - Cache miss → kick off async worker compute; consumer sees null until ready,
 *    falls back to whatever connectivity it has (typically static frame-0).
 *  - On every visited frame, also prefetch ±5 neighbours during idle time.
 *  - During fast scrubbing (frame change interval < 100 ms) only enqueue
 *    "keyframes" (idx % 10 == 0) to keep the worker queue short. When the
 *    user releases the scrubber, a fill timer schedules the last-seen idx.
 *
 * Storage: Map<frame_idx, BondConnectivity[]>. Entries are small (a few KB
 * per frame), and trajectories rarely exceed a few hundred frames in
 * practice — full cache is bounded.
 */

import type { AnyStructure } from '$lib'
import type { BondingStrategy } from '$lib/structure/bonding'
import { untrack } from 'svelte'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { compute_bonds_async } from './workers/bond-worker-api'

export type BondConnectivity = {
  site_idx_1: number
  site_idx_2: number
  strength: number
  jimage: [number, number, number]
}

export interface FrameComputeRequest {
  /** Caller-provided base structure (sites + lattice). Positions overridden by `positions`. */
  structure: AnyStructure
  /** Float32Array of length 3*N with per-site xyz for this frame. */
  positions: Float32Array
  strategy: BondingStrategy
  options: Record<string, number>
}

const PREFETCH_RADIUS = 5
const SCRUB_THRESHOLD_MS = 100
const SCRUB_KEYFRAME_STRIDE = 10
const SCRUB_FILL_DELAY_MS = 200

function build_frame_structure(
  base: AnyStructure,
  positions: Float32Array,
): AnyStructure {
  const N = Math.floor(positions.length / 3)
  const sites = base.sites?.map((s, i) => {
    if (i >= N) return s // out of trajectory cache range — keep base xyz
    return {
      ...s,
      xyz: [
        positions[i * 3],
        positions[i * 3 + 1],
        positions[i * 3 + 2],
      ] as [number, number, number],
    }
  }) ?? []
  return { ...base, sites } as AnyStructure
}

export class TrajectoryBondCache {
  /** Per-frame connectivity. Reactive bumps `version` on writes. */
  private cache = new SvelteMap<number, BondConnectivity[]>()
  private inflight = new SvelteSet<number>()
  private last_change_ms = 0
  private last_scrub_idx = -1
  private scrub_fill_timer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  /** $state — consumers read inside $derived/effect to react to cache writes. */
  version = $state(0)

  /** Get cached connectivity for frame or return null. Does NOT trigger compute. */
  get(frame_idx: number): BondConnectivity[] | null {
    return this.cache.get(frame_idx) ?? null
  }

  /** Get cached connectivity for frame if ready, otherwise return static base connectivity. */
  get_best(frame_idx: number): BondConnectivity[] | null {
    return this.cache.get(frame_idx) ?? null
  }

  /** Request connectivity for a frame. Triggers async compute if missing. */
  async request(
    frame_idx: number,
    getter: (i: number) => Float32Array | null,
    base: AnyStructure,
    strategy: BondingStrategy,
    options: Record<string, number>,
  ): Promise<void> {
    if (this.cache.has(frame_idx) || this.inflight.has(frame_idx)) return

    const positions = getter(frame_idx)
    if (!positions) return

    this.inflight.add(frame_idx)
    const gen = this.generation
    try {
      const structure = build_frame_structure(base, positions)
      const connectivity = await compute_bonds_async(structure, strategy, options)

      // Ensure we haven't cleared the cache since request started
      if (gen === this.generation) {
        this.cache.set(frame_idx, connectivity)
        this.version++
      }
    } catch (err) {
      console.warn(`[BondCache] Failed for frame ${frame_idx}:`, err)
    } finally {
      this.inflight.delete(frame_idx)
    }
  }

  /** Signal frame change. Handles scrubbing heuristics and prefetching. */
  on_frame_change(
    frame_idx: number,
    getter: (i: number) => Float32Array | null,
    base: AnyStructure,
    strategy: BondingStrategy,
    options: Record<string, number>,
  ): void {
    const now = Date.now()
    const dt = now - this.last_change_ms
    this.last_change_ms = now
    this.last_scrub_idx = frame_idx

    // Cancel any pending fill-timer
    if (this.scrub_fill_timer) {
      clearTimeout(this.scrub_fill_timer)
      this.scrub_fill_timer = null
    }

    if (dt < SCRUB_THRESHOLD_MS) {
      // Fast scrubbing — only request keyframes
      if (frame_idx % SCRUB_KEYFRAME_STRIDE === 0) {
        this.request(frame_idx, getter, base, strategy, options)
      }
      // Schedule fill-timer for when scrubbing stops
      this.scrub_fill_timer = setTimeout(() => {
        this.request(this.last_scrub_idx, getter, base, strategy, options)
        this.prefetch(this.last_scrub_idx, getter, base, strategy, options)
      }, SCRUB_FILL_DELAY_MS)
    } else {
      // Normal playback or single step — request immediate
      this.request(frame_idx, getter, base, strategy, options)
      this.prefetch(frame_idx, getter, base, strategy, options)
    }
  }

  /** Prefetch ±5 frames relative to current. */
  private prefetch(
    pivot: number,
    getter: (i: number) => Float32Array | null,
    base: AnyStructure,
    strategy: BondingStrategy,
    options: Record<string, number>,
  ): void {
    for (let i = 1; i <= PREFETCH_RADIUS; i++) {
      if (pivot + i >= 0) this.request(pivot + i, getter, base, strategy, options)
      if (pivot - i >= 0) this.request(pivot - i, getter, base, strategy, options)
    }
  }

  /** Clear all cached connectivity. Increments generation to invalidate pending promises. */
  clear(): void {
    this.cache.clear()
    this.inflight.clear()
    this.generation++
    this.version++
  }

  /** Drop one frame's cached connectivity (position-aware invalidation —
   *  use after an in-place atom edit on that frame). The `generation++` is
   *  global: it voids ALL in-flight computes (any frame), not just this one
   *  — matches `clear()`'s coarse model and is acceptable for the edit case.
   *  `version++` drives consumers to re-pull. */
  invalidate(frame_idx: number): void {
    this.cache.delete(frame_idx)
    this.inflight.delete(frame_idx)
    this.generation++
    this.version++
  }

  /** Drop every frame (edit-all scope). Delegates to `clear()` — named
   *  separately for intent at call sites; do not inline (keeps the
   *  invalidation invariant single-sourced in `clear()`). */
  invalidate_all(): void {
    this.clear()
  }
}

/** Create a reactive instance of the bond cache. */
export function create_trajectory_bond_cache(): TrajectoryBondCache {
  return new TrajectoryBondCache()
}

/** Wire cache to structural deps. Drives on_frame_change and pushes results back. */
export function wire_trajectory_bond_cache(
  cache: TrajectoryBondCache,
  deps: {
    get_structure: () => AnyStructure | undefined
    get_base: () => AnyStructure | undefined
    get_step_idx: () => number
    get_trajectory_active: () => boolean
    get_positions: () => ((i: number) => Float32Array | null) | null
    get_strategy: () => BondingStrategy
    get_options: () => Record<string, number>
    set_connectivity: (v: BondConnectivity[] | null) => void
    get_connectivity: () => BondConnectivity[] | null
    /** Optional. Bumps when the CURRENT frame's positions change in place
     *  (atom edit) without step_idx moving — forces a recompute the
     *  last_idx guard would otherwise skip. */
    get_positions_version?: () => number
    /** Optional. When the positions-version bump represents an edit-all
     *  fan-out, drop EVERY frame's bond cache rather than just `idx`. */
    get_positions_invalidate_all?: () => boolean
  },
): void {
  // Reset cache on actual value changes (not parent-render proxy churn).
  // Identity comparison alone causes a feedback loop with Trajectory's bond
  // pipeline: the connectivity-push effect writes
  // `trajectory_bond_connectivity_for_frame`, which re-renders Structure
  // and re-derives the `structure` prop with a new spread (find_pbc_images_fast
  // / transform-controller / Svelte-5 proxy churn). The new ref trips this
  // guard, resets `last_idx = -2`, and re-fires the on_frame_change effect
  // for the same frame — which kicks another compute_bonds_async, which
  // bumps version, which fires connectivity-push again, ad infinitum.
  // Compare by content fingerprint so a same-content re-spread is a no-op.
  let last_struct: AnyStructure | undefined = undefined
  let last_struct_fp: string | undefined = undefined
  let last_strategy: string | undefined = undefined
  let last_opts: string | undefined = undefined
  let last_idx = -2

  const fingerprint = (s: AnyStructure | undefined): string => {
    if (!s) return `<none>`
    const sites = (s as { sites?: { species?: { element?: string }[] }[] }).sites
    const lattice = (s as { lattice?: { a?: number; b?: number; c?: number; alpha?: number; beta?: number; gamma?: number } }).lattice
    const n = sites?.length ?? 0
    // Sample a handful of sites' element so doping (per-frame element change)
    // is detected as a real content change, not a no-op spread.
    const e0 = sites?.[0]?.species?.[0]?.element ?? ``
    const eMid = sites?.[Math.floor(n / 2)]?.species?.[0]?.element ?? ``
    const eLast = sites?.[n - 1]?.species?.[0]?.element ?? ``
    const la = lattice
      ? `${lattice.a ?? 0}-${lattice.b ?? 0}-${lattice.c ?? 0}-${lattice.alpha ?? 0}-${lattice.beta ?? 0}-${lattice.gamma ?? 0}`
      : `<mol>`
    return `${n}|${e0}|${eMid}|${eLast}|${la}`
  }

  $effect(() => {
    const s = deps.get_structure()
    if (s === last_struct) return
    untrack(() => {
      const strategy = deps.get_strategy()
      const opts_str = JSON.stringify(deps.get_options() ?? {})
      if (strategy === last_strategy && opts_str === last_opts) {
        // Structure ref changed but strategy/options stable — check content.
        const fp = fingerprint(s)
        const same_content = fp === last_struct_fp
        if (same_content) {
          // Same content, different reference (proxy churn from a re-render).
          last_struct = s
          return
        }
        // First-ever assignment: don't clear (nothing cached yet).
        const first_assignment = last_struct_fp === undefined
        last_struct = s
        last_struct_fp = fp
        if (first_assignment) return
        last_idx = -2
        cache.clear()
      } else {
        // Strategy or options actually changed — full reset.
        last_struct = s
        last_struct_fp = fingerprint(s)
        last_strategy = strategy
        last_opts = opts_str
        last_idx = -2
        cache.clear()
      }
    })
  })

  // Drive on_frame_change only when the frame index actually moves.
  // Only `idx` is allowed to be a reactive dep — `getter`, `base`,
  // `strategy`, and `options` are read inside `untrack()` so that
  // identity churn on those (Svelte 5 proxy re-spreads through
  // `bind:scene_props`, `bind:structure`, etc.) does not refire this
  // effect when the frame index hasn't moved. Without the untrack, every
  // bond-compute result triggers a Structure re-render which respreads
  // scene_props / structure and refires this effect, which kicks another
  // bond-worker request, which spreads again, and Svelte 5's flush
  // overflow guard kicks in.
  let last_pos_version = -1
  $effect(() => {
    const idx = deps.get_step_idx()
    const pv = deps.get_positions_version?.() ?? 0
    if (idx < 0) return
    const idx_moved = idx !== last_idx
    const pos_changed = pv !== last_pos_version
    if (!idx_moved && !pos_changed) return
    untrack(() => {
      const getter = deps.get_positions()
      const base = deps.get_base()
      if (!getter || !base) return
      last_idx = idx
      last_pos_version = pv
      // An in-place edit (positions-version bumped) must invalidate BEFORE
      // any request, independent of whether `idx` also moved in the same
      // flush. When a scrub coalesces with an edit-all version bump,
      // `idx_moved && pos_changed` are both true; without this the cache
      // hit-check in on_frame_change/request early-returns stale bonds for
      // the destination frame. edit-all → drop every frame; edit-current →
      // drop just this one.
      if (pos_changed) {
        if (deps.get_positions_invalidate_all?.()) cache.invalidate_all()
        else cache.invalidate(idx)
      }
      if (idx_moved) {
        // Frame changed (with or without a coalesced edit): on_frame_change
        // recomputes idx (cache now clean if pos_changed) and primes
        // neighbors.
        cache.on_frame_change(idx, getter, base, deps.get_strategy(), deps.get_options())
      } else {
        // Same-frame in-place edit only: recompute just this frame.
        cache.request(idx, getter, base, deps.get_strategy(), deps.get_options())
      }
    })
  })

  // Push the resolved connectivity into the caller's $state. Only
  // `cache.version` is allowed as a reactive dep — everything else is
  // untracked so writing `set_connectivity()` (which mutates a $state in
  // the caller) doesn't refire this effect through `get_connectivity()`'s
  // own subscription. Without untrack, set→get→re-run feeds the loop.
  $effect(() => {
    void cache.version
    untrack(() => {
      let next: BondConnectivity[] | null = null
      if (deps.get_trajectory_active() && deps.get_step_idx() >= 0) {
        next = cache.get_best(deps.get_step_idx()) ?? null
      }
      if (next !== deps.get_connectivity()) deps.set_connectivity(next)
    })
  })
}
