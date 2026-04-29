# Frequently Asked Questions

## General

### What is CatGO?

CatGO is an interactive visualization and analysis toolkit for materials science and computational chemistry. It runs in the browser, as a desktop app, as a VSCode extension, or as a Jupyter widget.

### What file formats are supported?

**Import:** CIF, POSCAR/VASP, XYZ, Extended XYZ, ASE Trajectory (.traj), HDF5, XDATCAR, CUBE, plus compressed variants (.gz, .zip, .bz2)

**Export:** CIF, POSCAR, XYZ, Extended XYZ, JSON (pymatgen-compatible), GLB, OBJ

### Does CatGO require an internet connection?

The core viewer runs entirely in the browser with no server needed. WASM-powered features (bonding, slab generation, symmetry) also run locally. However, these features require the Python backend:

- Structure optimization (server-side calculators)
- Database search (OPTIMADE, Materials Project, PubChem)
- VASP input generation

### Is CatGO free and open source?

Yes. CatGO is open source and available on GitHub.

---

## Structure Viewer

### Why don't bonds appear?

Several possible reasons:

1. **Bonding is disabled** — Check that `show_bonds` is set to "always" (not "never") in settings
2. **Wrong bonding strategy** — Try switching between solid angle, electronegativity ratio, and atomic radii in settings
3. **Atoms too far apart** — If the structure has no periodic boundary conditions or atoms are widely spaced, bonds may not be detected
4. **Molecule mode** — If `show_bonds` is set to "crystals", bonds won't show for non-periodic structures

### Why is the structure upside down after a slab cut?

The slab cutter enforces a right-handed lattice where (a x b) . z > 0. If the initial rotation matrix produced a left-handed lattice, vectors are corrected. Press **R** to reset the camera, which re-aligns to the new lattice vectors.

### Why are atoms overlapping?

This can happen when:
- Image atoms are enabled (`show_image_atoms`) and the viewing angle makes them overlap with original atoms
- The structure has very short bond distances (check the info pane for lattice parameters)
- Atomic radii are set too large — reduce `atom_radius` in settings

### How do I change atom colors?

1. **Color scheme** — Change the global scheme (Vesta, Jmol, Alloy, Pastel, Muted, Dark Mode) in settings
2. **Per-element** — Click an element in the color legend to open the color picker
3. **By property** — Switch `atom_color_mode` to "coordination" or "wyckoff"

### How do I freeze atoms for optimization?

1. Select the atoms you want to freeze (click + Shift+click)
2. Right-click and choose "Freeze" from the context menu
3. Frozen atoms show a visual indicator (ring, crosshatch, or dimmed)
4. During optimization, frozen atoms remain in place

### How do I undo changes?

Press **Ctrl+Z** (Cmd+Z on macOS) to undo. **Ctrl+Shift+Z** to redo. This works for all structure modifications: adding/deleting atoms, slab cuts, supercells, etc.

---

## Desktop App

### How do I install the desktop app?

See the [Installation guide](/guide/installation) and [Desktop Build guide](/developer/desktop-build). Pre-built binaries are available for macOS, Windows, and Linux on the GitHub Releases page.

### Can I open files by double-clicking?

Yes. The desktop app registers file associations for `.cif`, `.poscar`, `.vasp`, `.contcar`, `.xyz`, `.extxyz`, `.traj`, and `.json`. Double-clicking these files opens them directly in CatGO. On macOS, associated files also display a custom CatGO document icon in Finder.

### Does the desktop app include the Python server?

The bundled desktop build (`pnpm bundle`) includes the Python computation server. The standard build (`pnpm tauri:build`) does not — you need to run the server separately.

---

## Optimization

### Which calculator should I use?

| Use Case | Recommended Calculator |
|----------|----------------------|
| Quick test / metals | EMT |
| Organic molecules | xTB (GFN2) |
| Inorganic crystals | MACE (medium) or CHGNet |
| General materials | MACE (medium) |
| Highest accuracy | MACE (large) |
| No server needed | UFF (local, browser-based) |

### Why is the server not detected?

1. Make sure the Python server is running: `cd server && python main.py`
2. Check that port 8000 is not in use by another process
3. Verify the server started without errors in the terminal
4. The health endpoint should respond: `http://localhost:8000/health`

### Why does optimization say "element not supported"?

Each calculator supports a limited set of elements:
- **EMT** — Only Cu, Ag, Au, Ni, Pd, Pt, Al
- **xTB** — Most organic elements (H, C, N, O, S, P, halogens, etc.)
- **MACE/CHGNet/M3GNet** — Most of the periodic table

Switch to a calculator that supports your structure's elements.

### Can I optimize the cell shape?

Yes, with server-side calculators. Enable **Optimize cell** in the optimization pane. This uses an ExpCellFilter for NPT-style relaxation. Not available with the local UFF optimizer.

---

## Database Search

### Why does database search fail?

Both OPTIMADE and PubChem searches require the Python backend running at `localhost:8000`. The backend proxies API requests to avoid CORS restrictions. Start the server with `cd server && python main.py`.

### How do I get a Materials Project API key?

1. Create an account at [materialsproject.org](https://materialsproject.org/)
2. Go to your dashboard and copy your API key
3. In CatGO's OPTIMADE search modal, click "Add API key" and paste it
4. The key is stored in your browser's localStorage

### What's the difference between OPTIMADE and PubChem?

- **OPTIMADE** searches crystal structure databases (periodic, with lattice) — use for bulk materials, surfaces, etc.
- **PubChem** searches molecular compound databases (non-periodic, no lattice) — use for organic molecules, drugs, small molecules

---

## Trajectories

### Why isn't my trajectory loading?

1. Check the file format — supported formats: .extxyz, .xyz, .traj, .h5/.hdf5, XDATCAR
2. For large files (>50 MB), loading may take a moment as CatGO indexes the frames
3. Compressed files (.gz, .zip) are supported but decompression adds time
4. Check the browser console for parse errors

### How do I control playback speed?

Use the FPS slider in the playback controls, or press **+** / **-** during playback. The range is configurable (default: 0.2-60 FPS).

### Can I export a specific frame?

Navigate to the desired frame, then use the standard Export pane to save the current structure in any supported format.

---

## WASM / Performance

### Why is WASM not loading?

1. Ensure the WASM package exists at `extensions/rust-wasm/pkg/`
2. Check that your browser supports WebAssembly (all modern browsers do)
3. Check the browser console for specific error messages
4. If building from source, run `wasm-pack build` in `extensions/rust/`

### The viewer is slow with many atoms. What can I do?

See the [performance tips](/guide/tips-and-tricks#performance-tips) section. Key actions:
- Reduce `sphere_segments` (try 12)
- Disable bonds for very large structures
- Disable image atoms
- Enable `same_size_atoms`

### How much memory does CatGO use?

Memory usage depends on structure size and trajectory length:
- A 100-atom structure: ~1 MB
- A 10,000-atom structure with bonds: ~50 MB
- A 1000-frame trajectory: ~100-500 MB depending on atom count

Adjust `max_frames_in_memory` for trajectory playback to control memory usage.

---

## Workflows {#workflows}

### What is the workflow engine?

The workflow engine lets you build multi-step computational pipelines as visual node graphs. You connect nodes (DFT calculations, structure transformations, analysis) with edges, configure parameters, and run everything on your HPC cluster. See the [Workflow Tutorial](/tutorials/workflows/workflows) for a step-by-step guide.

### Do I need VASP installed?

Yes, for DFT calculation nodes (VASP Relax, VASP Static, VASP MD, Electronic, Frequency). You need SSH access to an HPC cluster with VASP and valid pseudopotentials (POTCAR files). ML potential nodes (MLP Relax, MLP MD) require MACE, CHGNet, or M3GNet on the cluster instead. Structure transformation and analysis nodes run locally on the CatGO server and don't require any HPC access.

### How do I connect to my HPC cluster?

1. Open the **HPC** panel in the sidebar (terminal icon)
2. Enter your cluster hostname, username, and authentication (password or SSH key)
3. Connect — the session stays active for the duration of your CatGO session
4. Select this session when launching a workflow

### My workflow failed. How do I debug it?

1. Click the **failed node** (shown in red) in the workflow editor
2. Check the **error message** in the node details panel
3. Click **Files** to download OUTCAR or other output files from the cluster
4. Common causes:
   - **POTCAR not found** — Ensure pseudopotentials are in the expected directory on the cluster
   - **Walltime exceeded** — Increase walltime in the run configuration
   - **Memory error** — Reduce NCORE or increase node count
   - **Convergence failure** — Enable Custodian for automatic error recovery

### Can I resume a failed workflow?

Not directly. If a step fails, the workflow stops and downstream nodes are marked as skipped. You can:

1. Fix the issue (adjust parameters, increase resources)
2. Create a new workflow starting from the last successful structure
3. If the server crashed mid-workflow, recovery is automatic on restart

### What is Custodian and should I enable it?

Custodian is an automatic error handler for VASP calculations (from the atomate2/custodian project). It detects common VASP errors and applies fixes automatically — for example, switching the optimization algorithm if EDDDAV fails, or restarting from CONTCAR if walltime is exceeded. It's enabled by default and recommended for production workflows. Disable it only if you need raw VASP execution for debugging.

### How do I use a custom job script?

In the run configuration dialog, select a preset (SLURM, PBS, Shaheen-III) and modify it, or write your own script from scratch. The script template supports variables like `{nodes}`, `{ntasks}`, `{walltime}` that are filled in from the resource configuration.

### Can I run workflows without an HPC cluster?

Partially. Structure transformation nodes (slab generation, supercell, defect generation, etc.) and analysis nodes run locally on the CatGO server. But DFT calculations (VASP) and ML potential calculations require an HPC cluster. For local-only workflows, you can chain structure transformations with the [local optimization](/tutorials/structures/optimization) feature instead.

### Where are my results stored?

All completed DFT and MLP calculations are automatically stored in an ASE database on the server. You can browse results in the **Project Dashboard** (table and plot views) or query the database via the ASE Python API. Results include structures, energies, forces, and workflow metadata.

### How do I export workflow results?

1. Open the **Project Dashboard** for your workflow
2. Use the **Table** view to see all results
3. Click **Export** to download as JSON or CSV
4. Or add an **Export** node to the end of your workflow to automatically save results in JSON, CSV, CIF, or POSCAR format

### Can multiple workflows run at the same time?

Each workflow runs independently, but only one workflow can be actively running at a time. You can have multiple workflows in draft or completed state simultaneously.

### What happens if the server crashes during a workflow?

The workflow engine automatically recovers on restart. It checks the HPC cluster for job status, extracts results from jobs that completed while offline, and resumes from the next pending layer. No manual intervention needed.

---

## Contributing

### How do I report a bug?

Open an issue on the [GitHub repository](https://github.com/your-org/CatGO/issues) with:
- Steps to reproduce
- Expected vs. actual behavior
- Browser/platform information
- Sample file (if applicable)

### How do I contribute code?

See the [Contributing Guide](/developer/contributing) for setup instructions, coding standards, and PR workflow.
