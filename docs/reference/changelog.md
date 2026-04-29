# Changelog

All notable changes to CatGO are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Plugin system (Phase 0–5) — server-side plugin architecture with lifecycle management, dependency resolution, sandboxed execution, SFTP fallback, and frontend integration
- ABACUS input file export (INPUT, STRU, KPT) from structure viewer
- Force field conversion via Open Babel (GAFF, GAFF2, OPLS-AA) with CLI fallback
- Bond drag-to-connect — click and drag between atoms to create bonds with a real-time ghost bond preview
- Per-atom charge labels — right-click atom to toggle, drag to reposition, double-click to edit value
- Bulk show/hide all charge labels via context menu
- Manual charge value entry for atoms without Bader data
- Charge labels auto-hide when switching away from charge coloring mode and reappear when switching back
- Gaussian CUBE file visualization with isosurface rendering and 2D slice planes
- Materials Project API integration with band gap, energy, and stability data
- Paste structure content feature (Ctrl+Enter to import)
- Vacuum Box as standalone modal with ghost toolbar buttons
- `wrap_molecule_in_box` for non-periodic structures
- Depth cueing (fog effect) for visual depth perception
- Bond editing mode with add/delete functionality
- Atom drag UX: hold Shift+Alt to drag without clicking

### Changed
- Depth cueing on bonds now fades toward the background color (VESTA-style) instead of just darkening
- Removed depth cueing slider from controls panel (setting still works via config)

### Fixed
- AtomLegend × toggle visibility only working once (Svelte 5 `$derived.by()` Set tracking issue)
- Trajectory files (xyz.gz, traj, h5) from CatGo Database sidebar failing to load — binary files now handled properly via `load_from_url`
- Bond hitbox sensitivity reduced to prevent accidental selection when creating bonds
- Bond selection hit detection and deletion
- Scroll wheel rotation, supercell alignment, and context menu errors
- Slab cutter Y-axis flip from left-handed lattice
- Camera alignment with lattice after slab cut and supercell operations
- Right-handed lattice enforcement after slab generation
- TrackballControls camera snap-back during Ctrl key press
- Measurement lines follow atom positions during drag/rotate
- Bonds display correctly after rotation
- Camera recentering prevented during atom manipulation
- Index-keyed maps cleared when atom count changes to prevent snap-back
- Pencil mode ghost fix after slab cut

---

## [0.3.2] - 2026-02-02

### Added
- WASM slab generation functions (`wasm_generate_slab`, `wasm_detect_layers`)
- Ferrox upstream sync with latest Rust crate features
- Bundled backend CI support

### Changed
- Atom drag/rotate performance optimization

### Fixed
- CI workflow improvements and duplicate release workflow removal
- Standardized pnpm usage across GitHub Actions

---

## [0.3.1] - 2026-02-02

### Added
- Desktop landing page for Tauri app
- Pencil/draw mode for adding atoms with bond preview
- Periodic table embedded in search modals

### Fixed
- Slab cutting NaN lattice parameters
- Atom labels and axis vectors after slab cut
- Settings persistence across sessions

---

## [0.3.0] - 2026-02-01

### Added
- Python computation server bundled with desktop app
- Bundled backend build scripts (`pnpm bundle`)

### Fixed
- Removed unnecessary binaries directory
- Removed unnecessary shell permissions from Tauri config

---

## [0.2.3] - 2026-02-01

### Added
- VASP input file generation
- Adsorption site finder (atop, bridge, hollow)
- OPTIMADE database search integration
- PubChem molecular search integration
- MACE and EMT calculator support
- UFF local optimizer (WASM-based, no server needed)
- Slab generation via WASM bindings
- Molecule import and handling
- Supercell transformation
- Multi-pane desktop layout
- ferrox-wasm integration (bonding, neighbor lists, symmetry)

### Fixed
- Desktop-specific TypeScript and Svelte config for CI builds

---

## [0.1.17] - 2026-01-26

### Changed
- Renamed project to CatGO

### Added
- Import file button in toolbar

---

## [0.1.15] - 2026-01-26

### Added
- Tauri-specific file handling for import and export
- Drag-and-drop support for desktop app
- File permissions expanded for Tauri

---

## [0.1.13] - 2026-01-26

### Added
- Initial desktop app release (Tauri 2.0)
- macOS bundle category configuration
- CLAUDE.md project instructions

---

## Version History Summary

| Version | Date | Highlights |
|---------|------|-----------|
| 0.3.2 | 2026-02-02 | WASM slab functions, performance optimization |
| 0.3.1 | 2026-02-02 | Desktop landing page, pencil mode, periodic table in modals |
| 0.3.0 | 2026-02-01 | Bundled Python backend with desktop app |
| 0.2.3 | 2026-02-01 | Major feature expansion (database search, optimization, slab cutter) |
| 0.1.17 | 2026-01-26 | Rename to CatGO |
| 0.1.13 | 2026-01-26 | Initial desktop app release |
