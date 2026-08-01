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
  FramePositionData,
  TrajectoryFrame,
  TrajectoryMetadata,
  TrajectoryType,
} from './index'

interface BackendFrame {
  frame_number: number
  elements: string[]
  positions: number[][]
  forces?: number[][] | null
  comment?: string
  properties?: Record<string, number>
  // Present for periodic formats (XDATCAR): the 3x3 cell for this frame.
  // Absent for cell-less formats (CP2K *-pos*.xyz).
  lattice?: number[][] | null
}

/** Cap plot sampling so the metadata fetch stays small for 10k+ frames. */
const MAX_PLOT_POINTS = 2000

/** Keep one binary fetch around 4 MiB while amortizing request overhead. */
export const REMOTE_BATCH_POSITION_BYTE_BUDGET = 4 * 1024 * 1024
/** Retain at most about 64 MiB of compact Float32 position packets. */
export const REMOTE_CACHE_POSITION_BYTE_BUDGET = 64 * 1024 * 1024
const REMOTE_MAX_BATCH_FRAMES = 16
const REMOTE_MAX_CACHE_FRAMES = 400
const REMOTE_MIN_CACHE_CHUNKS = 3

export interface RemoteFrameCachePlan {
  batch_size: number
  cache_capacity: number
}

/**
 * Size remote fetches and the compact-position LRU by retained bytes.
 *
 * The binary display path keeps only 3N float32 coordinates plus an 80-byte
 * frame header, so a 19,968-atom frame is about 234 KiB instead of tens of
 * megabytes of nested site objects.
 */
export function remote_frame_cache_plan(n_atoms: number): RemoteFrameCachePlan {
  const bytes_per_frame = Math.max(1, Math.floor(n_atoms) || 1) * 3 * 4 + 80
  const batch_size = Math.min(
    REMOTE_MAX_BATCH_FRAMES,
    Math.max(
      1,
      Math.floor(REMOTE_BATCH_POSITION_BYTE_BUDGET / bytes_per_frame),
    ),
  )
  const cache_capacity = Math.min(
    REMOTE_MAX_CACHE_FRAMES,
    Math.max(
      batch_size * REMOTE_MIN_CACHE_CHUNKS,
      Math.floor(REMOTE_CACHE_POSITION_BYTE_BUDGET / bytes_per_frame),
    ),
  )
  return { batch_size, cache_capacity }
}

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
    bf.forces ?? undefined,
  )
}

type RemoteFramePacket = FramePositionData

function frames_url(path: string, start: number, count: number): string {
  return `${API_BASE}/trajectory/frames?path=${encodeURIComponent(path)}` +
    `&start=${start}&count=${count}`
}

function positions_url(path: string, start: number, count: number): string {
  return `${API_BASE}/trajectory/positions?path=${encodeURIComponent(path)}` +
    `&start=${start}&count=${count}`
}

/** Files the shared backend streamer can index with format-specific random
 *  access. VASP files are primarily name-based because they often have no
 *  extension. Gaussian .out/.log files are content-validated by the backend. */
const STREAMABLE_RE =
  /\.(?:xyz|extxyz|dump|lammpstrj|traj|h5|hdf5|out|log)$|(?:^|[._-])(?:xdatcar|outcar)(?:[._-]|$)|vasprun.*\.xml$/i
const STREAM_COMPRESSION_RE = /\.(?:gz|gzip|bz2|xz)$/i

function streamable_filename(filename: string): boolean {
  let base = filename
  while (STREAM_COMPRESSION_RE.test(base)) base = base.replace(STREAM_COMPRESSION_RE, ``)
  if (/\.json$/i.test(base)) {
    return /(?:^|[._-])(?:trajectory|traj|frames|relax|npt|nvt|nve|md)(?:[._-]|$)/i.test(base)
  }
  return STREAMABLE_RE.test(base)
}

/** Use the same file-backed indexing policy for every trajectory family.
 *  Even a 7-8 MiB variable-topology extXYZ can contain thousands of frames,
 *  while a compressed file can inflate far beyond its on-disk size. */
const STREAM_MIN_BYTES = 1 * 1024 * 1024
const COMPRESSED_STREAM_MIN_BYTES = 256 * 1024
function stream_min_bytes_for(filename: string): number {
  return STREAM_COMPRESSION_RE.test(filename)
    ? COMPRESSED_STREAM_MIN_BYTES
    : STREAM_MIN_BYTES
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
  if (!streamable_filename(filename)) return null
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
  if (!streamable_filename(filename) || (size_bytes ?? 0) <= limit) return null
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
  if (!streamable_filename(file.name) || file.size <= limit) return null
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
  // Insertion-ordered LRU of compact binary position views + in-flight chunk
  // dedupe. Full site graphs are materialized only by load_frame().
  private readonly cache = new Map<number, RemoteFramePacket>()
  private readonly inflight = new Map<number, Promise<void>>()
  private readonly cache_plan: RemoteFrameCachePlan

  constructor(
    private readonly path: string,
    private readonly total: number,
    private readonly n_atoms = 1,
    private readonly compact_positions = true,
  ) {
    this.cache_plan = remote_frame_cache_plan(n_atoms)
  }

  fork(): FrameLoader {
    return new RemoteFrameLoader(
      this.path,
      this.total,
      this.n_atoms,
      this.compact_positions,
    )
  }

  // deno-lint-ignore require-await
  async get_total_frames(): Promise<number> {
    return this.total
  }

  private chunk_start(n: number): number {
    const batch = this.cache_plan.batch_size
    return Math.floor(n / batch) * batch
  }

  /** Fetch (once) the byte-budgeted binary chunk containing `start`. */
  private fetch_chunk(start: number): Promise<void> {
    const existing = this.inflight.get(start)
    if (existing) return existing
    const count = Math.min(this.cache_plan.batch_size, this.total - start)
    const p = (async () => {
      try {
        const resp = await fetch(positions_url(this.path, start, count))
        if (!resp.ok) return
        const buffer = await resp.arrayBuffer()
        const view = new DataView(buffer)
        if (view.byteLength < 16) throw new Error(`short CGTP header`)
        const magic = String.fromCharCode(
          view.getUint8(0),
          view.getUint8(1),
          view.getUint8(2),
          view.getUint8(3),
        )
        const version = view.getUint32(4, true)
        const frame_count = view.getUint32(8, true)
        const n_atoms = view.getUint32(12, true)
        if (
          magic !== `CGTP` || ![1, 2].includes(version) ||
          n_atoms !== this.n_atoms
        ) {
          throw new Error(
            `bad position packet ${magic} v${version} (${n_atoms} atoms)`,
          )
        }
        let offset = 16
        for (let idx = 0; idx < frame_count; idx++) {
          const frame_header_bytes = version === 2 ? 84 : 80
          if (offset + frame_header_bytes > view.byteLength) {
            throw new Error(`short frame header`)
          }
          const frame_number = view.getUint32(offset, true)
          const frame_n_atoms = version === 2
            ? view.getUint32(offset + 4, true)
            : n_atoms
          const flags_offset = version === 2 ? offset + 8 : offset + 4
          const lattice_offset = version === 2 ? offset + 12 : offset + 8
          const flags = view.getUint32(flags_offset, true)
          const has_lattice = (flags & 1) !== 0
          const lattice_values = new Array<number>(9)
          for (let value_idx = 0; value_idx < 9; value_idx++) {
            lattice_values[value_idx] = view.getFloat64(
              lattice_offset + value_idx * 8,
              true,
            )
          }
          offset += frame_header_bytes
          const position_count = frame_n_atoms * 3
          const position_bytes = position_count * Float32Array.BYTES_PER_ELEMENT
          if (offset + position_bytes > view.byteLength) {
            throw new Error(`short position payload`)
          }
          const positions = new Float32Array(buffer, offset, position_count)
          offset += position_bytes
          this.cache.set(frame_number, {
            step: frame_number,
            positions,
            forces: null,
            lattice: has_lattice
              ? [
                  lattice_values.slice(0, 3),
                  lattice_values.slice(3, 6),
                  lattice_values.slice(6, 9),
                ]
              : null,
            metadata: {},
            topology_changed: (flags & 2) !== 0,
          })
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
    let over = this.cache.size - this.cache_plan.cache_capacity
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
    try {
      const resp = await fetch(frames_url(this.path, frame_number, 1))
      if (!resp.ok) return null
      const data = await resp.json()
      const frame = (data?.frames ?? [])[0] as BackendFrame | undefined
      return frame ? backend_frame_to_trajectory_frame(frame) : null
    } catch (error) {
      console.error(`RemoteFrameLoader.load_frame(${frame_number}) failed:`, error)
      return null
    }
  }

  async load_frame_positions(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<FramePositionData | null> {
    if (frame_number < 0 || frame_number >= this.total) return null
    if (!this.compact_positions) return null
    if (!this.cache.has(frame_number)) {
      await this.fetch_chunk(this.chunk_start(frame_number))
    }
    const next = this.chunk_start(frame_number) + this.cache_plan.batch_size
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
  initial = 1,
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

  const n0 = Math.min(initial, total)
  const fr_resp = await fetch(frames_url(path, 0, n0))
  const fr_data = fr_resp.ok ? await fr_resp.json() : { frames: [] }
  const frames: TrajectoryFrame[] = (fr_data.frames ?? [])
    .map(backend_frame_to_trajectory_frame)
  const loader = new RemoteFrameLoader(
    path,
    total,
    idx.n_atoms ?? 1,
    true,
  )

  // Reading ASE metadata walks every frame and contends with position packets.
  // Keep it genuinely lazy: Structure-only playback never starts the scan;
  // opening a plot starts it once and memoizes the promise.
  const stride = Math.max(1, Math.ceil(total / MAX_PLOT_POINTS))
  let pending_plot_metadata: Promise<TrajectoryMetadata[]> | undefined
  const plot_metadata_loader = () =>
    pending_plot_metadata ??= loader.extract_plot_metadata(
      ``,
      { sample_rate: stride },
    )

  const trajectory: TrajectoryType = {
    frames,
    total_frames: total,
    is_indexed: true,
    plot_metadata_loader,
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
