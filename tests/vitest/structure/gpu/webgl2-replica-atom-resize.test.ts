// Atom-replica vanish fix — buffer growth + divisor identity contract.
//
// Field bug (gates #531): static structure (~112 atoms) + bottom-right visual
// supercell 2x2x1 → atoms vanish while bonds render across replicas; toggling
// Settings → Visibility → Atoms off/on (remount = full rebuild) restores them.
// The packet path used to MUTATE `meshPerAttribute` on live
// InstancedBufferAttributes and rely on an `onBeforeRender` →
// `WebGLRenderer.resetState()` VAO-rebind hack. That combination happens to
// work on Chrome/ANGLE but is out of contract for Three's binding-state cache
// (`needsUpdate()` ignores divisors) and proved fragile on other GL stacks
// (desktop WebKitGTK). The contract pinned here:
//
//   1. a divisor change REPLACES the attribute object over the SAME backing
//      array, so Three rebinds naturally through attribute identity;
//   2. `onBeforeRender` performs NO renderer-global resets — no resetState(),
//      no setRenderTarget() churn mid-frame;
//   3. ANY atom_count change — even a packet whose versions were reused —
//      forces a full buffer/attribute rebuild: capacity is ground truth.
import { describe, expect, test, vi } from 'vitest'
import * as THREE from 'three'
import { AtomReplicaRenderer } from '$lib/structure/gpu/webgl2/atom-replica-renderer'
import type { RenderPacket } from '$lib/structure/scene/render-packet'
import { create_render_packet_builder } from '$lib/structure/scene/render-packet-builder'
import type { AnyStructure, Site } from '$lib'

function carbon_site(xyz: [number, number, number]): Site {
  return {
    species: [{ element: `C`, occu: 1, oxidation_state: 0 }],
    abc: [0, 0, 0],
    xyz,
    label: `C`,
    properties: {},
  } as unknown as Site
}

function make_structure(n: number, a = 10): AnyStructure {
  const sites = Array.from({ length: n }, (_, idx) => carbon_site([1.4 * idx, 0, 0]))
  return {
    sites,
    lattice: {
      matrix: [[a, 0, 0], [0, a, 0], [0, 0, a]],
      pbc: [true, true, true],
      a,
      b: a,
      c: a,
      alpha: 90,
      beta: 90,
      gamma: 90,
      volume: a ** 3,
    },
  } as unknown as AnyStructure
}

function geo(mesh: THREE.Mesh): THREE.InstancedBufferGeometry {
  return mesh.geometry as THREE.InstancedBufferGeometry
}

function attr(mesh: THREE.Mesh, name: string): THREE.InstancedBufferAttribute {
  return geo(mesh).getAttribute(name) as THREE.InstancedBufferAttribute
}

const ATTR_NAMES = [`instanceSite`, `instanceRadius`, `instanceAtomColor`] as const

/** Minimal fake WebGLRenderer that satisfies everything the (old) rebind hack
 *  touched, with spies on every renderer-global reset it performed. */
function make_reset_spy_renderer() {
  const resetState = vi.fn()
  const setRenderTarget = vi.fn()
  const renderer = {
    resetState,
    setRenderTarget,
    getRenderTarget: () => null,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getCurrentViewport: (target: THREE.Vector4) => target.set(0, 0, 800, 600),
    getDrawingBufferSize: (target: THREE.Vector2) => target.set(800, 600),
    getContext: () => ({
      SCISSOR_BOX: 0x0c10,
      SCISSOR_TEST: 0x0c11,
      getParameter: () => new Int32Array([0, 0, 800, 600]),
      isEnabled: () => false,
    }),
    state: { viewport: vi.fn(), scissor: vi.fn(), setScissorTest: vi.fn() },
  } as unknown as THREE.WebGLRenderer
  return { renderer, resetState, setRenderTarget }
}

function invoke_before_render(mesh: THREE.Mesh, renderer: THREE.WebGLRenderer): void {
  const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 100)
  camera.updateProjectionMatrix()
  mesh.onBeforeRender(
    renderer,
    new THREE.Scene(),
    camera,
    mesh.geometry,
    mesh.material as THREE.Material,
    null,
  )
}

describe(`AtomReplicaRenderer — divisor changes rebind via attribute identity`, () => {
  test(`factor change replaces attribute objects over the SAME arrays`, () => {
    const builder = create_render_packet_builder()
    const structure = make_structure(3)
    const renderer = new AtomReplicaRenderer()

    renderer.update(builder.build({ structure, dims: [2, 2, 1] }))
    const geometry = geo(renderer.mesh)
    const before = ATTR_NAMES.map((name) => attr(renderer.mesh, name))
    const arrays = before.map((attribute) => attribute.array)
    // Simulate a completed render pass: Three's binding-state setup caches the
    // draw clamp on the geometry and only recomputes it when it is undefined.
    ;(geometry as unknown as { _maxInstanceCount?: number })._maxInstanceCount = 3 * 4

    renderer.update(builder.build({ structure, dims: [2, 2, 2] }))

    expect(geo(renderer.mesh)).toBe(geometry)
    for (let idx = 0; idx < ATTR_NAMES.length; idx++) {
      const live = attr(renderer.mesh, ATTR_NAMES[idx])
      // Fresh identity → WebGLBindingStates.needsUpdate() sees the change and
      // re-runs VAO setup naturally. In-place meshPerAttribute mutation is
      // invisible to that cache and required the fragile resetState hack.
      expect(live).not.toBe(before[idx])
      // …but the backing typed array (and its data) is reused as-is.
      expect(live.array).toBe(arrays[idx])
      expect(live.meshPerAttribute).toBe(8)
    }
    expect(attr(renderer.mesh, `instanceSite`).count).toBe(3)
    expect(geometry.instanceCount).toBe(3 * 8)
    // The stale draw clamp from the previous divisor must be dropped so the
    // next binding-state setup recomputes it (24, not 12).
    expect((geometry as unknown as { _maxInstanceCount?: number })._maxInstanceCount)
      .toBeUndefined()
    renderer.dispose()
  })

  test(`onBeforeRender performs no renderer-global resets after a factor change`, () => {
    const builder = create_render_packet_builder()
    const structure = make_structure(3)
    const renderer = new AtomReplicaRenderer()
    renderer.update(builder.build({ structure, dims: [2, 2, 1] }))
    renderer.update(builder.build({ structure, dims: [2, 2, 2] }))

    const { renderer: fake, resetState, setRenderTarget } = make_reset_spy_renderer()
    invoke_before_render(renderer.mesh, fake)
    // The old hack called resetState() + setRenderTarget() mid-frame here —
    // renderer-global state churn that vanished atoms on non-ANGLE GL stacks.
    expect(resetState).not.toHaveBeenCalled()
    expect(setRenderTarget).not.toHaveBeenCalled()
    renderer.dispose()
  })
})

describe(`AtomReplicaRenderer — atom-count changes rebuild buffers`, () => {
  test(`growth 112→448 on the SAME renderer rebuilds capacity, counts, identity`, () => {
    const builder = create_render_packet_builder()
    const renderer = new AtomReplicaRenderer()

    renderer.update(builder.build({ structure: make_structure(112), dims: [2, 2, 1] }))
    const geometry = geo(renderer.mesh)
    const before = ATTR_NAMES.map((name) => attr(renderer.mesh, name))
    expect(geometry.instanceCount).toBe(112 * 4)
    expect(before[0].count).toBe(112)

    renderer.update(builder.build({ structure: make_structure(448), dims: [2, 2, 1] }))

    expect(geo(renderer.mesh)).toBe(geometry)
    expect(geometry.instanceCount).toBe(448 * 4)
    for (let idx = 0; idx < ATTR_NAMES.length; idx++) {
      const live = attr(renderer.mesh, ATTR_NAMES[idx])
      // Grown base buffers can never reuse the old attribute or array.
      expect(live).not.toBe(before[idx])
      expect(live.array).not.toBe(before[idx].array)
    }
    expect(attr(renderer.mesh, `instanceSite`).count).toBe(448)
    expect(attr(renderer.mesh, `instanceSite`).array).toHaveLength(448)
    expect(attr(renderer.mesh, `instanceRadius`).count).toBe(448)
    expect(attr(renderer.mesh, `instanceAtomColor`).count).toBe(448)
    expect(attr(renderer.mesh, `instanceSite`).meshPerAttribute).toBe(4)
    renderer.dispose()
  })

  test(`stale-version packet with grown atom_count still rebuilds — capacity is ground truth`, () => {
    const builder = create_render_packet_builder()
    const renderer = new AtomReplicaRenderer()
    const first = builder.build({ structure: make_structure(112), dims: [2, 2, 1] })
    renderer.update(first)
    expect(geo(renderer.mesh).instanceCount).toBe(112 * 4)

    // A hostile-but-real shape: atom_count grew while every version (and the
    // frame owner / positions_version) was carried over unchanged — e.g. an
    // upstream producer recycling counters. Sizes are self-consistent; only
    // the versions lie. The renderer must trust the buffers, not the versions.
    const grown: RenderPacket = {
      topology: {
        ...first.topology,
        atom_count: 448,
        site_ids: new Uint32Array(448),
        atomic_numbers: new Uint8Array(448).fill(6),
        radii: new Float32Array(448).fill(0.7),
        colors: new Float32Array(448 * 3).fill(0.5),
      },
      frame: { ...first.frame, positions: new Float32Array(448 * 3) },
      replicas: first.replicas,
    }

    // Old code: versions say "nothing changed" → topology rebuild skipped →
    // positions.set(1344 floats into a 336-float mirror) throws RangeError and
    // the mesh keeps stale 112-atom state (atoms vanish / renderer wedged).
    expect(() => renderer.update(grown)).not.toThrow()
    expect(geo(renderer.mesh).instanceCount).toBe(448 * 4)
    expect(attr(renderer.mesh, `instanceSite`).count).toBe(448)
    expect(attr(renderer.mesh, `instanceSite`).meshPerAttribute).toBe(4)
    expect(attr(renderer.mesh, `instanceRadius`).count).toBe(448)
    renderer.dispose()
  })
})
