import {
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
} from 'three'
import type { BaseTopology } from '../../scene/render-packet'
import { position_texture_shape } from '../position-texture-layout'

export type AtomColorTopology = Pick<
  BaseTopology,
  'version' | 'atom_count' | 'colors'
>

export type SharedAtomColorTextureStats = {
  uploads: number
  skipped_same_topology: number
  restores: number
}

type UploadedTopology = AtomColorTopology

export class SharedAtomColorTexture {
  readonly texture: DataTexture

  #uploaded: UploadedTopology | null = null
  #stats: SharedAtomColorTextureStats = {
    uploads: 0,
    skipped_same_topology: 0,
    restores: 0,
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

  update(topology: AtomColorTopology): boolean {
    if (
      this.#uploaded?.version === topology.version &&
      this.#uploaded.atom_count === topology.atom_count &&
      this.#uploaded.colors === topology.colors
    ) {
      this.#stats.skipped_same_topology += 1
      return false
    }

    const { atom_count, colors } = topology
    const component_count = colors.length === atom_count * 3
      ? 3
      : colors.length === atom_count * 4
        ? 4
        : null
    if (component_count === null) {
      throw new RangeError(
        `Atom color payload length ${colors.length} does not match ` +
          `RGB or RGBA colors for ${atom_count} atoms`,
      )
    }

    const { width, height, float_count } = position_texture_shape(atom_count)
    const data = new Float32Array(float_count)
    for (let atom_idx = 0; atom_idx < atom_count; atom_idx += 1) {
      const source_offset = atom_idx * component_count
      const target_offset = atom_idx * 4
      data[target_offset] = colors[source_offset]
      data[target_offset + 1] = colors[source_offset + 1]
      data[target_offset + 2] = colors[source_offset + 2]
      data[target_offset + 3] = component_count === 4
        ? colors[source_offset + 3]
        : 1
    }

    this.texture.image.data = data
    this.texture.image.width = width
    this.texture.image.height = height
    this.texture.needsUpdate = true
    this.#uploaded = topology
    this.#stats.uploads += 1
    return true
  }

  restore(): boolean {
    if (this.#disposed || this.#uploaded === null) return false
    this.texture.needsUpdate = true
    this.#stats.restores += 1
    return true
  }

  stats(): SharedAtomColorTextureStats {
    return { ...this.#stats }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.texture.dispose()
  }
}
