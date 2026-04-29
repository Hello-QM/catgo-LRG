# File I/O

CatGO supports reading and writing crystal and molecular structures in multiple standard file formats.

**Source:** `src/lib/structure/parse.ts`, `src/lib/structure/ferrox-wasm.ts`, `src/lib/io/`

## Supported Import Formats

| Format | Extensions | Description |
|--------|-----------|-------------|
| CIF | `.cif` | Crystallographic Information File — standard for crystal structures |
| POSCAR | `.poscar`, `.vasp`, `POSCAR`, `CONTCAR` | VASP structure format |
| XYZ | `.xyz` | Simple Cartesian coordinates |
| Extended XYZ | `.extxyz` | XYZ with lattice and per-atom properties |
| ASE Trajectory | `.traj` | ASE native binary trajectory format |
| HDF5 | `.hdf5`, `.h5` | Hierarchical Data Format (multi-frame) |
| XDATCAR | `XDATCAR` | VASP molecular dynamics trajectory |
| CUBE | `.cube` | Gaussian/VASP volumetric data |

### Compressed Files

All formats can be loaded from compressed archives:
- **gzip** (`.gz`) — e.g. `structure.cif.gz`
- **bzip2** (`.bz2`)
- **zip** (`.zip`)

## Supported Export Formats

| Format | Function | Description |
|--------|----------|-------------|
| CIF | `export_structure_as_cif()` | Crystallographic Information File |
| POSCAR | `export_structure_as_poscar()` | VASP structure format |
| XYZ | `export_structure_as_xyz()` | Simple Cartesian coordinates |
| Extended XYZ | `export_structure_as_extxyz()` | XYZ with lattice info |
| JSON | `export_structure_as_json()` | Pymatgen-compatible JSON |
| GLB | `export_scene_as_glb()` | 3D model (glTF Binary) |
| OBJ | `export_scene_as_obj()` | Wavefront 3D model |

## Key Functions

### Parsing

```typescript
// Parse structure from file content (auto-detects format)
parse_structure_from_file(content: string | ArrayBuffer, filename: string): PymatgenStructure

// Individual parsers (also available via WASM)
wasm_parse_cif(cif_string: string): PymatgenStructure
wasm_parse_poscar(poscar_string: string): PymatgenStructure
```

### Exporting

```typescript
// Export to string (for saving)
structure_to_cif_str(structure): string
structure_to_poscar_str(structure): string
structure_to_xyz_str(structure): string
structure_to_extxyz_str(structure): string
structure_to_json_str(structure): string

// Export with file download
export_structure_as_cif(structure, filename?)
export_structure_as_poscar(structure, filename?)
```

### File Handling

```typescript
// Generate filename from structure
create_structure_filename(structure, format): string

// Load from URL (auto-detect binary vs text, decompress)
load_from_url(url: string): Promise<string | ArrayBuffer>

// Handle drag-drop URL
handle_url_drop(url: string): Promise<PymatgenStructure>

// Trigger file download
download(content, filename, mime_type?)
```

## Loading Methods

Structures can be loaded through several entry points:

1. **File picker** — Browse local files via the file dialog
2. **Drag and drop** — Drop files directly onto the viewer
3. **URL loading** — Fetch structures from remote URLs
4. **Paste content** — Paste CIF/POSCAR/XYZ text directly
5. **Database search** — Load from OPTIMADE, Materials Project, or PubChem
6. **Desktop file system** — Native file access via Tauri

## Data Format

Internally, structures use a **pymatgen-compatible JSON format**:

```json
{
  "lattice": {
    "matrix": [[a1, a2, a3], [b1, b2, b3], [c1, c2, c3]],
    "pbc": [true, true, true]
  },
  "sites": [
    {
      "species": [{ "element": "Si", "occu": 1.0 }],
      "abc": [0.0, 0.0, 0.0],
      "xyz": [0.0, 0.0, 0.0]
    }
  ]
}
```

The lattice matrix follows the **rows = lattice vectors** convention (same as pymatgen). Fractional-to-Cartesian conversion uses `xyz = M^T * abc`.
