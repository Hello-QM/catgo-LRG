# Coordination Polyhedra Rendering

## Summary

Add coordination polyhedra visualization to CatGo's 3D structure viewer. Renders convex hull polyhedra around user-selected metal centers with mixed rendering mode (polyhedra for metals, ball-and-stick for organic parts) and depth-based transparency.

## Requirements

1. Draw convex hull polyhedra around coordination centers
2. Element-based center selection, defaulting to metals
3. Per-element color with override capability
4. Two opacity modes: uniform and depth-gradient
5. Mixed rendering: hide center atoms and internal bonds when polyhedra are shown
6. Minimize changes to StructureScene.svelte — all logic in new files

## Architecture

### New Files

**`src/lib/structure/polyhedra.ts`** — All computation logic:
- `build_neighbor_map(bond_pairs)` → `Map<number, number[]>`
- `filter_center_atoms(neighbor_map, structure, center_elements, min_coordination)` → `number[]`
- `compute_polyhedra(center_atoms, neighbor_map, structure)` → `PolyhedronData[]`
- `merge_polyhedra_geometry(polyhedra, element_colors, color_overrides)` → `{ faces_geometry, edges_geometry }`
- `get_polyhedra_hidden_atoms(polyhedra, hide_center, hide_ligands)` → `Map<number, number>` (opacity overrides)
- `get_polyhedra_hidden_bonds(polyhedra)` → `Set<string>` (bond keys to filter)
- `DEFAULT_METAL_ELEMENTS` — default set of metal element symbols
- Type exports: `PolyhedronData`, `PolyhedraGeometry`

**`src/lib/structure/CoordinationPolyhedra.svelte`** — Rendering component:
- Receives pre-computed merged geometry from parent
- Renders faces via `THREE.Mesh` + custom `ShaderMaterial`
- Renders edges via `THREE.LineSegments` + `LineBasicMaterial`
- Shader handles both uniform and depth-gradient opacity modes
- `side: DoubleSide`, `depthWrite: false`, `transparent: true`

### Modified Files

**`src/lib/settings/types.ts`** — Add polyhedra setting types:
```typescript
show_polyhedra: boolean
polyhedra_center_elements: string[]    // default: DEFAULT_METAL_ELEMENTS
polyhedra_min_coordination: number     // default: 3
polyhedra_opacity_mode: 'uniform' | 'depth_gradient'
polyhedra_opacity: number              // default: 0.4
polyhedra_opacity_near: number         // default: 0.6
polyhedra_opacity_far: number          // default: 0.1
polyhedra_edge_opacity: number         // default: 0.8
polyhedra_edge_color: string           // default: '#333333'
polyhedra_color_overrides: Record<string, string>  // per-element color
hide_polyhedra_center_atoms: boolean   // default: true
hide_polyhedra_internal_bonds: boolean // default: true
```

**`src/lib/settings/config.ts`** — Default values for above settings.

**`src/lib/structure/StructureScene.svelte`** — Minimal additions only:
- Import `CoordinationPolyhedra` component
- Import `compute_polyhedra`, `merge_polyhedra_geometry`, `get_polyhedra_hidden_atoms`, `get_polyhedra_hidden_bonds` from `polyhedra.ts`
- Add `$derived` for polyhedra data (calls into polyhedra.ts)
- Feed hidden atoms into existing `atom_opacity_overrides`
- Feed hidden bonds into existing `filtered_bond_pairs`
- Render `<CoordinationPolyhedra>` in scene tree

**`src/lib/structure/StructureControls.svelte`** (or equivalent settings panel) — Add Polyhedra settings group.

### Data Flow

```
bond_pairs + displayed_structure + settings
    ↓ ($derived in StructureScene, calls polyhedra.ts)
polyhedra_data: PolyhedronData[]
    ↓
merge_polyhedra_geometry() → faces_geometry + edges_geometry
    ↓
<CoordinationPolyhedra {faces_geometry} {edges_geometry} {settings} />

polyhedra_data
    ↓
get_polyhedra_hidden_atoms() → merged into atom_opacity_overrides
get_polyhedra_hidden_bonds() → merged into filtered_bond_pairs filter
```

### Shader Design

Vertex shader passes camera-space depth to fragment shader. Fragment shader computes alpha based on opacity mode:

- **Uniform:** `alpha = u_opacity`
- **Depth gradient:** `alpha = mix(u_opacity_near, u_opacity_far, normalized_depth)`

Lighting uses `dFdx`/`dFdy` screen-space normals for flat shading per face.

### Dependencies

- `quickhull3d` npm package (~15KB, zero dependencies) for convex hull computation
- All Three.js APIs used are built-in (BufferGeometry, ShaderMaterial, LineSegments)

### Out of Scope

- Pore/cavity sphere visualization
- Automatic MOF node/linker detection
- Non-convex polyhedra
- Per-polyhedron interaction (click, hover)
