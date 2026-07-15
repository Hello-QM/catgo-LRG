import { describe, expect, test } from 'vitest'
import { bake_atoms, bake_bonds } from '../bake'
import type { RenderStillSource, TemplateMesh } from '../bake'

// Single-triangle stand-in for the sphere template.
const TRI_TMPL: TemplateMesh = {
  position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  index: new Uint32Array([0, 1, 2]),
}

// Minimal unit-cylinder stand-in: two radial side vertices at y = ∓0.5 plus a
// third to make a triangle. Radial normals (zero y-component), axis +y.
const CYL_TMPL: TemplateMesh = {
  position: new Float32Array([1, -0.5, 0, 1, 0.5, 0, 0, -0.5, 1]),
  normal: new Float32Array([1, 0, 0, 1, 0, 0, 0, 0, 1]),
  index: new Uint32Array([0, 1, 2]),
}

function make_source(overrides: Partial<RenderStillSource> = {}): RenderStillSource {
  return {
    positions: new Float32Array([0, 0, 0, 0, 4, 0]),
    colors: new Float32Array([1, 0, 0, 0, 0, 1]), // site 0 red, site 1 blue
    radii: new Float32Array([0.5, 0.8]),
    site_count: 2,
    bond_pairs: new Uint32Array([0, 1]),
    bond_jimages: new Int8Array([0, 0, 0]),
    bond_kinds: new Uint8Array([0]),
    bond_count: 1,
    lattice: null,
    bond_radius: 0.5,
    ...overrides,
  }
}

function centroid(position: Float32Array): [number, number, number] {
  const n = position.length / 3
  let x = 0, y = 0, z = 0
  for (let i = 0; i < n; i++) {
    x += position[i * 3]
    y += position[i * 3 + 1]
    z += position[i * 3 + 2]
  }
  return [x / n, y / n, z / n]
}

describe(`bake_atoms`, () => {
  test(`stamps one scaled+translated template per visible site`, () => {
    const src = make_source({ radii: new Float32Array([2, 3]) })
    const out = bake_atoms(src, TRI_TMPL)
    expect(out).not.toBeNull()
    // 2 sites × 3 verts
    expect(out!.position.length).toBe(18)
    expect(out!.index.length).toBe(6)
    // site 0 at origin, radius 2: template vertex (1,0,0) → (2,0,0)
    expect(out!.position[3]).toBe(2)
    // site 1 at (0,4,0), radius 3: template vertex (1,0,0) → (3,4,0)
    expect(out!.position[12]).toBe(3)
    expect(out!.position[13]).toBe(4)
    // second stamp's indices offset by the template vertex count
    expect(Array.from(out!.index)).toEqual([0, 1, 2, 3, 4, 5])
    // uniform scaling leaves normals untouched
    expect(out!.normal[2]).toBe(1)
  })

  test(`per-vertex colors come from the site color`, () => {
    const out = bake_atoms(make_source(), TRI_TMPL)!
    // site 0 red on every vertex
    expect(out.color.slice(0, 9)).toEqual(
      new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]),
    )
    // site 1 blue
    expect(out.color[9 + 2]).toBe(1)
  })

  test(`radius <= 0 sites are skipped; all hidden → null`, () => {
    const one = bake_atoms(make_source({ radii: new Float32Array([0, 1]) }), TRI_TMPL)!
    expect(one.position.length).toBe(9)
    // the surviving stamp is site 1 at (0,4,0)
    expect(one.position[1]).toBe(4)
    expect(
      bake_atoms(make_source({ radii: new Float32Array([0, 0]) }), TRI_TMPL),
    ).toBeNull()
  })

  test(`null colors fall back to gray`, () => {
    const out = bake_atoms(make_source({ colors: null }), TRI_TMPL)!
    expect(out.color[0]).toBeGreaterThan(0)
    expect(out.color[0]).toBe(out.color[1])
    expect(out.color[1]).toBe(out.color[2])
  })
})

describe(`bake_bonds`, () => {
  test(`intra-cell bond bakes two solid-colored halves meeting at the midpoint`, () => {
    const out = bake_bonds(make_source(), CYL_TMPL)!
    // 2 halves × 3 verts
    expect(out.position.length).toBe(18)
    expect(out.index.length).toBe(6)
    // bond runs (0,0,0) → (0,4,0): half A centered at y=1, half B at y=3.
    // The template's own centroid sits at y=-1/6 (three verts at ∓0.5) which
    // scales by half-length 2 → offset -1/3 from each half center.
    const a = centroid(out.position.slice(0, 9) as Float32Array)
    const b = centroid(out.position.slice(9) as Float32Array)
    expect(a[1]).toBeCloseTo(1 - 1 / 3, 5)
    expect(b[1]).toBeCloseTo(3 - 1 / 3, 5)
    // half A uniformly red (site 0), half B uniformly blue (site 1)
    for (let i = 0; i < 3; i++) {
      expect(out.color[i * 3]).toBe(1)
      expect(out.color[i * 3 + 2]).toBe(0)
      expect(out.color[9 + i * 3]).toBe(0)
      expect(out.color[9 + i * 3 + 2]).toBe(1)
    }
    // radial template vertex (1, y, 0) scaled by bond_radius 0.5 → x = 0.5
    expect(Math.abs(out.position[0])).toBeCloseTo(0.5, 5)
    // radial normals survive rotation as unit vectors (bond ∥ template axis
    // → identity rotation, so the first normal stays (1,0,0))
    expect(out.normal[0]).toBeCloseTo(1, 5)
    expect(out.normal[1]).toBeCloseTo(0, 5)
  })

  test(`cross-cell bond uses b_eff = pos_b + lattice·jimage`, () => {
    const src = make_source({
      positions: new Float32Array([0, 0, 0, 2, 0, 0]),
      bond_jimages: new Int8Array([1, 0, 0]),
      lattice: new Float64Array([10, 0, 0, 0, 10, 0, 0, 0, 10]),
    })
    const out = bake_bonds(src, CYL_TMPL)!
    // b_eff = (12,0,0), so the full bond spans x ∈ [0,12]; half B's centroid
    // must sit beyond the raw endpoint x=2, out at ~x=9.
    const b = centroid(out.position.slice(9) as Float32Array)
    expect(b[0]).toBeGreaterThan(6)
    expect(b[0]).toBeLessThan(12)
    // and the whole geometry reaches near x=12
    let max_x = -Infinity
    for (let i = 0; i < out.position.length / 3; i++) {
      max_x = Math.max(max_x, out.position[i * 3])
    }
    expect(max_x).toBeGreaterThan(11)
  })

  test(`non-zero jimage without a lattice falls back to the raw endpoint`, () => {
    const src = make_source({ bond_jimages: new Int8Array([1, 0, 0]) })
    const out = bake_bonds(src, CYL_TMPL)!
    const b = centroid(out.position.slice(9) as Float32Array)
    expect(b[1]).toBeLessThan(4) // stays within the raw 0→4 segment
  })

  test(`h-bond and halo kinds are skipped`, () => {
    expect(bake_bonds(make_source({ bond_kinds: new Uint8Array([2]) }), CYL_TMPL))
      .toBeNull()
    expect(bake_bonds(make_source({ bond_kinds: new Uint8Array([3]) }), CYL_TMPL))
      .toBeNull()
  })

  test(`bonds to hidden sites are skipped`, () => {
    const src = make_source({ radii: new Float32Array([0.5, 0]) })
    expect(bake_bonds(src, CYL_TMPL)).toBeNull()
  })

  test(`degenerate zero-length bonds are trimmed out`, () => {
    const src = make_source({
      positions: new Float32Array([0, 0, 0, 0, 0, 0, 3, 0, 0]),
      colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      radii: new Float32Array([0.5, 0.5, 0.5]),
      site_count: 3,
      bond_pairs: new Uint32Array([0, 1, 0, 2]),
      bond_jimages: new Int8Array([0, 0, 0, 0, 0, 0]),
      bond_kinds: new Uint8Array([0, 0]),
      bond_count: 2,
    })
    const out = bake_bonds(src, CYL_TMPL)!
    // only the 0→2 bond survives → 2 halves
    expect(out.position.length).toBe(18)
    expect(out.index.length).toBe(6)
  })
})
