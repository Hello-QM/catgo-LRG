import { clone_structure } from '$lib/structure/clone'
import { create_effective_frame_resolver } from './effective-frame-resolver'
import type { TrajectoryFrame, TrajectoryType } from './index'
import { OperationLedger } from './operation-ledger'
import type { TrajectoryEditOp } from './operations'

/**
 * @deprecated Legacy alias — pane edits are `TrajectoryEditOp` ledger entries
 * now (design §9.3). Kept for the `pane_transformations` bridge below.
 */
export type TrajectoryTransformation = TrajectoryEditOp

export type PaneTrajectory = TrajectoryType & {
  pane_transformations?: TrajectoryTransformation[]
}

/**
 * `LibraryEntry` lives inside Svelte `$state`, so selecting an existing entry
 * can hand us reactive Proxy objects. Browsers reject those in
 * `structuredClone`. Fall back to a recursive plain-data clone that preserves
 * arrays, cycles, undefined/NaN, maps, sets, dates and binary views.
 */
function clone_data<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    return clone_proxy_safe(value, new WeakMap<object, unknown>())
  }
}

function clone_proxy_safe<T>(
  value: T,
  seen: WeakMap<object, unknown>,
): T {
  if ((typeof value !== `object` && typeof value !== `function`) || value === null) {
    return value
  }

  const object = value as object
  const existing = seen.get(object)
  if (existing !== undefined) return existing as T

  if (value instanceof Date) return new Date(value.getTime()) as T
  if (value instanceof ArrayBuffer) return value.slice(0) as T
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      const buffer = value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      )
      return new DataView(buffer) as T
    }
    const TypedArray = value.constructor as {
      new (source: ArrayLike<number> | ArrayBufferLike): typeof value
    }
    return new TypedArray(value as unknown as ArrayLike<number>) as T
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = []
    seen.set(object, copy)
    for (const item of value) copy.push(clone_proxy_safe(item, seen))
    return copy as T
  }
  if (value instanceof Map) {
    const copy = new Map()
    seen.set(object, copy)
    for (const [key, item] of value) {
      copy.set(clone_proxy_safe(key, seen), clone_proxy_safe(item, seen))
    }
    return copy as T
  }
  if (value instanceof Set) {
    const copy = new Set()
    seen.set(object, copy)
    for (const item of value) copy.add(clone_proxy_safe(item, seen))
    return copy as T
  }

  const copy: Record<PropertyKey, unknown> = {}
  seen.set(object, copy)
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(object, key)
    if (descriptor?.enumerable) {
      copy[key] = clone_proxy_safe(
        Reflect.get(object, key) as unknown,
        seen,
      )
    }
  }
  return copy as T
}

export function clone_frame(frame: TrajectoryFrame): TrajectoryFrame {
  return {
    ...frame,
    structure: clone_structure(frame.structure),
    metadata: frame.metadata ? clone_data(frame.metadata) : frame.metadata,
  }
}

/**
 * Frame count above which per-pane frames are cloned copy-on-write instead of
 * eagerly. Below it, eager `frames.map(clone_frame)` is simplest and the
 * memory cost is negligible. Above it (a many-frame *in-memory*, non-indexed
 * trajectory — large indexed/streamed files only hold a handful of frames in
 * `.frames`), eagerly duplicating every frame's structure multiplies peak
 * memory per pane and can jank/OOM the (mobile) WebView, so each frame is
 * deep-cloned lazily on first access.
 */
const LAZY_CLONE_FRAME_THRESHOLD = 256

/**
 * Copy-on-write frames array: a private backing container (so structural
 * isolation holds — the trajectory edit paths only ever replace frames by
 * index or whole-array `.map`, never push/splice/in-place-mutate) whose
 * elements start as references to the source frames and are deep-cloned the
 * first time they're read. This bounds memory to the frames a pane actually
 * touches while preserving the same isolation contract as eager cloning:
 * mutating one pane's frame never affects another pane or the source.
 *
 * The proxy delegates everything except integer-index reads/writes to the
 * backing array via `Reflect`, so it composes transparently with Svelte's
 * own `$state` array proxy.
 */
function lazy_clone_frames(source: readonly TrajectoryFrame[]): TrajectoryFrame[] {
  const backing = source.slice() as TrajectoryFrame[]
  const cloned = new Set<number>()
  const as_index = (prop: PropertyKey): number => {
    if (typeof prop !== `string`) return -1
    const n = Number(prop)
    return Number.isInteger(n) && n >= 0 ? n : -1
  }
  return new Proxy(backing, {
    get(target, prop, receiver) {
      const i = as_index(prop)
      if (i >= 0 && i < target.length && !cloned.has(i)) {
        target[i] = clone_frame(target[i])
        cloned.add(i)
      }
      return Reflect.get(target, prop, receiver)
    },
    set(target, prop, value, receiver) {
      const i = as_index(prop)
      // An app-supplied frame is already a fresh, isolated object — record it
      // as "cloned" so a later read returns it as-is instead of re-cloning
      // (which would break reference identity / churn reactivity).
      if (i >= 0) cloned.add(i)
      return Reflect.set(target, prop, value, receiver)
    },
  })
}

/**
 * Legacy bridge (superseded once Trajectory.svelte gains ledger transactions):
 * streamed all-frame scale edits are still recorded via
 * `pane_transformations.push(...)`. Forked loaders no longer replay this array
 * — the effective-frame resolver is the ONLY transform path — so pushes are
 * routed into the pane's ledger as all-scope entries (bumping its revision).
 */
function ledger_backed_transformations(
  ledger: OperationLedger,
): TrajectoryTransformation[] {
  const transformations: TrajectoryTransformation[] = []
  Object.defineProperty(transformations, `push`, {
    value: (...ops: TrajectoryTransformation[]): number => {
      for (const op of ops) ledger.append({ kind: `all` }, op)
      return Array.prototype.push.call(transformations, ...ops)
    },
    enumerable: false,
  })
  return transformations
}

/**
 * The pane's ledger: an independent clone of the source pane's ledger, or a
 * fresh one seeded from any legacy transformation array (design §9.3 — each
 * pane owns its ordered ledger; edits never leak across panes).
 */
function pane_ledger(source: PaneTrajectory): OperationLedger {
  if (source.operation_ledger) return source.operation_ledger.clone()
  const ledger = new OperationLedger()
  for (const op of clone_data(source.pane_transformations ?? [])) {
    ledger.append({ kind: `all` }, op)
  }
  return ledger
}

/** Give every pane its own mutable trajectory/frame graph. */
export function clone_trajectory_for_pane<T extends TrajectoryType | null | undefined>(trajectory: T): T {
  if (trajectory == null) return trajectory
  const source = trajectory as PaneTrajectory
  const ledger = pane_ledger(source)
  const copy: PaneTrajectory = {
    ...source,
    frames: source.frames.length > LAZY_CLONE_FRAME_THRESHOLD
      ? lazy_clone_frames(source.frames)
      : source.frames.map(clone_frame),
    metadata: source.metadata ? clone_data(source.metadata) : source.metadata,
    indexed_frames: source.indexed_frames?.map((x) => ({ ...x })),
    plot_metadata: source.plot_metadata?.map((x) => ({
      ...x,
      properties: { ...x.properties },
    })),
    operation_ledger: ledger,
    effective_frames: create_effective_frame_resolver(ledger),
    pane_transformations: ledger_backed_transformations(ledger),
  }
  if (source.frame_loader) {
    // Forked loaders serve immutable base frames only — no transformation
    // replay (that caused missing/double-applied ops when consumers mixed
    // loader frames with transformed `frames`). Ledger ops are applied by the
    // pane's effective-frame resolver, cached by (frame_idx, ledger_revision).
    copy.frame_loader = source.frame_loader.fork?.() ?? source.frame_loader
  }
  return copy as T
}
