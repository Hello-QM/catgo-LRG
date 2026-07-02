# Changelog

All notable changes to this project will be documented in this file.

## [1.4.2] - 2026-07-02

### Added
- **Terminal Ctrl+click a directory** navigates the Files sidebar to it (local shells and HPC sessions).
- **Doc viewer renders PDFs everywhere** — pages are drawn with pdf.js (fit-to-width, high-DPI), so PDFs display on Linux too, where the system webview has no native PDF renderer. Local PDFs/images now load through the backend's local-file binary route.
- **GitHub-grade markdown preview** — README-style files render with full GFM + safe raw HTML (badges, centered headers, tables) instead of the chat renderer.

### Fixed
- **Terminal Ctrl+click a file opens it again** — a local shell sent an empty session id the backend rejected (404) and the dir-check misclassified every path as a directory; both ends fixed.
- **"Open files in" targets are honored from a full-pane terminal** — Split/Tab create or reuse a structure pane beside the terminal instead of silently doing nothing; Overwrite replaces the tab's existing structure pane instead of splitting a new one on every open.
- **Window + Overwrite reuses one popout and actually updates it** — the reuse popout now receives every subsequent structure (storage-event + Tauri-event delivery, restored-terminal-tab fallback, no more payload theft by other popouts).
- **Popout structure windows work again on desktop** — they had no Tauri ACL capability, so every IPC from them was denied (the "Update failed: Command plugin:app|version not allowed by ACL" toast, dead reuse reloads). Update checks now run only in the main window.
- **`catgo view` pushes reach the External tab reliably** — SSE events were delivered to a registry key nobody subscribed to once a pane had been touched: the tab label froze on the first structure and multi-file trajectory pushes were dropped outright. Both fixed by alias-aware fan-out.
- **Doc viewer polish** — the markdown Edit toggle sits in the header row (it used to float over Download); the docs window follows the app theme (the active tab no longer looks dimmer than inactive ones in light theme); Monaco's benign "Canceled" rejection no longer whites out the window.
- **iOS: Chinese dictation into the terminal** no longer re-appends the whole transcript on every recognizer refinement — Chinese now takes the same reconcile path as English.
- **MCP `catgo_analyze` routes** — symmetry / dft_input / optimize / rdf / coordination now hit real endpoints (new standalone symmetry, single-structure RDF and CrystalNN coordination); the adsorption router is mounted.

### Changed
- Linux `.rpm` packages use zstd compression (smaller, faster CI).

## [1.4.1] - 2026-06-26

### Added
- **In-app auto-update** — installed desktop builds now notice new releases and update from inside the app. Windows/macOS download the signed bundle and relaunch with one click; Linux (`.deb`/`.rpm`) shows a "new version" banner that opens the download page. A bottom-centre banner appears only when a newer version exists. Web and mobile builds are unaffected.
- **Developer-ID signed macOS builds** — the `.dmg`/`.app` are now code-signed with a Developer ID certificate (first launch still needs right-click → Open; full notarization is a follow-up).

### Changed
- **Web "Get the App" button** is now embedded in the landing page (next to *Star on GitHub*) instead of floating over the editor after a structure loads.
- **Toon render style** default headlamp lowered to azimuth 25° / elevation 20°.

### Fixed
- **Bonds no longer disappear** after adding a periodic lattice to a molecule (Build Tools → Lattice): fractional coordinates are now recomputed correctly, including non-orthogonal boxes.
- **Search Database is no longer PubChem-only** — OPTIMADE providers are retried on cold start so the full provider list loads.
- **VS Code extension trajectory playback** no longer recomputes `solid_angle` bonds on the main thread every frame (jank fixed).
- **Electronic-structure plots** — axis titles no longer overlap tick labels at large font sizes.
- **iOS (App Store) build** hides backend-only surfaces (Analysis tools, Doping builder) that would otherwise show a "requires the desktop app" error in the static build.

## [1.4.0] - 2026-06-25

### Added
- **`catgo view` / `catgo gui` CLI** — open structure & trajectory files like `ase gui`. `catgo view */POSCAR` stacks single-frame files into one trajectory (natural-sorted); per-file `filename@SLICE` and global `-n/--image-number` frame selection; `--interpolate N` between two endpoints (IDPP, linear fallback); headless `-g/--graph` + `-t/--terminal` per-frame convergence dump/plot. Reuses the existing viewer push channel.
- **Nanoparticle / cluster builder** — finite metal clusters via `ase.cluster` (Wulff equilibrium shape, octahedron, icosahedron, decahedron), centred in a vacuum box. Exposed in the Build panel, the CLI (`catgo nanoparticle`), and the `catgo_nanoparticle` MCP tool — all backed by one `/api/build/nanoparticle` route.
- **Random concentration-based doping** — randomly substitute N of a host element with a dopant mix at random sites, with optional seed and dedup.
- **Web "Get the App" download flow** — the static web build surfaces an OS-picker download (Windows/macOS/Linux/Android via the GitHub releases API, iOS via TestFlight) inline at the "desktop required" notice and as a persistent badge, instead of a raw GitHub URL.

### Fixed
- **`catgo view` works after a packaged install** — the frozen `catgo-server` now dispatches `view`/`gui`/`nanoparticle` subcommands; the server records `~/.catgo/server.port` so the CLI attaches to the running app backend on any port; the Windows `-setup.exe` installer puts a `catgo` CLI shim on PATH; and `catgo view` with no app open launches the desktop app.

## [1.3.2] - 2026-06-21

### Added
- **Viewer render styles** (`render_style`): a per-material shading mode — **Glossy** (specular), **Matte** (diffuse), **Toon** (3-band cel/cartoon with silhouette outline) — orthogonal to the colour scheme. Lives in the controls pane (中文: 光泽 / 哑光 / 卡通).
- **Per-material lighting controls**: a Lighting group with light **azimuth + elevation** (direction), **directional + ambient** intensity and **highlight (specular) strength** — all update live. Each render style keeps its own lighting profile (remembered per material). Also corrects the viewer headlamp, which was lit from the lower-left, to light from above.
- **Bond-order perception in the 3D viewer** (`Bond orders` / 键级, off by default): perceives double / triple / aromatic bond orders across the whole structure — molecular adsorbates **and** carbon-framework catalysts (graphene, C₃N₄, h-BN, COF). Doubles/triples render as offset multi-cylinders; aromatic rings render as a single inscribed ring per hexagon (PBC-aware: cross-cell hexagons are detected, deduped and wrapped into the cell). Metals stay single-bonded.
- **CatBot atom-selection DSL**: agents can select atoms by query — `elem:O AND frac:c>0.9`, `label:O1`, `bonded:@i`, `sphere:@i;r`, with `AND`/`OR`/`NOT` and parentheses — via the `catgo_view` `select` action (no manual UI; nobody memorises a DSL).
- **DOS/COHP/BANDS plots**: customizable per-series line colours, Nature-style colour presets, and publication DPI × width PNG export.
- **CatGo CLI from the bundled app**: the `catgo` command is exposed by the packaged build (no `pip install` needed).
- **CatBot workflow editing**: client-direct chat providers can now build and edit workflows.

### Fixed
- **Electronic-structure DB previews** and assorted import/review fixes.

## [1.3.1] - 2026-06-20

### Fixed
- **HPC connections from packaged builds** (desktop & VS Code sidecar): the bundled `catgo-server` was missing `pynacl` and `bcrypt`, asyncssh's crypto backends for Ed25519 / Curve25519 / encrypted OpenSSH keys. Without them the SSH handshake/key-auth to clusters (e.g. SDSC Expanse) never completed — the UI hung at "connecting…". They were undeclared deps so PyInstaller never bundled them. Now declared (`requirements.txt`, `pyproject.toml`) and explicitly collected in `catgo_server.spec`. (asyncssh itself was always bundled; the gap was its optional crypto deps.)
- **Packaged VASP workflows**: `custodian` (job error-correction, lazily imported in `job_script.py` / `workflow_run.py`) was not collected by PyInstaller → workflow runs crashed in packaged builds. Now collected in the spec.

> Note: v1.3.0 was retracted before general availability due to the HPC bundle gap above; v1.3.1 is its corrected replacement (same features/docs).

## [1.3.0] - 2026-06-20

### Added
- **Multi-pane workspace**: tabs, tiling split-view and pop-out windows where **each pane is a fully independent structure/trajectory** with its own frames, playback, edits and caches — loading, scrubbing, editing or closing one pane never disturbs another.
- **Pane-precise viewer routing**: every viewer has a stable `tab:leaf` id; CatBot and tools can target a pane by id or by position (`top-left`, `bottom-right`, `pane 2`, filename/label).
- **Library-to-pane binding**: sidebar entries bind to the exact pane displaying them; removing one of two same-name entries closes only its pane, and the two-phase close flow keeps the entry until that pane actually closes.
- **Docs**: readme now surfaces the full read/write format matrix (by software) and the complete keyboard-shortcut reference; VS Code extension and CatBot plugin descriptions updated to reflect the real format breadth.

### Fixed
- **Load-into-occupied-pane hold-gate** (restores the #372 contract): a *load* into a pane that already holds a structure is held (overwrite / split / new-window prompt) instead of silently overwriting; `intent`/`had_structure` ride the SSE event again, computed against the resolved pane.
- **CatBot atom-graph honours PBC**: cross-cell bonds use the minimum-image convention, so periodic slab/bulk atoms are no longer mislabeled `coordination:0` / terminal.
- **Large in-memory trajectories**: copy-on-write frame cloning bounds peak memory per pane.
- **Viewer-ref matching**: filenames match by exact name/stem only (no more `"o"` → `POSCAR` mis-route); server gains pane-number matching to match the client.
- Unique command ids (no same-tick collision); library-removal no longer leaks when save-before-close fails on the HPC/DB path.

## [1.1.4] - 2026-05-30

### Added
- **Cluster config validation**: a "Test configuration" button in the Run dialog (and a CatBot tool, `validate_hpc_config` / `catgo_validate_config`) that probes the live HPC cluster over SSH — POTCAR root/functional directories, per-element pseudopotentials, and VASP binary resolution under the real module-load + conda environment — so a broken cluster config is caught before submitting instead of crashing silently on the cluster.
- **In-app AI gains tools**: non-SDK providers (DeepSeek/Qwen/Kimi/Gemini/…) now run the in-browser tool-calling loop, so CatBot can validate clusters, load skill guides on demand (`get_skill`), and **run and monitor workflows** (`run_workflow`, `get_workflow_run_status`) using a per-workflow run config persisted at submit time.
- **File tree "Open in editor"**: right-click context-menu action to open a file in the Monaco editor.

### Fixed
- **Skill system restored**: corrected `_SKILLS_DIR` (it pointed at a non-existent doubled `catgo/` path), so `GET /api/skills` and the `catgo_skills` MCP tool serve all skill guides again — the in-app AI was silently getting no skill guidance.
- **POTCAR generation**: the configured POTCAR directory was written to `hpc.job_defaults` but read from the hpc root, so POTCAR generation was silently skipped and VASP ran without one; the directory is now read correctly, and generation failures are surfaced as errored tasks (naming the missing element) instead of crashing silently on the cluster.
- **Local files in browser/web mode**: clicking the download button or previewing an image/PDF/binary in the local file browser no longer throws `Cannot read properties of undefined (reading 'invoke')` outside the desktop app — these now stream through a dev file route; markdown images load in parallel (was one slow request per image).
- **Terminal rendering**: default to the DOM renderer (WebGL opt-in) plus a Nerd Font / emoji / CJK glyph fallback chain, so terminal output no longer renders as tofu boxes in browser mode.

## [1.1.3] - 2026-05-30

### Added
- **Redo**: `Ctrl+Shift+Z` / `Ctrl+Y` to redo structure changes (undo was already `Ctrl+Z`).
- **CatBot `set_lattice`**: the web (STATIC_ONLY) assistant can give a molecule a periodic box client-side.
- **Landing page**: a "Star on GitHub" link on the welcome screen.

### Fixed
- **Cross-tab / cross-pane bleed**: loading a structure in one tab or pane no longer overwrites another.
- **Atom delete**: deleting an atom no longer drops unrelated surviving bonds.
- **(110) slab stoichiometry**: species-aware in-plane primitive reduction (TS + Rust); slab-cutter controls are no longer hard-capped.
- **Desktop file association**: "Open with CatGo" now loads the file on Windows & Linux, and drag-drop can read dropped files.
- **DOS / COHP analysis**: extension packages are importable again (was "Failed to fetch"), and large remote reads (PROCAR / COHPCAR / CHGCAR) are gzip-compressed in transit (~6× faster on slow links); the Charge `cube-processor` path was corrected.
- **CatBot**: "Allow for session" now persists in the client-direct path.
- **UI**: the active dialog tab no longer renders invisible (accent text on an accent fill); Structure-Info usage tips were corrected to match the real key/mouse bindings.
- **Large-system mode**: the toggle is disabled with an explanatory tooltip when WebGPU isn't actually available (no GPU adapter).
- **Trajectory**: keyboard shortcuts (A/D, Space, Ctrl+A/D, Home/End) work without first clicking into the viewer.
- **VASP**: a successful offline (client-side) input generation shows as info, not a red error.
- Fixed a startup crash ("Cannot access '_view_dir' before initialization").

### Changed
- **HPC**: ControlMaster-mode SSH commands use `BatchMode=yes` so a missing master fails cleanly instead of hanging on `ssh-askpass`.
- **CI**: bounded the e2e/unit job time so a hung dev-server can't run to the 6h cap; hardened cargo network flakes.

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
