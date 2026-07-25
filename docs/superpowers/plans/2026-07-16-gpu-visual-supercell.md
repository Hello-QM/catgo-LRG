# GPU Visual Supercell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bottom-right visual supercell correct through trajectory playback without CPU-materializing replicas, while rendering atoms, bonds, ghosts, selection, and picking through GPU impostors on WebGPU and WebGL2.

**Architecture:** A shared `RenderPacket` separates immutable base topology, current frame geometry, and replica layout. Both adapters consume only this packet. Visual replication changes uniforms/instance counts; scientific structure, cell, export, and base bond detection remain unchanged.

**Tech Stack:** TypeScript, Svelte 5, Three.js/WebGL2, WebGPU/WGSL, Vitest, Playwright.

## Global Constraints

- Visual replication keeps exactly N sites and 3N position floats on the CPU.
- Variable-cell frames use the current frame lattice.
- Periodic self-image edges are valid.
- Visual exports serialize the base scientific frame; raster/video capture the visible replicated scene.
- Do not edit true Build supercell semantics in this plan except at the explicit integration seam.

---

## Task 1: Introduce the shared RenderPacket and replica oracle

**Files:**

- Create: `src/lib/structure/scene/render-packet.ts`
- Create: `src/lib/structure/scene/replica-layout.ts`
- Modify: `src/lib/structure/scene/index.ts`
- Test: `tests/vitest/structure/scene/render-packet.test.ts`
- Test: `tests/vitest/structure/scene/replica-layout.test.ts`

**Interfaces:** Use the exact `BaseTopology`, `BaseBondGraph`, `FrameGeometry`, `ReplicaLayout`, `RenderPacket`, `ImageInstanceTable`, and `ReplicaPickResult` definitions in the approved design. Export `assert_render_packet`, `diff_render_packet`, `decode_replica_instance`, `replica_translation`, `resolve_periodic_edge`, `build_image_instance_table`, and `logical_site_for_pick`.

- [ ] Write failing tests for 3N validation, replica-only non-invalidation, variable lattice, instance decode, current-lattice translation, self-image edges, all four boundary policies, and logical/physical picking.
- [ ] Run `pnpm exec vitest run tests/vitest/structure/scene/render-packet.test.ts tests/vitest/structure/scene/replica-layout.test.ts --reporter=verbose`; verify modules are missing.
- [ ] Implement allocation-free pure helpers with atom-major instance order.
- [ ] Re-run tests and commit with `feat(render): define shared render packet`.

## Task 2: Build packets once and replace appended PBC images with a sparse table

**Files:**

- Create: `src/lib/structure/scene/render-packet-builder.ts`
- Modify: `src/lib/structure/pbc-image-atoms.ts`
- Modify: `src/lib/structure/workers/bond-worker-api.ts`
- Modify: `src/lib/structure/bond-computation-controller.svelte.ts`
- Modify: `src/lib/structure/Structure.svelte`
- Test: `tests/vitest/structure/scene/render-packet-builder.test.ts`
- Modify: `tests/vitest/structure/trajectory-bond-pairs.test.ts`

- [ ] Add failing tests `visual 2x2x2 packet keeps topology atom_count N and positions 3N`, `variable-cell frame uses frame lattice`, `ghost table deduplicates base_site+jimage`, and typed/object conversion self-edge retention.
- [ ] Run the two targeted test files and verify failures.
- [ ] Produce one packet from effective frame owner/position version/lattice/topology. Convert PBC image metadata to a sparse typed table and stop appending image sites on the packet path.
- [ ] Remove filters that discard `a === b` when `jimage !== [0,0,0]`.
- [ ] Re-run tests and commit with `fix(render): preserve base topology for replicas`.

## Task 3: Adapt the WebGPU renderer to packet versions

**Files:**

- Modify: `src/lib/structure/gpu/large-system-renderer.ts`
- Modify: `src/lib/structure/gpu/LargeSystemOverlay.svelte`
- Test: `tests/vitest/structure/gpu/webgpu-render-packet.test.ts`
- Modify: `tests/vitest/structure/gpu/large-system-renderer.test.ts`

**Interface produced:**

```ts
export interface LargeSystemRenderer {
  set_packet(packet: RenderPacket, images: ImageInstanceTable): void
  set_selection(base_sites: Uint32Array | number[]): void
  pick(x: number, y: number): Promise<ReplicaPickResult>
  get_diagnostics(): ReplicaRendererDiagnostics
  render(): void
  resize(width: number, height: number): void
  destroy(): void
}
```

- [ ] Add failing tests that a replica-only packet updates indirect counts without bond dispatch, frame packet uploads only base positions/current lattice, 2×2×2 preserves pair/grid capacity, ghosts upload sparsely, and self-edges reach draw.
- [ ] Run targeted tests and verify old setter fan-out and overlay reverse-read fail.
- [ ] Upload topology only on topology version, positions+lattice only on frame version, and dims/policy/indirect count only on replica version. Remove `get_displayed_frame_positions` reverse-read.
- [ ] Make pick target return kind/index/cell/ghost and decode with Task 1 helpers.
- [ ] Re-run tests and commit with `refactor(webgpu): consume render packets`.

## Task 4: Add WebGL2 atom and bond replica impostors

**Files:**

- Create: `src/lib/structure/gpu/webgl2/atom-replica-renderer.ts`
- Create: `src/lib/structure/gpu/webgl2/bond-replica-renderer.ts`
- Create: `src/lib/structure/gpu/WebGLReplicaLayer.svelte`
- Modify: `src/lib/structure/atoms/AtomManagerInstances.svelte`
- Modify: `src/lib/structure/atoms/atom-instanced-renderer.ts`
- Modify: `src/lib/structure/bonding/BondManagerInstances.svelte`
- Modify: `src/lib/structure/bonding/bond-instanced-renderer.ts`
- Test: `tests/vitest/structure/gpu/webgl2-replica-atoms.test.ts`
- Test: `tests/vitest/structure/gpu/webgl2-replica-bonds.test.ts`

- [ ] Add failing assertions that no `instanceMatrix` exists, base attributes remain N/2B sized, 2×2×2 sets 8N/16B instances, factor changes reuse buffers, and internal/stub/hide/ghost/self-image behavior matches the oracle.
- [ ] Run both tests and verify current `InstancedMesh` behavior fails.
- [ ] Use `Mesh + InstancedBufferGeometry.instanceCount`, base-size attribute buffers, `gl_InstanceID` replica decode, current-lattice uniforms, and a flat ray-cylinder bond impostor. Use a sparse second draw for ghosts.
- [ ] Re-run tests and commit with `feat(webgl): add replica impostor fast path`.

## Task 5: Unify GPU picking and base-site selection

**Files:**

- Create: `src/lib/structure/gpu/webgl2/replica-id-picker.ts`
- Modify: `src/lib/structure/gpu-picker.ts`
- Modify: `src/lib/structure/gpu-picker-integration.svelte.ts`
- Modify: `src/lib/structure/StructureScene.svelte`
- Modify: `src/lib/structure/gpu/large-system-renderer.ts`
- Test: `tests/vitest/structure/gpu/replica-picking.test.ts`

- [ ] Write failing tests for the same base atom in different cells, ghost-to-base mapping, one base selection flag, bond graph index picking, and zero N×C CPU matrices.
- [ ] Run the targeted test and verify failure.
- [ ] Implement integer GPU ID passes in both adapters. Store base-site selection for visual layouts and distinct physical IDs only for `physical-distinct-sites` provenance.
- [ ] Remove/gate invisible CPU sphere/cylinder hitboxes on the packet path.
- [ ] Re-run tests and commit with `feat(picking): map visual replicas to base sites`.

## Task 6: Integrate view-only semantics and base scientific export

**Files:**

- Modify: `src/lib/structure/controllers/transform-controller.svelte.ts`
- Modify: `src/lib/structure/Structure.svelte`
- Modify: `src/lib/structure/StructureScene.svelte`
- Modify: `src/lib/structure/ExportPane.svelte`
- Create: `src/lib/structure/scene/render-surface.ts`
- Test: `tests/vitest/structure/visual-supercell-integration.test.svelte.ts`
- Modify: `tests/vitest/structure/StructureExportPane.test.ts`
- Modify: `tests/vitest/structure/controllers.test.ts`

- [ ] Add failing tests that factor 1→8 changes only layout, backend choice does not change scientific structure, POSCAR/XYZ/CIF ignore visual dims, raster capture chooses the active replicated canvas, and images do not append sites.
- [ ] Run targeted tests and verify current CPU materialization/export behavior fails.
- [ ] Make bottom-right `supercell_scaling` build only `ReplicaLayout`; keep displayed/saveable scientific structure at the base effective frame. Remove renderer mode from semantic routing and remove visual-supercell scientific export expansion.
- [ ] Mark canvases with `data-render-backend` and `data-render-active`; select the active canvas for PNG/video.
- [ ] Re-run tests and commit with `fix(supercell): keep visual replication view-only`.

## Task 7: Browser and resource acceptance

**Files:**

- Create: `tests/e2e/trajectory-supercell-gpu.spec.ts`
- Create: `tests/e2e/helpers/renderer-diagnostics.ts`

- [ ] Cover exact `dump.traj` frames 5 and 99, rapid 5→99→5, play/pause/scrub, 1×1×1/2×1×1/2×2×2, forced WebGPU and WebGL2, attached bond endpoints, base-site picking, one visible canvas, stable bond dispatch/capacity, and stable resource counters.
- [ ] Run `DUMP_TRAJ=/home/james0001/Downloads/dump.traj pnpm exec playwright test tests/e2e/trajectory-supercell-gpu.spec.ts --workers=1`.
- [ ] Run `pnpm check` and commit with `test(supercell): cover gpu visual trajectory path`.

