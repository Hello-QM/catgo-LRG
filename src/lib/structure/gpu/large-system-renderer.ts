/// <reference types="@webgpu/types" />
/** WebGPU large-system render path (Task 9).
 *
 *  Milestone 9.1 — de-risking skeleton: clear-only pass + camera uniform upload.
 *  Milestone 9.2 — render the current frame's ATOMS as impostor spheres.
 *  A single instanced draw paints one screen-facing quad per atom; the fragment
 *  shader ray-traces a sphere inside the quad and writes correct clip-space depth
 *  so spheres occlude each other properly. No bonds / trajectory / picking yet —
 *  those arrive in later milestones. */

/** Camera uniform (legacy 9.1): 20 floats (proj*view + camPos + pad) = 80 bytes. */
const CAMERA_UNIFORM_BYTES = 80

/** Camera uniform (9.2 impostor): view(16) + proj(16) + camPos vec3 + pad = 36
 *  floats = 144 bytes. Matches pack_camera_full's layout. */
const CAMERA_FULL_BYTES = 144

/** A distinct dark background so flipping the toggle visibly swaps which canvas
 *  paints. Near-black with a faint blue tint. */
const CLEAR_COLOR: GPUColor = { r: 0.02, g: 0.03, b: 0.05, a: 1 }

const DEPTH_FORMAT: GPUTextureFormat = `depth24plus`

/** WGSL impostor-sphere shader. View-space billboard + per-fragment ray-sphere.
 *  - storage buffers: positions (3N), radii (N), colors (3N linear rgb)
 *  - camera uniform: view + proj (separate) + camPos
 *  Camera sits at the view-space origin, so the eye ray is just normalize(vpos). */
const IMPOSTOR_WGSL = `
struct Camera {
  view : mat4x4<f32>,
  proj : mat4x4<f32>,
  cam_pos : vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera : Camera;
@group(0) @binding(1) var<storage, read> positions : array<f32>;
@group(0) @binding(2) var<storage, read> radii : array<f32>;
@group(0) @binding(3) var<storage, read> colors : array<f32>;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) vc : vec3<f32>,      // view-space sphere center
  @location(1) radius : f32,
  @location(2) color : vec3<f32>,
  @location(3) vpos : vec3<f32>,    // view-space position of this quad corner
};

struct FsOut {
  @builtin(frag_depth) depth : f32,
  @location(0) color : vec4<f32>,
};

// Quad corners as a triangle-strip (4 verts): (-1,-1) (1,-1) (-1,1) (1,1)
fn corner_for(vi : u32) -> vec2<f32> {
  let x = select(-1.0, 1.0, (vi & 1u) == 1u);
  let y = select(-1.0, 1.0, (vi & 2u) == 2u);
  return vec2<f32>(x, y);
}

@vertex
fn vs_main(@builtin(vertex_index) vi : u32,
           @builtin(instance_index) inst : u32) -> VsOut {
  let center = vec3<f32>(
    positions[inst * 3u + 0u],
    positions[inst * 3u + 1u],
    positions[inst * 3u + 2u],
  );
  let r = radii[inst];
  let col = vec3<f32>(
    colors[inst * 3u + 0u],
    colors[inst * 3u + 1u],
    colors[inst * 3u + 2u],
  );

  let vc4 = camera.view * vec4<f32>(center, 1.0);
  let vc = vc4.xyz;

  let c = corner_for(vi);
  // Billboard in view space; bump radius slightly so the silhouette isn't clipped.
  let vpos = vc + vec3<f32>(c * r * 1.5, 0.0);
  var clip = camera.proj * vec4<f32>(vpos, 1.0);
  // three.js projectionMatrix uses GL NDC z in [-1,1]; WebGPU clip space needs
  // 0 <= z <= w (NDC z in [0,1]). Remap before returning @builtin(position).
  clip.z = (clip.z + clip.w) * 0.5;

  var out : VsOut;
  out.clip = clip;
  out.vc = vc;
  out.radius = r;
  out.color = col;
  out.vpos = vpos;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> FsOut {
  // Eye at view-space origin; ray through the interpolated view-space position.
  let ro = vec3<f32>(0.0, 0.0, 0.0);
  let rd = normalize(in.vpos);

  // Ray-sphere intersection: |ro + t*rd - vc|^2 = radius^2
  let oc = ro - in.vc;
  let b = dot(oc, rd);
  let c = dot(oc, oc) - in.radius * in.radius;
  let disc = b * b - c;
  if (disc < 0.0) {
    discard;
  }
  let t = -b - sqrt(disc); // near hit
  if (t < 0.0) {
    discard;
  }
  let p = ro + t * rd;            // view-space hit point
  let n = normalize(p - in.vc);   // surface normal

  let light_dir = normalize(vec3<f32>(0.3, 0.5, 0.8));
  let lighting = 0.35 + 0.65 * max(dot(n, light_dir), 0.0);

  // Correct depth: project the hit point, apply the same GL->WebGPU z remap as
  // the vertex stage, then perspective-divide into NDC z (WebGPU range 0..1).
  let clip_h = camera.proj * vec4<f32>(p, 1.0);
  let remapped_z = (clip_h.z + clip_h.w) * 0.5;

  var out : FsOut;
  out.depth = clamp(remapped_z / clip_h.w, 0.0, 1.0);
  out.color = vec4<f32>(in.color * lighting, 1.0);
  return out;
}
`

export type LargeSystemRenderer = {
  /** Upload a packed camera uniform (Float32Array(20), proj*view layout).
   *  Legacy 9.1 entry point; kept for back-compat. Not used by the impostor
   *  draw (which reads view+proj separately via set_camera_full). */
  set_camera(uniform: Float32Array): void
  /** Upload the full camera uniform (Float32Array(36): view + proj + camPos).
   *  This is what the impostor pipeline binds. */
  set_camera_full(uniform: Float32Array): void
  /** (Re)upload atom storage buffers. positions=3N, radii=N, colors=3N linear
   *  rgb. Buffers grow as needed; count drives the instanced draw. */
  set_atoms(
    positions: Float32Array,
    radii: Float32Array,
    colors: Float32Array,
    count: number,
  ): void
  /** Run one render pass: clear + (if atoms present) impostor sphere draw. */
  render(): void
  /** Resize the backing canvas + depth texture to device-pixel dimensions. */
  resize(w: number, h: number): void
  /** Tear down GPU resources and unconfigure the context. */
  destroy(): void
}

export function create_large_system_renderer(
  device: GPUDevice,
  canvas: HTMLCanvasElement,
): LargeSystemRenderer {
  const context = canvas.getContext(`webgpu`)
  if (!context) throw new Error(`WebGPU canvas context unavailable`)
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: `premultiplied` })

  // Full camera uniform (view + proj + camPos), bound by the impostor pipeline.
  const camera_buffer = device.createBuffer({
    label: `large-system-camera-full`,
    size: CAMERA_FULL_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  // Atom storage buffers — lazily (re)created when the atom count grows.
  let positions_buffer: GPUBuffer | null = null
  let radii_buffer: GPUBuffer | null = null
  let colors_buffer: GPUBuffer | null = null
  let atom_capacity = 0 // instances the current buffers can hold
  let atom_count = 0 // instances to draw this frame

  // Depth texture, sized to the canvas; recreated on resize.
  let depth_texture: GPUTexture | null = null
  let depth_view: GPUTextureView | null = null

  // Bind group depends on the storage buffers, so rebuild whenever they change.
  let bind_group: GPUBindGroup | null = null

  const shader = device.createShaderModule({
    label: `large-system-impostor`,
    code: IMPOSTOR_WGSL,
  })

  const bind_group_layout = device.createBindGroupLayout({
    label: `large-system-impostor-bgl`,
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: `uniform` } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: `read-only-storage` } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: `read-only-storage` } },
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: `read-only-storage` } },
    ],
  })

  const pipeline = device.createRenderPipeline({
    label: `large-system-impostor-pipeline`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [bind_group_layout] }),
    vertex: { module: shader, entryPoint: `vs_main` },
    fragment: { module: shader, entryPoint: `fs_main`, targets: [{ format }] },
    // Camera-facing billboards must never be back-face culled — winding flips
    // depending on view, so cull nothing.
    primitive: { topology: `triangle-strip`, cullMode: `none` },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: true,
      depthCompare: `less`,
    },
  })

  function ensure_depth(w: number, h: number): void {
    depth_texture?.destroy()
    depth_texture = device.createTexture({
      label: `large-system-depth`,
      size: { width: Math.max(1, w), height: Math.max(1, h) },
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    depth_view = depth_texture.createView()
  }
  ensure_depth(canvas.width || 1, canvas.height || 1)

  function rebuild_bind_group(): void {
    if (!positions_buffer || !radii_buffer || !colors_buffer) {
      bind_group = null
      return
    }
    bind_group = device.createBindGroup({
      label: `large-system-impostor-bg`,
      layout: bind_group_layout,
      entries: [
        { binding: 0, resource: { buffer: camera_buffer } },
        { binding: 1, resource: { buffer: positions_buffer } },
        { binding: 2, resource: { buffer: radii_buffer } },
        { binding: 3, resource: { buffer: colors_buffer } },
      ],
    })
  }

  let destroyed = false

  // TODO(9.2-debug) remove — capture the last full camera uniform + log once.
  let _dbg_last_cam: Float32Array | null = null
  let _dbg_logged_cam = false

  return {
    set_camera(uniform: Float32Array): void {
      if (destroyed) return
      // Legacy 80-byte (proj*view) upload into the first bytes; harmless — the
      // impostor draw uses set_camera_full. Guard against short/long arrays.
      const bytes = Math.min(uniform.byteLength, CAMERA_UNIFORM_BYTES)
      device.queue.writeBuffer(camera_buffer, 0, uniform.buffer, uniform.byteOffset, bytes)
    },
    set_camera_full(uniform: Float32Array): void {
      if (destroyed) return
      _dbg_last_cam = uniform // TODO(9.2-debug) remove
      const bytes = Math.min(uniform.byteLength, CAMERA_FULL_BYTES)
      device.queue.writeBuffer(camera_buffer, 0, uniform.buffer, uniform.byteOffset, bytes)
    },
    set_atoms(
      positions: Float32Array,
      radii: Float32Array,
      colors: Float32Array,
      count: number,
    ): void {
      if (destroyed) return
      // TODO(9.2-debug) remove
      console.log(`[lsr] set_atoms count=`, count, `pos0=`, Array.from(positions.slice(0, 3)), `r0=`, radii[0], `col0=`, Array.from(colors.slice(0, 3)))
      atom_count = Math.max(0, count)
      if (atom_count === 0) return

      // (Re)allocate when capacity is insufficient. Storage buffers must be at
      // least the byte length we write; grow with headroom to avoid churn.
      if (atom_count > atom_capacity) {
        const new_cap = Math.max(atom_count, Math.ceil(atom_capacity * 2), 1)
        positions_buffer?.destroy()
        radii_buffer?.destroy()
        colors_buffer?.destroy()
        positions_buffer = device.createBuffer({
          label: `large-system-positions`,
          size: new_cap * 3 * 4,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })
        radii_buffer = device.createBuffer({
          label: `large-system-radii`,
          size: new_cap * 4,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })
        colors_buffer = device.createBuffer({
          label: `large-system-colors`,
          size: new_cap * 3 * 4,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })
        atom_capacity = new_cap
        rebuild_bind_group()
      }

      device.queue.writeBuffer(
        positions_buffer as GPUBuffer, 0,
        positions.buffer, positions.byteOffset, atom_count * 3 * 4,
      )
      device.queue.writeBuffer(
        radii_buffer as GPUBuffer, 0,
        radii.buffer, radii.byteOffset, atom_count * 4,
      )
      device.queue.writeBuffer(
        colors_buffer as GPUBuffer, 0,
        colors.buffer, colors.byteOffset, atom_count * 3 * 4,
      )
    },
    render(): void {
      if (destroyed) return
      // TODO(9.2-debug) remove — log the camera uniform sample on the first frame.
      if (!_dbg_logged_cam && _dbg_last_cam) {
        _dbg_logged_cam = true
        const u = _dbg_last_cam
        console.log(
          `[lsr] cam uniform view0..3=`, Array.from(u.slice(0, 4)),
          `proj0..3=`, Array.from(u.slice(16, 20)),
          `camPos=`, Array.from(u.slice(32, 35)),
        )
      }
      if (!depth_view) ensure_depth(canvas.width || 1, canvas.height || 1)
      const encoder = device.createCommandEncoder({ label: `large-system-frame` })
      const view = context.getCurrentTexture().createView()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view,
            clearValue: CLEAR_COLOR,
            loadOp: `clear`,
            storeOp: `store`,
          },
        ],
        depthStencilAttachment: {
          view: depth_view as GPUTextureView,
          depthClearValue: 1.0,
          depthLoadOp: `clear`,
          depthStoreOp: `store`,
        },
      })
      if (atom_count > 0 && bind_group) {
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bind_group)
        pass.draw(4, atom_count) // triangle-strip quad, one instance per atom
      }
      pass.end()
      device.queue.submit([encoder.finish()])
    },
    resize(w: number, h: number): void {
      if (destroyed) return
      canvas.width = Math.max(1, Math.floor(w))
      canvas.height = Math.max(1, Math.floor(h))
      ensure_depth(canvas.width, canvas.height)
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      try {
        context.unconfigure()
      } catch {
        // some implementations / already-lost contexts may throw — ignore
      }
      camera_buffer.destroy()
      positions_buffer?.destroy()
      radii_buffer?.destroy()
      colors_buffer?.destroy()
      depth_texture?.destroy()
      positions_buffer = null
      radii_buffer = null
      colors_buffer = null
      depth_texture = null
      depth_view = null
      bind_group = null
    },
  }
}
