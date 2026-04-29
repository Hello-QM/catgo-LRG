# Getting Started

This tutorial walks you through loading your first crystal structure in CatGO, exploring the 3D viewer, and exporting the result.

## Loading a Structure

CatGO supports several ways to load structures:

### Drag and Drop

The simplest method — drag a structure file (`.cif`, `.poscar`, `.xyz`, `.extxyz`, `.json`) directly onto the 3D viewer. Compressed files (`.gz`, `.zip`) are also supported.

### File Picker

Click the **Import** button in the toolbar to open a file browser dialog.

### Paste Content

Click the **Paste** button (or use the paste icon in the toolbar) to open a text modal. Paste CIF, POSCAR, or XYZ content directly and press **Ctrl+Enter** (or **Cmd+Enter** on macOS) to import.

### Database Search

Use the **OPTIMADE** or **PubChem** search modals to find structures from online databases. See the [Database Search tutorial](/tutorials/structures/database-search) for details.

## Navigating the 3D Viewer

Once a structure is loaded, you can interact with it using the mouse and keyboard:

### Mouse Controls

| Action | Control |
|--------|---------|
| Rotate | Left-click and drag |
| Roll | Right-click and drag |
| Zoom | Scroll wheel |
| Pan | Shift + drag (or Ctrl/Cmd + drag) |

### Keyboard Controls

| Key | Action |
|-----|--------|
| Arrow keys | Rotate structure (pitch and yaw) |
| W / S | Roll structure |
| R | Reset camera to default view |
| F | Toggle fullscreen |
| I | Toggle info pane |
| Escape | Close open panes / exit editing modes |

## Selecting Atoms

- **Click** an atom to select it — the info pane shows its element, index, and coordinates.
- **Shift+click** to add/remove atoms from the selection.
- **Double-click** the background to clear the selection.
- **Delete** or **Backspace** removes selected atoms from the structure.

## Toggling Display Options

Use the **Controls** panel (gear icon) to adjust the viewer:

| Option | Description |
|--------|-------------|
| Show Bonds | Toggle bond display |
| Show Cell | Display unit cell wireframe |
| Show Image Atoms | Show PBC image atoms on cell edges |
| Show Labels | Element symbols on atoms |
| Camera Projection | Switch between perspective and orthographic |
| Color Scheme | Choose from Vesta, Jmol, Alloy, Pastel, Muted, Dark Mode |
| Atom Radius | Adjust sphere size |
| Depth Cueing | Add fog effect for depth perception |

## Inspecting Structure Properties

Press **I** or click the info icon to open the **Info Pane**, which shows:

- Chemical formula and composition
- Space group and crystal system (via Spglib/Moyo)
- Lattice parameters (a, b, c, alpha, beta, gamma)
- Cell volume and density
- Number of sites

## Exporting

Click the **Export** button in the toolbar to save the structure:

| Format | Extension | Use Case |
|--------|-----------|----------|
| CIF | `.cif` | Standard crystallographic exchange |
| POSCAR | `.poscar` | VASP input files |
| XYZ | `.xyz` | Simple Cartesian coordinates |
| Extended XYZ | `.extxyz` | XYZ with lattice and properties |
| JSON | `.json` | Pymatgen-compatible JSON |
| GLB | `.glb` | 3D model for presentations |
| OBJ | `.obj` | 3D model for rendering software |

## Undo / Redo

All structure modifications (adding/deleting/moving atoms, slab cuts, supercells) support undo and redo:

- **Ctrl+Z** (Cmd+Z on macOS) — Undo
- **Ctrl+Shift+Z** (Cmd+Shift+Z on macOS) — Redo

## Next Steps

- [Building Slabs](/tutorials/structures/building-slabs) — Generate surface slabs from Miller indices
- [Running an Optimization](/tutorials/structures/optimization) — Relax structures with ML potentials
- [Searching Databases](/tutorials/structures/database-search) — Find structures from OPTIMADE, Materials Project, and PubChem
