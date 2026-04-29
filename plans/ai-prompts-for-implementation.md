# CatGo 统一插件系统 — AI 实施 Prompts

## 使用说明

每个 prompt 可以直接复制给 AI 助手（如 Claude Code），AI 读取指定文件后即可独立完成实施。

**Prompt 之间有顺序依赖**：Phase 0 → Phase 1 → Phase 2 → Phase 3/4/5（3/4/5 可并行）。

**约定**：
- 所有文件路径相对于项目根目录 `d:/catgo/`
- 后端代码在 `server/` 目录下，使用 Python + FastAPI
- 前端代码在 `src/` 目录下，使用 Svelte 5 (runes) + TypeScript
- 插件目录在项目根的 `plugins/` 目录下
- 插件清单文件为 `catgo-plugin.json`，入口为 `plugin.py`

---

## Prompt 0: 修复 Calculator 插件断路

```
你是 CatGo 项目的开发者。请修复 Calculator 插件系统的断路问题。

## 背景

CatGo 已有一个插件框架 (server/plugins/)，支持 CalculatorPlugin 类型。PluginManager 能发现、
加载、注册插件。但优化路由 optimize.py 和 optimize_ws.py 直接调用 server/calculators/base.py
中的 get_calculator() 工厂函数，这个函数只查内置枚举 CalculatorType（EMT/XTB/MACE/CHGNET/M3GNET），
完全忽略 plugin_manager 注册表。

## 断路调用链

用户选择 calculator_type="lennard_jones"（一个插件 calculator）
  → optimize.py L121: calc_wrapper = get_calculator(request.calculator, ...)
    → calculators/base.py L74: if calc_type not in calculators: raise ValueError(...)
    → 抛出 "Calculator 'lennard_jones' not available"

从未走到:
  → plugin_manager.get_calculator("lennard_jones")
    → plugins/manager.py L283: self._calculator_plugins["lennard_jones"]
    → 返回 LennardJonesPlugin.get_calculator()

## 请先读取以下文件

1. `server/calculators/base.py` — get_calculator() 工厂函数 (L35-98)。注意它接受 CalculatorType 枚举，
   内部 dict 映射枚举值到 Calculator 类。如果 calc_type 不在 dict 中，直接 raise ValueError。

2. `server/routers/optimize.py` — 两个调用点:
   - L121: `calc_wrapper = get_calculator(request.calculator, request.calculator_params)` — /optimize/structure 端点
   - L258: `calc_wrapper = get_calculator(request.calculator, request.calculator_params)` — /optimize/energy 端点
   - L84-106: list_calculators() — 只遍历 CalculatorType 枚举

3. `server/routers/optimize_ws.py` — WebSocket 优化:
   - 同样导入 `from calculators import get_calculator`
   - 同样只接受 CalculatorType 枚举

4. `server/plugins/manager.py` — PluginManager 类:
   - L269-291: get_calculator(calculator_id, **kwargs) — 从 _calculator_plugins 获取
   - L293-295: has_calculator(calculator_id) — 检查是否存在
   - L315-320: get_all_calculators() — 返回所有插件 calculator 信息

5. `server/plugins/base.py` — CalculatorPlugin 基类:
   - L179-270: 定义 calculator_id, supported_elements, get_calculator(), supports_structure()
   - 注意 CalculatorPlugin.get_calculator() 返回 ASE Calculator，但 calculators/base.py
     的 BaseCalculator.get_calculator() 也返回 ASE Calculator — 接口兼容

6. `server/models/structure.py` — CalculatorType 枚举 (L11-18):
   - CalculatorType(str, Enum): EMT, XTB, MACE, CHGNET, M3GNET

7. `examples/plugins/lennard-jones-calculator/plugin.py` — 参考插件实现

## 任务

### 1. 修改 server/calculators/base.py 的 get_calculator() (L35-98)

将 calc_type 参数类型从 `CalculatorType` 改为 `CalculatorType | str`。

逻辑改为:
a) 如果 calc_type 是 CalculatorType 枚举成员，走现有逻辑查内置 dict
b) 如果不在内置 dict 中（或 calc_type 是普通 str），fallback 到 plugin_manager:
   ```python
   from plugins import plugin_manager

   calc_type_str = calc_type.value if isinstance(calc_type, CalculatorType) else str(calc_type)

   if plugin_manager.has_calculator(calc_type_str):
       # CalculatorPlugin 的 get_calculator() 直接返回 ASE Calculator
       # 需要包装成 BaseCalculator 接口
       plugin = plugin_manager._calculator_plugins[calc_type_str]

       class _PluginWrapper(BaseCalculator):
           name = plugin.display_name
           description = plugin.description
           supported_elements = plugin.supported_elements
           def get_calculator(self):
               return plugin.get_calculator(**kwargs_from_params)

       return _PluginWrapper()
   ```
c) 两者都失败才 raise ValueError，错误消息包含插件 calculators

注意: CalculatorPlugin.get_calculator(**kwargs) 接受任意 kwargs，
但 BaseCalculator 的消费者（optimize.py）通过 calc_wrapper.get_calculator()
无参调用。需要在 wrapper 中把 params 传递进去。

### 2. 修改 optimize.py 的 list_calculators() (L84-106)

当前只遍历 CalculatorType 枚举。改为：遍历枚举后，追加 plugin_manager.get_all_calculators()
返回的插件 calculator（标记 is_plugin=true）。

### 3. 确保 optimize_ws.py 走同一个工厂函数

optimize_ws.py 也 `from calculators import get_calculator`，与 optimize.py 相同。
只要 calculators/base.py 的 get_calculator() 支持 str 类型的 calc_type，
WebSocket 路径就自动修复。

但需要检查 WSOptimizationRequest 模型中 calculator 字段类型是否允许插件 id。
如果是 CalculatorType 枚举，需要改为 `CalculatorType | str`。

### 4. 修改 models/structure.py 的请求模型

- OptimizationRequest.calculator 字段: 从 `CalculatorType` 改为 `str`
  （或 `CalculatorType | str`，Pydantic v2 支持 Union 类型）
- WSOptimizationRequest.calculator 字段: 同上
- 保持前端已有的 CalculatorType 枚举值仍然可用

## 验证步骤

1. 运行 `cd server && python -c "from calculators.base import get_calculator; print('import ok')"` — 无 import 错误
2. 将 examples/plugins/lennard-jones-calculator/ 复制到项目根 plugins/ 目录:
   `cp -r examples/plugins/lennard-jones-calculator plugins/`
3. 启动后端: `python server/main.py`
4. POST http://localhost:8000/api/plugins/refresh — 应发现 lennard-jones 插件
5. GET http://localhost:8000/api/plugins/calculators — 应返回 lennard_jones
6. GET http://localhost:8000/api/optimize/calculators — 应包含 lennard_jones（is_plugin=true）
7. 用一个 Ar2 分子测试 POST /api/optimize/structure，calculator="lennard_jones" — 应返回优化结果
```

---

## Prompt 1: 实现 ReaderPlugin 基类

```
你是 CatGo 项目的开发者。请实现统一的 ReaderPlugin 文件读取插件接口。

## 背景

CatGo 有 20+ 种文件格式的读取器，分散在多个位置:
- extensions/dos-analysis/catgo_dos/io.py — VASP HDF5 + PROCAR 读取
- extensions/cohp-analysis/catgo_cohp/io.py — LOBSTER COHP 文件读取
- server/routers/dos.py — 通过 sys.path.insert 硬编码导入
- server/routers/cohp.py — 同上

每增加一个新格式（如 CP2K PDOS），需要手动修改 6+ 个文件。ReaderPlugin 的目标是：
- 新格式只需放一个插件目录到 plugins/ 即可
- 自动注册 REST 端点
- 自动创建 session（DOS/COHP/Bands 共用 session 模式）
- 前端无需改动

## 请先读取以下文件

1. `server/plugins/base.py` — 理解 BasePlugin 基类 (L103-172) 和 CalculatorPlugin 模式 (L179-270)
   注意: PluginType 枚举在 L72-77，目前只有 CALCULATOR/OPTIMIZER/ROUTER

2. `server/plugins/discovery.py` — 理解 _find_plugin_class() (L208-237):
   当前只搜索 CalculatorPlugin 和 OptimizerPlugin 子类，新增 ReaderPlugin 后需要加入搜索

3. `server/plugins/manager.py` — 理解注册和获取逻辑:
   - _register_plugin() (L121-149): isinstance 判断后注册到对应 dict
   - 需要新增 _reader_plugins dict 和对应的注册/查询方法

4. `server/routers/plugins.py` — 理解 REST 端点模式:
   - GET /api/plugins/calculators (L115-137) — 列出所有 calculator 插件
   - POST /api/plugins/refresh (L268-288) — 重新发现插件

5. `extensions/dos-analysis/catgo_dos/io.py` — VaspData 数据类 (L33-68):
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
   这是 DOS session 的核心数据结构。ReaderPlugin 产出的数据需要兼容此格式。

6. `server/routers/dos.py` — 理解 session 和 upload 模式:
   - DOSSession 数据类 (L39-45): 持有 VaspData + source 标签
   - _sessions dict (L48): session_id → DOSSession 的内存缓存
   - _create_session() (L122-146): 创建 session 并返回 DOSUploadResponse
   - upload_h5 端点 (L149-177): 上传 HDF5 → read_vaspout_h5() → _create_session()
   - upload_procar 端点 (L179+): 上传 PROCAR → read_procar() → _create_session()
   - 注意: session 创建后，前端用 session_id 调用 /api/dos/compute 计算 PDOS

## 任务

### 1. 在 server/plugins/base.py 中添加 ReaderPlugin 基类

在 OptimizerPlugin 之后添加:

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
                # Parse .pdos files → return VaspData-compatible dict
                return { "eigenvalues": ..., "kweights": ..., ... }

            def detect_file(self, filename, content_preview=None):
                return filename.endswith(".pdos")
    """

    # Reader-specific attributes
    reader_id: str                       # API 标识 (e.g., "cp2k_pdos")
    supported_formats: list[str]         # 文件扩展名列表 (e.g., [".pdos", ".pdos.1"])
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

### 2. 在 PluginType 枚举 (L72-77) 中添加

```python
READER = "reader"
```

### 3. 修改 BasePlugin.get_plugin_type() (L126-134)

添加 ReaderPlugin 分支:
```python
elif issubclass(cls, ReaderPlugin):
    return PluginType.READER
```

### 4. 修改 discovery.py 的 _find_plugin_class() (L208-237)

在 L222 的 import 中添加 ReaderPlugin:
```python
from .base import BasePlugin, CalculatorPlugin, OptimizerPlugin, ReaderPlugin
```

在 L225 的 issubclass 检查中添加 ReaderPlugin:
```python
if issubclass(obj, (CalculatorPlugin, OptimizerPlugin, ReaderPlugin)):
```

### 5. 在 manager.py 中添加 Reader 相关方法

在 __init__ 中添加:
```python
self._reader_plugins: dict[str, ReaderPlugin] = {}  # reader_id -> plugin
```

在 _register_plugin() 中添加 ReaderPlugin 分支（参考 CalculatorPlugin 的模式）。

新增方法:
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

### 6. 在 routers/plugins.py 中添加端点

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

其中 _create_dos_session_from_reader() 复用 dos.py 的 _create_session 模式:
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

### 7. 创建示例 CP2K DOS reader 插件

创建目录: `plugins/cp2k-dos-reader/`

文件 `plugins/cp2k-dos-reader/catgo-plugin.json`:
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

文件 `plugins/cp2k-dos-reader/plugin.py`:
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
        # 3. Multiple .pdos files → merge by atom kind
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

## 验证步骤

1. 检查 import 无误:
   ```bash
   cd server && python -c "from plugins.base import ReaderPlugin; print('ReaderPlugin ok')"
   cd server && python -c "from plugins.manager import plugin_manager; print(plugin_manager._reader_plugins)"
   ```

2. 启动后端 → POST /api/plugins/refresh → 应发现 cp2k-dos-reader

3. GET /api/plugins/readers → 应返回:
   ```json
   {"readers": [{"id": "cp2k_pdos", "supported_formats": [".pdos"], ...}], "total": 1}
   ```

4. GET /api/plugins/ → 应包含 cp2k-dos-reader，plugin_type="reader"

5. 不影响现有功能: 现有的 H5/PROCAR 上传路径不受影响
```

---

## Prompt 2: 实现 AnalyzerPlugin 基类

```
你是 CatGo 项目的开发者。请实现 AnalyzerPlugin 分析工具插件接口。

## 背景

CatGo 的分析功能（DOS、d-band、COHP 等）全部硬编码在 server/routers/ 中。新增分析工具
需要改动大量文件。AnalyzerPlugin 让用户通过插件添加自定义分析功能（如 bond histogram、
RDF 分析、Bader charge 可视化等），前端自动渲染结果。

## 前置条件

Phase 1（ReaderPlugin）已完成，server/plugins/base.py 中已有 ReaderPlugin 基类。

## 请先读取以下文件

1. `server/plugins/base.py` — 理解现有基类模式。Phase 1 已添加 ReaderPlugin。
   注意 PluginType 枚举、BasePlugin.get_plugin_type()、validate() 模式。

2. `server/plugins/discovery.py` — _find_plugin_class() (L208-237):
   Phase 1 已添加 ReaderPlugin 到 issubclass 检查，需要再加 AnalyzerPlugin。

3. `server/plugins/manager.py` — _register_plugin() 路由和 dict 注册模式。
   Phase 1 已添加 _reader_plugins，需要再加 _analyzer_plugins。

4. `server/routers/plugins.py` — REST 端点模式。
   Phase 1 已添加 /readers 和 /readers/upload，需要再加 /analyzers 和 /{name}/analyze。

5. `src/lib/plot/types.ts` — 前端数据格式（参考数据契约）:
   - DataSeries (L88-112): { x: number[], y: number[], label?: string, ... }
   - BarSeries (L265-282): { x: number[], y: number[], label?: string, color?: string, ... }
   - AxisConfig (L285-297): { label?: string, format?: string, scale_type?: "linear" | "log", ... }
   分析插件的输出需要符合这些格式，前端才能直接渲染。

## 任务

### 1. 在 base.py 中添加 AnalyzerPlugin

在 ReaderPlugin 之后添加:

```python
class AnalyzerPlugin(BasePlugin):
    """
    Base class for analysis tool plugins.

    Analyzer plugins take structured input (typically a structure + parameters)
    and produce visualization data (plots, tables, images).

    The output_type determines which frontend renderer is used:
    - "scatter_plot": DataSeries-compatible output → ScatterPlot component
    - "bar_plot": BarSeries-compatible output → BarPlot component
    - "table": Tabular data → HTML table
    - "image": Base64 image → <img> tag
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
    analyzer_id: str                # API 标识 (e.g., "bond_histogram")
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

### 2. 在 PluginType 枚举中添加

```python
ANALYZER = "analyzer"
```

### 3. 更新 BasePlugin.get_plugin_type()

添加 AnalyzerPlugin 分支。

### 4. 更新 discovery.py

在 _find_plugin_class() 的 issubclass 检查中添加 AnalyzerPlugin。

### 5. 在 manager.py 中添加

```python
self._analyzer_plugins: dict[str, AnalyzerPlugin] = {}  # analyzer_id -> plugin
```

以及 _register_plugin() 中的 AnalyzerPlugin 分支、get_all_analyzers() 方法。

### 6. 在 routers/plugins.py 中添加端点

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

### 7. 创建示例 bond-histogram 插件

创建 `plugins/bond-histogram/catgo-plugin.json`:
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

创建 `plugins/bond-histogram/plugin.py`:
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

## 验证步骤

1. `cd server && python -c "from plugins.base import AnalyzerPlugin; print('ok')"`
2. 启动后端 → POST /api/plugins/refresh → 应发现 bond-histogram
3. GET /api/plugins/analyzers → 应返回 bond_histogram 信息
4. 用一个 pymatgen structure dict 测试:
   ```bash
   curl -X POST http://localhost:8000/api/plugins/bond_histogram/analyze \
     -H "Content-Type: application/json" \
     -d '{"structure": <pymatgen_dict>, "n_bins": 20, "max_distance": 3.5}'
   ```
   应返回 bar_plot 格式的数据
5. 检查返回的 series.x 和 series.y 是 number[] 数组
```

---

## Prompt 3: 实现 WorkflowNodePlugin

```
你是 CatGo 项目的开发者。请实现 WorkflowNodePlugin 工作流节点插件。

## 背景

CatGo 的工作流系统有两层:
- 前端: src/lib/workflow/node-definitions.ts 定义所有节点类型的 UI 元数据
  （label, icon, category, param_schema 等），WorkflowEditor.svelte 渲染 SVG 图
- 后端: server/utils/workflow_engine.py 执行工作流节点，用硬编码的 set
  (VASP_CALC_NODES, LOCAL_NODES, BUILD_NODES, ANALYSIS_NODES 等) 分发到不同处理逻辑

新增节点类型需要同时修改前后端硬编码。WorkflowNodePlugin 让用户通过插件添加自定义节点。

## 前置条件

Phase 2（AnalyzerPlugin）已完成。

## 请先读取以下文件

1. `server/plugins/base.py` — 当前已有 BasePlugin, CalculatorPlugin, OptimizerPlugin,
   ReaderPlugin, AnalyzerPlugin。

2. `src/lib/workflow/workflow-types.ts` — 关键类型定义:
   - NodeDefinition (L31-50): 节点 UI 定义
     ```typescript
     interface NodeDefinition {
       type: string          // 唯一标识 (e.g., "geo_opt")
       label: string         // 显示名称
       color: string         // 节点颜色 (hex)
       icon: string          // emoji 图标
       category: string      // 侧栏分类 ("Calculation", "Tools", "Analysis", etc.)
       description: string
       inputs: string[]      // 输入端口类型 (e.g., ["structure"])
       outputs: string[]     // 输出端口类型 (e.g., ["structure", "energy"])
       default_params: Record<string, unknown>
       param_schema?: ParamDef[]  // 参数面板字段定义
     }
     ```
   - ParamDef (L16-29): 参数定义
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
   - NODE_DEFINITIONS: Record<string, NodeDefinition> (L353) — 静态节点注册表
   - get_sidebar_categories() (L2066-2081) — 构建侧栏分类
   - 注意 L1428 的 on_drop(): `if (!type || !NODE_DEFINITIONS[type]) return`
     — 如果 type 不在 NODE_DEFINITIONS 中，drop 会被静默忽略

4. `src/lib/workflow/WorkflowEditor.svelte` — on_drop() (L1425-1446):
   ```typescript
   function on_drop(e: DragEvent) {
     const type = e.dataTransfer?.getData('nodeType')
     if (!type || !NODE_DEFINITIONS[type]) return  // ← 守卫: 必须在 NODE_DEFINITIONS 中
     const cfg = NODE_DEFINITIONS[type]
     // ... 创建节点
   }
   ```
   后续需要把 plugin nodes 合并进 NODE_DEFINITIONS 或修改守卫。

5. `server/utils/workflow_engine.py` — 节点执行分发:
   - VASP_CALC_NODES (L34-37): set of vasp 节点类型
   - UNIFIED_CALC_NODES (L40): set of 统一计算节点
   - LOCAL_NODES (L43-47): 本地执行节点
   - BUILD_NODES (L65-70): 结构构建节点
   - ANALYSIS_NODES (L85-88): 分析节点
   - 执行分发 (L457-478): if/elif 链判断 node_type 属于哪个 set
   - 最后的 else 分支 (L478+): 提交到 HPC
   - 没有 "未知节点类型" 的 fallback 到插件

## 任务

### 1. 在 base.py 中添加 WorkflowNodePlugin

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

    node_type: str                    # 唯一节点类型 ID (e.g., "custom_md")
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

### 2. 在 PluginType 枚举添加

```python
WORKFLOW_NODE = "workflow_node"
```

### 3. 更新 discovery.py, manager.py 同前几个 Phase 的模式

manager.py 新增:
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

### 4. 在 routers/plugins.py 中添加

```python
@router.get("/workflow-nodes")
async def list_workflow_node_plugins():
    """List all workflow node plugins and their definitions."""
    nodes = plugin_manager.get_all_workflow_nodes()
    return {"nodes": nodes, "total": len(nodes)}
```

### 5. 修改 workflow_engine.py 的执行分发

在 L478 的最后一个 elif（HPC 提交节点）之后、结尾之前，添加插件 fallback:

```python
elif node_type in plugin_manager._workflow_node_plugins:
    # Plugin node — execute via plugin
    plugin = plugin_manager._workflow_node_plugins[node_type]
    if plugin.execution_mode == "local":
        await self._execute_plugin_node(
            workflow_id, node_id, plugin, params,
            edges, step_results, config,
        )
    else:
        # HPC plugin nodes — future support
        logger.warning(f"HPC plugin nodes not yet supported: {node_type}")
```

新增 _execute_plugin_node() 方法:
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

### 6. 修改前端 node-definitions.ts

在文件末尾添加:

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

### 7. 修改 WorkflowEditor.svelte

在 onMount 或初始化逻辑中，调用 load_plugin_nodes():

```typescript
import { load_plugin_nodes } from './node-definitions'
import { API_BASE } from '$lib/api/config'

onMount(async () => {
  await load_plugin_nodes(API_BASE)
  // ... existing onMount logic
})
```

注意: 因为 load_plugin_nodes() 直接修改 NODE_DEFINITIONS 对象（mutation），
on_drop() 的 `NODE_DEFINITIONS[type]` 检查会自动通过。

## 验证步骤

1. 后端:
   - `cd server && python -c "from plugins.base import WorkflowNodePlugin; print('ok')"`
   - POST /api/plugins/refresh
   - GET /api/plugins/workflow-nodes → 返回插件节点定义列表

2. 前端:
   - `pnpm check` 无新类型错误
   - 打开工作流编辑器，在侧栏看到插件节点（如果已有插件的话）
   - 拖入插件节点 → 应正常创建节点（不被 on_drop 守卫拦截）

3. 端到端:
   - 创建一个简单的测试插件节点（echo 结构，不做实际计算）
   - 拖入工作流图 → 运行工作流 → 节点执行成功
```

---

## Prompt 4: MCP 动态工具注册

```
你是 CatGo 项目的开发者。请实现 MCP 工具的动态注册，让插件自动成为 MCP 工具。

## 背景

CatGo 的 MCP server (server/mcp_server.py) 通过 TOOLS 列表定义所有可用工具。
每个工具映射到一个 FastAPI 端点。新增工具需要手动在 TOOLS 列表添加条目 + handle_call_tool 处理。

目标: 让已注册的 AnalyzerPlugin 和 ReaderPlugin 自动成为 MCP 工具，AI 助手可以直接调用。

## 前置条件

Phase 2（AnalyzerPlugin）已完成。server/plugins/base.py 中有 AnalyzerPlugin,
manager.py 中有 _analyzer_plugins 注册表。

## 请先读取以下文件

1. `server/mcp_server.py` — 完整阅读，重点:
   - TOOLS 列表 (L44 开始): 每个工具是一个 dict:
     ```python
     {
         "name": "catgo_xxx",
         "description": "...",
         "endpoint": "/path/to/endpoint",
         "method": "POST",
         "inputSchema": { "type": "object", "properties": {...}, "required": [...] },
     }
     ```
   - handle_list_tools() (L1326-1334): 遍历 TOOLS 生成 MCP Tool 对象。
     注意 _strip_structure_from_schema() — 移除 inputSchema 中的 "structure" 属性
     （因为 handle_call_tool 会自动注入当前 viewer 的结构）
   - handle_call_tool() (L1807+):
     1. 在 TOOLS 中找到 tool_def
     2. 如果 endpoint 以 "__special__/" 开头，调用 _handle_special_tool()
     3. 否则: 自动注入 structure → POST/GET 到 FastAPI 端点 → 自动推送结构到 viewer
     4. 返回 TextContent 文本结果
   - 关键模式: auto-inject structure (L1826-1836) + auto-push result (L1848-1870)

2. `server/plugins/manager.py` — get_all_analyzers(), get_all_readers()

## 任务

### 1. 在 mcp_server.py 启动时，从 plugin_manager 获取插件并生成 TOOLS 条目

在 TOOLS 列表定义之后（但在 handle_list_tools 之前），添加函数:

```python
def _get_plugin_tools() -> list[dict]:
    """Generate MCP tool definitions from registered plugins."""
    from plugins import plugin_manager

    plugin_tools = []

    # Analyzer plugins → MCP tools
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

    # Reader plugins → MCP tools (file-based, less common for MCP but possible)
    # Skip for now — reader plugins typically need file upload, not JSON input

    return plugin_tools
```

### 2. 修改 handle_list_tools() 合并插件工具

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

### 3. 修改 handle_call_tool() 处理插件工具

当 tool_def 为 None（不在 TOOLS 中）时，检查是否是插件工具:

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

### 4. 在 _handle_special_tool() 中添加 plugin_analyze 分支

在 _handle_special_tool() 函数中添加:

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
        pass  # Continue without structure — some analyzers might not need it

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

### 5. 考虑 MCP server 启动时机

mcp_server.py 是独立进程（通过 CLI agent 启动），不经过 FastAPI lifespan。
plugin_manager 可能尚未初始化。需要在 _get_plugin_tools() 中处理这种情况:

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
                    # Can't await in running loop — return empty
                    return []
                else:
                    loop.run_until_complete(plugin_manager.initialize())
            except RuntimeError:
                return []
    except ImportError:
        return []

    # ... rest of the function
```

或者更简单: 让 MCP server 在启动时（main() 之前）同步发现插件:

```python
async def main():
    from plugins import plugin_manager
    await plugin_manager.initialize()

    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, ...)
```

## 验证步骤

1. 启动后端，确保 bond-histogram 插件已注册（Phase 2 的示例）
2. 启动 MCP server: `python server/mcp_server.py` — 无报错
3. 用 Claude Code 连接，`handle_list_tools()` 应包含 `catgo_plugin_bond_histogram`
4. 调用工具: AI 说"分析当前结构的键长分布" → 触发 catgo_plugin_bond_histogram
5. MCP 自动注入当前结构 → 调用分析端点 → 返回文本摘要
```

---

## Prompt 5: 前端动态 Tab 注册

```
你是 CatGo 项目的开发者。请实现分析面板的动态 tab 注册，让 AnalyzerPlugin 自动出现在前端。

## 背景

CatGo 的分析面板 (AnalysisPane.svelte) 有硬编码的 tab_defs:
```typescript
const tab_defs: { id: AnalysisTab; label: string }[] = [
  { id: 'electronic', label: 'Electronic' },
  { id: 'md', label: 'MD' },
  { id: 'phase', label: 'Phase' },
  { id: 'structure_analysis', label: 'Structure' },
  { id: 'spectrum', label: 'Spectrum' },
]
```

目标: 让后端注册的 AnalyzerPlugin 自动添加为新 tab，点击 tab 后显示 "Run Analysis" 按钮，
执行后根据 output_type 选择合适的渲染器显示结果。

## 前置条件

Phase 2（AnalyzerPlugin）已完成。GET /api/plugins/analyzers 返回插件列表。

## 请先读取以下文件

1. `src/lib/structure/AnalysisPane.svelte` — 完整阅读:
   - L12: AnalysisTab 类型 = 'electronic' | 'md' | 'phase' | 'structure_analysis' | 'spectrum'
   - L14-20: tab_defs 静态数组
   - L40-72: props 定义（包括 active_tab = $bindable）
   - 渲染逻辑: {#if active_tab === 'electronic'} ... {/if} 条件分支

2. `src/lib/plot/types.ts` — DataSeries, BarSeries, AxisConfig 类型（Phase 2 已阅读）

3. `src/lib/api/config.ts` — API_BASE 常量
   ```typescript
   export const API_BASE = ...  // e.g., "http://localhost:8000/api"
   ```

## 任务

### 1. 修改 AnalysisTab 类型

从固定联合类型改为可扩展:
```typescript
export type AnalysisTab = 'electronic' | 'md' | 'phase' | 'structure_analysis' | 'spectrum' | `plugin_${string}`
```

### 2. 将 tab_defs 从 const 改为 $state

```typescript
// 基础 tabs（静态）
const base_tab_defs: { id: AnalysisTab; label: string }[] = [
  { id: 'electronic', label: 'Electronic' },
  { id: 'md', label: 'MD' },
  { id: 'phase', label: 'Phase' },
  { id: 'structure_analysis', label: 'Structure' },
  { id: 'spectrum', label: 'Spectrum' },
]

// 合并基础 + 插件 tabs
let tab_defs = $state<{ id: AnalysisTab; label: string }[]>([...base_tab_defs])

// 插件分析器的元数据缓存
interface PluginAnalyzerInfo {
  analyzer_id: string
  display_name: string
  output_type: string
  input_schema: dict
}
let plugin_analyzers = $state<PluginAnalyzerInfo[]>([])
```

### 3. onMount 加载插件分析器

```typescript
import { onMount } from 'svelte'

onMount(async () => {
  try {
    const resp = await fetch(`${API_BASE}/plugins/analyzers`)
    if (!resp.ok) return
    const data = await resp.json()
    if (!data.analyzers) return

    plugin_analyzers = data.analyzers
    // 追加插件 tabs
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

### 4. 添加插件 tab 渲染逻辑

在现有的 {#if active_tab === 'spectrum'} ... {/if} 之后添加:

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

### 5. 创建 PluginAnalyzerTab 组件

创建 `src/lib/structure/PluginAnalyzerTab.svelte`:

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

### 6. 注意事项

- ScatterPlot 和 BarPlot 的导入路径:
  先检查 `src/lib/plot/` 目录中实际的组件文件名。可能是 `ScatterPlot.svelte` 或其他名称。
  用 `ls src/lib/plot/` 确认。

- Structure prop 传递:
  AnalysisPane 已经接收 `structure` prop，直接传递给 PluginAnalyzerTab 即可。

- API_BASE 导入:
  在 AnalysisPane.svelte 中已有 `import { API_BASE } from '$lib/api/config'`（L3）。

- AnalysisPane 的 children snippet:
  注意 AnalysisPane 用 `{@render children?.()}` 渲染子内容。
  Structure.svelte 在 AnalysisPane 的 children 中渲染具体 tab 内容。
  插件 tab 的渲染可以直接放在 AnalysisPane 内部，不需要通过 children。

## 验证步骤

1. `pnpm check` — 无新类型错误

2. 确保后端有至少一个 AnalyzerPlugin（Phase 2 的 bond-histogram）

3. 启动后端 + 前端:
   - `pnpm desktop:serve`（或 `pnpm dev` + 单独启动后端）

4. 打开分析面板（Analysis Pane）:
   - 应看到 5 个基础 tab + 1 个 "Bond Length Histogram" 插件 tab

5. 点击 "Bond Length Histogram" tab:
   - 应看到 "Run Analysis" 按钮
   - 加载一个结构，点击按钮
   - 应显示柱状图（BarPlot 渲染）

6. 无插件时:
   - 如果后端没有分析插件，面板应只显示 5 个基础 tab（不崩溃）

7. 网络错误容忍:
   - 如果后端不可达，onMount fetch 失败应静默处理（只显示基础 tabs）
```

---

## 附录: 完整的 Phase 依赖图

```
Phase 0: Calculator 断路修复
  ↓ (无依赖，可直接开始)
Phase 1: ReaderPlugin 基类
  ↓ (依赖 Phase 0 确认 base.py 模式正确)
Phase 2: AnalyzerPlugin 基类
  ↓ (依赖 Phase 1 的 discovery/manager 模式)
  ├→ Phase 3: WorkflowNodePlugin (依赖 Phase 2 完成 base.py 模式)
  ├→ Phase 4: MCP 动态注册 (依赖 Phase 2 的 AnalyzerPlugin)
  └→ Phase 5: 前端动态 Tab (依赖 Phase 2 的 AnalyzerPlugin)
```

Phase 3、4、5 之间无互相依赖，可以并行实施。
