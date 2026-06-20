import type { FrameLoader, TrajectoryFrame, TrajectoryType } from './index'
import { clone_structure } from '$lib/structure/clone'
import { scale_structure_geometry } from './operations'

export type TrajectoryTransformation =
  | { kind: `scale_geometry`; factor: number }

export type PaneTrajectory = TrajectoryType & {
  frame_loader?: FrameLoader
  pane_transformations?: TrajectoryTransformation[]
}

const loader_bases = new WeakMap<FrameLoader, FrameLoader>()

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

function clone_frame(frame: TrajectoryFrame): TrajectoryFrame {
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

export function apply_trajectory_transformations(
  frame: TrajectoryFrame,
  transformations: TrajectoryTransformation[],
): TrajectoryFrame {
  return transformations.reduce((next, transformation) => {
    if (transformation.kind === `scale_geometry`) {
      return {
        ...next,
        structure: scale_structure_geometry(next.structure, transformation.factor),
      }
    }
    return next
  }, frame)
}

function fork_loader(
  loader: FrameLoader,
  transformations: TrajectoryTransformation[],
): FrameLoader {
  const original = loader_bases.get(loader) ?? loader
  const base = original.fork?.() ?? original
  const wrapped: FrameLoader = {
    get_total_frames: (data) => base.get_total_frames(data),
    build_frame_index: (data, sample_rate, on_progress) =>
      base.build_frame_index(data, sample_rate, on_progress),
    load_frame: async (data, frame_number) => {
      const frame = await base.load_frame(data, frame_number)
      return frame
        ? apply_trajectory_transformations(clone_frame(frame), transformations)
        : null
    },
    extract_plot_metadata: (data, options, on_progress) =>
      base.extract_plot_metadata(data, options, on_progress),
  }
  loader_bases.set(wrapped, base)
  return wrapped
}

/** Give every pane its own mutable trajectory/frame graph. */
export function clone_trajectory_for_pane<T extends TrajectoryType | null | undefined>(trajectory: T): T {
  if (trajectory == null) return trajectory
  const source = trajectory as PaneTrajectory
  const transformations = clone_data(source.pane_transformations ?? [])
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
    pane_transformations: transformations,
  }
  if (source.frame_loader) {
    copy.frame_loader = fork_loader(source.frame_loader, transformations)
  }
  return copy as T
}
