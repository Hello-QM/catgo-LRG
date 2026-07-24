// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

if (typeof document === `undefined`) {
  Object.defineProperty(globalThis, `document`, {
    configurable: true,
    value: { body: { innerHTML: `` } },
  })
}

const read = (path: string) => readFileSync(path, `utf8`)
const COMMIT = `0b2cdccef7452bf28212e15daf9df2dc7a545bcc`

describe(`OVITO-derived WebGL bond code attribution`, () => {
  test(`retains the MIT notice and pinned provenance`, () => {
    const notice = read(`THIRD_PARTY_NOTICES.md`)
    expect(notice).toContain(`Copyright 2026 OVITO GmbH, Germany`)
    expect(notice).toContain(COMMIT)
    expect(notice).toContain(`Permission is hereby granted, free of charge`)
    expect(notice).toContain(`OpenGLCylinderPrimitive.cpp`)
    expect(notice).toContain(`cylinder.frag`)
    expect(notice).toContain(`WebGL2 GLSL3`)
    expect(notice).toContain(`half-bond replica decoding`)
    expect(notice).toContain(`GPU picking`)
  })

  test.each([
    `src/lib/structure/gpu/webgl2/bond-replica-renderer.ts`,
    `src/lib/structure/gpu/webgl2/replica-id-picker.ts`,
  ])(`%s points to the repository notice and pinned source`, (path) => {
    const source = read(path)
    expect(source).toContain(COMMIT)
    expect(source).toContain(`THIRD_PARTY_NOTICES.md`)
    expect(source).toContain(`OVITO GmbH`)
  })
})
