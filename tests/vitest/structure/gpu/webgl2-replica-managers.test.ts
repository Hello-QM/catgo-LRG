// gpu-visual-supercell Task 4 review fix round 1 — manager-component integration.
//
// These are component-level tests: they mount the REAL AtomManagerInstances /
// BondManagerInstances components under a minimal Threlte context, inspect the
// actual Three scene, and drive packet/appearance props through Svelte events.
// They prevent the manager wrappers from hiding a legacy InstancedMesh (and
// its capacity-sized instanceMatrix) behind the replica layer, prevent
// 1×↔N× remount churn, and prove the divisor-cache rebind hook is observable
// without allocating new geometry/material/attribute resources.
import type { RenderPacket } from '$lib/structure/scene/render-packet'
import {
  create_render_packet_builder,
  type PacketBondConnectivity,
} from '$lib/structure/scene/render-packet-builder'
import { AtomManager } from '$lib/structure/atoms/atom-manager.svelte'
import { BondManager } from '$lib/structure/bonding/bond-manager.svelte'
import type { AnyStructure, Site } from '$lib'
import * as THREE from 'three'
import { flushSync, mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, test, vi } from 'vitest'
import Harness from './webgl2-replica-managers-harness.svelte'

function carbon_site(xyz: [number, number, number]): Site {
  return {
    species: [{ element: `C`, occu: 1, oxidation_state: 0 }],
    abc: [0, 0, 0],
    xyz,
    label: `C`,
    properties: {},
  } as unknown as Site
}

function make_structure(): AnyStructure {
  const sites = [carbon_site([0, 0, 0]), carbon_site([1.4, 0, 0])]
  return {
    sites,
    lattice: {
      matrix: [[10, 0, 0], [0, 10, 0], [0, 0, 10]],
      pbc: [true, true, true],
      a: 10,
      b: 10,
      c: 10,
      alpha: 90,
      beta: 90,
      gamma: 90,
      volume: 1000,
    },
  } as unknown as AnyStructure
}

const CONNECTIVITY: PacketBondConnectivity[] = [
  { site_idx_1: 0, site_idx_2: 1 },
  { site_idx_1: 1, site_idx_2: 0, jimage: [1, 0, 0] },
]

function make_packets(): RenderPacket[] {
  const builder = create_render_packet_builder()
  const structure = make_structure()
  return [
    builder.build({ structure, bond_connectivity: CONNECTIVITY, dims: [1, 1, 1] }),
    builder.build({ structure, bond_connectivity: CONNECTIVITY, dims: [2, 1, 1] }),
    builder.build({ structure, bond_connectivity: CONNECTIVITY, dims: [2, 2, 2] }),
  ]
}

function make_fake_renderer() {
  // Match Three r181's split bookkeeping: getViewport/getScissor/getScissorTest
  // expose the canvas defaults, while setRenderTarget copies the target's
  // viewport/scissor/scissorTest into the active _current* pass state.
  const canvas_viewport = new THREE.Vector4(11, 12, 320, 240)
  const canvas_scissor = new THREE.Vector4(13, 14, 300, 220)
  let canvas_scissor_test = false
  const renderTarget = new THREE.WebGLRenderTarget(32, 32)
  renderTarget.viewport.set(3, 4, 29, 27)
  renderTarget.scissor.set(5, 6, 23, 21)
  renderTarget.scissorTest = true

  let active_target: THREE.WebGLRenderTarget | null = renderTarget
  let active_cube_face = 3
  let active_mip_level = 2
  const bookkeeping_viewport = renderTarget.viewport.clone()
  const gl_viewport = renderTarget.viewport.clone()
  const current_scissor = renderTarget.scissor.clone()
  let current_scissor_test = renderTarget.scissorTest
  const pass_viewport = new THREE.Vector4(7, 8, 19, 17)
  const pass_scissor = new THREE.Vector4(9, 10, 13, 11)
  const pass_scissor_test = true

  const resetState = vi.fn(() => {
    active_target = null
    active_cube_face = 0
    active_mip_level = 0
  })
  const setRenderTarget = vi.fn((
    target: THREE.WebGLRenderTarget | null,
    cube_face = 0,
    mip_level = 0,
  ) => {
    active_target = target
    active_cube_face = cube_face
    active_mip_level = mip_level
    if (target !== null) {
      bookkeeping_viewport.copy(target.viewport)
      gl_viewport.copy(target.viewport)
      current_scissor.copy(target.scissor)
      current_scissor_test = target.scissorTest
    } else {
      bookkeeping_viewport.copy(canvas_viewport)
      gl_viewport.copy(canvas_viewport)
      current_scissor.copy(canvas_scissor)
      current_scissor_test = canvas_scissor_test
    }
  })
  const setViewport = vi.fn((x: number, y: number, width: number, height: number) => {
    canvas_viewport.set(x, y, width, height)
    bookkeeping_viewport.copy(canvas_viewport)
    gl_viewport.copy(canvas_viewport)
  })
  const setScissor = vi.fn((x: number, y: number, width: number, height: number) => {
    canvas_scissor.set(x, y, width, height)
    current_scissor.copy(canvas_scissor)
  })
  const setScissorTest = vi.fn((enabled: boolean) => {
    canvas_scissor_test = enabled
    current_scissor_test = enabled
  })
  const stateViewport = vi.fn((viewport: THREE.Vector4) => {
    // WebGLState restores the raw GL viewport but does not update Three's
    // private WebGLRenderer._currentViewport bookkeeping.
    gl_viewport.copy(viewport)
  })
  const stateScissor = vi.fn((scissor: THREE.Vector4) => {
    current_scissor.copy(scissor)
  })
  const stateScissorTest = vi.fn((enabled: boolean) => {
    current_scissor_test = enabled
  })
  const activate_render_target = () => {
    setRenderTarget(renderTarget, 3, 2)
    // ArrayCamera/XR/tiled passes apply an active override after selecting the
    // target. It is deliberately distinct from target and canvas defaults.
    bookkeeping_viewport.copy(pass_viewport)
    gl_viewport.copy(pass_viewport)
    current_scissor.copy(pass_scissor)
    current_scissor_test = pass_scissor_test
  }
  const current_pass = () => ({
    target: active_target,
    cube_face: active_cube_face,
    mip_level: active_mip_level,
    viewport: gl_viewport.clone(),
    bookkeeping_viewport: bookkeeping_viewport.clone(),
    scissor: current_scissor.clone(),
    scissor_test: current_scissor_test,
  })
  const gl = {
    SCISSOR_BOX: 0x0c10,
    SCISSOR_TEST: 0x0c11,
    getParameter: (parameter: number) => {
      if (parameter === 0x0c10) {
        return new Int32Array([
          current_scissor.x,
          current_scissor.y,
          current_scissor.z,
          current_scissor.w,
        ])
      }
      return null
    },
    isEnabled: (capability: number) =>
      capability === 0x0c11 && current_scissor_test,
  } as unknown as WebGL2RenderingContext

  const renderer = {
    render: vi.fn(),
    setSize: vi.fn(),
    setPixelRatio: vi.fn(),
    getDrawingBufferSize: (target: THREE.Vector2) => target.set(800, 600),
    getContext: () => gl,
    getRenderTarget: () => active_target,
    getActiveCubeFace: () => active_cube_face,
    getActiveMipmapLevel: () => active_mip_level,
    getCurrentViewport: (target: THREE.Vector4) => target.copy(bookkeeping_viewport),
    getViewport: (target: THREE.Vector4) => target.copy(canvas_viewport),
    getScissor: (target: THREE.Vector4) => target.copy(canvas_scissor),
    getScissorTest: () => canvas_scissor_test,
    setRenderTarget,
    setViewport,
    setScissor,
    setScissorTest,
    resetState,
    state: {
      viewport: stateViewport,
      scissor: stateScissor,
      setScissorTest: stateScissorTest,
    },
    dispose: vi.fn(),
    outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: false, type: THREE.PCFSoftShadowMap },
    toneMapping: THREE.NoToneMapping,
  } as unknown as THREE.WebGLRenderer
  return {
    renderer,
    resetState,
    renderTarget,
    setRenderTarget,
    setViewport,
    setScissor,
    setScissorTest,
    activate_render_target,
    current_pass,
    expected_pass: {
      viewport: pass_viewport,
      scissor: pass_scissor,
      scissor_test: pass_scissor_test,
    },
  }
}

function scene_objects<T extends THREE.Object3D>(
  scene: THREE.Scene,
  predicate: (obj: THREE.Object3D) => obj is T,
): T[] {
  const out: T[] = []
  scene.traverse((obj) => {
    if (predicate(obj)) out.push(obj)
  })
  return out
}

function meshes(scene: THREE.Scene): THREE.Mesh[] {
  return scene_objects(scene, (obj): obj is THREE.Mesh =>
    (obj as THREE.Mesh).isMesh === true
  )
}

function instanced_meshes(scene: THREE.Scene): THREE.InstancedMesh[] {
  return scene_objects(scene, (obj): obj is THREE.InstancedMesh =>
    (obj as THREE.InstancedMesh).isInstancedMesh === true
  )
}

function visible_meshes(scene: THREE.Scene): THREE.Mesh[] {
  return meshes(scene).filter((mesh) => mesh.visible)
}

async function settle(): Promise<void> {
  flushSync()
  await tick()
  flushSync()
}

const mounted: object[] = []
afterEach(async () => {
  while (mounted.length > 0) await unmount(mounted.pop()!)
  document.body.replaceChildren()
})

async function mount_manager(mode: 'atom' | 'bond', start_null = false) {
  const dom = document.createElement(`div`)
  const canvas = document.createElement(`canvas`)
  dom.append(canvas)
  document.body.append(dom)
  const {
    renderer,
    resetState,
    renderTarget,
    setRenderTarget,
    setViewport,
    setScissor,
    setScissorTest,
    activate_render_target,
    current_pass,
    expected_pass,
  } = make_fake_renderer()
  let scene!: THREE.Scene
  const component = mount(Harness, {
    target: dom,
    props: {
      mode,
      packets: make_packets(),
      atom_manager: new AtomManager(16),
      bond_manager: new BondManager(16),
      renderer,
      dom,
      canvas,
      onscene: (next: THREE.Scene) => scene = next,
      start_null,
    },
  })
  mounted.push(component)
  await settle()
  return {
    dom,
    renderer,
    resetState,
    renderTarget,
    setRenderTarget,
    setViewport,
    setScissor,
    setScissorTest,
    activate_render_target,
    current_pass,
    expected_pass,
    scene,
  }
}

async function click(dom: HTMLElement, testid: string): Promise<void> {
  dom.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click()
  await settle()
}

function invoke_before_render(
  mesh: THREE.Mesh,
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
): void {
  const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 100)
  camera.updateProjectionMatrix()
  mesh.onBeforeRender(
    renderer,
    scene,
    camera,
    mesh.geometry,
    mesh.material as THREE.Material,
    null,
  )
}

for (const mode of [`atom`, `bond`] as const) {
  describe(`${mode} manager replica packet path`, () => {
    test(`1×→2×→8×→1× stays on one replica mesh with no legacy instanceMatrix`, async () => {
      const {
        dom,
        renderer,
        resetState,
        renderTarget,
        setRenderTarget,
        setViewport,
        setScissor,
        setScissorTest,
        activate_render_target,
        current_pass,
        expected_pass,
        scene,
      } = await mount_manager(mode)

      // A packet means the replica renderer owns the path starting at 1×.
      // No hidden legacy InstancedMesh — and therefore no capacity-sized
      // instanceMatrix — may exist in the Three scene.
      expect(instanced_meshes(scene)).toHaveLength(0)
      expect(visible_meshes(scene)).toHaveLength(1)

      const main = visible_meshes(scene)[0]
      const geometry = main.geometry as THREE.InstancedBufferGeometry
      const material = main.material
      const attr_name = mode === `atom` ? `instanceSite` : `a_site`
      const initial_attr = geometry.getAttribute(attr_name) as
        THREE.InstancedBufferAttribute
      const base_array = initial_attr.array
      const expected_divisor = (cell_count: number): number =>
        mode === `atom` ? cell_count : 2 * cell_count

      // Atom attributes stay per-site and advance once per replica cell.
      // Compact bond attributes stay per-bond and serve both half-bond draws,
      // so they advance once per (2 × replica cell count) instance group.
      expect(initial_attr.meshPerAttribute).toBe(expected_divisor(1))
      let previous_attr = initial_attr

      for (const [button, expected_cells] of [
        [`factor-2`, 2],
        [`factor-8`, 8],
        [`factor-1`, 1],
      ] as const) {
        await click(dom, button)
        expect(instanced_meshes(scene)).toHaveLength(0)
        expect(visible_meshes(scene)).toEqual([main])
        expect(main.geometry).toBe(geometry)
        expect(main.material).toBe(material)
        // Factor changes install a FRESH attribute object (identity-based VAO
        // rebind — the only divisor change Three's binding-state cache
        // detects) over the SAME base-sized backing array.
        const live_attr = geometry.getAttribute(attr_name) as
          THREE.InstancedBufferAttribute
        expect(live_attr).not.toBe(previous_attr)
        expect(live_attr.array).toBe(base_array)
        expect(live_attr.meshPerAttribute).toBe(
          expected_divisor(expected_cells),
        )
        previous_attr = live_attr

        // The render boundary must be inert: the retired resetState() VAO
        // hack reset renderer-global state mid-frame (correct on ANGLE only —
        // on desktop WebKitGTK it vanished the draw until a remount). Start an
        // offscreen pass with a custom target/viewport/scissor and prove the
        // hook leaves ALL of it untouched.
        activate_render_target()
        const before_resets = resetState.mock.calls.length
        const before_target_restores = setRenderTarget.mock.calls.length
        const before_viewport_writes = setViewport.mock.calls.length
        const before_scissor_writes = setScissor.mock.calls.length
        const before_scissor_test_writes = setScissorTest.mock.calls.length
        invoke_before_render(main, renderer, scene)
        expect(resetState).toHaveBeenCalledTimes(before_resets)
        expect(setRenderTarget).toHaveBeenCalledTimes(before_target_restores)
        expect(setViewport).toHaveBeenCalledTimes(before_viewport_writes)
        expect(setScissor).toHaveBeenCalledTimes(before_scissor_writes)
        expect(setScissorTest).toHaveBeenCalledTimes(before_scissor_test_writes)
        const pass = current_pass()
        expect(pass.target).toBe(renderTarget)
        expect(pass.cube_face).toBe(3)
        expect(pass.mip_level).toBe(2)
        expect(pass.viewport).toEqual(expected_pass.viewport)
        expect(pass.bookkeeping_viewport).toEqual(expected_pass.viewport)
        expect(pass.scissor).toEqual(expected_pass.scissor)
        expect(pass.scissor_test).toBe(expected_pass.scissor_test)
        if (mode === `bond`) {
          const uniforms = (main.material as THREE.ShaderMaterial).uniforms
          expect(uniforms.uViewport.value).toEqual(expected_pass.viewport)
          const ghost_draws = meshes(scene).filter((mesh) => mesh !== main)
          expect(ghost_draws.length).toBeGreaterThan(0)
          for (const ghost of ghost_draws) {
            invoke_before_render(ghost, renderer, scene)
            expect(uniforms.uViewport.value).toEqual(expected_pass.viewport)
          }
        }
      }
    })
  })
}

describe(`packet-path activation from a previously mounted static state`, () => {
  test(`legacy 1×1×1 → packet supercell renders atoms without a remount`, async () => {
    // Field flow (atom-vanish bug): a static structure renders on the legacy
    // InstancedMesh at 1×1×1; the FIRST visual-supercell factor swaps in the
    // packet path on the already-mounted component. Atoms must be fully built
    // immediately — no Visibility→Atoms off/on remount to recover.
    const { dom, renderer, resetState, scene } = await mount_manager(`atom`, true)

    // Legacy static path: exactly one InstancedMesh, no replica draw.
    expect(instanced_meshes(scene)).toHaveLength(1)

    await click(dom, `factor-2`)
    // Packet path owns the draw now — the legacy mesh (and its capacity-sized
    // instanceMatrix) is gone, and the replica geometry is fully sized.
    expect(instanced_meshes(scene)).toHaveLength(0)
    const main = visible_meshes(scene)[0]
    expect(main).toBeDefined()
    const geometry = main.geometry as THREE.InstancedBufferGeometry
    const first = geometry.getAttribute(`instanceSite`) as
      THREE.InstancedBufferAttribute
    expect(geometry.instanceCount).toBe(2 * 2)
    expect(first.count).toBe(2)
    expect(first.meshPerAttribute).toBe(2)

    await click(dom, `factor-8`)
    // Live factor change on the mounted renderer: fresh attribute identity
    // (natural VAO rebind) over the same base array, counts follow.
    const second = geometry.getAttribute(`instanceSite`) as
      THREE.InstancedBufferAttribute
    expect(second).not.toBe(first)
    expect(second.array).toBe(first.array)
    expect(second.meshPerAttribute).toBe(8)
    expect(geometry.instanceCount).toBe(2 * 8)
    invoke_before_render(main, renderer, scene)
    expect(resetState).not.toHaveBeenCalled()

    await click(dom, `factor-null`)
    // Dropping back to 1×1×1 static returns to the legacy path cleanly.
    expect(instanced_meshes(scene)).toHaveLength(1)
  })
})

describe(`replica manager live appearance props`, () => {
  test(`atom ghost opacity updates uniform + transparency without remount`, async () => {
    const { dom, scene } = await mount_manager(`atom`)
    const all_meshes = meshes(scene)
    expect(all_meshes).toHaveLength(2)
    const main = all_meshes.find((mesh) => mesh.visible)!
    const ghost = all_meshes.find((mesh) => !mesh.visible)!
    const main_geometry = main.geometry
    const main_material = main.material
    const ghost_material = ghost.material as THREE.ShaderMaterial

    expect(ghost_material.uniforms.uOpacityScale.value).toBeCloseTo(0.2)
    expect(ghost_material.transparent).toBe(true)
    expect(ghost_material.depthWrite).toBe(false)
    expect(ghost_material.alphaToCoverage).toBe(false)

    await click(dom, `appearance`)

    expect(main.geometry).toBe(main_geometry)
    expect(main.material).toBe(main_material)
    expect(ghost.material).toBe(ghost_material)
    expect(ghost_material.uniforms.uOpacityScale.value).toBeCloseTo(0.65)
    expect(ghost_material.transparent).toBe(true)
    expect(ghost_material.depthWrite).toBe(false)
    expect(ghost_material.alphaToCoverage).toBe(false)
  })

  test(`bond opacity/stub/ghost props update live without remount`, async () => {
    const { dom, scene } = await mount_manager(`bond`)
    const all_meshes = meshes(scene)
    expect(all_meshes).toHaveLength(2)
    const main = all_meshes.find((mesh) => mesh.visible)!
    const ghost = all_meshes.find((mesh) => !mesh.visible)!
    const geometry = main.geometry
    const material = main.material as THREE.ShaderMaterial
    const ghost_material = ghost.material as THREE.ShaderMaterial

    expect(material.uniforms.uStubScale.value).toBeCloseTo(0.25)
    expect(material.uniforms.uOpacity.value).toBeCloseTo(0.8)
    expect(ghost_material.uniforms.uOpacity.value).toBeCloseTo(0.2)
    expect(ghost_material.transparent).toBe(true)
    expect(ghost_material.depthWrite).toBe(false)
    expect(ghost_material.alphaToCoverage).toBe(false)

    await click(dom, `appearance`)

    expect(main.geometry).toBe(geometry)
    expect(main.material).toBe(material)
    expect(ghost.material).toBe(ghost_material)
    expect(material.uniforms.uStubScale.value).toBeCloseTo(0.75)
    expect(material.uniforms.uOpacity.value).toBeCloseTo(0.4)
    expect(ghost_material.uniforms.uOpacity.value).toBeCloseTo(0.65)
    expect(ghost_material.transparent).toBe(true)
    expect(ghost_material.depthWrite).toBe(false)
    expect(ghost_material.alphaToCoverage).toBe(false)
  })
})

describe(`packet-path material style (#533)`, () => {
  test(`Appearance → Material reaches the replica impostor uniforms live`, async () => {
    const { dom, scene } = await mount_manager(`atom`)
    const main = meshes(scene).find((mesh) => mesh.visible)!
    const material = main.material as THREE.ShaderMaterial
    // Default glossy → branch 0 with the dielectric GGX profile.
    expect(material.uniforms.uRenderStyle.value).toBe(0)
    expect(material.uniforms.uRoughness.value).toBeCloseTo(0.2)
    expect(material.uniforms.uMetalness.value).toBeCloseTo(0)

    await click(dom, `style-toon`)
    expect(main.material).toBe(material) // uniform switch, no material swap
    expect(material.uniforms.uRenderStyle.value).toBe(2)

    await click(dom, `style-metallic`)
    expect(material.uniforms.uRenderStyle.value).toBe(0)
    expect(material.uniforms.uRoughness.value).toBeCloseTo(0.4)
    expect(material.uniforms.uMetalness.value).toBeCloseTo(0.4)
  })
})
