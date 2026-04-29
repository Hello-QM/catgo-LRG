# Using the Desktop App

CatGO's desktop app is a native application built with Tauri 2.0. It provides the same 3D structure viewer and analysis tools as the web app, plus native file handling, a multi-pane editor, and an optional bundled computation server.

## Starting the App

After [building or installing](/developer/desktop-build) the desktop app, launch it like any native application:

- **macOS:** Open `CatGo.app` from Applications or the `.dmg`
- **Windows:** Run the `.exe` or use the Start Menu shortcut from the `.msi` installer
- **Linux:** Run the `.AppImage`, or install the `.deb`/`.rpm` package

The app opens a single pane with the **landing page**, which shows import options and a sample structure.

## Loading Structures

There are five ways to get a structure into CatGO:

### Open File Dialog

Click **Open File** on the landing page, or press `Ctrl+O` (`Cmd+O` on macOS). A native OS file picker appears with filters for supported formats:

- **Structure files:** `.cif`, `.poscar`, `.vasp`, `.xyz`, `.json`
- **Trajectory files:** `.extxyz`, `.traj`, `.h5`, `.hdf5`, `XDATCAR`
- **Density files:** `.cube`, `.cub`
- **Compressed:** `.gz`, `.zip`, `.bz2` variants of all the above

### Drag and Drop

Drag any supported file from your file manager directly onto the app window. The file loads into the first empty pane, or the active pane if all are occupied.

### Double-Click (File Associations)

The desktop app registers file associations for `.cif`, `.poscar`, `.vasp`, `.contcar`, `.xyz`, `.extxyz`, `.traj`, and `.json`. Double-clicking these files in your file manager opens them directly in CatGO. On macOS, associated files display a custom CatGO document icon in Finder.

### Database Search

Click **OPTIMADE** to search crystal structure databases (Materials Project, AFLOW, COD, etc.) or **PubChem** to search molecular compound databases. Both require the computation server to be running (see [Backend Server](#backend-server) below).

### Paste Content

Click **Paste** to paste POSCAR or CONTCAR text directly from your clipboard.

## Tabs and Multi-Pane Layout

### Tab Management

CatGO uses a **collapsible tab bar** to manage multiple workspaces:

- **Single tab:** The tab bar is hidden to maximize viewport space. A small **+** button floats in the top-right corner to add new tabs.
- **Multiple tabs:** A full tab bar appears with **pill-style tabs**. The active tab is highlighted with a subtle accent fill.

| Action | How |
|--------|-----|
| New structure tab | Click **+** &rarr; Structure, or `Ctrl+T` / `Cmd+T` |
| New workflow tab | Click **+** &rarr; Workflow |
| Switch tabs | Click a tab, or `Ctrl+Tab` / `Ctrl+Shift+Tab` to cycle |
| Close tab | Click the **x** on a tab, or middle-click it |

### Multi-Pane Layout

Each structure tab supports up to **4 structures simultaneously** in a grid layout. When you load a second file, the layout auto-expands to 2 panes. When you close structures, the layout auto-collapses.

### Switching Panes

- **Click** any pane to make it active
- Press **1**, **2**, **3**, or **4** to switch by number
- The active pane receives all keyboard shortcuts and toolbar actions

### Closing Structures

- Press `Ctrl+W` (`Cmd+W`) to close the active structure
- Press `Esc` to close the active structure (only if unmodified)

When a structure is closed, remaining content is automatically rearranged and the layout collapses.

## Atom Clipboard

You can copy and paste atoms between panes — useful for building heterostructures or transferring fragments.

1. **Select atoms** in the source pane (click + Shift+click)
2. Press `Ctrl+C` (`Cmd+C`) to copy — a clipboard indicator appears in the bottom-right showing how many atoms were copied
3. **Switch** to the target pane (click it or press its number key)
4. Press `Ctrl+V` (`Cmd+V`) to paste — atoms are inserted with a 0.5 A offset to avoid overlap

Pasted atoms are automatically selected so you can immediately reposition them. The clipboard preserves full site data: element species, coordinates, labels, and properties.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+O` / `Cmd+O` | Open file dialog |
| `Ctrl+T` / `Cmd+T` | New structure tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |
| `Ctrl+W` / `Cmd+W` | Close active structure or tab |
| `Ctrl+C` / `Cmd+C` | Copy selected atoms |
| `Ctrl+V` / `Cmd+V` | Paste atoms into active pane |
| `Esc` | Close active structure (if unmodified) |
| `1` - `4` | Switch active pane |
| `R` | Reset camera |

All standard structure viewer shortcuts (rotation, zoom, selection) also work within each pane.

## Settings Persistence

The desktop app automatically saves your preferences to `localStorage`. These settings persist across sessions:

- **Camera:** Projection mode (perspective/orthographic), zoom/rotate/pan speeds, zoom-to-cursor
- **Display:** Bond visibility, atom radius, same-size atoms, site labels, site indices
- **Lighting:** Ambient and directional light intensity

Settings are shared across all panes and saved with a 500ms debounce to avoid excessive writes. They are restored automatically on next launch.

## Backend Server

Some features require the Python computation server running on `localhost:8000`:

- **Structure optimization** (EMT, xTB, MACE, CHGNet, M3GNet)
- **Database search** (OPTIMADE, Materials Project, PubChem)
- **Structure builders** (Moire, nanotube, heterostructure, water layer)
- **Input file generation** (Quantum ESPRESSO, LAMMPS, VASP)
- **Adsorption site finding**
- **CUBE file processing**

### Bundled Server

If you built CatGO with the bundled backend (`pnpm bundle`), the Python server starts automatically when the app launches and shuts down when the window closes. No manual setup is needed.

You can verify it's running by checking `http://localhost:8000/health` in a browser.

### Manual Server

If you built with `pnpm tauri:build` (without bundling), start the server separately:

```bash
cd server
pip install -r requirements.txt
python main.py
```

The server runs on port 8000 with CORS configured for the desktop app. Features that need the server will work as soon as it's detected.

### Features That Work Without the Server

The core viewer, WASM-powered features, and local operations work entirely offline:

- 3D structure viewing, rotation, selection
- File parsing and export (all formats)
- Bond detection and editing (WASM)
- Slab generation and supercells (WASM)
- Symmetry analysis (Spglib/Moyo WASM)
- Local UFF optimization (browser-based)
- Trajectory playback

## Structure Builders

The **Build** button on the landing page opens a graphene template that gives access to the structure manipulation toolbar. From there you can use:

- **Slab Cutter** — Generate surface slabs from Miller indices
- **Supercell** — Expand the periodic cell
- **Moire Builder** — Create twisted bilayer structures (requires server)
- **Nanotube Builder** — Roll sheets into nanotubes (requires server)
- **Heterostructure Builder** — Stack different materials (requires server)
- **Adsorbate Placement** — Place molecules on surfaces (requires server)

## Tips

- **Compare structures** side by side: open two files in the same tab — the layout auto-splits to show them simultaneously
- **Transfer atoms** between structures: select in one pane, `Ctrl+C`, switch panes, `Ctrl+V`
- **Quick preview:** Drop a file onto the app window — it loads into the first empty pane without disrupting your current work
- **Modified indicator:** CatGO tracks whether you've edited a structure (added/removed atoms). Modified structures cannot be closed with `Esc` — use `Ctrl+W` instead
- **Dark theme:** The desktop app uses the dark theme by default for reduced eye strain during long sessions
- **Maximize space:** With a single tab open, the tab bar hides completely — all vertical space goes to the structure viewer
