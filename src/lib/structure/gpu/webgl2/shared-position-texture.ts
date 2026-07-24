import {
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
} from 'three'
import type { FrameGeometry } from '../../scene/render-packet'
import { trajectory_render_diagnostics } from '../../trajectory-render-diagnostics'
import { position_texture_shape } from '../position-texture-layout'

export type SharedPositionTextureStats = {
  uploads: number
  skipped_same_frame: number
  atom_consumers: number
  bond_consumers: number
  picker_consumers: number
}

export type UploadedFrameIdentity = {
  owner: object
  frame_idx: number
  positions_version: number
}

type Consumer = 'atom' | 'bond' | 'picker'

export class SharedPositionTexture {
  readonly texture: DataTexture

  #uploaded: UploadedFrameIdentity | null = null
  #stats: SharedPositionTextureStats = {
    uploads: 0,
    skipped_same_frame: 0,
    atom_consumers: 0,
    bond_consumers: 0,
    picker_consumers: 0,
  }
  #disposed = false

  constructor() {
    this.texture = new DataTexture(
      new Float32Array(4),
      1,
      1,
      RGBAFormat,
      FloatType,
    )
    this.texture.minFilter = NearestFilter
    this.texture.magFilter = NearestFilter
    this.texture.generateMipmaps = false
  }

  update(frame: FrameGeometry, rgba: Float32Array | null = null): boolean {
    if (
      this.#uploaded?.owner === frame.owner &&
      this.#uploaded.frame_idx === frame.frame_idx &&
      this.#uploaded.positions_version === frame.positions_version
    ) {
      this.#stats.skipped_same_frame += 1
      return false
    }

    const atom_count = Math.floor(frame.positions.length / 3)
    const { width, height, float_count } = position_texture_shape(atom_count)
    let data = rgba
    if (data === null) {
      data = new Float32Array(float_count)
      for (let idx = 0; idx < atom_count; idx++) {
        data[idx * 4] = frame.positions[idx * 3]
        data[idx * 4 + 1] = frame.positions[idx * 3 + 1]
        data[idx * 4 + 2] = frame.positions[idx * 3 + 2]
        data[idx * 4 + 3] = 1
      }
    } else if (data.length !== float_count) {
      throw new RangeError(
        `Position RGBA payload length ${data.length} does not match ` +
          `texture allocation ${float_count}`,
      )
    }

    this.texture.image.data = data
    this.texture.image.width = width
    this.texture.image.height = height
    this.texture.needsUpdate = true
    this.#uploaded = {
      owner: frame.owner,
      frame_idx: frame.frame_idx,
      positions_version: frame.positions_version,
    }
    this.#stats.uploads += 1
    trajectory_render_diagnostics.record_position_upload(data.byteLength)
    return true
  }

  register(consumer: Consumer): () => void {
    const key = `${consumer}_consumers` as const
    this.#stats[key] += 1
    let registered = true
    return () => {
      if (!registered) return
      registered = false
      this.#stats[key] -= 1
    }
  }

  stats(): SharedPositionTextureStats {
    return { ...this.#stats }
  }

  /** Metadata-only identity of the complete frame retained by the texture. */
  uploaded_frame(): UploadedFrameIdentity | null {
    return this.#uploaded === null ? null : { ...this.#uploaded }
  }

  /** Re-upload the retained complete frame after WebGL context restoration. */
  restore(): boolean {
    if (this.#disposed || this.#uploaded === null) return false
    this.texture.needsUpdate = true
    this.#stats.uploads += 1
    trajectory_render_diagnostics.record_position_upload(
      (this.texture.image.data as ArrayBufferView).byteLength,
    )
    return true
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.texture.dispose()
  }
}
