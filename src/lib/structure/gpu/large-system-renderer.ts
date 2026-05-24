/// <reference types="@webgpu/types" />
/** WebGPU large-system render path (Task 9).
 *
 *  Milestone 9.1 — de-risking skeleton: configures a webgpu canvas context,
 *  holds the camera uniform buffer (proving the upload path), and renders a
 *  single clear pass to a distinct dark-blue so the overlay canvas is visibly
 *  the one painting. No atom / bond geometry yet; this module grows in later
 *  milestones (atoms, then bonds via the existing bond-compute pipeline). */

/** Camera uniform: 20 floats (proj*view 4x4 + camera world pos vec3 + pad),
 *  matching Task 7's pack_camera_uniform layout. 20 * 4 bytes = 80. */
const CAMERA_UNIFORM_BYTES = 80

/** A distinct dark blue, intentionally different from the normal viewer
 *  background, so flipping the toggle visibly swaps which canvas paints. */
const CLEAR_COLOR: GPUColor = { r: 0.06, g: 0.1, b: 0.16, a: 1 }

export type LargeSystemRenderer = {
  /** Upload a packed camera uniform (Float32Array(20)). Stored only for now. */
  set_camera(uniform: Float32Array): void
  /** Run one render pass (clear-only this milestone). */
  render(): void
  /** Resize the backing canvas to the given device-pixel dimensions. */
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

  // Camera uniform buffer — written by set_camera, not yet bound for drawing.
  const camera_buffer = device.createBuffer({
    label: `large-system-camera-uniform`,
    size: CAMERA_UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  let destroyed = false

  return {
    set_camera(uniform: Float32Array): void {
      if (destroyed) return
      // Upload exactly CAMERA_UNIFORM_BYTES; guard against a short/long array.
      const bytes = Math.min(uniform.byteLength, CAMERA_UNIFORM_BYTES)
      device.queue.writeBuffer(camera_buffer, 0, uniform.buffer, uniform.byteOffset, bytes)
    },
    render(): void {
      if (destroyed) return
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
      })
      // No geometry yet — clear-only pass.
      pass.end()
      device.queue.submit([encoder.finish()])
    },
    resize(w: number, h: number): void {
      if (destroyed) return
      canvas.width = Math.max(1, Math.floor(w))
      canvas.height = Math.max(1, Math.floor(h))
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
    },
  }
}
