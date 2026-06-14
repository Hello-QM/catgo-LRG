# CatGo 统一细粒度 API 层规范

**版本：** 1.0.0-draft
**日期：** 2026-02-23
**状态：** 提案

## 概览

本文定义统一的细粒度 API 层，同时服务内置 AI 聊天助手和未来的 MCP（Model Context Protocol）服务器。该 API 为结构操作、结构构建、视图捕获以及多提供商聊天能力提供程序化访问入口。

所有端点均由 FastAPI 后端（`server/main.py`）提供，并通过代码库中统一使用的标准 router 模式注册。

### 设计原则

1. **无状态结构操作** -- 结构端点在请求体中接收完整结构 JSON，并在响应中返回修改后的结构。服务端不保存结构状态。
2. **兼容 pymatgen 的序列化** -- 所有结构载荷都使用 pymatgen 的 `Structure.as_dict()` / `Molecule.as_dict()` 格式，并与 `server/routers/build.py` 中已有的 `StructureInput` 模式保持一致。
3. **统一错误响应** -- 所有错误都返回 `ErrorResponse` 封装。
4. **面向 MCP 就绪** -- 每个端点都可以在不改变语义的前提下封装为 MCP 工具。

### 通用类型

#### ErrorResponse

```json
{
  "error": "string -- human-readable error message",
  "code": "string -- machine-readable error code (e.g. INVALID_INDEX, MISSING_LATTICE)",
  "details": {}  // optional structured details
}
```

HTTP 状态码：`400` 表示校验错误，`422` 表示请求格式错误，`500` 表示服务端错误。

#### Vec3

由 3 个浮点数组成的数组，用于表示三维向量：`[x, y, z]`

```json
[1.234, 5.678, 9.012]
```

#### StructureJSON

结构的 pymatgen 字典序列化形式。这是 `pymatgen.core.Structure.as_dict()` 或 `pymatgen.core.Molecule.as_dict()` 返回的格式，包含：

```json
{
  "@module": "pymatgen.core.structure",
  "@class": "Structure",
  "lattice": {
    "matrix": [[a1,a2,a3],[b1,b2,b3],[c1,c2,c3]],
    "pbc": [true, true, true],
    "a": 5.43, "b": 5.43, "c": 5.43,
    "alpha": 90.0, "beta": 90.0, "gamma": 90.0,
    "volume": 160.1
  },
  "sites": [
    {
      "species": [{"element": "Si", "occu": 1}],
      "abc": [0.0, 0.0, 0.0],
      "xyz": [0.0, 0.0, 0.0],
      "label": "Si",
      "properties": {}
    }
  ],
  "charge": 0
}
```

对于分子体系（无周期性），不存在 `lattice` 键，且 `@class` 为 `"Molecule"`。

---

## 1. 原子操作 -- `/api/structure-ops`

**Router 文件：** `server/routers/structure_ops.py`
**Router 前缀：** `/structure-ops`
**标签：** `["structure-ops"]`

这些端点提供按原子粒度的结构操作能力。它们对应 `src/lib/structure/atom-manipulation.ts` 中的函数，但在服务端通过 pymatgen 执行，以保证前端和后端操作的一致性。

### 1.1 POST `/add-atom`

向结构中添加单个原子。

**请求体：**

```json
{
  "structure": {},           // StructureJSON (required)
  "element": "O",            // string -- element symbol (required)
  "position": [1.2, 3.4, 5.6] // Vec3 -- Cartesian coordinates in Angstroms (required)
}
```

**Pydantic 模型：**

```python
class AddAtomRequest(BaseModel):
    structure: dict                          # pymatgen Structure.as_dict()
    element: str                             # element symbol, e.g. "O", "Fe"
    position: tuple[float, float, float]     # Cartesian [x, y, z] in Angstroms
```

**响应 `200 OK`：**

```json
{
  "structure": {},   // StructureJSON -- modified structure with atom added
  "n_atoms": 17,     // int -- total atom count after addition
  "added_index": 16  // int -- 0-based index of the newly added atom
}
```

**Pydantic 模型：**

```python
class AtomOpResult(BaseModel):
    structure: dict
    n_atoms: int
    added_index: int | None = None
```

**错误：**

| Code | 条件 |
|------|-----------|
| 400 | 元素符号无效 |
| 400 | 无法解析 Structure JSON |

---

### 1.2 POST `/add-atoms`

批量添加多个原子，比重复调用 `/add-atom` 更高效。

**请求体：**

```json
{
  "structure": {},
  "atoms": [
    {"element": "O", "xyz": [1.2, 3.4, 5.6]},
    {"element": "H", "xyz": [2.0, 3.4, 5.6]},
    {"element": "H", "xyz": [0.4, 3.4, 5.6]}
  ]
}
```

**Pydantic 模型：**

```python
class AtomEntry(BaseModel):
    element: str
    xyz: tuple[float, float, float]

class AddAtomsRequest(BaseModel):
    structure: dict
    atoms: list[AtomEntry]  # at least 1
```

**响应 `200 OK`：**

```json
{
  "structure": {},
  "n_atoms": 19,
  "added_indices": [16, 17, 18]  // 0-based indices of all newly added atoms
}
```

**Pydantic 模型：**

```python
class AddAtomsResult(BaseModel):
    structure: dict
    n_atoms: int
    added_indices: list[int]
```

**错误：**

| Code | 条件 |
|------|-----------|
| 400 | atoms 列表为空 |
| 400 | 任一元素符号无效 |

---

### 1.3 POST `/delete-atoms`

根据 site index 删除原子。

**请求体：**

```json
{
  "structure": {},
  "indices": [0, 3, 7]  // 0-based site indices to remove
}
```

**Pydantic 模型：**

```python
class DeleteAtomsRequest(BaseModel):
    structure: dict
    indices: list[int]  # 0-based site indices, at least 1
```

**响应 `200 OK`：**

```json
{
  "structure": {},
  "n_atoms": 13,
  "deleted_count": 3
}
```

**Pydantic 模型：**

```python
class DeleteAtomsResult(BaseModel):
    structure: dict
    n_atoms: int
    deleted_count: int
```

**错误：**

| Code | 条件 |
|------|-----------|
| 400 | 任一 index 越界 |
| 400 | indices 列表为空 |

---

### 1.4 POST `/replace-atom`

替换指定 site index 位置上的元素。

**请求体：**

```json
{
  "structure": {},
  "index": 4,              // 0-based site index
  "new_element": "N"       // replacement element symbol
}
```

**Pydantic 模型：**

```python
class ReplaceAtomRequest(BaseModel):
    structure: dict
    index: int
    new_element: str
```

**响应 `200 OK`：**

```json
{
  "structure": {},
  "n_atoms": 16,
  "old_element": "C",
  "new_element": "N",
  "index": 4
}
```

**Pydantic 模型：**

```python
class ReplaceAtomResult(BaseModel):
    structure: dict
    n_atoms: int
    old_element: str
    new_element: str
    index: int
```

**错误：**

| Code | 条件 |
|------|-----------|
| 400 | index 越界 |
| 400 | new_element 元素符号无效 |

---

### 1.5 POST `/move-atom`

将单个原子移动到指定的绝对笛卡尔坐标位置。

**请求体：**

```json
{
  "structure": {},
  "index": 2,
  "new_position": [3.5, 1.0, 7.2]  // new absolute Cartesian [x,y,z] in Angstroms
}
```

**Pydantic 模型：**

```python
class MoveAtomRequest(BaseModel):
    structure: dict
    index: int
    new_position: tuple[float, float, float]
```

**响应 `200 OK`：**

```json
{
  "structure": {},
  "n_atoms": 16,
  "index": 2,
  "old_position": [1.0, 2.0, 3.0],
  "new_position": [3.5, 1.0, 7.2]
}
```

**Pydantic 模型：**

```python
class MoveAtomResult(BaseModel):
    structure: dict
    n_atoms: int
    index: int
    old_position: list[float]
    new_position: list[float]
```

**错误：**

| Code | 条件 |
|------|-----------|
| 400 | index 越界 |

---

### 1.6 POST `/move-atoms`

按照位移向量平移多个原子。所有指定原子都会按同一个 `[dx, dy, dz]` 平移。

**请求体：**

```json
{
  "structure": {},
  "indices": [0, 1, 2, 3],
  "displacement": [0.0, 0.0, 2.5]  // displacement vector [dx, dy, dz] in Angstroms
}
```

**Pydantic 模型：**

```python
class MoveAtomsRequest(BaseModel):
    structure: dict
    indices: list[int]
    displacement: tuple[float, float, float]
```

**响应 `200 OK`：**

```json
{
  "structure": {},
  "n_atoms": 16,
  "moved_count": 4,
  "displacement": [0.0, 0.0, 2.5]
}
```

**Pydantic 模型：**

```python
class MoveAtomsResult(BaseModel):
    structure: dict
    n_atoms: int
    moved_count: int
    displacement: list[float]
```

**错误：**

| Code | 条件 |
|------|-----------|
| 400 | 任一 index 越界 |
| 400 | indices 列表为空 |

---

## 2. 结构构建 -- `/api/structure-build`

**Router 文件：** `server/routers/structure_build.py`
**Router 前缀：** `/structure-build`
**标签：** `["structure-build"]`

更高层级的结构构建操作，用于从已有结构生成新结构。它们补充已有的 `/api/build` router；后者负责缺陷、应变、掺杂、嵌入和组合取代等构建任务。

### 2.1 POST `/supercell`

沿晶格矢量重复晶胞，生成超胞。

**请求体：**

```json
{
  "structure": {},
  "scaling": [2, 2, 1]   // [na, nb, nc] repetitions along a, b, c
}
```

**Pydantic 模型：**

```python
class SupercellRequest(BaseModel):
    structure: dict
    scaling: tuple[int, int, int]  # each >= 1
```

**响应 `200 OK`：**

```json
{
  "structure": {},
  "n_atoms": 64,
  "scaling": [2, 2, 1],
  "original_n_atoms": 16,
  "formula": "Si64"
}
```

**Pydantic 模型：**

```python
class SupercellResult(BaseModel):
    structure: dict
    n_atoms: int
    scaling: list[int]
    original_n_atoms: int
    formula: str
```

**错误：**

| Code | 条件 |
|------|-----------|
| 400 | 任一缩放因子 < 1 或 > 10 |
| 400 | 结构没有晶格（分子）|
| 400 | 生成结构将超过 10000 个原子 |

**说明：**

- 与已有 `/api/build/supercell` 不同，后者接收类似 `"2x2x2"` 的字符串，并返回带有 structures/labels 数组的 `BuildResult`。本端点直接接收整数数组并返回单个结构结果，更适合程序化调用和 AI 工具使用。
- 已有的 `/api/build/supercell` 端点会保留，以兼容工作流 UI。

---

### 2.2 POST `/slab`

沿指定 Miller 指数晶面，从体相结构切割表面 slab。

**请求体：**

```json
{
  "structure": {},
  "miller": [1, 1, 0],        // Miller indices [h, k, l]
  "thickness": 3,              // number of atomic layers (int) or thickness in Angstroms (float)
  "vacuum": 15.0,              // vacuum thickness in Angstroms
  "center_slab": true,         // optional, default true -- center slab in vacuum
  "primitive": true,           // optional, default true -- reduce to primitive cell
  "max_normal_search": 1,      // optional, default 1 -- max index for normal search
  "symmetrize": false          // optional, default false -- enforce inversion symmetry
}
```

**Pydantic 模型：**

```python
class SlabRequest(BaseModel):
    structure: dict
    miller: tuple[int, int, int]
    thickness: float                   # layers (int) or Angstroms (float)
    vacuum: float = 15.0              # Angstroms
    center_slab: bool = True
    primitive: bool = True
    max_normal_search: int = 1
    symmetrize: bool = False
```

**响应 `200 OK`：**

```json
{
  "structure": {},
  "n_atoms": 32,
  "miller": [1, 1, 0],
  "thickness_angstroms": 8.45,
  "vacuum_angstroms": 15.0,
  "formula": "Si32",
  "surface_area": 29.54,
  "n_terminations": 1,
  "termination_index": 0
}
```

**Pydantic 模型：**

```python
class SlabResult(BaseModel):
    structure: dict
    n_atoms: int
    miller: list[int]
    thickness_angstroms: float
    vacuum_angstroms: float
    formula: str
    surface_area: float
    n_terminations: int
    termination_index: int
```

**错误：**

| Code | 条件 |
|------|-----------|
| 400 | Miller 指数全为零 |
| 400 | 结构没有晶格 |
| 400 | thickness <= 0 或 vacuum < 0 |
| 400 | 生成的 slab 超过 10000 个原子 |

**实现说明：**

内部使用 `pymatgen.core.surface.SlabGenerator`：

```python
from pymatgen.core.surface import SlabGenerator
slabgen = SlabGenerator(
    structure, miller_index=req.miller,
    min_slab_size=req.thickness, min_vacuum_size=req.vacuum,
    center_slab=req.center_slab, primitive=req.primitive,
    max_normal_search=req.max_normal_search,
)
slabs = slabgen.get_slabs(symmetrize=req.symmetrize)
```

---

### 2.3 POST `/merge`

合并两个结构。待并入结构会被放置在基底结构内部或相对基底结构的指定位置。如果基底结构具有晶格，则保留该晶格；否则结果为分子。

**请求体：**

```json
{
  "base": {},                 // StructureJSON -- base structure (lattice preserved)
  "incoming": {},             // StructureJSON -- structure to merge in
  "position": [5.0, 5.0, 12.0], // Vec3 -- Cartesian position for center of incoming
  "mode": "preserve_lattice"  // optional: "preserve_lattice" (default) | "to_molecule"
}
```

**Pydantic 模型：**

```python
class MergeRequest(BaseModel):
    base: dict
    incoming: dict
    position: tuple[float, float, float]
    mode: str = "preserve_lattice"  # "preserve_lattice" | "to_molecule"
```

**响应 `200 OK`：**

```json
{
  "structure": {},
  "n_atoms": 48,
  "n_base_atoms": 32,
  "n_incoming_atoms": 16,
  "has_lattice": true
}
```

**Pydantic 模型：**

```python
class MergeResult(BaseModel):
    structure: dict
    n_atoms: int
    n_base_atoms: int
    n_incoming_atoms: int
    has_lattice: bool
```

**错误：**

| Code | 条件 |
|------|-----------|
| 400 | base 和 incoming 都为空 |
| 400 | mode 值无效 |

**实现说明：**

该行为对应 `src/lib/structure/atom-manipulation.ts` 中的 `merge_structures()` 和 `concatenate_structures()` 函数。当 `mode="preserve_lattice"` 时使用 `merge_structures` 语义；当 `mode="to_molecule"` 时使用 `concatenate_structures` 语义。

---

## 3. 视图捕获 -- `/api/view`

**Router 文件：** `server/routers/view.py`
**Router 前缀：** `/view`
**标签：** `["view"]`

这些端点与前端三维查看器交互，用于捕获截图并查询当前查看器状态。它们需要已连接的前端客户端；后端在其中充当中继。

### 架构说明

截图和选择相关端点在后端与前端之间使用 request-reply 模式：

1. 后端接收 API 请求。
2. 后端向共享消息总线发布命令（SSE 通道或 WebSocket）。
3. 前端执行命令（例如捕获 canvas），并通过 POST 返回结果。
4. 后端将结果返回给原始 API 调用方。

用于 MCP 服务器时，前端必须处于运行并已连接状态。

---

### 3.1 POST `/screenshot`

向前端三维查看器请求截图。

**请求体：**

```json
{
  "width": 1920,        // optional, default 1920 -- pixel width
  "height": 1080,       // optional, default 1080 -- pixel height
  "format": "png",      // optional, default "png" -- "png" | "jpeg" | "webp"
  "quality": 0.92,      // optional, default 0.92 -- JPEG/WebP quality (0-1)
  "transparent": false,  // optional, default false -- transparent background
  "camera": null        // optional -- override camera: {rotation: [x,y,z], zoom: float}
}
```

**Pydantic 模型：**

```python
class ScreenshotRequest(BaseModel):
    width: int = 1920
    height: int = 1080
    format: str = "png"           # "png" | "jpeg" | "webp"
    quality: float = 0.92
    transparent: bool = False
    camera: dict | None = None    # optional camera override
```

**响应 `200 OK`：**

```json
{
  "image": "iVBORw0KGgoAAAANSUhEUg...",  // base64-encoded image data
  "format": "png",
  "width": 1920,
  "height": 1080,
  "size_bytes": 245760
}
```

**Pydantic 模型：**

```python
class ScreenshotResult(BaseModel):
    image: str          # base64-encoded image
    format: str
    width: int
    height: int
    size_bytes: int
```

**错误：**

| Code | 条件 |
|------|-----------|
| 503 | 没有已连接的前端客户端 |
| 504 | 前端在超时时间内未响应（10 秒）|
| 400 | format 或 dimensions 无效 |

---

### 3.2 GET `/structure-info`

获取前端查看器中当前加载结构的元数据。

**查询参数：** 无。

**响应 `200 OK`：**

```json
{
  "formula": "TiO2",
  "reduced_formula": "TiO2",
  "n_atoms": 6,
  "elements": ["Ti", "O"],
  "element_counts": {"Ti": 2, "O": 4},
  "has_lattice": true,
  "lattice": {
    "a": 4.593, "b": 4.593, "c": 2.959,
    "alpha": 90.0, "beta": 90.0, "gamma": 90.0,
    "volume": 62.42,
    "matrix": [[4.593,0,0],[0,4.593,0],[0,0,2.959]]
  },
  "symmetry": {
    "space_group": "P4_2/mnm",
    "space_group_number": 136,
    "crystal_system": "tetragonal",
    "point_group": "4/mmm"
  },
  "sites": [
    {
      "index": 0,
      "element": "Ti",
      "xyz": [0.0, 0.0, 0.0],
      "abc": [0.0, 0.0, 0.0],
      "label": "Ti"
    }
  ],
  "density": 4.23,
  "is_molecule": false
}
```

**Pydantic 模型：**

```python
class LatticeInfo(BaseModel):
    a: float
    b: float
    c: float
    alpha: float
    beta: float
    gamma: float
    volume: float
    matrix: list[list[float]]

class SymmetryInfo(BaseModel):
    space_group: str
    space_group_number: int
    crystal_system: str
    point_group: str

class SiteInfo(BaseModel):
    index: int
    element: str
    xyz: list[float]
    abc: list[float]
    label: str

class StructureInfoResult(BaseModel):
    formula: str
    reduced_formula: str
    n_atoms: int
    elements: list[str]
    element_counts: dict[str, int]
    has_lattice: bool
    lattice: LatticeInfo | None
    symmetry: SymmetryInfo | None
    sites: list[SiteInfo]
    density: float | None
    is_molecule: bool
```

**错误：**

| Code | 条件 |
|------|-----------|
| 503 | 没有已连接的前端客户端 |
| 404 | 当前未加载结构 |

---

### 3.3 GET `/selection`

获取三维查看器中当前选中的原子。

**查询参数：** 无。

**响应 `200 OK`：**

```json
{
  "selected_indices": [0, 3, 7],
  "n_selected": 3,
  "selected_atoms": [
    {"index": 0, "element": "Ti", "xyz": [0.0, 0.0, 0.0], "label": "Ti1"},
    {"index": 3, "element": "O",  "xyz": [1.45, 1.45, 0.0], "label": "O1"},
    {"index": 7, "element": "O",  "xyz": [3.14, 3.14, 1.48], "label": "O4"}
  ],
  "has_selection": true
}
```

**Pydantic 模型：**

```python
class SelectedAtom(BaseModel):
    index: int
    element: str
    xyz: list[float]
    label: str

class SelectionResult(BaseModel):
    selected_indices: list[int]
    n_selected: int
    selected_atoms: list[SelectedAtom]
    has_selection: bool
```

**错误：**

| Code | 条件 |
|------|-----------|
| 503 | 没有已连接的前端客户端 |

---

## 4. 多提供商聊天 -- `/api/chat`

**Router 文件：** `server/routers/chat.py`（增强已有 router）
**Router 前缀：** `/chat`
**标签：** `["chat"]`

在已有 chat router 上增加 OpenAI 兼容端点支持（用于 DeepSeek、Qwen、Kimi、Ollama 和其他提供商）、CLI agent 启动，以及 provider 发现能力。

### 4.1 POST `/stream`（已有 -- 保留）

已有的 Anthropic 和 OpenAI provider SSE 流式端点，保持不变。

**请求体：**（不变）

```json
{
  "messages": [
    {"role": "user", "content": "What is this structure?"}
  ],
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "temperature": 0.3,
  "max_tokens": 2048,
  "system": "You are a materials science assistant."
}
```

**响应：** `data: {"text": "..."}` 事件组成的 SSE 流，以 `data: [DONE]` 结束。

---

### 4.2 POST `/stream-openai-compat`

OpenAI 兼容的 chat completions 端点，适用于任何实现 OpenAI API 格式的 provider，包括 DeepSeek、Qwen、Kimi、Ollama（本地）、OpenRouter、Together AI 等。

**请求体：**

```json
{
  "messages": [
    {"role": "system", "content": "You are a materials science assistant."},
    {"role": "user", "content": "Describe the crystal structure of TiO2 rutile."}
  ],
  "provider": "deepseek",
  "model": "deepseek-chat",
  "temperature": 0.3,
  "max_tokens": 2048,
  "tools": null,
  "tool_choice": null,
  "base_url": null,
  "api_key": null
}
```

**Pydantic 模型：**

```python
class OpenAICompatMessage(BaseModel):
    role: str       # "system" | "user" | "assistant" | "tool"
    content: str | list | None = None
    name: str | None = None
    tool_calls: list[dict] | None = None
    tool_call_id: str | None = None

class OpenAICompatRequest(BaseModel):
    messages: list[OpenAICompatMessage]
    provider: str = "deepseek"    # provider key for URL/key lookup
    model: str = "deepseek-chat"
    temperature: float = 0.3
    max_tokens: int = 2048
    tools: list[dict] | None = None       # OpenAI function-calling tools
    tool_choice: str | dict | None = None # "auto" | "none" | {"type":"function","function":{"name":"..."}}
    base_url: str | None = None           # override provider URL
    api_key: str | None = None            # override provider API key
```

**Provider 解析：**

如果没有显式提供，端点会根据 `provider` 字段解析 `base_url` 和 `api_key`：

| provider | base_url | API key 环境变量 |
|----------|----------|---------------------|
| `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `qwen` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` |
| `kimi` | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` |
| `ollama` | `http://localhost:11434/v1` | （无需） |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `together` | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `custom` | （必须提供 `base_url`） | （必须提供 `api_key`） |

**响应：** OpenAI 格式的 SSE 流：

```
data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"TiO2"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

服务端会将其规范化为前端使用的 CatGo 内部格式：

```
data: {"text": "TiO2"}
data: {"tool_call": {"id": "call_abc", "name": "toggle_atoms", "arguments": "{\"visible\":false}"}}
data: [DONE]
```

**错误：**

| Code | 条件 |
|------|-----------|
| 400 | provider 未知且未提供 base_url |
| 401 | API key 缺失或无效 |
| 502 | 上游 provider 返回错误 |

---

### 4.3 POST `/stream-cli-agent`

以子进程方式启动基于 CLI 的 AI agent（Claude Code、Gemini CLI、Codex CLI），并流式返回其结构化输出。这支持能够调用 CatGo 工具的长时程 agent 工作流。

**请求体：**

```json
{
  "agent": "claude",
  "prompt": "Optimize the TiO2 slab and report the surface energy.",
  "model": null,
  "context": {
    "structure_json": {},
    "working_directory": "/tmp/catgo-work",
    "available_tools": ["add_atom", "delete_atoms", "supercell", "screenshot"]
  },
  "timeout": 300,
  "max_turns": 20
}
```

**Pydantic 模型：**

```python
class CLIAgentContext(BaseModel):
    structure_json: dict | None = None
    working_directory: str = "/tmp/catgo-work"
    available_tools: list[str] | None = None

class CLIAgentRequest(BaseModel):
    agent: str                     # "claude" | "gemini" | "codex"
    prompt: str
    model: str | None = None       # agent-specific model override
    context: CLIAgentContext | None = None
    timeout: int = 300             # max seconds
    max_turns: int = 20
```

**Agent 解析：**

| agent | command | 默认模型 |
|-------|---------|---------------|
| `claude` | `claude --output-format stream-json` | （默认） |
| `gemini` | `gemini` | `gemini-2.5-pro` |
| `codex` | `codex --quiet` | `o4-mini` |

**响应：** 结构化事件组成的 SSE 流：

```
data: {"type": "thinking", "text": "I need to first create a slab..."}
data: {"type": "text", "text": "I'll create a (001) slab of TiO2."}
data: {"type": "tool_use", "name": "supercell", "input": {"structure": {}, "scaling": [2,2,1]}}
data: {"type": "tool_result", "name": "supercell", "output": {"structure": {}, "n_atoms": 48}}
data: {"type": "text", "text": "The supercell has been created with 48 atoms."}
data: {"type": "done", "usage": {"input_tokens": 1200, "output_tokens": 450}}
data: [DONE]
```

**事件的 Pydantic 模型：**

```python
class AgentStreamEvent(BaseModel):
    type: str      # "thinking" | "text" | "tool_use" | "tool_result" | "error" | "done"
    text: str | None = None
    name: str | None = None          # tool name (for tool_use / tool_result)
    input: dict | None = None        # tool input (for tool_use)
    output: dict | str | None = None # tool output (for tool_result)
    usage: dict | None = None        # token usage (for done)
```

**错误：**

| Code | 条件 |
|------|-----------|
| 400 | agent 未知 |
| 404 | PATH 中未找到 agent CLI |
| 504 | agent 超时 |
| 500 | agent 进程崩溃 |

---

### 4.4 GET `/providers`

列出所有可用 AI provider 及其当前状态。

**查询参数：** 无。

**响应 `200 OK`：**

```json
{
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "type": "api",
      "available": true,
      "has_api_key": true,
      "models": [
        {"id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4", "context_window": 200000},
        {"id": "claude-opus-4-20250514", "name": "Claude Opus 4", "context_window": 200000}
      ],
      "supports_tools": true,
      "supports_vision": true,
      "endpoint": "/api/chat/stream"
    },
    {
      "id": "openai",
      "name": "OpenAI",
      "type": "api",
      "available": true,
      "has_api_key": true,
      "models": [
        {"id": "gpt-4o", "name": "GPT-4o", "context_window": 128000},
        {"id": "o3", "name": "o3", "context_window": 200000}
      ],
      "supports_tools": true,
      "supports_vision": true,
      "endpoint": "/api/chat/stream"
    },
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "type": "openai-compat",
      "available": true,
      "has_api_key": true,
      "models": [
        {"id": "deepseek-chat", "name": "DeepSeek V3", "context_window": 65536},
        {"id": "deepseek-reasoner", "name": "DeepSeek R1", "context_window": 65536}
      ],
      "supports_tools": true,
      "supports_vision": false,
      "endpoint": "/api/chat/stream-openai-compat"
    },
    {
      "id": "ollama",
      "name": "Ollama (Local)",
      "type": "openai-compat",
      "available": false,
      "has_api_key": true,
      "models": [],
      "supports_tools": false,
      "supports_vision": false,
      "endpoint": "/api/chat/stream-openai-compat",
      "status_message": "Ollama not running at localhost:11434"
    },
    {
      "id": "claude-cli",
      "name": "Claude Code (CLI Agent)",
      "type": "cli-agent",
      "available": true,
      "has_api_key": true,
      "models": [],
      "supports_tools": true,
      "supports_vision": true,
      "endpoint": "/api/chat/stream-cli-agent"
    }
  ]
}
```

**Pydantic 模型：**

```python
class ModelInfo(BaseModel):
    id: str
    name: str
    context_window: int

class ProviderInfo(BaseModel):
    id: str
    name: str
    type: str                     # "api" | "openai-compat" | "cli-agent"
    available: bool
    has_api_key: bool
    models: list[ModelInfo]
    supports_tools: bool
    supports_vision: bool
    endpoint: str
    status_message: str | None = None

class ProvidersResult(BaseModel):
    providers: list[ProviderInfo]
```

**检测逻辑：**

- **API providers：** 检查环境变量是否存在（例如 `ANTHROPIC_API_KEY`）。
- **Ollama：** 尝试以 2 秒超时请求 `GET http://localhost:11434/api/tags`。
- **CLI agents：** 通过 `shutil.which()` 检查二进制文件是否存在于 `PATH`。

---

## 5. AI 工具定义 -- 前端

**文件：** `src/lib/chat/tools.ts`

以下工具定义应添加到 `tools.ts` 的 `TOOL_DEFINITIONS` 数组中。每个工具都可以由 AI 聊天助手调用，并映射到上文定义的某个 API 端点。

### 5.1 已有工具（保留）

`tools.ts` 中当前已有工具保持不变：

- `toggle_atoms` -- 显示/隐藏原子
- `toggle_bonds` -- 显示/隐藏键
- `toggle_unit_cell` -- 显示/隐藏晶胞
- `toggle_labels` -- 显示/隐藏标签
- `toggle_force_vectors` -- 显示/隐藏力矢量
- `reset_camera` -- 重置相机位置
- `set_rotation` -- 设置视图旋转
- `select_atoms` -- 按 index 选择原子
- `select_by_element` -- 按元素选择原子
- `clear_selection` -- 清除选择
- `set_atom_radius` -- 设置原子显示尺寸
- `set_bond_color` -- 设置键颜色

### 5.2 新工具：`add_atom`

```typescript
{
  name: `add_atom`,
  description: `Add a single atom to the structure at a specified Cartesian position.`,
  input_schema: {
    type: `object`,
    properties: {
      element: {
        type: `string`,
        description: `Element symbol (e.g. "O", "Fe", "Li").`,
      },
      position: {
        type: `array`,
        items: { type: `number` },
        minItems: 3,
        maxItems: 3,
        description: `Cartesian coordinates [x, y, z] in Angstroms.`,
      },
    },
    required: [`element`, `position`],
  },
}
```

**调用：** `POST /api/structure-ops/add-atom`
**执行器行为：** 从 Svelte store 读取当前结构，将其和参数一起发送到 API，然后用返回的结构更新 store。

---

### 5.3 新工具：`add_atoms`

```typescript
{
  name: `add_atoms`,
  description: `Add multiple atoms to the structure in a single operation. More efficient than repeated add_atom calls.`,
  input_schema: {
    type: `object`,
    properties: {
      atoms: {
        type: `array`,
        items: {
          type: `object`,
          properties: {
            element: { type: `string`, description: `Element symbol.` },
            xyz: {
              type: `array`,
              items: { type: `number` },
              minItems: 3,
              maxItems: 3,
              description: `Cartesian coordinates [x, y, z] in Angstroms.`,
            },
          },
          required: [`element`, `xyz`],
        },
        description: `Array of atoms to add.`,
      },
    },
    required: [`atoms`],
  },
}
```

**调用：** `POST /api/structure-ops/add-atoms`

---

### 5.4 新工具：`delete_atoms`

```typescript
{
  name: `delete_atoms`,
  description: `Delete atoms from the structure by their 0-based site indices.`,
  input_schema: {
    type: `object`,
    properties: {
      indices: {
        type: `array`,
        items: { type: `integer` },
        description: `0-based site indices of atoms to delete.`,
      },
    },
    required: [`indices`],
  },
}
```

**调用：** `POST /api/structure-ops/delete-atoms`

---

### 5.5 新工具：`replace_atom`

```typescript
{
  name: `replace_atom`,
  description: `Replace the element of a specific atom (substitution). Keeps the atom at the same position but changes its element.`,
  input_schema: {
    type: `object`,
    properties: {
      index: {
        type: `integer`,
        description: `0-based site index of the atom to replace.`,
      },
      new_element: {
        type: `string`,
        description: `New element symbol (e.g. "N", "Fe").`,
      },
    },
    required: [`index`, `new_element`],
  },
}
```

**调用：** `POST /api/structure-ops/replace-atom`

---

### 5.6 新工具：`move_atom`

```typescript
{
  name: `move_atom`,
  description: `Move a single atom to a new absolute Cartesian position.`,
  input_schema: {
    type: `object`,
    properties: {
      index: {
        type: `integer`,
        description: `0-based site index of the atom to move.`,
      },
      new_position: {
        type: `array`,
        items: { type: `number` },
        minItems: 3,
        maxItems: 3,
        description: `New Cartesian coordinates [x, y, z] in Angstroms.`,
      },
    },
    required: [`index`, `new_position`],
  },
}
```

**调用：** `POST /api/structure-ops/move-atom`

---

### 5.7 新工具：`move_atoms`

```typescript
{
  name: `move_atoms`,
  description: `Translate multiple atoms by a displacement vector. All specified atoms are shifted by the same [dx, dy, dz].`,
  input_schema: {
    type: `object`,
    properties: {
      indices: {
        type: `array`,
        items: { type: `integer` },
        description: `0-based site indices of atoms to move.`,
      },
      displacement: {
        type: `array`,
        items: { type: `number` },
        minItems: 3,
        maxItems: 3,
        description: `Displacement vector [dx, dy, dz] in Angstroms.`,
      },
    },
    required: [`indices`, `displacement`],
  },
}
```

**调用：** `POST /api/structure-ops/move-atoms`

---

### 5.8 新工具：`make_supercell`

```typescript
{
  name: `make_supercell`,
  description: `Create a supercell by repeating the unit cell along lattice vectors. Only works on periodic structures.`,
  input_schema: {
    type: `object`,
    properties: {
      scaling: {
        type: `array`,
        items: { type: `integer`, minimum: 1, maximum: 10 },
        minItems: 3,
        maxItems: 3,
        description: `Number of repetitions along [a, b, c] lattice vectors.`,
      },
    },
    required: [`scaling`],
  },
}
```

**调用：** `POST /api/structure-build/supercell`

---

### 5.9 新工具：`cut_slab`

```typescript
{
  name: `cut_slab`,
  description: `Cut a surface slab from a bulk crystal along a Miller index plane. Adds vacuum layer for surface calculations.`,
  input_schema: {
    type: `object`,
    properties: {
      miller: {
        type: `array`,
        items: { type: `integer` },
        minItems: 3,
        maxItems: 3,
        description: `Miller indices [h, k, l] defining the surface plane.`,
      },
      thickness: {
        type: `number`,
        description: `Slab thickness: integer for number of layers, float for Angstroms.`,
      },
      vacuum: {
        type: `number`,
        description: `Vacuum thickness in Angstroms (default: 15).`,
        default: 15.0,
      },
    },
    required: [`miller`, `thickness`],
  },
}
```

**调用：** `POST /api/structure-build/slab`

---

### 5.10 新工具：`merge_structures`

```typescript
{
  name: `merge_structures`,
  description: `Merge another structure (e.g. adsorbate, molecule) into the current structure at a specified position.`,
  input_schema: {
    type: `object`,
    properties: {
      incoming_structure: {
        type: `object`,
        description: `The structure to merge in (pymatgen dict format).`,
      },
      position: {
        type: `array`,
        items: { type: `number` },
        minItems: 3,
        maxItems: 3,
        description: `Cartesian position [x, y, z] for the center of the incoming structure.`,
      },
    },
    required: [`incoming_structure`, `position`],
  },
}
```

**调用：** `POST /api/structure-build/merge`
**执行器行为：** 当前结构作为 `base`；工具输入中的 `incoming_structure` 作为 `incoming` 发送。

---

### 5.11 新工具：`take_screenshot`

```typescript
{
  name: `take_screenshot`,
  description: `Capture a screenshot of the current 3D structure view. Returns a base64-encoded image.`,
  input_schema: {
    type: `object`,
    properties: {
      width: {
        type: `integer`,
        description: `Image width in pixels (default: 1920).`,
        default: 1920,
      },
      height: {
        type: `integer`,
        description: `Image height in pixels (default: 1080).`,
        default: 1080,
      },
    },
  },
}
```

**调用：** `POST /api/view/screenshot`

---

### 5.12 新工具：`get_structure_info`

```typescript
{
  name: `get_structure_info`,
  description: `Get detailed information about the currently loaded structure: formula, atom count, lattice parameters, symmetry, density.`,
  input_schema: {
    type: `object`,
    properties: {},
  },
}
```

**调用：** `GET /api/view/structure-info`

---

### 5.13 新工具：`get_selection`

```typescript
{
  name: `get_selection`,
  description: `Get the currently selected atoms in the 3D viewer, including their indices, elements, and positions.`,
  input_schema: {
    type: `object`,
    properties: {},
  },
}
```

**调用：** `GET /api/view/selection`

---

## 附录 A：Router 注册

新 router 应按已有模式注册到 `server/routers/__init__.py` 和 `server/main.py` 中：

### `server/routers/__init__.py` 新增内容

```python
from .structure_ops import router as structure_ops_router
from .structure_build import router as structure_build_router
from .view import router as view_router

__all__ = [
    # ... existing entries ...
    "structure_ops_router",
    "structure_build_router",
    "view_router",
]
```

### `server/main.py` 新增内容

```python
from routers import (
    # ... existing imports ...
    structure_ops_router,
    structure_build_router,
    view_router,
)

# ... after existing include_router calls ...
app.include_router(structure_ops_router, prefix="/api")
app.include_router(structure_build_router, prefix="/api")
app.include_router(view_router, prefix="/api")
```

这会生成如下完整端点路径：

| Router 前缀 | + endpoint | = 完整路径 |
|---------------|-----------|-------------|
| `/structure-ops` | `/add-atom` | `/api/structure-ops/add-atom` |
| `/structure-ops` | `/add-atoms` | `/api/structure-ops/add-atoms` |
| `/structure-ops` | `/delete-atoms` | `/api/structure-ops/delete-atoms` |
| `/structure-ops` | `/replace-atom` | `/api/structure-ops/replace-atom` |
| `/structure-ops` | `/move-atom` | `/api/structure-ops/move-atom` |
| `/structure-ops` | `/move-atoms` | `/api/structure-ops/move-atoms` |
| `/structure-build` | `/supercell` | `/api/structure-build/supercell` |
| `/structure-build` | `/slab` | `/api/structure-build/slab` |
| `/structure-build` | `/merge` | `/api/structure-build/merge` |
| `/view` | `/screenshot` | `/api/view/screenshot` |
| `/view` | `/structure-info` | `/api/view/structure-info` |
| `/view` | `/selection` | `/api/view/selection` |
| `/chat` | `/stream` | `/api/chat/stream`（已有） |
| `/chat` | `/stream-openai-compat` | `/api/chat/stream-openai-compat` |
| `/chat` | `/stream-cli-agent` | `/api/chat/stream-cli-agent` |
| `/chat` | `/providers` | `/api/chat/providers` |

---

## 附录 B：MCP 服务器映射

每个 API 端点都直接映射到一个 MCP 工具。MCP 服务器（未来的 `server/mcp.py`）会通过 MCP 协议暴露这些工具：

| MCP 工具名 | API 端点 | 输入 Schema 来源 |
|---------------|-------------|---------------------|
| `catgo_add_atom` | `POST /api/structure-ops/add-atom` | `AddAtomRequest` |
| `catgo_add_atoms` | `POST /api/structure-ops/add-atoms` | `AddAtomsRequest` |
| `catgo_delete_atoms` | `POST /api/structure-ops/delete-atoms` | `DeleteAtomsRequest` |
| `catgo_replace_atom` | `POST /api/structure-ops/replace-atom` | `ReplaceAtomRequest` |
| `catgo_move_atom` | `POST /api/structure-ops/move-atom` | `MoveAtomRequest` |
| `catgo_move_atoms` | `POST /api/structure-ops/move-atoms` | `MoveAtomsRequest` |
| `catgo_supercell` | `POST /api/structure-build/supercell` | `SupercellRequest` |
| `catgo_slab` | `POST /api/structure-build/slab` | `SlabRequest` |
| `catgo_merge` | `POST /api/structure-build/merge` | `MergeRequest` |
| `catgo_screenshot` | `POST /api/view/screenshot` | `ScreenshotRequest` |
| `catgo_structure_info` | `GET /api/view/structure-info` | (none) |
| `catgo_selection` | `GET /api/view/selection` | (none) |
| `catgo_providers` | `GET /api/chat/providers` | (none) |

MCP 工具统一使用 `catgo_` 前缀，以避免在多服务器 MCP 配置中发生命名冲突。

---

## 附录 C：工具执行器接线

前端（`src/lib/chat/tools.ts`）中的 `ToolExecutor` 函数应扩展以处理这些新工具。服务端支撑工具的模式与现有纯客户端工具不同：

```typescript
// Existing client-only tools (toggle_atoms, set_rotation, etc.)
// execute directly on the Svelte store / Three.js scene.

// New server-backed tools call the API and update the store:
async function executeServerTool(
  name: string,
  input: Record<string, unknown>,
  currentStructure: AnyStructure,
): Promise<string> {
  const endpoint = TOOL_ENDPOINT_MAP[name]
  if (!endpoint) throw new Error(`Unknown tool: ${name}`)

  const body = endpoint.buildBody(input, currentStructure)
  const response = await fetch(endpoint.url, {
    method: endpoint.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const error = await response.json()
    return `Error: ${error.error}`
  }

  const result = await response.json()

  // Update the structure store if the result contains a structure
  if (result.structure) {
    structureStore.set(result.structure)
  }

  return JSON.stringify(result)
}
```

**工具端点映射：**

```typescript
const TOOL_ENDPOINT_MAP: Record<string, {url: string, method: string, buildBody: Function}> = {
  add_atom: {
    url: `/api/structure-ops/add-atom`,
    method: `POST`,
    buildBody: (input, structure) => ({
      structure: structure, element: input.element, position: input.position
    }),
  },
  add_atoms: {
    url: `/api/structure-ops/add-atoms`,
    method: `POST`,
    buildBody: (input, structure) => ({
      structure: structure, atoms: input.atoms
    }),
  },
  delete_atoms: {
    url: `/api/structure-ops/delete-atoms`,
    method: `POST`,
    buildBody: (input, structure) => ({
      structure: structure, indices: input.indices
    }),
  },
  replace_atom: {
    url: `/api/structure-ops/replace-atom`,
    method: `POST`,
    buildBody: (input, structure) => ({
      structure: structure, index: input.index, new_element: input.new_element
    }),
  },
  move_atom: {
    url: `/api/structure-ops/move-atom`,
    method: `POST`,
    buildBody: (input, structure) => ({
      structure: structure, index: input.index, new_position: input.new_position
    }),
  },
  move_atoms: {
    url: `/api/structure-ops/move-atoms`,
    method: `POST`,
    buildBody: (input, structure) => ({
      structure: structure, indices: input.indices, displacement: input.displacement
    }),
  },
  make_supercell: {
    url: `/api/structure-build/supercell`,
    method: `POST`,
    buildBody: (input, structure) => ({
      structure: structure, scaling: input.scaling
    }),
  },
  cut_slab: {
    url: `/api/structure-build/slab`,
    method: `POST`,
    buildBody: (input, structure) => ({
      structure: structure, miller: input.miller,
      thickness: input.thickness, vacuum: input.vacuum ?? 15.0
    }),
  },
  merge_structures: {
    url: `/api/structure-build/merge`,
    method: `POST`,
    buildBody: (input, structure) => ({
      base: structure, incoming: input.incoming_structure, position: input.position
    }),
  },
  take_screenshot: {
    url: `/api/view/screenshot`,
    method: `POST`,
    buildBody: (input) => ({
      width: input.width ?? 1920, height: input.height ?? 1080
    }),
  },
  get_structure_info: {
    url: `/api/view/structure-info`,
    method: `GET`,
    buildBody: () => null,
  },
  get_selection: {
    url: `/api/view/selection`,
    method: `GET`,
    buildBody: () => null,
  },
}
```

---

## 附录 D：与已有端点的关系

该 API 层与已有 router 共存，并不替代它们。

| 已有 Router | 前缀 | 关系 |
|----------------|--------|-------------|
| `build_router` | `/api/build` | **保留。** 新的 `/api/structure-build` 为 AI 工具提供更简单的单结构端点，而 `/api/build` 继续以 `BuildResult`（多结构 + labels）格式服务工作流 UI。 |
| `chat_router` | `/api/chat` | **增强。** 保留已有 `/stream` 端点，并在同一个 router 中新增 `/stream-openai-compat`、`/stream-cli-agent`、`/providers`。 |
| `adsorption_router` | `/api/adsorption` | **保留。** 吸附位点查找器是专用算法，不在新 API 中重复实现。AI 可通过其已有端点调用。 |
| `heterostructure_router` | `/api/heterostructure` | **保留。** 复杂界面匹配仍放在其专用 router 中。 |

---

## 附录 E：前端/后端双执行策略

对于原子操作（第 1 节），同一套逻辑同时存在于：

- **前端：** `src/lib/structure/atom-manipulation.ts`（TypeScript，即时反馈，无需服务端往返）
- **后端：** `server/routers/structure_ops.py`（Python/pymatgen，权威实现，可被 MCP 访问）

策略如下：

1. **交互式 UI** -- 直接使用前端函数，提供即时反馈（拖拽、键盘移动）。
2. **AI 聊天工具** -- 调用后端 API 以保证一致性，并让 AI agent 的工具调用路径保持简单（单次 HTTP 请求）。
3. **MCP 服务器** -- 只调用后端 API。

由于数学处理（笛卡尔坐标到分数坐标转换、位移应用）一致，两条路径会产生相同结果。
