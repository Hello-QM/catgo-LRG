import { zipSync } from 'fflate'
import {
  structure_to_poscar_str,
  trajectory_frame_to_extxyz_str,
  trajectory_to_xyz_str,
} from '$lib/structure/export'
import type { TrajectoryFrame, TrajectoryFrameResolver } from './index'

const COMPRESSED_SUFFIX = /\.(gz|bz2|xz|zst)$/i

async function yield_export_loop(completed: number, total: number): Promise<void> {
  if (completed < total && completed % 8 === 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

export function trajectory_export_basename(filename: string): string {
  let base = filename.split(/[/\\]/).pop() || `trajectory`
  while (COMPRESSED_SUFFIX.test(base)) base = base.replace(COMPRESSED_SUFFIX, ``)
  base = base.replace(/\.(extxyz|xyz|traj|h5|hdf5|xml|outcar|xdatcar)$/i, ``)
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, `_`).replace(/^\.+|\.+$/g, ``)
  return safe || `trajectory`
}

export function editable_trajectory_source(filename: string): `xyz` | `extxyz` | null {
  let base = filename.toLowerCase()
  while (COMPRESSED_SUFFIX.test(base)) base = base.replace(COMPRESSED_SUFFIX, ``)
  if (base.endsWith(`.extxyz`)) return `extxyz`
  if (base.endsWith(`.xyz`)) return `xyz`
  return null
}

export async function resolve_frame_range(
  start_frame: number,
  end_frame: number,
  resolve_frame: TrajectoryFrameResolver,
  on_progress?: (completed: number, total: number) => void,
): Promise<TrajectoryFrame[]> {
  if (start_frame < 0 || end_frame < start_frame) {
    throw new Error(`Invalid trajectory frame range ${start_frame}-${end_frame}`)
  }
  const total = end_frame - start_frame + 1
  const frames: TrajectoryFrame[] = []
  for (let idx = start_frame; idx <= end_frame; idx++) {
    const frame = await resolve_frame(idx)
    if (!frame?.structure?.sites) {
      throw new Error(`Trajectory frame ${idx} is not available for export`)
    }
    frames.push(frame)
    on_progress?.(frames.length, total)
  }
  return frames
}

export function serialize_extxyz_trajectory(frames: TrajectoryFrame[]): string {
  return trajectory_to_xyz_str(frames)
}

/** Serialize a lazy/indexed trajectory without retaining every decoded frame.
 * Only the final text chunks remain resident; frame objects can be released or
 * evicted by the effective-frame resolver as the walk advances. */
export async function serialize_extxyz_frame_range(
  start_frame: number,
  end_frame: number,
  resolve_frame: TrajectoryFrameResolver,
  on_progress?: (completed: number, total: number) => void,
): Promise<string> {
  if (start_frame < 0 || end_frame < start_frame) {
    throw new Error(`Invalid trajectory frame range ${start_frame}-${end_frame}`)
  }
  const total = end_frame - start_frame + 1
  const chunks: string[] = []
  for (let frame_idx = start_frame; frame_idx <= end_frame; frame_idx++) {
    const frame = await resolve_frame(frame_idx)
    if (!frame?.structure?.sites) {
      throw new Error(`Trajectory frame ${frame_idx} is not available for export`)
    }
    chunks.push(trajectory_frame_to_extxyz_str(frame))
    on_progress?.(chunks.length, total)
    await yield_export_loop(chunks.length, total)
  }
  return chunks.join(`\n`)
}

export function poscar_frame_filename(
  filename: string,
  frame_idx: number,
  total_frames: number,
): string {
  const width = Math.max(4, String(Math.max(0, total_frames - 1)).length)
  const frame = String(frame_idx).padStart(width, `0`)
  return `${trajectory_export_basename(filename)}_frame_${frame}.vasp`
}

export function create_poscar_frames_zip(
  frames: TrajectoryFrame[],
  frame_indices: number[],
  filename: string,
  total_frames: number,
): Blob {
  if (frames.length !== frame_indices.length) {
    throw new Error(`POSCAR export frame/index count mismatch`)
  }
  const encoder = new TextEncoder()
  const files: Record<string, Uint8Array> = {}
  for (let idx = 0; idx < frames.length; idx++) {
    files[poscar_frame_filename(filename, frame_indices[idx], total_frames)] =
      encoder.encode(`${structure_to_poscar_str(frames[idx].structure)}\n`)
  }
  const zipped = zipSync(files)
  return new Blob([zipped as BlobPart], { type: `application/zip` })
}

/** Build a numbered POSCAR ZIP from a lazy frame source without retaining the
 * decoded structures after their POSCAR bytes have been produced. */
export async function create_poscar_frame_range_zip(
  start_frame: number,
  end_frame: number,
  resolve_frame: TrajectoryFrameResolver,
  filename: string,
  total_frames: number,
  on_progress?: (completed: number, total: number) => void,
): Promise<Blob> {
  if (start_frame < 0 || end_frame < start_frame) {
    throw new Error(`Invalid trajectory frame range ${start_frame}-${end_frame}`)
  }
  const total = end_frame - start_frame + 1
  const encoder = new TextEncoder()
  const files: Record<string, Uint8Array> = {}
  for (let frame_idx = start_frame; frame_idx <= end_frame; frame_idx++) {
    const frame = await resolve_frame(frame_idx)
    if (!frame?.structure?.sites) {
      throw new Error(`Trajectory frame ${frame_idx} is not available for export`)
    }
    files[poscar_frame_filename(filename, frame_idx, total_frames)] = encoder.encode(
      `${structure_to_poscar_str(frame.structure)}\n`,
    )
    const completed = frame_idx - start_frame + 1
    on_progress?.(completed, total)
    await yield_export_loop(completed, total)
  }
  const zipped = zipSync(files)
  return new Blob([zipped as BlobPart], { type: `application/zip` })
}
