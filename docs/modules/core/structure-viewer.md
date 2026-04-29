# Structure Viewer

The structure viewer is the largest module in CatGO, providing interactive 3D visualization of crystal structures, molecules, and surfaces.

**Source:** `src/lib/structure/`

## Components

### Core

| Component | Description |
|-----------|-------------|
| `Structure.svelte` | Main orchestrator — manages state, controls, and passes data to the 3D scene |
| `StructureScene.svelte` | Three.js scene — renders atoms, bonds, lattice, labels, and handles raycasting |
| `StructureControls.svelte` | Control panel with toggles for bonds, labels, lattice, camera, and more |
| `StructureLegend.svelte` | Color legend for atom types |
| `StructureInfoPane.svelte` | Displays metadata (formula, space group, density, etc.) |

### Geometry Primitives

| Component | Description |
|-----------|-------------|
| `Bond.svelte` | Renders a bond as a cylinder between two atoms |
| `Cylinder.svelte` | Generic cylinder primitive used by bonds and arrows |
| `Arrow.svelte` | Arrow for force vectors (MD/optimization) |
| `Lattice.svelte` | Unit cell wireframe edges and lattice vectors |

### Panes & Controls

| Component | Description |
|-----------|-------------|
| `LatticePane.svelte` | Edit lattice parameters (a, b, c, alpha, beta, gamma) |
| `ExportPane.svelte` | Export structure in CIF, POSCAR, XYZ, EXTXYZ, JSON, GLB, OBJ |
| `MillerSlabCutterPane.svelte` | Generate surface slabs from Miller indices |
| `CuttingPlaneVisualizer.svelte` | Visual preview of the cutting plane |
| `OptimizationPane.svelte` | Connect to optimization server for relaxation |
| `AdsorptionSitePane.svelte` | Find adsorption sites on surfaces |
| `CubePanel.svelte` | Integrate density visualization from CUBE files |
| `CellSelect.svelte` | Supercell dimension selector (n x m x p) |

### Modals

| Component | Description |
|-----------|-------------|
| `OptimadeSearchModal.svelte` | Search OPTIMADE structure databases |
| `OptimadePreviewModal.svelte` | Preview structures before loading |
| `PubchemSearchModal.svelte` | Search molecules via PubChem |
| `PasteContentModal.svelte` | Paste structure data directly |
| `VacuumBoxModal.svelte` | Add vacuum box around structure |

## Rendering Architecture

The viewer uses **Three.js** via the **Threlte** Svelte wrapper:

- **InstancedMesh** for efficient rendering of many atoms (handles thousands of atoms)
- **BVH acceleration** (three-mesh-bvh) for fast raycasting / atom picking
- **Spatial grid** for bond detection in structures with >50 atoms
- **LOD** sphere segment count adjusts based on atom count
- **Depth cueing** — fades distant atoms and bonds toward the background color (VESTA-style) for depth perception

## Camera & Controls

- **TrackballControls** — orbit, zoom, and pan
- **Perspective** and **Orthographic** projection modes
- **Auto-rotate** mode
- **Camera reset** aligns to lattice after slab cuts / supercell operations
- **Gizmo** orientation widget for spatial reference

## Atom Interaction

### Selection
- Click to select individual atoms (raycasting)
- Selected atoms show index, element, and coordinates
- Bond selection and deletion supported

### Manipulation
- **Add atom** — insert new atom at position
- **Delete atoms** — remove selected atoms
- **Replace atom** — change element at site
- **Move atoms** — reposition via arrow keys or drag
- **Add bonds** — drag from one atom to another in bond editing mode to create a bond (or click-click as fallback)
- **Freeze atoms** — mark atoms as fixed for optimization (ring/crosshatch/dimmed indicators)

### Labels
- Site labels with element symbol
- Index display
- Custom label colors, sizes, and offsets
- Configurable via settings

### Charge Labels
Per-atom charge labels display Bader charge values directly on atoms in the 3D scene.

**Toggling labels:**
- Right-click an atom → **Charge Label** → **Show/Hide charge label** to toggle a single atom
- Right-click → **Charge Label** → **Show all charge labels** / **Hide all charge labels** for bulk control
- Labels are only visible when the atom coloring mode is set to **Charge** — switching to another mode (e.g., Element) hides them, and switching back restores them

**Repositioning:**
- Click and drag any charge label to reposition it in screen space
- Offsets persist across camera rotations and are stored per-atom
- Labels default to a position slightly above the atom to avoid blocking interactions

**Editing values:**
- Double-click a charge label to edit the value inline (Enter to confirm, Escape to cancel)
- Right-click → **Charge Label** → **Set charge value...** to manually enter a charge for any atom (useful for atoms without Bader data)

**Loading charges:**
- Import Bader charges from an ACF.dat file via right-click → **Import** → **Load charges**
- Charges are stored as `site.properties.bader_charge` on each atom

## Display Modes

### Atom Coloring
- **Element** — CPK/Jmol standard colors
- **Coordination number** — color by number of neighbors
- **Wyckoff position** — color by symmetry site
- **Charge** — color by Bader charge value (from ACF.dat); supports per-atom charge labels
- **Custom** — user-defined color per element

### Lattice Display
- Unit cell edges (wireframe)
- Lattice vectors with arrows
- Adjustable opacity
- Periodic boundary condition (PBC) image atoms

## Key Functions

```typescript
// Structure creation & manipulation
add_atom(structure, element, position)
delete_atoms(structure, indices)
replace_atom(structure, index, new_element)
move_atom(structure, index, new_position)
move_atoms_by_displacement(structure, indices, displacement)
concatenate_structures(struct_a, struct_b)

// Analysis
get_center_of_mass(structure)
get_density(structure)
calculate_inertia_tensor(structure)
get_principal_axes(structure)
align_to_principal_axes(structure)
```

## Settings

Key settings that control the structure viewer (defined in `settings.ts`):

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `atom_radius` | number | 0.4 | Atom sphere radius |
| `bond_thickness` | number | 0.15 | Bond cylinder thickness |
| `sphere_segments` | number | 16 | Sphere quality (segments) |
| `show_image_atoms` | boolean | true | Show PBC image atoms |
| `show_bonds` | boolean | true | Display bonds |
| `show_cell` | boolean | true | Display unit cell |
| `camera_projection` | string | "perspective" | Camera mode |
| `color_mode` | string | "element" | Atom coloring strategy |
| `auto_rotate` | boolean | false | Auto-rotation mode |
| `depth_cueing` | number | 0 | Fog effect strength |
