import { PerspectiveCamera, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { pack_camera_full } from '$lib/structure/gpu/camera-uniform'
import {
  GIZMO_AXIS_COLORS,
  GIZMO_AXIS_HEX,
  GIZMO_LAYOUT,
  GIZMO_NEG_AXIS_COLORS,
  GIZMO_NEG_AXIS_HEX,
  GIZMO_SIZE_CSS,
  GIZMO_WORLD_AXES,
  gizmo_dom_offset,
  project_gizmo_axes,
  resolve_gizmo_layout,
} from '$lib/structure/rendering/gizmo'
import { axis_colors, neg_axis_colors } from '$lib/colors'

describe(`shared gizmo palette`, () => {
  it(`is the one palette exposed through the public color module`, () => {
    expect(axis_colors).toBe(GIZMO_AXIS_COLORS)
    expect(neg_axis_colors).toBe(GIZMO_NEG_AXIS_COLORS)
    expect(GIZMO_AXIS_HEX).toEqual(axis_colors.map(([, color]) => color))
    expect(GIZMO_NEG_AXIS_HEX).toEqual(neg_axis_colors.map(([, color]) => color))
  })
})

describe(`shared gizmo layout`, () => {
  it(`owns the WebGL clamp(70px, 18cqmin, 100px) expression`, () => {
    expect(GIZMO_LAYOUT).toMatchObject({
      edge_inset_css_px: 5,
      min_size_css_px: 70,
      responsive_size_cqmin: 18,
      max_size_css_px: 100,
    })
    expect(GIZMO_SIZE_CSS).toBe(`clamp(70px, 18cqmin, 100px)`)
  })

  it.each([
    { css: [200, 300], expected: 70 },
    { css: [500, 600], expected: 90 },
    { css: [1000, 800], expected: 100 },
  ])(`clamps an 18cqmin widget for $css`, ({ css, expected }) => {
    const layout = resolve_gizmo_layout({
      width_device_px: css[0],
      height_device_px: css[1],
      dpr: 1,
    })
    expect(layout.size_css_px).toBe(expected)
  })

  it(`applies DPR after CSS layout and preserves the CSS-space center`, () => {
    const css = resolve_gizmo_layout({
      width_device_px: 500,
      height_device_px: 600,
      dpr: 1,
      safe_left_css_px: 12,
      safe_bottom_css_px: 20,
    })
    const retina = resolve_gizmo_layout({
      width_device_px: 1000,
      height_device_px: 1200,
      dpr: 2,
      safe_left_css_px: 12,
      safe_bottom_css_px: 20,
    })

    expect(retina.size_css_px).toBe(css.size_css_px)
    expect(retina.radius_device_px).toBe(css.radius_device_px * 2)
    expect(retina.line_half_width_device_px).toBe(css.line_half_width_device_px * 2)
    expect(retina.center_ndc[0]).toBeCloseTo(css.center_ndc[0])
    expect(retina.center_ndc[1]).toBeCloseTo(css.center_ndc[1])
  })

  it(`uses the same edge inset and HUD safe-area for DOM and GPU placement`, () => {
    expect(gizmo_dom_offset({ l: 12, r: 99, t: 88, b: 20 })).toEqual({
      left: 17,
      bottom: 25,
    })

    const layout = resolve_gizmo_layout({
      width_device_px: 500,
      height_device_px: 600,
      dpr: 1,
      safe_left_css_px: 12,
      safe_bottom_css_px: 20,
    })
    expect(layout.left_device_px).toBe(17)
    expect(layout.bottom_device_px).toBe(25)
    expect(layout.center_ndc[0]).toBeCloseTo(-1 + (2 * (17 + 45)) / 500)
    expect(layout.center_ndc[1]).toBeCloseTo(-1 + (2 * (25 + 45)) / 600)
  })
})

describe(`shared gizmo camera orientation`, () => {
  it(`projects one camera fixture identically from WebGL quaternion and WebGPU view`, () => {
    const camera = new PerspectiveCamera(45, 1, 0.1, 100)
    camera.position.set(4, -3, 2)
    camera.up.set(0, 0, 1)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)

    const packed = pack_camera_full(camera)
    const webgpu = project_gizmo_axes(packed.subarray(0, 16))
    const world_to_view = camera.quaternion.clone().invert()
    const webgl = GIZMO_WORLD_AXES.map((axis) =>
      new Vector3(...axis).applyQuaternion(world_to_view as Quaternion).toArray()
    )

    webgpu.forEach((axis, idx) => {
      axis.forEach((value, channel) => {
        expect(value).toBeCloseTo(webgl[idx][channel], 6)
      })
    })
  })
})
