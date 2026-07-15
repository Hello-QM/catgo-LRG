/**
 * Feature detection for the "Render Still" offline path tracer.
 *
 * three-gpu-pathtracer needs a WebGL2 context with float color-buffer
 * rendering (EXT_color_buffer_float). Tauri's WebKitGTK webview on some
 * Linux stacks exposes neither — the UI entry point must degrade to a
 * disabled state there instead of throwing mid-render. We also surface a
 * "software renderer" flag (SwiftShader / llvmpipe) so the dialog can warn
 * that sampling will be an order of magnitude slower than on a real GPU.
 */

export interface RenderStillCapability {
  supported: boolean
  /** set when unsupported */
  reason?: `no-webgl2` | `no-float-buffer`
  /** true when the GL stack is a software rasterizer (expect very slow renders) */
  software: boolean
  renderer_string: string
}

let cached: RenderStillCapability | null = null

const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|software\s*(rasterizer|renderer)/i

export function detect_render_still_capability(): RenderStillCapability {
  if (cached) return cached
  if (typeof document === `undefined`) {
    // SSR / test environment — report unsupported without caching so a real
    // browser check can still run later in the same module lifetime.
    return { supported: false, reason: `no-webgl2`, software: false, renderer_string: `` }
  }

  const canvas = document.createElement(`canvas`)
  let gl: WebGL2RenderingContext | null = null
  try {
    gl = canvas.getContext(`webgl2`, { failIfMajorPerformanceCaveat: false })
  } catch {
    gl = null
  }
  if (!gl) {
    cached = { supported: false, reason: `no-webgl2`, software: false, renderer_string: `` }
    return cached
  }

  let renderer_string = ``
  try {
    const dbg = gl.getExtension(`WEBGL_debug_renderer_info`)
    renderer_string = String(
      dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    )
  } catch {
    renderer_string = ``
  }

  const has_float = !!gl.getExtension(`EXT_color_buffer_float`)
  const software = SOFTWARE_RE.test(renderer_string)

  // Release the probe context immediately — WebGL context slots are scarce.
  gl.getExtension(`WEBGL_lose_context`)?.loseContext()

  cached = has_float
    ? { supported: true, software, renderer_string }
    : { supported: false, reason: `no-float-buffer`, software, renderer_string }
  return cached
}

/** Test hook: clear the memoized probe result. */
export function reset_render_still_capability_cache(): void {
  cached = null
}
