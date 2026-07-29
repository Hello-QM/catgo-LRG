---
name: electronic-analysis
description: >
  Use when the user asks to analyze DOS, band structure, COHP bonding, d-band center,
  or MD trajectory properties (RDF, RMSD, RMSF, hydrogen bonds, clustering,
  dimensionality reduction, dihedral angles, planar density).
---

# Electronic Structure & MD Trajectory Analysis

## Density of States (DOS)

| Tool | Purpose |
|------|---------|
| `catgo_dos_total` | Total DOS |
| `catgo_dos_compute` | Projected DOS (PDOS) for atom groups |
| `catgo_dos_dband` | D-band center, width, filling (catalysis) |
| `catgo_dos_from_dir` | Load DOS from remote HPC directory |

### Getting a session
`catgo_dos_from_dir(session_id=<hpc session>, remote_path=<dir>)` — points at the run
directory on the cluster (it looks for `vaspout.h5` / `vasprun.xml`) and returns a DOS
session id. Prefer this over asking for an upload: the data is already on the cluster,
and the loaded session **opens in the Analysis panel by itself**, together with the
structure it was computed on. Same for `catgo_bands_from_dir`.

Report what you loaded and what the spectrum shows. Do not tell the user to upload a
file, and do not say the result cannot be displayed — it already is.

### PDOS Workflow
1. Get `session_id` from `catgo_dos_from_dir` (or from a file the user uploaded)
2. Define atom groups: `{"groups": [{"atoms": [0,1,2], "channels": "d", "label": "Surface Pt d"}]}`
3. Call `catgo_dos_compute` with session_id and groups

**Channel syntax**: `"d"`, `"s,p"`, `"dxy,dz2"`

### D-Band Analysis
`catgo_dos_dband(session_id, atoms=[surface_indices])` — Returns d-band center, width, filling.
- Higher center = stronger adsorbate binding
- `occupied_only_center=True` (default) for occupied d-band center

## Band Structure

| Tool | Purpose |
|------|---------|
| `catgo_bands_data` | Band energies, k-path, band gap |
| `catgo_bands_projections` | Projected (fat) bands with orbital weights |

Report: direct/indirect gap, gap value, high-symmetry labels.

## COHP (Bonding Analysis)

`catgo_cohp_data` — Crystal Orbital Hamilton Population from LOBSTER output.
- `bond_indices`: 1-based bond numbers
- Negative -COHP below Fermi = bonding; positive = antibonding
- ICOHP = quantitative bond strength

## MD Trajectory Analysis

All MD tools accept `trajectory_b64` (base64-encoded file) and `format` (pdb, xyz, extxyz, lammpstrj).

### Structural Analysis

| Tool | Purpose | Key Parameters |
|------|---------|---------------|
| `catgo_md_rdf` | Radial distribution g(r) | `pairs`, `r_range`, `n_bins` |
| `catgo_md_rmsd` | RMSD over time (stability) | `ref_frame`, `atom_indices` |
| `catgo_md_rmsf` | Per-atom fluctuation | `atom_indices` |
| `catgo_md_dihedrals` | Dihedral angle evolution | `atom_quartets` |

### Hydrogen Bond Analysis

| Tool | Purpose |
|------|---------|
| `catgo_md_hbonds` | Detect H-bonds per frame |
| `catgo_md_hbond_lifetime` | H-bond lifetime autocorrelation |

Methods: `baker_hubbard` or `wernet_nilsson`. Default: D-A 3.5 A, D-H-A angle 150 deg.

### Conformational Analysis

| Tool | Purpose |
|------|---------|
| `catgo_md_clustering` | Cluster frames by structural similarity (kmeans/dbscan) |
| `catgo_md_dimreduce` | PCA/t-SNE/UMAP embedding |
| `catgo_md_planar_density` | 2D density map (diffusion analysis) |

## Workflow Recipes

### Surface Catalysis DOS
1. `catgo_dos_from_dir(remote_path="...")` → 2. `catgo_dos_total` →
3. `catgo_dos_dband(atoms=[surface])` → 4. `catgo_dos_compute(groups=[...])`

### MD Water/Interface
1. `catgo_md_rdf(pairs=[["O","H"],["O","O"]])` → 2. `catgo_md_hbonds` →
3. `catgo_md_hbond_lifetime` → 4. `catgo_md_planar_density(plane="xy")`
