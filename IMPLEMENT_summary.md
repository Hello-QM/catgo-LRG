# CatGO Plugin System — Implementation Summary

> **Date**: 2026-03-03
> **Branch**: `feat/plugin-calculator-circuit-break`
> **Test Result**: **60/60 PASS** (`python -m pytest tests/test_all_phases.py -v`)
> **Test Log**: `tests/test_all_phases_log_20260303.txt`

---

## Overview

A 6-phase plugin system that enables CatGO to be extended with custom calculators, file readers, analysis tools, workflow nodes, and AI agent integrations — all without modifying core code.

### Architecture

```
plugins/                          # Plugin packages (auto-discovered)
├── lennard-jones-calculator/     # Phase 0: CalculatorPlugin example
├── cp2k-dos-reader/              # Phase 1: ReaderPlugin example
├── bond-histogram/               # Phase 2: AnalyzerPlugin example
└── lammps-workflow/              # Phase 3: WorkflowNodePlugin example

server/plugins/                   # Core plugin framework
├── base.py                       # Base classes (728 lines)
├── manager.py                    # PluginManager singleton (614 lines)
├── discovery.py                  # Auto-discovery engine (277 lines)
├── sandbox.py                    # Security sandbox (325 lines)
├── tool_builder.py               # Dynamic MCP tool builder (308 lines)
└── __init__.py                   # Public exports (51 lines)

server/mcp_server.py              # MCP server (61 tools, ~1500 lines)
server/routers/plugins.py         # REST API endpoints
server/routers/chat_multi.py      # MCP config generation for 4 AI agents
server/utils/workflow_engine.py   # Workflow engine plugin dispatch

src/lib/structure/AnalysisPane.svelte       # Dynamic analyzer tabs
src/lib/structure/PluginResultPane.svelte    # Plugin result renderer
src/lib/structure/controllers/file-handlers.ts  # Reader upload integration
src/lib/workflow/node-definitions.ts        # Dynamic workflow node loading
src/lib/workflow/WorkflowEditor.svelte      # Workflow editor plugin support
```

---

## Phase Status

| Phase | Feature | Status | Tests | Notes |
|-------|---------|--------|-------|-------|
| **0** | CalculatorPlugin circuit break | **COMPLETE** | 9/9 PASS | Accepts plugin calculator IDs in optimization API |
| **1** | ReaderPlugin + CP2K DOS reader | **COMPLETE** | 13/13 PASS | Multi-file, spin-polarized, auto-detect |
| **2** | AnalyzerPlugin + Bond Histogram | **COMPLETE** | 14/14 PASS | bar_plot/table/image/text renderers |
| **3** | WorkflowNodePlugin + LAMMPS NVT | **COMPLETE** | 15/15 PASS | Placeholder execute (no real LAMMPS) |
| **4** | MCP dynamic tool registration | **COMPLETE** | 7/7 PASS (static) | 61 MCP tools, 4 AI agents |
| **5** | Frontend dynamic tabs | **COMPLETE** | 9/9 PASS (static) | Auto-fetches analyzer/workflow plugins |
| — | Cross-phase integration | **COMPLETE** | 10/10 PASS | All 4 plugin types coexist |

---

## Phase 0: Calculator Plugin Circuit Break

### What Changed
- `server/models/structure.py`: `OptimizationRequest.calculator` changed from `CalculatorType` enum → `str`
- `server/calculators/base.py`: `get_calculator()` falls through to `plugin_manager.has_calculator()` if built-in not found
- `_PluginCalculatorAdapter` wraps `CalculatorPlugin.get_calculator()` → `BaseCalculator` interface
- `server/routers/optimize.py`: `list_calculators()` includes plugin calculators with `is_plugin: true`

### Example Plugin
`plugins/lennard-jones-calculator/plugin.py`:
- `calculator_id = "lennard_jones"`
- Supports: Ar, Ne, Kr, Xe (noble gases)
- Parameter schema: `{ cutoff, sigma, epsilon }`

### Verified
- [x] Plugin discovery and registration
- [x] Metadata (id, display_name, supported_elements, parameter_schema)
- [x] Disable/enable toggle
- [x] Appears in `get_all_calculators()`
- [x] Validation rejects bad calculator_id formats
- [x] Model field is `str` type

---

## Phase 1: ReaderPlugin + CP2K DOS Reader

### Base Class: `ReaderPlugin`
```python
class ReaderPlugin(BasePlugin):
    reader_id: str                 # "cp2k_pdos"
    supported_formats: list[str]   # [".pdos"]
    output_type: str               # "electronic_dos"
    multi_file: bool = False       # True for CP2K (one .pdos per atom kind)

    async def read(file_paths, options) → dict    # VaspData-compatible dict
    def detect_files(filenames) → bool            # Extension matching
    def priority_score(filenames) → int           # Priority ranking
```

**Valid output_type values**: `electronic_dos`, `electronic_bands`, `cohp`, `structure`, `trajectory`, `volumetric`, `scatter_plot`, `bar_plot`, `table`, `image`

### Example Plugin
`plugins/cp2k-dos-reader/plugin.py`:
- Parses CP2K `.pdos` files (Hartree → eV conversion)
- Multi-file: combines Ti + O atom kinds
- Spin-polarized: ALPHA/BETA detection (nspin=2)
- Returns VaspData-compatible dict with eigenvalues, projectors, efermi

### API Endpoints
- `GET /plugins/readers` — list all registered readers
- `POST /plugins/readers/upload` — upload files, auto-detect reader, return parsed data

### Verified
- [x] Reader discovery and metadata
- [x] `detect_files()` case-insensitive matching
- [x] `find_reader_for_files()` auto-selection
- [x] Single file parse (Ti: efermi=-5.0458 eV, 60 bands)
- [x] Multi-file parse (Ti + O combined)
- [x] Spin-polarized parse (nspin=2)
- [x] Validation rejects missing/invalid attributes

### Test Fixtures
`tests/fixtures/cp2k-pdos/`:
- `TiO2-Ti-k1-1.pdos`, `TiO2-O-k1-1.pdos` (non-magnetic)
- `TiO2-Ti-ALPHA-k1-1.pdos`, `TiO2-Ti-BETA-k1-1.pdos` (spin-polarized)
- `TiO2-O-ALPHA-k1-1.pdos`, `TiO2-O-BETA-k1-1.pdos`

---

## Phase 2: AnalyzerPlugin + Bond Histogram

### Base Class: `AnalyzerPlugin`
```python
class AnalyzerPlugin(BasePlugin):
    analyzer_id: str        # "bond_histogram"
    output_type: str        # "bar_plot"
    input_schema: dict      # JSON Schema for input validation

    async def analyze(input_data: dict) → dict
```

**Output format by type**:
- `bar_plot` / `scatter_plot`: `{ series: [{x, y, label}], x_axis, y_axis }`
- `table`: `{ columns: [{key, label, format}], rows: [...] }`
- `image`: `{ data: "base64", mime: "image/png" }`
- `text`: `{ content: "markdown" }`

### Example Plugin
`plugins/bond-histogram/plugin.py`:
- Uses pymatgen `structure.get_neighbors()` to compute bond lengths
- Returns bar_plot with histogram bins

### API Endpoints
- `GET /plugins/analyzers` — list all analyzers with input_schema
- `POST /plugins/analyzers/{analyzer_id}/run` — execute analysis

### Frontend
- `AnalysisPane.svelte`: Fetches `GET /plugins/analyzers` on mount, creates dynamic tabs
- `PluginResultPane.svelte`: Renders results by output_type (bar chart, table, image, text)

### Verified
- [x] Discovery, metadata, input_schema
- [x] Execute with FCC Cu (20 bins, max count=48)
- [x] Disable/enable toggle
- [x] All 5 output_types pass validation
- [x] Frontend components have all required keywords

---

## Phase 3: WorkflowNodePlugin + LAMMPS NVT

### Base Class: `WorkflowNodePlugin`
```python
class WorkflowNodePlugin(BasePlugin):
    node_type: str           # "lammps_nvt_plugin"
    node_definition: dict    # NodeDefinition for UI (type, label, color, icon, ...)
    execution_mode: str      # "local" | "hpc"

    async def execute(structure_json, params, config) → dict
```

### Example Plugin
`plugins/lammps-workflow/plugin.py`:
- **Placeholder**: Returns input structure unchanged with `energy=-42.0`
- Parameters: timestep (fs), temperature (K), steps, potential (eam/lj/reaxff)
- Ready for real LAMMPS integration

### Integration
- `workflow_engine.py`: `_has_plugin_node()` + `_execute_plugin_node()` dispatch
- `node-definitions.ts`: `load_plugin_nodes()` fetches from `GET /plugins/workflow-nodes`
- `WorkflowEditor.svelte`: Plugin nodes appear in "Plugin" sidebar category

### API Endpoints
- `GET /plugins/workflow-nodes` — returns `{ nodes: [...], total }`

### Verified
- [x] Discovery, metadata (display_name, execution_mode, node_type)
- [x] node_definition has all required UI keys
- [x] param_schema (timestep, temperature, steps, potential)
- [x] Execute returns correct mock result
- [x] Disable hides from workflow node list
- [x] WorkflowEngine has `_has_plugin_node` + `_execute_plugin_node`
- [x] Frontend `load_plugin_nodes` + `is_plugin_node` functions exist

---

## Phase 4: MCP Dynamic Tool Registration

### MCP Server (`server/mcp_server.py`)
- **61 MCP tools** organized by category (structure, building, optimization, fetch, spectroscopy, workflow, MD analysis)
- `CatGoMcpServer` class with methods:
  - `_get_plugin_tools()` — dynamically generates tool specs from registered plugins
  - `_handle_plugin_analyzer()` — routes analyzer calls to backend
  - `_handle_plugin_reader()` — routes reader calls to backend
- Communicates with backend via `CATGO_API` env var (default `http://localhost:8000/api`)

### MCP Config Generation (`server/routers/chat_multi.py`)
Supports 4 AI agents:
- `_ensure_claude_mcp()` → `~/.claude/mcp.json`
- `_ensure_gemini_mcp()` → `~/.gemini/settings.json`
- `_ensure_codex_mcp()` → `~/.codex/config.toml`
- `_ensure_iflow_mcp()` → `iflow mcp add catgo ...`

`ensure_all_mcp_configs()` called at backend startup.

### Verified (Static Analysis)
- [x] mcp_server.py syntax valid
- [x] 61 tools defined
- [x] Plugin tool methods present (_get_plugin_tools, _handle_plugin_analyzer, _handle_plugin_reader)
- [x] MCP config for all 4 AI agents
- [x] CATGO_API env var handling

### Not Yet Verified (Requires Running Server)
- [ ] Live MCP tool execution via Claude Code
- [ ] Live MCP tool execution via Gemini CLI
- [ ] Plugin tool dynamic registration at runtime

---

## Phase 5: Frontend Dynamic Tabs

### Components
| File | Purpose | Lines |
|------|---------|-------|
| `AnalysisPane.svelte` | Dynamic tab bar + plugin tab creation | 512 |
| `PluginResultPane.svelte` | Renders analyzer results by output_type | 216 |
| `file-handlers.ts` | Plugin reader file upload integration | 381 |
| `node-definitions.ts` | Workflow node plugin loading | 2118 |
| `WorkflowEditor.svelte` | Workflow editor with plugin sidebar | 2876 |

### Data Flow
1. **AnalysisPane** mounts → `GET /api/plugins/analyzers` → creates `plugin_tab_defs`
2. User clicks plugin tab → `<PluginResultPane>` renders with analyzer_id
3. User clicks "Run" → `POST /api/plugins/analyzers/{id}/run` → renders result
4. **WorkflowEditor** mounts → `load_plugin_nodes()` → `GET /api/plugins/workflow-nodes`
5. Plugin nodes appear in "Plugin" sidebar category with drag-and-drop

### Verified (Static Analysis)
- [x] All required keywords present in all 5 frontend files
- [x] PluginResultPane handles bar_plot, table, image, text, JSON
- [x] load_plugin_nodes and is_plugin_node exported
- [x] WorkflowEditor calls load_plugin_nodes

### Not Yet Verified (Requires Running Frontend)
- [ ] Dynamic tab rendering in browser
- [ ] Plugin result visualization (bar chart, table, image)
- [ ] Workflow node drag-and-drop from Plugin category
- [ ] File drop triggers plugin reader upload

---

## How to Continue Testing

### 1. Run Offline Tests (No Server Required)
```bash
cd CatGO-dev
python -m pytest tests/test_all_phases.py -v
```

### 2. Run Server Integration Tests (Requires Backend Running)
```bash
# Terminal 1: Start backend
cd CatGO-dev/server
python main.py

# Terminal 2: Run integration tests
python tests/test_phase1_manual.py    # Reader API tests
python tests/test_phase2_analyzer.py  # Analyzer API tests
python tests/test_server_startup.py   # Server startup + plugin loading
```

### 3. Frontend Visual Testing (Requires Dev Server)
```bash
pnpm dev  # Start SvelteKit dev server on port 3000
```
Then in browser:
1. Load any structure → Open Analysis pane → Check for "Bond Length Histogram" tab
2. Click the plugin tab → Click "Run Analysis" → Verify bar chart renders
3. Open Workflow Editor → Check "Plugin" category in sidebar → Verify "LAMMPS NVT (Plugin)" node
4. Drag plugin node to canvas → Check parameter panel shows timestep/temperature/steps/potential

### 4. MCP Integration Testing (Requires Backend + AI CLI)
```bash
# Start backend first, then:
claude -p "List available calculators"  # Should show lennard_jones
claude -p "Show bond histogram for FCC Cu"  # Should invoke analyzer
```

### 5. Bond Histogram Runtime Test (Requires pymatgen)
```bash
python -c "
import asyncio
from pymatgen.core import Structure, Lattice

# Import plugin
import sys; sys.path.insert(0, 'plugins/bond-histogram')
from plugin import BondHistogramPlugin

async def test():
    plugin = BondHistogramPlugin()
    lattice = Lattice.cubic(3.615)
    struct = Structure(lattice, ['Cu']*4,
        [[0,0,0],[0.5,0.5,0],[0.5,0,0.5],[0,0.5,0.5]])
    result = await plugin.analyze({
        'structure': struct.as_dict(),
        'n_bins': 20, 'max_distance': 4.0
    })
    print(f'Series: {len(result[\"series\"])}')
    print(f'Bins: {len(result[\"series\"][0][\"x\"])}')
    print(f'Max count: {max(result[\"series\"][0][\"y\"])}')

asyncio.run(test())
"
```

---

## Known Limitations

1. **LAMMPS plugin is placeholder** — `execute()` returns mock data, no real MD simulation
2. **No conda/ASE env on current Windows** — server can't run optimization endpoints with ASE calculators
3. **MCP integration not live-tested** — static analysis only, needs running backend + AI CLI
4. **Frontend not visually tested** — keyword verification only, needs running dev server
5. **Bond histogram requires pymatgen** — available in catgo conda env, verified working
6. **Plugin sandbox** (`sandbox.py`) and **tool_builder** (`tool_builder.py`) exist but not tested in this round

---

## File Inventory

### Core Framework (server/plugins/)
| File | Lines | Purpose |
|------|-------|---------|
| `base.py` | 728 | BasePlugin, CalculatorPlugin, ReaderPlugin, AnalyzerPlugin, WorkflowNodePlugin |
| `manager.py` | 614 | PluginManager singleton — registration, lookup, enable/disable |
| `discovery.py` | 277 | Auto-discovery: scan dirs, load modules, validate classes |
| `sandbox.py` | 325 | Security sandbox for plugin execution |
| `tool_builder.py` | 308 | Dynamic MCP tool spec generation |
| `__init__.py` | 51 | Public exports |

### Example Plugins (plugins/)
| Plugin | Lines | Type | ID |
|--------|-------|------|----|
| `lennard-jones-calculator/plugin.py` | 141 | Calculator | `lennard_jones` |
| `cp2k-dos-reader/plugin.py` | 252 | Reader | `cp2k_pdos` |
| `bond-histogram/plugin.py` | 85 | Analyzer | `bond_histogram` |
| `lammps-workflow/plugin.py` | 135 | WorkflowNode | `lammps_nvt_plugin` |

### Server Integration
| File | Lines | Changes |
|------|-------|---------|
| `mcp_server.py` | ~1500 | 61 MCP tools + plugin tool generation |
| `routers/plugins.py` | — | REST endpoints for all plugin types |
| `routers/chat_multi.py` | — | MCP config generation for 4 AI agents |
| `utils/workflow_engine.py` | — | `_has_plugin_node` + `_execute_plugin_node` |
| `models/structure.py` | — | `calculator: str` (was enum) |
| `calculators/base.py` | — | Plugin calculator fallback chain |

### Frontend Integration
| File | Lines | Changes |
|------|-------|---------|
| `AnalysisPane.svelte` | 512 | Dynamic plugin tabs from API |
| `PluginResultPane.svelte` | 216 | Result renderer (bar/table/image/text) |
| `file-handlers.ts` | 381 | Plugin reader file upload |
| `node-definitions.ts` | 2118 | `load_plugin_nodes()` + `is_plugin_node()` |
| `WorkflowEditor.svelte` | 2876 | Plugin category in sidebar |

### Tests
| File | Tests | Purpose |
|------|-------|---------|
| `tests/test_all_phases.py` | 60 | Comprehensive offline test suite |
| `tests/conftest.py` | — | sys.path setup |
| `tests/fixtures/cp2k-pdos/` | 6 files | CP2K .pdos test data |
| `tests/test_phase1_manual.py` | — | Phase 1 server integration |
| `tests/test_phase2_analyzer.py` | — | Phase 2 server integration |
| `tests/test_server_startup.py` | — | Server startup verification |

---

## Plugin Developer Guide (Quick Reference)

### Creating a New Plugin

1. Create a directory under `plugins/`:
```
plugins/my-plugin/
├── catgo-plugin.json    # Manifest
└── plugin.py            # Implementation
```

2. Write `catgo-plugin.json`:
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "displayName": "My Plugin",
  "description": "Description",
  "author": "Author",
  "catgo": {
    "backend": {
      "main": "plugin.py"
    }
  }
}
```

3. Implement plugin class in `plugin.py` (subclass one of):
   - `CalculatorPlugin` — custom calculator for optimization
   - `ReaderPlugin` — custom file format reader
   - `AnalyzerPlugin` — custom analysis tool with visualization
   - `WorkflowNodePlugin` — custom workflow node

4. Restart server — plugin auto-discovered and registered.

### Available Base Classes

```python
from plugins.base import (
    CalculatorPlugin,     # calculator_id, get_calculator()
    ReaderPlugin,         # reader_id, read(), detect_files()
    AnalyzerPlugin,       # analyzer_id, analyze(), input_schema
    WorkflowNodePlugin,   # node_type, execute(), node_definition
)
```
