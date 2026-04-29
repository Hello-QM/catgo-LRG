# Coordination Polyhedra Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add coordination polyhedra visualization to CatGo's 3D structure viewer with mixed rendering, per-element coloring, and depth-based transparency.

**Architecture:** Two new files — `polyhedra.ts` (computation) and `CoordinationPolyhedra.svelte` (rendering). Settings added to `types.ts`/`config.ts`. StructureScene gets minimal glue: import component, compute polyhedra data in a `$derived`, and render the component. StructureControls gets a new "Polyhedra" settings section.

**Tech Stack:** Three.js (BufferGeometry, ShaderMaterial, LineSegments), quickhull3d (convex hull), Svelte 5 runes, Threlte

---

### Task 1: Install quickhull3d dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install quickhull3d**

```bash
pnpm add quickhull3d
```

- [ ] **Step 2: Verify installation**

```bash
node -e "const qh = require('quickhull3d'); console.log(typeof qh)"
```

Expected: `function` (default export is the quickhull function)

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add quickhull3d dependency for coordination polyhedra"
```

---

### Task 2: Add polyhedra settings to types.ts and config.ts

**Files:**
- Modify: `src/lib/settings/types.ts`
- Modify: `src/lib/settings/config.ts`

- [ ] **Step 1: Add type definitions to `types.ts`**

Add after the `AtomColorMode` type (line ~35):

```typescript
export const polyhedra_opacity_modes = [`uniform`, `depth_gradient`] as const
export type PolyhedraOpacityMode = (typeof polyhedra_opacity_modes)[number]
```

Add inside the `structure` block of `SettingsConfig` (after `frozen_atom_indicator`, around line 180):

```typescript
    // Polyhedra visualization
    show_polyhedra: SettingType<boolean>
    polyhedra_center_elements: SettingType<string[]>
    polyhedra_min_coordination: SettingType<number>
    polyhedra_opacity_mode: SettingType<PolyhedraOpacityMode>
    polyhedra_opacity: SettingType<number>
    polyhedra_opacity_near: SettingType<number>
    polyhedra_opacity_far: SettingType<number>
    polyhedra_edge_opacity: SettingType<number>
    polyhedra_edge_color: SettingType<string>
    polyhedra_color_overrides: SettingType<Record<string, string>>
    hide_polyhedra_center_atoms: SettingType<boolean>
    hide_polyhedra_internal_bonds: SettingType<boolean>
```

- [ ] **Step 2: Add defaults to `config.ts`**

Add inside `structure:` block after `frozen_atom_indicator` (around line 438):

```typescript
    // Polyhedra visualization
    show_polyhedra: {
      value: false,
      description: `Display coordination polyhedra around metal centers`,
    },
    polyhedra_center_elements: {
      value: [] as string[],
      description: `Elements to draw polyhedra around (empty = auto-detect metals in structure)`,
    },
    polyhedra_min_coordination: {
      value: 3,
      description: `Minimum coordination number to draw a polyhedron`,
      minimum: 3,
      maximum: 12,
    },
    polyhedra_opacity_mode: {
      value: `uniform` as const,
      description: `Opacity mode for polyhedra faces`,
      enum: {
        uniform: `Uniform`,
        depth_gradient: `Depth Gradient`,
      },
    },
    polyhedra_opacity: {
      value: 0.4,
      description: `Opacity of polyhedra faces (uniform mode)`,
      minimum: 0.05,
      maximum: 1,
    },
    polyhedra_opacity_near: {
      value: 0.6,
      description: `Opacity of nearest polyhedra faces (depth gradient mode)`,
      minimum: 0.05,
      maximum: 1,
    },
    polyhedra_opacity_far: {
      value: 0.1,
      description: `Opacity of farthest polyhedra faces (depth gradient mode)`,
      minimum: 0,
      maximum: 1,
    },
    polyhedra_edge_opacity: {
      value: 0.8,
      description: `Opacity of polyhedra edges`,
      minimum: 0,
      maximum: 1,
    },
    polyhedra_edge_color: {
      value: `#333333`,
      description: `Color of polyhedra edges`,
    },
    polyhedra_color_overrides: {
      value: {} as Record<string, string>,
      description: `Per-element color overrides for polyhedra (e.g. {"Zr": "#00aaff"})`,
    },
    hide_polyhedra_center_atoms: {
      value: true,
      description: `Hide the central atom inside each polyhedron`,
    },
    hide_polyhedra_internal_bonds: {
      value: true,
      description: `Hide bonds inside polyhedra (center-to-ligand and ligand-to-ligand)`,
    },
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/james0001/project/catgo/.worktrees/split-files && pnpm check 2>&1 | tail -5
```

Expected: No new errors from settings files (existing TS warnings are acceptable).

- [ ] **Step 4: Commit**

```bash
git add src/lib/settings/types.ts src/lib/settings/config.ts
git commit -m "feat: add polyhedra visualization settings"
```

---

### Task 3: Create `polyhedra.ts` — computation module

**Files:**
- Create: `src/lib/structure/polyhedra.ts`

- [ ] **Step 1: Create the full computation module**

Create `src/lib/structure/polyhedra.ts` with the following content:

```typescript
// Coordination polyhedra computation for structure visualization.
// Computes convex hulls around coordination centers and merges geometry
// for efficient single-draw-call rendering.

import type { AnyStructure, BondPair, Vec3 } from '$lib'
import { element_data } from '$lib/element'
import { get_bond_key } from './bonding'
import { get_orig_site_idx } from './atom-properties'
import { colors as global_colors } from '$lib/state.svelte'
import qh from 'quickhull3d'

// --- Types ---

export interface PolyhedronData {
  center_idx: number
  center_element: string
  neighbor_indices: number[]
  vertices: number[][]  // [x, y, z][] — positions of neighbor atoms
}

export interface MergedPolyhedraGeometry {
  face_positions: Float32Array   // Interleaved xyz for all triangle vertices
  face_colors: Float32Array      // RGB per vertex
  face_polyhedron_ids: Float32Array // Which polyhedron each vertex belongs to
  face_count: number             // Number of triangles
  edge_positions: Float32Array   // Interleaved xyz for line segment endpoints
  edge_count: number             // Number of line segments
}

// --- Metal element detection ---

const METAL_ELEMENTS = new Set(
  element_data
    .filter((el) => el.metal === true)
    .map((el) => el.symbol),
)

export function get_default_metal_elements(): string[] {
  return [...METAL_ELEMENTS]
}

export function is_metal(element: string): boolean {
  return METAL_ELEMENTS.has(element)
}

// --- Neighbor map ---

export function build_neighbor_map(bond_pairs: BondPair[]): Map<number, number[]> {
  const neighbors = new Map<number, number[]>()
  for (const bond of bond_pairs) {
    let list = neighbors.get(bond.site_idx_1)
    if (!list) { list = []; neighbors.set(bond.site_idx_1, list) }
    list.push(bond.site_idx_2)

    list = neighbors.get(bond.site_idx_2)
    if (!list) { list = []; neighbors.set(bond.site_idx_2, list) }
    list.push(bond.site_idx_1)
  }
  return neighbors
}

// --- Center atom selection ---

function get_site_element(structure: AnyStructure, site_idx: number): string {
  const site = structure.sites[site_idx]
  if (!site?.species?.length) return ``
  return site.species.reduce(
    (max, s) => (s.occu > max.occu ? s : max),
    site.species[0],
  ).element
}

export function filter_center_atoms(
  neighbor_map: Map<number, number[]>,
  structure: AnyStructure,
  center_elements: string[],
  min_coordination: number,
): number[] {
  // If center_elements is empty, auto-detect metals present in the structure
  const target_elements = center_elements.length > 0
    ? new Set(center_elements)
    : new Set(
        structure.sites
          .map((_, idx) => get_site_element(structure, idx))
          .filter((el) => el && is_metal(el)),
      )

  const centers: number[] = []
  for (const [idx, neighbors] of neighbor_map) {
    if (neighbors.length < min_coordination) continue
    const element = get_site_element(structure, idx)
    if (target_elements.has(element)) {
      centers.push(idx)
    }
  }
  return centers
}

// --- Polyhedra computation ---

export function compute_polyhedra(
  center_atoms: number[],
  neighbor_map: Map<number, number[]>,
  structure: AnyStructure,
): PolyhedronData[] {
  const polyhedra: PolyhedronData[] = []

  for (const center_idx of center_atoms) {
    const neighbor_indices = neighbor_map.get(center_idx)
    if (!neighbor_indices || neighbor_indices.length < 3) continue

    const vertices = neighbor_indices.map((n_idx) => {
      const pos = structure.sites[n_idx]?.xyz
      return pos ? [pos[0], pos[1], pos[2]] : [0, 0, 0]
    })

    // Need at least 3 non-collinear points for a polyhedron
    if (vertices.length < 3) continue

    // For exactly 3 points, we can't form a 3D convex hull — make a flat triangle
    // quickhull3d requires 4+ non-coplanar points
    const element = get_site_element(structure, center_idx)

    polyhedra.push({
      center_idx,
      center_element: element,
      neighbor_indices: [...neighbor_indices],
      vertices,
    })
  }

  return polyhedra
}

// --- Convex hull + geometry merging ---

function compute_hull_faces(vertices: number[][]): number[][] {
  if (vertices.length < 4) {
    // For 3 vertices: single triangle (both winding orders for double-sided)
    return [[0, 1, 2]]
  }
  try {
    return qh(vertices) as number[][]
  } catch {
    // Degenerate case (all coplanar, etc.) — fall back to fan triangulation
    const faces: number[][] = []
    for (let i = 1; i < vertices.length - 1; i++) {
      faces.push([0, i, i + 1])
    }
    return faces
  }
}

function hex_to_rgb(hex: string): [number, number, number] {
  const h = hex.replace(`#`, ``)
  return [
    parseInt(h.substring(0, 2), 16) / 255,
    parseInt(h.substring(2, 4), 16) / 255,
    parseInt(h.substring(4, 6), 16) / 255,
  ]
}

export function merge_polyhedra_geometry(
  polyhedra: PolyhedronData[],
  color_overrides: Record<string, string>,
): MergedPolyhedraGeometry {
  if (polyhedra.length === 0) {
    return {
      face_positions: new Float32Array(0),
      face_colors: new Float32Array(0),
      face_polyhedron_ids: new Float32Array(0),
      face_count: 0,
      edge_positions: new Float32Array(0),
      edge_count: 0,
    }
  }

  // First pass: compute hulls and count geometry
  const hulls: { faces: number[][]; edge_set: Set<string> }[] = []
  let total_tris = 0
  let total_edges = 0

  for (const poly of polyhedra) {
    const faces = compute_hull_faces(poly.vertices)
    const edge_set = new Set<string>()
    for (const face of faces) {
      for (let i = 0; i < face.length; i++) {
        const a = face[i]
        const b = face[(i + 1) % face.length]
        const key = a < b ? `${a}-${b}` : `${b}-${a}`
        edge_set.add(key)
      }
    }
    hulls.push({ faces, edge_set })
    total_tris += faces.length
    total_edges += edge_set.size
  }

  // Allocate
  const face_positions = new Float32Array(total_tris * 9)   // 3 verts × 3 coords
  const face_colors = new Float32Array(total_tris * 9)      // 3 verts × 3 RGB
  const face_polyhedron_ids = new Float32Array(total_tris * 3)
  const edge_positions = new Float32Array(total_edges * 6)   // 2 verts × 3 coords

  let tri_offset = 0
  let edge_offset = 0

  for (let p = 0; p < polyhedra.length; p++) {
    const poly = polyhedra[p]
    const hull = hulls[p]

    // Resolve color: override > element color > fallback cyan
    let color: [number, number, number]
    if (color_overrides[poly.center_element]) {
      color = hex_to_rgb(color_overrides[poly.center_element])
    } else {
      const el_color = global_colors.element?.[poly.center_element]
      if (el_color) {
        color = hex_to_rgb(el_color)
      } else {
        color = [0, 0.7, 0.9] // fallback cyan
      }
    }

    // Write face triangles
    for (const face of hull.faces) {
      for (let v = 0; v < 3; v++) {
        const vert = poly.vertices[face[v]]
        const base = tri_offset * 9 + v * 3
        face_positions[base] = vert[0]
        face_positions[base + 1] = vert[1]
        face_positions[base + 2] = vert[2]
        face_colors[base] = color[0]
        face_colors[base + 1] = color[1]
        face_colors[base + 2] = color[2]
        face_polyhedron_ids[tri_offset * 3 + v] = p
      }
      tri_offset++
    }

    // Write edges
    for (const edge_key of hull.edge_set) {
      const [a_str, b_str] = edge_key.split(`-`)
      const a = parseInt(a_str)
      const b = parseInt(b_str)
      const va = poly.vertices[a]
      const vb = poly.vertices[b]
      const base = edge_offset * 6
      edge_positions[base] = va[0]
      edge_positions[base + 1] = va[1]
      edge_positions[base + 2] = va[2]
      edge_positions[base + 3] = vb[0]
      edge_positions[base + 4] = vb[1]
      edge_positions[base + 5] = vb[2]
      edge_offset++
    }
  }

  return {
    face_positions,
    face_colors,
    face_polyhedron_ids,
    face_count: total_tris,
    edge_positions,
    edge_count: total_edges,
  }
}

// --- Visibility helpers ---

export function get_polyhedra_hidden_atoms(
  polyhedra: PolyhedronData[],
  hide_center: boolean,
): Map<number, number> {
  const overrides = new Map<number, number>()
  for (const poly of polyhedra) {
    if (hide_center) {
      overrides.set(poly.center_idx, 0)
    }
  }
  return overrides
}

export function get_polyhedra_hidden_bond_keys(
  polyhedra: PolyhedronData[],
): Set<string> {
  const keys = new Set<string>()
  for (const poly of polyhedra) {
    // Center-to-neighbor bonds
    for (const n of poly.neighbor_indices) {
      keys.add(get_bond_key(poly.center_idx, n))
    }
    // Neighbor-to-neighbor bonds (within the same polyhedron)
    for (let i = 0; i < poly.neighbor_indices.length; i++) {
      for (let j = i + 1; j < poly.neighbor_indices.length; j++) {
        keys.add(get_bond_key(poly.neighbor_indices[i], poly.neighbor_indices[j]))
      }
    }
  }
  return keys
}

// --- Detect which metal elements are present in a structure ---

export function get_metals_in_structure(structure: AnyStructure | undefined): string[] {
  if (!structure?.sites) return []
  const metals = new Set<string>()
  for (const site of structure.sites) {
    const el = site.species?.[0]?.element
    if (el && is_metal(el)) metals.add(el)
  }
  return [...metals].sort()
}
```

- [ ] **Step 2: Verify the module compiles**

```bash
cd /home/james0001/project/catgo/.worktrees/split-files && pnpm check 2>&1 | grep -i "polyhedra" | head -10
```

Expected: No errors related to polyhedra.ts (or only pre-existing TS warnings).

- [ ] **Step 3: Commit**

```bash
git add src/lib/structure/polyhedra.ts
git commit -m "feat: add polyhedra computation module (convex hull, geometry merge, visibility)"
```

---

### Task 4: Create `CoordinationPolyhedra.svelte` — rendering component

**Files:**
- Create: `src/lib/structure/CoordinationPolyhedra.svelte`

- [ ] **Step 1: Create the rendering component**

Create `src/lib/structure/CoordinationPolyhedra.svelte`:

```svelte
<script lang="ts">
  import type { MergedPolyhedraGeometry } from './polyhedra'
  import type { PolyhedraOpacityMode } from '$lib/settings'
  import { T } from '@threlte/core'
  import {
    BufferGeometry,
    BufferAttribute,
    ShaderMaterial,
    LineBasicMaterial,
    DoubleSide,
  } from 'three'

  let {
    geometry,
    opacity_mode = `uniform`,
    opacity = 0.4,
    opacity_near = 0.6,
    opacity_far = 0.1,
    edge_color = `#333333`,
    edge_opacity = 0.8,
  }: {
    geometry: MergedPolyhedraGeometry
    opacity_mode?: PolyhedraOpacityMode
    opacity?: number
    opacity_near?: number
    opacity_far?: number
    edge_color?: string
    edge_opacity?: number
  } = $props()

  // --- Face geometry ---
  let face_geom = $derived.by(() => {
    const g = new BufferGeometry()
    if (geometry.face_count === 0) return g
    g.setAttribute(`position`, new BufferAttribute(geometry.face_positions, 3))
    g.setAttribute(`faceColor`, new BufferAttribute(geometry.face_colors, 3))
    g.computeBoundingSphere()
    return g
  })

  // --- Face shader material ---
  const face_vertex_shader = `
    attribute vec3 faceColor;
    varying vec3 vColor;
    varying vec3 vWorldPosition;

    void main() {
      vColor = faceColor;
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPos.xyz;
      gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
  `

  const face_fragment_shader = `
    uniform float u_opacity;
    uniform float u_opacity_near;
    uniform float u_opacity_far;
    uniform int u_opacity_mode;
    uniform float u_depth_min;
    uniform float u_depth_max;
    uniform vec3 u_camera_pos;

    varying vec3 vColor;
    varying vec3 vWorldPosition;

    void main() {
      // Flat shading via screen-space derivatives
      vec3 dx = dFdx(vWorldPosition);
      vec3 dy = dFdy(vWorldPosition);
      vec3 normal = normalize(cross(dx, dy));

      // Simple headlamp lighting (view-space)
      vec3 view_dir = normalize(u_camera_pos - vWorldPosition);
      float ndotl = abs(dot(normal, view_dir));
      float light = 0.3 + 0.7 * ndotl;

      // Opacity
      float alpha;
      if (u_opacity_mode == 0) {
        alpha = u_opacity;
      } else {
        float dist = distance(u_camera_pos, vWorldPosition);
        float t = clamp((dist - u_depth_min) / (u_depth_max - u_depth_min + 0.001), 0.0, 1.0);
        alpha = mix(u_opacity_near, u_opacity_far, t);
      }

      gl_FragColor = vec4(vColor * light, alpha);
    }
  `

  let face_material = $derived.by(() => {
    return new ShaderMaterial({
      vertexShader: face_vertex_shader,
      fragmentShader: face_fragment_shader,
      uniforms: {
        u_opacity: { value: opacity },
        u_opacity_near: { value: opacity_near },
        u_opacity_far: { value: opacity_far },
        u_opacity_mode: { value: opacity_mode === `depth_gradient` ? 1 : 0 },
        u_depth_min: { value: 0 },
        u_depth_max: { value: 100 },
        u_camera_pos: { value: [0, 0, 50] },
      },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    })
  })

  // Update uniforms reactively without recreating material
  $effect(() => {
    const mat = face_material
    mat.uniforms.u_opacity.value = opacity
    mat.uniforms.u_opacity_near.value = opacity_near
    mat.uniforms.u_opacity_far.value = opacity_far
    mat.uniforms.u_opacity_mode.value = opacity_mode === `depth_gradient` ? 1 : 0
    mat.needsUpdate = true
  })

  // --- Edge geometry ---
  let edge_geom = $derived.by(() => {
    const g = new BufferGeometry()
    if (geometry.edge_count === 0) return g
    g.setAttribute(`position`, new BufferAttribute(geometry.edge_positions, 3))
    g.computeBoundingSphere()
    return g
  })

  let edge_material = $derived.by(() => {
    return new LineBasicMaterial({
      color: edge_color,
      transparent: true,
      opacity: edge_opacity,
      depthTest: true,
    })
  })

  $effect(() => {
    edge_material.color.set(edge_color)
    edge_material.opacity = edge_opacity
    edge_material.needsUpdate = true
  })
</script>

{#if geometry.face_count > 0}
  <T.Mesh
    geometry={face_geom}
    material={face_material}
    frustumCulled={false}
    renderOrder={2}
  />
{/if}

{#if geometry.edge_count > 0}
  <T.LineSegments
    geometry={edge_geom}
    material={edge_material}
    frustumCulled={false}
    renderOrder={3}
  />
{/if}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/structure/CoordinationPolyhedra.svelte
git commit -m "feat: add CoordinationPolyhedra rendering component (shader + edges)"
```

---

### Task 5: Integrate into StructureScene.svelte — minimal glue

**Files:**
- Modify: `src/lib/structure/StructureScene.svelte`

The goal is **minimal** changes. All computation is in `polyhedra.ts`, all rendering is in `CoordinationPolyhedra.svelte`. StructureScene only:
1. Imports the component and computation functions
2. Accepts polyhedra-related props
3. Adds a `$derived` to compute polyhedra data
4. Renders `<CoordinationPolyhedra>` in the scene tree
5. Merges polyhedra hidden atoms into `atom_opacity_overrides`
6. Merges polyhedra hidden bonds into `filtered_bond_pairs`

- [ ] **Step 1: Add imports** (after existing imports, around line 48)

Add after `import { get_orig_site_idx, type AtomPropertyColors } from './atom-properties'`:

```typescript
import CoordinationPolyhedra from './CoordinationPolyhedra.svelte'
import {
  build_neighbor_map,
  filter_center_atoms,
  compute_polyhedra,
  merge_polyhedra_geometry,
  get_polyhedra_hidden_atoms,
  get_polyhedra_hidden_bond_keys,
  type MergedPolyhedraGeometry,
} from './polyhedra'
```

- [ ] **Step 2: Add polyhedra props** (inside the props destructuring, after `frozen_atom_indicator`)

Find the props section (around line 640) and add after `frozen_atom_indicator`:

```typescript
    // Polyhedra visualization
    show_polyhedra?: boolean
    polyhedra_center_elements?: string[]
    polyhedra_min_coordination?: number
    polyhedra_opacity_mode?: import('$lib/settings').PolyhedraOpacityMode
    polyhedra_opacity?: number
    polyhedra_opacity_near?: number
    polyhedra_opacity_far?: number
    polyhedra_edge_opacity?: number
    polyhedra_edge_color?: string
    polyhedra_color_overrides?: Record<string, string>
    hide_polyhedra_center_atoms?: boolean
    hide_polyhedra_internal_bonds?: boolean
```

- [ ] **Step 3: Add polyhedra computation** (after `show_bulk_atoms` derived, around line 1436)

Add after the `_hidden_sites` `$effect` block (around line 1448):

```typescript
  // --- Polyhedra computation ---
  let polyhedra_data = $derived.by(() => {
    if (!show_polyhedra || !structure?.sites || !bond_pairs.length) return []
    try {
      const neighbor_map = build_neighbor_map(bond_pairs)
      const center_atoms = filter_center_atoms(
        neighbor_map, structure,
        polyhedra_center_elements ?? [],
        polyhedra_min_coordination ?? 3,
      )
      return compute_polyhedra(center_atoms, neighbor_map, structure)
    } catch (err) {
      console.warn(`[CatGo] Polyhedra computation failed:`, err)
      return []
    }
  })

  let polyhedra_geometry: MergedPolyhedraGeometry = $derived.by(() => {
    if (!polyhedra_data.length) {
      return { face_positions: new Float32Array(0), face_colors: new Float32Array(0), face_polyhedron_ids: new Float32Array(0), face_count: 0, edge_positions: new Float32Array(0), edge_count: 0 }
    }
    try {
      return merge_polyhedra_geometry(polyhedra_data, polyhedra_color_overrides ?? {})
    } catch (err) {
      console.warn(`[CatGo] Polyhedra geometry merge failed:`, err)
      return { face_positions: new Float32Array(0), face_colors: new Float32Array(0), face_polyhedron_ids: new Float32Array(0), face_count: 0, edge_positions: new Float32Array(0), edge_count: 0 }
    }
  })

  let polyhedra_hidden_atoms = $derived.by(() => {
    if (!show_polyhedra || !polyhedra_data.length || !hide_polyhedra_center_atoms) {
      return new Map<number, number>()
    }
    return get_polyhedra_hidden_atoms(polyhedra_data, true)
  })

  let polyhedra_hidden_bond_keys = $derived.by(() => {
    if (!show_polyhedra || !polyhedra_data.length || !hide_polyhedra_internal_bonds) {
      return new Set<string>()
    }
    return get_polyhedra_hidden_bond_keys(polyhedra_data)
  })
```

- [ ] **Step 4: Merge polyhedra hidden atoms into `atom_opacity_overrides`**

Find the `<AtomImpostors>` tag (around line 2277). Change `{atom_opacity_overrides}` to pass merged overrides.

Add a `$derived` near the polyhedra computation block:

```typescript
  let merged_atom_opacity_overrides = $derived.by(() => {
    if (polyhedra_hidden_atoms.size === 0) return atom_opacity_overrides
    const merged = new Map(atom_opacity_overrides)
    for (const [idx, opacity] of polyhedra_hidden_atoms) {
      merged.set(idx, opacity)
    }
    return merged
  })
```

Then in the `<AtomImpostors>` tag, change:
```
{atom_opacity_overrides}
```
to:
```
atom_opacity_overrides={merged_atom_opacity_overrides}
```

- [ ] **Step 5: Merge polyhedra hidden bonds into `filtered_bond_pairs`**

In the existing `filtered_bond_pairs` `$derived.by()` (around line 1538), add a filter at the end of the `result` pipeline, just before `return result`:

```typescript
    // Filter bonds hidden by polyhedra
    if (polyhedra_hidden_bond_keys.size > 0) {
      result = result.filter((bond) => {
        const key = get_bond_key(bond.site_idx_1, bond.site_idx_2)
        return !polyhedra_hidden_bond_keys.has(key)
      })
    }
```

Add this right before the `return result` on line ~1609.

- [ ] **Step 6: Render `<CoordinationPolyhedra>` in the scene tree**

In the template, after `<AtomImpostors ... />` (around line 2289), add:

```svelte
        {#if show_polyhedra && polyhedra_geometry.face_count > 0}
          <CoordinationPolyhedra
            geometry={polyhedra_geometry}
            opacity_mode={polyhedra_opacity_mode}
            opacity={polyhedra_opacity}
            opacity_near={polyhedra_opacity_near}
            opacity_far={polyhedra_opacity_far}
            edge_color={polyhedra_edge_color}
            edge_opacity={polyhedra_edge_opacity}
          />
        {/if}
```

- [ ] **Step 7: Verify it compiles**

```bash
cd /home/james0001/project/catgo/.worktrees/split-files && pnpm check 2>&1 | tail -10
```

- [ ] **Step 8: Commit**

```bash
git add src/lib/structure/StructureScene.svelte
git commit -m "feat: integrate polyhedra rendering into StructureScene (minimal glue)"
```

---

### Task 6: Wire polyhedra settings through Structure.svelte to StructureScene

**Files:**
- Modify: `src/lib/structure/Structure.svelte` — pass polyhedra scene_props to StructureScene

The `scene_props` object is spread into `<StructureScene>` via `{...scene_props}`. Since we added the polyhedra settings to the `structure` section of the settings config, they will automatically appear in `scene_props` after being loaded from DEFAULTS.

- [ ] **Step 1: Verify scene_props spreading**

Check that `<StructureScene>` receives `{...scene_props}` in Structure.svelte. Find the `<StructureScene` tag (around line 7030). It should have `{...scene_props}` or equivalent spread.

If `scene_props` is spread and the polyhedra settings are in DEFAULTS.structure, they'll be passed automatically. No manual wiring needed.

```bash
grep -n "scene_props" src/lib/structure/Structure.svelte | head -20
```

Verify that the settings controller creates `scene_props` from `DEFAULTS.structure`. If polyhedra settings are in `config.ts` under `structure:`, they'll be in the scene_props.

- [ ] **Step 2: Commit** (only if changes were needed)

```bash
git add src/lib/structure/Structure.svelte
git commit -m "feat: wire polyhedra settings from Structure to StructureScene"
```

---

### Task 7: Add Polyhedra settings section to StructureControls

**Files:**
- Modify: `src/lib/structure/StructureControls.svelte`

- [ ] **Step 1: Add Polyhedra section**

Find the "Hydrogen Bonds" `<SettingsSection>` block (around line 914). Add a new section **before** it:

```svelte
  <SettingsSection
    title="Polyhedra"
    current_values={{
      show_polyhedra: scene_props.show_polyhedra,
      polyhedra_opacity: scene_props.polyhedra_opacity,
      polyhedra_opacity_mode: scene_props.polyhedra_opacity_mode,
      polyhedra_edge_color: scene_props.polyhedra_edge_color,
      hide_polyhedra_center_atoms: scene_props.hide_polyhedra_center_atoms,
      hide_polyhedra_internal_bonds: scene_props.hide_polyhedra_internal_bonds,
    }}
    on_reset={() => {
      scene_props.show_polyhedra = DEFAULTS.structure.show_polyhedra
      scene_props.polyhedra_center_elements = DEFAULTS.structure.polyhedra_center_elements
      scene_props.polyhedra_min_coordination = DEFAULTS.structure.polyhedra_min_coordination
      scene_props.polyhedra_opacity_mode = DEFAULTS.structure.polyhedra_opacity_mode
      scene_props.polyhedra_opacity = DEFAULTS.structure.polyhedra_opacity
      scene_props.polyhedra_opacity_near = DEFAULTS.structure.polyhedra_opacity_near
      scene_props.polyhedra_opacity_far = DEFAULTS.structure.polyhedra_opacity_far
      scene_props.polyhedra_edge_opacity = DEFAULTS.structure.polyhedra_edge_opacity
      scene_props.polyhedra_edge_color = DEFAULTS.structure.polyhedra_edge_color
      scene_props.polyhedra_color_overrides = DEFAULTS.structure.polyhedra_color_overrides
      scene_props.hide_polyhedra_center_atoms = DEFAULTS.structure.hide_polyhedra_center_atoms
      scene_props.hide_polyhedra_internal_bonds = DEFAULTS.structure.hide_polyhedra_internal_bonds
    }}
  >
    <label>
      <input type="checkbox" bind:checked={scene_props.show_polyhedra} />
      Show Polyhedra
    </label>
    {#if scene_props.show_polyhedra}
      <label>
        Min Coordination
        <input
          type="number"
          min="3"
          max="12"
          step="1"
          bind:value={scene_props.polyhedra_min_coordination}
        />
      </label>
      <label>
        Opacity Mode
        <select bind:value={scene_props.polyhedra_opacity_mode}>
          <option value="uniform">Uniform</option>
          <option value="depth_gradient">Depth Gradient</option>
        </select>
      </label>
      {#if scene_props.polyhedra_opacity_mode === `uniform`}
        <label>
          Face Opacity
          <input
            type="range"
            min="0.05"
            max="1"
            step="0.05"
            bind:value={scene_props.polyhedra_opacity}
          />
        </label>
      {:else}
        <label>
          Near Opacity
          <input
            type="range"
            min="0.05"
            max="1"
            step="0.05"
            bind:value={scene_props.polyhedra_opacity_near}
          />
        </label>
        <label>
          Far Opacity
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            bind:value={scene_props.polyhedra_opacity_far}
          />
        </label>
      {/if}
      <label>
        Edge Color
        <input type="color" bind:value={scene_props.polyhedra_edge_color} />
      </label>
      <label>
        Edge Opacity
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          bind:value={scene_props.polyhedra_edge_opacity}
        />
      </label>
      <label>
        <input type="checkbox" bind:checked={scene_props.hide_polyhedra_center_atoms} />
        Hide Center Atoms
      </label>
      <label>
        <input type="checkbox" bind:checked={scene_props.hide_polyhedra_internal_bonds} />
        Hide Internal Bonds
      </label>
    {/if}
  </SettingsSection>
```

- [ ] **Step 2: Import DEFAULTS if not already imported**

Check top of StructureControls.svelte for existing DEFAULTS import. It should already have:
```typescript
import { DEFAULTS, SETTINGS_CONFIG } from '$lib/settings'
```

If not, add it.

- [ ] **Step 3: Verify it compiles**

```bash
cd /home/james0001/project/catgo/.worktrees/split-files && pnpm check 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/structure/StructureControls.svelte
git commit -m "feat: add Polyhedra settings section to StructureControls"
```

---

### Task 8: Update camera position uniform for depth-gradient opacity

**Files:**
- Modify: `src/lib/structure/CoordinationPolyhedra.svelte`
- Modify: `src/lib/structure/StructureScene.svelte`

The depth-gradient opacity needs the camera position to compute distance. Pass it from StructureScene.

- [ ] **Step 1: Add camera_position prop to CoordinationPolyhedra**

In `CoordinationPolyhedra.svelte`, add to props:

```typescript
    camera_position?: [number, number, number]
```

Add an `$effect` to update the uniform:

```typescript
  $effect(() => {
    if (camera_position) {
      face_material.uniforms.u_camera_pos.value = camera_position
    }
  })
```

- [ ] **Step 2: Pass camera position from StructureScene**

In StructureScene, where `<CoordinationPolyhedra>` is rendered, add the camera position prop. The camera is available via `threlte.camera.current`:

Add a derived to get camera position:

```typescript
  let _camera_world_pos = $state<[number, number, number]>([0, 0, 50])
```

In the existing `useTask` (render loop), add camera position sync:

```typescript
  // Inside an existing useTask or add to the frame loop
  // Update camera world position for polyhedra depth gradient
  if (show_polyhedra && polyhedra_geometry.face_count > 0) {
    const cam = threlte.camera.current
    if (cam) {
      cam.updateMatrixWorld()
      const wp = cam.getWorldPosition(new Vector3())
      _camera_world_pos = [wp.x, wp.y, wp.z]
    }
  }
```

Then pass to the component:

```svelte
<CoordinationPolyhedra
  ...
  camera_position={_camera_world_pos}
/>
```

- [ ] **Step 3: Also compute and pass depth range**

The depth-gradient shader needs min/max depth values. Add to the useTask camera position sync:

```typescript
  // Compute depth range from polyhedra geometry bounding box
  if (show_polyhedra && polyhedra_geometry.face_count > 0) {
    const cam = threlte.camera.current
    if (cam) {
      cam.updateMatrixWorld()
      const wp = cam.getWorldPosition(new Vector3())
      _camera_world_pos = [wp.x, wp.y, wp.z]

      // Compute depth range from face positions
      const positions = polyhedra_geometry.face_positions
      let min_dist = Infinity, max_dist = 0
      for (let i = 0; i < positions.length; i += 3) {
        const dx = positions[i] - wp.x
        const dy = positions[i + 1] - wp.y
        const dz = positions[i + 2] - wp.z
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (d < min_dist) min_dist = d
        if (d > max_dist) max_dist = d
      }
      _polyhedra_depth_range = [min_dist, max_dist]
    }
  }
```

Add state and pass to component:

```typescript
let _polyhedra_depth_range = $state<[number, number]>([0, 100])
```

In CoordinationPolyhedra, add prop and uniform update:

```typescript
    depth_range?: [number, number]
```

```typescript
  $effect(() => {
    if (depth_range) {
      face_material.uniforms.u_depth_min.value = depth_range[0]
      face_material.uniforms.u_depth_max.value = depth_range[1]
    }
  })
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/structure/CoordinationPolyhedra.svelte src/lib/structure/StructureScene.svelte
git commit -m "feat: add camera-aware depth gradient for polyhedra opacity"
```

---

### Task 9: Visual testing and polish

**Files:**
- No new files — test with an actual structure

- [ ] **Step 1: Start the dev server**

```bash
cd /home/james0001/project/catgo/.worktrees/split-files && pnpm dev
```

- [ ] **Step 2: Load a test structure**

Load a structure with metal centers (e.g., MOF CIF, or a simple crystal like TiO2, Fe2O3). Open Settings → Polyhedra → Enable "Show Polyhedra".

- [ ] **Step 3: Verify features**

Check each feature:
1. Polyhedra appear around metal centers
2. Toggle "Hide Center Atoms" → center atoms disappear
3. Toggle "Hide Internal Bonds" → bonds inside polyhedra disappear
4. Change opacity slider → faces change transparency
5. Switch to "Depth Gradient" → near faces opaque, far faces transparent
6. Change edge color → edges update
7. Disable "Show Polyhedra" → everything disappears cleanly

- [ ] **Step 4: Fix any visual issues found during testing**

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: coordination polyhedra visualization complete"
```
