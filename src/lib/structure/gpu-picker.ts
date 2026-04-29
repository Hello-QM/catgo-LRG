// GPU-based color-ID picking for O(1) atom/bond hit detection on large structures.
// Renders each atom/bond with a unique color encoding its index, then reads back
// a single pixel to determine what's under the cursor.

import type { Vec3 } from '$lib'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import type { Camera } from 'three'

export type PickResult = { type: `atom`; index: number } | { type: `bond`; index: number } | null

// Encode an integer index into an RGB color (24 bits = up to 16M objects).
// Index 0 maps to color (0, 0, 1) so the background (black) is never a valid hit.
function index_to_color(index: number): Color {
  const id = index + 1
  const r = ((id >> 16) & 0xff) / 255
  const g = ((id >> 8) & 0xff) / 255
  const b = (id & 0xff) / 255
  return new Color(r, g, b)
}

function color_to_index(r: number, g: number, b: number): number {
  return ((r << 16) | (g << 8) | b) - 1
}

const PICK_SIZE = 1 // 1x1 pixel readback

export class GPUPicker {
  private scene = new Scene()
  private render_target = new WebGLRenderTarget(PICK_SIZE, PICK_SIZE)
  private pixel_buffer = new Uint8Array(4)
  private atom_count = 0
  private bond_count = 0
  private atom_mesh: InstancedMesh | null = null
  private bond_mesh: InstancedMesh | null = null
  /**
   * Phase 7e — per-cylinder-instance map back to a `filtered_bond_pairs`
   * index. When non-null, `pick()` decodes a bond hit via `bond_index_for_instance[id - atom_count]`
   * instead of the legacy `>>> 1` shorthand. The caller produces this map
   * so that decorator instances (image-atom × bond) resolve to the same
   * logical bond as the cell-internal half they decorate. `-1` entries are
   * treated as null hits — useful for e.g. orphan slots that haven't yet
   * shadow-synced with `filtered_bond_pairs`.
   */
  private bond_index_for_instance: Int32Array | null = null
  private sphere_geo: SphereGeometry
  private cyl_geo: CylinderGeometry
  private material = new MeshBasicMaterial({ vertexColors: false })

  constructor() {
    this.sphere_geo = new SphereGeometry(1, 8, 6)
    this.cyl_geo = new CylinderGeometry(1, 1, 1, 6)
  }

  update(
    positions: Vec3[],
    radii: number[],
    bond_xforms: Float32Array[],
    bond_thickness: number,
    bond_index_for_instance: Int32Array | null = null,
  ) {
    // Clear previous meshes
    this.scene.clear()
    this.atom_count = positions.length
    this.bond_count = bond_xforms.length
    this.bond_index_for_instance = bond_index_for_instance

    // Atom instances
    if (this.atom_count > 0) {
      const mesh = new InstancedMesh(this.sphere_geo, this.material, this.atom_count)
      const mat = new Matrix4()
      const color = new Color()

      for (let i = 0; i < this.atom_count; i++) {
        const [x, y, z] = positions[i]
        const r = radii[i]
        mat.makeScale(r, r, r)
        mat.setPosition(x, y, z)
        mesh.setMatrixAt(i, mat)
        const c = index_to_color(i)
        mesh.setColorAt(i, c)
      }

      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      this.atom_mesh = mesh
      this.scene.add(mesh)
    }

    // Bond instances (offset indices after atoms)
    if (this.bond_count > 0) {
      const mesh = new InstancedMesh(this.cyl_geo, this.material, this.bond_count)
      const mat = new Matrix4()
      const scale = new Matrix4()

      for (let i = 0; i < this.bond_count; i++) {
        const xform = bond_xforms[i]
        mat.fromArray(xform)
        // Apply bond thickness scaling to x and z axes
        scale.makeScale(bond_thickness, 1, bond_thickness)
        mat.multiply(scale)
        mesh.setMatrixAt(i, mat)
        const c = index_to_color(this.atom_count + i)
        mesh.setColorAt(i, c)
      }

      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      this.bond_mesh = mesh
      this.scene.add(mesh)
    }
  }

  pick(ndc_x: number, ndc_y: number, cam: Camera, renderer: WebGLRenderer): PickResult {
    // Create a 1x1 camera that looks at just the pixel under the cursor
    const pick_cam = cam.clone() as PerspectiveCamera | OrthographicCamera

    const full_width = renderer.domElement.width
    const full_height = renderer.domElement.height

    // Pixel coordinates from NDC
    const px = ((ndc_x + 1) / 2) * full_width
    const py = ((1 - ndc_y) / 2) * full_height

    // Save renderer state
    const prev_rt = renderer.getRenderTarget()
    const prev_clear = renderer.getClearColor(new Color())
    const prev_alpha = renderer.getClearAlpha()

    renderer.setRenderTarget(this.render_target)
    renderer.setClearColor(0x000000, 1)
    renderer.clear()

    // Use setViewOffset to render only the 1x1 pixel region
    if (`setViewOffset` in pick_cam) {
      ;(pick_cam as any).setViewOffset(full_width, full_height, px, py, PICK_SIZE, PICK_SIZE)
    }

    renderer.render(this.scene, pick_cam)

    renderer.readRenderTargetPixels(this.render_target, 0, 0, PICK_SIZE, PICK_SIZE, this.pixel_buffer)

    // Restore state
    renderer.setRenderTarget(prev_rt)
    renderer.setClearColor(prev_clear, prev_alpha)

    const [r, g, b] = this.pixel_buffer
    if (r === 0 && g === 0 && b === 0) return null // Background

    const id = color_to_index(r, g, b)
    if (id < 0) return null

    if (id < this.atom_count) {
      return { type: `atom`, index: id }
    } else if (id < this.atom_count + this.bond_count) {
      const inst = id - this.atom_count
      // Phase 7e: when a per-instance map is supplied, decode through it so
      // decorator-instance hits resolve to the same `filtered_bond_pairs`
      // index as the cell-internal halves they decorate. Without the map
      // (legacy callers) the `>>> 1` shorthand handles the half-bond pair.
      if (this.bond_index_for_instance !== null) {
        const idx = this.bond_index_for_instance[inst]
        return idx < 0 ? null : { type: `bond`, index: idx }
      }
      return { type: `bond`, index: inst >>> 1 }
    }

    return null
  }

  dispose() {
    this.render_target.dispose()
    this.sphere_geo.dispose()
    this.cyl_geo.dispose()
    this.material.dispose()
    this.atom_mesh?.dispose()
    this.bond_mesh?.dispose()
  }
}
