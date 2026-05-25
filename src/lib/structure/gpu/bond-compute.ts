/// <reference types="@webgpu/types" />
/** Bond-detection compute pipeline: wraps BOND_COMPUTE_WGSL into a GPU compute
 *  pass (storage buffers, bind group, uniform packing, dispatch, readback).
 *  Readback is for tests + the future on-pause CPU bridge, NOT the playback loop. */
import { BOND_COMPUTE_WGSL } from '$lib/structure/gpu/bond-compute.wgsl'

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

/** Result of a bond-compute run.
 *  - `count` is the number of pairs actually returned (clamped to `capacity`).
 *  - `pairs` holds `count` entries.
 *  - `raw_count` is the unclamped count the shader atomically accumulated; it may
 *    exceed `capacity` because the shader `atomicAdd`s before checking the slot.
 *  - `overflowed` is true when `raw_count > capacity`, meaning some pairs were
 *    silently dropped and the caller should resize (`capacity`) and rerun. */
export type BondComputeResult = {
  count: number
  pairs: { a: number; b: number; jimage: [number, number, number] }[]
  overflowed: boolean
  raw_count: number
}

/** Size of the packed Params uniform. WGSL pads each mat3x3 column (vec3) to 16
 *  bytes, so the matrix spans bytes 32..80 and the struct is 80 bytes total. */
export const PARAMS_BYTES = 80

/** Pack the Params uniform (80 bytes). The lattice is uploaded TRANSPOSED so the
 *  WGSL column-major mat3x3 columns equal the row-major lattice rows a,b,c:
 *  column k (f32 offsets 8/12/16, each 3 floats + 1 pad) = lattice row k. */
export function pack_params(n: number, capacity: number, r: BondComputeRun): ArrayBuffer {
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
  return buf
}

/** Unpack a packed jimage u32 -> [na,nb,nc] in {-1,0,1}.
 *  pack = (na+1) | ((nb+1)<<2) | ((nc+1)<<4). */
export function unpack_jimage(p: number): [number, number, number] {
  return [(p & 3) - 1, ((p >> 2) & 3) - 1, ((p >> 4) & 3) - 1]
}

/** Create a reusable bond-detection compute pipeline for a fixed output capacity.
 *  Buffers sized for `capacity` pairs are allocated per-run (positions/radii vary
 *  in length); the pipeline + bind-group layout are built once. */
export function create_bond_compute(device: GPUDevice, cfg: { capacity: number }) {
  const { capacity } = cfg
  const module = device.createShaderModule({ code: BOND_COMPUTE_WGSL })
  const pipeline = device.createComputePipeline({
    layout: `auto`,
    compute: { module, entryPoint: `detect_bonds` },
  })

  return {
    async run(r: BondComputeRun): Promise<BondComputeResult> {
      const n = r.radii.length
      const pairs_bytes = capacity * 3 * 4

      // Declared before the try so finally can destroy whatever was created,
      // even if buffer creation throws partway. run() is called repeatedly
      // (the on-pause bridge), so a leak on the mapAsync error path would
      // accumulate GPU memory.
      let positions_buf: GPUBuffer | undefined
      let radii_buf: GPUBuffer | undefined
      let params_buf: GPUBuffer | undefined
      let pairs_buf: GPUBuffer | undefined
      let count_buf: GPUBuffer | undefined
      let elem_ids_buf: GPUBuffer | undefined
      let rules_buf: GPUBuffer | undefined
      let count_read: GPUBuffer | undefined
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
        device.queue.writeBuffer(params_buf, 0, pack_params(n, capacity, r))

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

        const bind_group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: positions_buf } },
            { binding: 1, resource: { buffer: radii_buf } },
            { binding: 2, resource: { buffer: params_buf } },
            { binding: 3, resource: { buffer: pairs_buf } },
            { binding: 4, resource: { buffer: count_buf } },
            { binding: 5, resource: { buffer: elem_ids_buf } },
            { binding: 6, resource: { buffer: rules_buf } },
          ],
        })

        count_read = device.createBuffer({
          size: 4,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        pairs_read = device.createBuffer({
          size: pairs_bytes,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })

        const encoder = device.createCommandEncoder()
        const pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bind_group)
        pass.dispatchWorkgroups(Math.max(1, Math.ceil(n / 64)))
        pass.end()
        encoder.copyBufferToBuffer(count_buf, 0, count_read, 0, 4)
        encoder.copyBufferToBuffer(pairs_buf, 0, pairs_read, 0, pairs_bytes)
        device.queue.submit([encoder.finish()])

        await count_read.mapAsync(GPUMapMode.READ)
        const raw_count = new Uint32Array(count_read.getMappedRange())[0]
        count_read.unmap()
        const count = Math.min(raw_count, capacity)
        const overflowed = raw_count > capacity

        await pairs_read.mapAsync(GPUMapMode.READ)
        const pairs_data = new Uint32Array(pairs_read.getMappedRange().slice(0))
        pairs_read.unmap()

        const pairs: BondComputeResult[`pairs`] = []
        for (let s = 0; s < count; s++) {
          const a = pairs_data[s * 3 + 0]
          const b = pairs_data[s * 3 + 1]
          pairs.push({ a, b, jimage: unpack_jimage(pairs_data[s * 3 + 2]) })
        }

        return { count, pairs, overflowed, raw_count }
      } finally {
        positions_buf?.destroy()
        radii_buf?.destroy()
        params_buf?.destroy()
        pairs_buf?.destroy()
        count_buf?.destroy()
        elem_ids_buf?.destroy()
        rules_buf?.destroy()
        count_read?.destroy()
        pairs_read?.destroy()
      }
    },
  }
}
