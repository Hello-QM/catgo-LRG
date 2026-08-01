import { Color } from 'three'
import { afterEach, describe, expect, it } from 'vitest'
import {
  find_theme_background,
  linear_channel_to_srgb,
  parse_computed_background,
  resolve_background_linear,
  srgb_channel_to_linear,
} from '$lib/structure/rendering/background'

afterEach(() => {
  document.body.replaceChildren()
  document.body.removeAttribute(`style`)
  document.documentElement.removeAttribute(`style`)
})

describe(`shared background resolver`, () => {
  it(`parses computed CSS RGB as sRGB and converts exactly once`, () => {
    const parsed = parse_computed_background(`rgb(28, 28, 28)`)

    expect(parsed?.alpha).toBe(1)
    expect(parsed?.linear).toEqual([
      srgb_channel_to_linear(28 / 255),
      srgb_channel_to_linear(28 / 255),
      srgb_channel_to_linear(28 / 255),
    ])
    expect(linear_channel_to_srgb(parsed!.linear[0]) * 255).toBeCloseTo(28, 5)
  })

  it(`parses comma-separated rgba alpha`, () => {
    expect(parse_computed_background(`rgba(28, 28, 28, 0.6)`)).toEqual({
      linear: [
        srgb_channel_to_linear(28 / 255),
        srgb_channel_to_linear(28 / 255),
        srgb_channel_to_linear(28 / 255),
      ],
      alpha: 0.6,
    })
  })

  it.each([
    [0, 28],
    [0.1, 50.12],
    [1, 128],
  ])(`resolves opacity %s in linear space`, (opacity, expected) => {
    const out = resolve_background_linear({
      theme_linear: parse_computed_background(`rgb(28, 28, 28)`)!.linear,
      picked: `#808080`,
      opacity,
    }, new Color())

    expect(linear_channel_to_srgb(out.r) * 255).toBeCloseTo(expected, 1)
    expect(linear_channel_to_srgb(out.g) * 255).toBeCloseTo(expected, 1)
    expect(linear_channel_to_srgb(out.b) * 255).toBeCloseTo(expected, 1)
  })

  it(`walks to the first parent whose computed background alpha is at least 0.5`, () => {
    const opaque = document.createElement(`div`)
    opaque.style.backgroundColor = `rgb(28, 28, 28)`
    const translucent = document.createElement(`div`)
    translucent.style.backgroundColor = `rgba(255, 0, 0, 0.49)`
    const canvas = document.createElement(`canvas`)
    translucent.append(canvas)
    opaque.append(translucent)
    document.body.append(opaque)

    const out = find_theme_background(canvas, new Color())

    expect(linear_channel_to_srgb(out.r) * 255).toBeCloseTo(28, 5)
    expect(linear_channel_to_srgb(out.g) * 255).toBeCloseTo(28, 5)
    expect(linear_channel_to_srgb(out.b) * 255).toBeCloseTo(28, 5)
  })

  it(`falls back to linear black when every root is transparent`, () => {
    document.documentElement.style.backgroundColor = `rgba(0, 0, 0, 0)`
    document.body.style.backgroundColor = `rgba(0, 0, 0, 0)`
    const canvas = document.createElement(`canvas`)
    document.body.append(canvas)

    expect(find_theme_background(canvas, new Color()).toArray()).toEqual([0, 0, 0])
  })
})
