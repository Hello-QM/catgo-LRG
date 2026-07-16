/// <reference types="@webgpu/types" />
/** Bond-detection compute pipeline: wraps the bond WGSL modules into a GPU
 *  compute pass (storage buffers, bind group, uniform packing, dispatch,
 *  readback). Readback is for tests + the future on-pause CPU bridge, NOT the
 *  playback loop.
 *
 *  Routing (design §8.2): `plan_bond_dispatch` decides the path CPU-side —
 *  tiny systems take the DIRECT all-pairs shader, everything else the uniform
 *  GRID shader, and periodic thin cells / over-budget grids REFUSE with a
 *  typed `requires-rust-wasm` outcome (never a silent all-pairs fallback).
 *
 *  Lossless overflow: a run whose cell occupancy exceeds the stride or whose
 *  raw pair count exceeds capacity is INCOMPLETE — it is never returned as a
 *  result. The run controller grows the sizing to the next power of two and
 *  reruns, bounded by allocation limits; hitting a limit returns a typed
 *  `allocation-limit` outcome instead of a clamped graph. */
import {
  BOND_COMPUTE_DIRECT_WGSL,
  BOND_COMPUTE_WGSL,
} from '$lib/structure/gpu/bond-compute.wgsl'
import {
  type BondGpuDiagnostics,
  type BondOverflowLimits,
  create_bond_run_controller,
} from '$lib/structure/gpu/bond-diagnostics'
import { type GridPlan, MAX_PER_CELL } from '$lib/structure/gpu/bond-grid'
import {
  MAX_DIRECT_ATOMS,
  plan_bond_dispatch,
} from '$lib/structure/workers/bond-backend-policy'

export type BondComputeRun = {
  tolerance: number
  max_bond_dist: number
  min_dist: number
  positions: Float32Array // 3N, xyz interleaved
  radii: Float32Array // N
  lattice: Float32Array // 9, row-major (rows a,b,c)
  periodic: boolean
  /** Per-atom element id (N). Optional — defaults to all-zero (no rule matches
   *  any pair, so behaviour is identical to no rules). Shares its id mapping
   *  with `rules` (see bond-rules.ts encode_bond_rules). */
  elem_ids?: Uint32Array
  /** Packed element-pair distance rules: 4 floats per rule
   *  [id_a, id_b, min, max] with id_a ≤ id_b. Optional — defaults to empty
   *  (rule_count 0 ⇒ the shader applies no post-filter). */
  rules?: Float32Array
}

/** A COMPLETE bond-compute result (nothing dropped): `count` pairs, with
 *  `raw_count === count` — overflowed runs are rerun internally, never
 *  returned. `overflowed` is retained for shape compatibility and is always
 *  false on a returned result. */
export type BondComputeResult = {
  count: number
  pairs: { a: number; b: number; jimage: [number, number, number] }[]
  overflowed: boolean
  raw_count: number
}

/** Typed outcome of one bond-compute request (design §8.2):
 *  - `complete`: the published (lossless) graph + deterministic diagnostics.
 *  - `requires-rust-wasm`: the GPU path REFUSES this system (periodic thin
 *    cell / grid storage over budget); the caller must hand off to the Rust
 *    WASM backend — there is no all-pairs fallback for large N.
 *  - `allocation-limit`: overflow growth exceeded the bounded limits; no
 *    (incomplete) graph is returned, the caller keeps its active graph. */
export type BondComputeOutcome =
  | ({ status: 'complete' } & BondComputeResult & {
    diagnostics: BondGpuDiagnostics
  })
  | {
    status: 'requires-rust-wasm'
    reason: 'periodic-thin-cell' | 'grid-storage-limit'
  }
  | { status: 'allocation-limit'; message: string; diagnostics: BondGpuDiagnostics }

/** Size of the packed Params uniform. WGSL pads each mat3x3 column (vec3) to 16
 *  bytes, so the matrix spans bytes 32..80. The uniform-grid block (vec3+u32 dims,
 *  vec3+u32 aabb/stride, f32+3pad) appends three 16-byte rows ⇒ bytes 80..128. */
export const PARAMS_BYTES = 128

/** Pack the Params uniform (128 bytes). The lattice is uploaded TRANSPOSED so the
 *  WGSL column-major mat3x3 columns equal the row-major lattice rows a,b,c:
 *  column k (f32 offsets 8/12/16, each 3 floats + 1 pad) = lattice row k.
 *  `grid` (optional) appends the uniform-grid sizing the grid WGSL reads (dims,
 *  aabb_min, cell_stride = grid.max_per_cell, inv_h). Word 23 records the plan's
 *  grid-usable flag as a DIAGNOSTIC only — no shader branches on it; routing is
 *  decided CPU-side by plan_bond_dispatch. When `grid` is omitted the grid block
 *  packs zeros (the small-N direct shader never reads it). */
export function pack_params(
  n: number,
  capacity: number,
  r: BondComputeRun,
  grid?: GridPlan,
): ArrayBuffer {
  const buf = new ArrayBuffer(PARAMS_BYTES)
  const u32 = new Uint32Array(buf)
  const f32 = new Float32Array(buf)
  u32[0] = n
  u32[1] = capacity
  u32[2] = r.periodic ? 1 : 0
  u32[3] = 0
  f32[4] = r.tolerance
  f32[5] = r.max_bond_dist
  f32[6] = r.min_dist
  // u32[7] = rule_count (number of element-pair distance rules). 0 ⇒ no filter.
  u32[7] = r.rules ? r.rules.length / 4 : 0
  const L = r.lattice
  // Transpose: WGSL reads lattice[k] as column k; write row k into column k.
  // Column 0 = row a (L[0..2]), column 1 = row b (L[3..5]), column 2 = row c (L[6..8]).
  f32[8] = L[0]; f32[9] = L[1]; f32[10] = L[2]; f32[11] = 0
  f32[12] = L[3]; f32[13] = L[4]; f32[14] = L[5]; f32[15] = 0
  f32[16] = L[6]; f32[17] = L[7]; f32[18] = L[8]; f32[19] = 0
  // ── Uniform-grid block (f32/u32 words 20..31; bytes 80..128) ──
  // word 20-22 = grid_dims.xyz (u32), word 23 = grid-usable flag (diagnostic)
  // word 24-26 = aabb_min.xyz (f32), word 27 = cell_stride (u32)
  // word 28 = inv_h (f32), words 29-31 = pad
  if (grid) {
    u32[20] = grid.dims[0]; u32[21] = grid.dims[1]; u32[22] = grid.dims[2]
    u32[23] = grid.use_grid ? 1 : 0
    f32[24] = grid.aabb_min[0]; f32[25] = grid.aabb_min[1]; f32[26] = grid.aabb_min[2]
    u32[27] = grid.max_per_cell
    f32[28] = grid.inv_h
  }
  return buf
}

/** Pack the full signed Int8 jimage range into three biased u8 lanes. */
export function pack_jimage(na: number, nb: number, nc: number): number {
  return (na + 128) | ((nb + 128) << 8) | ((nc + 128) << 16)
}

/** Unpack three biased u8 lanes into the declared signed Int8 jimage range. */
export function unpack_jimage(p: number): [number, number, number] {
  return [(p & 0xff) - 128, ((p >> 8) & 0xff) - 128, ((p >> 16) & 0xff) - 128]
}

/** One dispatch attempt's readback: the unclamped pair count, the max observed
 *  cell occupancy (0 on the direct path), and the raw pairs data. */
type AttemptReadback = {
  raw_count: number
  occupancy: number
  pairs_data: Uint32Array
}

/** Create a reusable bond-detection compute pipeline.
 *  - `capacity` is the STARTING pair capacity; overflow grows it (nextPow2) and
 *    reruns within `limits`.
 *  - `direct_limit` caps the small-N direct all-pairs path (default
 *    MAX_DIRECT_ATOMS; tests pass 0 to force the grid).
 *  Buffers are allocated per-attempt (positions/radii vary in length and
 *  overflow retries resize); the pipelines + bind-group layout are built once. */
export function create_bond_compute(
  device: GPUDevice,
  cfg: {
    capacity: number
    direct_limit?: number
    limits?: Partial<BondOverflowLimits>
  },
) {
  const grid_module = device.createShaderModule({ code: BOND_COMPUTE_WGSL })
  const direct_module = device.createShaderModule({ code: BOND_COMPUTE_DIRECT_WGSL })
  // Explicit bind-group layout shared by all passes (clear/bin/detect/direct)
  // so ONE bind group binds every pipeline. `auto` layout would give each entry
  // point its own layout (only the bindings it uses), so the bind groups wouldn't
  // be interchangeable; an explicit layout with all 10 bindings avoids that. (A
  // layout may declare bindings a shader doesn't use — the direct module only
  // declares 0-6.)
  const storage = (rw: boolean): GPUBindGroupLayoutEntry[`buffer`] => ({
    type: rw ? `storage` : `read-only-storage`,
  })
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: storage(false) },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: storage(false) },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: `uniform` } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: storage(true) },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: storage(true) },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: storage(false) },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: storage(false) },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: storage(true) },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: storage(true) },
      { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: storage(true) },
    ],
  })
  const compute_layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] })
  const detect_pipeline = device.createComputePipeline({
    layout: compute_layout,
    compute: { module: grid_module, entryPoint: `detect_bonds` },
  })
  const clear_pipeline = device.createComputePipeline({
    layout: compute_layout,
    compute: { module: grid_module, entryPoint: `clear_grid` },
  })
  const bin_pipeline = device.createComputePipeline({
    layout: compute_layout,
    compute: { module: grid_module, entryPoint: `bin_atoms` },
  })
  const direct_pipeline = device.createComputePipeline({
    layout: compute_layout,
    compute: { module: direct_module, entryPoint: `detect_bonds` },
  })

  /** One full dispatch + readback at the given sizing. Allocates and destroys
   *  its own buffers (declared before the try so finally can destroy whatever
   *  was created, even if buffer creation throws partway — run() is called
   *  repeatedly, so a leak on the mapAsync error path would accumulate). */
  async function attempt(
    r: BondComputeRun,
    n: number,
    grid: GridPlan | null,
    cell_stride: number,
    capacity: number,
  ): Promise<AttemptReadback> {
    const pairs_bytes = capacity * 3 * 4

    let positions_buf: GPUBuffer | undefined
    let radii_buf: GPUBuffer | undefined
    let params_buf: GPUBuffer | undefined
    let pairs_buf: GPUBuffer | undefined
    let count_buf: GPUBuffer | undefined
    let elem_ids_buf: GPUBuffer | undefined
    let rules_buf: GPUBuffer | undefined
    let cell_count_buf: GPUBuffer | undefined
    let cell_atoms_buf: GPUBuffer | undefined
    let grid_meta_buf: GPUBuffer | undefined
    let count_read: GPUBuffer | undefined
    let meta_read: GPUBuffer | undefined
    let pairs_read: GPUBuffer | undefined

    try {
      positions_buf = device.createBuffer({
        size: Math.max(r.positions.byteLength, 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(positions_buf, 0, r.positions as BufferSource)

      radii_buf = device.createBuffer({
        size: Math.max(r.radii.byteLength, 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(radii_buf, 0, r.radii as BufferSource)

      params_buf = device.createBuffer({
        size: PARAMS_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      // The grid's max_per_cell is overridden with the (possibly grown) stride
      // — cell_stride is a uniform precisely so retries need no shader rebuild.
      device.queue.writeBuffer(
        params_buf,
        0,
        pack_params(
          n,
          capacity,
          r,
          grid ? { ...grid, max_per_cell: cell_stride } : undefined,
        ),
      )

      pairs_buf = device.createBuffer({
        size: pairs_bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      })

      count_buf = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(count_buf, 0, new Uint32Array([0]))

      // Per-atom element ids (binding 5). Optional: default to all-zero (size n)
      // so the rule scan sees every atom with id 0 — harmless because with no
      // rules (rule_count 0) the scan is skipped entirely.
      const elem_ids = r.elem_ids ?? new Uint32Array(n)
      elem_ids_buf = device.createBuffer({
        size: Math.max(elem_ids.byteLength, 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(elem_ids_buf, 0, elem_ids as BufferSource)

      // Packed element-pair rules (binding 6). Optional: default empty ⇒ the
      // shader reads rule_count 0 from Params and applies no post-filter. A
      // 4-byte minimum keeps the (read-only) storage binding non-empty.
      const rules = r.rules ?? new Float32Array(0)
      rules_buf = device.createBuffer({
        size: Math.max(rules.byteLength, 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      if (rules.byteLength > 0) device.queue.writeBuffer(rules_buf, 0, rules as BufferSource)

      // ── Grid storage (bindings 7/8/9). Sized from the plan + current stride;
      // a 4-byte minimum keeps the bindings non-empty on the direct path where
      // the shader never touches them. grid_meta[0] = max observed occupancy
      // (zero-seeded so a direct run reads back 0 = no cell overflow). ──
      const n_cells = Math.max(1, grid?.n_cells ?? 1)
      cell_count_buf = device.createBuffer({
        size: Math.max(n_cells * 4, 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      cell_atoms_buf = device.createBuffer({
        size: Math.max(n_cells * cell_stride * 4, 4),
        usage: GPUBufferUsage.STORAGE,
      })
      grid_meta_buf = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(grid_meta_buf, 0, new Uint32Array([0]))

      const bind_group = device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: positions_buf } },
          { binding: 1, resource: { buffer: radii_buf } },
          { binding: 2, resource: { buffer: params_buf } },
          { binding: 3, resource: { buffer: pairs_buf } },
          { binding: 4, resource: { buffer: count_buf } },
          { binding: 5, resource: { buffer: elem_ids_buf } },
          { binding: 6, resource: { buffer: rules_buf } },
          { binding: 7, resource: { buffer: cell_count_buf } },
          { binding: 8, resource: { buffer: cell_atoms_buf } },
          { binding: 9, resource: { buffer: grid_meta_buf } },
        ],
      })

      count_read = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
      meta_read = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
      pairs_read = device.createBuffer({
        size: pairs_bytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })

      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      pass.setBindGroup(0, bind_group)
      if (grid) {
        // Three ordered grid passes in one submit: clear, bin, detect.
        pass.setPipeline(clear_pipeline)
        pass.dispatchWorkgroups(Math.max(1, Math.ceil(n_cells / 64)))
        pass.setPipeline(bin_pipeline)
        pass.dispatchWorkgroups(Math.max(1, Math.ceil(n / 64)))
        pass.setPipeline(detect_pipeline)
      } else {
        // Small-N direct path: a single exact all-pairs pass.
        pass.setPipeline(direct_pipeline)
      }
      pass.dispatchWorkgroups(Math.max(1, Math.ceil(n / 64)))
      pass.end()
      encoder.copyBufferToBuffer(count_buf, 0, count_read, 0, 4)
      encoder.copyBufferToBuffer(grid_meta_buf, 0, meta_read, 0, 4)
      encoder.copyBufferToBuffer(pairs_buf, 0, pairs_read, 0, pairs_bytes)
      device.queue.submit([encoder.finish()])

      await count_read.mapAsync(GPUMapMode.READ)
      const raw_count = new Uint32Array(count_read.getMappedRange())[0]
      count_read.unmap()

      await meta_read.mapAsync(GPUMapMode.READ)
      const occupancy = new Uint32Array(meta_read.getMappedRange())[0]
      meta_read.unmap()

      await pairs_read.mapAsync(GPUMapMode.READ)
      const pairs_data = new Uint32Array(pairs_read.getMappedRange().slice(0))
      pairs_read.unmap()

      return { raw_count, occupancy, pairs_data }
    } finally {
      positions_buf?.destroy()
      radii_buf?.destroy()
      params_buf?.destroy()
      pairs_buf?.destroy()
      count_buf?.destroy()
      elem_ids_buf?.destroy()
      rules_buf?.destroy()
      cell_count_buf?.destroy()
      cell_atoms_buf?.destroy()
      grid_meta_buf?.destroy()
      count_read?.destroy()
      meta_read?.destroy()
      pairs_read?.destroy()
    }
  }

  return {
    async run(r: BondComputeRun): Promise<BondComputeOutcome> {
      const n = r.radii.length
      const plan = plan_bond_dispatch({
        periodic: r.periodic,
        lattice: r.lattice,
        max_bond_dist: r.max_bond_dist,
        positions: r.positions,
        n,
        atom_count: n,
        direct_limit: cfg.direct_limit ?? MAX_DIRECT_ATOMS,
        max_storage_bytes: device.limits?.maxStorageBufferBindingSize ?? (1 << 27),
      })
      if (plan.kind === `rust-wasm`) {
        // REFUSE: a periodic thin cell / over-budget grid never falls back to
        // an all-pairs shader (design §8.2). The caller routes to Rust WASM.
        return { status: `requires-rust-wasm`, reason: plan.reason }
      }
      const grid = plan.kind === `gpu-grid` ? plan.grid : null

      const controller = create_bond_run_controller({
        cell_stride: grid?.max_per_cell ?? MAX_PER_CELL,
        pair_capacity: cfg.capacity,
        limits: cfg.limits,
      })
      controller.begin_graph()

      for (;;) {
        const stride = controller.cell_stride()
        const capacity = controller.pair_capacity()
        const got = await attempt(r, n, grid, stride, capacity)
        controller.record_dispatch(
          grid ? { clear: true, bin: true, detect: true } : { detect: true },
          grid?.dims,
        )
        const decision = controller.observe({
          raw_count: got.raw_count,
          max_observed_occupancy: got.occupancy,
        })
        if (decision.action === `publish`) {
          // Complete candidate: raw_count ≤ capacity, occupancy ≤ stride —
          // every detected pair is in the buffer.
          const pairs: BondComputeResult[`pairs`] = []
          for (let s = 0; s < got.raw_count; s++) {
            const a = got.pairs_data[s * 3 + 0]
            const b = got.pairs_data[s * 3 + 1]
            pairs.push({ a, b, jimage: unpack_jimage(got.pairs_data[s * 3 + 2]) })
          }
          return {
            status: `complete`,
            count: got.raw_count,
            pairs,
            overflowed: false,
            raw_count: got.raw_count,
            diagnostics: controller.diagnostics(),
          }
        }
        if (decision.action === `allocation-limit`) {
          return {
            status: `allocation-limit`,
            message: decision.message,
            diagnostics: controller.diagnostics(),
          }
        }
        // retry: the controller grew its stride/capacity — loop reruns with it.
      }
    },
  }
}
