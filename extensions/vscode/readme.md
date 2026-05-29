# [CatGo VSCode Extension]

[catgo vscode extension]: https://marketplace.visualstudio.com/items?itemName=Guangsheng.catgo

**CatGo** offers a VSCode extension for rendering crystal structures and molecular dynamics (MD) or geometry optimization trajectories directly in the editor to speed up typical materials science/computational chemistry workflows.

## ✨ Features

### 🔬 **Structure Visualization**

- **Crystal Structures**: Visualize CIF, POSCAR, VASP, and other crystallographic formats
- **Molecular Systems**: Display XYZ, JSON, and YAML molecular structures
- **Interactive 3D Viewer**: Rotate, zoom, and explore structures with intuitive controls
- **Atomic Properties**: View element information, bonding, and structural details

### 🎬 **Trajectory Analysis**

- **MD Trajectories**: Animate and analyze molecular dynamics simulations
- **Multi-format Support**: Handle TRAJ, ExtXYZ, HDF5, and compressed formats
- **Playback Controls**: Navigate through trajectory frames with timeline controls
- **Frame Analysis**: Extract and analyze individual frames from trajectories

### 🎨 **Customization**

- **Color Schemes**: Multiple built-in color schemes (Jmol, VESTA, Alloy, Pastel, etc.)
- **Visualization Modes**: Ball-and-stick, space-filling, wireframe representations
- **Export Options**: Save visualizations to PNG or export structure data to ASE XYZ and pymatgen JSON

## 🚀 Installation

Search for "CatGo" in the VS Code Extensions marketplace.

## 📋 Usage

### Quick Start

1. **Open a structure file** in VS Code (`.cif`, `.poscar`, `.xyz`, `.json`, etc.)
2. **Right-click** in the explorer or editor
3. **Select "Render with CatGo"** from the context menu
4. **Or use the keyboard shortcut**: `Ctrl+Shift+V` (Windows/Linux) / `Cmd+Shift+V` (Mac)

### Supported File Formats

#### Structure Files

- **CIF** - Crystallographic Information Files
- **POSCAR/CONTCAR** - VASP structure files
- **XYZ/ExtXYZ** - Standard molecular coordinate formats
- **JSON** - JSON-formatted structure data
- **YAML/YML** - YAML structure definitions

#### Trajectory Files

- **TRAJ** - ASE trajectory files
- **ExtXYZ** - Extended XYZ trajectories
- **HDF5/H5** - `flame` HDF5 trajectory formats
- **JSON** - `pymatgen` JSON trajectory formats
- **Compressed files** - `.gz` compressed versions of above

### Custom Editor Integration

CatGo automatically registers as a custom editor for trajectory files such as `.traj`, `.h5`, `.hdf5`, `.xyz.gz`, etc.

### Remote SSH Support

CatGo supports [VSCode](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh)/[Cursor](https://open-vsx.org/extension/jajera/vsx-remote-ssh) remote SSH connections. Connect to your server via Remote SSH extension, and CatGo should work just like it does locally.

- ✅ **Remote file access**: Visualize structures and trajectories on remote servers (HPC clusters, cloud instances, etc.)
- ✅ **No manual file transfer**: Files are read directly from the remote filesystem
- ✅ **File watching**: Changes to remote files are automatically detected and reloaded
- ⚠️ **File size limit**: Files are currently limited to 1GB to prevent memory issues. Larger files are streamed in chunks which is only supported locally, not via remote SSH.

## ⚙️ Configuration & Customization

CatGo provides extensive customization options through VSCode settings. Access these via:

- **Settings UI**: `File → Preferences → Settings` → Search for "CatGo"
- **JSON Settings**: `Ctrl+Shift+P` → "Preferences: Open Settings (JSON)"

### Common Configuration Scenarios

#### 🎨 **Visual Appearance**

```json
{
  "catgo.color_scheme": "Jmol",
  "catgo.background_color": "#ffffff",
  "catgo.background_opacity": 0.8,
  "catgo.structure.show_image_atoms": true,
  "catgo.structure.atom_radius": 1.2,
  "catgo.structure.bond_thickness": 0.8
}
```

#### 🎬 **Trajectory Playback**

```json
{
  "catgo.trajectory.auto_play": true,
  "catgo.trajectory.fps": 10,
  "catgo.trajectory.display_mode": "structure+scatter",
  "catgo.trajectory.show_controls": true
}
```

#### 📊 **Plot Customization**

```json
{
  "catgo.scatter.point_size": 5,
  "catgo.scatter.line_width": 3,
  "catgo.plot.grid_lines": true,
  "catgo.scatter.show_legend": true
}
```

#### 🔧 **Performance Optimization**

```json
{
  "catgo.trajectory.chunk_size": 500,
  "catgo.trajectory.bin_file_threshold": 10485760,
  "catgo.structure.sphere_segments": 16
}
```

### Setting Categories

| Category        | Description                     | Example Settings                                                             |
| --------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| **General**     | Global appearance and behavior  | `color_scheme`, `background_color`                                           |
| **Structure**   | 3D structure visualization      | `atom_radius`, `bond_thickness`, `show_cell`, `lighting`, `show_image_atoms` |
| **Trajectory**  | Animation and playback controls | `fps`, `auto_play`, `display_mode`, `show_controls`                          |
| **Plots**       | Scatter plots and histograms    | `scatter_point_size`, `plot_grid_lines`, `auto_fit_range`                    |
| **Performance** | Memory and processing options   | `chunk_size`, `use_indexing`, `sphere_segments`                              |

### Pro Tips

- **Reset to defaults**: Remove custom settings from your JSON config
- **Project-specific settings**: Use workspace settings (`.vscode/settings.json`) for per-project customization
- **Theme integration**: CatGo automatically adapts to your VSCode color theme
- **Performance**: Reduce `sphere_segments` for better performance with large structures

## ⌨️ Keyboard Shortcuts

- `Ctrl+Shift+V` / `Cmd+Shift+V` → Render structure/trajectory with CatGo

## 🐛 Bug Reporting

If you encounter any issues with CatGo, you can use the built-in bug reporting command to collect debug information:

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run **"Report CatGo Bug"**
3. The command will open a new document with detailed debug information including:
   - Your OS and version
   - VSCode/Cursor version
   - CatGo version
   - Whether you're in a remote session
   - Files currently being rendered
   - System resources and memory usage
   - Extension configuration
4. Copy the information and include it when [creating a GitHub issue](https://github.com/Hello-QM/catgo-LRG/issues/new)

## 📄 License

This extension is licensed under the [GNU AGPL-3.0](./license), matching the [catgo-LRG repository](https://github.com/Hello-QM/catgo-LRG).

## 🔗 Related Projects

- **Upstream CatGo / MatterViz**: [github.com/janosh/catgo](https://github.com/janosh/catgo)
- **pymatviz**: [Jupyter](https://jupyter.org)/[Marimo](https://marimo.io) extension for Python notebooks. Read about widgets in [`pymatviz` readme](https://github.com/janosh/pymatviz/blob/main/readme.md#interactive-widgets) for details.

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](../../contributing.md) for details.

## 🛠️ Development

```bash
git clone https://github.com/Hello-QM/catgo-LRG
cd catgo/extensions/vscode
pnpm install
pnpm build
vsce package
```
