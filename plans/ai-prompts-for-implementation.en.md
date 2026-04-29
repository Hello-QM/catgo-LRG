# CatGo Unified Plugin System -- AI Implementation Prompts

## Usage Instructions

Each prompt can be copied directly to an AI assistant (e.g., Claude Code). After reading the specified files, the AI can independently complete the implementation.

**Prompts have sequential dependencies**: Phase 0 -> Phase 1 -> Phase 2 -> Phase 3/4/5 (3/4/5 can run in parallel).

**Conventions**:
- All file paths are relative to the project root `d:/catgo/`
- Backend code is in the `server/` directory, using Python + FastAPI
- Frontend code is in the `src/` directory, using Svelte 5 (runes) + TypeScript
- Plugin directory is at `plugins/` under the project root
- Plugin manifest file is `catgo-plugin.json`, entry point is `plugin.py`

---

## Prompt 0: Fix Calculator Plugin Disconnection

```
You are a CatGo project developer. Please fix the Calculator plugin system disconnection issue.

## Background

CatGo already has a plugin framework (server/plugins/) that supports the CalculatorPlugin type. The PluginManager
can discover, load, and register plugins. However, the optimization routes optimize.py and optimize_ws.py directly
call the get_calculator() factory function in server/calculators/base.py, which only queries the built-in enum
CalculatorType (EMT/XTB/MACE/CHGNET/M3GNET), completely ignoring the plugin_manager registry.

## Disconnected Call Chain

User selects calculator_type="lennard_jones" (a plugin calculator)
  -> optimize.py L121: calc_wrapper = get_calculator(request.calculator, ...)
    -> calculators/base.py L74: if calc_type not in calculators: raise ValueError(...)
    -> Throws "Calculator 'lennard_jones' not available"

Never reaches:
  -> plugin_manager.get_calculator("lennard_jones")
    -> plugins/manager.py L283: self._calculator_plugins["lennard_jones"]
    -> Returns LennardJonesPlugin.get_calculator()

## Please read the following files first

1. `server/calculators/base.py` -- get_calculator() factory function (L35-98). Note that it accepts a CalculatorType
   enum, with an internal dict mapping enum values to Calculator classes. If calc_type is not in the dict, it
   directly raises ValueError.

2. `server/routers/optimize.py` -- Two call sites:
   - L121: `calc_wrapper = get_calculator(request.calculator, request.calculator_params)` -- /optimize/structure endpoint
   - L258: `calc_wrapper = get_calculator(request.calculator, request.calculator_params)` -- /optimize/energy endpoint
   - L84-106: list_calculators() -- only iterates over the CalculatorType enum

3. `server/routers/optimize_ws.py` -- WebSocket optimization:
   - Also imports `from calculators import get_calculator`
   - Also only accepts CalculatorType enum

4. `server/plugins/manager.py` -- PluginManager class:
   - L269-291: get_calculator(calculator_id, **kwargs) -- fetches from _calculator_plugins
   - L293-295: has_calculator(calculator_id) -- checks if it exists
   - L315-320: get_all_calculators() -- returns all plugin calculator info

5. `server/plugins/base.py` -- CalculatorPlugin base class:
   - L179-270: defines calculator_id, supported_elements, get_calculator(), supports_structure()
   - Note that CalculatorPlugin.get_calculator() returns an ASE Calculator, and calculators/base.py's
     BaseCalculator.get_calculator() also returns an ASE Calculator -- interfaces are compatible

6. `server/models/structure.py` -- CalculatorType enum (L11-18):
   - CalculatorType(str, Enum): EMT, XTB, MACE, CHGNET, M3GNET

7. `examples/plugins/lennard-jones-calculator/plugin.py` -- reference plugin implementation

## Tasks

### 1. Modify server/calculators/base.py's get_calculator() (L35-98)

Change the calc_type parameter type from `CalculatorType` to `CalculatorType | str`.

Change the logic to:
a) If calc_type is a CalculatorType enum member, use existing logic to look up the built-in dict
b) If not in the built-in dict (or calc_type is a plain str), fall back to plugin_manager:
   ```python
   from plugins import plugin_manager

   calc_type_str = calc_type.value if isinstance(calc_type, CalculatorType) else str(calc_type)

   if plugin_manager.has_calculator(calc_type_str):
       # CalculatorPlugin's get_calculator() directly returns an ASE Calculator
       # Need to wrap it in the BaseCalculator interface
       plugin = plugin_manager._calculator_plugins[calc_type_str]

       class _PluginWrapper(BaseCalculator):
           name = plugin.display_name
           description = plugin.description
           supported_elements = plugin.supported_elements
           def get_calculator(self):
               return plugin.get_calculator(**kwargs_from_params)

       return _PluginWrapper()
   ```
c) Only raise ValueError if both fail, with error message including plugin calculators

Note: CalculatorPlugin.get_calculator(**kwargs) accepts arbitrary kwargs,
but BaseCalculator consumers (optimize.py) call calc_wrapper.get_calculator()
with no arguments. Need to pass params through in the wrapper.

### 2. Modify optimize.py's list_calculators() (L84-106)

Currently only iterates over the CalculatorType enum. Change to: after iterating the enum, append
plugin_manager.get_all_calculators() returned plugin calculators (marked with is_plugin=true).

### 3. Ensure optimize_ws.py uses the same factory function

optimize_ws.py also does `from calculators import get_calculator`, same as optimize.py.
As long as calculators/base.py's get_calculator() supports str-type calc_type,
the WebSocket path is automatically fixed.

But need to check if the WSOptimizationRequest model's calculator field type allows plugin ids.
If it's a CalculatorType enum, need to change to `CalculatorType | str`.

### 4. Modify models/structure.py request models

- OptimizationRequest.calculator field: change from `CalculatorType` to `str`
  (or `CalculatorType | str`, Pydantic v2 supports Union types)
- WSOptimizationRequest.calculator field: same
- Keep existing CalculatorType enum values still usable on the frontend

## Verification Steps

1. Run `cd server && python -c "from calculators.base import get_calculator; print('import ok')"` -- no import errors
2. Copy examples/plugins/lennard-jones-calculator/ to the project root plugins/ directory:
   `cp -r examples/plugins/lennard-jones-calculator plugins/`
3. Start backend: `python server/main.py`
4. POST http://localhost:8000/api/plugins/refresh -- should discover the lennard-jones plugin
5. GET http://localhost:8000/api/plugins/calculators -- should return lennard_jones
6. GET http://localhost:8000/api/optimize/calculators -- should include lennard_jones (is_plugin=true)
7. Test with an Ar2 molecule: POST /api/optimize/structure, calculator="lennard_jones" -- should return optimization results
```

---

## Prompt 1: Implement ReaderPlugin Base Class

```
You are a CatGo project developer. Please implement the unified ReaderPlugin file reading plugin interface.

## Background

CatGo has 20+ file format readers scattered across multiple locations:
- extensions/dos-analysis/catgo_dos/io.py -- VASP HDF5 + PROCAR reading
- extensions/cohp-analysis/catgo_cohp/io.py -- LOBSTER COHP file reading
- server/routers/dos.py -- hardcoded import via sys.path.insert
- server/routers/cohp.py -- same as above

Each time a new format is added (e.g., CP2K PDOS), 6+ files must be manually modified. The goal of ReaderPlugin is:
- New formats only need a plugin directory placed in plugins/
- REST endpoints are automatically registered
- Sessions are automatically created (DOS/COHP/Bands share the session pattern)
- No frontend changes needed

## Please read the following files first

1. `server/plugins/base.py` -- Understand the BasePlugin base class (L103-172) and the CalculatorPlugin pattern (L179-270)
   Note: PluginType enum is at L72-77, currently only has CALCULATOR/OPTIMIZER/ROUTER

2. `server/plugins/discovery.py` -- Understand _find_plugin_class() (L208-237):
   Currently only searches for CalculatorPlugin and OptimizerPlugin subclasses; after adding ReaderPlugin, it needs to be included in the search

3. `server/plugins/manager.py` -- Understand registration and retrieval logic:
   - _register_plugin() (L121-149): isinstance checks then registers to the corresponding dict
   - Need to add _reader_plugins dict and corresponding register/query methods

4. `server/routers/plugins.py` -- Understand REST endpoint patterns:
   - GET /api/plugins/calculators (L115-137) -- lists all calculator plugins
   - POST /api/plugins/refresh (L268-288) -- re-discovers plugins

5. `extensions/dos-analysis/catgo_dos/io.py` -- VaspData dataclass (L33-68):
   ```python
   @dataclass
   class VaspData:
       eigenvalues: np.ndarray      # (nspin, nkpts, nbands)
       kweights: np.ndarray         # (nkpts,)
       efermi: float
       projectors: np.ndarray       # (nspin, nions, nchannels, nkpts, nbands)
       positions: np.ndarray        # (nions, 3) cartesian
       positions_frac: np.ndarray   # (nions, 3) fractional
       lattice: np.ndarray          # (3, 3)
       elements: np.ndarray         # (nions,) str
       ion_types: list[str]
       ion_counts: list[int]
   ```
   This is the core data structure for DOS sessions. Data produced by ReaderPlugin must be compatible with this format.

6. `server/routers/dos.py` -- Understand session and upload patterns:
   - DOSSession dataclass (L39-45): holds VaspData + source label
   - _sessions dict (L48): session_id -> DOSSession in-memory cache
   - _create_session() (L122-146): creates session and returns DOSUploadResponse
   - upload_h5 endpoint (L149-177): upload HDF5 -> read_vaspout_h5() -> _create_session()
   - upload_procar endpoint (L179+): upload PROCAR -> read_procar() -> _create_session()
   - Note: after session creation, the frontend uses session_id to call /api/dos/compute to calculate PDOS

## Tasks

### 1. Add ReaderPlugin base class in server/plugins/base.py

Add after OptimizerPlugin:

```python
class ReaderPlugin(BasePlugin):
    """
    Base class for file reader plugins.

    Reader plugins handle uploading and parsing specific file formats
    (e.g., CP2K PDOS, Quantum ESPRESSO bands, VASP XML).

    The output_type determines how the parsed data is routed:
    - "electronic_dos": Creates a DOS session, data must be VaspData-compatible dict
    - "electronic_bands": Creates a bands session
    - "cohp": Creates a COHP session
    - "structure": Returns structure dict directly
    - "trajectory": Returns trajectory frames

    Example:
        class CP2KDosReader(ReaderPlugin):
            name = "cp2k-dos-reader"
            reader_id = "cp2k_pdos"
            display_name = "CP2K PDOS Reader"
            description = "Read CP2K projected DOS files (.pdos)"
            version = "1.0.0"
            author = "Your Name"

            supported_formats = [".pdos"]
            output_type = "electronic_dos"

            async def read(self, file_paths, options=None):
                # Parse .pdos files -> return VaspData-compatible dict
                return { "eigenvalues": ..., "kweights": ..., ... }

            def detect_file(self, filename, content_preview=None):
                return filename.endswith(".pdos")
    """

    # Reader-specific attributes
    reader_id: str                       # API identifier (e.g., "cp2k_pdos")
    supported_formats: list[str]         # File extension list (e.g., [".pdos", ".pdos.1"])
    output_type: str                     # "electronic_dos" | "electronic_bands" | "cohp" | "structure" | "trajectory"

    @abstractmethod
    async def read(self, file_paths: list[Path], options: Optional[dict] = None) -> dict:
        """
        Read and parse the uploaded file(s).

        Args:
            file_paths: List of temporary file paths (uploaded files)
            options: Optional parameters from the upload request

        Returns:
            Dict with parsed data. Format depends on output_type:
            - electronic_dos: VaspData-compatible dict with keys:
              eigenvalues, kweights, efermi, projectors, positions,
              positions_frac, lattice, elements, ion_types, ion_counts
            - structure: {"structure": pymatgen_dict}
            - electronic_bands: {"bands": {...}, "structure": {...}}
        """
        pass

    def detect_file(self, filename: str, content_preview: Optional[str] = None) -> bool:
        """
        Check if this reader can handle a given file.

        Default implementation checks file extension against supported_formats.
        Override for content-based detection.
        """
        from pathlib import Path as P
        suffixes = P(filename).suffixes  # e.g., ['.pdos', '.1']
        ext = P(filename).suffix         # e.g., '.1' or '.pdos'
        full_ext = "".join(suffixes)     # e.g., '.pdos.1'
        return any(
            ext == fmt or full_ext.endswith(fmt)
            for fmt in self.supported_formats
        )

    @classmethod
    def validate(cls) -> list[str]:
        errors = super().validate()
        if not hasattr(cls, "reader_id") or not cls.reader_id:
            errors.append("Missing required attribute: reader_id")
        if not hasattr(cls, "supported_formats") or not cls.supported_formats:
            errors.append("Missing required attribute: supported_formats")
        if not hasattr(cls, "output_type") or not cls.output_type:
            errors.append("Missing required attribute: output_type")
        valid_output_types = {"electronic_dos", "electronic_bands", "cohp", "structure", "trajectory"}
        if hasattr(cls, "output_type") and cls.output_type not in valid_output_types:
            errors.append(f"Invalid output_type: {cls.output_type}. Must be one of {valid_output_types}")
        return errors

    def get_metadata(self) -> PluginMetadata:
        meta = super().get_metadata()
        meta.extra["reader_id"] = self.reader_id
        meta.extra["supported_formats"] = self.supported_formats
        meta.extra["output_type"] = self.output_type
        return meta
```

### 2. Add to PluginType enum (L72-77)

```python
READER = "reader"
```

### 3. Modify BasePlugin.get_plugin_type() (L126-134)

Add ReaderPlugin branch:
```python
elif issubclass(cls, ReaderPlugin):
    return PluginType.READER
```

### 4. Modify discovery.py's _find_plugin_class() (L208-237)

Add ReaderPlugin to the import at L222:
```python
from .base import BasePlugin, CalculatorPlugin, OptimizerPlugin, ReaderPlugin
```

Add ReaderPlugin to the issubclass check at L225:
```python
if issubclass(obj, (CalculatorPlugin, OptimizerPlugin, ReaderPlugin)):
```

### 5. Add Reader-related methods in manager.py

Add to __init__:
```python
self._reader_plugins: dict[str, ReaderPlugin] = {}  # reader_id -> plugin
```

Add ReaderPlugin branch in _register_plugin() (following the CalculatorPlugin pattern).

Add new methods:
```python
def find_reader_for_files(self, filenames: list[str]) -> Optional[ReaderPlugin]:
    """Find a reader plugin that can handle the given files."""
    for plugin in self._reader_plugins.values():
        if not plugin._enabled:
            continue
        for filename in filenames:
            if plugin.detect_file(filename):
                return plugin
    return None

def get_all_readers(self) -> list[dict]:
    """Get information about all registered reader plugins."""
    return [
        {
            "id": plugin.reader_id,
            "name": plugin.name,
            "display_name": plugin.display_name,
            "description": plugin.description,
            "version": plugin.version,
            "enabled": plugin._enabled,
            "supported_formats": plugin.supported_formats,
            "output_type": plugin.output_type,
        }
        for plugin in self._reader_plugins.values()
    ]
```

### 6. Add endpoints in routers/plugins.py

```python
@router.get("/readers")
async def list_reader_plugins():
    """List all reader plugins and their supported formats."""
    readers = plugin_manager.get_all_readers()
    return {"readers": readers, "total": len(readers)}


@router.post("/readers/upload")
async def reader_plugin_upload(
    files: list[UploadFile] = File(...),
    reader_id: Optional[str] = None,
):
    """
    Upload files to a reader plugin.

    If reader_id is not specified, auto-detect based on file extensions.
    Creates appropriate session (DOS/bands/etc.) based on output_type.
    """
    import tempfile
    from pathlib import Path

    if not files:
        raise HTTPException(400, "No files provided")

    filenames = [f.filename or "unknown" for f in files]

    # Find reader
    if reader_id:
        if not plugin_manager.has_reader(reader_id):
            raise HTTPException(404, f"Reader not found: {reader_id}")
        reader = plugin_manager._reader_plugins[reader_id]
    else:
        reader = plugin_manager.find_reader_for_files(filenames)
        if not reader:
            raise HTTPException(400, f"No reader found for files: {filenames}")

    # Save files to temp
    tmp_paths = []
    try:
        for f in files:
            suffix = Path(f.filename or "").suffix or ".dat"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                content = await f.read()
                tmp.write(content)
                tmp_paths.append(Path(tmp.name))

        # Read
        data = await reader.read(tmp_paths)

        # Route based on output_type
        if reader.output_type == "electronic_dos":
            return _create_dos_session_from_reader(data, reader.reader_id)
        elif reader.output_type == "structure":
            return data
        else:
            return data

    finally:
        for p in tmp_paths:
            p.unlink(missing_ok=True)
```

Where _create_dos_session_from_reader() reuses the dos.py _create_session pattern:
```python
def _create_dos_session_from_reader(data: dict, source: str):
    """Create a DOS session from reader plugin output."""
    import numpy as np
    import time
    import uuid

    # Import dos session infrastructure
    from routers.dos import _sessions, DOSSession, _cleanup_expired

    # Reconstruct VaspData-compatible object from dict
    # (reader plugins return plain dicts, DOS router expects VaspData)
    from catgo_dos.io import VaspData

    vasp_data = VaspData(
        eigenvalues=np.array(data["eigenvalues"]),
        kweights=np.array(data["kweights"]),
        efermi=float(data["efermi"]),
        projectors=np.array(data["projectors"]),
        positions=np.array(data["positions"]),
        positions_frac=np.array(data["positions_frac"]),
        lattice=np.array(data["lattice"]),
        elements=np.array(data["elements"]),
        ion_types=data.get("ion_types", []),
        ion_counts=data.get("ion_counts", []),
    )

    # Reuse dos.py session creation
    from routers.dos import _create_session
    return _create_session(vasp_data, source=source)
```

### 7. Create example CP2K DOS reader plugin

Create directory: `plugins/cp2k-dos-reader/`

File `plugins/cp2k-dos-reader/catgo-plugin.json`:
```json
{
  "name": "@catgo/cp2k-dos-reader",
  "version": "1.0.0",
  "displayName": "CP2K PDOS Reader",
  "description": "Read CP2K projected density of states (.pdos) files",
  "author": { "name": "CatGo Team" },
  "license": "MIT",
  "catgo": {
    "apiVersion": "1.0",
    "backend": {
      "main": "plugin.py",
      "contributions": {
        "readers": [
          {
            "id": "cp2k_pdos",
            "name": "CP2K PDOS",
            "formats": [".pdos"],
            "output_type": "electronic_dos"
          }
        ]
      }
    }
  }
}
```

File `plugins/cp2k-dos-reader/plugin.py`:
```python
"""CP2K PDOS file reader plugin for CatGo.

Reads CP2K .pdos output files and converts them to VaspData-compatible
format for DOS analysis.

CP2K .pdos format:
  # First few lines are headers with metadata
  # Columns: MO eigenvalue(eV) occupation s py pz px ...
  # Multiple files per calculation (one per atom kind + total)
"""

import sys
from pathlib import Path

server_dir = Path(__file__).parent.parent.parent / "server"
if server_dir.exists() and str(server_dir) not in sys.path:
    sys.path.insert(0, str(server_dir))

from plugins.base import ReaderPlugin
from typing import Optional
import numpy as np


class CP2KDosReaderPlugin(ReaderPlugin):
    name = "cp2k-dos-reader"
    reader_id = "cp2k_pdos"
    display_name = "CP2K PDOS Reader"
    description = "Read CP2K projected density of states (.pdos) files"
    version = "1.0.0"
    author = "CatGo Team"

    supported_formats = [".pdos"]
    output_type = "electronic_dos"

    async def read(self, file_paths: list[Path], options: Optional[dict] = None) -> dict:
        """Parse CP2K .pdos files into VaspData-compatible format."""
        # TODO: implement actual CP2K .pdos parsing
        # For now, this is a scaffold. Key steps:
        # 1. Parse header to get atom kind, orbital labels, MO count
        # 2. Parse numeric columns: eigenvalue, occupation, orbital projections
        # 3. Multiple .pdos files -> merge by atom kind
        # 4. Construct eigenvalues, kweights, projectors arrays
        raise NotImplementedError(
            "CP2K PDOS parsing not yet implemented. "
            "This is a scaffold plugin demonstrating the ReaderPlugin interface."
        )

    def detect_file(self, filename: str, content_preview: Optional[str] = None) -> bool:
        """Check if file is a CP2K .pdos file."""
        if filename.endswith(".pdos"):
            return True
        # CP2K also produces numbered pdos files like "k1-1.pdos"
        if ".pdos" in filename:
            return True
        return False
```

## Verification Steps

1. Check that imports work:
   ```bash
   cd server && python -c "from plugins.base import ReaderPlugin; print('ReaderPlugin ok')"
   cd server && python -c "from plugins.manager import plugin_manager; print(plugin_manager._reader_plugins)"
   ```

2. Start backend -> POST /api/plugins/refresh -> should discover cp2k-dos-reader

3. GET /api/plugins/readers -> should return:
   ```json
   {"readers": [{"id": "cp2k_pdos", "supported_formats": [".pdos"], ...}], "total": 1}
   ```

4. GET /api/plugins/ -> should include cp2k-dos-reader, plugin_type="reader"

5. Existing functionality unaffected: existing H5/PROCAR upload paths are not affected
```

---

## Prompt 2: Implement AnalyzerPlugin Base Class

```
You are a CatGo project developer. Please implement the AnalyzerPlugin analysis tool plugin interface.

## Background

CatGo's analysis features (DOS, d-band, COHP, etc.) are all hardcoded in server/routers/. Adding a new analysis
tool requires modifying many files. AnalyzerPlugin lets users add custom analysis features through plugins (e.g.,
bond histogram, RDF analysis, Bader charge visualization, etc.), with the frontend automatically rendering results.

## Prerequisites

Phase 1 (ReaderPlugin) is complete, server/plugins/base.py already has the ReaderPlugin base class.

## Please read the following files first

1. `server/plugins/base.py` -- Understand existing base class patterns. Phase 1 already added ReaderPlugin.
   Note the PluginType enum, BasePlugin.get_plugin_type(), validate() patterns.

2. `server/plugins/discovery.py` -- _find_plugin_class() (L208-237):
   Phase 1 already added ReaderPlugin to the issubclass check, need to add AnalyzerPlugin too.

3. `server/plugins/manager.py` -- _register_plugin() routing and dict registration pattern.
   Phase 1 already added _reader_plugins, need to add _analyzer_plugins.

4. `server/routers/plugins.py` -- REST endpoint patterns.
   Phase 1 already added /readers and /readers/upload, need to add /analyzers and /{name}/analyze.

5. `src/lib/plot/types.ts` -- Frontend data formats (reference data contracts):
   - DataSeries (L88-112): { x: number[], y: number[], label?: string, ... }
   - BarSeries (L265-282): { x: number[], y: number[], label?: string, color?: string, ... }
   - AxisConfig (L285-297): { label?: string, format?: string, scale_type?: "linear" | "log", ... }
   Analysis plugin output must conform to these formats for the frontend to render directly.

## Tasks

### 1. Add AnalyzerPlugin in base.py

Add after ReaderPlugin:

```python
class AnalyzerPlugin(BasePlugin):
    """
    Base class for analysis tool plugins.

    Analyzer plugins take structured input (typically a structure + parameters)
    and produce visualization data (plots, tables, images).

    The output_type determines which frontend renderer is used:
    - "scatter_plot": DataSeries-compatible output -> ScatterPlot component
    - "bar_plot": BarSeries-compatible output -> BarPlot component
    - "table": Tabular data -> HTML table
    - "image": Base64 image -> <img> tag
    - "text": Plain text / markdown

    Example:
        class BondHistogramPlugin(AnalyzerPlugin):
            name = "bond-histogram"
            analyzer_id = "bond_histogram"
            display_name = "Bond Length Histogram"
            description = "Distribution of bond lengths in the structure"
            version = "1.0.0"
            author = "Your Name"

            output_type = "bar_plot"
            input_schema = {
                "type": "object",
                "properties": {
                    "structure": {"type": "object"},
                    "n_bins": {"type": "integer", "default": 30},
                    "max_distance": {"type": "number", "default": 4.0},
                },
                "required": ["structure"]
            }

            async def analyze(self, input_data):
                # Parse structure, compute bond lengths, histogram
                return {
                    "series": [{"x": bin_centers, "y": counts, "label": "Bond Lengths"}],
                    "x_axis": {"label": "Distance (A)"},
                    "y_axis": {"label": "Count"},
                }
    """

    # Analyzer-specific attributes
    analyzer_id: str                # API identifier (e.g., "bond_histogram")
    output_type: str                # "scatter_plot" | "bar_plot" | "table" | "image" | "text"
    input_schema: dict              # JSON Schema for analyze() input

    @abstractmethod
    async def analyze(self, input_data: dict) -> dict:
        """
        Run analysis and produce visualization data.

        Args:
            input_data: Input matching input_schema (typically includes "structure")

        Returns:
            Dict formatted according to output_type:

            scatter_plot / bar_plot:
            {
                "series": [
                    {"x": [...], "y": [...], "label": "Series 1"},
                    {"x": [...], "y": [...], "label": "Series 2"},
                ],
                "x_axis": {"label": "X Label", "unit": "eV"},
                "y_axis": {"label": "Y Label"},
            }

            table:
            {
                "columns": [
                    {"key": "element", "label": "Element"},
                    {"key": "cn", "label": "CN", "format": ".0f"},
                ],
                "rows": [
                    {"element": "Fe", "cn": 8},
                    {"element": "O", "cn": 4},
                ],
            }

            image:
            {
                "data": "base64-encoded-image-data",
                "mime": "image/png",
                "width": 800, "height": 600,
            }

            text:
            {
                "content": "Markdown formatted text...",
            }
        """
        pass

    @classmethod
    def validate(cls) -> list[str]:
        errors = super().validate()
        if not hasattr(cls, "analyzer_id") or not cls.analyzer_id:
            errors.append("Missing required attribute: analyzer_id")
        if not hasattr(cls, "output_type") or not cls.output_type:
            errors.append("Missing required attribute: output_type")
        valid_types = {"scatter_plot", "bar_plot", "table", "image", "text"}
        if hasattr(cls, "output_type") and cls.output_type not in valid_types:
            errors.append(f"Invalid output_type: {cls.output_type}. Must be one of {valid_types}")
        if not hasattr(cls, "input_schema") or not cls.input_schema:
            errors.append("Missing required attribute: input_schema")
        return errors

    def get_metadata(self) -> PluginMetadata:
        meta = super().get_metadata()
        meta.extra["analyzer_id"] = self.analyzer_id
        meta.extra["output_type"] = self.output_type
        meta.extra["input_schema"] = self.input_schema
        return meta
```

### 2. Add to PluginType enum

```python
ANALYZER = "analyzer"
```

### 3. Update BasePlugin.get_plugin_type()

Add AnalyzerPlugin branch.

### 4. Update discovery.py

Add AnalyzerPlugin to the issubclass check in _find_plugin_class().

### 5. Add to manager.py

```python
self._analyzer_plugins: dict[str, AnalyzerPlugin] = {}  # analyzer_id -> plugin
```

Plus the AnalyzerPlugin branch in _register_plugin() and the get_all_analyzers() method.

### 6. Add endpoints in routers/plugins.py

```python
@router.get("/analyzers")
async def list_analyzer_plugins():
    """List all analyzer plugins with their schemas."""
    analyzers = plugin_manager.get_all_analyzers()
    return {"analyzers": analyzers, "total": len(analyzers)}


@router.post("/{plugin_name}/analyze")
async def run_analyzer(plugin_name: str, input_data: dict):
    """
    Run an analyzer plugin.

    The plugin_name can be either the plugin name or analyzer_id.
    Input must match the plugin's input_schema.
    """
    # Try by analyzer_id first, then by plugin name
    plugin = None
    if plugin_name in plugin_manager._analyzer_plugins:
        plugin = plugin_manager._analyzer_plugins[plugin_name]
    else:
        p = plugin_manager.get_plugin(plugin_name)
        if p and isinstance(p, AnalyzerPlugin):
            plugin = p

    if not plugin:
        raise HTTPException(404, f"Analyzer not found: {plugin_name}")
    if not plugin._enabled:
        raise HTTPException(400, f"Analyzer plugin is disabled: {plugin_name}")

    try:
        result = await plugin.analyze(input_data)
        return {
            "analyzer_id": plugin.analyzer_id,
            "output_type": plugin.output_type,
            "result": result,
        }
    except Exception as e:
        logger.exception(f"Analyzer {plugin_name} failed")
        raise HTTPException(500, detail=str(e))
```

### 7. Create example bond-histogram plugin

Create `plugins/bond-histogram/catgo-plugin.json`:
```json
{
  "name": "@catgo/bond-histogram",
  "version": "1.0.0",
  "displayName": "Bond Length Histogram",
  "description": "Compute and display bond length distribution",
  "author": { "name": "CatGo Team" },
  "license": "MIT",
  "catgo": {
    "apiVersion": "1.0",
    "backend": {
      "main": "plugin.py",
      "contributions": {
        "analyzers": [{
          "id": "bond_histogram",
          "name": "Bond Length Histogram",
          "output_type": "bar_plot"
        }]
      }
    }
  }
}
```

Create `plugins/bond-histogram/plugin.py`:
```python
"""Bond length histogram analyzer plugin for CatGo."""

import sys
from pathlib import Path
from typing import Optional

server_dir = Path(__file__).parent.parent.parent / "server"
if server_dir.exists() and str(server_dir) not in sys.path:
    sys.path.insert(0, str(server_dir))

from plugins.base import AnalyzerPlugin


class BondHistogramPlugin(AnalyzerPlugin):
    name = "bond-histogram"
    analyzer_id = "bond_histogram"
    display_name = "Bond Length Histogram"
    description = "Compute distribution of interatomic distances in the structure"
    version = "1.0.0"
    author = "CatGo Team"

    output_type = "bar_plot"
    input_schema = {
        "type": "object",
        "properties": {
            "structure": {"type": "object", "description": "Pymatgen structure dict"},
            "n_bins": {"type": "integer", "default": 30, "minimum": 5, "maximum": 200},
            "max_distance": {"type": "number", "default": 4.0, "minimum": 1.0, "maximum": 20.0},
        },
        "required": ["structure"],
    }

    async def analyze(self, input_data: dict) -> dict:
        import numpy as np
        from pymatgen.core import Structure

        struct_dict = input_data["structure"]
        n_bins = input_data.get("n_bins", 30)
        max_dist = input_data.get("max_distance", 4.0)

        structure = Structure.from_dict(struct_dict)

        # Get all pairwise distances
        distances = []
        for i in range(len(structure)):
            neighbors = structure.get_neighbors(structure[i], max_dist)
            for neighbor in neighbors:
                distances.append(neighbor.nn_distance)

        if not distances:
            return {
                "series": [],
                "x_axis": {"label": "Distance (Angstrom)"},
                "y_axis": {"label": "Count"},
            }

        counts, bin_edges = np.histogram(distances, bins=n_bins, range=(0, max_dist))
        bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2

        return {
            "series": [
                {
                    "x": bin_centers.tolist(),
                    "y": counts.tolist(),
                    "label": f"Bond lengths (N={len(distances)})",
                }
            ],
            "x_axis": {"label": "Distance (Angstrom)"},
            "y_axis": {"label": "Count"},
        }
```

## Verification Steps

1. `cd server && python -c "from plugins.base import AnalyzerPlugin; print('ok')"`
2. Start backend -> POST /api/plugins/refresh -> should discover bond-histogram
3. GET /api/plugins/analyzers -> should return bond_histogram info
4. Test with a pymatgen structure dict:
   ```bash
   curl -X POST http://localhost:8000/api/plugins/bond_histogram/analyze \
     -H "Content-Type: application/json" \
     -d '{"structure": <pymatgen_dict>, "n_bins": 20, "max_distance": 3.5}'
   ```
   Should return bar_plot formatted data
5. Check that the returned series.x and series.y are number[] arrays
```

---

## Prompt 3: Implement WorkflowNodePlugin

```
You are a CatGo project developer. Please implement the WorkflowNodePlugin workflow node plugin.

## Background

CatGo's workflow system has two layers:
- Frontend: src/lib/workflow/node-definitions.ts defines all node type UI metadata
  (label, icon, category, param_schema, etc.), WorkflowEditor.svelte renders the SVG graph
- Backend: server/utils/workflow_engine.py executes workflow nodes, using hardcoded sets
  (VASP_CALC_NODES, LOCAL_NODES, BUILD_NODES, ANALYSIS_NODES, etc.) to dispatch to different processing logic

Adding a new node type requires simultaneous modifications to both frontend and backend hardcoded code.
WorkflowNodePlugin lets users add custom nodes through plugins.

## Prerequisites

Phase 2 (AnalyzerPlugin) is complete.

## Please read the following files first

1. `server/plugins/base.py` -- Currently has BasePlugin, CalculatorPlugin, OptimizerPlugin,
   ReaderPlugin, AnalyzerPlugin.

2. `src/lib/workflow/workflow-types.ts` -- Key type definitions:
   - NodeDefinition (L31-50): Node UI definition
     ```typescript
     interface NodeDefinition {
       type: string          // Unique identifier (e.g., "geo_opt")
       label: string         // Display name
       color: string         // Node color (hex)
       icon: string          // Emoji icon
       category: string      // Sidebar category ("Calculation", "Tools", "Analysis", etc.)
       description: string
       inputs: string[]      // Input port types (e.g., ["structure"])
       outputs: string[]     // Output port types (e.g., ["structure", "energy"])
       default_params: Record<string, unknown>
       param_schema?: ParamDef[]  // Parameter panel field definitions
     }
     ```
   - ParamDef (L16-29): Parameter definition
     ```typescript
     interface ParamDef {
       key: string
       label: string
       type: "number" | "string" | "boolean" | "select" | "kpoints" | "text"
       default: unknown
       options?: { label: string; value: unknown }[]
       help?: string
       group?: string
       show_if?: { key: string; values: string[] }
       min?: number; max?: number; step?: number
     }
     ```

3. `src/lib/workflow/node-definitions.ts`:
   - NODE_DEFINITIONS: Record<string, NodeDefinition> (L353) -- static node registry
   - get_sidebar_categories() (L2066-2081) -- builds sidebar categories
   - Note L1428's on_drop(): `if (!type || !NODE_DEFINITIONS[type]) return`
     -- if type is not in NODE_DEFINITIONS, the drop is silently ignored

4. `src/lib/workflow/WorkflowEditor.svelte` -- on_drop() (L1425-1446):
   ```typescript
   function on_drop(e: DragEvent) {
     const type = e.dataTransfer?.getData('nodeType')
     if (!type || !NODE_DEFINITIONS[type]) return  // <-- guard: must be in NODE_DEFINITIONS
     const cfg = NODE_DEFINITIONS[type]
     // ... create node
   }
   ```
   Later, plugin nodes need to be merged into NODE_DEFINITIONS or the guard needs to be modified.

5. `server/utils/workflow_engine.py` -- Node execution dispatch:
   - VASP_CALC_NODES (L34-37): set of VASP node types
   - UNIFIED_CALC_NODES (L40): set of unified calculation nodes
   - LOCAL_NODES (L43-47): locally executed nodes
   - BUILD_NODES (L65-70): structure building nodes
   - ANALYSIS_NODES (L85-88): analysis nodes
   - Execution dispatch (L457-478): if/elif chain checking which set node_type belongs to
   - Final else branch (L478+): submits to HPC
   - No "unknown node type" fallback to plugins

## Tasks

### 1. Add WorkflowNodePlugin in base.py

```python
class WorkflowNodePlugin(BasePlugin):
    """
    Base class for workflow node plugins.

    Defines a custom node type for the visual workflow editor.
    Each plugin provides:
    - node_definition: UI metadata (label, icon, category, params)
    - execute(): async function called during workflow execution
    - execution_mode: "local" (run on CatGo server) or "hpc" (submit to HPC)

    Example:
        class CustomMDNode(WorkflowNodePlugin):
            name = "custom-md-node"
            node_type = "custom_md"
            display_name = "Custom MD"
            description = "Run MD with custom force field"
            version = "1.0.0"
            author = "Your Name"
            execution_mode = "local"

            node_definition = {
                "type": "custom_md",
                "label": "Custom MD",
                "color": "#22c55e",
                "icon": "\\u{1F3C3}",
                "category": "Specialized",
                "description": "Run MD with custom force field",
                "inputs": ["structure"],
                "outputs": ["trajectory"],
                "default_params": {"steps": 1000, "temperature": 300},
                "param_schema": [
                    {"key": "steps", "label": "Steps", "type": "number", "default": 1000},
                    {"key": "temperature", "label": "Temperature (K)", "type": "number", "default": 300},
                ],
            }

            async def execute(self, structure_json, params, config):
                # Run custom MD simulation
                # Return result dict
                return {"structure_json": optimized_json, "trajectory": frames}
    """

    node_type: str                    # Unique node type ID (e.g., "custom_md")
    node_definition: dict             # NodeDefinition-compatible dict
    execution_mode: str = "local"     # "local" | "hpc"

    @abstractmethod
    async def execute(
        self,
        structure_json: str,
        params: dict,
        config: dict,
    ) -> dict:
        """
        Execute the workflow node.

        Args:
            structure_json: Input structure as JSON string (pymatgen dict)
            params: Node parameters from the workflow editor
            config: Workflow run configuration (execution_mode, hpc settings, etc.)

        Returns:
            Result dict. Must include "structure_json" key if node outputs a structure.
        """
        pass

    @classmethod
    def validate(cls) -> list[str]:
        errors = super().validate()
        if not hasattr(cls, "node_type") or not cls.node_type:
            errors.append("Missing required attribute: node_type")
        if not hasattr(cls, "node_definition") or not cls.node_definition:
            errors.append("Missing required attribute: node_definition")
        # Validate node_definition has required keys
        required_keys = {"type", "label", "color", "icon", "category", "description", "inputs", "outputs"}
        if hasattr(cls, "node_definition") and cls.node_definition:
            missing = required_keys - set(cls.node_definition.keys())
            if missing:
                errors.append(f"node_definition missing keys: {missing}")
        return errors

    def get_metadata(self) -> PluginMetadata:
        meta = super().get_metadata()
        meta.extra["node_type"] = self.node_type
        meta.extra["node_definition"] = self.node_definition
        meta.extra["execution_mode"] = self.execution_mode
        return meta
```

### 2. Add to PluginType enum

```python
WORKFLOW_NODE = "workflow_node"
```

### 3. Update discovery.py, manager.py following the same pattern as previous Phases

manager.py additions:
```python
self._workflow_node_plugins: dict[str, WorkflowNodePlugin] = {}

def get_all_workflow_nodes(self) -> list[dict]:
    """Get all workflow node plugin definitions (for frontend)."""
    return [
        plugin.node_definition
        for plugin in self._workflow_node_plugins.values()
        if plugin._enabled
    ]
```

### 4. Add to routers/plugins.py

```python
@router.get("/workflow-nodes")
async def list_workflow_node_plugins():
    """List all workflow node plugins and their definitions."""
    nodes = plugin_manager.get_all_workflow_nodes()
    return {"nodes": nodes, "total": len(nodes)}
```

### 5. Modify workflow_engine.py execution dispatch

After the last elif (HPC submit nodes) at L478, before the end, add plugin fallback:

```python
elif node_type in plugin_manager._workflow_node_plugins:
    # Plugin node -- execute via plugin
    plugin = plugin_manager._workflow_node_plugins[node_type]
    if plugin.execution_mode == "local":
        await self._execute_plugin_node(
            workflow_id, node_id, plugin, params,
            edges, step_results, config,
        )
    else:
        # HPC plugin nodes -- future support
        logger.warning(f"HPC plugin nodes not yet supported: {node_type}")
```

Add _execute_plugin_node() method:
```python
async def _execute_plugin_node(
    self, workflow_id, step_id, plugin, params,
    edges, step_results, config,
):
    """Execute a plugin-provided workflow node."""
    from utils.workflow_db import update_step
    from plugins.base import WorkflowNodePlugin

    try:
        update_step(workflow_id, step_id, {"status": StepStatus.RUNNING.value})
        await _broadcast(workflow_id, {
            "type": "step_status", "step_id": step_id, "status": "running"
        })

        # Get input structure from parent nodes
        parent_ids = _get_parent_step_ids(step_id, edges)
        structure_json = ""
        for pid in parent_ids:
            if pid in step_results and "structure_json" in step_results[pid]:
                structure_json = step_results[pid]["structure_json"]
                break

        # Execute plugin
        result = await plugin.execute(structure_json, params, config.__dict__ if hasattr(config, '__dict__') else {})
        step_results[step_id] = result

        update_step(workflow_id, step_id, {
            "status": StepStatus.COMPLETED.value,
            "result_json": json.dumps(result),
        })
        await _broadcast(workflow_id, {
            "type": "step_status", "step_id": step_id, "status": "completed"
        })

    except Exception as e:
        logger.exception(f"Plugin node {step_id} ({plugin.node_type}) failed")
        update_step(workflow_id, step_id, {
            "status": StepStatus.FAILED.value,
            "error_message": str(e),
        })
        await _broadcast(workflow_id, {
            "type": "step_status", "step_id": step_id,
            "status": "failed", "error": str(e),
        })
```

### 6. Modify frontend node-definitions.ts

Append at end of file:

```typescript
/** Plugin node definitions fetched from backend */
let _plugin_nodes: Record<string, NodeDefinition> = {}

/**
 * Load plugin node definitions from the backend API.
 * Called on WorkflowEditor mount to merge plugin nodes into NODE_DEFINITIONS.
 */
export async function load_plugin_nodes(api_base: string): Promise<void> {
  try {
    const resp = await fetch(`${api_base}/plugins/workflow-nodes`)
    if (!resp.ok) return
    const data = await resp.json()
    if (!data.nodes || !Array.isArray(data.nodes)) return

    for (const def of data.nodes) {
      if (def.type && !NODE_DEFINITIONS[def.type]) {
        // Merge plugin node into the main definitions
        NODE_DEFINITIONS[def.type] = def as NodeDefinition
        _plugin_nodes[def.type] = def as NodeDefinition
      }
    }
  } catch (e) {
    console.warn(`Failed to load plugin workflow nodes:`, e)
  }
}

/** Check if a node type is from a plugin */
export function is_plugin_node(type: string): boolean {
  return type in _plugin_nodes
}
```

### 7. Modify WorkflowEditor.svelte

In the onMount or initialization logic, call load_plugin_nodes():

```typescript
import { load_plugin_nodes } from './node-definitions'
import { API_BASE } from '$lib/api/config'

onMount(async () => {
  await load_plugin_nodes(API_BASE)
  // ... existing onMount logic
})
```

Note: Since load_plugin_nodes() directly mutates the NODE_DEFINITIONS object,
on_drop()'s `NODE_DEFINITIONS[type]` check will automatically pass.

## Verification Steps

1. Backend:
   - `cd server && python -c "from plugins.base import WorkflowNodePlugin; print('ok')"`
   - POST /api/plugins/refresh
   - GET /api/plugins/workflow-nodes -> returns plugin node definition list

2. Frontend:
   - `pnpm check` with no new type errors
   - Open workflow editor, see plugin nodes in sidebar (if any plugins exist)
   - Drag in a plugin node -> should create normally (not blocked by on_drop guard)

3. End-to-end:
   - Create a simple test plugin node (echo structure, no actual computation)
   - Drag into workflow graph -> run workflow -> node executes successfully
```

---

## Prompt 4: MCP Dynamic Tool Registration

```
You are a CatGo project developer. Please implement MCP tool dynamic registration so plugins automatically become MCP tools.

## Background

CatGo's MCP server (server/mcp_server.py) defines all available tools through the TOOLS list.
Each tool maps to a FastAPI endpoint. Adding a new tool requires manually adding an entry to the TOOLS list
+ handling in handle_call_tool.

Goal: Make registered AnalyzerPlugin and ReaderPlugin automatically become MCP tools that AI assistants can directly call.

## Prerequisites

Phase 2 (AnalyzerPlugin) is complete. server/plugins/base.py has AnalyzerPlugin,
manager.py has the _analyzer_plugins registry.

## Please read the following files first

1. `server/mcp_server.py` -- Read completely, focus on:
   - TOOLS list (starting at L44): each tool is a dict:
     ```python
     {
         "name": "catgo_xxx",
         "description": "...",
         "endpoint": "/path/to/endpoint",
         "method": "POST",
         "inputSchema": { "type": "object", "properties": {...}, "required": [...] },
     }
     ```
   - handle_list_tools() (L1326-1334): iterates TOOLS to generate MCP Tool objects.
     Note _strip_structure_from_schema() -- removes "structure" property from inputSchema
     (because handle_call_tool auto-injects the current viewer's structure)
   - handle_call_tool() (L1807+):
     1. Finds tool_def in TOOLS
     2. If endpoint starts with "__special__/", calls _handle_special_tool()
     3. Otherwise: auto-injects structure -> POST/GET to FastAPI endpoint -> auto-pushes structure to viewer
     4. Returns TextContent text result
   - Key pattern: auto-inject structure (L1826-1836) + auto-push result (L1848-1870)

2. `server/plugins/manager.py` -- get_all_analyzers(), get_all_readers()

## Tasks

### 1. At mcp_server.py startup, get plugins from plugin_manager and generate TOOLS entries

After the TOOLS list definition (but before handle_list_tools), add function:

```python
def _get_plugin_tools() -> list[dict]:
    """Generate MCP tool definitions from registered plugins."""
    from plugins import plugin_manager

    plugin_tools = []

    # Analyzer plugins -> MCP tools
    for analyzer in plugin_manager._analyzer_plugins.values():
        if not analyzer._enabled:
            continue

        # Build input schema from plugin's input_schema
        # Remove "structure" from required (auto-injected)
        schema = dict(analyzer.input_schema)
        properties = dict(schema.get("properties", {}))
        required = [r for r in schema.get("required", []) if r != "structure"]
        if "structure" in properties:
            properties.pop("structure")

        plugin_tools.append({
            "name": f"catgo_plugin_{analyzer.analyzer_id}",
            "description": f"[Plugin] {analyzer.display_name}: {analyzer.description}",
            "endpoint": f"__special__/plugin_analyze/{analyzer.analyzer_id}",
            "method": "POST",
            "inputSchema": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        })

    # Reader plugins -> MCP tools (file-based, less common for MCP but possible)
    # Skip for now -- reader plugins typically need file upload, not JSON input

    return plugin_tools
```

### 2. Modify handle_list_tools() to merge plugin tools

```python
@server.list_tools()
async def handle_list_tools() -> list[Tool]:
    all_tools = TOOLS + _get_plugin_tools()
    return [
        Tool(
            name=t["name"],
            description=t["description"],
            inputSchema=_strip_structure_from_schema(t["inputSchema"]),
        )
        for t in all_tools
    ]
```

### 3. Modify handle_call_tool() to handle plugin tools

When tool_def is None (not in TOOLS), check if it's a plugin tool:

```python
@server.call_tool()
async def handle_call_tool(name: str, arguments: dict | None) -> list[TextContent]:
    arguments = arguments or {}

    # Check static TOOLS first
    all_tools = TOOLS + _get_plugin_tools()
    tool_def = next((t for t in all_tools if t["name"] == name), None)
    if not tool_def:
        return [TextContent(type="text", text=f"Unknown tool: {name}")]

    endpoint = tool_def["endpoint"]
    method = tool_def["method"]

    # Special tools
    if endpoint.startswith("__special__/"):
        return await _handle_special_tool(name, endpoint, arguments)

    # ... rest of existing logic
```

### 4. Add plugin_analyze branch in _handle_special_tool()

Add to the _handle_special_tool() function:

```python
if endpoint.startswith("__special__/plugin_analyze/"):
    analyzer_id = endpoint.split("/")[-1]

    # Auto-inject current structure
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{API_BASE}/view/structure/current")
            if resp.status_code == 200:
                arguments["structure"] = resp.json()
    except Exception:
        pass  # Continue without structure -- some analyzers might not need it

    # Call the analyzer endpoint
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{API_BASE}/plugins/{analyzer_id}/analyze",
                json=arguments,
            )
            if resp.status_code == 200:
                data = resp.json()
                result = data.get("result", {})
                output_type = data.get("output_type", "text")

                # Format result for text output
                if output_type in ("scatter_plot", "bar_plot"):
                    series = result.get("series", [])
                    summary_lines = [f"Analysis: {data.get('analyzer_id', analyzer_id)}"]
                    for s in series:
                        label = s.get("label", "Series")
                        n_points = len(s.get("x", []))
                        summary_lines.append(f"  {label}: {n_points} data points")
                        if s.get("y"):
                            y = s["y"]
                            summary_lines.append(f"    y range: [{min(y):.4f}, {max(y):.4f}]")
                    return [TextContent(type="text", text="\n".join(summary_lines))]

                elif output_type == "table":
                    columns = result.get("columns", [])
                    rows = result.get("rows", [])
                    header = " | ".join(c.get("label", c.get("key", "")) for c in columns)
                    lines = [header, "-" * len(header)]
                    for row in rows[:20]:  # Limit to 20 rows
                        vals = [str(row.get(c.get("key", ""), "")) for c in columns]
                        lines.append(" | ".join(vals))
                    if len(rows) > 20:
                        lines.append(f"... and {len(rows) - 20} more rows")
                    return [TextContent(type="text", text="\n".join(lines))]

                elif output_type == "text":
                    return [TextContent(type="text", text=result.get("content", str(result)))]

                else:
                    return [TextContent(type="text", text=json.dumps(result, indent=2))]

            else:
                return [TextContent(type="text", text=f"Analyzer failed: {resp.text[:500]}")]

    except Exception as exc:
        return [TextContent(type="text", text=f"Plugin analyzer error: {exc}")]
```

### 5. Consider MCP server startup timing

mcp_server.py is an independent process (started via CLI agent), not going through the FastAPI lifespan.
plugin_manager might not be initialized yet. Need to handle this case in _get_plugin_tools():

```python
def _get_plugin_tools() -> list[dict]:
    """Generate MCP tool definitions from registered plugins."""
    try:
        from plugins import plugin_manager
        if not plugin_manager._initialized:
            # Try to initialize synchronously (discover only, no async on_load)
            import asyncio
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    # Can't await in running loop -- return empty
                    return []
                else:
                    loop.run_until_complete(plugin_manager.initialize())
            except RuntimeError:
                return []
    except ImportError:
        return []

    # ... rest of the function
```

Or more simply: have the MCP server initialize plugins at startup (before main()):

```python
async def main():
    from plugins import plugin_manager
    await plugin_manager.initialize()

    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, ...)
```

## Verification Steps

1. Start backend, ensure the bond-histogram plugin is registered (Phase 2's example)
2. Start MCP server: `python server/mcp_server.py` -- no errors
3. Connect with Claude Code, `handle_list_tools()` should include `catgo_plugin_bond_histogram`
4. Call tool: AI says "analyze the bond length distribution of the current structure" -> triggers catgo_plugin_bond_histogram
5. MCP auto-injects current structure -> calls analysis endpoint -> returns text summary
```

---

## Prompt 5: Frontend Dynamic Tab Registration

```
You are a CatGo project developer. Please implement dynamic tab registration for the analysis panel so AnalyzerPlugins automatically appear in the frontend.

## Background

CatGo's analysis panel (AnalysisPane.svelte) has hardcoded tab_defs:
```typescript
const tab_defs: { id: AnalysisTab; label: string }[] = [
  { id: 'electronic', label: 'Electronic' },
  { id: 'md', label: 'MD' },
  { id: 'phase', label: 'Phase' },
  { id: 'structure_analysis', label: 'Structure' },
  { id: 'spectrum', label: 'Spectrum' },
]
```

Goal: Make backend-registered AnalyzerPlugins automatically added as new tabs. Clicking a tab shows a
"Run Analysis" button, and after execution, the appropriate renderer is selected based on output_type to
display the result.

## Prerequisites

Phase 2 (AnalyzerPlugin) is complete. GET /api/plugins/analyzers returns the plugin list.

## Please read the following files first

1. `src/lib/structure/AnalysisPane.svelte` -- Read completely:
   - L12: AnalysisTab type = 'electronic' | 'md' | 'phase' | 'structure_analysis' | 'spectrum'
   - L14-20: tab_defs static array
   - L40-72: props definition (including active_tab = $bindable)
   - Rendering logic: {#if active_tab === 'electronic'} ... {/if} conditional branches

2. `src/lib/plot/types.ts` -- DataSeries, BarSeries, AxisConfig types (already read in Phase 2)

3. `src/lib/api/config.ts` -- API_BASE constant
   ```typescript
   export const API_BASE = ...  // e.g., "http://localhost:8000/api"
   ```

## Tasks

### 1. Modify AnalysisTab type

Change from fixed union type to extensible:
```typescript
export type AnalysisTab = 'electronic' | 'md' | 'phase' | 'structure_analysis' | 'spectrum' | `plugin_${string}`
```

### 2. Change tab_defs from const to $state

```typescript
// Base tabs (static)
const base_tab_defs: { id: AnalysisTab; label: string }[] = [
  { id: 'electronic', label: 'Electronic' },
  { id: 'md', label: 'MD' },
  { id: 'phase', label: 'Phase' },
  { id: 'structure_analysis', label: 'Structure' },
  { id: 'spectrum', label: 'Spectrum' },
]

// Merged base + plugin tabs
let tab_defs = $state<{ id: AnalysisTab; label: string }[]>([...base_tab_defs])

// Plugin analyzer metadata cache
interface PluginAnalyzerInfo {
  analyzer_id: string
  display_name: string
  output_type: string
  input_schema: dict
}
let plugin_analyzers = $state<PluginAnalyzerInfo[]>([])
```

### 3. Load plugin analyzers in onMount

```typescript
import { onMount } from 'svelte'

onMount(async () => {
  try {
    const resp = await fetch(`${API_BASE}/plugins/analyzers`)
    if (!resp.ok) return
    const data = await resp.json()
    if (!data.analyzers) return

    plugin_analyzers = data.analyzers
    // Append plugin tabs
    const plugin_tabs = data.analyzers
      .filter((a: any) => a.enabled !== false)
      .map((a: any) => ({
        id: `plugin_${a.analyzer_id}` as AnalysisTab,
        label: a.display_name,
      }))

    tab_defs = [...base_tab_defs, ...plugin_tabs]
  } catch (e) {
    console.warn(`Failed to load plugin analyzers:`, e)
  }
})
```

### 4. Add plugin tab rendering logic

After the existing {#if active_tab === 'spectrum'} ... {/if}, add:

```svelte
{#if active_tab.startsWith('plugin_')}
  {@const analyzer_id = active_tab.slice(7)}
  {@const analyzer = plugin_analyzers.find(a => a.analyzer_id === analyzer_id)}
  {#if analyzer}
    <PluginAnalyzerTab
      {analyzer}
      {structure}
      api_base={API_BASE}
    />
  {:else}
    <p style="padding: 1em; color: var(--text-muted);">Plugin not found.</p>
  {/if}
{/if}
```

### 5. Create PluginAnalyzerTab component

Create `src/lib/structure/PluginAnalyzerTab.svelte`:

```svelte
<script lang="ts">
  import type { AnyStructure } from '$lib/structure/index'
  import ScatterPlot from '$lib/plot/ScatterPlot.svelte'
  import BarPlot from '$lib/plot/BarPlot.svelte'

  let {
    analyzer,
    structure = undefined,
    api_base = '',
  }: {
    analyzer: {
      analyzer_id: string
      display_name: string
      output_type: string
      input_schema: any
    }
    structure?: AnyStructure
    api_base: string
  } = $props()

  let loading = $state(false)
  let error = $state(``)
  let result = $state<any>(null)

  async function run_analysis() {
    if (!structure) {
      error = `No structure loaded`
      return
    }

    loading = true
    error = ``
    result = null

    try {
      const resp = await fetch(`${api_base}/plugins/${analyzer.analyzer_id}/analyze`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify({ structure }),
      })

      if (!resp.ok) {
        const detail = await resp.text()
        throw new Error(`Analysis failed: ${detail}`)
      }

      const data = await resp.json()
      result = data.result
    } catch (e: any) {
      error = e.message || `Analysis failed`
    } finally {
      loading = false
    }
  }
</script>

<div class="plugin-analyzer">
  <div class="header">
    <h4>{analyzer.display_name}</h4>
    <button onclick={run_analysis} disabled={loading || !structure}>
      {loading ? `Running...` : `Run Analysis`}
    </button>
  </div>

  {#if error}
    <p class="error">{error}</p>
  {/if}

  {#if result}
    {#if analyzer.output_type === `scatter_plot`}
      <ScatterPlot
        series={result.series}
        x_axis={result.x_axis || {}}
        y_axis={result.y_axis || {}}
      />
    {:else if analyzer.output_type === `bar_plot`}
      <BarPlot
        series={result.series}
        x_axis={result.x_axis || {}}
        y_axis={result.y_axis || {}}
      />
    {:else if analyzer.output_type === `table`}
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              {#each result.columns || [] as col}
                <th>{col.label || col.key}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each result.rows || [] as row}
              <tr>
                {#each result.columns || [] as col}
                  <td>{row[col.key] ?? ``}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if analyzer.output_type === `image`}
      <img
        src={`data:${result.mime || `image/png`};base64,${result.data}`}
        alt={analyzer.display_name}
        style="max-width: 100%; height: auto;"
      />
    {:else if analyzer.output_type === `text`}
      <pre class="text-result">{result.content || JSON.stringify(result, null, 2)}</pre>
    {:else}
      <pre>{JSON.stringify(result, null, 2)}</pre>
    {/if}
  {/if}
</div>

<style>
  .plugin-analyzer {
    padding: 0.5em;
    display: flex;
    flex-direction: column;
    gap: 0.5em;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5em;
  }
  .header h4 {
    margin: 0;
    font-size: 0.9em;
  }
  .header button {
    padding: 0.3em 0.8em;
    font-size: 0.85em;
    border-radius: 4px;
    border: 1px solid var(--border, #ccc);
    background: var(--bg-2, #f0f0f0);
    cursor: pointer;
  }
  .header button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .error {
    color: #ef4444;
    font-size: 0.85em;
    margin: 0;
  }
  .table-wrapper {
    overflow-x: auto;
    max-height: 400px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85em;
  }
  th, td {
    padding: 0.3em 0.5em;
    border: 1px solid var(--border, #ddd);
    text-align: left;
  }
  th {
    background: var(--bg-2, #f5f5f5);
    font-weight: 600;
  }
  .text-result {
    padding: 0.5em;
    background: var(--bg-2, #f5f5f5);
    border-radius: 4px;
    font-size: 0.85em;
    overflow-x: auto;
    white-space: pre-wrap;
  }
</style>
```

### 6. Notes

- ScatterPlot and BarPlot import paths:
  First check the actual component filenames in the `src/lib/plot/` directory. They may be `ScatterPlot.svelte` or other names.
  Use `ls src/lib/plot/` to confirm.

- Structure prop passing:
  AnalysisPane already receives the `structure` prop, just pass it directly to PluginAnalyzerTab.

- API_BASE import:
  AnalysisPane.svelte already has `import { API_BASE } from '$lib/api/config'` (L3).

- AnalysisPane's children snippet:
  Note that AnalysisPane uses `{@render children?.()}` to render child content.
  Structure.svelte renders specific tab content in AnalysisPane's children.
  Plugin tab rendering can be placed directly inside AnalysisPane, no need to go through children.

## Verification Steps

1. `pnpm check` -- no new type errors

2. Ensure the backend has at least one AnalyzerPlugin (Phase 2's bond-histogram)

3. Start backend + frontend:
   - `pnpm desktop:serve` (or `pnpm dev` + start backend separately)

4. Open the analysis panel (Analysis Pane):
   - Should see 5 base tabs + 1 "Bond Length Histogram" plugin tab

5. Click "Bond Length Histogram" tab:
   - Should see "Run Analysis" button
   - Load a structure, click the button
   - Should display a bar chart (BarPlot rendering)

6. Without plugins:
   - If the backend has no analysis plugins, the panel should only show 5 base tabs (no crash)

7. Network error tolerance:
   - If the backend is unreachable, the onMount fetch failure should be handled silently (only show base tabs)
```

---

## Appendix: Complete Phase Dependency Graph

```
Phase 0: Calculator disconnection fix
  | (no dependencies, can start immediately)
Phase 1: ReaderPlugin base class
  | (depends on Phase 0 to confirm base.py patterns are correct)
Phase 2: AnalyzerPlugin base class
  | (depends on Phase 1's discovery/manager patterns)
  |-> Phase 3: WorkflowNodePlugin (depends on Phase 2 completing the base.py pattern)
  |-> Phase 4: MCP dynamic registration (depends on Phase 2's AnalyzerPlugin)
  +-> Phase 5: Frontend dynamic tabs (depends on Phase 2's AnalyzerPlugin)
```

Phase 3, 4, and 5 have no interdependencies and can be implemented in parallel.
