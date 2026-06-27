import {
  add_png_dpi_metadata,
  compute_export_render_plan,
  export_canvas_as_png,
  export_svg_as_png,
  export_svg_as_svg,
} from '$lib/io/export'
import { download } from '$lib/io/fetch'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { simple_structure } from '../setup'

vi.mock(`$lib/io/fetch`, () => ({ download: vi.fn() }))
const mock_download = vi.mocked(download)

// Helper functions
function create_mock_svg(view_box = `0 0 100 100`): SVGElement {
  const svg = document.createElementNS(`http://www.w3.org/2000/svg`, `svg`)
  svg.setAttribute(`viewBox`, view_box)
  svg.setAttribute(`width`, `100`)
  svg.setAttribute(`height`, `100`)
  return svg
}

function create_mock_canvas(): HTMLCanvasElement & { __customRenderer?: unknown } {
  const canvas = document.createElement(`canvas`) as HTMLCanvasElement & {
    __customRenderer?: unknown
  }
  canvas.toBlob = vi.fn((cb: (blob: Blob | null) => void) =>
    cb(new Blob([`pngdata`], { type: `image/png` }))
  ) as unknown as (HTMLCanvasElement & { __customRenderer?: unknown })[`toBlob`]
  return canvas
}

function create_mock_image(): HTMLImageElement {
  return {
    crossOrigin: ``,
    onload: null,
    onerror: null,
    src: ``,
  } as unknown as HTMLImageElement
}

function u32_be(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, false)
  return out
}

function make_png_chunk(type: string, data = new Uint8Array()): Uint8Array {
  const type_bytes = new TextEncoder().encode(type)
  const out = new Uint8Array(12 + data.length)
  out.set(u32_be(data.length), 0)
  out.set(type_bytes, 4)
  out.set(data, 8)
  // CRC is not relevant for metadata insertion tests; the production code
  // writes a valid CRC for the pHYs chunk it creates.
  return out
}

function make_minimal_png(extra_chunks: Uint8Array[] = []): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = new Uint8Array(13)
  new DataView(ihdr.buffer).setUint32(0, 1, false)
  new DataView(ihdr.buffer).setUint32(4, 1, false)
  ihdr[8] = 8
  ihdr[9] = 6
  return new Uint8Array([
    ...signature,
    ...make_png_chunk(`IHDR`, ihdr),
    ...extra_chunks.flatMap((chunk) => [...chunk]),
    ...make_png_chunk(`IEND`),
  ])
}

function find_png_chunk(png: Uint8Array, type: string): Uint8Array | null {
  let offset = 8
  while (offset + 8 <= png.length) {
    const length = new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0, false)
    const type_start = offset + 4
    const data_start = offset + 8
    const chunk_end = data_start + length + 4
    if (chunk_end > png.length) return null
    const chunk_type = String.fromCharCode(...png.slice(type_start, type_start + 4))
    if (chunk_type === type) return png.slice(data_start, data_start + length)
    offset = chunk_end
  }
  return null
}

function count_png_chunks(png: Uint8Array, type: string): number {
  let count = 0
  let offset = 8
  while (offset + 8 <= png.length) {
    const length = new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0, false)
    const type_start = offset + 4
    const chunk_end = offset + 8 + length + 4
    if (chunk_end > png.length) return count
    const chunk_type = String.fromCharCode(...png.slice(type_start, type_start + 4))
    if (chunk_type === type) count++
    offset = chunk_end
  }
  return count
}

describe(`Export functionality`, () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe(`high-DPI crop render planning`, () => {
    it(`renders a crop directly instead of clamping the full high-DPI viewport`, () => {
      const multiplier = 600 / 72
      const plan = compute_export_render_plan(
        1280,
        720,
        1280 * multiplier,
        720 * multiplier,
        8192,
        { x: 460, y: 180, width: 365, height: 365 },
      )

      expect(plan.render_width).toBe(Math.round(365 * multiplier))
      expect(plan.render_height).toBe(Math.round(365 * multiplier))
      expect(plan.render_width).toBeLessThan(8192)
      expect(plan.view_offset).toMatchObject({
        full_width: Math.round(1280 * multiplier),
        full_height: Math.round(720 * multiplier),
        x: Math.round(460 * multiplier),
        y: Math.round(180 * multiplier),
      })
    })

    it(`still clamps uncropped full-canvas exports to the WebGL max size`, () => {
      const multiplier = 600 / 72
      const plan = compute_export_render_plan(
        1280,
        720,
        1280 * multiplier,
        720 * multiplier,
        8192,
        null,
      )

      expect(Math.max(plan.render_width, plan.render_height)).toBeLessThanOrEqual(8192)
      expect(Math.max(plan.render_width, plan.render_height)).toBeGreaterThan(8000)
      expect(plan.view_offset).toBeUndefined()
    })
  })

  describe(`PNG DPI metadata`, () => {
    it(`writes a pHYs chunk matching the requested DPI`, () => {
      const patched = add_png_dpi_metadata(make_minimal_png(), 600)
      const phys = find_png_chunk(patched, `pHYs`)
      expect(phys).not.toBeNull()

      const view = new DataView(phys!.buffer, phys!.byteOffset, phys!.byteLength)
      const expected_ppm = Math.round(600 / 0.0254)
      expect(view.getUint32(0, false)).toBe(expected_ppm)
      expect(view.getUint32(4, false)).toBe(expected_ppm)
      expect(phys![8]).toBe(1)
    })

    it(`leaves non-PNG bytes unchanged`, () => {
      const bytes = new Uint8Array([1, 2, 3])
      expect(add_png_dpi_metadata(bytes, 600)).toBe(bytes)
    })

    it(`replaces an existing pHYs chunk`, () => {
      const old_phys = new Uint8Array(9)
      new DataView(old_phys.buffer).setUint32(0, 1, false)
      new DataView(old_phys.buffer).setUint32(4, 1, false)
      old_phys[8] = 1
      const patched = add_png_dpi_metadata(make_minimal_png([make_png_chunk(`pHYs`, old_phys)]), 300)
      const phys = find_png_chunk(patched, `pHYs`)

      expect(count_png_chunks(patched, `pHYs`)).toBe(1)
      expect(new DataView(phys!.buffer, phys!.byteOffset, phys!.byteLength).getUint32(0, false))
        .toBe(Math.round(300 / 0.0254))
    })
  })

  describe(`Canvas PNG export`, () => {
    it(`exports PNG for direct export`, async () => {
      const mock_canvas = create_mock_canvas()
      export_canvas_as_png(mock_canvas, simple_structure, 72)
      // capture_canvas_as_png_blob returns a promise; flush microtasks so .then(download) runs
      await new Promise((r) => setTimeout(r, 0))
      expect(mock_canvas.toBlob).toHaveBeenCalled()
      expect(mock_download).toHaveBeenCalledWith(
        expect.any(Blob),
        expect.stringContaining(`.png`),
        `image/png`,
      )
    })

    it(`exports PNG with custom filename string`, async () => {
      const mock_canvas = create_mock_canvas()
      export_canvas_as_png(mock_canvas, `custom-filename.png`, 72)
      await new Promise((r) => setTimeout(r, 0))
      expect(mock_canvas.toBlob).toHaveBeenCalled()
      expect(mock_download).toHaveBeenCalledWith(
        expect.any(Blob),
        `custom-filename-72dpi.png`,
        `image/png`,
      )
    })

    it(`exports PNG via canvas-fallback when scene/camera are absent`, async () => {
      // export_canvas_as_image hits the renderer-driven path only when both
      // scene AND camera are provided; otherwise it falls back to a direct
      // canvas capture. We still expect a download call with the .png MIME.
      const mock_canvas = create_mock_canvas()
      const mock_renderer = {
        getPixelRatio: vi.fn(() => 1),
        setPixelRatio: vi.fn(),
        getSize: vi.fn(() => ({ width: 100, height: 100 })),
        setSize: vi.fn(),
        render: vi.fn(),
      }
      ;(mock_canvas as { __renderer?: typeof mock_renderer }).__renderer = mock_renderer
      export_canvas_as_png(mock_canvas, simple_structure, 144)
      await new Promise((r) => setTimeout(r, 0))
      expect(mock_download).toHaveBeenCalledWith(
        expect.any(Blob),
        expect.stringContaining(`.png`),
        `image/png`,
      )
    })

    it.each([
      { canvas: null, warn_msg: `Canvas not found for image export` },
      {
        canvas: create_mock_canvas(),
        error_msg: `Error during image export:`,
        use_error: true,
        setup: (canvas: HTMLCanvasElement) => {
          canvas.toBlob = vi.fn((cb: (blob: Blob | null) => void) =>
            cb(null)
          ) as unknown as (HTMLCanvasElement & { __customRenderer?: unknown })[`toBlob`]
        },
      },
    ])(`handles canvas issues`, async ({ canvas, warn_msg, error_msg, use_error, setup }) => {
      if (setup) setup(canvas as HTMLCanvasElement)
      const warn = vi.spyOn(console, `warn`).mockImplementation(() => {})
      const error = vi.spyOn(console, `error`).mockImplementation(() => {})
      export_canvas_as_png(canvas, simple_structure)
      // Flush microtasks for async capture_canvas_as_png_blob path
      await new Promise((r) => setTimeout(r, 0))
      if (use_error) {
        expect(error).toHaveBeenCalledWith(error_msg, expect.any(Error))
      } else {
        expect(warn).toHaveBeenCalledWith(warn_msg)
      }
      expect(mock_download).not.toHaveBeenCalled()
      warn.mockRestore()
      error.mockRestore()
    })
  })

  describe(`SVG export`, () => {
    let mock_xml_serializer: { serializeToString: ReturnType<typeof vi.fn> }

    beforeEach(() => {
      mock_xml_serializer = { serializeToString: vi.fn(() => `<svg></svg>`) }
      globalThis.XMLSerializer = vi.fn(function () {
        return mock_xml_serializer
      }) as unknown as typeof XMLSerializer
    })

    it(`exports SVG with XML/DOCTYPE and font-family`, () => {
      const mock_svg = create_mock_svg()
      const mock_cloned_svg = create_mock_svg()
      mock_svg.cloneNode = vi.fn(() => mock_cloned_svg)
      export_svg_as_svg(mock_svg, `f.svg`)
      expect(mock_xml_serializer.serializeToString).toHaveBeenCalledWith(mock_cloned_svg)
      expect(mock_download).toHaveBeenCalledWith(
        expect.stringContaining(`<?xml version="1.0"`),
        `f.svg`,
        `image/svg+xml;charset=utf-8`,
      )
      expect(mock_download).toHaveBeenCalledWith(
        expect.stringContaining(`<!DOCTYPE svg PUBLIC`),
        `f.svg`,
        `image/svg+xml;charset=utf-8`,
      )
      expect(mock_cloned_svg.getAttribute(`font-family`)).toBe(`sans-serif`)
      expect(mock_cloned_svg.getAttribute(`style`)).toContain(`font-family:sans-serif`)
      expect(mock_svg.cloneNode).toHaveBeenCalledWith(true)
    })

    it(`preserves existing font-family`, () => {
      const mock_svg = create_mock_svg()
      const mock_cloned_svg = create_mock_svg()
      mock_cloned_svg.setAttribute(`style`, `color: red; font-family: Arial;`)
      mock_svg.cloneNode = vi.fn(() => mock_cloned_svg)
      export_svg_as_svg(mock_svg, `f.svg`)
      expect(mock_cloned_svg.getAttribute(`style`)).toBe(
        `color: red; font-family: Arial;`,
      )
    })

    it(`handles null SVG`, () => {
      const warn = vi.spyOn(console, `warn`).mockImplementation(() => {})
      export_svg_as_svg(null, `f.svg`)
      expect(warn).toHaveBeenCalledWith(`SVG element not found for export`)
      expect(mock_download).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it(`handles serialization errors`, () => {
      const mock_svg = create_mock_svg()
      const mock_cloned_svg = create_mock_svg()
      mock_svg.cloneNode = vi.fn(() => mock_cloned_svg)
      mock_xml_serializer.serializeToString.mockImplementation(() => {
        throw new Error(`fail`)
      })
      const err = vi.spyOn(console, `error`).mockImplementation(() => {})
      export_svg_as_svg(mock_svg, `f.svg`)
      expect(err).toHaveBeenCalledWith(`Error exporting SVG:`, expect.any(Error))
      expect(mock_download).not.toHaveBeenCalled()
      err.mockRestore()
    })
  })

  describe(`SVG to PNG export`, () => {
    let mock_svg: SVGElement
    let mock_cloned_svg: SVGElement
    let mock_canvas: HTMLCanvasElement
    let mock_context: CanvasRenderingContext2D
    let mock_image: HTMLImageElement
    let mock_xml_serializer: { serializeToString: ReturnType<typeof vi.fn> }

    beforeEach(() => {
      mock_svg = create_mock_svg()
      mock_cloned_svg = create_mock_svg()
      mock_svg.cloneNode = vi.fn(() => mock_cloned_svg)
      mock_canvas = create_mock_canvas()
      mock_context = {
        clearRect: vi.fn(),
        drawImage: vi.fn(),
      } as unknown as CanvasRenderingContext2D
      mock_canvas.getContext = vi.fn(() =>
        mock_context
      ) as unknown as HTMLCanvasElement[`getContext`]
      mock_image = create_mock_image()
      mock_xml_serializer = { serializeToString: vi.fn(() => `<svg></svg>`) }
      globalThis.XMLSerializer = vi.fn(function () {
        return mock_xml_serializer
      }) as unknown as typeof XMLSerializer
      globalThis.document.createElement = vi.fn((tag) =>
        tag === `canvas`
          ? mock_canvas
          : tag === `img`
          ? mock_image
          : document.createElement(tag)
      ) as typeof document.createElement
      globalThis.Image = vi.fn(function () {
        return mock_image
      }) as unknown as typeof Image
      globalThis.URL.createObjectURL = vi.fn(() => `blob:mock-url`)
      globalThis.URL.revokeObjectURL = vi.fn()
    })

    it(`exports PNG with correct dimensions and DPI`, () => {
      export_svg_as_png(mock_svg, `f.png`, 150)
      expect(mock_canvas.width).toBe(208)
      expect(mock_canvas.height).toBe(208)
      expect(mock_image.src).toMatch(/^(data:image\/svg\+xml;base64,|blob:)/)
      mock_image.onload?.call(mock_image, new Event(`load`))
      expect(mock_context.clearRect).toHaveBeenCalledWith(0, 0, 208, 208)
      expect(mock_context.drawImage).toHaveBeenCalledWith(mock_image, 0, 0, 208, 208)
      expect(mock_canvas.toBlob).toHaveBeenCalled()
      expect(mock_download).toHaveBeenCalledWith(expect.any(Blob), `f.png`, `image/png`)
      expect(mock_cloned_svg.getAttribute(`font-family`)).toBe(`sans-serif`)
    })

    it.each([
      { dpi: undefined, width: 208, height: 208 },
      { dpi: 300, width: 417, height: 417 },
      { dpi: 144, width: 200, height: 200 },
    ])(`uses DPI $dpi correctly`, ({ dpi, width, height }) => {
      export_svg_as_png(mock_svg, `f.png`, dpi)
      expect(mock_canvas.width).toBe(width)
      expect(mock_canvas.height).toBe(height)
    })

    it.each([
      { svg: null, warn_msg: `SVG element not found for PNG export` },
      {
        svg: create_mock_svg(),
        warn_msg: `SVG viewBox not found for PNG export`,
        setup: (svg: SVGElement) => svg.removeAttribute(`viewBox`),
      },
      {
        svg: create_mock_svg(`0 0 0 0`),
        warn_msg: `Invalid SVG dimensions for PNG export`,
      },
      {
        svg: create_mock_svg(),
        warn_msg: `Canvas 2D context not available for PNG export`,
        setup: () => {
          mock_canvas.getContext = vi.fn(() =>
            null
          ) as unknown as HTMLCanvasElement[`getContext`]
        },
      },
    ])(`handles SVG issues: $warn_msg`, ({ svg, warn_msg, setup }) => {
      if (setup && svg) setup(svg)
      const warn = vi.spyOn(console, `warn`).mockImplementation(() => {})
      export_svg_as_png(svg as SVGElement | null, `f.png`)
      expect(warn).toHaveBeenCalledWith(warn_msg)
      expect(mock_download).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it(`handles image load error`, () => {
      const err = vi.spyOn(console, `error`).mockImplementation(() => {})
      export_svg_as_png(mock_svg, `f.png`, 150)
      if (typeof mock_image.onerror === `function`) {
        mock_image.onerror.call(mock_image, new Event(`error`))
      }
      expect(err).toHaveBeenCalledWith(`Failed to load SVG for PNG export`)
      expect(mock_download).not.toHaveBeenCalled()
      err.mockRestore()
    })

    it(`handles toBlob null`, () => {
      mock_canvas.toBlob = vi.fn((cb: (b: Blob | null) => void) =>
        cb(null)
      ) as unknown as (HTMLCanvasElement & { __customRenderer?: unknown })[`toBlob`]
      const warn = vi.spyOn(console, `warn`).mockImplementation(() => {})
      export_svg_as_png(mock_svg, `f.png`)
      mock_image.onload?.call(mock_image, new Event(`load`))
      expect(warn).toHaveBeenCalledWith(`Failed to generate PNG blob`)
      expect(mock_download).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it(`handles drawImage error`, () => {
      const error = new Error(`Draw failed`)
      mock_context.drawImage = vi.fn(() => {
        throw error
      })
      const err = vi.spyOn(console, `error`).mockImplementation(() => {})
      export_svg_as_png(mock_svg, `f.png`)
      mock_image.onload?.call(mock_image, new Event(`load`))
      expect(err).toHaveBeenCalledWith(`Error during PNG generation:`, error)
      expect(mock_download).not.toHaveBeenCalled()
      err.mockRestore()
    })

    it(`handles non-integer dimensions`, () => {
      mock_svg.setAttribute(`viewBox`, `0 0 50.5 75.3`)
      export_svg_as_png(mock_svg, `f.png`, 144)
      expect(mock_canvas.width).toBe(101)
      expect(mock_canvas.height).toBe(151)
    })
  })
})
