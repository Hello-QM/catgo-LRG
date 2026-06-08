// Remote (backend-streamed) frame loader for very large trajectories.
//
// Huge AIMD XYZ files (100s of MB, 10k+ frames) must not be slurped into the
// webview — see `server/catgo/routers/trajectory_stream.py`. Instead the
// backend indexes the file on disk and serves frame N on demand; this loader
// fetches frames over HTTP, so the webview only ever holds the current +
// prefetched frames. It implements the same `FrameLoader` contract as the
// in-memory `TrajFrameReader`, but ignores the `data` argument (there is no
// in-memory content) and addresses frames by the file path instead.

import type { ElementSymbol } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import { API_BASE } from '$lib/api/config'
import { create_trajectory_frame } from './parsers/common'
import type {
  FrameIndex,
  FrameLoader,
  TrajectoryFrame,
  TrajectoryMetadata,
  TrajectoryType,
} from './index'

interface BackendFrame {
  frame_number: number
  elements: string[]
  positions: number[][]
  comment?: string
  properties?: Record<string, number>
  // Present for periodic formats (XDATCAR): the 3x3 cell for this frame.
  // Absent for cell-less formats (CP2K *-pos*.xyz).
  lattice?: number[][] | null
}

/** Cap plot sampling so the metadata fetch stays small for 10k+ frames. */
const MAX_PLOT_POINTS = 2000

/** Frames fetched per HTTP request (backend caps `count` at 64). */
const BATCH = 16
/** Max frames kept in the per-loader LRU cache (~hundreds of MB headroom). */
const CACHE_CAP = 400

function backend_frame_to_trajectory_frame(bf: BackendFrame): TrajectoryFrame {
  // Periodic formats (XDATCAR) carry a per-frame cell; pass it through so the
  // viewer draws the box and bonds are PBC-aware. Cell-less formats (CP2K
  // *-pos*.xyz) send no lattice and stay non-periodic.
  const lattice = (bf.lattice && bf.lattice.length === 3)
    ? bf.lattice as unknown as Matrix3x3
    : undefined
  return create_trajectory_frame(
    bf.positions,
    bf.elements as ElementSymbol[],
    lattice,
    lattice ? [true, true, true] : undefined,
    bf.frame_number,
    { comment: bf.comment ?? ``, ...(bf.properties ?? {}) },
  )
}

function frames_url(path: string, start: number, count: number): string {
  return `${API_BASE}/trajectory/frames?path=${encodeURIComponent(path)}` +
    `&start=${start}&count=${count}`
}

/** Files the backend trajectory streamer can index. XDATCAR is matched by
 *  name (VASP trajectories usually have no extension). */
const STREAMABLE_RE = /\.(xyz|extxyz|lammpstrj|traj)$|xdatcar/i

/** XDATCAR parses ~100× its byte size into JS site objects (fractional text →
 *  nested objects), so it must stream at a much lower size than text XYZ — a
 *  2-3 MB XDATCAR already balloons to hundreds of MB and OOMs the webview when
 *  a second one is opened. Stream XDATCAR above 1 MB; keep the 20 MB default
 *  for the lighter text formats. */
const XDATCAR_STREAM_MIN_BYTES = 1 * 1024 * 1024
function stream_min_bytes_for(filename: string): number {
  return /xdatcar/i.test(filename) ? XDATCAR_STREAM_MIN_BYTES : 20 * 1024 * 1024
}

export interface StreamProbe {
  stream: boolean
  total_frames: number
  file_size: number
}

/**
 * Decide whether an on-disk file should be streamed frame-by-frame.
 *
 * Returns `null` for unsupported extensions / unreachable backend (caller then
 * falls back to the in-memory read path). Returns `{ stream: true, ... }` only
 * for genuinely large multi-frame files so small trajectories keep the snappier
 * in-memory path. Shared by every path-based entry point (file tree, drag-drop,
 * open-file, open-folder) so the threshold lives in one place.
 */
export async function probe_streamable_trajectory(
  path: string,
  filename: string,
  min_bytes?: number,
): Promise<StreamProbe | null> {
  if (!STREAMABLE_RE.test(filename)) return null
  const limit = min_bytes ?? stream_min_bytes_for(filename)
  try {
    const resp = await fetch(
      `${API_BASE}/trajectory/index?path=${encodeURIComponent(path)}`,
    )
    if (!resp.ok) return null
    const idx = await resp.json()
    const total_frames = idx?.total_frames ?? 0
    const file_size = idx?.file_size ?? 0
    return { stream: total_frames >= 2 && file_size > limit, total_frames, file_size }
  } catch {
    return null
  }
}

/**
 * For a large remote trajectory, pull it to a backend-local cache file (once,
 * gzip-compressed on the wire) and return that local path — which the normal
 * {@link load_remote_trajectory} streamer can then read. Returns `null` for
 * unsupported extensions / small files / failures (caller falls back to the
 * in-memory remote read).
 */
export async function materialize_remote_if_large(
  session_id: string,
  remote_path: string,
  filename: string,
  size_bytes: number,
  min_bytes?: number,
): Promise<string | null> {
  const limit = min_bytes ?? stream_min_bytes_for(filename)
  if (!STREAMABLE_RE.test(filename) || (size_bytes ?? 0) <= limit) return null
  try {
    const { materializeRemoteTrajectory } = await import('$lib/api/hpc')
    const mat = await materializeRemoteTrajectory(session_id, remote_path)
    if (mat?.ok && mat.total_frames >= 2) return mat.local_path
  } catch (error) {
    console.error(`remote trajectory materialize failed for ${filename}:`, error)
  }
  return null
}

/**
 * For a large browser ``File`` with no filesystem path (web-mode drop / file
 * picker), upload it once to a backend-local cache and return that local path
 * for {@link load_remote_trajectory}. Returns `null` for unsupported / small
 * files / failures (caller falls back to the in-memory parse).
 */
export async function materialize_file_if_large(
  file: File,
  min_bytes?: number,
): Promise<string | null> {
  const limit = min_bytes ?? stream_min_bytes_for(file.name)
  if (!STREAMABLE_RE.test(file.name) || file.size <= limit) return null
  try {
    const fd = new FormData()
    fd.append('file', file, file.name)
    const resp = await fetch(`${API_BASE}/trajectory/upload`, { method: 'POST', body: fd })
    if (!resp.ok) return null
    const mat = await resp.json()
    if (mat?.ok && mat.total_frames >= 2) return mat.local_path
  } catch (error) {
    console.error(`trajectory upload failed for ${file.name}:`, error)
  }
  return null
}

export class RemoteFrameLoader implements FrameLoader {
  // Insertion-ordered LRU of parsed frames + in-flight chunk dedupe, so
  // sequential playback costs ~1 HTTP request per BATCH frames and re-visited
  // frames are instant.
  private readonly cache = new Map<number, TrajectoryFrame>()
  private readonly inflight = new Map<number, Promise<void>>()

  constructor(
    private readonly path: string,
    private readonly total: number,
  ) {}

  // deno-lint-ignore require-await
  async get_total_frames(): Promise<number> {
    return this.total
  }

  private chunk_start(n: number): number {
    return Math.floor(n / BATCH) * BATCH
  }

  /** Fetch (once) the BATCH-aligned chunk containing `start`; cache all frames. */
  private fetch_chunk(start: number): Promise<void> {
    const existing = this.inflight.get(start)
    if (existing) return existing
    const count = Math.min(BATCH, this.total - start)
    const p = (async () => {
      try {
        const resp = await fetch(frames_url(this.path, start, count))
        if (!resp.ok) return
        const data = await resp.json()
        for (const bf of (data?.frames ?? []) as BackendFrame[]) {
          this.cache.set(bf.frame_number, backend_frame_to_trajectory_frame(bf))
        }
        this.evict()
      } catch (error) {
        console.error(`RemoteFrameLoader.fetch_chunk(${start}) failed:`, error)
      }
    })().finally(() => this.inflight.delete(start))
    this.inflight.set(start, p)
    return p
  }

  private evict(): void {
    let over = this.cache.size - CACHE_CAP
    if (over <= 0) return
    for (const key of this.cache.keys()) {
      if (over-- <= 0) break
      this.cache.delete(key)
    }
  }

  // deno-lint-ignore require-await
  async build_frame_index(
    _data: string | ArrayBuffer,
    sample_rate: number,
  ): Promise<FrameIndex[]> {
    // The scrubber ranges over `total_frames`; a full offset table is held on
    // the backend, so we only synthesize lightweight markers here.
    const step = Math.max(1, sample_rate)
    const out: FrameIndex[] = []
    for (let i = 0; i < this.total; i += step) {
      out.push({ frame_number: i, byte_offset: 0, estimated_size: 0 })
    }
    return out
  }

  async load_frame(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<TrajectoryFrame | null> {
    if (frame_number < 0 || frame_number >= this.total) return null
    if (!this.cache.has(frame_number)) {
      await this.fetch_chunk(this.chunk_start(frame_number))
    }
    // Prefetch the next chunk so forward playback never blocks on a fetch.
    const next = this.chunk_start(frame_number) + BATCH
    if (next < this.total && !this.cache.has(next) && !this.inflight.has(next)) {
      void this.fetch_chunk(next)
    }
    return this.cache.get(frame_number) ?? null
  }

  async extract_plot_metadata(
    _data: string | ArrayBuffer,
    options?: { sample_rate?: number },
  ): Promise<TrajectoryMetadata[]> {
    const stride = Math.max(1, options?.sample_rate ?? 1)
    try {
      const resp = await fetch(
        `${API_BASE}/trajectory/metadata?path=${encodeURIComponent(this.path)}&stride=${stride}`,
      )
      if (!resp.ok) return []
      const data = await resp.json()
      return (data?.metadata ?? []) as TrajectoryMetadata[]
    } catch (error) {
      console.error(`RemoteFrameLoader.extract_plot_metadata failed:`, error)
      return []
    }
  }
}

/**
 * Build a streamed `TrajectoryType` for a large on-disk trajectory.
 *
 * Fetches the frame index, the first `initial` frames, and sampled plot
 * metadata, then attaches a {@link RemoteFrameLoader}. The returned object is
 * the minimum `<Trajectory>` needs: `frames[0..initial)`, `total_frames`,
 * `is_indexed`, `plot_metadata`, and the monkey-patched `frame_loader`
 * (mirroring `Trajectory.svelte`'s `load_with_indexing`).
 */
export async function load_remote_trajectory(
  path: string,
  filename: string,
  initial = 10,
): Promise<TrajectoryType> {
  const idx_resp = await fetch(
    `${API_BASE}/trajectory/index?path=${encodeURIComponent(path)}`,
  )
  if (!idx_resp.ok) {
    throw new Error(`trajectory index failed (HTTP ${idx_resp.status}) for ${filename}`)
  }
  const idx = await idx_resp.json()
  const total: number = idx.total_frames ?? 0
  if (total <= 0) throw new Error(`no frames indexed in ${filename}`)

  const loader = new RemoteFrameLoader(path, total)

  const n0 = Math.min(initial, total)
  const fr_resp = await fetch(frames_url(path, 0, n0))
  const fr_data = fr_resp.ok ? await fr_resp.json() : { frames: [] }
  const frames: TrajectoryFrame[] = (fr_data.frames ?? [])
    .map(backend_frame_to_trajectory_frame)

  const stride = Math.max(1, Math.ceil(total / MAX_PLOT_POINTS))
  const plot_metadata = await loader.extract_plot_metadata(``, { sample_rate: stride })

  const trajectory: TrajectoryType = {
    frames,
    total_frames: total,
    is_indexed: true,
    plot_metadata,
    metadata: {
      filename,
      source: `remote-stream`,
      n_atoms: idx.n_atoms,
      file_size: idx.file_size,
    },
  }
  // `frame_loader` is consumed by Trajectory.svelte but not on TrajectoryType.
  ;(trajectory as TrajectoryType & { frame_loader: FrameLoader }).frame_loader = loader
  return trajectory
}
