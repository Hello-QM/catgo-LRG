# server/ — Python 后端踩坑记录

> 这份文档的定位是“后端事故 / bugfix / gotcha 日志”，不是完整接口规范。
> 需要确认当前真实行为时，请优先查看：
> - `server/routers/*.py`
> - `server/mcp_tools/server.py`
> - `server/mcp_tools/server_claude_code.py`
> - `server/models/*.py`
>
> 时效性规则:
> - 带明确日期的条目默认先视为“历史记录”
> - 只有在别处被重新标记为 `open`，才应当把它当作当前未修复问题
> - 当前 workflow / CatBot 仍然有效的未修复问题，请优先看根目录 `WORKFLOW_BUGS.md`

## ORCA 结果解析 (orca_output.py)

### [2026-03-12] 频率和UV-Vis解析修复 ✅

**问题:** ORCA频率(freq)和UV-Vis光谱工作流完成后，结果为空或不显示

**根因:**

1. **OrcaFreqOutput 频率列表解析失败** — `find("\n---", pos)` 匹配到了VIBRATIONAL FREQUENCIES标题后的关闭横线，导致 `freq_section` 只包含2行标题，没有实际频率数据。结果: `frequencies = []`

2. **虚频检测逻辑错误** — 正则模式 `(?:(i)\s+)?cm` 期望在cm前有`i`字符。但ORCA实际使用负值表示虚频（如 `-1192.35 cm**-1`）。导致 `is_imaginary` 始终为False。

3. **UV-Vis错误日志不可见** — 使用 `logger.warning` 使解析错误容易被忽略

**修复:**

1. **改变频率列表终止符** (lines 402-406)
   ```python
   # 之前: end = self.output_text.find("\n---", pos)
   # 之后: end = self.output_text.find("NORMAL MODES", pos)
   ```
   NORMAL MODES标记实际出现在频率列表之后，现在能正确包含所有频率。

2. **虚频检测** (lines 410, 415)
   ```python
   # 之前: freq_pattern = r"(\d+):\s+([-\d.]+)\s+(?:(i)\s+)?cm"
   #      is_imaginary = match.group(3) == 'i'
   # 之后: freq_pattern = r"(\d+):\s+([-\d.]+)\s+cm\*\*-1"
   #      is_imaginary = freq_value < 0
   ```
   现在正确识别ORCA的负值虚频格式。

3. **UV-Vis错误日志** (line 916 in engine.py)
   - 改为 `logger.error(..., exc_info=True)` 显示完整堆栈跟踪

4. **OrcaNebOutput同样修复** (line 163) — NEB-TS频率也用相同方法

**影响:**
- 频率工作流现在解析出全部24个模式 (之前: 0)
- 虚频 (负值) 正确标记
- 前端NodeStatusPanel自动显示频率表格
- UV-Vis解析失败时有清晰的错误日志可追踪

**不会冻结:** 频率解析使用有界切片 (`pos:pos+30000`)，无正则回溯风险。UV-Vis已通过 `results-enriched` 端点的扩展绕过避免冻结。

---

## 插件系统 (plugins/)

### [2026-03-06] MCP 热加载插件系统

**架构:**
```
~/.catgo/plugins/
    orthogonalize_slab.py   ← 放进去就自动生效
    my_custom_tool.py       ← 修改后自动重载
```

每个插件文件导出两个东西：
```python
TOOL_DEF = {
    "name": "catgo_xxx",
    "description": "...",
    "inputSchema": {"type": "object", "properties": {...}}
}

async def handle(arguments: dict, client: httpx.AsyncClient, api_base: str) -> list[TextContent]:
    # 工具逻辑
    ...
```

**实现文件:**
- `server/plugin_loader.py` — 热加载引擎，基于 mtime 扫描 `~/.catgo/plugins/`
- `server/mcp_server.py` — 集成：`handle_list_tools` 追加插件工具，`handle_call_tool` 优先匹配插件

**工作原理:**
- 每次 `list_tools` / `call_tool` 调用时扫描插件目录
- 检查 mtime：新增/修改自动加载，删除自动卸载
- 插件文件用 `importlib.util` 动态加载，不影响 MCP server 启动速度
- pymatgen 等重依赖应放在 `handle()` 内部 lazy import，不要放顶层

**注意:**
- 插件运行在 MCP server 进程中（独立子进程），顶层 import pymatgen 会导致首次调用 30s+ 延迟
- 插件的 `handle()` 接收 `httpx.AsyncClient` + `api_base`，推荐通过 REST API 调用后端处理
- 以 `_` 开头的 `.py` 文件会被跳过

### [2026-03-03] Phase 0: 修复 Calculator 插件断路

**问题:** `optimize.py` 调用 `calculators/base.py` 的 `get_calculator(CalculatorType)` 只接受硬编码枚举值 (EMT/XTB/MACE/CHGNET/M3GNET)。`PluginManager.get_calculator()` 虽能正确获取插件 calculator，但 optimize 路由从未调用它。用户安装插件 calculator 后发 POST 请求会直接被 Pydantic 422 拦截（枚举校验失败）。

**修复 (4 文件):**
1. `models/structure.py` — `OptimizationRequest.calculator` 和 `WSOptimizationRequest.calculator` 从 `CalculatorType` 枚举改为 `str`（默认 `"emt"`），允许任意 calculator_id
2. `calculators/base.py` — `get_calculator()` 参数改为 `CalculatorType | str`，内部统一为 str lookup。内置 dict 不命中时 fallback 到 `plugin_manager.has_calculator()`。新增 `_PluginCalculatorAdapter` 将 `CalculatorPlugin` 适配为 `BaseCalculator` 接口
3. `routers/optimize.py` — `list_calculators()` 增加 plugin_manager 遍历，返回 `is_plugin: true` 标记。修复 `request.calculator.value` → `request.calculator`（已是 str）
4. `routers/optimize_ws.py` — 无需修改（无 `.value` 调用，`get_calculator()` 签名变化自动兼容）

**验证:** 将 `examples/plugins/lennard-jones-calculator/` 复制到 `plugins/`，重启后端 → `GET /api/optimize/calculators` 应包含 `lennard_jones (is_plugin=true)` → `POST /api/optimize/structure` 用 `calculator="lennard_jones"` 可正常优化

**注意:** `CalculatorType` 枚举保留不删 — 前端 UI 用它渲染内置选项。`list_calculators()` 仍遍历枚举列出内置 calc，再追加插件 calc。

## MCP Server (mcp_server.py) — OPTIMADE 集成

### OPTIMADE 化学式格式

**规则:** `chemical_formula_reduced` 要求元素按字母序排列:
- `TiO2` → `O2Ti`
- `Fe2O3` → `Fe2O3` (已按字母序)
- `H2O` → `H2O` (已按字母序)

前端 `optimade.ts` 中已有 `normalize_formula_for_optimade()` 做同样处理。MCP 端用 `_normalize_formula_alphabetical()` 实现。

### Unicode 下标

用户输入的公式可能包含 Unicode 下标字符 (如 TiO₂)。需要用 `str.maketrans("₀₁₂₃₄₅₆₇₈₉", "0123456789")` 转换。

### MCP 工具搜索超时（已修复）

**问题:** MCP 工具通过 FastAPI 后端代理调用 OPTIMADE API 导致嵌套超时:
```
MCP (30s timeout) → httpx → FastAPI → httpx (30s) → OPTIMADE API
```
FastAPI 内部有 `get_providers()` + `resolve_provider_url()` + 实际搜索三层外部 HTTP 调用，每层最多 30 秒。MCP 的 30 秒超时在后端完成前就过期了。

**修复:** MCP 工具直接调用 OPTIMADE API，跳过 FastAPI 代理层:
```
MCP (30s timeout) → httpx → OPTIMADE API（直接）
```
使用 `_OPTIMADE_PROVIDERS` 字典存储已知提供者的 URL，用 `_optimade_search_direct()` / `_optimade_fetch_by_id_direct()` 直接搜索。

### ⚠️ MCP Server 中禁止 import pymatgen（严重）

**问题:** `_optimade_to_pymatgen()` 和 `_pubchem_to_pymatgen()` 中使用了 `from pymatgen.core import Lattice, Structure`。pymatgen 首次 import 在 Windows 上需要 **30+ 秒**（加载大量子模块和数据文件）。Gemini CLI 对 MCP 工具调用有超时限制，import 还没完成工具就被杀了。

**现象:** MCP 日志停在 `[fetch-crystal] got entry id=mp-655656` 之后再无输出。OPTIMADE 搜索成功但结构永远不会加载到 viewer。

**修复:** 手动构建 pymatgen 兼容的 dict，不 import pymatgen：
```python
# 不要这样做:
from pymatgen.core import Lattice, Structure
struct = Structure(lattice, elements, positions, coords_are_cartesian=True)
return struct.as_dict()

# 应该这样做:
return {
    "@module": "pymatgen.core.structure",
    "@class": "Structure",
    "lattice": {"matrix": lattice_vectors, "a": a, "b": b, ...},
    "sites": [{"species": [{"element": el, "occu": 1}], "xyz": xyz, ...}],
}
```

**教训:** MCP Server 是独立进程，每次 Gemini/Claude 启动时冷启动。任何重量级 import（pymatgen, ase, numpy 大模块）都应该避免。用纯 Python 标准库构建数据结构。

### ⚠️ 手动构建 pymatgen dict 必须计算正确的 abc 分数坐标（严重）

**问题:** `_optimade_to_pymatgen()` 手动构建 pymatgen dict 时，sites 的 `abc`（分数坐标）设为 `[0.0, 0.0, 0.0]` 占位符，只提供了正确的 `xyz`（笛卡尔坐标）。

`Structure.from_dict()` 反序列化时**只读取 `abc` 字段**作为分数坐标，完全忽略 `xyz`。结果所有原子都被放在原点 (0,0,0)，结构退化。

**现象:** 结构能正常加载到 viewer（viewer 用 xyz），但后续操作如 `SlabGenerator` 调用 `Structure.from_dict()` 时得到退化结构，报 500 错误且 `detail` 为空。

**修复:** 从笛卡尔坐标和晶格矩阵计算正确的分数坐标：
```python
# frac = cart @ M^{-1}  (M 行向量 = 晶格向量)
inv_lat = _mat3_inverse(lattice_matrix)
frac = [sum(xyz[j] * inv_lat[j][k] for j in range(3)) for k in range(3)]

sites.append({
    "abc": frac,      # ← 必须是正确的分数坐标
    "xyz": list(xyz),  # Cartesian 坐标
    ...
})
```

**教训:** pymatgen `from_dict` 对 `abc` 字段的依赖是硬编码的，不会 fallback 到 `xyz`。手动构建 dict 时，`abc` 的值**必须正确**，不能用占位符。`_mat3_inverse()` 用纯 Python 实现 3×3 矩阵求逆，无需 numpy。

### 调试 MCP 工具

MCP server 通过 stdio 与 CLI 通信，print/logger 输出不会显示给用户。调试时:
- FastAPI 端 (optimade.py) 的 `print()` 会出现在 uvicorn 终端
- MCP 端可以用 `logger` 写文件日志
- 可以直接用 httpx 测试 FastAPI 端点绕过 MCP 层

### MCP Server 插件初始化阻塞 (历史教训)

`mcp_server.py` 的 `handle_list_tools()` 一度在每次调用时通过 `_ensure_plugin_manager()` 初始化 PluginManager，加载 `cp2k-dos-reader` 等重依赖插件需要 10-60 秒，导致 SDK agent 等待 MCP server 的 `list_tools` 响应超时。**修复**：MCP server 跳过插件初始化——插件工具通过后端 REST API 提供，MCP server 只是代理。修复后 `initialize` + `list_tools` 总共 ~0.7 秒。新增 MCP server 工具时不要在 cold-start 路径上引入慢 import。

### SSE 流不能被 GZipMiddleware 缓冲

`GZipMiddleware(minimum_size=1000)` 的 zlib 压缩器会缓冲小数据块以构建高效 gzip 块，阻止 SSE 事件实时 flush。`_SSEAwareGZipMiddleware` 在 `main.py` 中跳过 `/stream` 端点和 `/mcp/`。新增 SSE 端点要确认走的是这个 bypass。

## HPC SSH 连接 (hpc_client.py)

### [2026-03-11] LocalFileConnection Windows 兼容 — Unix shell 命令在 Windows 失败

**问题:** `LocalCommandRunner.run()` 使用 `asyncio.create_subprocess_shell(cmd)` 执行命令。所有文件操作（`read_remote_file`、`write_remote_file`、`mkdir`、`rm`、`mv`、`cp`）通过 `conn.run("head -c ...")` 等 Unix 命令实现。在 Windows 上 `cmd.exe` 不认识 `wc`、`head`、`rm` 等命令，导致 `__local__` 会话的所有文件操作静默失败。

**修复:**
1. `LocalFileConnection` 新增纯 Python 方法：`_resolve_local_path()`, `read_file_content()`, `mkdir_local()`, `delete_local()`, `rename_local()`, `copy_local()`
2. `hpc.py` 路由中检测 `isinstance(hpc, LocalFileConnection)` 时走纯 Python 路径
3. `_resolve_local_path()` 统一处理 `~/` 和 `~\`（Unix + Windows 兼容）

**受影响端点:** `/files/read-content`, `/files/write-content`, `/files/mkdir`, `/files/delete`, `/files/rename`, `/files/copy`, `/files/move`

### [2026-03-04] SFTP Fallback — Terminal 正常但文件操作全部失败

**问题:** Terminal (SSH PTY) 连接成功，但所有文件操作（list/download/upload/import）失败。原因是 `HPCConnection` 在 asyncssh 模式下所有文件操作都走 SFTP 子系统，如果 HPC 服务器限制/禁用 SFTP，`start_sftp_client()` 失败后没有回退路径。

**修复:** 三层回退机制：
1. **SFTP**（最快，原生协议）
2. **SSH Exec via conn.run()/conn.create_process()**（任何 SSH 连接都支持）
3. **错误抛出**

实现细节：
- 新增 `_sftp_failed: bool` 标志，避免每次操作都重试 SFTP 初始化
- `get_sftp()` 捕获异常返回 `None`，不再抛出
- 新增 `_download_exec()`（用 `conn.create_process("cat ...")`）和 `_upload_exec()`（用 `conn.run("cat > ...", input=content)`）
- 新增 `_get_file_size_exec()`（从 subprocess 分支提取复用）
- 所有 dispatch 方法（`list_remote_dir`, `download_remote_file`, `upload_remote_file`, `download_to_local`, `get_remote_file_size`）改为：先尝试 SFTP，SFTP 失败时 try-catch 回退到 exec
- `_list_dir_subprocess` 已经用 `conn.run()` 实现，asyncssh 和 SubprocessSSHRunner 都兼容，直接复用

**注意:** 如果 HPC 支持 SFTP，性能不受影响（仍走 SFTP）。只在 SFTP 失败时才回退。`_sftp_failed` 标志是连接级别的，重新连接会重置。

### ⚠️ KbdintSSHClient OTP prompt 误匹配 "password" 关键字（严重）

**[2026-02-28]**

**问题:** `KbdintSSHClient.kbdint_challenge_received()` 中，检查 prompt 是否为密码时用 `"password" in lower`，但某些 HPC 的 OTP prompt 包含 "password" 一词（如 KAUST Shaheen: `"One-time password (OATH) for 'reny0b': "`）。代码错误地走到了密码分支，发送空字符串而非 OTP 验证码。服务器反复重试 6 次后触发 "Too many authentication failures"。

**现象:** 连接 Shaheen 时选择 "SSH Key + OTP"，填入正确的 key_file，前端弹出 OTP 输入框并输入正确的验证码，但连接始终失败报 "Too many authentication failures"。其他 HPC（如 Expanse）正常。

**根因:** Shaheen 的 OTP 提示包含 "password" 子串 → 匹配到密码分支 → 发送 `self._password`（空串）→ 认证失败 → 重试直到 MaxAuthTries 耗尽。

**修复:** 在通用 `"password"` 检查之前，先检查 OTP 特有关键字：`one-time`, `otp`, `oath`, `verification`, `passcode`, `token`, `duo`, `2fa`, `second factor`, `authenticator`。匹配到这些关键字时发送 OTP code 而非密码。

**调试技巧:** 可以用 asyncssh 直接测试认证流程，观察 `kbdint_challenge_received` 收到的 prompt 文本：
```python
import asyncio, asyncssh

class TestClient(asyncssh.SSHClient):
    def kbdint_auth_requested(self):
        return ''
    def kbdint_challenge_received(self, name, instructions, lang, prompts):
        print(f'Prompts: {prompts}')
        return ['dummy']

asyncio.run(asyncssh.connect(host, port=22, username=user,
    client_keys=[key_path], known_hosts=None, client_factory=TestClient))
```

**教训:** 不同 HPC 的 keyboard-interactive prompt 格式差异很大，不能用简单的 `"password" in text` 判断。OTP 关键字必须优先于通用关键字检测。

## MCP 工具执行架构

### 两条路径：前端 WASM vs 后端 pymatgen

CatGO 的结构操作有两条独立的执行路径：

**路径 A — Anthropic API 直连（前端执行）:**
```
用户消息 → Anthropic API → tool_use 响应
→ chat-state.svelte.ts:run_tool_loop()
→ Structure.svelte:tool_executor(name, input)
→ WASM create_supercell() / wasm_generate_slab() / add_atom()
→ structure = result （即时更新 UI）
```
- 所有 44+ 工具定义在 `src/lib/chat/structure-tools.ts`
- `Structure.svelte` 注册 handler (~L2849) 处理所有工具
- Supercell/slab 用 WASM (ferrox)，原子操作用 TS (atom-manipulation.ts)
- **速度: 即时（< 50ms）**

**路径 B — CLI agents / MCP（后端执行）:**
```
CLI agent (claude/gemini/codex) → MCP protocol
→ mcp_server.py:handle_call_tool()
→ 自动获取 viewer 当前结构: GET /view/structure/current
→ POST /structure-ops/supercell (pymatgen 处理)
→ _push_structure_to_viewer(): POST /view/structure/push + /pending-update
→ 前端每 500ms 轮询 /pending-update → structure = data （延迟更新）
```
- 所有操作用 pymatgen（无 WASM）
- MCP server 是独立 Python 进程，无法访问浏览器 WASM
- **速度: ~600ms（pymatgen < 200ms + 轮询 ≤ 500ms）**

### 为什么不统一用前端 WASM？

MCP 工具需要**同步返回结果**给 CLI agent。如果让前端执行，需要：
1. MCP server 发 pending-action → 等待前端执行 → 前端返回结果 → MCP 拿到结果
2. 整个过程依赖前端轮询，反而比直接 pymatgen 更慢
3. 引入复杂的状态管理和竞态条件

**结论:** 保留 pymatgen 后端路径，将轮询间隔从 2s 优化到 500ms 是最务实的方案。

### 前端轮询机制 (Structure.svelte)

`poll_structure_updates()` (~L3510) 每 500ms 轮询 `/view/structure/pending-update`:
- 无更新: 返回 `{"pending": false}`（< 1KB，开销可忽略）
- 有更新: 返回 `{"pending": true, "structure": {...}}`，前端设置 `structure = data.structure`
- 消费后清空队列（原子性）

`push_structure_info()` 每 5s 推送当前结构+选区到后端（供 MCP 工具读取）。

### MCP 工具分类

| 类别 | 实现位置 | 示例 |
|------|---------|------|
| 原子操作 | `structure_ops.py` (pymatgen) | add_atom, delete_atoms, move_atom, replace_atom |
| 超胞/晶格 | `structure_ops.py` (pymatgen make_supercell) | supercell, set_lattice |
| 表面切割 | `structure_ops.py` (pymatgen SlabGenerator) | generate_slab |
| 构建工具 | `build.py` (pymatgen) | defect, strain, doping, substitution, intercalation |
| 表面修饰 | `water_layer.py`, `pseudo_hydrogen.py` (ASE) | water_layer, passivate |
| 纳米结构 | `moire.py`, `nanotube.py`, `heterostructure.py` | moire_build, nanotube_build |
| 特殊工具 | `mcp_server.py:_handle_special_tool()` | set_lattice, fetch_crystal, fetch_molecule |

所有修改结构的工具最后都调用 `_push_structure_to_viewer()`。

## 性能与并发

- [2026-03-01] **GZip 压缩**: `main.py` 添加了 `GZipMiddleware(minimum_size=1000)`，大于 1KB 的响应自动 gzip 压缩。大结构 JSON 可压缩 5-10 倍。
- [2026-03-01] **pending-update 竞态修复**: `_pending_structure_update` 从单变量改为 `deque(maxlen=16)` 队列。GET 返回最新结构并清空队列，防止快速连续操作覆盖未消费的结构。

## 通用模式

### `_handle_special_tool` 模式

MCP 中不走标准 REST 转发的工具使用 `endpoint="__special__/xxx"` 标记，由 `_handle_special_tool()` 单独处理。这些工具需要：
- 先获取 viewer 当前结构
- 或者调用多个后端端点组合完成操作
- 或者有特殊的返回格式要求

### 推送结构到 Viewer

所有修改结构的操作最后都要推送到 viewer:
```python
push_err = await _push_structure_to_viewer(client, struct_dict)
```
内部调用两个端点：`push` 更新结构数据，`pending-update` 触发 UI 刷新。

**重要:** `_push_structure_to_viewer` 返回错误字符串而非抛异常。这样即使后端不可达（如 dev server 未启动），MCP 工具仍能返回搜索结果给用户，而不是整个工具调用失败。

### MCP 工具不可用 — 历史教训

`mcp` Python 包必须在 `requirements.txt` 中列出（`server/mcp_server.py` 第一行 `from mcp.server import Server`）。conda 环境缺它时 MCP server 子进程立即 `ModuleNotFoundError`。

MCP server 读取 `CATGO_API` 环境变量决定 backend 端口。`server/catgo/mcp_tools/server.py` / `server_claude_code.py` 调 `_get_catgo_api_url()` 动态从 `SERVER_PORT` 派生，与 `main.py` 一致。切换端口运行时不要把 `8000` 硬编码到任何地方。

## 结构序列化 (workflow.py) — ASE 替代 pymatgen

### [2026-03-02] oxidation_state:0 导致 "C0+" 元素名（严重）

**问题:** 前端所有结构 dict 中的 species 都包含 `oxidation_state: 0`（`parse.ts`、`atom-manipulation.ts`、`AdsorbatePlacementPane.svelte` 等 20+ 处）。pymatgen `Structure.from_dict()` 会将 `{element: "C", oxidation_state: 0}` 反序列化为 `Species("C", 0)`，其 `species_string` 为 `"C0+"`。导致 XYZ/CIF/ExtXYZ 输出中元素名变成 `C0+`、`O0+`、`H0+`。

**现象:** 用户编辑 H2O 后导出到 HPC，文件内容中出现 `C0+` 而非 `C`。

**修复:** 将 `api_serialize_structure` 和 `api_export_structure` 从 pymatgen I/O 改为 ASE I/O:
- `_dict_to_ase()`: 使用 `utils/converter.py` 的 `pymatgen_to_ase()`，其中 `_clean_element_symbol()` 自动清理 `C0+` → `C`
- `_ase_serialize()`: 使用 `ase.io.write()` 输出 CIF/POSCAR/XYZ/ExtXYZ
- 旧 pymatgen 代码已注释保留在 `workflow.py` 中（搜索 "OLD pymatgen-based serialization"）

**ASE 相比 pymatgen 的优势:**
1. 不受 oxidation_state 影响（通过 converter 清理）
2. 原生支持 Molecule（pbc=False）和 Crystal（pbc=True）统一处理
3. `FixAtoms` constraint → POSCAR `Selective dynamics` 自动输出
4. ExtXYZ 格式由 ASE 原生处理（不需要手写 `_serialize_extxyz`）

**注意:**
- ASE CIF writer 需要 `BytesIO`，其他格式（POSCAR/XYZ/ExtXYZ）需要 `StringIO`
- 分子请求 CIF/ExtXYZ 格式时自动降级为 XYZ（前端返回 `format: "xyz"` 提示用户）
- 分子请求 POSCAR 时返回 400 错误（POSCAR 必须有晶格）
- 每步都有 `logger.info` 日志记录，方便调试

### [2026-03-02] db-wasm.ts 序列化/导出 throw 而非转发后端

**问题:** `db-wasm.ts` 中 `db_serialize_structure()` 和 `db_export_structure()` 直接 `throw new Error("Structure serialization requires the Python backend")`，即使后端在运行也无法序列化。

**修复:** 改为 `fetch()` 转发到 `${API_BASE}/workflow/files/serialize-structure`（同 `db_export_structure`）。

## Workflow Skills (optional reference)

Skills are available via `catgo_skills` MCP tool for domain-specific guidance. Common paths:
- `vasp/relax`, `vasp/freq`, `vasp/static`, `vasp/dos`
- `analysis/oer`, `analysis/her`, `analysis/co2rr`, `analysis/nrr`
- `structure/slab`, `structure/adsorbate`

Skills are reference documents — reading them before workflow creation is optional.
For simple or familiar workflows, proceed directly with `create → batch → run`.

## Claude Code MCP 集成 (server_claude_code.py)

### [2026-03-10] 轻量 MCP Server — 5 合并工具

**文件:** `server/mcp_tools/server_claude_code.py`

区别于 `server/mcp_tools/server.py`（50+ 工具，给 CatGO 内置 AI Chat 用），这个是给 **Claude Code CLI** 用的轻量版。

**设计:**
- 5 个合并工具（catgo_structure/fetch/workflow/analyze/view），每个用 `action` 参数路由
- ~500 tokens 工具定义（vs 原版 ~5000 tokens）
- fetch/workflow 操作复用 `server.py` 的 `_handle_special_tool`
- structure/analyze 直接调用 FastAPI 端点

**协作者配置:**
```bash
bash scripts/setup-claude-code.sh
```
自动配置 `~/.claude/mcp.json` + `~/.claude/settings.json` + SessionStart hook。

**注意:**
- 普通用户（Tauri 打包 APP）不需要这个，他们用 CatGO 内置 AI Chat
- SessionStart hook 依赖 `jq` 和 `curl`
- Hook 在后端未运行时静默退出（零开销）
