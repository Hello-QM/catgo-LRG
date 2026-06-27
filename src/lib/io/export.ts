// deno-lint-ignore-file no-await-in-loop
import type { AnyStructure } from '$lib'
import { download } from '$lib/io/fetch'
import { create_structure_filename } from '$lib/structure/export'
import { zipSync } from 'fflate'
import type * as THREE from 'three'
import { Color, Vector2, WebGLRenderer } from 'three'

// Crop region in CSS pixels relative to canvas wrapper
export type CropRegion = { x: number; y: number; width: number; height: number }

// Supported image export formats
export type ImageExportFormat = `png` | `jpg` | `tiff` | `svg` | `pdf`

type ExportViewOffset = {
  full_width: number
  full_height: number
  x: number
  y: number
  width: number
  height: number
}

export type ExportRenderPlan = {
  full_width: number
  full_height: number
  render_width: number
  render_height: number
  view_offset?: ExportViewOffset
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
let crc32_table: Uint32Array | undefined

function clamp_num(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

function get_crc32_table(): Uint32Array {
  if (crc32_table) return crc32_table
  crc32_table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    crc32_table[n] = c >>> 0
  }
  return crc32_table
}

function crc32(bytes: Uint8Array): number {
  const table = get_crc32_table()
  let c = 0xffffffff
  for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function read_u32_be(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false)
}

function write_u32_be(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 4).setUint32(0, value >>> 0, false)
}

function is_png(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false
  return PNG_SIGNATURE.every((byte, idx) => bytes[idx] === byte)
}

function make_png_chunk(type: string, data: Uint8Array): Uint8Array {
  const type_bytes = new TextEncoder().encode(type)
  const chunk = new Uint8Array(12 + data.length)
  write_u32_be(chunk, 0, data.length)
  chunk.set(type_bytes, 4)
  chunk.set(data, 8)
  const crc_input = new Uint8Array(type_bytes.length + data.length)
  crc_input.set(type_bytes, 0)
  crc_input.set(data, type_bytes.length)
  write_u32_be(chunk, 8 + data.length, crc32(crc_input))
  return chunk
}

function concat_bytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// PNG stores physical resolution as pixels per meter in a pHYs chunk. Windows
// image properties read this chunk for horizontal/vertical DPI.
export function add_png_dpi_metadata(png: Uint8Array, dpi: number): Uint8Array {
  if (!is_png(png)) return png

  const ppm = Math.max(1, Math.round(dpi / 0.0254))
  const phys_data = new Uint8Array(9)
  write_u32_be(phys_data, 0, ppm)
  write_u32_be(phys_data, 4, ppm)
  phys_data[8] = 1 // unit: meter
  const phys_chunk = make_png_chunk(`pHYs`, phys_data)

  let offset = PNG_SIGNATURE.length
  let insert_after_ihdr: number | null = null
  while (offset + 8 <= png.length) {
    const length = read_u32_be(png, offset)
    const type_start = offset + 4
    const data_start = offset + 8
    const chunk_end = data_start + length + 4
    if (chunk_end > png.length) return png

    const type = String.fromCharCode(...png.slice(type_start, type_start + 4))
    if (type === `pHYs`) {
      return concat_bytes([png.slice(0, offset), phys_chunk, png.slice(chunk_end)])
    }
    if (type === `IHDR`) {
      insert_after_ihdr = chunk_end
    }
    offset = chunk_end
  }
  if (insert_after_ihdr !== null) {
    return concat_bytes([
      png.slice(0, insert_after_ihdr),
      phys_chunk,
      png.slice(insert_after_ihdr),
    ])
  }
  return png
}

async function blob_with_png_dpi(blob: Blob, dpi?: number): Promise<Blob> {
  if (!dpi || blob.type !== `image/png`) return blob
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const patched = add_png_dpi_metadata(bytes, dpi)
  return new Blob([patched], { type: blob.type })
}

// Decide the actual off-screen render size. With a crop, render only that
// selected sub-view via camera.setViewOffset instead of rendering a giant
// full-canvas image and then reading a rectangle from it. This keeps high-DPI
// crops aligned with the on-screen selection and avoids full-viewport WebGL
// max-size downscaling.
export function compute_export_render_plan(
  source_width: number,
  source_height: number,
  target_width: number,
  target_height: number,
  max_size: number,
  crop_region?: CropRegion | null,
): ExportRenderPlan {
  const safe_source_w = Math.max(1, source_width)
  const safe_source_h = Math.max(1, source_height)
  const safe_max = Math.max(1, Math.floor(max_size))

  if (crop_region) {
    const x0 = clamp_num(crop_region.x, 0, safe_source_w)
    const y0 = clamp_num(crop_region.y, 0, safe_source_h)
    const x1 = clamp_num(crop_region.x + crop_region.width, 0, safe_source_w)
    const y1 = clamp_num(crop_region.y + crop_region.height, 0, safe_source_h)
    const crop_w = Math.max(1, x1 - x0)
    const crop_h = Math.max(1, y1 - y0)

    const scale_x = target_width / safe_source_w
    const scale_y = target_height / safe_source_h
    let full_w = Math.max(1, Math.round(target_width))
    let full_h = Math.max(1, Math.round(target_height))
    let view_x = Math.round(x0 * scale_x)
    let view_y = Math.round(y0 * scale_y)
    let view_w = Math.max(1, Math.round(crop_w * scale_x))
    let view_h = Math.max(1, Math.round(crop_h * scale_y))

    if (view_w > safe_max || view_h > safe_max) {
      const scale = safe_max / Math.max(view_w, view_h)
      full_w = Math.max(1, Math.floor(full_w * scale))
      full_h = Math.max(1, Math.floor(full_h * scale))
      view_x = Math.round(view_x * scale)
      view_y = Math.round(view_y * scale)
      view_w = Math.max(1, Math.floor(view_w * scale))
      view_h = Math.max(1, Math.floor(view_h * scale))
    }

    view_x = clamp_num(view_x, 0, Math.max(0, full_w - 1))
    view_y = clamp_num(view_y, 0, Math.max(0, full_h - 1))
    view_w = Math.max(1, Math.min(view_w, full_w - view_x))
    view_h = Math.max(1, Math.min(view_h, full_h - view_y))

    return {
      full_width: full_w,
      full_height: full_h,
      render_width: view_w,
      render_height: view_h,
      view_offset: {
        full_width: full_w,
        full_height: full_h,
        x: view_x,
        y: view_y,
        width: view_w,
        height: view_h,
      },
    }
  }

  let w = Math.max(1, Math.round(target_width))
  let h = Math.max(1, Math.round(target_height))
  if (w > safe_max || h > safe_max) {
    const scale = safe_max / Math.max(w, h)
    w = Math.max(1, Math.floor(w * scale))
    h = Math.max(1, Math.floor(h * scale))
  }
  return {
    full_width: w,
    full_height: h,
    render_width: w,
    render_height: h,
  }
}

function prepare_camera_for_export(
  camera: THREE.Camera,
  full_width: number,
  full_height: number,
  view_offset?: ExportViewOffset,
): () => void {
  const cam = camera as any
  const state = {
    aspect: cam.aspect,
    left: cam.left,
    right: cam.right,
    top: cam.top,
    bottom: cam.bottom,
    view: cam.view ? { ...cam.view } : null,
  }

  const aspect = full_width / Math.max(1, full_height)
  if (cam.isPerspectiveCamera) {
    cam.aspect = aspect
  } else if (cam.isOrthographicCamera) {
    const center_x = (cam.left + cam.right) / 2
    const view_height = cam.top - cam.bottom
    if (Number.isFinite(center_x) && Number.isFinite(view_height) && view_height > 0) {
      const view_width = view_height * aspect
      cam.left = center_x - view_width / 2
      cam.right = center_x + view_width / 2
    }
  }

  if (view_offset && typeof cam.setViewOffset === `function`) {
    cam.setViewOffset(
      view_offset.full_width,
      view_offset.full_height,
      view_offset.x,
      view_offset.y,
      view_offset.width,
      view_offset.height,
    )
  } else if (typeof cam.clearViewOffset === `function`) {
    cam.clearViewOffset()
  }
  cam.updateProjectionMatrix?.()

  return () => {
    if (state.aspect !== undefined) cam.aspect = state.aspect
    if (state.left !== undefined) cam.left = state.left
    if (state.right !== undefined) cam.right = state.right
    if (state.top !== undefined) cam.top = state.top
    if (state.bottom !== undefined) cam.bottom = state.bottom
    if (state.view) cam.view = { ...state.view }
    else if (typeof cam.clearViewOffset === `function`) cam.clearViewOffset()
    cam.updateProjectionMatrix?.()
  }
}

// Render scene at specified resolution and read pixels synchronously via gl.readPixels.
// This avoids preserveDrawingBuffer issues that cause blank exports on WebGL canvases.
// Returns RGBA pixel data (top-to-bottom row order) and actual dimensions.
function render_and_read_pixels(
  renderer: WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  target_width: number,
  target_height: number,
  crop_region?: CropRegion | null,
): { pixels: Uint8Array; width: number; height: number } {
  const gl = renderer.getContext()
  const max_size = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number

  // Save original state
  const orig_pixel_ratio = renderer.getPixelRatio()
  const orig_size = renderer.getSize(new Vector2())
  const plan = compute_export_render_plan(
    orig_size.width,
    orig_size.height,
    target_width,
    target_height,
    max_size,
    crop_region,
  )
  let restore_camera: (() => void) | undefined

  try {
    // Render at target resolution (pixelRatio=1, exact pixel dimensions)
    renderer.setPixelRatio(1)
    renderer.setSize(plan.render_width, plan.render_height, false)
    restore_camera = prepare_camera_for_export(
      camera,
      plan.full_width,
      plan.full_height,
      plan.view_offset,
    )
    renderer.render(scene, camera)

    // Read pixels synchronously — works regardless of preserveDrawingBuffer
    const read_x = 0
    const read_y = 0
    const read_w = plan.render_width
    const read_h = plan.render_height

    const pixels = new Uint8Array(read_w * read_h * 4)
    gl.readPixels(read_x, read_y, read_w, read_h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

    // Flip vertically (OpenGL reads bottom-to-top)
    const row_size = read_w * 4
    const temp = new Uint8Array(row_size)
    for (let y = 0; y < Math.floor(read_h / 2); y++) {
      const top = y * row_size
      const bottom = (read_h - 1 - y) * row_size
      temp.set(pixels.subarray(top, top + row_size))
      pixels.copyWithin(top, bottom, bottom + row_size)
      pixels.set(temp, bottom)
    }

    return { pixels, width: read_w, height: read_h }
  } finally {
    // Always restore original renderer state
    restore_camera?.()
    renderer.setPixelRatio(orig_pixel_ratio)
    renderer.setSize(orig_size.width, orig_size.height, false)
  }
}

// Convert RGBA pixel data to a PNG or JPEG blob via a temporary 2D canvas
function pixels_to_image_blob(
  pixels: Uint8Array,
  width: number,
  height: number,
  mime: `image/png` | `image/jpeg`,
  quality = 1.0,
  dpi?: number,
): Promise<Blob> {
  const canvas = document.createElement(`canvas`)
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext(`2d`)
  if (!ctx) return Promise.reject(new Error(`Failed to get 2D context`))
  const clamped = new Uint8ClampedArray(width * height * 4)
  clamped.set(pixels)
  const image_data = new ImageData(clamped, width, height)
  ctx.putImageData(image_data, 0, 0)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error(`Failed to create ${mime} blob`))
          return
        }
        blob_with_png_dpi(blob, dpi).then(resolve, reject)
      },
      mime,
      quality,
    )
  })
}

// Encode RGBA pixel data as an uncompressed TIFF file with correct DPI metadata
function encode_tiff(pixels: Uint8Array, width: number, height: number, dpi = 150): Blob {
  const num_pixels = width * height
  // Convert RGBA → RGB
  const rgb = new Uint8Array(num_pixels * 3)
  for (let i = 0; i < num_pixels; i++) {
    rgb[i * 3] = pixels[i * 4]
    rgb[i * 3 + 1] = pixels[i * 4 + 1]
    rgb[i * 3 + 2] = pixels[i * 4 + 2]
  }

  const num_tags = 12
  const ifd_size = 2 + num_tags * 12 + 4 // tag count + entries + next IFD pointer
  const header_size = 8
  const bits_per_sample_offset = header_size + ifd_size
  const x_res_offset = bits_per_sample_offset + 6 // 3 × SHORT (6 bytes)
  const y_res_offset = x_res_offset + 8 // RATIONAL (2 × LONG = 8 bytes)
  const image_data_offset = y_res_offset + 8

  const total_size = image_data_offset + rgb.length
  const buf = new ArrayBuffer(total_size)
  const view = new DataView(buf)

  // TIFF header — little-endian
  view.setUint16(0, 0x4949) // 'II' byte order
  view.setUint16(2, 42, true) // magic
  view.setUint32(4, header_size, true) // offset to first IFD

  // IFD entries (tags must be in ascending order)
  let off = header_size
  view.setUint16(off, num_tags, true); off += 2

  const write_tag = (tag: number, type: number, count: number, value: number) => {
    view.setUint16(off, tag, true); off += 2
    view.setUint16(off, type, true); off += 2
    view.setUint32(off, count, true); off += 4
    view.setUint32(off, value, true); off += 4
  }

  write_tag(256, 4, 1, width)                    // ImageWidth (LONG)
  write_tag(257, 4, 1, height)                   // ImageLength (LONG)
  write_tag(258, 3, 3, bits_per_sample_offset)   // BitsPerSample → offset to [8,8,8]
  write_tag(259, 3, 1, 1)                        // Compression: None
  write_tag(262, 3, 1, 2)                        // PhotometricInterpretation: RGB
  write_tag(273, 4, 1, image_data_offset)        // StripOffsets
  write_tag(277, 3, 1, 3)                        // SamplesPerPixel
  write_tag(278, 4, 1, height)                   // RowsPerStrip (single strip)
  write_tag(279, 4, 1, rgb.length)               // StripByteCounts
  write_tag(282, 5, 1, x_res_offset)             // XResolution → RATIONAL
  write_tag(283, 5, 1, y_res_offset)             // YResolution → RATIONAL
  write_tag(296, 3, 1, 2)                        // ResolutionUnit: inch

  // Next IFD = 0 (no more IFDs)
  view.setUint32(off, 0, true)

  // BitsPerSample: [8, 8, 8]
  view.setUint16(bits_per_sample_offset, 8, true)
  view.setUint16(bits_per_sample_offset + 2, 8, true)
  view.setUint16(bits_per_sample_offset + 4, 8, true)

  // XResolution: dpi/1 (RATIONAL = numerator + denominator, each LONG)
  view.setUint32(x_res_offset, dpi, true)
  view.setUint32(x_res_offset + 4, 1, true)

  // YResolution: dpi/1
  view.setUint32(y_res_offset, dpi, true)
  view.setUint32(y_res_offset + 4, 1, true)

  // Image data
  new Uint8Array(buf).set(rgb, image_data_offset)

  return new Blob([buf], { type: `image/tiff` })
}

// Encode RGBA pixel data as an SVG file wrapping a rasterized PNG image.
// SVG is a vector container — DPI controls the embedded raster resolution,
// while the SVG dimensions are in physical units (points = 1/72 inch),
// making it resolution-independent for scaling and printing.
async function encode_svg(pixels: Uint8Array, width: number, height: number, dpi: number): Promise<Blob> {
  // Get base64-encoded PNG data for embedding
  const png_blob = await pixels_to_image_blob(pixels, width, height, `image/png`, 1.0, dpi)
  const png_base64 = await blob_to_base64(png_blob)

  // Physical dimensions: pixel size / DPI → inches → points (1 pt = 1/72 inch)
  const width_pt = (width / dpi) * 72
  const height_pt = (height / dpi) * 72

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${width_pt.toFixed(2)}pt"
     height="${height_pt.toFixed(2)}pt"
     viewBox="0 0 ${width} ${height}">
  <metadata>
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description>
        <dc:source xmlns:dc="http://purl.org/dc/elements/1.1/">CatGo</dc:source>
        <dc:description xmlns:dc="http://purl.org/dc/elements/1.1/">Raster resolution: ${width}×${height} px (${Math.round(dpi)} DPI)</dc:description>
      </rdf:Description>
    </rdf:RDF>
  </metadata>
  <image width="${width}" height="${height}" xlink:href="${png_base64}"/>
</svg>`

  return new Blob([svg], { type: `image/svg+xml` })
}

// Encode RGBA pixel data as a minimal PDF with the image at correct physical dimensions.
// PDF dimensions are in points (1 pt = 1/72 inch). The image is placed to fill the page
// at the DPI-determined physical size — a 300 DPI image prints at native resolution.
async function encode_pdf(pixels: Uint8Array, width: number, height: number, dpi: number): Promise<Blob> {
  // Convert RGBA → RGB for PDF (no alpha channel in DCT/raw image XObject)
  const num_pixels = width * height
  const rgb = new Uint8Array(num_pixels * 3)
  for (let i = 0; i < num_pixels; i++) {
    rgb[i * 3] = pixels[i * 4]
    rgb[i * 3 + 1] = pixels[i * 4 + 1]
    rgb[i * 3 + 2] = pixels[i * 4 + 2]
  }

  // Physical page size in points (1 pt = 1/72 inch)
  const page_w = (width / dpi) * 72
  const page_h = (height / dpi) * 72

  const enc = new TextEncoder()

  // Build PDF as a sequence of byte chunks, tracking byte offsets for xref
  const chunks: Uint8Array[] = []
  let byte_offset = 0
  const offsets: number[] = []

  const push = (text: string) => {
    const bytes = enc.encode(text)
    chunks.push(bytes)
    byte_offset += bytes.length
  }

  const add_object = (id: number, content: string) => {
    offsets[id] = byte_offset
    push(`${id} 0 obj\n${content}\nendobj\n`)
  }

  // Header — binary comment ensures PDF readers detect binary content
  push(`%PDF-1.4\n`)
  // Binary marker (4 bytes > 0x80)
  const binary_marker = new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])
  chunks.push(binary_marker)
  byte_offset += binary_marker.length

  // Object 1: Catalog
  add_object(1, `<< /Type /Catalog /Pages 2 0 R >>`)

  // Object 2: Pages
  add_object(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`)

  // Object 3: Page
  add_object(3, [
    `<< /Type /Page /Parent 2 0 R`,
    `/MediaBox [0 0 ${page_w.toFixed(4)} ${page_h.toFixed(4)}]`,
    `/Contents 4 0 R /Resources << /XObject << /Img 5 0 R >> >> >>`,
  ].join(` `))

  // Object 4: Page content stream — draw image to fill page
  const stream_content = `q ${page_w.toFixed(4)} 0 0 ${page_h.toFixed(4)} 0 0 cm /Img Do Q`
  add_object(4, `<< /Length ${stream_content.length} >>\nstream\n${stream_content}\nendstream`)

  // Object 5: Image XObject (raw RGB, uncompressed)
  const image_dict = [
    `<< /Type /XObject /Subtype /Image`,
    `/Width ${width} /Height ${height}`,
    `/ColorSpace /DeviceRGB /BitsPerComponent 8`,
    `/Length ${rgb.length} >>`,
  ].join(` `)

  offsets[5] = byte_offset
  push(`5 0 obj\n${image_dict}\nstream\n`)
  chunks.push(rgb)
  byte_offset += rgb.length
  push(`\nendstream\nendobj\n`)

  // Cross-reference table
  const xref_offset = byte_offset
  const num_objects = 6 // 0..5

  let xref = `xref\n0 ${num_objects}\n`
  xref += `0000000000 65535 f \n`
  for (let i = 1; i < num_objects; i++) {
    xref += `${String(offsets[i]).padStart(10, `0`)} 00000 n \n`
  }
  xref += `trailer\n<< /Size ${num_objects} /Root 1 0 R >>\nstartxref\n${xref_offset}\n%%EOF\n`
  push(xref)

  // Concatenate all chunks into final PDF
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const result = new Uint8Array(total)
  let pos = 0
  for (const chunk of chunks) {
    result.set(chunk, pos)
    pos += chunk.length
  }

  return new Blob([result], { type: `application/pdf` })
}

// Convert a Blob to a base64 data URI
function blob_to_base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

// Capture a canvas frame as a PNG blob, optionally cropping to a region
export async function capture_canvas_as_png_blob(
  canvas: HTMLCanvasElement,
  crop_region?: CropRegion | null,
  pixel_ratio?: number,
  dpi?: number,
): Promise<Blob> {
  const ratio = pixel_ratio ?? (
    (canvas as { __renderer?: WebGLRenderer }).__renderer?.getPixelRatio() ??
    window.devicePixelRatio ?? 1
  )

  if (crop_region) {
    // Convert CSS-pixel crop coords to canvas pixels
    const sx = Math.round(crop_region.x * ratio)
    const sy = Math.round(crop_region.y * ratio)
    const sw = Math.round(crop_region.width * ratio)
    const sh = Math.round(crop_region.height * ratio)

    const tmp = document.createElement(`canvas`)
    tmp.width = sw
    tmp.height = sh
    const ctx = tmp.getContext(`2d`)
    if (!ctx) throw new Error(`Failed to get 2D context for crop`)
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh)

    return new Promise<Blob>((resolve, reject) => {
      tmp.toBlob((blob) => {
        if (!blob) {
          reject(new Error(`Failed to generate cropped PNG blob`))
          return
        }
        blob_with_png_dpi(blob, dpi).then(resolve, reject)
      }, `image/png`)
    })
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error(`Failed to generate PNG blob`))
        return
      }
      blob_with_png_dpi(blob, dpi).then(resolve, reject)
    }, `image/png`)
  })
}

// Export canvas as image with DPI scaling.
// Raster formats (PNG, JPEG, TIFF): DPI controls output pixel dimensions (higher DPI = more pixels).
// Vector containers (SVG, PDF): DPI controls the embedded raster resolution, but the output
// dimensions are in physical units (pt/mm) — the file scales without quality loss at any zoom.
// Uses gl.readPixels for reliable high-DPI capture (no preserveDrawingBuffer dependency).
export function export_canvas_as_image(
  canvas: HTMLCanvasElement | null,
  structure_or_filename: AnyStructure | string | undefined,
  format: ImageExportFormat = `png`,
  png_dpi = 150,
  scene: THREE.Scene | null = null,
  camera: THREE.Camera | null = null,
  crop_region?: CropRegion | null,
): void {
  try {
    if (!canvas) {
      console.warn(`Canvas not found for image export`)
      return
    }

    const ext_map: Record<ImageExportFormat, string> = {
      png: `png`, jpg: `jpg`, tiff: `tif`, svg: `svg`, pdf: `pdf`,
    }
    const ext = ext_map[format]
    let filename = typeof structure_or_filename === `string`
      ? structure_or_filename
      : create_structure_filename(structure_or_filename, ext)

    // Inject DPI into filename for raster formats; for vector formats use pixel dimensions
    const is_vector = format === `svg` || format === `pdf`
    const suffix = is_vector ? `` : `-${Math.round(png_dpi)}dpi`
    const ext_re = new RegExp(`\\.${ext}$`, `i`)
    if (ext_re.test(filename)) {
      filename = filename.replace(ext_re, `${suffix}.${ext}`)
    } else {
      filename = `${filename}${suffix}.${ext}`
    }

    const renderer = (canvas as { __renderer?: WebGLRenderer }).__renderer
    const resolution_multiplier = Math.min(png_dpi / 72, 10)

    if (!renderer || !scene || !camera) {
      // Fallback: direct canvas capture (only works for PNG at current resolution)
      capture_canvas_as_png_blob(canvas, crop_region, undefined, Math.round(png_dpi))
        .then((blob) => download(blob, filename, `image/png`))
        .catch((error) => console.error(`Error during image export:`, error))
      return
    }

    // Compute target pixel dimensions
    const css_size = renderer.getSize(new Vector2())
    const target_w = css_size.width * resolution_multiplier
    const target_h = css_size.height * resolution_multiplier

    // Temporarily set white background for export
    const orig_clear_color = new Color()
    const orig_clear_alpha = renderer.getClearAlpha()
    renderer.getClearColor(orig_clear_color)
    renderer.setClearColor(0xffffff, 1)

    // Render at target resolution and read pixels synchronously
    const { pixels, width, height } = render_and_read_pixels(
      renderer, scene, camera, target_w, target_h, crop_region,
    )

    // Restore original clear color and re-render so the viewport isn't left dirty
    renderer.setClearColor(orig_clear_color, orig_clear_alpha)
    renderer.render(scene, camera)

    const mime_map: Record<ImageExportFormat, string> = {
      png: `image/png`,
      jpg: `image/jpeg`,
      tiff: `image/tiff`,
      svg: `image/svg+xml`,
      pdf: `application/pdf`,
    }
    const mime = mime_map[format]

    if (format === `tiff`) {
      const blob = encode_tiff(pixels, width, height, Math.round(png_dpi))
      download(blob, filename, mime)
    } else if (format === `svg`) {
      encode_svg(pixels, width, height, Math.round(png_dpi))
        .then((blob) => download(blob, filename, mime))
        .catch((error) => console.error(`Error during SVG export:`, error))
    } else if (format === `pdf`) {
      encode_pdf(pixels, width, height, Math.round(png_dpi))
        .then((blob) => download(blob, filename, mime))
        .catch((error) => console.error(`Error during PDF export:`, error))
    } else {
      pixels_to_image_blob(
        pixels,
        width,
        height,
        format === `jpg` ? `image/jpeg` : `image/png`,
        1.0,
        Math.round(png_dpi),
      )
        .then((blob) => download(blob, filename, mime))
        .catch((error) => console.error(`Error during ${format.toUpperCase()} export:`, error))
    }
  } catch (error) {
    console.error(`Error exporting image:`, error)
  }
}

// Export structure as PNG image from canvas (convenience wrapper)
export function export_canvas_as_png(
  canvas: HTMLCanvasElement | null,
  structure_or_filename: AnyStructure | string | undefined,
  png_dpi = 150,
  scene: THREE.Scene | null = null,
  camera: THREE.Camera | null = null,
  crop_region?: CropRegion | null,
): void {
  export_canvas_as_image(canvas, structure_or_filename, `png`, png_dpi, scene, camera, crop_region)
}

// Helper to ensure font-family is set on SVG root
function set_svg_font_family(svg: SVGElement) {
  const style = svg.getAttribute(`style`) || ``
  if (!/font-family/.test(style)) {
    svg.setAttribute(`style`, `${style};font-family:sans-serif;`)
  }
  // Also set as attribute for extra robustness
  svg.setAttribute(`font-family`, `sans-serif`)
}

// Export SVG element as SVG file
export function export_svg_as_svg(
  svg_element: SVGElement | null,
  filename: string,
): void {
  try {
    if (!svg_element) {
      console.warn(`SVG element not found for export`)
      return
    }

    // Clone the SVG to avoid modifying the original
    const cloned_svg = svg_element.cloneNode(true) as SVGElement

    // Ensure the SVG has proper dimensions and viewBox
    const viewBox = svg_element.getAttribute(`viewBox`)
    if (viewBox) cloned_svg.setAttribute(`viewBox`, viewBox)

    // Ensure font-family is set
    set_svg_font_family(cloned_svg)
    // Ensure xmlns is set
    if (!cloned_svg.hasAttribute(`xmlns`)) {
      cloned_svg.setAttribute(`xmlns`, `http://www.w3.org/2000/svg`)
    }

    // Convert SVG to string
    const svg_string = new XMLSerializer().serializeToString(cloned_svg)

    // Add XML declaration and DOCTYPE for proper SVG format
    const svg_content =
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n${svg_string}`

    download(svg_content, filename, `image/svg+xml;charset=utf-8`)
  } catch (error) {
    console.error(`Error exporting SVG:`, error)
  }
}

// Export SVG element as PNG by converting to canvas
export function export_svg_as_png(
  svg_element: SVGElement | null,
  filename: string,
  png_dpi = 150,
): void {
  try {
    if (!svg_element) {
      console.warn(`SVG element not found for PNG export`)
      return
    }

    // Get SVG dimensions
    const viewBox = svg_element.getAttribute(`viewBox`)
    if (!viewBox) {
      console.warn(`SVG viewBox not found for PNG export`)
      return
    }

    const [, , width, height] = viewBox.split(` `).map(Number)
    if (!width || !height) {
      console.warn(`Invalid SVG dimensions for PNG export`)
      return
    }

    // Convert DPI to pixel dimensions
    const resolution_multiplier = Math.min(png_dpi / 72, 10)
    const pixel_width = Math.round(width * resolution_multiplier)
    const pixel_height = Math.round(height * resolution_multiplier)

    // Create a canvas for rendering
    const canvas = document.createElement(`canvas`)
    const ctx = canvas.getContext(`2d`)
    if (!ctx) {
      console.warn(`Canvas 2D context not available for PNG export`)
      return
    }

    // Set canvas dimensions
    canvas.width = pixel_width
    canvas.height = pixel_height

    // Clone and patch SVG for font-family
    const cloned_svg = svg_element.cloneNode(true) as SVGElement
    set_svg_font_family(cloned_svg)

    // Create an object URL from SVG Blob
    const svg_string = new XMLSerializer().serializeToString(cloned_svg)
    const svg_blob = new Blob([svg_string], { type: `image/svg+xml;charset=utf-8` })
    const svg_data_url = URL.createObjectURL(svg_blob)

    // Create an image element to load the SVG
    const img = new Image()
    img.onload = () => {
      try {
        ctx.clearRect(0, 0, pixel_width, pixel_height)
        ctx.drawImage(img, 0, 0, pixel_width, pixel_height)
        canvas.toBlob(
          (blob) => {
            if (blob) download(blob, filename, `image/png`)
            else console.warn(`Failed to generate PNG blob`)
          },
          `image/png`,
          1, // set max PNG quality
        )
      } catch (error) {
        console.error(`Error during PNG generation:`, error)
      } finally {
        URL.revokeObjectURL(svg_data_url)
      }
    }
    img.onerror = () => {
      console.error(`Failed to load SVG for PNG export`)
      URL.revokeObjectURL(svg_data_url)
    }
    img.src = svg_data_url
  } catch (error) {
    console.error(`Error exporting PNG:`, error)
  }
}

// Generate FFmpeg command for WebM to MP4 conversion
export function get_ffmpeg_conversion_command(input_filename: string): string {
  const output = input_filename.replace(/\.webm$/i, `.mp4`)
  return `ffmpeg -i "${input_filename}" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags faststart "${output}"`
}

// Export trajectory video as WebM with frame-by-frame rendering to prevent dropped frames.
// Note: Browsers only support WebM natively. Use FFmpeg for MP4 conversion (see get_ffmpeg_conversion_command).
export async function export_trajectory_video(
  canvas: HTMLCanvasElement | null,
  filename: string,
  options: {
    fps?: number
    total_frames?: number
    on_progress?: (progress: number) => void
    on_step?: (step_idx: number) => void | Promise<void>
    resolution_multiplier?: number
  } = {},
): Promise<void> {
  const {
    fps = 30,
    total_frames = 100,
    on_progress,
    on_step,
    resolution_multiplier = 1,
  } = options

  if (
    !canvas ||
    typeof MediaRecorder === `undefined` ||
    !MediaRecorder.isTypeSupported(`video/webm;codecs=vp9`)
  ) throw new Error(`WebM video recording not supported in this browser`)

  const renderer = (canvas as { __renderer?: WebGLRenderer }).__renderer

  // Store original renderer settings if changing resolution
  let orig_pixel_ratio: number | undefined
  let orig_size: THREE.Vector2 | undefined

  if (resolution_multiplier !== 1 && renderer) {
    orig_pixel_ratio = renderer.getPixelRatio()
    orig_size = renderer.getSize(new Vector2())
    // Adjust pixel ratio for different resolution export
    renderer.setPixelRatio(orig_pixel_ratio * resolution_multiplier)
    renderer.setSize(orig_size.width, orig_size.height, false)
  }

  // Calculate bitrate based on actual video dimensions
  // VP9 typically needs 0.08-0.12 bits per pixel per frame for good quality
  // canvas dimensions include device pixel ratio and any resolution_multiplier
  const pixels_per_frame = canvas.width * canvas.height
  const bits_per_pixel_per_frame = 0.1 // Good quality for VP9
  // Clamp bitrate to reasonable bounds (1 Mbps min, 200 Mbps max)
  const calculated_bitrate = pixels_per_frame * fps * bits_per_pixel_per_frame
  const bitrate = Math.max(1_000_000, Math.min(calculated_bitrate, 200_000_000))

  const stream = canvas.captureStream(0)
  const chunks: Blob[] = []
  const recorder = new MediaRecorder(stream, {
    mimeType: `video/webm;codecs=vp9`,
    videoBitsPerSecond: bitrate,
  })

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }

  const track = stream.getVideoTracks()[0] as MediaStreamTrack & {
    requestFrame?: () => void
  }

  // Start recording
  recorder.start()

  const frame_duration = 1000 / fps

  try {
    // Render each frame sequentially with precise timing
    for (let idx = 0; idx < total_frames; idx++) {
      const frame_start = performance.now()

      on_progress?.((idx / total_frames) * 100)

      // Update trajectory step
      if (on_step) await on_step(idx)

      // Double RAF ensures Three.js completes rendering before capture
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )

      // Capture frame
      track.requestFrame?.()

      // Wait for remaining frame time to maintain consistent FPS
      const elapsed = performance.now() - frame_start
      const remaining = Math.max(0, frame_duration - elapsed)
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining))
      }
    }
  } finally {
    // Restore original renderer settings
    if (orig_pixel_ratio !== undefined && orig_size && renderer) {
      renderer.setPixelRatio(orig_pixel_ratio)
      renderer.setSize(orig_size.width, orig_size.height, false)
    }
  }

  // Finalize recording
  return new Promise((resolve, reject) => {
    let is_resolved = false

    recorder.onstop = () => {
      if (is_resolved) return
      is_resolved = true

      try {
        const blob = new Blob(chunks, { type: `video/webm` })
        const webm_filename = filename.replace(/\.(mp4|webm)$/i, `.webm`)
        download(blob, webm_filename, `video/webm`)
        on_progress?.(100)
        resolve()
      } catch (error) {
        reject(error)
      }
    }

    recorder.onerror = (event) => {
      if (is_resolved) return
      is_resolved = true
      // Extract error details from MediaRecorderErrorEvent or ErrorEvent
      reject(new Error(`MediaRecorder error: ${event.error}`))
    }

    // Stop recording with safety timeout
    try {
      recorder.stop()
      // Fallback: force resolution if recorder doesn't stop within 5 seconds
      setTimeout(() => {
        if (!is_resolved) {
          is_resolved = true
          reject(new Error(`Recording timeout - recorder did not stop`))
        }
      }, 5000)
    } catch (error) {
      if (!is_resolved) {
        is_resolved = true
        reject(error)
      }
    }
  })
}

// Export trajectory frames as a ZIP of numbered PNG files
/** Parse a frame specification string like "1, 3, 5, 9-22, 40-69" into sorted unique 0-based indices.
 *  Input numbers are 1-based (user-facing). Returns 0-based indices. */
export function parse_frame_spec(spec: string, total_frames: number): number[] {
  const indices = new Set<number>()
  for (const part of spec.split(`,`)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const range_match = trimmed.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range_match) {
      const start = Math.max(1, parseInt(range_match[1]))
      const end = Math.min(total_frames, parseInt(range_match[2]))
      for (let i = start; i <= end; i++) indices.add(i - 1) // convert to 0-based
    } else {
      const n = parseInt(trimmed)
      if (!isNaN(n) && n >= 1 && n <= total_frames) indices.add(n - 1)
    }
  }
  return [...indices].sort((a, b) => a - b)
}

export async function export_trajectory_png_sequence(
  canvas: HTMLCanvasElement | null,
  filename_prefix: string,
  options: {
    frame_indices: number[] // 0-based frame indices to export
    on_progress?: (progress: number) => void
    on_step?: (step_idx: number) => void | Promise<void>
    png_dpi?: number
    crop_region?: CropRegion | null
    scene?: THREE.Scene | null
    camera?: THREE.Camera | null
  },
): Promise<void> {
  const {
    frame_indices,
    on_progress,
    on_step,
    png_dpi = 150,
    crop_region,
  } = options

  if (!canvas) throw new Error(`Canvas not available for PNG sequence export`)
  if (frame_indices.length === 0) return

  const renderer = (canvas as { __renderer?: WebGLRenderer }).__renderer
  // Fall back to scene/camera attached to the canvas by StructureScene when a
  // caller doesn't pass them explicitly (e.g. the trajectory export pane).
  // Required for the reliable gl.readPixels path; without it the fallback
  // canvas.toBlob() yields blank/transparent frames on a WebGL canvas.
  const scene =
    options.scene ?? (canvas as { __scene?: THREE.Scene }).__scene ?? null
  const camera =
    options.camera ?? (canvas as { __camera?: THREE.Camera }).__camera ?? null
  const resolution_multiplier = Math.min(png_dpi / 72, 10)

  const files: Record<string, Uint8Array> = {}
  const max_frame = Math.max(...frame_indices)
  const pad_len = String(max_frame + 1).length // 1-based in filename

  // Use readPixels approach for reliable high-DPI capture
  const use_readpixels = renderer && scene && camera && resolution_multiplier > 1.1

  // For readPixels path, compute target pixel dimensions once
  const css_size = renderer ? renderer.getSize(new Vector2()) : undefined

  // Temporarily set white background for export
  let orig_clear_color: Color | undefined
  let orig_clear_alpha: number | undefined
  if (renderer) {
    orig_clear_color = new Color()
    orig_clear_alpha = renderer.getClearAlpha()
    renderer.getClearColor(orig_clear_color)
    renderer.setClearColor(0xffffff, 1)
  }

  // Legacy path: modify renderer pixel ratio for the entire export
  let orig_pixel_ratio: number | undefined
  let orig_size: THREE.Vector2 | undefined
  if (!use_readpixels && resolution_multiplier > 1.1 && renderer) {
    orig_pixel_ratio = renderer.getPixelRatio()
    orig_size = renderer.getSize(new Vector2())
    renderer.setPixelRatio(resolution_multiplier)
    renderer.setSize(orig_size.width, orig_size.height, false)
  }

  try {
    for (let i = 0; i < frame_indices.length; i++) {
      const frame_idx = frame_indices[i]
      on_progress?.((i / frame_indices.length) * 100)

      if (on_step) await on_step(frame_idx)

      // Wait for frame to load reactively
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )

      let blob: Blob

      if (use_readpixels && css_size) {
        // Render at target res and read pixels synchronously (reliable at high DPI)
        const target_w = css_size.width * resolution_multiplier
        const target_h = css_size.height * resolution_multiplier
        const { pixels, width, height } = render_and_read_pixels(
          renderer!, scene!, camera!, target_w, target_h, crop_region,
        )
        blob = await pixels_to_image_blob(
          pixels,
          width,
          height,
          `image/png`,
          1.0,
          Math.round(png_dpi),
        )
      } else {
        // Fallback: render + toBlob
        if (renderer && scene && camera) renderer.render(scene, camera)
        const pixel_ratio = renderer?.getPixelRatio() ?? window.devicePixelRatio ?? 1
        blob = await capture_canvas_as_png_blob(
          canvas,
          crop_region,
          pixel_ratio,
          Math.round(png_dpi),
        )
      }

      const arr = new Uint8Array(await blob.arrayBuffer())
      const frame_num = String(frame_idx + 1).padStart(pad_len, `0`) // 1-based in filename
      files[`${filename_prefix}_frame_${frame_num}.png`] = arr
    }
  } finally {
    if (orig_pixel_ratio !== undefined && orig_size && renderer) {
      renderer.setPixelRatio(orig_pixel_ratio)
      renderer.setSize(orig_size.width, orig_size.height, false)
    }
    // Restore original clear color
    if (renderer && orig_clear_color !== undefined && orig_clear_alpha !== undefined) {
      renderer.setClearColor(orig_clear_color, orig_clear_alpha)
    }
  }

  on_progress?.(95)

  const zipped = zipSync(files)
  const blob = new Blob([zipped as any], { type: `application/zip` })
  download(blob, `${filename_prefix}_frames.zip`, `application/zip`)
  on_progress?.(100)
}
