# CatGo 统一插件系统 — 详细实施计划

> 已归档为 done（2026-03-13）。
> 该计划对应的 Phase 0-6 已有实现与总结，不再作为当前待办。

## 总览

将 CatGo 从硬编码扩展改为统一插件架构，最终支持 AI 自动生成工具（self-extending-tools 愿景）。

本文档是**可直接执行的实施指南**——包含精确的文件路径、代码片段、修改位置行号和验证步骤。AI 助手读取后应能独立完成每个 Phase 的实现。

---

### 当前状态

| 类别 | 状态 | 关键文件 | 问题 |
|------|------|---------|------|
| Calculator 插件 | 框架存在但**断路** | `server/plugins/base.py` L179-262, `server/plugins/manager.py` L269-295 | `optimize.py` 调用 `calculators.base.get_calculator()`（硬编码枚举），从不调用 `plugin_manager.get_calculator()` |
| Analysis 工具 | **硬编码** sys.path.insert | `server/routers/dos.py` L21-23, `server/routers/cohp.py` L16-17 | DOS/COHP 分析扩展用 `sys.path.insert()` 导入，不走插件系统 |
| 文件读取 (后端) | **硬编码** 分散 4 处 | `catgo_dos/io.py`, `catgo_cohp/io.py`, `server/routers/bands.py`, `server/routers/cube.py` | 20+ 格式分散在 4 个位置，加新格式需改 5+ 文件 |
| 文件读取 (前端) | **硬编码** 大型 switch | `src/lib/structure/parse.ts` L2035-2197, `src/lib/trajectory/parse.ts` | 10+ 结构格式 + 5+ 轨迹格式全在 parse 函数里 |
| Workflow 节点 | **硬编码** 静态集合 | `server/utils/workflow_engine.py` L34-59, `src/lib/workflow/node-definitions.ts` | `VASP_CALC_NODES`, `LOCAL_NODES` 等静态 set，无法动态扩展 |
| MCP 工具 | **硬编码** 静态列表 | `server/mcp_server.py` L44 `TOOLS: list[dict]` | 61 个工具全部硬编码在一个 list 里 |
| 前端 Analysis Tab | **硬编码** 静态数组 | `src/lib/structure/AnalysisPane.svelte` L14 `tab_defs` | 5 个 tab 写死，无法动态注册 |

### 目标架构

```
plugins/                            ← 用户/AI 创建的插件
├── my-calculator/                  ← CalculatorPlugin (Phase 0 修复)
│   ├── catgo-plugin.json
│   └── plugin.py
├── cp2k-dos-reader/                ← ReaderPlugin (Phase 1)
│   ├── catgo-plugin.json
│   └── plugin.py
├── qe-bands-reader/                ← ReaderPlugin (Phase 1)
│   ├── catgo-plugin.json
│   └── plugin.py
├── bond-histogram/                 ← AnalyzerPlugin (Phase 2)
│   ├── catgo-plugin.json
│   └── plugin.py
└── lammps-workflow/                ← WorkflowNodePlugin (Phase 3)
    ├── catgo-plugin.json
    └── plugin.py

后端自动:
  1. 发现 + 加载插件 (discovery.py — 已有)
  2. 注册到 PluginManager 各类型注册表
  3. 注册 REST 端点 (/api/plugins/readers/upload, /api/plugins/{name}/analyze, ...)
  4. 注册 MCP 工具 (Phase 4)
  5. 通知前端有新 reader/tab/节点 (Phase 5)
```

### 统一 catgo-plugin.json Manifest

所有插件类型共享同一个 manifest schema。`catgo.backend.contributions` 下声明贡献类型：

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

### output_type 路由表（核心设计）

插件声明 `output_type`，系统自动路由到对应的可视化管线：

| output_type | 数据契约 (Python dict) | 前端渲染器 | 现有管线参考 |
|-------------|----------------------|-----------|-------------|
| `structure` | `{"structure": pymatgen_dict}` | 3D Structure viewer | `parse.ts` → `Structure.svelte` |
| `electronic_dos` | VaspData 兼容 dict（见下文） | DosPlot (Plotly) | `dos.py` → `DosAnalysisPane` |
| `electronic_bands` | BandStructureSymmLine dict | BandPlot (Plotly) | `bands.py` → `BandAnalysisPane` |
| `cohp` | COHPData dict | CohpPlot (Plotly) | `cohp.py` → `CohpAnalysisPane` |
| `trajectory` | TrajectoryType dict | Trajectory player | `parse.ts` → `Trajectory.svelte` |
| `volumetric` | CubeHeader + grid data | Cube pane + isosurface | `cube.py` → `CubePane` |
| `scatter_plot` | `{"series": DataSeries[], "x_label": str, "y_label": str}` | ScatterPlot (D3) | 通用 |
| `bar_plot` | `{"series": BarSeries[], "x_label": str, "y_label": str}` | BarPlot (D3) | 通用 |
| `table` | `{"columns": [str], "rows": [[val, ...], ...]}` | 通用表格 | 通用 |
| `image` | `{"data": "base64...", "mime": "image/png"}` | `<img>` | 通用 |

**VaspData 兼容 dict 格式**（`electronic_dos` output_type 必须返回）:
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

## 必读文件清单（按 Phase 组织）

### 全局
| 文件 | 关键内容 |
|------|---------|
| `server/plugins/__init__.py` | 公开 API: `BasePlugin`, `CalculatorPlugin`, `plugin_manager` |
| `server/plugins/base.py` | `BasePlugin` (L103-171), `CalculatorPlugin` (L179-270), `OptimizerPlugin` (L278-336), `PluginType` 枚举 (L72-77) |
| `server/plugins/discovery.py` | `discover_plugins()` (L50-91), `load_plugin_from_path()` (L94-128), `_find_plugin_class()` (L208-237) |
| `server/plugins/manager.py` | `PluginManager` (L31-390): `_plugins`, `_calculator_plugins`, `_optimizer_plugins` 注册表; `get_calculator()` (L269-291) |
| `server/routers/plugins.py` | REST 端点: `GET /plugins/`, `GET /plugins/calculators`, `POST /plugins/refresh` |
| `server/main.py` | `lifespan()` 中 `await plugin_manager.initialize()` |

### Phase 0 (修复 Calculator)
| 文件 | 关键内容 |
|------|---------|
| `server/calculators/base.py` | `get_calculator()` 工厂函数 (L35-98) — 硬编码 `CalculatorType` 枚举 |
| `server/routers/optimize.py` | `get_calculator(request.calculator, ...)` 调用点 (L121) |
| `server/routers/optimize_ws.py` | 同上，WebSocket 路由 (L163) |
| `server/models/structure.py` | `CalculatorType` 枚举 (L11-17), `OptimizerType` (L21-27) |
| `examples/plugins/lennard-jones-calculator/plugin.py` | 参考实现 (L56-115) |

### Phase 1 (统一 Reader)
| 文件 | 关键内容 |
|------|---------|
| `extensions/dos-analysis/catgo_dos/io.py` | `VaspData` (L33-91), `read_vaspout_h5()` (L93-156), `read_procar()` (L284-485) |
| `server/routers/dos.py` | `upload_h5` (L149-176), `upload_procar` (L179-225), `_create_session()` (L122-146), `sys.path.insert` (L21-23) |
| `server/routers/bands.py` | `upload_band_vasprun` (L159-198), `_create_band_session()` (L201-239), pymatgen `Vasprun` 依赖 |
| `extensions/cohp-analysis/catgo_cohp/io.py` | `parse_cohpcar()` (L253-387), `parse_icohplist()` (L423-524) |
| `server/routers/cohp.py` | `upload_cohpcar` (L58-99), `sys.path.insert` (L16-17) |
| `server/routers/cube.py` | `upload_cube_file` (L49-60), Rust binary 调用 |
| `src/lib/structure/parse.ts` | `parse_poscar` (L125), `parse_xyz` (L412), `parse_cif` (L801), `parse_lammps_data` (L1390), `parse_cp2k` (L1702), `parse_any_structure` (L2198) |
| `src/lib/structure/controllers/file-handlers.ts` | 文件类型路由: `is_h5_file`, `try_handle_cube_file`, `handle_import_file` |
| `src/lib/trajectory/parse.ts` | `FORMAT_PATTERNS` (L48), `.traj`/`.hdf5`/XDATCAR 等 5+ 格式 |

### Phase 2 (Analyzer)
| 文件 | 关键内容 |
|------|---------|
| `src/lib/plot/types.ts` | `DataSeries`, `AxisConfig` |
| `src/lib/electronic/` | DOS/Band/COHP 前端组件 |

### Phase 3 (Workflow Node)
| 文件 | 关键内容 |
|------|---------|
| `src/lib/workflow/workflow-types.ts` | `NodeDefinition`, `ParamDef` |
| `src/lib/workflow/node-definitions.ts` | `NODE_DEFINITIONS` (静态 Record), `SOFTWARE_PERIODICITY` |
| `server/utils/workflow_engine.py` | `VASP_CALC_NODES` (L34), `LOCAL_NODES` (L43), `UNIFIED_CALC_NODES` (L40) — 节点分类 sets |

### Phase 4 (MCP)
| 文件 | 关键内容 |
|------|---------|
| `server/mcp_server.py` | `TOOLS` list (L44), `handle_list_tools()` (L1326), `handle_call_tool()` (L1807) |

### Phase 5 (前端动态注册)
| 文件 | 关键内容 |
|------|---------|
| `src/lib/structure/AnalysisPane.svelte` | `tab_defs` (L14), `AnalysisTab` 类型 (L12) |
| `src/lib/electronic/DosAnalysisPane.svelte` | 文件上传检测 |

---

## Phase 0: 修复 Calculator 插件断路

### 问题分析

`server/routers/optimize.py` 第 121 行调用:
```python
calc_wrapper = get_calculator(request.calculator, request.calculator_params)
```

这里的 `get_calculator` 是从 `calculators.base` 导入的（第 9 行），它内部维护一个硬编码的 `CalculatorType → class` 字典（`server/calculators/base.py` L41-72）。只支持 EMT/XTB/MACE/CHGNET/M3GNET 五个枚举值。

`PluginManager.get_calculator()` (`server/plugins/manager.py` L269-291) 能正确获取插件注册的 calculator，但 `optimize.py` 从未调用它。

用户安装了 `lennard-jones-calculator` 插件后，在前端选择 "lennard_jones" calculator 时，`CalculatorType` 枚举不包含该值，后端直接报 422 validation error。

### 修改方案

#### 步骤 1: 修改 `server/models/structure.py` — calculator_type 放宽为 str

**文件**: `server/models/structure.py`
**位置**: `CalculatorType` 枚举 (L11-17) 和 `OptimizationRequest` model

**问题**: `OptimizationRequest.calculator` 字段类型是 `CalculatorType`（枚举），FastAPI/Pydantic 自动校验只允许枚举值，插件的 calculator_id 被拒绝。

**修改**: 不删除 `CalculatorType` 枚举（前端 UI 仍用它列举内置选项），但在 `OptimizationRequest` 中将 `calculator` 字段放宽：

```python
# server/models/structure.py

# CalculatorType 枚举保留不变（L11-17）

# 找到 OptimizationRequest 模型，修改 calculator 字段:
class OptimizationRequest(BaseModel):
    structure: dict
    # 之前: calculator: CalculatorType = CalculatorType.EMT
    # 之后:
    calculator: str = "emt"  # 内置: "emt"|"mace"|"chgnet"等; 插件: 任意 calculator_id
    calculator_params: Optional[CalculatorParams] = None
    # ... 其余字段不变
```

> **注意**: 需要搜索整个 `server/models/` 目录中引用 `request.calculator` 的地方，确认它们不依赖枚举的 `.value` 属性。实际上 `optimize.py` L121 传给 `get_calculator(request.calculator, ...)` 的第一个参数需要从枚举改为字符串。

#### 步骤 2: 修改 `server/calculators/base.py` — 添加 plugin fallback

**文件**: `server/calculators/base.py`
**位置**: `get_calculator()` 函数 (L35-98)

在最后的 `if calc_type not in calculators` 分支之前，添加 plugin_manager 查询:

```python
# server/calculators/base.py  L35-98

def get_calculator(
    calc_type: str,  # 之前: CalculatorType, 改为 str
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

    # --- 新增: 尝试插件注册的 calculator ---
    # 将 CalculatorType 枚举值或字符串统一为小写 str
    calc_id = calc_type.value if hasattr(calc_type, 'value') else str(calc_type)

    if calc_id in calculators:
        calc_class = calculators[calc_id]
        # ... 现有的参数处理逻辑 (XTB/MACE params) 不变 ...
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
            # 返回一个 adapter，使接口与内置 BaseCalculator 一致
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
    """将 PluginManager 的 calculator 适配为内置 BaseCalculator 接口。"""

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

#### 步骤 3: 修改 `server/routers/optimize.py` — 兼容字符串 calculator

**文件**: `server/routers/optimize.py`
**位置**: L9, L89-106, L121

```python
# L9: 导入不变（get_calculator 签名改了，但 import 路径不变）
from calculators import get_calculator

# L89-106: list_calculators 端点需要同时列出内置 + 插件 calculator
@router.get("/calculators")
async def list_calculators() -> dict:
    """List available calculators (built-in + plugins)."""
    calculators = {}

    # 内置
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

    # 插件
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

# L121: request.calculator 现在是 str，不是枚举
# get_calculator 已改为接受 str, 无需修改调用方式
# 但要处理枚举兼容: 如果前端发 "emt" 而非 CalculatorType.EMT
calc_wrapper = get_calculator(request.calculator, request.calculator_params)
# 同时要修改 L133 的 request.calculator.value → request.calculator
```

#### 步骤 4: 同步修改 `server/routers/optimize_ws.py`

**文件**: `server/routers/optimize_ws.py`
**位置**: L13, L163-164

```python
# L13: 导入不变
from calculators import get_calculator

# L163-164: request.calculator 已经是 str
calc_wrapper = get_calculator(
    self.request.calculator, self.request.calculator_params
)
# 确认没有 .value 调用
```

### 验证步骤

```bash
# 1. 确认 examples 中的 LJ 插件目录存在
ls examples/plugins/lennard-jones-calculator/

# 2. 复制到 plugins/ 目录
mkdir -p plugins
cp -r examples/plugins/lennard-jones-calculator plugins/

# 3. 重启后端
# (在 conda 环境中)
python server/main.py
# 应看到: "[Server] Plugin manager initialized"
# 应看到: "Loaded plugin: lennard-jones from .../plugins/lennard-jones-calculator"
# 应看到: "Registered calculator: lennard_jones"

# 4. 检查 calculator 列表 (内置 + 插件)
curl http://localhost:8000/api/optimize/calculators | python -m json.tool
# 应包含:
# "lennard_jones": {"available": true, "name": "Lennard-Jones", "is_plugin": true, ...}

# 5. 用插件 calculator 优化 (He dimer)
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
# 应返回 {"success": true, "optimized_structure": {...}, ...}

# 6. 确认内置 calculator 不受影响
curl -X POST http://localhost:8000/api/optimize/structure \
  -H "Content-Type: application/json" \
  -d '{"structure": {...Cu atoms...}, "calculator": "emt", "fmax": 0.05}'
# 应正常工作

# 7. pnpm check 确认前端类型无回归
pnpm check
```

### 注意事项

- `CalculatorType` 枚举保留不删——前端 `OptimizationPane.svelte` 用它渲染 select 选项。前端需要从 `/api/optimize/calculators` 动态获取完整列表（含插件），但这是 Phase 5 前端动态 UI 的工作。Phase 0 只确保后端能用。
- `optimize_ws.py` 里的 `CalculatorType` 引用也需要改为兼容 str。搜索 `CalculatorType` 确认所有引用点。

---

## Phase 1: 统一 ReaderPlugin 接口

### 问题分析

CatGo 当前的文件读取能力分散在 4 个独立系统中：

**后端 Python 读取器**:
1. **DOS**: `extensions/dos-analysis/catgo_dos/io.py` — `read_vaspout_h5()` (L93), `read_procar()` (L284)
2. **COHP**: `extensions/cohp-analysis/catgo_cohp/io.py` — `parse_cohpcar()` (L253), `parse_icohplist()` (L423)
3. **Bands**: `server/routers/bands.py` — pymatgen `Vasprun()` (L186) → `get_band_structure()` (L187)
4. **Cube**: `server/routers/cube.py` — Rust binary `cube-processor` (L28)

**前端 JS 读取器**:
5. **Structure**: `src/lib/structure/parse.ts` — `parse_poscar` (L125), `parse_xyz` (L412), `parse_cif` (L801), `parse_lammps_data` (L1390), `parse_cp2k` (L1702), `parse_optimade_json` (L2236)
6. **Trajectory**: `src/lib/trajectory/parse.ts` — ASE .traj, HDF5, XDATCAR, XYZ 多帧

**问题**:
- 加一个新格式（比如 CP2K .pdos）需要：改 io.py, 改 dos.py 加端点, 改前端加文件类型检测 — 至少 5 个文件
- 后端读取器用 `sys.path.insert()` 硬编码路径导入扩展包
- 不同格式的上传端点接口不统一（DOS 用 `POST /dos/upload`, Bands 用 `POST /bands/upload`, COHP 用 `POST /cohp/upload-cohpcar`）

### 设计目标

1. **统一 ReaderPlugin 基类** — 声明格式 + 输出类型
2. **统一上传端点** — `POST /api/plugins/readers/upload` 自动路由
3. **向后兼容** — 现有专用端点不变，新端点并行存在
4. **内置 reader 也走插件** — 将现有 DOS/COHP/Bands reader 包装为内置 ReaderPlugin

### 步骤 1: 扩展 `PluginType` 枚举和基类

**文件**: `server/plugins/base.py`

在 `PluginType` 枚举 (L72-77) 中添加新类型：

```python
class PluginType(str, Enum):
    CALCULATOR = "calculator"
    OPTIMIZER = "optimizer"
    READER = "reader"          # 新增
    ANALYZER = "analyzer"      # 新增 (Phase 2)
    WORKFLOW_NODE = "workflow_node"  # 新增 (Phase 3)
    ROUTER = "router"
```

在文件末尾（L337 之后）添加 `ReaderPlugin` 基类：

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
    reader_id: str = ""               # 唯一标识
    supported_formats: list[str] = [] # 文件扩展名, 如 [".pdos", ".PDOS"]
    output_type: str = ""             # "electronic_dos" | "electronic_bands" | "cohp" | "structure" | "trajectory" | "volumetric"
    multi_file: bool = False          # True if reader needs multiple files (e.g., PROCAR+OUTCAR+POSCAR)
    required_files: list[str] = []    # 如 ["PROCAR"] (可选提示)
    optional_files: list[str] = []    # 如 ["OUTCAR", "POSCAR"]

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

**同步更新**:
- `server/plugins/base.py` 中 `BasePlugin.get_plugin_type()` (L126-134) 添加 `ReaderPlugin` 分支
- `server/plugins/__init__.py` 的 `__all__` 中添加 `"ReaderPlugin"`

### 步骤 2: 扩展 PluginManager 支持 Reader

**文件**: `server/plugins/manager.py`

在 `__init__` (L48-53) 添加 reader 注册表：

```python
def __init__(self):
    self._plugins: dict[str, BasePlugin] = {}
    self._calculator_plugins: dict[str, CalculatorPlugin] = {}
    self._optimizer_plugins: dict[str, OptimizerPlugin] = {}
    self._reader_plugins: dict[str, ReaderPlugin] = {}  # 新增
    self._initialized = False
    self._plugins_dir: Optional[Path] = None
```

在 `_register_plugin()` (L121-149) 添加 reader 分支：

```python
async def _register_plugin(self, plugin: BasePlugin) -> None:
    self._plugins[plugin.name] = plugin

    if isinstance(plugin, CalculatorPlugin):
        # ... 现有代码 ...

    elif isinstance(plugin, OptimizerPlugin):
        # ... 现有代码 ...

    elif isinstance(plugin, ReaderPlugin):  # 新增
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

添加 Reader 查询方法（在 Optimizer Methods 之后）：

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

**同步更新**: `discovery.py` 的 `_find_plugin_class()` (L208-237) 需要在 `issubclass` 检查中添加 `ReaderPlugin`:

```python
# server/plugins/discovery.py L225
if issubclass(obj, (CalculatorPlugin, OptimizerPlugin, ReaderPlugin)):
    plugin_classes.append(obj)
```

### 步骤 3: 添加通用 Reader 上传端点

**文件**: `server/routers/plugins.py`

在现有端点之后添加：

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

**Session 创建辅助函数** (同文件):

```python
def _create_dos_session_from_reader(reader_result: dict) -> dict:
    """将 reader 输出转换为 DOS session（复用现有 dos.py 的 session 机制）。"""
    import numpy as np
    # 延迟导入避免循环依赖
    import sys
    from pathlib import Path
    _ext_dir = Path(__file__).resolve().parent.parent.parent / "extensions" / "dos-analysis"
    if str(_ext_dir) not in sys.path:
        sys.path.insert(0, str(_ext_dir))
    from catgo_dos.io import VaspData

    # 从 reader dict 构造 VaspData
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
    # 保持 POSCAR 顺序（出现顺序）
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

    # 复用 dos.py 的 _create_session
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

### 步骤 4: 将现有 reader 包装为内置 ReaderPlugin

创建 `server/plugins/builtin_readers.py` — 将现有 DOS/COHP/Band reader 包装为 ReaderPlugin，在 PluginManager 初始化时自动注册。

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

**注册 builtin readers** — 修改 `server/plugins/manager.py`:

```python
# 在 initialize() 方法中 (L62-86), discover_plugins() 之后:
async def initialize(self, plugins_dir=None):
    # ... 现有代码 ...
    await self.discover_plugins()

    # 注册内置 reader 插件
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

### 步骤 5: 创建第一个外部 reader 插件: CP2K DOS

**目录**: `plugins/cp2k-dos-reader/`

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

# Import base class — plugin manager adds server/ to sys.path
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

        eigenvalues = all_eigenvalues[0]  # 所有原子共享相同 eigenvalue grid
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

### 验证步骤

```bash
# 1. 确保 builtin readers 注册
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
# 应输出:
# Registered 5 readers:
#   vaspout_h5: ['.h5', '.hdf5'] -> electronic_dos
#   vasp_procar: ['PROCAR'] -> electronic_dos
#   vasprun_bands: ['.xml'] -> electronic_bands
#   lobster_cohp: ['.lobster', 'COHPCAR'] -> cohp
#   cp2k_pdos: ['.pdos'] -> electronic_dos

# 2. 启动后端, 检查 reader 列表
curl http://localhost:8000/api/plugins/readers | python -m json.tool

# 3. 测试统一上传端点 (用现有的 vaspout.h5)
curl -X POST http://localhost:8000/api/plugins/readers/upload \
  -F "files=@test_data/vaspout.h5"
# 应返回: {"reader_id": "vaspout_h5", "output_type": "electronic_dos", "session_id": "...", ...}

# 4. 确认现有端点不受影响
curl -X POST http://localhost:8000/api/dos/upload -F "file=@test_data/vaspout.h5"
# 应正常工作

# 5. pnpm check
pnpm check
```

---

## Phase 2: AnalyzerPlugin 基类

### 设计

AnalyzerPlugin 接收输入数据（结构、session 数据等），执行分析，返回可视化数据。

### 步骤 1: 添加 AnalyzerPlugin 基类

**文件**: `server/plugins/base.py`（在 ReaderPlugin 之后追加）

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
    input_schema: dict = {}    # JSON Schema for validate + UI generation
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

### 步骤 2: 扩展 PluginManager

**文件**: `server/plugins/manager.py`

```python
# __init__ 添加:
self._analyzer_plugins: dict[str, AnalyzerPlugin] = {}

# _register_plugin 添加:
elif isinstance(plugin, AnalyzerPlugin):
    if plugin.analyzer_id in self._analyzer_plugins:
        logger.warning(f"Analyzer ID '{plugin.analyzer_id}' already registered")
    self._analyzer_plugins[plugin.analyzer_id] = plugin
    logger.info(f"Registered analyzer: {plugin.analyzer_id}")

# 添加方法:
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

### 步骤 3: 添加通用分析端点

**文件**: `server/routers/plugins.py`

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

### 步骤 4: 示例插件 — bond-length-histogram

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

### 验证步骤

```bash
# 1. 启动后端，检查 analyzer 列表
curl http://localhost:8000/api/plugins/analyzers

# 2. 运行分析
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
# 应返回: {"analyzer_id": "bond_length_histogram", "output_type": "bar_plot", "data": {"series": [...], ...}}
```

---

## Phase 3: WorkflowNodePlugin

### 问题

`server/utils/workflow_engine.py` 用硬编码 set 分发节点类型：
- `VASP_CALC_NODES` (L34): `{"vasp_relax", "vasp_static", ...}`
- `LOCAL_NODES` (L43): `{"structure_input", "slab_gen", ...}`
- `UNIFIED_CALC_NODES` (L40): `{"geo_opt", "single_point", ...}`

前端 `src/lib/workflow/node-definitions.ts` 中 `NODE_DEFINITIONS` 是静态 Record。

无法通过插件添加新节点类型。

### 步骤 1: 添加 WorkflowNodePlugin 基类

**文件**: `server/plugins/base.py`

```python
class WorkflowNodePlugin(BasePlugin):
    """
    Base class for workflow node plugins.

    A workflow node plugin defines a new computation node type that can be
    used in the visual workflow editor.
    """

    node_type: str = ""         # 唯一节点类型 ID, 如 "lammps_nvt"
    node_category: str = "plugin"  # 在 workflow editor 侧栏中的分类
    execution_mode: str = "local"  # "local" | "hpc"
    node_definition: dict = {}  # 前端 NodeDefinition JSON (label, params, inputs, outputs)

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
            {"structure": {...}, "energy": float, ...} — depends on node type.
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

### 步骤 2: 扩展 PluginManager + workflow_engine

**`server/plugins/manager.py`**:
```python
# __init__:
self._workflow_node_plugins: dict[str, WorkflowNodePlugin] = {}

# _register_plugin:
elif isinstance(plugin, WorkflowNodePlugin):
    self._workflow_node_plugins[plugin.node_type] = plugin
    logger.info(f"Registered workflow node: {plugin.node_type}")

# 方法:
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

**`server/utils/workflow_engine.py`** — 在节点分发逻辑末尾添加 plugin fallback:

找到节点类型分发链（搜索 `if node_type in VASP_CALC_NODES` 或类似 if-elif 链），在最后的 else 之前添加:

```python
# 在 workflow_engine.py 的节点执行分发逻辑中:
from plugins import plugin_manager

# ... 现有 if-elif 链 ...
elif plugin_manager.has_workflow_node(node_type):
    plugin = plugin_manager.get_workflow_node(node_type)
    result = await plugin.execute(
        params=step_params,
        input_structure=input_structure,
        config=run_config.dict() if run_config else {},
    )
    # result 应包含 {"structure": ..., "energy": ..., "status": "completed"}
else:
    logger.error(f"Unknown node type: {node_type}")
    # ...
```

### 步骤 3: 前端动态节点加载

**文件**: `src/lib/workflow/node-definitions.ts`

在文件末尾添加:

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
        // 不覆盖内置节点
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

**`server/routers/plugins.py`** 添加端点:

```python
@router.get("/workflow-nodes")
async def list_workflow_nodes():
    """List all registered workflow node plugins."""
    nodes = plugin_manager.get_all_workflow_nodes()
    return {"nodes": nodes, "total": len(nodes)}
```

### 验证步骤

```bash
# 1. 检查 workflow node 列表 (初始为空)
curl http://localhost:8000/api/plugins/workflow-nodes
# {"nodes": [], "total": 0}

# 2. 创建测试插件后再验证 (略，Phase 3 属于中期目标)
```

---

## Phase 4: MCP 动态工具注册

### 问题

`server/mcp_server.py` L44 的 `TOOLS: list[dict]` 是一个巨大的静态列表（61 个工具）。`handle_list_tools()` (L1326) 直接返回它，`handle_call_tool()` (L1807) 遍历匹配 name。插件添加的 reader/analyzer 无法作为 MCP 工具暴露给 AI。

### 修改方案

**文件**: `server/mcp_server.py`

在 `handle_list_tools()` 中动态追加插件工具：

```python
# server/mcp_server.py

async def handle_list_tools() -> list[Tool]:
    # 现有静态工具
    all_tools = [
        Tool(
            name=t["name"],
            description=t.get("description", ""),
            inputSchema=t.get("inputSchema", {"type": "object", "properties": {}}),
        )
        for t in TOOLS
    ]

    # 动态追加插件工具
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

    # Analyzer plugins → MCP tools
    for analyzer_info in plugin_manager.get_all_analyzers():
        tools.append(Tool(
            name=f"catgo_analyze_{analyzer_info['analyzer_id']}",
            description=f"[Plugin] {analyzer_info['description']}",
            inputSchema=analyzer_info.get("input_schema", {"type": "object", "properties": {}}),
        ))

    # Reader plugins → MCP tools (for reading files from HPC)
    for reader_info in plugin_manager.get_all_readers():
        if reader_info.get("name", "").startswith("builtin-"):
            continue  # 内置 reader 已有对应的专用工具
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

在 `handle_call_tool()` 中添加插件工具分发：

```python
async def handle_call_tool(name: str, arguments: dict | None) -> list[TextContent]:
    arguments = arguments or {}

    # 先检查静态工具列表
    tool_def = None
    for t in TOOLS:
        if t["name"] == name:
            tool_def = t
            break

    if tool_def:
        # ... 现有分发逻辑 ...
        pass

    # 插件工具分发
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

        # 如果没提供 structure，从 viewer 获取当前结构
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

        # 如果输出是 structure，推送到 viewer
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

### 验证步骤

```bash
# 1. 在有 bond-histogram 插件的情况下启动后端
# 2. 启动 MCP server 检查工具列表
echo '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}' | python server/mcp_server.py
# 输出应包含 "catgo_analyze_bond_length_histogram"

# 3. 调用插件工具
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"catgo_analyze_bond_length_histogram","arguments":{"structure":{...},"cutoff":3.5}}}' | python server/mcp_server.py
```

---

## Phase 5: 前端动态 Tab/Panel 注册

### 问题

`src/lib/structure/AnalysisPane.svelte` L14 的 `tab_defs` 是静态数组：

```typescript
const tab_defs: { id: AnalysisTab; label: string }[] = [
  { id: 'electronic', label: 'Electronic' },
  { id: 'md', label: 'MD' },
  { id: 'phase', label: 'Phase' },
  { id: 'structure_analysis', label: 'Structure' },
  { id: 'spectrum', label: 'Spectrum' },
]
```

插件注册的 analyzer 没有对应的前端 tab。

### 修改方案

#### 步骤 1: 动态加载插件 tab

**文件**: `src/lib/structure/AnalysisPane.svelte`

```typescript
// 在 <script> 块中:
import { onMount } from 'svelte'

// 扩展 AnalysisTab 类型
export type AnalysisTab = 'electronic' | 'md' | 'phase' | 'structure_analysis' | 'spectrum' | string

// 静态 tab (不变)
const static_tab_defs: { id: AnalysisTab; label: string }[] = [
  { id: 'electronic', label: 'Electronic' },
  { id: 'md', label: 'MD' },
  { id: 'phase', label: 'Phase' },
  { id: 'structure_analysis', label: 'Structure' },
  { id: 'spectrum', label: 'Spectrum' },
]

// 动态 tab (从后端加载)
let plugin_tab_defs = $state<{ id: string; label: string; plugin_name: string; output_type: string }[]>([])

// 合并
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

#### 步骤 2: 添加通用插件结果渲染组件

**文件**: `src/lib/structure/PluginResultPane.svelte`（新建）

```svelte
<script lang="ts">
  // 通用插件分析结果渲染器
  // 根据 output_type 选择合适的可视化组件

  interface Props {
    analyzer_id: string
    output_type: string
    input_schema: Record<string, any>
    structure: any  // 当前结构
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
      <!-- 使用 D3 或 Plotly 渲染 -->
      <div class="plot-container">
        <!-- 简单 SVG 柱状图渲染器 -->
        {#each result.series || [] as series}
          <p><strong>{series.label}</strong></p>
          <!-- 此处接入现有的 PlotComponent 或简单 SVG -->
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

在 `AnalysisPane.svelte` 的 tab 内容区域添加插件 tab 的渲染:

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

#### 步骤 3: Reader 上传路由集成

**文件**: `src/lib/structure/controllers/file-handlers.ts`

在 `handle_import_file` 函数中，当文件不是已知格式时，尝试通过插件 reader 上传:

```typescript
// 在 file-handlers.ts 的 handle_import_file 中，现有格式检测失败后:

// 尝试插件 reader (统一上传)
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
    // ... 其他 output_type 路由
  }
} catch (e) {
  console.warn('[file-handlers] Plugin reader upload failed:', e)
}
```

### 验证步骤

```bash
# 1. 启动后端 (有 bond-histogram 插件)
# 2. 打开前端，展开 Analysis 面板
# 3. 应看到 5 个内置 tab + "Bond Length Histogram" 插件 tab
# 4. 点击插件 tab → 点击 "Run Analysis" → 应显示柱状图结果
# 5. 拖入 .pdos 文件 → 应自动路由到 CP2K reader → 打开 DOS 分析
```

---

## Phase 6 (远期): AI Tool Builder + 沙箱

### ToolSpec 数据结构

每个插件（无论人写还是 AI 生成）都可以用 ToolSpec 完整描述:

```python
@dataclass
class ToolSpec:
    """Complete specification for a CatGo plugin.

    This is the schema that the AI Tool Builder generates, and the
    static validator + sandbox tester verify.
    """
    id: str                     # 唯一 ID
    tool_type: str              # "reader" | "analyzer" | "calculator" | "workflow_node"
    name: str                   # 显示名
    description: str            # 功能描述
    version: str = "1.0.0"

    # 输入/输出
    input_schema: dict = {}     # JSON Schema
    output_type: str = ""       # output_type 路由键
    output_schema: dict = {}    # 输出 JSON Schema (用于验证)

    # 安全
    permissions: list[str] = [] # ["structure:read", "fs:read", "network:none"]
    is_deterministic: bool = True
    max_execution_time: int = 30  # 秒

    # 测试
    test_cases: list[dict] = [] # [{"input": {...}, "expected_output_type": "bar_plot", "expected_keys": ["series"]}]

    # 代码
    code: str = ""              # Python 源代码
```

### AI 生成流程

```
1. 用户请求: "我想分析 CP2K 的 DOS"

2. Intent Parser (LLM):
   - 输入: 用户请求 + 已注册 reader/analyzer 列表
   - 输出: {"intent": "need_reader", "format": ".pdos", "output_type": "electronic_dos"}

3. Tool Registry 查询:
   - 搜索 reader_id/format 匹配
   - 找到 → 直接使用，跳到步骤 7
   - 未找到 → 步骤 4

4. AI Tool Builder (LLM):
   - 输入: ToolSpec schema + ReaderPlugin 基类 docstring + 格式文档 (如果有) + 测试数据
   - System prompt: 包含所有 output_type 数据契约、ReaderPlugin 接口说明
   - 输出: ToolSpec JSON (含完整 Python 代码)
   - 模型: 使用当前聊天模型 (Claude/Gemini)

5. 静态验证 (AST):
   - 解析 Python AST
   - 禁止列表: os.system, subprocess, eval, exec, __import__, open(写模式)
   - Import 白名单: numpy, scipy, math, json, re, collections, pathlib(只读)
   - 检查: 必须继承 ReaderPlugin/AnalyzerPlugin
   - 检查: 必须实现 read()/analyze() 方法

6. 沙箱测试:
   - 用 subprocess + timeout + resource limits 执行
   - 提供 test_cases 中的输入
   - 验证输出符合 output_schema
   - 验证输出键匹配 expected_keys
   - 超时 / 异常 → 反馈给 LLM 重新生成 (最多 3 次)

7. 注册:
   - 写入 plugins/{id}/plugin.py + catgo-plugin.json
   - 记录到 tools.db (版本、来源、测试结果)
   - plugin_manager.discover_plugins() 重新发现
   - 通知前端刷新 reader/analyzer 列表
   - 通知用户: "已生成 CP2K DOS 读取器，现在可以上传 .pdos 文件了"
```

### 沙箱策略

```python
# server/plugins/sandbox.py

import ast
import subprocess
import sys
import tempfile
from pathlib import Path

# 禁止的 AST 节点/函数
FORBIDDEN_NAMES = {
    "os", "sys", "subprocess", "shutil", "socket", "http",
    "urllib", "requests", "eval", "exec", "compile", "__import__",
    "open",  # 只在写模式禁止
}

# Import 白名单
ALLOWED_IMPORTS = {
    "numpy", "np", "scipy", "math", "json", "re", "collections",
    "dataclasses", "typing", "pathlib", "io", "csv", "struct",
    "ase", "pymatgen",  # 科学计算库
    "plugins",  # CatGo 插件基类
}

def validate_ast(code: str) -> list[str]:
    """静态分析 Python 代码安全性。返回错误列表。"""
    errors = []
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [f"Syntax error: {e}"]

    for node in ast.walk(tree):
        # 检查 import
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

        # 检查危险函数调用
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
    """在受限子进程中执行插件代码并返回结果。"""
    with tempfile.TemporaryDirectory() as tmpdir:
        plugin_file = Path(tmpdir) / "plugin.py"
        plugin_file.write_text(code)

        runner_code = f'''
import json, sys
sys.path.insert(0, {repr(str(Path(__file__).parent.parent))})
sys.path.insert(0, {repr(tmpdir)})

from plugin import *  # noqa

# 找到 plugin 类
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

## 实施顺序和预估

| Phase | 修改文件数 | 新建文件数 | 描述 | 依赖 |
|-------|-----------|-----------|------|------|
| **Phase 0** | 4 | 0 | 修复 calculator 断路: `models/structure.py`, `calculators/base.py`, `routers/optimize.py`, `routers/optimize_ws.py` | 无 |
| **Phase 1** | 4 | 2 | ReaderPlugin 基类 + 通用上传端点 + 内置 reader 包装 + CP2K reader: 修改 `plugins/base.py`, `plugins/manager.py`, `plugins/discovery.py`, `routers/plugins.py`; 新建 `plugins/builtin_readers.py`, `plugins/cp2k-dos-reader/` | Phase 0 |
| **Phase 2** | 2 | 1 | AnalyzerPlugin 基类 + 通用分析端点 + bond-histogram: 修改 `plugins/base.py`, `plugins/manager.py`; 新建 `plugins/bond-histogram/` | Phase 1 |
| **Phase 3** | 3 | 0 | WorkflowNodePlugin + 前后端动态注册: 修改 `plugins/base.py`, `workflow_engine.py`, `node-definitions.ts` | Phase 2 |
| **Phase 4** | 1 | 0 | MCP 动态工具: 修改 `mcp_server.py` | Phase 2 |
| **Phase 5** | 3 | 1 | 前端动态 tab + 文件路由: 修改 `AnalysisPane.svelte`, `file-handlers.ts`, `routers/plugins.py`; 新建 `PluginResultPane.svelte` | Phase 2+4 |
| **Phase 6** | 0 | 2 | AI Tool Builder + sandbox: 新建 `plugins/sandbox.py`, `routers/tool_builder.py` | Phase 1-5 |

### 推荐执行策略

1. **Phase 0** 立即可做，修改量最小（4 文件），风险最低
2. **Phase 1** 是核心基础设施，投入最多但价值最高——建议先完成 ReaderPlugin 基类 + builtin_readers，不急着做 CP2K reader
3. **Phase 2-4** 可以并行开发（它们只共享 base.py 和 manager.py 的修改）
4. **Phase 5** 需要前端修改，建议在 Phase 2 的后端工作完成后开始
5. **Phase 6** 是远期目标，依赖所有前置 Phase 稳定运行

---

## 回归风险和缓解措施

### Phase 0 风险
- **风险**: `CalculatorType` 枚举从必填改为 str 可能导致前端表单验证问题
- **缓解**: 前端 `OptimizationPane.svelte` 的 select 选项仍从 `/api/optimize/calculators` 动态获取，不依赖枚举值
- **测试**: 运行 `pnpm check` + 手动测试 EMT/MACE 优化确认内置 calculator 不受影响

### Phase 1 风险
- **风险**: 内置 reader 包装可能引入延迟导入循环
- **缓解**: `builtin_readers.py` 使用延迟 import（函数内 `import sys; sys.path.insert`）
- **风险**: 统一上传端点的 auto-detect 可能匹配错误 reader（如 .xml 既是 vasprun 又是一般 XML）
- **缓解**: `priority_score()` 机制 + 支持显式 `reader_id` 参数

### Phase 4 风险
- **风险**: MCP 工具数量膨胀，AI 模型可能选不到正确的工具
- **缓解**: 插件工具用 `[Plugin]` 前缀标记，description 清晰描述适用场景

### 全局风险
- **风险**: `plugins/` 目录可能被提交到 git
- **缓解**: 确保 `.gitignore` 包含 `plugins/` (但保留 `examples/plugins/`)
- **风险**: 恶意插件代码
- **缓解**: Phase 6 的 AST 静态分析 + 沙箱；Phase 0-5 阶段只信任手动安装的插件

---

## 附录 A: 现有读取器格式完整清单

### 前端 JS 结构读取器 (parse.ts)

| 函数 | 格式 | 行号 | 检测方式 |
|------|------|------|---------|
| `parse_poscar` | VASP POSCAR/CONTCAR | L125 | 文件名匹配 |
| `parse_xyz` | XYZ, Extended XYZ | L412 | `.xyz` 扩展名 |
| `parse_cif` | CIF | L801 | `.cif` 扩展名 |
| `parse_phonopy_yaml` | phonopy YAML | L1148 | `.yaml` + phonopy 关键字 |
| `parse_lammps_data` | LAMMPS data | L1390 | `.data` / `.lmp` |
| `parse_cp2k` | CP2K input/output | L1702 | `&GLOBAL` 关键字 |
| `parse_optimade_json` | OPTIMADE JSON | L2236 | JSON 内容匹配 |
| `parse_structure_file` (总路由) | 所有上述 | L2035 | 逐一尝试 |

### 前端 JS 轨迹读取器 (trajectory/parse.ts)

| 格式 | 检测方式 | 说明 |
|------|---------|------|
| ASE `.traj` | magic bytes + `.traj` 扩展名 | 二进制 |
| HDF5 `.h5`/`.hdf5` | magic bytes | h5wasm |
| XDATCAR | `XDATCAR_REGEX` | VASP MD |
| 多帧 XYZ | 文本解析 | `.xyz` 多帧 |
| LAMMPS dump | 文本解析 | `ITEM: TIMESTEP` |

### 后端 Python DOS 读取器 (catgo_dos/io.py)

| 函数 | 格式 | 输入 | 输出 |
|------|------|------|------|
| `read_vaspout_h5` | vaspout.h5 | HDF5 文件路径 | VaspData |
| `read_procar` | PROCAR 文本 | PROCAR 文本 + efermi + POSCAR 文本 | VaspData |
| `read_poscar` | POSCAR/CONTCAR 文本 | 文本 | (lattice, frac_pos, types, counts) |
| `extract_efermi_outcar` | OUTCAR 文本 | 文本 | float |

### 后端 Python Band 读取器 (routers/bands.py)

| 方法 | 格式 | 依赖 |
|------|------|------|
| pymatgen `Vasprun()` | vasprun.xml | pymatgen.io.vasp |
| `get_band_structure()` | KPOINTS (可选) | pymatgen |

### 后端 Python COHP 读取器 (catgo_cohp/io.py)

| 函数 | 格式 | 输出 |
|------|------|------|
| `parse_cohpcar` | COHPCAR.lobster | COHPData |
| `parse_icohplist` | ICOHPLIST.lobster | list[ICOHPEntry] |

### 后端 Cube 读取器

| 位置 | 格式 | 说明 |
|------|------|------|
| `src/lib/cube/parse-cube.ts` (前端) | .cube 头部解析 | 原子坐标提取 |
| `server/routers/cube.py` (后端) | .cube 完整解析 | Rust binary `cube-processor` |

---

## 附录 B: 数据契约详细定义

### electronic_dos (VaspData 兼容)

```python
{
    # 必填
    "eigenvalues": list,     # shape (nspin, nkpts, nbands) — 嵌套 list
    "kweights": list[float], # shape (nkpts,) — k 点权重，和为 1
    "efermi": float,         # Fermi 能 (eV)
    "elements": list[str],   # 每个原子的元素符号

    # 可选但推荐
    "projectors": list,      # shape (nspin, nions, nchannels, nkpts, nbands)
                              # 如无投影数据，设为 None 或全零
    "positions": list,       # shape (nions, 3) — Cartesian Angstrom
    "positions_frac": list,  # shape (nions, 3) — fractional coords
    "lattice": list,         # shape (3, 3) — 行向量
    "ion_types": list[str],  # 唯一元素类型
    "ion_counts": list[int], # 每种类型的原子数
}
```

### electronic_bands

```python
{
    # pymatgen 对象（内置 reader 直接传递）
    "_vasprun": Vasprun,            # pymatgen Vasprun 对象
    "_bandstructure": BandStructureSymmLine,  # pymatgen BS 对象

    # 或者纯 dict（外部插件）
    "bands": {
        "up": list,    # shape (nbands, nkpts)
        "down": list,  # shape (nbands, nkpts) or None
    },
    "distance": list[float],    # k-point 累计距离
    "efermi": float,
    "branches": [{"name": "G-X", "start_index": 0, "end_index": 30}, ...],
    "structure": dict,  # pymatgen dict
}
```

### cohp

```python
{
    # pymatgen/lobster 对象（内置 reader）
    "_cohp_data": COHPData,

    # 或者纯 dict（外部插件）
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
            "color": "#ff0000",   # 可选
        },
        # ...
    ],
    "x_label": "X axis label",
    "y_label": "Y axis label",
    "title": "Plot title",  # 可选
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
    "title": "Table title",  # 可选
}
```

### image

```python
{
    "data": "iVBORw0KGgo...",  # base64 编码
    "mime": "image/png",        # MIME 类型
    "width": 800,               # 可选
    "height": 600,              # 可选
}
```

---

## 附录 C: 插件开发者快速入门

### 创建一个 Reader 插件

```bash
# 1. 创建目录
mkdir -p plugins/my-format-reader

# 2. 创建 manifest
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

# 3. 创建插件代码
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
        # 解析文件...
        return {
            "eigenvalues": [...],
            "kweights": [...],
            "efermi": 0.0,
            "projectors": None,
            "elements": ["Fe", "O"],
            # ...
        }
PYEOF

# 4. 重启后端或刷新插件
curl -X POST http://localhost:8000/api/plugins/refresh

# 5. 验证
curl http://localhost:8000/api/plugins/readers
```

### 创建一个 Analyzer 插件

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

## 附录 D: discovery.py 修改详情

`_find_plugin_class()` (L208-237) 当前只查找 `CalculatorPlugin` 和 `OptimizerPlugin` 的子类。需要扩展为支持所有新类型。

**完整修改**:

```python
# server/plugins/discovery.py

from .base import (
    BasePlugin,
    CalculatorPlugin,
    OptimizerPlugin,
    ReaderPlugin,      # 新增
    AnalyzerPlugin,    # 新增
    WorkflowNodePlugin,# 新增
    PluginError,
    PluginLoadError,
    PluginValidationError,
)

# L208-237: _find_plugin_class
def _find_plugin_class(module) -> Optional[Type[BasePlugin]]:
    """Find the main plugin class in a module."""
    # 所有支持的基类
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

同时更新 `_load_plugin_module()` (L185-186) 的错误消息：

```python
raise PluginLoadError(
    f"No plugin class found in {module_path}. "
    "Module must define a class inheriting from "
    "CalculatorPlugin, OptimizerPlugin, ReaderPlugin, AnalyzerPlugin, or WorkflowNodePlugin"
)
```

---

## 附录 E: __init__.py 更新

**文件**: `server/plugins/__init__.py`

```python
from .base import (
    BasePlugin,
    CalculatorPlugin,
    OptimizerPlugin,
    ReaderPlugin,        # 新增
    AnalyzerPlugin,      # 新增
    WorkflowNodePlugin,  # 新增
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
