# CatGo Unified Plugin System -- Detailed Implementation Plan

> Archived as done on 2026-03-13.
> The Phase 0-6 work described here has already been implemented and is preserved for historical reference.

## Overview

Transform CatGo from hardcoded extensions to a unified plugin architecture, ultimately supporting AI-generated tools (the self-extending-tools vision).

This document is a **directly executable implementation guide** -- containing precise file paths, code snippets, modification line numbers, and verification steps. An AI assistant should be able to independently complete each Phase's implementation after reading it.

---

### Current State

| Category | Status | Key Files | Problem |
|----------|--------|-----------|---------|
| Calculator plugins | Framework exists but is **disconnected** | `server/plugins/base.py` L179-262, `server/plugins/manager.py` L269-295 | `optimize.py` calls `calculators.base.get_calculator()` (hardcoded enum), never calls `plugin_manager.get_calculator()` |
| Analysis tools | **Hardcoded** sys.path.insert | `server/routers/dos.py` L21-23, `server/routers/cohp.py` L16-17 | DOS/COHP analysis extensions use `sys.path.insert()` imports, bypassing the plugin system |
| File reading (backend) | **Hardcoded** across 4 locations | `catgo_dos/io.py`, `catgo_cohp/io.py`, `server/routers/bands.py`, `server/routers/cube.py` | 20+ formats scattered across 4 locations; adding a new format requires modifying 5+ files |
| File reading (frontend) | **Hardcoded** large switch | `src/lib/structure/parse.ts` L2035-2197, `src/lib/trajectory/parse.ts` | 10+ structure formats + 5+ trajectory formats all in parse functions |
| Workflow nodes | **Hardcoded** static sets | `server/utils/workflow_engine.py` L34-59, `src/lib/workflow/node-definitions.ts` | `VASP_CALC_NODES`, `LOCAL_NODES` and other static sets, no dynamic extension possible |
| MCP tools | **Hardcoded** static list | `server/mcp_server.py` L44 `TOOLS: list[dict]` | All 61 tools hardcoded in one list |
| Frontend Analysis Tab | **Hardcoded** static array | `src/lib/structure/AnalysisPane.svelte` L14 `tab_defs` | 5 tabs hardcoded, no dynamic registration |

### Target Architecture

```
plugins/                            <-- User/AI-created plugins
|-- my-calculator/                  <-- CalculatorPlugin (Phase 0 fix)
|   |-- catgo-plugin.json
|   +-- plugin.py
|-- cp2k-dos-reader/                <-- ReaderPlugin (Phase 1)
|   |-- catgo-plugin.json
|   +-- plugin.py
|-- qe-bands-reader/                <-- ReaderPlugin (Phase 1)
|   |-- catgo-plugin.json
|   +-- plugin.py
|-- bond-histogram/                 <-- AnalyzerPlugin (Phase 2)
|   |-- catgo-plugin.json
|   +-- plugin.py
+-- lammps-workflow/                <-- WorkflowNodePlugin (Phase 3)
    |-- catgo-plugin.json
    +-- plugin.py

Backend automatically:
  1. Discovers + loads plugins (discovery.py -- already exists)
  2. Registers to PluginManager type-specific registries
  3. Registers REST endpoints (/api/plugins/readers/upload, /api/plugins/{name}/analyze, ...)
  4. Registers MCP tools (Phase 4)
  5. Notifies frontend of new readers/tabs/nodes (Phase 5)
```

### Unified catgo-plugin.json Manifest

All plugin types share the same manifest schema. Contribution types are declared under `catgo.backend.contributions`:

```json
{
  "name": "cp2k-dos-reader",
  "version": "1.0.0",
  "description": "Read CP2K .pdos files for DOS analysis",
  "author": "CatGo Team",
  "catgo": {
    "backend": {
      "main": "plugin.py",
      "contributions": {
        "readers": [{
          "id": "cp2k_pdos",
          "formats": [".pdos"],
          "output_type": "electronic_dos",
          "description": "CP2K projected DOS (.pdos files)"
        }],
        "analyzers": [{
          "id": "bond_histogram",
          "output_type": "bar_plot",
          "description": "Bond length distribution histogram"
        }],
        "calculators": [{
          "id": "my_calc",
          "description": "My custom calculator"
        }],
        "workflow_nodes": [{
          "type": "my_custom_node",
          "definition": {}
        }]
      }
    }
  }
}
```

### output_type Routing Table (Core Design)

Plugins declare an `output_type`, and the system automatically routes to the corresponding visualization pipeline:

| output_type | Data Contract (Python dict) | Frontend Renderer | Existing Pipeline Reference |
|-------------|---------------------------|-------------------|---------------------------|
| `structure` | `{"structure": pymatgen_dict}` | 3D Structure viewer | `parse.ts` -> `Structure.svelte` |
| `electronic_dos` | VaspData-compatible dict (see below) | DosPlot (Plotly) | `dos.py` -> `DosAnalysisPane` |
| `electronic_bands` | BandStructureSymmLine dict | BandPlot (Plotly) | `bands.py` -> `BandAnalysisPane` |
| `cohp` | COHPData dict | CohpPlot (Plotly) | `cohp.py` -> `CohpAnalysisPane` |
| `trajectory` | TrajectoryType dict | Trajectory player | `parse.ts` -> `Trajectory.svelte` |
| `volumetric` | CubeHeader + grid data | Cube pane + isosurface | `cube.py` -> `CubePane` |
| `scatter_plot` | `{"series": DataSeries[], "x_label": str, "y_label": str}` | ScatterPlot (D3) | Generic |
| `bar_plot` | `{"series": BarSeries[], "x_label": str, "y_label": str}` | BarPlot (D3) | Generic |
| `table` | `{"columns": [str], "rows": [[val, ...], ...]}` | Generic table | Generic |
| `image` | `{"data": "base64...", "mime": "image/png"}` | `<img>` | Generic |

**VaspData-compatible dict format** (required return type for `electronic_dos` output_type):
```python
{
    "eigenvalues": [[[float, ...], ...], ...],  # (nspin, nkpts, nbands)
    "kweights": [float, ...],                    # (nkpts,)
    "efermi": float,
    "projectors": [...],   # (nspin, nions, nchannels, nkpts, nbands) or None
    "positions": [[x,y,z], ...],        # Cartesian Angstrom
    "positions_frac": [[fx,fy,fz], ...], # fractional coords
    "lattice": [[...], [...]., [...]],  # 3x3 row vectors
    "elements": ["O", "Ti", ...],
    "ion_types": ["Ti", "O"],
    "ion_counts": [1, 2],
}
```

---

## Required Reading List (Organized by Phase)

### Global
| File | Key Content |
|------|------------|
| `server/plugins/__init__.py` | Public API: `BasePlugin`, `CalculatorPlugin`, `plugin_manager` |
| `server/plugins/base.py` | `BasePlugin` (L103-171), `CalculatorPlugin` (L179-270), `OptimizerPlugin` (L278-336), `PluginType` enum (L72-77) |
| `server/plugins/discovery.py` | `discover_plugins()` (L50-91), `load_plugin_from_path()` (L94-128), `_find_plugin_class()` (L208-237) |
| `server/plugins/manager.py` | `PluginManager` (L31-390): `_plugins`, `_calculator_plugins`, `_optimizer_plugins` registries; `get_calculator()` (L269-291) |
| `server/routers/plugins.py` | REST endpoints: `GET /plugins/`, `GET /plugins/calculators`, `POST /plugins/refresh` |
| `server/main.py` | `await plugin_manager.initialize()` in `lifespan()` |

### Phase 0 (Fix Calculator)
| File | Key Content |
|------|------------|
| `server/calculators/base.py` | `get_calculator()` factory function (L35-98) -- hardcoded `CalculatorType` enum |
| `server/routers/optimize.py` | `get_calculator(request.calculator, ...)` call site (L121) |
| `server/routers/optimize_ws.py` | Same as above, WebSocket route (L163) |
| `server/models/structure.py` | `CalculatorType` enum (L11-17), `OptimizerType` (L21-27) |
| `examples/plugins/lennard-jones-calculator/plugin.py` | Reference implementation (L56-115) |

### Phase 1 (Unified Reader)
| File | Key Content |
|------|------------|
| `extensions/dos-analysis/catgo_dos/io.py` | `VaspData` (L33-91), `read_vaspout_h5()` (L93-156), `read_procar()` (L284-485) |
| `server/routers/dos.py` | `upload_h5` (L149-176), `upload_procar` (L179-225), `_create_session()` (L122-146), `sys.path.insert` (L21-23) |
| `server/routers/bands.py` | `upload_band_vasprun` (L159-198), `_create_band_session()` (L201-239), pymatgen `Vasprun` dependency |
| `extensions/cohp-analysis/catgo_cohp/io.py` | `parse_cohpcar()` (L253-387), `parse_icohplist()` (L423-524) |
| `server/routers/cohp.py` | `upload_cohpcar` (L58-99), `sys.path.insert` (L16-17) |
| `server/routers/cube.py` | `upload_cube_file` (L49-60), Rust binary invocation |
| `src/lib/structure/parse.ts` | `parse_poscar` (L125), `parse_xyz` (L412), `parse_cif` (L801), `parse_lammps_data` (L1390), `parse_cp2k` (L1702), `parse_any_structure` (L2198) |
| `src/lib/structure/controllers/file-handlers.ts` | File type routing: `is_h5_file`, `try_handle_cube_file`, `handle_import_file` |
| `src/lib/trajectory/parse.ts` | `FORMAT_PATTERNS` (L48), `.traj`/`.hdf5`/XDATCAR and 5+ other formats |

### Phase 2 (Analyzer)
| File | Key Content |
|------|------------|
| `src/lib/plot/types.ts` | `DataSeries`, `AxisConfig` |
| `src/lib/electronic/` | DOS/Band/COHP frontend components |

### Phase 3 (Workflow Node)
| File | Key Content |
|------|------------|
| `src/lib/workflow/workflow-types.ts` | `NodeDefinition`, `ParamDef` |
| `src/lib/workflow/node-definitions.ts` | `NODE_DEFINITIONS` (static Record), `SOFTWARE_PERIODICITY` |
| `server/utils/workflow_engine.py` | `VASP_CALC_NODES` (L34), `LOCAL_NODES` (L43), `UNIFIED_CALC_NODES` (L40) -- node classification sets |

### Phase 4 (MCP)
| File | Key Content |
|------|------------|
| `server/mcp_server.py` | `TOOLS` list (L44), `handle_list_tools()` (L1326), `handle_call_tool()` (L1807) |

### Phase 5 (Frontend Dynamic Registration)
| File | Key Content |
|------|------------|
| `src/lib/structure/AnalysisPane.svelte` | `tab_defs` (L14), `AnalysisTab` type (L12) |
| `src/lib/electronic/DosAnalysisPane.svelte` | File upload detection |

---

## Phase 0: Fix Calculator Plugin Disconnection

### Problem Analysis

`server/routers/optimize.py` line 121 calls:
```python
calc_wrapper = get_calculator(request.calculator, request.calculator_params)
```

The `get_calculator` here is imported from `calculators.base` (line 9), which internally maintains a hardcoded `CalculatorType -> class` dictionary (`server/calculators/base.py` L41-72). It only supports the five enum values: EMT/XTB/MACE/CHGNET/M3GNET.

`PluginManager.get_calculator()` (`server/plugins/manager.py` L269-291) can correctly retrieve plugin-registered calculators, but `optimize.py` never calls it.

After a user installs the `lennard-jones-calculator` plugin, selecting "lennard_jones" as the calculator in the frontend causes a 422 validation error because the `CalculatorType` enum does not include that value.

### Modification Plan

#### Step 1: Modify `server/models/structure.py` -- Relax calculator_type to str

**File**: `server/models/structure.py`
**Location**: `CalculatorType` enum (L11-17) and `OptimizationRequest` model

**Problem**: The `OptimizationRequest.calculator` field type is `CalculatorType` (enum). FastAPI/Pydantic auto-validation only allows enum values, rejecting plugin calculator_ids.

**Modification**: Keep the `CalculatorType` enum (the frontend UI still uses it to list built-in options), but relax the `calculator` field in `OptimizationRequest`:

```python
# server/models/structure.py

# CalculatorType enum remains unchanged (L11-17)

# Find the OptimizationRequest model, modify the calculator field:
class OptimizationRequest(BaseModel):
    structure: dict
    # Before: calculator: CalculatorType = CalculatorType.EMT
    # After:
    calculator: str = "emt"  # Built-in: "emt"|"mace"|"chgnet" etc.; Plugin: any calculator_id
    calculator_params: Optional[CalculatorParams] = None
    # ... remaining fields unchanged
```

> **Note**: Search the entire `server/models/` directory for references to `request.calculator` to confirm they don't depend on the enum's `.value` attribute. In practice, `optimize.py` L121 passes `get_calculator(request.calculator, ...)` as the first argument, which needs to change from enum to string.

#### Step 2: Modify `server/calculators/base.py` -- Add plugin fallback

**File**: `server/calculators/base.py`
**Location**: `get_calculator()` function (L35-98)

Before the final `if calc_type not in calculators` branch, add a plugin_manager query:

```python
# server/calculators/base.py  L35-98

def get_calculator(
    calc_type: str,  # Before: CalculatorType, changed to str
    params: Optional[CalculatorParams] = None,
) -> BaseCalculator:
    """Factory function to get calculator instance."""
    from .emt import EMTCalculator

    calculators: dict[str, type] = {
        "emt": EMTCalculator,
    }

    # Try to import optional calculators
    try:
        from .xtb import XTBCalculator
        calculators["xtb"] = XTBCalculator
    except ImportError:
        pass

    try:
        from .mace import MACECalculator
        calculators["mace"] = MACECalculator
    except ImportError:
        pass

    try:
        from .chgnet import CHGNetCalculator
        calculators["chgnet"] = CHGNetCalculator
    except ImportError:
        pass

    try:
        from .m3gnet import M3GNetCalculator
        calculators["m3gnet"] = M3GNetCalculator
    except ImportError:
        pass

    # --- New: Try plugin-registered calculators ---
    # Normalize CalculatorType enum value or string to lowercase str
    calc_id = calc_type.value if hasattr(calc_type, 'value') else str(calc_type)

    if calc_id in calculators:
        calc_class = calculators[calc_id]
        # ... existing parameter handling logic (XTB/MACE params) unchanged ...
        if calc_id == "xtb" and params and params.xtb:
            return calc_class(method=params.xtb.method.value, ...)
        elif calc_id == "mace" and params and params.mace:
            return calc_class(model=params.mace.model, ...)
        else:
            return calc_class()

    # --- Plugin fallback ---
    try:
        from plugins import plugin_manager
        if plugin_manager.has_calculator(calc_id):
            # Return an adapter that matches the built-in BaseCalculator interface
            return _PluginCalculatorAdapter(calc_id, plugin_manager)
    except ImportError:
        pass

    available = list(calculators.keys())
    try:
        from plugins import plugin_manager
        available += [c["id"] for c in plugin_manager.get_all_calculators()]
    except Exception:
        pass
    raise ValueError(
        f"Calculator '{calc_id}' not available. Available: {available}"
    )


class _PluginCalculatorAdapter(BaseCalculator):
    """Adapts a PluginManager calculator to the built-in BaseCalculator interface."""

    def __init__(self, calc_id: str, manager):
        self._calc_id = calc_id
        self._manager = manager
        info = manager.get_calculator_info(calc_id) or {}
        self.name = info.get("display_name", calc_id)
        self.description = info.get("description", "Plugin calculator")
        self.supported_elements = info.get("supported_elements")

    def get_calculator(self, **kwargs):
        return self._manager.get_calculator(self._calc_id, **kwargs)
```

#### Step 3: Modify `server/routers/optimize.py` -- Support string calculator

**File**: `server/routers/optimize.py`
**Location**: L9, L89-106, L121

```python
# L9: Import unchanged (get_calculator signature changed, but import path is the same)
from calculators import get_calculator

# L89-106: list_calculators endpoint needs to list both built-in + plugin calculators
@router.get("/calculators")
async def list_calculators() -> dict:
    """List available calculators (built-in + plugins)."""
    calculators = {}

    # Built-in
    for calc_type in CalculatorType:
        try:
            calc = get_calculator(calc_type.value)
            calculators[calc_type.value] = {
                "available": True,
                "name": calc.name,
                "description": calc.description,
                "supported_elements": calc.supported_elements,
                "is_plugin": False,
            }
        except ValueError:
            calculators[calc_type.value] = {
                "available": False,
                "name": calc_type.value,
                "description": f"{calc_type.value} calculator not installed",
                "supported_elements": None,
                "is_plugin": False,
            }

    # Plugins
    from plugins import plugin_manager
    for calc_info in plugin_manager.get_all_calculators():
        calculators[calc_info["id"]] = {
            "available": calc_info["enabled"],
            "name": calc_info["display_name"],
            "description": calc_info["description"],
            "supported_elements": calc_info["supported_elements"],
            "is_plugin": True,
            "parameter_schema": calc_info.get("parameter_schema"),
        }

    return {"calculators": calculators}

# L121: request.calculator is now str, not an enum
# get_calculator already accepts str, no need to change the call
# But handle enum compatibility: if frontend sends "emt" instead of CalculatorType.EMT
calc_wrapper = get_calculator(request.calculator, request.calculator_params)
# Also modify L133: request.calculator.value -> request.calculator
```

#### Step 4: Apply the same changes to `server/routers/optimize_ws.py`

**File**: `server/routers/optimize_ws.py`
**Location**: L13, L163-164

```python
# L13: Import unchanged
from calculators import get_calculator

# L163-164: request.calculator is already str
calc_wrapper = get_calculator(
    self.request.calculator, self.request.calculator_params
)
# Confirm there are no .value calls
```

### Verification Steps

```bash
# 1. Confirm the LJ plugin directory exists in examples
ls examples/plugins/lennard-jones-calculator/

# 2. Copy to plugins/ directory
mkdir -p plugins
cp -r examples/plugins/lennard-jones-calculator plugins/

# 3. Restart backend
# (in conda environment)
python server/main.py
# Should see: "[Server] Plugin manager initialized"
# Should see: "Loaded plugin: lennard-jones from .../plugins/lennard-jones-calculator"
# Should see: "Registered calculator: lennard_jones"

# 4. Check calculator list (built-in + plugins)
curl http://localhost:8000/api/optimize/calculators | python -m json.tool
# Should contain:
# "lennard_jones": {"available": true, "name": "Lennard-Jones", "is_plugin": true, ...}

# 5. Optimize with plugin calculator (He dimer)
curl -X POST http://localhost:8000/api/optimize/structure \
  -H "Content-Type: application/json" \
  -d '{
    "structure": {
      "lattice": {"matrix": [[10,0,0],[0,10,0],[0,0,10]], "pbc": [false,false,false]},
      "sites": [
        {"species": [{"element": "He", "occu": 1}], "xyz": [0,0,0], "abc": [0,0,0]},
        {"species": [{"element": "He", "occu": 1}], "xyz": [3,0,0], "abc": [0.3,0,0]}
      ]
    },
    "calculator": "lennard_jones",
    "fmax": 0.05,
    "max_steps": 50
  }'
# Should return {"success": true, "optimized_structure": {...}, ...}

# 6. Confirm built-in calculators are unaffected
curl -X POST http://localhost:8000/api/optimize/structure \
  -H "Content-Type: application/json" \
  -d '{"structure": {...Cu atoms...}, "calculator": "emt", "fmax": 0.05}'
# Should work normally

# 7. pnpm check to confirm no frontend type regressions
pnpm check
```

### Notes

- Keep the `CalculatorType` enum -- the frontend `OptimizationPane.svelte` uses it to render select options. The frontend needs to dynamically fetch the complete list (including plugins) from `/api/optimize/calculators`, but that is Phase 5 (frontend dynamic UI) work. Phase 0 only ensures the backend works.
- `optimize_ws.py` `CalculatorType` references also need to be changed for str compatibility. Search for `CalculatorType` to confirm all reference points.

---

## Phase 1: Unified ReaderPlugin Interface

### Problem Analysis

CatGo's current file reading capabilities are scattered across 4 independent systems:

**Backend Python readers**:
1. **DOS**: `extensions/dos-analysis/catgo_dos/io.py` -- `read_vaspout_h5()` (L93), `read_procar()` (L284)
2. **COHP**: `extensions/cohp-analysis/catgo_cohp/io.py` -- `parse_cohpcar()` (L253), `parse_icohplist()` (L423)
3. **Bands**: `server/routers/bands.py` -- pymatgen `Vasprun()` (L186) -> `get_band_structure()` (L187)
4. **Cube**: `server/routers/cube.py` -- Rust binary `cube-processor` (L28)

**Frontend JS readers**:
5. **Structure**: `src/lib/structure/parse.ts` -- `parse_poscar` (L125), `parse_xyz` (L412), `parse_cif` (L801), `parse_lammps_data` (L1390), `parse_cp2k` (L1702), `parse_optimade_json` (L2236)
6. **Trajectory**: `src/lib/trajectory/parse.ts` -- ASE .traj, HDF5, XDATCAR, multi-frame XYZ

**Problems**:
- Adding a new format (e.g., CP2K .pdos) requires: modifying io.py, adding an endpoint in dos.py, adding file type detection in the frontend -- at least 5 files
- Backend readers use `sys.path.insert()` to hardcode import paths for extension packages
- Different format upload endpoints have inconsistent interfaces (DOS uses `POST /dos/upload`, Bands uses `POST /bands/upload`, COHP uses `POST /cohp/upload-cohpcar`)

### Design Goals

1. **Unified ReaderPlugin base class** -- declares format + output type
2. **Unified upload endpoint** -- `POST /api/plugins/readers/upload` with auto-routing
3. **Backward compatible** -- existing dedicated endpoints unchanged, new endpoint runs in parallel
4. **Built-in readers also use the plugin system** -- wrap existing DOS/COHP/Bands readers as built-in ReaderPlugins

### Step 1: Extend `PluginType` Enum and Base Class

**File**: `server/plugins/base.py`

Add new types to the `PluginType` enum (L72-77):

```python
class PluginType(str, Enum):
    CALCULATOR = "calculator"
    OPTIMIZER = "optimizer"
    READER = "reader"          # New
    ANALYZER = "analyzer"      # New (Phase 2)
    WORKFLOW_NODE = "workflow_node"  # New (Phase 3)
    ROUTER = "router"
```

Add the `ReaderPlugin` base class at the end of the file (after L337):

```python
# =============================================================================
# Reader Plugin
# =============================================================================


class ReaderPlugin(BasePlugin):
    """
    Base class for file reader plugins.

    Reader plugins declare which file formats they support and what type of
    data they produce (output_type). The system automatically routes uploaded
    files to the appropriate reader and then to the correct visualization
    pipeline.

    Example:
        class CP2KDosReader(ReaderPlugin):
            name = "cp2k-dos-reader"
            reader_id = "cp2k_pdos"
            display_name = "CP2K DOS Reader"
            description = "Reads CP2K .pdos files"
            version = "1.0.0"
            author = "CatGo Team"
            supported_formats = [".pdos"]
            output_type = "electronic_dos"

            async def read(self, file_paths, options={}):
                # parse files and return VaspData-compatible dict
                ...
    """

    # Reader-specific attributes
    reader_id: str = ""               # Unique identifier
    supported_formats: list[str] = [] # File extensions, e.g. [".pdos", ".PDOS"]
    output_type: str = ""             # "electronic_dos" | "electronic_bands" | "cohp" | "structure" | "trajectory" | "volumetric"
    multi_file: bool = False          # True if reader needs multiple files (e.g., PROCAR+OUTCAR+POSCAR)
    required_files: list[str] = []    # e.g. ["PROCAR"] (optional hint)
    optional_files: list[str] = []    # e.g. ["OUTCAR", "POSCAR"]

    @abstractmethod
    async def read(self, file_paths: list[str], options: dict | None = None) -> dict:
        """Read files and return data conforming to output_type contract.

        Args:
            file_paths: List of absolute paths to uploaded files.
            options: Optional parameters (e.g., efermi, sigma).

        Returns:
            Dict conforming to the output_type data contract.
            See module docstring for each output_type's expected format.

        Raises:
            ValueError: If files cannot be parsed.
            FileNotFoundError: If required files are missing.
        """
        ...

    def detect_files(self, filenames: list[str]) -> bool:
        """Check if this reader can handle the given set of files.

        Default: matches if ANY filename has a supported extension.
        Override for multi-file readers that need specific combinations.
        """
        for fn in filenames:
            lower = fn.lower()
            for ext in self.supported_formats:
                if lower.endswith(ext.lower()):
                    return True
        return False

    def priority_score(self, filenames: list[str]) -> int:
        """Return match priority (higher = better match).

        Used when multiple readers claim to handle the same files.
        Default: number of matching files.
        """
        score = 0
        for fn in filenames:
            lower = fn.lower()
            for ext in self.supported_formats:
                if lower.endswith(ext.lower()):
                    score += 1
        return score

    @classmethod
    def validate(cls) -> list[str]:
        errors = super().validate()
        if not hasattr(cls, "reader_id") or not cls.reader_id:
            errors.append("Missing required attribute: reader_id")
        if not hasattr(cls, "supported_formats") or not cls.supported_formats:
            errors.append("Missing required attribute: supported_formats")
        if not hasattr(cls, "output_type") or not cls.output_type:
            errors.append("Missing required attribute: output_type")
        valid_types = {
            "electronic_dos", "electronic_bands", "cohp",
            "structure", "trajectory", "volumetric",
            "scatter_plot", "bar_plot", "table", "image",
        }
        if hasattr(cls, "output_type") and cls.output_type and cls.output_type not in valid_types:
            errors.append(f"Invalid output_type '{cls.output_type}'. Must be one of: {valid_types}")
        return errors

    def get_metadata(self) -> PluginMetadata:
        meta = super().get_metadata()
        meta.extra["reader_id"] = self.reader_id
        meta.extra["supported_formats"] = self.supported_formats
        meta.extra["output_type"] = self.output_type
        meta.extra["multi_file"] = self.multi_file
        return meta
```

**Sync updates**:
- Add `ReaderPlugin` branch to `BasePlugin.get_plugin_type()` (L126-134) in `server/plugins/base.py`
- Add `"ReaderPlugin"` to `__all__` in `server/plugins/__init__.py`

### Step 2: Extend PluginManager to Support Readers

**File**: `server/plugins/manager.py`

Add reader registry to `__init__` (L48-53):

```python
def __init__(self):
    self._plugins: dict[str, BasePlugin] = {}
    self._calculator_plugins: dict[str, CalculatorPlugin] = {}
    self._optimizer_plugins: dict[str, OptimizerPlugin] = {}
    self._reader_plugins: dict[str, ReaderPlugin] = {}  # New
    self._initialized = False
    self._plugins_dir: Optional[Path] = None
```

Add reader branch to `_register_plugin()` (L121-149):

```python
async def _register_plugin(self, plugin: BasePlugin) -> None:
    self._plugins[plugin.name] = plugin

    if isinstance(plugin, CalculatorPlugin):
        # ... existing code ...

    elif isinstance(plugin, OptimizerPlugin):
        # ... existing code ...

    elif isinstance(plugin, ReaderPlugin):  # New
        if plugin.reader_id in self._reader_plugins:
            logger.warning(
                f"Reader ID '{plugin.reader_id}' already registered, "
                f"overwriting with plugin '{plugin.name}'"
            )
        self._reader_plugins[plugin.reader_id] = plugin
        logger.info(
            f"Registered reader: {plugin.reader_id} "
            f"(formats={plugin.supported_formats}, output_type={plugin.output_type})"
        )

    # Call plugin's on_load hook
    try:
        await plugin.on_load()
    except Exception as e:
        logger.exception(f"Error in plugin {plugin.name} on_load: {e}")
```

Add Reader query methods (after Optimizer Methods):

```python
# =========================================================================
# Reader Methods
# =========================================================================

def find_reader_for_files(self, filenames: list[str]) -> Optional["ReaderPlugin"]:
    """Find the best matching reader for a set of filenames.

    Returns the reader with the highest priority_score, or None.
    """
    from .base import ReaderPlugin

    best_reader: Optional[ReaderPlugin] = None
    best_score = 0

    for reader in self._reader_plugins.values():
        if not reader._enabled:
            continue
        if reader.detect_files(filenames):
            score = reader.priority_score(filenames)
            if score > best_score:
                best_score = score
                best_reader = reader

    return best_reader

def get_reader(self, reader_id: str) -> "ReaderPlugin":
    """Get a specific reader by ID."""
    from .base import ReaderPlugin

    if reader_id not in self._reader_plugins:
        raise PluginError(f"Reader not found: {reader_id}")
    reader = self._reader_plugins[reader_id]
    if not reader._enabled:
        raise PluginError(f"Reader plugin is disabled: {reader_id}")
    return reader

def has_reader(self, reader_id: str) -> bool:
    return reader_id in self._reader_plugins

def get_all_readers(self) -> list[dict]:
    """Get information about all registered reader plugins."""
    return [
        {
            "reader_id": p.reader_id,
            "name": p.name,
            "display_name": p.display_name,
            "description": p.description,
            "formats": p.supported_formats,
            "output_type": p.output_type,
            "multi_file": p.multi_file,
            "enabled": p._enabled,
        }
        for p in self._reader_plugins.values()
    ]
```

**Sync update**: `discovery.py`'s `_find_plugin_class()` (L208-237) needs `ReaderPlugin` added to the `issubclass` check:

```python
# server/plugins/discovery.py L225
if issubclass(obj, (CalculatorPlugin, OptimizerPlugin, ReaderPlugin)):
    plugin_classes.append(obj)
```

### Step 3: Add Generic Reader Upload Endpoint

**File**: `server/routers/plugins.py`

Add after existing endpoints:

```python
from fastapi import UploadFile, File, Form
from typing import Optional
import tempfile
import shutil


@router.get("/readers")
async def list_readers():
    """List all registered reader plugins."""
    readers = plugin_manager.get_all_readers()
    return {"readers": readers, "total": len(readers)}


@router.post("/readers/upload")
async def upload_to_reader(
    files: list[UploadFile] = File(...),
    reader_id: Optional[str] = Form(None),
    options: Optional[str] = Form(None),  # JSON string
):
    """Upload files and route to the appropriate reader plugin.

    If reader_id is provided, uses that specific reader.
    Otherwise, auto-detects based on file extensions.

    Returns:
        {
            "reader_id": "cp2k_pdos",
            "output_type": "electronic_dos",
            "data": { ... output_type-specific data ... },
            "session_id": "..." (for DOS/Band/COHP that create sessions)
        }
    """
    import json

    filenames = [f.filename or "unknown" for f in files]
    opts = json.loads(options) if options else {}

    # Find reader
    if reader_id:
        try:
            reader = plugin_manager.get_reader(reader_id)
        except PluginError as e:
            raise HTTPException(status_code=404, detail=str(e))
    else:
        reader = plugin_manager.find_reader_for_files(filenames)
        if not reader:
            raise HTTPException(
                status_code=400,
                detail=f"No reader found for files: {filenames}. "
                f"Available readers: {[r['reader_id'] for r in plugin_manager.get_all_readers()]}"
            )

    # Save files to temp directory
    tmp_dir = Path(tempfile.mkdtemp(prefix="catgo_reader_"))
    tmp_paths = []
    try:
        for f in files:
            fname = f.filename or "unknown"
            tmp_path = tmp_dir / fname
            with open(tmp_path, "wb") as out:
                shutil.copyfileobj(f.file, out)
            tmp_paths.append(str(tmp_path))

        # Call reader
        try:
            result = await reader.read(tmp_paths, opts)
        except Exception as e:
            logger.exception(f"Reader {reader.reader_id} failed")
            raise HTTPException(status_code=400, detail=f"Reader failed: {e}")

        # Route based on output_type
        response = {
            "reader_id": reader.reader_id,
            "output_type": reader.output_type,
        }

        if reader.output_type == "electronic_dos":
            # Create a DOS session for the existing compute pipeline
            session_resp = _create_dos_session_from_reader(result)
            response["session_id"] = session_resp["session_id"]
            response["data"] = session_resp

        elif reader.output_type == "electronic_bands":
            session_resp = _create_bands_session_from_reader(result)
            response["session_id"] = session_resp["session_id"]
            response["data"] = session_resp

        elif reader.output_type == "cohp":
            session_resp = _create_cohp_session_from_reader(result)
            response["session_id"] = session_resp["session_id"]
            response["data"] = session_resp

        elif reader.output_type == "structure":
            response["data"] = result

        else:
            # scatter_plot, bar_plot, table, image, etc.
            response["data"] = result

        return response

    finally:
        # Cleanup temp files
        shutil.rmtree(tmp_dir, ignore_errors=True)
```

**Session creation helper functions** (same file):

```python
def _create_dos_session_from_reader(reader_result: dict) -> dict:
    """Convert reader output to a DOS session (reuses the existing dos.py session mechanism)."""
    import numpy as np
    # Lazy imports to avoid circular dependencies
    import sys
    from pathlib import Path
    _ext_dir = Path(__file__).resolve().parent.parent.parent / "extensions" / "dos-analysis"
    if str(_ext_dir) not in sys.path:
        sys.path.insert(0, str(_ext_dir))
    from catgo_dos.io import VaspData

    # Construct VaspData from reader dict
    eigenvalues = np.array(reader_result["eigenvalues"])
    kweights = np.array(reader_result["kweights"])
    projectors = np.array(reader_result["projectors"]) if reader_result.get("projectors") is not None else np.zeros((1, 1, 1, 1, 1))
    positions = np.array(reader_result.get("positions", [[0,0,0]]))
    positions_frac = np.array(reader_result.get("positions_frac", positions))
    lattice = np.array(reader_result.get("lattice", np.eye(3) * 10))
    elements = np.array(reader_result["elements"], dtype=object)

    # ion_types / ion_counts
    from collections import Counter
    elem_list = list(reader_result["elements"])
    ion_counter = Counter(elem_list)
    # Maintain POSCAR order (order of appearance)
    seen = []
    for e in elem_list:
        if e not in seen:
            seen.append(e)
    ion_types = seen
    ion_counts = [ion_counter[t] for t in ion_types]

    data = VaspData(
        eigenvalues=eigenvalues,
        kweights=kweights,
        efermi=float(reader_result.get("efermi", 0.0)),
        projectors=projectors,
        positions=positions,
        positions_frac=positions_frac,
        lattice=lattice,
        elements=elements,
        ion_types=ion_types,
        ion_counts=ion_counts,
    )

    # Reuse dos.py's _create_session
    from routers.dos import _create_session
    upload_resp = _create_session(data, source="plugin")

    return {
        "session_id": upload_resp.session_id,
        "nions": upload_resp.nions,
        "nkpts": upload_resp.nkpts,
        "nbands": upload_resp.nbands,
        "nspin": upload_resp.nspin,
        "elements": upload_resp.elements,
        "efermi": upload_resp.efermi,
        "structure": upload_resp.structure,
    }
```

### Step 4: Wrap Existing Readers as Built-in ReaderPlugins

Create `server/plugins/builtin_readers.py` -- wraps existing DOS/COHP/Band readers as ReaderPlugins, auto-registered during PluginManager initialization.

```python
"""Built-in readers wrapped as ReaderPlugin for the unified reader system.

These are NOT external plugins in the plugins/ directory. They are registered
programmatically during PluginManager.initialize() to allow the unified
/api/plugins/readers/upload endpoint to route to existing reading code.
"""

import logging
from pathlib import Path
from typing import Optional

from .base import ReaderPlugin

logger = logging.getLogger(__name__)


class VaspoutH5Reader(ReaderPlugin):
    """Read VASP vaspout.h5 for DOS analysis."""

    name = "builtin-vaspout-h5"
    reader_id = "vaspout_h5"
    display_name = "VASP vaspout.h5"
    description = "Read vaspout.h5 HDF5 file for DOS analysis (VASP >= 6.4)"
    version = "1.0.0"
    author = "CatGo (builtin)"
    supported_formats = [".h5", ".hdf5"]
    output_type = "electronic_dos"

    async def read(self, file_paths, options=None):
        import sys
        _ext = Path(__file__).resolve().parent.parent.parent / "extensions" / "dos-analysis"
        if str(_ext) not in sys.path:
            sys.path.insert(0, str(_ext))
        from catgo_dos.io import read_vaspout_h5

        h5_path = None
        for p in file_paths:
            if p.lower().endswith((".h5", ".hdf5")):
                h5_path = p
                break
        if not h5_path:
            raise ValueError("No .h5/.hdf5 file found in uploads")

        data = read_vaspout_h5(h5_path)
        return _vaspdata_to_dict(data)


class ProcarReader(ReaderPlugin):
    """Read VASP PROCAR + OUTCAR + POSCAR for DOS analysis."""

    name = "builtin-procar"
    reader_id = "vasp_procar"
    display_name = "VASP PROCAR"
    description = "Read PROCAR (+ OUTCAR for E_f, POSCAR for structure) for DOS analysis"
    version = "1.0.0"
    author = "CatGo (builtin)"
    supported_formats = ["PROCAR"]
    output_type = "electronic_dos"
    multi_file = True
    required_files = ["PROCAR"]
    optional_files = ["OUTCAR", "POSCAR", "CONTCAR"]

    def detect_files(self, filenames):
        return any("PROCAR" in fn.upper() for fn in filenames)

    async def read(self, file_paths, options=None):
        import sys
        _ext = Path(__file__).resolve().parent.parent.parent / "extensions" / "dos-analysis"
        if str(_ext) not in sys.path:
            sys.path.insert(0, str(_ext))
        from catgo_dos.io import read_procar, extract_efermi_outcar

        opts = options or {}
        procar_text = outcar_text = poscar_text = None

        for p in file_paths:
            name = Path(p).name.upper()
            content = Path(p).read_text(errors="replace")
            if "PROCAR" in name:
                procar_text = content
            elif "OUTCAR" in name:
                outcar_text = content
            elif name in ("POSCAR", "CONTCAR"):
                poscar_text = content

        if not procar_text:
            raise ValueError("PROCAR file not found")

        efermi = opts.get("efermi", 0.0)
        if outcar_text and efermi == 0.0:
            try:
                efermi = extract_efermi_outcar(outcar_text)
            except ValueError:
                pass

        data = read_procar(procar_text, efermi=efermi, poscar_text=poscar_text)
        return _vaspdata_to_dict(data)


class VasprunBandReader(ReaderPlugin):
    """Read vasprun.xml for band structure analysis."""

    name = "builtin-vasprun-bands"
    reader_id = "vasprun_bands"
    display_name = "VASP Band Structure"
    description = "Read vasprun.xml for band structure analysis"
    version = "1.0.0"
    author = "CatGo (builtin)"
    supported_formats = [".xml"]
    output_type = "electronic_bands"

    async def read(self, file_paths, options=None):
        from pymatgen.io.vasp import Vasprun

        xml_path = kpoints_path = None
        for p in file_paths:
            name = Path(p).name.upper()
            if name.endswith(".XML") or "VASPRUN" in name:
                xml_path = p
            elif "KPOINTS" in name:
                kpoints_path = p

        if not xml_path:
            raise ValueError("vasprun.xml not found")

        vr = Vasprun(
            xml_path,
            parse_projected_eigen=True,
            parse_potcar_file=False,
            exception_on_bad_xml=False,
        )
        bs = vr.get_band_structure(kpoints_filename=kpoints_path, line_mode=True)

        # Return pymatgen objects for the existing bands pipeline
        return {"_vasprun": vr, "_bandstructure": bs}


class CohpcarReader(ReaderPlugin):
    """Read COHPCAR.lobster for COHP analysis."""

    name = "builtin-cohpcar"
    reader_id = "lobster_cohp"
    display_name = "LOBSTER COHP"
    description = "Read COHPCAR.lobster for COHP analysis"
    version = "1.0.0"
    author = "CatGo (builtin)"
    supported_formats = [".lobster", "COHPCAR"]
    output_type = "cohp"

    def detect_files(self, filenames):
        return any("COHPCAR" in fn.upper() or fn.endswith(".lobster") for fn in filenames)

    async def read(self, file_paths, options=None):
        import sys
        _ext = Path(__file__).resolve().parent.parent.parent / "extensions" / "cohp-analysis"
        if str(_ext) not in sys.path:
            sys.path.insert(0, str(_ext))
        from catgo_cohp.io import parse_cohpcar

        cohp_path = None
        for p in file_paths:
            if "COHPCAR" in Path(p).name.upper() or p.endswith(".lobster"):
                cohp_path = p
                break

        if not cohp_path:
            raise ValueError("COHPCAR.lobster file not found")

        data = parse_cohpcar(cohp_path)
        return {"_cohp_data": data}


def _vaspdata_to_dict(data) -> dict:
    """Convert VaspData to the universal reader dict format."""
    import numpy as np
    return {
        "eigenvalues": data.eigenvalues.tolist(),
        "kweights": data.kweights.tolist(),
        "efermi": float(data.efermi),
        "projectors": data.projectors.tolist(),
        "positions": data.positions.tolist(),
        "positions_frac": data.positions_frac.tolist(),
        "lattice": data.lattice.tolist(),
        "elements": [str(e) for e in data.elements],
        "ion_types": data.ion_types,
        "ion_counts": data.ion_counts,
    }


# All builtin readers to register
BUILTIN_READERS = [
    VaspoutH5Reader,
    ProcarReader,
    VasprunBandReader,
    CohpcarReader,
]
```

**Register builtin readers** -- modify `server/plugins/manager.py`:

```python
# In the initialize() method (L62-86), after discover_plugins():
async def initialize(self, plugins_dir=None):
    # ... existing code ...
    await self.discover_plugins()

    # Register built-in reader plugins
    await self._register_builtin_readers()

    self._initialized = True
    logger.info(
        f"PluginManager initialized: {len(self._plugins)} plugins, "
        f"{len(self._calculator_plugins)} calculators, "
        f"{len(self._optimizer_plugins)} optimizers, "
        f"{len(self._reader_plugins)} readers"
    )

async def _register_builtin_readers(self):
    """Register built-in readers as ReaderPlugin instances."""
    try:
        from .builtin_readers import BUILTIN_READERS
        for reader_cls in BUILTIN_READERS:
            try:
                instance = reader_cls()
                instance._path = Path(__file__).parent
                await self._register_plugin(instance)
            except Exception as e:
                logger.warning(f"Failed to register builtin reader {reader_cls.__name__}: {e}")
    except ImportError as e:
        logger.warning(f"Could not import builtin_readers: {e}")
```

### Step 5: Create the First External Reader Plugin: CP2K DOS

**Directory**: `plugins/cp2k-dos-reader/`

**`plugins/cp2k-dos-reader/catgo-plugin.json`**:
```json
{
  "name": "cp2k-dos-reader",
  "version": "1.0.0",
  "description": "Read CP2K .pdos files for DOS analysis",
  "author": "CatGo Team",
  "catgo": {
    "backend": {
      "main": "plugin.py",
      "contributions": {
        "readers": [{
          "id": "cp2k_pdos",
          "formats": [".pdos"],
          "output_type": "electronic_dos",
          "description": "CP2K projected DOS (.pdos files)"
        }]
      }
    }
  }
}
```

**`plugins/cp2k-dos-reader/plugin.py`**:
```python
"""CP2K .pdos file reader for CatGo DOS analysis.

CP2K writes per-atom projected DOS files named like:
  MoS2-k1-1.pdos  (kind 1 = Mo, atom 1)
  MoS2-k2-1.pdos  (kind 2 = S, atom 1)

Format:
  Line 1: # Projected DOS for atomic kind Mo atom 1
  Line 2: # MO Eigenvalue [a.u.] Occupation  s  py  pz  px  ...
  Lines 3+: data
"""

import numpy as np
from pathlib import Path

# Import base class -- plugin manager adds server/ to sys.path
from plugins.base import ReaderPlugin

HARTREE_TO_EV = 27.211386245988


class CP2KDosReader(ReaderPlugin):
    name = "cp2k-dos-reader"
    display_name = "CP2K DOS Reader"
    description = "Reads CP2K .pdos files for projected density of states analysis"
    version = "1.0.0"
    author = "CatGo Team"

    reader_id = "cp2k_pdos"
    supported_formats = [".pdos"]
    output_type = "electronic_dos"
    multi_file = True  # usually one .pdos per atom kind

    async def read(self, file_paths, options=None):
        options = options or {}
        all_eigenvalues = []
        all_projectors = []
        elements = []

        for path in sorted(file_paths):
            if not path.lower().endswith(".pdos"):
                continue
            atom_data = self._parse_pdos_file(path)
            if atom_data:
                all_eigenvalues.append(atom_data["eigenvalues"])
                all_projectors.append(atom_data["projectors"])
                elements.append(atom_data["element"])

        if not all_eigenvalues:
            raise ValueError("No valid .pdos files found")

        eigenvalues = all_eigenvalues[0]  # All atoms share the same eigenvalue grid
        nbands = len(eigenvalues)
        nkpts = 1
        nspin = 1
        nions = len(elements)

        max_channels = max(p.shape[0] for p in all_projectors)
        proj_array = np.zeros((nspin, nions, max_channels, nkpts, nbands))
        for i, proj in enumerate(all_projectors):
            nch = proj.shape[0]
            proj_array[0, i, :nch, 0, :] = proj

        efermi = float(options.get("efermi", 0.0))

        return {
            "eigenvalues": [[[float(e) for e in eigenvalues]]],
            "kweights": [1.0],
            "efermi": efermi,
            "projectors": proj_array.tolist(),
            "positions": [[0.0, 0.0, 0.0]] * nions,
            "positions_frac": [[0.0, 0.0, 0.0]] * nions,
            "lattice": [[10, 0, 0], [0, 10, 0], [0, 0, 10]],
            "elements": elements,
            "ion_types": list(dict.fromkeys(elements)),
            "ion_counts": [elements.count(t) for t in dict.fromkeys(elements)],
        }

    def _parse_pdos_file(self, path):
        lines = Path(path).read_text().strip().split("\n")
        if len(lines) < 3:
            return None

        header = lines[0]
        element = "X"
        if "kind" in header:
            parts = header.split("kind")[-1].strip().split()
            if parts:
                element = parts[0]

        eigenvalues = []
        projectors = []
        for line in lines[2:]:
            if line.startswith("#") or not line.strip():
                continue
            parts = line.split()
            if len(parts) < 4:
                continue
            eigenvalues.append(float(parts[1]) * HARTREE_TO_EV)
            projectors.append([float(x) for x in parts[3:]])

        if not eigenvalues:
            return None

        return {
            "element": element,
            "eigenvalues": np.array(eigenvalues),
            "projectors": np.array(projectors).T,
        }
```

### Verification Steps

```bash
# 1. Ensure builtin readers are registered
python -c "
import asyncio
import sys; sys.path.insert(0, 'server')
from plugins import plugin_manager
asyncio.run(plugin_manager.initialize())
readers = plugin_manager.get_all_readers()
print(f'Registered {len(readers)} readers:')
for r in readers:
    print(f'  {r[\"reader_id\"]}: {r[\"formats\"]} -> {r[\"output_type\"]}')
"
# Expected output:
# Registered 5 readers:
#   vaspout_h5: ['.h5', '.hdf5'] -> electronic_dos
#   vasp_procar: ['PROCAR'] -> electronic_dos
#   vasprun_bands: ['.xml'] -> electronic_bands
#   lobster_cohp: ['.lobster', 'COHPCAR'] -> cohp
#   cp2k_pdos: ['.pdos'] -> electronic_dos

# 2. Start backend, check reader list
curl http://localhost:8000/api/plugins/readers | python -m json.tool

# 3. Test unified upload endpoint (using an existing vaspout.h5)
curl -X POST http://localhost:8000/api/plugins/readers/upload \
  -F "files=@test_data/vaspout.h5"
# Should return: {"reader_id": "vaspout_h5", "output_type": "electronic_dos", "session_id": "...", ...}

# 4. Confirm existing endpoints are unaffected
curl -X POST http://localhost:8000/api/dos/upload -F "file=@test_data/vaspout.h5"
# Should work normally

# 5. pnpm check
pnpm check
```

---

## Phase 2: AnalyzerPlugin Base Class

### Design

AnalyzerPlugin receives input data (structures, session data, etc.), performs analysis, and returns visualization data.

### Step 1: Add AnalyzerPlugin Base Class

**File**: `server/plugins/base.py` (append after ReaderPlugin)

```python
# =============================================================================
# Analyzer Plugin
# =============================================================================


class AnalyzerPlugin(BasePlugin):
    """
    Base class for analyzer plugins.

    Analyzer plugins accept structured input (e.g., a pymatgen structure dict),
    run some computation, and return data conforming to an output_type.

    Example:
        class BondHistogram(AnalyzerPlugin):
            name = "bond-histogram"
            analyzer_id = "bond_length_histogram"
            display_name = "Bond Length Histogram"
            description = "Distribution of bond lengths"
            version = "1.0.0"
            author = "CatGo Team"
            output_type = "bar_plot"
            input_schema = {
                "type": "object",
                "properties": {
                    "structure": {"type": "object"},
                    "cutoff": {"type": "number", "default": 3.0}
                },
                "required": ["structure"]
            }

            async def analyze(self, input_data):
                struct = Structure.from_dict(input_data["structure"])
                ...
                return {"series": [...], "x_label": "Distance", "y_label": "Count"}
    """

    analyzer_id: str = ""
    input_schema: dict = {}    # JSON Schema for validation + UI generation
    output_type: str = "table" # scatter_plot | bar_plot | table | image | ...

    @abstractmethod
    async def analyze(self, input_data: dict) -> dict:
        """Execute analysis and return results.

        Args:
            input_data: Dict validated against input_schema.

        Returns:
            Dict conforming to output_type data contract.
        """
        ...

    @classmethod
    def validate(cls) -> list[str]:
        errors = super().validate()
        if not hasattr(cls, "analyzer_id") or not cls.analyzer_id:
            errors.append("Missing required attribute: analyzer_id")
        if not hasattr(cls, "output_type") or not cls.output_type:
            errors.append("Missing required attribute: output_type")
        return errors

    def get_metadata(self) -> PluginMetadata:
        meta = super().get_metadata()
        meta.extra["analyzer_id"] = self.analyzer_id
        meta.extra["output_type"] = self.output_type
        meta.extra["input_schema"] = self.input_schema
        return meta
```

### Step 2: Extend PluginManager

**File**: `server/plugins/manager.py`

```python
# Add to __init__:
self._analyzer_plugins: dict[str, AnalyzerPlugin] = {}

# Add to _register_plugin:
elif isinstance(plugin, AnalyzerPlugin):
    if plugin.analyzer_id in self._analyzer_plugins:
        logger.warning(f"Analyzer ID '{plugin.analyzer_id}' already registered")
    self._analyzer_plugins[plugin.analyzer_id] = plugin
    logger.info(f"Registered analyzer: {plugin.analyzer_id}")

# Add methods:
def get_analyzer(self, analyzer_id: str) -> "AnalyzerPlugin":
    if analyzer_id not in self._analyzer_plugins:
        raise PluginError(f"Analyzer not found: {analyzer_id}")
    plugin = self._analyzer_plugins[analyzer_id]
    if not plugin._enabled:
        raise PluginError(f"Analyzer plugin is disabled: {analyzer_id}")
    return plugin

def has_analyzer(self, analyzer_id: str) -> bool:
    return analyzer_id in self._analyzer_plugins

def get_all_analyzers(self) -> list[dict]:
    return [
        {
            "analyzer_id": p.analyzer_id,
            "name": p.name,
            "display_name": p.display_name,
            "description": p.description,
            "output_type": p.output_type,
            "input_schema": p.input_schema,
            "enabled": p._enabled,
        }
        for p in self._analyzer_plugins.values()
    ]
```

### Step 3: Add Generic Analysis Endpoint

**File**: `server/routers/plugins.py`

```python
@router.get("/analyzers")
async def list_analyzers():
    """List all registered analyzer plugins."""
    analyzers = plugin_manager.get_all_analyzers()
    return {"analyzers": analyzers, "total": len(analyzers)}


@router.post("/analyzers/{analyzer_id}/run")
async def run_analyzer(analyzer_id: str, input_data: dict):
    """Execute an analyzer plugin.

    Body should conform to the analyzer's input_schema.
    Returns {output_type, data}.
    """
    try:
        analyzer = plugin_manager.get_analyzer(analyzer_id)
    except PluginError as e:
        raise HTTPException(status_code=404, detail=str(e))

    # Optional: validate input against schema
    # (jsonschema validation can be added later)

    try:
        result = await analyzer.analyze(input_data)
    except Exception as e:
        logger.exception(f"Analyzer {analyzer_id} failed")
        raise HTTPException(status_code=400, detail=f"Analysis failed: {e}")

    return {
        "analyzer_id": analyzer_id,
        "output_type": analyzer.output_type,
        "data": result,
    }
```

### Step 4: Example Plugin -- bond-length-histogram

**`plugins/bond-histogram/catgo-plugin.json`**:
```json
{
  "name": "bond-histogram",
  "version": "1.0.0",
  "description": "Compute bond length distribution histogram from a crystal structure",
  "author": "CatGo Team",
  "catgo": {
    "backend": {
      "main": "plugin.py",
      "contributions": {
        "analyzers": [{
          "id": "bond_length_histogram",
          "output_type": "bar_plot",
          "description": "Bond length distribution histogram"
        }]
      }
    }
  }
}
```

**`plugins/bond-histogram/plugin.py`**:
```python
"""Bond length histogram analyzer plugin."""

import numpy as np
from plugins.base import AnalyzerPlugin


class BondHistogramAnalyzer(AnalyzerPlugin):
    name = "bond-histogram"
    analyzer_id = "bond_length_histogram"
    display_name = "Bond Length Histogram"
    description = "Compute bond length distribution from a crystal structure"
    version = "1.0.0"
    author = "CatGo Team"

    output_type = "bar_plot"
    input_schema = {
        "type": "object",
        "properties": {
            "structure": {
                "type": "object",
                "description": "Pymatgen structure dict with lattice and sites",
            },
            "cutoff": {
                "type": "number",
                "default": 3.0,
                "minimum": 1.0,
                "maximum": 10.0,
                "description": "Neighbor search cutoff in Angstrom",
            },
            "nbins": {
                "type": "integer",
                "default": 50,
                "minimum": 10,
                "maximum": 200,
                "description": "Number of histogram bins",
            },
        },
        "required": ["structure"],
    }

    async def analyze(self, input_data):
        from pymatgen.core import Structure

        struct_dict = input_data["structure"]
        cutoff = input_data.get("cutoff", 3.0)
        nbins = input_data.get("nbins", 50)

        struct = Structure.from_dict(struct_dict)
        neighbors = struct.get_all_neighbors(cutoff)
        distances = [n.nn_distance for site_nn in neighbors for n in site_nn]

        if not distances:
            return {
                "series": [],
                "x_label": "Distance (A)",
                "y_label": "Count",
            }

        hist, bin_edges = np.histogram(distances, bins=nbins)
        x = [(bin_edges[i] + bin_edges[i + 1]) / 2 for i in range(len(hist))]

        return {
            "series": [
                {
                    "x": [round(v, 3) for v in x],
                    "y": hist.tolist(),
                    "label": f"Bond lengths (cutoff={cutoff} A)",
                }
            ],
            "x_label": "Distance (A)",
            "y_label": "Count",
        }
```

### Verification Steps

```bash
# 1. Start backend, check analyzer list
curl http://localhost:8000/api/plugins/analyzers

# 2. Run analysis
curl -X POST http://localhost:8000/api/plugins/analyzers/bond_length_histogram/run \
  -H "Content-Type: application/json" \
  -d '{
    "structure": {
      "lattice": {"matrix": [[3.2,0,0],[0,3.2,0],[0,0,3.2]]},
      "sites": [
        {"species": [{"element": "Cu", "occu": 1}], "abc": [0,0,0], "xyz": [0,0,0]},
        {"species": [{"element": "Cu", "occu": 1}], "abc": [0.5,0.5,0], "xyz": [1.6,1.6,0]}
      ]
    },
    "cutoff": 3.5
  }'
# Should return: {"analyzer_id": "bond_length_histogram", "output_type": "bar_plot", "data": {"series": [...], ...}}
```

---

## Phase 3: WorkflowNodePlugin

### Problem

`server/utils/workflow_engine.py` dispatches node types using hardcoded sets:
- `VASP_CALC_NODES` (L34): `{"vasp_relax", "vasp_static", ...}`
- `LOCAL_NODES` (L43): `{"structure_input", "slab_gen", ...}`
- `UNIFIED_CALC_NODES` (L40): `{"geo_opt", "single_point", ...}`

The frontend `src/lib/workflow/node-definitions.ts` `NODE_DEFINITIONS` is a static Record.

There is no way to add new node types through plugins.

### Step 1: Add WorkflowNodePlugin Base Class

**File**: `server/plugins/base.py`

```python
class WorkflowNodePlugin(BasePlugin):
    """
    Base class for workflow node plugins.

    A workflow node plugin defines a new computation node type that can be
    used in the visual workflow editor.
    """

    node_type: str = ""         # Unique node type ID, e.g. "lammps_nvt"
    node_category: str = "plugin"  # Category in workflow editor sidebar
    execution_mode: str = "local"  # "local" | "hpc"
    node_definition: dict = {}  # Frontend NodeDefinition JSON (label, params, inputs, outputs)

    @abstractmethod
    async def execute(
        self,
        params: dict,
        input_structure: dict | None,
        config: dict | None = None,
    ) -> dict:
        """Execute the workflow node.

        Args:
            params: Node parameters from the workflow editor.
            input_structure: Pymatgen structure dict from upstream node.
            config: Workflow run configuration (HPC settings, etc.).

        Returns:
            {"structure": {...}, "energy": float, ...} -- depends on node type.
        """
        ...

    @classmethod
    def validate(cls) -> list[str]:
        errors = super().validate()
        if not hasattr(cls, "node_type") or not cls.node_type:
            errors.append("Missing required attribute: node_type")
        return errors

    def get_metadata(self) -> PluginMetadata:
        meta = super().get_metadata()
        meta.extra["node_type"] = self.node_type
        meta.extra["node_category"] = self.node_category
        meta.extra["execution_mode"] = self.execution_mode
        meta.extra["node_definition"] = self.node_definition
        return meta
```

### Step 2: Extend PluginManager + workflow_engine

**`server/plugins/manager.py`**:
```python
# __init__:
self._workflow_node_plugins: dict[str, WorkflowNodePlugin] = {}

# _register_plugin:
elif isinstance(plugin, WorkflowNodePlugin):
    self._workflow_node_plugins[plugin.node_type] = plugin
    logger.info(f"Registered workflow node: {plugin.node_type}")

# Methods:
def has_workflow_node(self, node_type: str) -> bool:
    return node_type in self._workflow_node_plugins

def get_workflow_node(self, node_type: str) -> "WorkflowNodePlugin":
    if node_type not in self._workflow_node_plugins:
        raise PluginError(f"Workflow node not found: {node_type}")
    return self._workflow_node_plugins[node_type]

def get_all_workflow_nodes(self) -> list[dict]:
    return [
        {
            "node_type": p.node_type,
            "name": p.name,
            "display_name": p.display_name,
            "description": p.description,
            "node_category": p.node_category,
            "execution_mode": p.execution_mode,
            "node_definition": p.node_definition,
            "enabled": p._enabled,
        }
        for p in self._workflow_node_plugins.values()
    ]
```

**`server/utils/workflow_engine.py`** -- Add plugin fallback at the end of the node dispatch logic:

Find the node type dispatch chain (search for `if node_type in VASP_CALC_NODES` or similar if-elif chain), and add before the final else:

```python
# In workflow_engine.py's node execution dispatch logic:
from plugins import plugin_manager

# ... existing if-elif chain ...
elif plugin_manager.has_workflow_node(node_type):
    plugin = plugin_manager.get_workflow_node(node_type)
    result = await plugin.execute(
        params=step_params,
        input_structure=input_structure,
        config=run_config.dict() if run_config else {},
    )
    # result should contain {"structure": ..., "energy": ..., "status": "completed"}
else:
    logger.error(f"Unknown node type: {node_type}")
    # ...
```

### Step 3: Frontend Dynamic Node Loading

**File**: `src/lib/workflow/node-definitions.ts`

Append at the end of the file:

```typescript
/**
 * Load plugin-contributed workflow node definitions from the backend.
 * Merges them into NODE_DEFINITIONS at runtime.
 *
 * Call this once when the WorkflowEditor mounts.
 */
export async function load_plugin_nodes(server_url: string): Promise<void> {
  try {
    const resp = await fetch(`${server_url}/api/plugins/workflow-nodes`)
    if (!resp.ok) return

    const data = await resp.json()
    const nodes: { node_type: string; node_definition: NodeDefinition }[] = data.nodes || []

    for (const entry of nodes) {
      if (entry.node_type && entry.node_definition) {
        // Don't overwrite built-in nodes
        if (!(entry.node_type in NODE_DEFINITIONS)) {
          NODE_DEFINITIONS[entry.node_type] = entry.node_definition
        }
      }
    }
  } catch (e) {
    console.warn(`[workflow] Failed to load plugin nodes:`, e)
  }
}
```

**`server/routers/plugins.py`** add endpoint:

```python
@router.get("/workflow-nodes")
async def list_workflow_nodes():
    """List all registered workflow node plugins."""
    nodes = plugin_manager.get_all_workflow_nodes()
    return {"nodes": nodes, "total": len(nodes)}
```

### Verification Steps

```bash
# 1. Check workflow node list (initially empty)
curl http://localhost:8000/api/plugins/workflow-nodes
# {"nodes": [], "total": 0}

# 2. Create a test plugin and verify later (omitted, Phase 3 is a mid-term goal)
```

---

## Phase 4: MCP Dynamic Tool Registration

### Problem

The `TOOLS: list[dict]` at L44 in `server/mcp_server.py` is a massive static list (61 tools). `handle_list_tools()` (L1326) returns it directly, and `handle_call_tool()` (L1807) iterates to match by name. Readers/analyzers added through plugins cannot be exposed as MCP tools for AI.

### Modification Plan

**File**: `server/mcp_server.py`

Dynamically append plugin tools in `handle_list_tools()`:

```python
# server/mcp_server.py

async def handle_list_tools() -> list[Tool]:
    # Existing static tools
    all_tools = [
        Tool(
            name=t["name"],
            description=t.get("description", ""),
            inputSchema=t.get("inputSchema", {"type": "object", "properties": {}}),
        )
        for t in TOOLS
    ]

    # Dynamically append plugin tools
    try:
        all_tools.extend(_get_plugin_tools())
    except Exception as e:
        logger.warning(f"Failed to load plugin tools for MCP: {e}")

    return all_tools


def _get_plugin_tools() -> list:
    """Generate MCP Tool entries from registered plugins."""
    from mcp.types import Tool

    tools = []

    try:
        from plugins import plugin_manager
    except ImportError:
        return tools

    # Analyzer plugins -> MCP tools
    for analyzer_info in plugin_manager.get_all_analyzers():
        tools.append(Tool(
            name=f"catgo_analyze_{analyzer_info['analyzer_id']}",
            description=f"[Plugin] {analyzer_info['description']}",
            inputSchema=analyzer_info.get("input_schema", {"type": "object", "properties": {}}),
        ))

    # Reader plugins -> MCP tools (for reading files from HPC)
    for reader_info in plugin_manager.get_all_readers():
        if reader_info.get("name", "").startswith("builtin-"):
            continue  # Built-in readers already have dedicated tools
        tools.append(Tool(
            name=f"catgo_read_{reader_info['reader_id']}",
            description=f"[Plugin] Read {', '.join(reader_info['formats'])} files. Output: {reader_info['output_type']}",
            inputSchema={
                "type": "object",
                "properties": {
                    "file_paths": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Absolute paths to the files to read",
                    },
                    "options": {
                        "type": "object",
                        "description": "Optional reader parameters",
                    },
                },
                "required": ["file_paths"],
            },
        ))

    return tools
```

Add plugin tool dispatch in `handle_call_tool()`:

```python
async def handle_call_tool(name: str, arguments: dict | None) -> list[TextContent]:
    arguments = arguments or {}

    # Check static tools list first
    tool_def = None
    for t in TOOLS:
        if t["name"] == name:
            tool_def = t
            break

    if tool_def:
        # ... existing dispatch logic ...
        pass

    # Plugin tool dispatch
    elif name.startswith("catgo_analyze_"):
        analyzer_id = name[len("catgo_analyze_"):]
        return await _handle_plugin_analyzer(analyzer_id, arguments)

    elif name.startswith("catgo_read_"):
        reader_id = name[len("catgo_read_"):]
        return await _handle_plugin_reader(reader_id, arguments)

    else:
        return [TextContent(type="text", text=f"Unknown tool: {name}")]


async def _handle_plugin_analyzer(analyzer_id: str, arguments: dict) -> list:
    from mcp.types import TextContent
    try:
        from plugins import plugin_manager
        analyzer = plugin_manager.get_analyzer(analyzer_id)

        # If no structure provided, get the current structure from the viewer
        if "structure" not in arguments:
            async with httpx.AsyncClient() as client:
                resp = await client.get(f"{_CATGO_API_URL.rstrip('/api')}/api/view/structure/current")
                if resp.status_code == 200:
                    arguments["structure"] = resp.json().get("structure")

        result = await analyzer.analyze(arguments)
        return [TextContent(type="text", text=json.dumps(result, indent=2, ensure_ascii=False))]
    except Exception as e:
        return [TextContent(type="text", text=f"Analyzer error: {e}")]


async def _handle_plugin_reader(reader_id: str, arguments: dict) -> list:
    from mcp.types import TextContent
    try:
        from plugins import plugin_manager
        reader = plugin_manager.get_reader(reader_id)
        file_paths = arguments.get("file_paths", [])
        options = arguments.get("options", {})
        result = await reader.read(file_paths, options)

        # If output is a structure, push to viewer
        if reader.output_type == "structure" and "structure" in result:
            await _push_structure_to_viewer(
                httpx.AsyncClient(), result["structure"]
            )

        return [TextContent(type="text", text=json.dumps(
            {"reader_id": reader_id, "output_type": reader.output_type, "success": True},
            indent=2
        ))]
    except Exception as e:
        return [TextContent(type="text", text=f"Reader error: {e}")]
```

### Verification Steps

```bash
# 1. Start backend with the bond-histogram plugin present
# 2. Start MCP server to check tool list
echo '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}' | python server/mcp_server.py
# Output should include "catgo_analyze_bond_length_histogram"

# 3. Call plugin tool
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"catgo_analyze_bond_length_histogram","arguments":{"structure":{...},"cutoff":3.5}}}' | python server/mcp_server.py
```

---

## Phase 5: Frontend Dynamic Tab/Panel Registration

### Problem

The `tab_defs` at L14 in `src/lib/structure/AnalysisPane.svelte` is a static array:

```typescript
const tab_defs: { id: AnalysisTab; label: string }[] = [
  { id: 'electronic', label: 'Electronic' },
  { id: 'md', label: 'MD' },
  { id: 'phase', label: 'Phase' },
  { id: 'structure_analysis', label: 'Structure' },
  { id: 'spectrum', label: 'Spectrum' },
]
```

Plugin-registered analyzers have no corresponding frontend tab.

### Modification Plan

#### Step 1: Dynamic Tab Loading

**File**: `src/lib/structure/AnalysisPane.svelte`

```typescript
// In <script> block:
import { onMount } from 'svelte'

// Extend AnalysisTab type
export type AnalysisTab = 'electronic' | 'md' | 'phase' | 'structure_analysis' | 'spectrum' | string

// Static tabs (unchanged)
const static_tab_defs: { id: AnalysisTab; label: string }[] = [
  { id: 'electronic', label: 'Electronic' },
  { id: 'md', label: 'MD' },
  { id: 'phase', label: 'Phase' },
  { id: 'structure_analysis', label: 'Structure' },
  { id: 'spectrum', label: 'Spectrum' },
]

// Dynamic tabs (loaded from backend)
let plugin_tab_defs = $state<{ id: string; label: string; plugin_name: string; output_type: string }[]>([])

// Merged
let tab_defs = $derived([...static_tab_defs, ...plugin_tab_defs])

onMount(async () => {
  try {
    const resp = await fetch(`${server_url}/api/plugins/analyzers`)
    if (!resp.ok) return
    const data = await resp.json()
    plugin_tab_defs = (data.analyzers || []).map((a: any) => ({
      id: `plugin_${a.analyzer_id}`,
      label: a.display_name,
      plugin_name: a.name,
      output_type: a.output_type,
    }))
  } catch (e) {
    console.warn(`[AnalysisPane] Failed to load plugin analyzers:`, e)
  }
})
```

#### Step 2: Add Generic Plugin Result Rendering Component

**File**: `src/lib/structure/PluginResultPane.svelte` (new)

```svelte
<script lang="ts">
  // Generic plugin analysis result renderer
  // Selects the appropriate visualization component based on output_type

  interface Props {
    analyzer_id: string
    output_type: string
    input_schema: Record<string, any>
    structure: any  // Current structure
    server_url: string
  }

  let { analyzer_id, output_type, input_schema, structure, server_url }: Props = $props()

  let loading = $state(false)
  let result = $state<any>(null)
  let error = $state<string | null>(null)

  async function run_analysis() {
    loading = true
    error = null
    try {
      const resp = await fetch(`${server_url}/api/plugins/analyzers/${analyzer_id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ structure }),
      })
      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || resp.statusText)
      }
      const data = await resp.json()
      result = data.data
    } catch (e: any) {
      error = e.message
    } finally {
      loading = false
    }
  }
</script>

<div class="plugin-result-pane">
  <button onclick={run_analysis} disabled={loading || !structure}>
    {loading ? 'Running...' : 'Run Analysis'}
  </button>

  {#if error}
    <p class="error">{error}</p>
  {/if}

  {#if result}
    {#if output_type === 'bar_plot' || output_type === 'scatter_plot'}
      <!-- Render using D3 or Plotly -->
      <div class="plot-container">
        <!-- Simple SVG bar chart renderer -->
        {#each result.series || [] as series}
          <p><strong>{series.label}</strong></p>
          <!-- Plug into existing PlotComponent or simple SVG here -->
        {/each}
      </div>
    {:else if output_type === 'table'}
      <table>
        <thead>
          <tr>
            {#each result.columns || [] as col}
              <th>{col}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each result.rows || [] as row}
            <tr>
              {#each row as cell}
                <td>{cell}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    {:else if output_type === 'image'}
      <img src="data:{result.mime};base64,{result.data}" alt="Analysis result" />
    {:else}
      <pre>{JSON.stringify(result, null, 2)}</pre>
    {/if}
  {/if}
</div>
```

Add plugin tab rendering in the tab content area of `AnalysisPane.svelte`:

```svelte
{#if active_tab?.startsWith('plugin_')}
  {@const plugin_info = plugin_tab_defs.find(t => t.id === active_tab)}
  {#if plugin_info}
    <PluginResultPane
      analyzer_id={plugin_info.id.replace('plugin_', '')}
      output_type={plugin_info.output_type}
      input_schema={{}}
      {structure}
      {server_url}
    />
  {/if}
{/if}
```

#### Step 3: Reader Upload Route Integration

**File**: `src/lib/structure/controllers/file-handlers.ts`

In the `handle_import_file` function, when the file doesn't match any known format, try uploading through the plugin reader:

```typescript
// In file-handlers.ts's handle_import_file, after existing format detection fails:

// Try plugin reader (unified upload)
try {
  const formData = new FormData()
  formData.append('files', file)
  const resp = await fetch(`${server_url}/api/plugins/readers/upload`, {
    method: 'POST',
    body: formData,
  })
  if (resp.ok) {
    const data = await resp.json()
    if (data.output_type === 'structure' && data.data?.structure) {
      deps.set_structure(data.data.structure)
      deps.inc_center_camera()
      return
    }
    if (data.output_type === 'electronic_dos' && data.session_id) {
      deps.set_dos_session(data.data)
      deps.set_analysis_open(true)
      deps.set_analysis_tab('electronic')
      return
    }
    // ... route other output_types
  }
} catch (e) {
  console.warn('[file-handlers] Plugin reader upload failed:', e)
}
```

### Verification Steps

```bash
# 1. Start backend (with bond-histogram plugin)
# 2. Open frontend, expand the Analysis pane
# 3. Should see 5 built-in tabs + "Bond Length Histogram" plugin tab
# 4. Click plugin tab -> click "Run Analysis" -> should display bar chart result
# 5. Drag in .pdos file -> should auto-route to CP2K reader -> open DOS analysis
```

---

## Phase 6 (Long-term): AI Tool Builder + Sandbox

### ToolSpec Data Structure

Every plugin (whether human-written or AI-generated) can be fully described by a ToolSpec:

```python
@dataclass
class ToolSpec:
    """Complete specification for a CatGo plugin.

    This is the schema that the AI Tool Builder generates, and the
    static validator + sandbox tester verify.
    """
    id: str                     # Unique ID
    tool_type: str              # "reader" | "analyzer" | "calculator" | "workflow_node"
    name: str                   # Display name
    description: str            # Feature description
    version: str = "1.0.0"

    # Input/Output
    input_schema: dict = {}     # JSON Schema
    output_type: str = ""       # output_type routing key
    output_schema: dict = {}    # Output JSON Schema (for validation)

    # Security
    permissions: list[str] = [] # ["structure:read", "fs:read", "network:none"]
    is_deterministic: bool = True
    max_execution_time: int = 30  # seconds

    # Testing
    test_cases: list[dict] = [] # [{"input": {...}, "expected_output_type": "bar_plot", "expected_keys": ["series"]}]

    # Code
    code: str = ""              # Python source code
```

### AI Generation Flow

```
1. User request: "I want to analyze CP2K DOS"

2. Intent Parser (LLM):
   - Input: user request + list of registered readers/analyzers
   - Output: {"intent": "need_reader", "format": ".pdos", "output_type": "electronic_dos"}

3. Tool Registry Query:
   - Search for reader_id/format match
   - Found -> use directly, skip to step 7
   - Not found -> step 4

4. AI Tool Builder (LLM):
   - Input: ToolSpec schema + ReaderPlugin base class docstring + format docs (if available) + test data
   - System prompt: includes all output_type data contracts, ReaderPlugin interface docs
   - Output: ToolSpec JSON (with complete Python code)
   - Model: uses current chat model (Claude/Gemini)

5. Static Validation (AST):
   - Parse Python AST
   - Forbidden list: os.system, subprocess, eval, exec, __import__, open (write mode)
   - Import allowlist: numpy, scipy, math, json, re, collections, pathlib (read-only)
   - Check: must inherit from ReaderPlugin/AnalyzerPlugin
   - Check: must implement read()/analyze() method

6. Sandbox Test:
   - Execute with subprocess + timeout + resource limits
   - Provide test_cases input
   - Validate output conforms to output_schema
   - Validate output keys match expected_keys
   - Timeout / exception -> feed back to LLM for regeneration (up to 3 times)

7. Registration:
   - Write to plugins/{id}/plugin.py + catgo-plugin.json
   - Record to tools.db (version, source, test results)
   - plugin_manager.discover_plugins() rediscovery
   - Notify frontend to refresh reader/analyzer list
   - Notify user: "CP2K DOS reader generated, you can now upload .pdos files"
```

### Sandbox Strategy

```python
# server/plugins/sandbox.py

import ast
import subprocess
import sys
import tempfile
from pathlib import Path

# Forbidden AST nodes/functions
FORBIDDEN_NAMES = {
    "os", "sys", "subprocess", "shutil", "socket", "http",
    "urllib", "requests", "eval", "exec", "compile", "__import__",
    "open",  # Only forbidden in write mode
}

# Import allowlist
ALLOWED_IMPORTS = {
    "numpy", "np", "scipy", "math", "json", "re", "collections",
    "dataclasses", "typing", "pathlib", "io", "csv", "struct",
    "ase", "pymatgen",  # Scientific computing libraries
    "plugins",  # CatGo plugin base classes
}

def validate_ast(code: str) -> list[str]:
    """Statically analyze Python code for safety. Returns list of errors."""
    errors = []
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [f"Syntax error: {e}"]

    for node in ast.walk(tree):
        # Check imports
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root not in ALLOWED_IMPORTS:
                    errors.append(f"Forbidden import: {alias.name}")

        elif isinstance(node, ast.ImportFrom):
            if node.module:
                root = node.module.split(".")[0]
                if root not in ALLOWED_IMPORTS:
                    errors.append(f"Forbidden import from: {node.module}")

        # Check dangerous function calls
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                if node.func.id in {"eval", "exec", "compile", "__import__"}:
                    errors.append(f"Forbidden builtin: {node.func.id}()")
            elif isinstance(node.func, ast.Attribute):
                if node.func.attr in {"system", "popen", "exec"}:
                    errors.append(f"Forbidden method: .{node.func.attr}()")

    return errors


def run_in_sandbox(
    code: str,
    test_input: dict,
    timeout: int = 30,
    max_memory_mb: int = 512,
) -> dict:
    """Execute plugin code in a restricted subprocess and return results."""
    with tempfile.TemporaryDirectory() as tmpdir:
        plugin_file = Path(tmpdir) / "plugin.py"
        plugin_file.write_text(code)

        runner_code = f'''
import json, sys
sys.path.insert(0, {repr(str(Path(__file__).parent.parent))})
sys.path.insert(0, {repr(tmpdir)})

from plugin import *  # noqa

# Find the plugin class
import inspect
plugin_cls = None
for name, obj in list(globals().items()):
    if inspect.isclass(obj) and name != "ReaderPlugin" and name != "AnalyzerPlugin":
        if hasattr(obj, "read") or hasattr(obj, "analyze"):
            plugin_cls = obj
            break

if not plugin_cls:
    print(json.dumps({{"error": "No plugin class found"}}))
    sys.exit(1)

import asyncio
instance = plugin_cls()
input_data = json.loads({repr(json.dumps(test_input))})

async def run():
    if hasattr(instance, "read"):
        return await instance.read(input_data.get("file_paths", []), input_data.get("options", {{}}))
    elif hasattr(instance, "analyze"):
        return await instance.analyze(input_data)

result = asyncio.run(run())
print(json.dumps(result, default=str))
'''
        runner_file = Path(tmpdir) / "runner.py"
        runner_file.write_text(runner_code)

        try:
            proc = subprocess.run(
                [sys.executable, str(runner_file)],
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=tmpdir,
            )
            if proc.returncode != 0:
                return {"error": proc.stderr.strip()}
            return json.loads(proc.stdout)
        except subprocess.TimeoutExpired:
            return {"error": f"Execution timed out after {timeout}s"}
        except json.JSONDecodeError:
            return {"error": f"Invalid JSON output: {proc.stdout[:200]}"}
```

---

## Implementation Order and Estimates

| Phase | Files Modified | New Files | Description | Dependencies |
|-------|---------------|-----------|-------------|--------------|
| **Phase 0** | 4 | 0 | Fix calculator disconnection: `models/structure.py`, `calculators/base.py`, `routers/optimize.py`, `routers/optimize_ws.py` | None |
| **Phase 1** | 4 | 2 | ReaderPlugin base class + generic upload endpoint + built-in reader wrappers + CP2K reader: modify `plugins/base.py`, `plugins/manager.py`, `plugins/discovery.py`, `routers/plugins.py`; create `plugins/builtin_readers.py`, `plugins/cp2k-dos-reader/` | Phase 0 |
| **Phase 2** | 2 | 1 | AnalyzerPlugin base class + generic analysis endpoint + bond-histogram: modify `plugins/base.py`, `plugins/manager.py`; create `plugins/bond-histogram/` | Phase 1 |
| **Phase 3** | 3 | 0 | WorkflowNodePlugin + frontend/backend dynamic registration: modify `plugins/base.py`, `workflow_engine.py`, `node-definitions.ts` | Phase 2 |
| **Phase 4** | 1 | 0 | MCP dynamic tools: modify `mcp_server.py` | Phase 2 |
| **Phase 5** | 3 | 1 | Frontend dynamic tabs + file routing: modify `AnalysisPane.svelte`, `file-handlers.ts`, `routers/plugins.py`; create `PluginResultPane.svelte` | Phase 2+4 |
| **Phase 6** | 0 | 2 | AI Tool Builder + sandbox: create `plugins/sandbox.py`, `routers/tool_builder.py` | Phase 1-5 |

### Recommended Execution Strategy

1. **Phase 0** can be done immediately -- minimal changes (4 files), lowest risk
2. **Phase 1** is the core infrastructure, highest investment but highest value -- recommended to complete ReaderPlugin base class + builtin_readers first, no rush on the CP2K reader
3. **Phase 2-4** can be developed in parallel (they only share modifications to base.py and manager.py)
4. **Phase 5** requires frontend changes, recommend starting after Phase 2 backend work is complete
5. **Phase 6** is a long-term goal, depends on all preceding Phases being stable

---

## Regression Risks and Mitigation

### Phase 0 Risks
- **Risk**: Changing `CalculatorType` enum from required to str may cause frontend form validation issues
- **Mitigation**: Frontend `OptimizationPane.svelte` select options are dynamically fetched from `/api/optimize/calculators`, not dependent on enum values
- **Testing**: Run `pnpm check` + manually test EMT/MACE optimization to confirm built-in calculators are unaffected

### Phase 1 Risks
- **Risk**: Built-in reader wrappers may introduce lazy import circular dependencies
- **Mitigation**: `builtin_readers.py` uses lazy imports (in-function `import sys; sys.path.insert`)
- **Risk**: Unified upload endpoint auto-detect may match the wrong reader (e.g., .xml is both vasprun and generic XML)
- **Mitigation**: `priority_score()` mechanism + support for explicit `reader_id` parameter

### Phase 4 Risks
- **Risk**: MCP tool count inflation, AI model may not select the correct tool
- **Mitigation**: Plugin tools are marked with `[Plugin]` prefix, descriptions clearly describe applicable scenarios

### Global Risks
- **Risk**: `plugins/` directory may be committed to git
- **Mitigation**: Ensure `.gitignore` includes `plugins/` (but keep `examples/plugins/`)
- **Risk**: Malicious plugin code
- **Mitigation**: Phase 6 AST static analysis + sandbox; Phase 0-5 only trusts manually installed plugins

---

## Appendix A: Complete List of Existing Reader Formats

### Frontend JS Structure Readers (parse.ts)

| Function | Format | Line | Detection Method |
|----------|--------|------|-----------------|
| `parse_poscar` | VASP POSCAR/CONTCAR | L125 | Filename matching |
| `parse_xyz` | XYZ, Extended XYZ | L412 | `.xyz` extension |
| `parse_cif` | CIF | L801 | `.cif` extension |
| `parse_phonopy_yaml` | phonopy YAML | L1148 | `.yaml` + phonopy keywords |
| `parse_lammps_data` | LAMMPS data | L1390 | `.data` / `.lmp` |
| `parse_cp2k` | CP2K input/output | L1702 | `&GLOBAL` keyword |
| `parse_optimade_json` | OPTIMADE JSON | L2236 | JSON content matching |
| `parse_structure_file` (main router) | All above | L2035 | Tries each one |

### Frontend JS Trajectory Readers (trajectory/parse.ts)

| Format | Detection Method | Notes |
|--------|-----------------|-------|
| ASE `.traj` | magic bytes + `.traj` extension | Binary |
| HDF5 `.h5`/`.hdf5` | magic bytes | h5wasm |
| XDATCAR | `XDATCAR_REGEX` | VASP MD |
| Multi-frame XYZ | Text parsing | `.xyz` multi-frame |
| LAMMPS dump | Text parsing | `ITEM: TIMESTEP` |

### Backend Python DOS Readers (catgo_dos/io.py)

| Function | Format | Input | Output |
|----------|--------|-------|--------|
| `read_vaspout_h5` | vaspout.h5 | HDF5 file path | VaspData |
| `read_procar` | PROCAR text | PROCAR text + efermi + POSCAR text | VaspData |
| `read_poscar` | POSCAR/CONTCAR text | Text | (lattice, frac_pos, types, counts) |
| `extract_efermi_outcar` | OUTCAR text | Text | float |

### Backend Python Band Readers (routers/bands.py)

| Method | Format | Dependency |
|--------|--------|-----------|
| pymatgen `Vasprun()` | vasprun.xml | pymatgen.io.vasp |
| `get_band_structure()` | KPOINTS (optional) | pymatgen |

### Backend Python COHP Readers (catgo_cohp/io.py)

| Function | Format | Output |
|----------|--------|--------|
| `parse_cohpcar` | COHPCAR.lobster | COHPData |
| `parse_icohplist` | ICOHPLIST.lobster | list[ICOHPEntry] |

### Backend Cube Readers

| Location | Format | Notes |
|----------|--------|-------|
| `src/lib/cube/parse-cube.ts` (frontend) | .cube header parsing | Atom coordinate extraction |
| `server/routers/cube.py` (backend) | .cube full parsing | Rust binary `cube-processor` |

---

## Appendix B: Detailed Data Contract Definitions

### electronic_dos (VaspData-compatible)

```python
{
    # Required
    "eigenvalues": list,     # shape (nspin, nkpts, nbands) -- nested list
    "kweights": list[float], # shape (nkpts,) -- k-point weights, sum to 1
    "efermi": float,         # Fermi energy (eV)
    "elements": list[str],   # Element symbol for each atom

    # Optional but recommended
    "projectors": list,      # shape (nspin, nions, nchannels, nkpts, nbands)
                              # If no projection data, set to None or all zeros
    "positions": list,       # shape (nions, 3) -- Cartesian Angstrom
    "positions_frac": list,  # shape (nions, 3) -- fractional coords
    "lattice": list,         # shape (3, 3) -- row vectors
    "ion_types": list[str],  # Unique element types
    "ion_counts": list[int], # Number of atoms per type
}
```

### electronic_bands

```python
{
    # pymatgen objects (built-in readers pass directly)
    "_vasprun": Vasprun,            # pymatgen Vasprun object
    "_bandstructure": BandStructureSymmLine,  # pymatgen BS object

    # Or plain dict (external plugins)
    "bands": {
        "up": list,    # shape (nbands, nkpts)
        "down": list,  # shape (nbands, nkpts) or None
    },
    "distance": list[float],    # k-point cumulative distance
    "efermi": float,
    "branches": [{"name": "G-X", "start_index": 0, "end_index": 30}, ...],
    "structure": dict,  # pymatgen dict
}
```

### cohp

```python
{
    # pymatgen/lobster objects (built-in reader)
    "_cohp_data": COHPData,

    # Or plain dict (external plugins)
    "energies": list[float],     # shape (npoints,)
    "cohp": list,                # shape (nspin, ncols, npoints)
    "icohp": list,               # shape (nspin, ncols, npoints)
    "bonds": [{"atom1": "N92", "atom2": "Mo26", "distance": 2.28, ...}, ...],
    "efermi": float,
}
```

### scatter_plot / bar_plot

```python
{
    "series": [
        {
            "x": [float, ...],
            "y": [float, ...],
            "label": "Series name",
            "color": "#ff0000",   # Optional
        },
        # ...
    ],
    "x_label": "X axis label",
    "y_label": "Y axis label",
    "title": "Plot title",  # Optional
}
```

### table

```python
{
    "columns": ["Column A", "Column B", "Column C"],
    "rows": [
        ["value1", 3.14, true],
        ["value2", 2.72, false],
    ],
    "title": "Table title",  # Optional
}
```

### image

```python
{
    "data": "iVBORw0KGgo...",  # base64 encoded
    "mime": "image/png",        # MIME type
    "width": 800,               # Optional
    "height": 600,              # Optional
}
```

---

## Appendix C: Plugin Developer Quick Start

### Creating a Reader Plugin

```bash
# 1. Create directory
mkdir -p plugins/my-format-reader

# 2. Create manifest
cat > plugins/my-format-reader/catgo-plugin.json << 'EOF'
{
  "name": "my-format-reader",
  "version": "1.0.0",
  "description": "Read .myformat files",
  "author": "Your Name",
  "catgo": {
    "backend": {
      "main": "plugin.py",
      "contributions": {
        "readers": [{
          "id": "my_format",
          "formats": [".myformat"],
          "output_type": "electronic_dos",
          "description": "My custom format reader"
        }]
      }
    }
  }
}
EOF

# 3. Create plugin code
cat > plugins/my-format-reader/plugin.py << 'PYEOF'
from plugins.base import ReaderPlugin

class MyFormatReader(ReaderPlugin):
    name = "my-format-reader"
    reader_id = "my_format"
    display_name = "My Format Reader"
    description = "Read .myformat files"
    version = "1.0.0"
    author = "Your Name"
    supported_formats = [".myformat"]
    output_type = "electronic_dos"

    async def read(self, file_paths, options=None):
        # Parse files...
        return {
            "eigenvalues": [...],
            "kweights": [...],
            "efermi": 0.0,
            "projectors": None,
            "elements": ["Fe", "O"],
            # ...
        }
PYEOF

# 4. Restart backend or refresh plugins
curl -X POST http://localhost:8000/api/plugins/refresh

# 5. Verify
curl http://localhost:8000/api/plugins/readers
```

### Creating an Analyzer Plugin

```bash
mkdir -p plugins/my-analyzer

cat > plugins/my-analyzer/plugin.py << 'PYEOF'
from plugins.base import AnalyzerPlugin

class MyAnalyzer(AnalyzerPlugin):
    name = "my-analyzer"
    analyzer_id = "my_analysis"
    display_name = "My Analysis"
    description = "Compute something interesting"
    version = "1.0.0"
    author = "Your Name"
    output_type = "table"
    input_schema = {
        "type": "object",
        "properties": {
            "structure": {"type": "object"}
        },
        "required": ["structure"]
    }

    async def analyze(self, input_data):
        structure = input_data["structure"]
        n_atoms = len(structure.get("sites", []))
        return {
            "columns": ["Property", "Value"],
            "rows": [
                ["Number of atoms", n_atoms],
                ["Has lattice", bool(structure.get("lattice"))],
            ]
        }
PYEOF
```

---

## Appendix D: discovery.py Modification Details

`_find_plugin_class()` (L208-237) currently only searches for subclasses of `CalculatorPlugin` and `OptimizerPlugin`. It needs to be extended to support all new types.

**Complete modification**:

```python
# server/plugins/discovery.py

from .base import (
    BasePlugin,
    CalculatorPlugin,
    OptimizerPlugin,
    ReaderPlugin,      # New
    AnalyzerPlugin,    # New
    WorkflowNodePlugin,# New
    PluginError,
    PluginLoadError,
    PluginValidationError,
)

# L208-237: _find_plugin_class
def _find_plugin_class(module) -> Optional[Type[BasePlugin]]:
    """Find the main plugin class in a module."""
    # All supported base classes
    _BASE_CLASSES = (
        BasePlugin, CalculatorPlugin, OptimizerPlugin,
        ReaderPlugin, AnalyzerPlugin, WorkflowNodePlugin,
    )
    _CONCRETE_BASES = (
        CalculatorPlugin, OptimizerPlugin,
        ReaderPlugin, AnalyzerPlugin, WorkflowNodePlugin,
    )

    plugin_classes: list[Type[BasePlugin]] = []

    for name in dir(module):
        if name.startswith("_"):
            continue
        obj = getattr(module, name)
        if not isinstance(obj, type):
            continue
        if obj in _BASE_CLASSES:
            continue
        if issubclass(obj, _CONCRETE_BASES):
            plugin_classes.append(obj)

    if not plugin_classes:
        return None

    for cls in plugin_classes:
        if hasattr(cls, "name") and cls.name:
            return cls

    return plugin_classes[0]
```

Also update the error message in `_load_plugin_module()` (L185-186):

```python
raise PluginLoadError(
    f"No plugin class found in {module_path}. "
    "Module must define a class inheriting from "
    "CalculatorPlugin, OptimizerPlugin, ReaderPlugin, AnalyzerPlugin, or WorkflowNodePlugin"
)
```

---

## Appendix E: __init__.py Updates

**File**: `server/plugins/__init__.py`

```python
from .base import (
    BasePlugin,
    CalculatorPlugin,
    OptimizerPlugin,
    ReaderPlugin,        # New
    AnalyzerPlugin,      # New
    WorkflowNodePlugin,  # New
    PluginMetadata,
    PluginError,
    PluginLoadError,
    PluginValidationError,
)
from .manager import plugin_manager
from .discovery import discover_plugins, load_plugin_from_path

__all__ = [
    # Base classes
    "BasePlugin",
    "CalculatorPlugin",
    "OptimizerPlugin",
    "ReaderPlugin",
    "AnalyzerPlugin",
    "WorkflowNodePlugin",
    "PluginMetadata",
    # Errors
    "PluginError",
    "PluginLoadError",
    "PluginValidationError",
    # Manager
    "plugin_manager",
    # Discovery
    "discover_plugins",
    "load_plugin_from_path",
]
```
