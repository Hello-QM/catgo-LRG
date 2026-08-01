import type {
  FrameLoader,
  ParseProgress,
  TrajectoryType,
} from '$lib/trajectory/index'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { NodeASEFrameLoader } from './node-ase-reader'
import { NodeHDF5FrameLoader } from './node-hdf5-reader'
import { NodeJSONFrameLoader } from './node-json-reader'
import {
  create_node_text_trajectory_loader,
  NodeOrcaFrameLoader,
} from './node-text-trajectory-reader'
import { NodeXYZFrameLoader } from './node-xyz-reader'

export interface LocalTrajectoryLoader {
  loader: FrameLoader
  source_format: string
}

async function prepare_local_trajectory_source(
  file_path: string,
  filename: string,
): Promise<{ file_path: string; filename: string }> {
  if (!/\.(?:gz|gzip)$/i.test(filename)) return { file_path, filename }
  const source_stat = await stat(file_path)
  const inner_filename = filename.replace(/\.(?:gz|gzip)$/i, ``)
  const cache_key = createHash(`sha1`)
    .update(`${path.resolve(file_path)}\0${source_stat.mtimeMs}\0${source_stat.size}`)
    .digest(`hex`)
    .slice(0, 16)
  const cache_dir = path.join(tmpdir(), `catgo-trajectory-cache`)
  await mkdir(cache_dir, { recursive: true })
  const safe_suffix = path.extname(inner_filename) || `.trajectory`
  const target = path.join(cache_dir, `${cache_key}${safe_suffix}`)
  try {
    if ((await stat(target)).size > 0) return { file_path: target, filename: inner_filename }
  } catch {
    // Cache miss.
  }
  const partial = `${target}.${process.pid}.${randomUUID()}.part`
  try {
    await pipeline(
      createReadStream(file_path),
      createGunzip(),
      createWriteStream(partial, { flags: `wx` }),
    )
    try {
      await rename(partial, target)
    } catch {
      // Another editor window may have completed the same cache entry first.
      await unlink(partial).catch(() => undefined)
    }
  } catch (error) {
    await unlink(partial).catch(() => undefined)
    throw error
  }
  return { file_path: target, filename: inner_filename }
}

/**
 * Select a format-specific local reader. Every returned loader keeps the
 * source file on disk and exposes O(1) frame requests to the webview.
 */
export async function create_local_trajectory_loader(
  file_path: string,
  filename: string,
  on_progress?: (progress: ParseProgress) => void,
): Promise<LocalTrajectoryLoader | null> {
  const prepared = await prepare_local_trajectory_source(file_path, filename)
  file_path = prepared.file_path
  filename = prepared.filename
  const lower = filename.toLowerCase()
  if (/\.(?:xyz|extxyz)$/i.test(lower)) {
    return {
      loader: await NodeXYZFrameLoader.create(file_path, filename, on_progress),
      source_format: `xyz_trajectory`,
    }
  }
  if (/\.traj$/i.test(lower)) {
    return {
      loader: await NodeASEFrameLoader.create(file_path, filename, on_progress),
      source_format: `ase_trajectory`,
    }
  }
  if (/\.(?:h5|hdf5)$/i.test(lower)) {
    return {
      loader: await NodeHDF5FrameLoader.create(file_path, filename, on_progress),
      source_format: `hdf5_trajectory`,
    }
  }
  if (/\.json$/i.test(lower)) {
    return {
      loader: await NodeJSONFrameLoader.create(file_path, filename, on_progress),
      source_format: `json_trajectory`,
    }
  }

  const loader = await create_node_text_trajectory_loader(
    file_path,
    filename,
    on_progress,
  )
  if (!loader) return null
  const source_format =
    /(?:^|[._-])xdatcar(?:[._-]|$)/i.test(filename)
      ? `vasp_xdatcar`
      : /(?:^|[._-])outcar(?:[._-]|$)/i.test(filename)
      ? `vasp_outcar`
      : /vasprun.*\.xml$/i.test(filename)
      ? `vasprun_xml`
      : /\.(?:dump|lammpstrj)$/i.test(filename)
      ? `lammps_dump`
      : loader instanceof NodeOrcaFrameLoader
      ? `orca_output`
      : `gaussian_output`
  return { loader, source_format }
}

export async function build_local_trajectory_manifest(
  loader_data: LocalTrajectoryLoader,
): Promise<TrajectoryType> {
  const { loader, source_format } = loader_data
  const total_frames = await loader.get_total_frames(``)
  const indexed_frames = await loader.build_frame_index(``, 1)
  const frames = []
  // Frame 0 establishes topology; frame 1 is an inexpensive early probe for
  // variable atom counts/elements.
  for (let frame_idx = 0; frame_idx < Math.min(2, total_frames); frame_idx++) {
    const frame = await loader.load_frame(``, frame_idx)
    if (frame) frames.push(frame)
  }
  if (frames.length === 0) throw new Error(`Failed to parse initial trajectory frame`)
  return {
    frames,
    metadata: {
      source_format,
      frame_count: total_frames,
    },
    total_frames,
    indexed_frames,
    is_indexed: true,
  }
}
