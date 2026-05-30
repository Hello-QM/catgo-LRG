# Changelog

All notable changes to this project will be documented in this file.

## [1.1.2] - 2026-05-29

### Added
- **i18n**: Localized many additional UI surfaces (workflow, file browser, trajectory, phase diagram, plugins, gesture, MD analysis panels).

### Fixed
- **VS Code extension sidecar 404**: The `catgo-server` binary the extension downloads on first activate is now built on real per-platform runners and attached to each release (`catgo-server-linux-x64` / `-darwin-arm64` / `-win-x64.exe`). Previously these were never produced, so first activate failed with HTTP 404.
- **Extension license**: Overview/readme now correctly states GNU AGPL-3.0 (was mislabeled MIT), matching the repository.

### Changed
- **Release CI**: The VS Code extension version is auto-synced from the root `package.json` at publish time, and publish steps now fail loudly on real errors instead of silently swallowing them.

## [1.1.1] - 2026-05-28

### Added
- **Client-side builders**: Nanotube, Moiré, Passivate, Heterostructure (ZSL lattice matching), and Nanoscroll now run fully in-browser via `ferrox-wasm` — no backend required (works in STATIC_ONLY web builds).
- **MOF/COF builder**: Reticular framework construction via PORMAKE, plus MOFX-DB search.
- **CatBot client-side tool-calling**: CatBot operates in STATIC_ONLY web builds, including conversational heterostructure (vertical + lateral) and passivation tools.
- **Client-side input generation**: VASP (INCAR/KPOINTS), Quantum ESPRESSO, LAMMPS, and CP2K inputs generate offline on any backend failure.
- **Large-system performance mode**: WebGPU overlay for million-atom rendering.
- **MCP builders**: Heterostructure (vertical + lateral in-plane), nanotube, and moiré builders exposed to CatBot via MCP.
- **Linux RPM packages**: Releases now ship `.rpm` alongside `.deb` (Fedora/RHEL).

### Fixed
- Materials Project API key now works in STATIC_ONLY web builds.
- Resolved split-pane structure clobber and DB crystal import demotion.
- Water-layer packing is client-side with clash-free PBC boundaries.
- Stopped Site Indices/Labels from freezing the tab (color-mix self-nesting).
- VASP `KSPACING` uses true VASP semantics, not kppvol density.
- Swallow WebGPU `AbortError` when the pick buffer is destroyed mid-map.
- Prevented an infinite loop in the chat markdown table parser.
- Preserve camera view when switching projection (orthographic ↔ perspective).
- Stopped whole-app freeze on gesture enable → disable → re-enable.
- Allow atom delete/edit in non-1×1×1 supercells.

### Changed
- Added Dockerfile and GHCR container publish workflow.

## [1.0.0] - 2026-05-12

### Added
- **Static Web Deployment**: Full support for Cloudflare Pages (frontend-only mode).
- **Static Mode Banner**: Informational UI component for features requiring the desktop app.
- **SPA Routing**: Automatic `_redirects` generation for Cloudflare Pages.
- **Workflow Engine**: DAG-based visual editor for complex calculation pipelines.
- **CatBot AI Assistant**: Natural language structure operations and workflow authoring.
- **HPC Integration**: SSH terminal, remote file browser, and job monitoring.
- **Built-in Calculators**: xTB and EMT bundled in the desktop application.
- **Database Browser**: OPTIMADE and PubChem integration.

### Changed
- Migrated all repository links to `Hello-QM/catgo-LRG`.
- Unified structure saving and exporting across project, HPC, and local file system.
- Improved coordination polyhedra rendering and performance.
- Enhanced MD trajectory playback with per-frame bond caching.

### Fixed
- Fixed oxidation state serialization issues in ASE exports.
- Resolved CORS issues for OPTIMADE providers in static mode.
- Fixed compressed file loading in the desktop sidebar.
- Corrected various accessibility and linting issues.

## [0.3.0] - 2026-03-02
- Initial private beta release.
- 3D structure viewer with basic editing.
- VASP input generation.
- Basic HPC connectivity.
