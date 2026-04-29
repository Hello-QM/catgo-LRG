# Spectroscopy & Electronic Structure

X-ray diffraction patterns, radial distribution functions, band structures, density of states, and Brillouin zone visualization.

**Source:** `src/lib/xrd/`, `src/lib/rdf/`, `src/lib/bands/`, `src/lib/brillouin/`

## X-Ray Diffraction (XRD)

Compute powder XRD patterns from crystal structures.

### Key Functions

```typescript
// Calculate XRD pattern for a structure
calculate_xrd_pattern(structure, radiation?): XrdPattern

// Compare XRD patterns across multiple structures
calculate_xrd_structure(structures, radiation?): XrdComparison
```

### Radiation Sources

| Source | Wavelength (A) |
|--------|---------------|
| Cu Ka | 1.5406 |
| Mo Ka | 0.7107 |
| Ag Ka | 0.5609 |
| W La | 1.4764 |

### Component

`XrdPlot.svelte` — Interactive XRD pattern display with peak labels, 2-theta range selection, and multi-structure overlay.

---

## Radial Distribution Function (RDF)

Calculate pair correlation functions g(r) for structural analysis.

### Key Functions

```typescript
// RDF for a specific element pair
calculate_rdf(structure, options): RdfResult

// All pair RDFs at once
calculate_all_pair_rdfs(structure, options): Map<string, RdfResult>
```

### Options

```typescript
interface RdfOptions {
  cutoff: number          // Maximum distance (A)
  bins: number            // Number of histogram bins
  center_species?: string // Central element filter
  neighbor_species?: string // Neighbor element filter
  use_pbc: boolean        // Apply periodic boundary conditions
}
```

### Component

`RdfPlot.svelte` — Line plot of g(r) vs distance with pair selection and smoothing.

---

## Band Structure

Visualize electronic band structure E(k) along high-symmetry paths.

### Components

| Component | Description |
|-----------|-------------|
| `Bands.svelte` | Band structure E(k) line plot |
| `Dos.svelte` | Density of states plot |
| `BandsAndDos.svelte` | Combined side-by-side bands + DOS |
| `BrillouinBandsDos.svelte` | Brillouin zone + bands + DOS together |

### Data Format

```typescript
interface BandData {
  kpoints: number[][]      // k-point coordinates
  eigenvalues: number[][]  // Energy values per band per k-point
  efermi: number           // Fermi energy (eV)
  labels: string[]         // High-symmetry point labels (Gamma, X, M, etc.)
  label_positions: number[] // x-coordinates of labels
}

interface DosData {
  energies: number[]       // Energy grid (eV)
  densities: number[]      // DOS values
  efermi: number           // Fermi energy (eV)
}
```

---

## Brillouin Zone

Interactive 3D visualization of the first Brillouin zone with high-symmetry points and k-paths.

### Key Functions

```typescript
// Compute reciprocal lattice vectors
compute_reciprocal_lattice(lattice_matrix): number[][]

// Compute Brillouin zone polyhedron
compute_brillouin_zone(reciprocal_lattice): BrillouinZone

// Identify high-symmetry k-points
compute_high_symmetry_points(lattice_type): HighSymmetryPoints

// Get k-path coordinates for band structure
get_path_coords(bz, path_labels): PathCoords
```

### Components

| Component | Description |
|-----------|-------------|
| `BrillouinZone.svelte` | Main 3D viewer |
| `BrillouinZoneScene.svelte` | Three.js scene with zone faces, edges, and k-points |
| `BrillouinZoneControls.svelte` | Toggle faces, edges, labels, paths |
| `BrillouinZoneInfoPane.svelte` | Reciprocal lattice parameters |
| `BrillouinZoneExportPane.svelte` | Export visualization |

### Features

- Transparent polyhedron rendering
- High-symmetry point labels (Gamma, X, M, R, K, L, etc.)
- k-path visualization along the zone
- Interactive rotation and zoom
- Combined view with band structure and DOS
