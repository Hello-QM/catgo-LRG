# Changelog

> **Note:** This project was renamed from MatterViz to CatGO in v0.3.0. Historical changelog entries below reference the original `janosh/matterviz` GitHub repository.

## [Unreleased]

### 🛠 Enhancements

**Plugin system (Phase 0–5):**

- Server-side plugin architecture with lifecycle management, dependency resolution, and sandboxed execution
- SFTP fallback for HPC file transfers when native Tauri commands are unavailable
- Frontend plugin integration with dynamic UI component loading
- Plugin manifest schema, validation, and hot-reload support

**ABACUS input file export:**

- Generate ABACUS INPUT, STRU, and KPT files from structure viewer
- Support for pseudopotential path configuration and k-point mesh settings

**Force field conversion:**

- Open Babel integration for GAFF, GAFF2, and OPLS-AA force fields
- CLI fallback when Python bindings are unavailable
- Support for XYZ and MOL2 input formats

**AtomLegend visibility toggle fix:**

- Fixed × button in atom legend only working once due to Svelte 5 `$derived.by()` not tracking Set prop changes
- Solution: bridge `$effect` + `$state` pattern for reliable reactivity

**Trajectory file loading from CatGo Database:**

- Fixed built-in trajectory files (xyz.gz, traj, h5) failing to load from sidebar
- Root cause: binary files were fetched as text; now uses `load_from_url` with proper binary/gzip detection

### 🐛 Bug Fixes — Terminal & Layout

**Terminal fails to spawn on Windows (`src-tauri/src/pty.rs`):**

- Root cause: Shell detection defaulted to `/bin/bash` when `$SHELL` env var was not set. On Windows, `$SHELL` is never set, so `CreateProcessW` tried to execute `/bin/bash` — which doesn't exist.
- Fix: Platform-aware shell detection using `cfg!(windows)`. On Windows, tries `$SHELL` → `$COMSPEC` (usually `cmd.exe`) → `powershell.exe` as final fallback. Also passes `-NoLogo` to PowerShell for cleaner startup.
- On Unix, behavior is unchanged: `$SHELL` → `/bin/bash`.

**Terminal + AI Chat fill entire interface (`src/lib/structure/Structure.svelte`):**

- Root cause: `.structure` div uses CSS Grid for split layouts. Terminal activates `side-split` (3-column grid), Chat activates `chat-split` (3-column grid). When both are open simultaneously, 5 grid children compete for 3 column slots — the extra items overflow to implicit columns, breaking the layout.
- Fix: Added `combined-split` CSS Grid layout. When both Chat and Terminal are open, the right column splits vertically: Chat (top-right) + Terminal (bottom-right). Uses `grid-template-rows: 1fr 1fr` with explicit grid placement (`grid-column: 3`) for both panels. Chat resize handle is hidden in combined mode; the side resize handle spans both rows. Minimizing collapses both panels.

### 🐛 Bug Fixes — Windows Path Compatibility

Fixed filesystem path handling across the entire stack to support Windows backslash paths (`C:\Users\...`), Chinese folder names, and the `\\?\` extended-length prefix returned by Windows `canonicalize()`.

**Frontend (TypeScript/Svelte):**

- `src/lib/api/db-wasm.ts` — `db_get_current`, `db_new`, `db_open`, `db_save_as`: Changed `path.split('/')` to `path.split(/[/\\]/)` for filename extraction. Previously, Windows-style paths like `C:\Users\sakura\data.db` would return the entire path as the "name" instead of just `data`.
- `desktop/App.svelte` — `load_file_from_path` and drag-and-drop handler: Fixed broken fallback pattern `path.split('/').pop() || path.split('\\').pop()` which always returned the full Windows path (since `split('/')` on a backslash-only path returns a single truthy element). Replaced with `path.split(/[/\\]/).pop()`.
- `desktop/Sidebar.svelte` — `make_files()`: Changed `path.split('/')` to `path.split(/[/\\]/)` for extracting filenames from Vite glob import paths.
- `desktop/Sidebar.svelte` — `file_picker_confirm()`: Fixed path construction for "New Database" and "Save As" modes. Previously used hardcoded `/` separator (`${dir}/${filename}`), which produced mixed-separator paths on Windows (e.g., `C:\Users\sakura/new.db`). Now auto-detects the platform separator from the directory path.

**Backend (Rust — src-tauri/src/db.rs):**

- `db_browse_directory` — `~` expansion: Added `trim_start_matches('\\')` alongside `trim_start_matches('/')` so that `~\Documents` works on Windows. Also changed the fallback home directory from `PathBuf::from("/")` to `USERPROFILE` env var (or `C:\`) on Windows.
- Added `normalize_path_string()` helper: Strips the `\\?\` extended-length path prefix that Windows `canonicalize()` adds. This prefix caused issues when paths were passed back to the frontend JavaScript (e.g., file picker navigation, path display, subsequent API calls).
- Applied `normalize_path_string()` to all path outputs: `db_get_current`, `db_new`, `db_open`, `db_save_as`, `db_browse_directory` (dir, parent, and item paths).

**Vite Dev Middleware (`vite.desktop.config.ts`):**

- `resolve_path()`: Changed `replace(/^\//, '')` to `replace(/^[/\\]/, '')` in `~` expansion so that `~\path` is handled correctly on Windows.

**Not changed (correct as-is):**

- `src/lib/io/tauri.ts` — already used `path.split(/[/\\]/)` for both separators.
- `desktop/Sidebar.svelte` line 719 (HPC remote file) — remote paths are always Unix forward-slash, no change needed.
- Python server (`server/routers/workflow.py`) — uses `pathlib.Path` which handles Windows paths natively.
- `server/routers/hpc.py` — remote SSH paths are always POSIX, forward slash is correct.

## [v0.1.13](https://github.com/janosh/matterviz/compare/v0.1.12...v0.1.13)

> 18 October 2025

### 💥 Breaking Changes

- Plot component refactor: use grouped x/y axis, display, bar/line/point style props by @janosh in https://github.com/janosh/matterviz/pull/169
- `y2`-axis support for `BarPlot` + `Histogram` by @janosh in https://github.com/janosh/matterviz/pull/171

### 🛠 Enhancements

- RDF plot component by @janosh in https://github.com/janosh/matterviz/pull/164
- `CoordinationBarPlot` by @janosh in https://github.com/janosh/matterviz/pull/165
- 3D `Structure` export as GLB/OBJ by @janosh in https://github.com/janosh/matterviz/pull/168
- `Bands`, `Dos`, `BandsAndDos` components by @janosh in https://github.com/janosh/matterviz/pull/172
- Brillouin zone by @janosh in https://github.com/janosh/matterviz/pull/174

### 💡 Refactoring

- Use spatial decomposition to speed up bond detection by @janosh in https://github.com/janosh/matterviz/pull/178

## [v0.1.12](https://github.com/janosh/matterviz/compare/v0.1.9...v0.1.12)

> 6 October 2025

### 🛠 Enhancements

- Structure from string by @janosh in https://github.com/janosh/matterviz/pull/150
- 2/3/4D Phase diagrams by @janosh in https://github.com/janosh/matterviz/pull/152
- `XrdPlot.svelte` powered by new `BarPlot.svelte` by @janosh in https://github.com/janosh/matterviz/pull/153
- `ScatterPlot`/`Histogram` support one-sided pin on `x`/`y` range by @janosh in https://github.com/janosh/matterviz/pull/154
- Support on-the-fly 4D energy above hull calculation by @janosh in https://github.com/janosh/matterviz/pull/155
- Enhance interactivity in plotting components by @janosh in https://github.com/janosh/matterviz/pull/157
- Tweaks and tests by @janosh in https://github.com/janosh/matterviz/pull/159
- Add `grouped` mode to `BarPlot` + interactivity improvements by @janosh in https://github.com/janosh/matterviz/pull/162
- Add WebM video export to `Trajectory` by @janosh in https://github.com/janosh/matterviz/pull/163

### 🐛 Bug Fixes

- Fix angle calculation in `Structure` measure mode by @janosh in https://github.com/janosh/matterviz/pull/160

### 📖 Documentation

- Site reorg by @janosh in https://github.com/janosh/matterviz/pull/161

## [v0.1.9](https://github.com/janosh/matterviz/compare/v0.1.8...v0.1.9)

> 5 September 2025

### 🛠 Enhancements

- Interactive symmetry analysis powered by `moyo` WASM bindings by @janosh in https://github.com/janosh/matterviz/pull/140
- Wyckoff table by @janosh in https://github.com/janosh/matterviz/pull/141
- `Structure` rotation controls by @janosh in https://github.com/janosh/matterviz/pull/144

### 🐛 Bug Fixes

- Fix missing Structure/Trajectory pane scroll in `overflow: hidden` containers by @janosh in https://github.com/janosh/matterviz/pull/142

## [v0.1.8](https://github.com/janosh/matterviz/compare/v0.1.7...v0.1.8)

> 17 August 2025

### 🛠 Enhancements

- Measure distances and angles between selected `Structure` sites by @janosh in https://github.com/janosh/matterviz/pull/137
- Optimade page 3-column layout (providers, suggestions, structure) by @janosh in https://github.com/janosh/matterviz/pull/126

### 🐛 Bug Fixes

- Fix parsing `mof-issue-127.cif` by @janosh in https://github.com/janosh/matterviz/pull/128
- Disable `Structure`/`Trajectory` fullscreen buttons in non-browser contexts by @janosh in https://github.com/janosh/matterviz/pull/133
- Set VSCode preferred extension location by @janosh in https://github.com/janosh/matterviz/pull/136

## [v0.1.7](https://github.com/janosh/matterviz/compare/v0.1.6...v0.1.7)

> 11 August 2025

### 🛠 Enhancements

- Settings reset buttons by @janosh in https://github.com/janosh/matterviz/pull/116
- Supercells by @janosh in https://github.com/janosh/matterviz/pull/117

### 🐛 Bug Fixes

- Fix large trajectory loading in VSCode extension by @janosh in https://github.com/janosh/matterviz/pull/115
- Move structure IO by @janosh in https://github.com/janosh/matterviz/pull/123
- Change default camera projection to orthographic by @janosh in https://github.com/janosh/matterviz/pull/124
- Fix `supported_resource` context for keyboard shortcut `when` in VSCode extension by @janosh in https://github.com/janosh/matterviz/pull/125

### 🧪 Tests

- Improve unit tests by @janosh in https://github.com/janosh/matterviz/pull/118

## [v0.1.6](https://github.com/janosh/matterviz/compare/v0.1.5...v0.1.6)

> 28 July 2025

### 🛠 Enhancements

- More `Histogram.svelte` features (near parity with `ScatterPlot.svelte`) by @janosh in https://github.com/janosh/matterviz/pull/101
- Add parsing routines for single OPTIMADE JSON by @ml-evs in https://github.com/janosh/matterviz/pull/100
- Add camera projection selector to `StructureControls.svelte`: perspective (default) or orthographic by @janosh in https://github.com/janosh/matterviz/pull/105
- StructureControls.svelte add CIF and POSCAR file export and clipboard copy buttons by @janosh in https://github.com/janosh/matterviz/pull/110
- Customize site labels (size, color, padding, bg color, offset) via `StructureControls.svelte` by @janosh in https://github.com/janosh/matterviz/pull/111
- Streaming trajectory loader and parser to support large MD files by @janosh in https://github.com/janosh/matterviz/pull/112
- Add lots of VSCode extension settings for customizing default appearance by @janosh in https://github.com/janosh/matterviz/pull/114

### 🐛 Bug Fixes

- Fix VSCode PNG export by @janosh in https://github.com/janosh/matterviz/pull/103
- Fix Matterviz auto-render triggering on unsupported files by @janosh in https://github.com/janosh/matterviz/pull/108
- Fix CIF parsing of TiO2 (mp-2657) by @janosh in https://github.com/janosh/matterviz/pull/109

## New Contributors

- @ml-evs made their first contribution in https://github.com/janosh/matterviz/pull/100

## [v0.1.5](https://github.com/janosh/matterviz/compare/v0.1.4...v0.1.5)

> 22 July 2025

### 🛠 Enhancements

- Significant speedups of Trajectory and Structure viewers by @janosh in https://github.com/janosh/matterviz/pull/96
- Add `auto-render` setting to VSCode extension by @janosh in https://github.com/janosh/matterviz/pull/97

## [v0.1.4](https://github.com/janosh/matterviz/compare/v0.1.3...v0.1.4)

> 20 July 2025

### 🛠 Enhancements

- Add `ContextMenu.svelte` used on double click in `Composition.svelte` to select chart mode, color palette, export text/JSON/SVG/PNG by @janosh in https://github.com/janosh/matterviz/pull/94
- URL-based data loading in Structure and refactored in Trajectory by @janosh in https://github.com/janosh/matterviz/pull/93

### 🐛 Bug Fixes

- Fix vscode extension build by @janosh in https://github.com/janosh/matterviz/pull/95
- Housekeeping + Fixes by @janosh in https://github.com/janosh/matterviz/pull/92

### 💥 Breaking Changes

- Structure.svelte rename prop `show_buttons` to `show_controls` for consistency with other components by @janosh

## [v0.1.3](https://github.com/janosh/matterviz/compare/v0.1.2...v0.1.3)

> 9 July 2025

### 🛠 Enhancements

- Add color theme support to MatterViz Web and VSCode by @janosh in https://github.com/janosh/matterviz/pull/86
- `DraggablePane` replaces `ControlPane` used by `StructureControls`, `StructureInfoPane`, `ScatterPlotControls` by @janosh in https://github.com/janosh/matterviz/pull/89
- VSCode extension file-watching: Structure and Trajectory viewers auto-update on file changes by @janosh in https://github.com/janosh/matterviz/pull/91

### 🐛 Bug Fixes

- Add `HistogramControls` using `DraggablePane`, rename `TrajectorySidebar` to `TrajectoryInfoPane` now also using `DraggablePane` by @janosh in https://github.com/janosh/matterviz/pull/90

## [v0.1.2](https://github.com/janosh/matterviz/compare/v0.1.1...v0.1.2)

> 4 July 2025

### 🛠 Enhancements

- Allow toggling between histogram and line plot of properties in Trajectory viewer by @janosh in https://github.com/janosh/matterviz/pull/85
- VSCode extension for rendering structures and trajectories with MatterViz directly in editor tabs by @janosh in https://github.com/janosh/matterviz/pull/82

#### [v0.1.1](https://github.com/janosh/matterviz/compare/v0.1.1...v0.1.2)

> 19 June 2025

### 🛠 Enhancements

- Big speedup of binary trajectory parsing by avoiding data-URI conversion, use ArrayBuffer directly by @janosh in https://github.com/janosh/matterviz/pull/81
- Force vectors by @janosh in https://github.com/janosh/matterviz/pull/80

## [v0.1.0](https://github.com/janosh/matterviz/commits/v0.1.0)

> 19 June 2025

### 🛠 Enhancements

- Add tick labels to ColorBar by @janosh in https://github.com/janosh/matterviz/pull/19
- Add prop `color_scale_range` to `PeriodicTable` by @janosh in https://github.com/janosh/matterviz/pull/20
- `Structure` allow selecting from different element color schemes + override individual elements by @janosh in https://github.com/janosh/matterviz/pull/29
- Structure hide buttons on desktop until hover by @janosh in https://github.com/janosh/matterviz/pull/31
- Structure tooltips when hovering atoms by @janosh in https://github.com/janosh/matterviz/pull/33
- Highlight active and hovered sites in `Structure` by @janosh in https://github.com/janosh/matterviz/pull/34
- Add materials detail pages by @janosh in https://github.com/janosh/matterviz/pull/35
- Add `Bond` component by @janosh in https://github.com/janosh/matterviz/pull/37
- Show cylinder between active and hovered sites by @janosh in https://github.com/janosh/matterviz/pull/40
- Add `Lattice.svelte` by @janosh in https://github.com/janosh/matterviz/pull/41
- Add `SymmetryCard.svelte` by @janosh in https://github.com/janosh/matterviz/pull/42
- Add props and control sliders for ambient and directional lighting to `Structure` by @janosh in https://github.com/janosh/matterviz/pull/45
- Support partial site occupancies by rendering atoms as multiple sphere slices by @janosh in https://github.com/janosh/matterviz/pull/46
- Add `parse_si_float` inverse function to `pretty_num` in `labels.ts` by @janosh in https://github.com/janosh/matterviz/pull/50
- Migrate to Svelte 5 runes syntax by @janosh in https://github.com/janosh/matterviz/pull/55
- `ScatterPlot` support custom x/y tick label spacing and formatting by @janosh in https://github.com/janosh/matterviz/pull/56
- Make `ScatterPlot.svelte` drag-zoomable and add auto-placed `ColorBar` by @janosh in https://github.com/janosh/matterviz/pull/59
- Auto-placed ScatterPlot labels by @janosh in https://github.com/janosh/matterviz/pull/60
- `PlotLegend.svelte` by @janosh in https://github.com/janosh/matterviz/pull/61
- `ScatterPlot` allow custom tween easing and interpolation functions + fix NaNs in interpolated ScatterPoint coords when tweening between linear/log scaled by @janosh in https://github.com/janosh/matterviz/pull/62
- Fix ScatterPlot zoom by @janosh in https://github.com/janosh/matterviz/pull/63
- More element color schemes by @janosh in https://github.com/janosh/matterviz/pull/65
- Add `PeriodicTable` element tile tooltip and more `Structure` UI controls by @janosh in https://github.com/janosh/matterviz/pull/66
- `Lattice` replace wireframe with `EdgesGeometry` cylinders and add PBC distance calculation in `Structure` hover tooltip (prev. direct only) by @janosh in https://github.com/janosh/matterviz/pull/67
- Support dragging `POSCAR` + `(ext)XYZ` files onto the Structure viewer by @janosh in https://github.com/janosh/matterviz/pull/68
- Add drag-and-drop CIF file support to `Structure.svelte` by @janosh in https://github.com/janosh/matterviz/pull/70
- Add new `lib/composition` module with `PieChart`/`BubbleChart`/`BarChart` components for rendering chemical formulae by @janosh in https://github.com/janosh/matterviz/pull/73
- `ElementTile` split support for multi-value `PeriodicTable` heatmaps + more testing by @janosh in https://github.com/janosh/matterviz/pull/74
- Add `Trajectory` sidebar, full-screen toggle, and plot/structure/plot+structure display mode buttons by @janosh in https://github.com/janosh/matterviz/pull/77
- `phonopy.yaml` support by @janosh in https://github.com/janosh/matterviz/pull/79

### 🐛 Bug Fixes

- Structure grid example by @janosh in https://github.com/janosh/matterviz/pull/30
- Fix structure controls for `atom_radius`, `same_size_atoms` by @janosh in https://github.com/janosh/matterviz/pull/38
- `Structure` fixes by @janosh in https://github.com/janosh/matterviz/pull/64
- Color bonds as linear gradient between connected element colors, fix `ElementTile` not using user-set `text_color` by @janosh in https://github.com/janosh/matterviz/pull/71

### 🏥 Package Health

- Split `/src/lib` into submodules by @janosh in https://github.com/janosh/matterviz/pull/36
- Swap `node` for `deno` by @janosh in https://github.com/janosh/matterviz/pull/76
- Rename package from `elementari` to `matterviz` by @janosh in https://github.com/janosh/matterviz/pull/78

### 🤷‍♂️ Other Changes

- Add fill area below elemental periodicity line plot by @janosh in https://github.com/janosh/matterviz/pull/4
- Bohr Atoms by @janosh in https://github.com/janosh/matterviz/pull/6
- Fix build after update to `vite` v3 by @janosh in https://github.com/janosh/matterviz/pull/7
- SvelteKit auto migration by @janosh in https://github.com/janosh/matterviz/pull/8
- Update scatter tooltip when hovering element tiles by @janosh in https://github.com/janosh/matterviz/pull/9
- Migrate to PNPM by @janosh in https://github.com/janosh/matterviz/pull/12
- Convert src/lib/element-data.{ts -> yml} by @janosh in https://github.com/janosh/matterviz/pull/13
- Heatmap unit test by @janosh in https://github.com/janosh/matterviz/pull/14
- Deploy site to GitHub Pages by @janosh in https://github.com/janosh/matterviz/pull/15
- AVIF element images by @janosh in https://github.com/janosh/matterviz/pull/18
- Add unit tests for `ColorBar.svelte` by @janosh in https://github.com/janosh/matterviz/pull/21
- DRY workflows and ColorBar snap tick labels to nice values by @janosh in https://github.com/janosh/matterviz/pull/22
- Rename ColorBar props by @janosh in https://github.com/janosh/matterviz/pull/27
- Initial support for rendering interactive 3d structures by @janosh in https://github.com/janosh/matterviz/pull/28
- Get started with testing `Structure.svelte` and `structure.ts` by @janosh in https://github.com/janosh/matterviz/pull/32
- Fix and speedup `max_dist` and `nearest_neighbor` bonding algorithms by @janosh in https://github.com/janosh/matterviz/pull/48
- Couple new unit tests by @janosh in https://github.com/janosh/matterviz/pull/52
- Add `color_scale_type`, `color_scheme`, `color_range` props to `ScatterPlot` for coloring points by numeric values by @janosh in https://github.com/janosh/matterviz/pull/58
- `Trajectory` viewer by @janosh in https://github.com/janosh/matterviz/pull/75
