# Workflow / CatBot Bug Notes

更新时间: 2026-03-13

本文档只记录当前仓库里和 workflow 设计、MCP `catgo_workflow`、以及 CatBot 写 workflow 时最容易踩到的真实问题。

状态说明:
- `open`: 当前代码里仍然存在
- `fixed`: 之前存在，但本次复核时已不再成立
- `historical`: 历史上踩过，但本文只保留作背景，不应再当成当前 bug

## 1. `create` 会自动插入一个 `structure_input`，但 CatBot 文档仍按”空工作流”来写

状态:
- fixed

复核说明:
- `server/mcp_tools/workflow_tools.py` 的 `action == “create”` 响应消息已更新，明确告知 AI 和用户: 自动添加了 structure_input 节点，不要再重复添加。
- `add_node` 分支也已有防重复逻辑: 如果已存在 structure_input 节点，会更新现有节点而非创建新节点。

当前行为:
- `server/mcp_tools/workflow_tools.py` 的 `action == “create”` 分支会自动创建一个带 `structure_input` 的初始图。

风险:
- CatBot 如果继续照旧再 `add_node structure_input`，会得到重复输入节点。
- 后续连接时很容易把边连到新旧两个输入节点中的错误一个。
- 人类用户看到画布和 AI 口头描述不一致，容易误判为 UI 不同步。

建议:
- CatBot 创建 workflow 后先 `get` 一次，确认初始图。
- 文档中明确说明: `create` 后默认已有一个 `structure_input`，除非确实需要第二个输入，否则不要再加。

## 2. `connect` 默认把 `from_handle` / `to_handle` 都写成 `structure`

状态:
- fixed

复核说明 (2026-03-13):
- `server/mcp_tools/workflow_tools.py` 的 `action == “connect”` 分支现在会检查是否显式传了 handle。
- 当 `from_handle` 或 `to_handle` 使用默认值 `”structure”` 时，代码会查找源/目标节点的 `_NODE_DEFAULTS` 定义。
- 只有当节点恰好有唯一一个 handle 且为 `”structure”` 时才允许省略。
- 如果节点有多个 handle（如 `merge` 的 `input_a/input_b/input_c`）或 handle 名不是 `”structure”`，会返回错误并列出可用 handle，要求显式指定。

当前行为:
- 简单的 `structure_input -> geo_opt` 仍然可以省略 handle（双方都是单个 `structure` handle）。
- `geo_opt -> merge` 等多 handle 连接必须显式指定 `from_handle` 和 `to_handle`。

风险:
- 当前这个问题已经通过服务端验证修复，不再依赖 CatBot 文档提醒。

## 3. `node_types` 只能给出粗粒度分类，不能给出真实 handle / 参数细节

状态:
- fixed

复核说明 (2026-03-13):
- 新增 `catgo_workflow(action=”node_details”, node_type=”geo_opt”)` action。
- 返回完整 node schema: 输入 handle 列表、输出 handle 列表、默认参数及其值。
- 支持别名解析（如 `vasp_relax` 自动解析为 `geo_opt` 并注明）。
- 未知 node_type 返回可用类型列表。

当前行为:
- `node_types` 仍然是发现工具（返回分类列表）。
- `node_details` 是 schema 工具（返回单个节点类型的完整定义）。
- CatBot 建图时推荐先 `node_types` 发现，再 `node_details` 查看具体 handle 和参数。

## 4. `validate` 只返回 warning，不会阻止保存错误图

状态:
- fixed

复核说明 (2026-03-13):
- `_validate_graph()` 现在返回 `(errors, warnings)` 元组，区分严重错误和信息性警告。
- **Errors**（阻断 `run`）: 有环、孤边（引用不存在的节点）、非输入节点缺少输入边。
- **Warnings**（不阻断）: handle 不兼容、叶子节点无输出边。
- `add_node` / `connect` / `set_params` 仍然保存图（增量构建操作），但响应中同时显示 errors 和 warnings。
- `validate` action 分别返回 errors 和 warnings，带明确标签。
- `run` action **在有 errors 时拒绝执行**，返回错误列表要求先修复。仅有 warnings 时允许运行。

当前行为:
- `server/mcp_tools/workflow_tools.py` 的 `_validate_graph()` 返回 `tuple[list[str], list[str]]`。
- `run` 执行前先调用 `_validate_graph()`，有 errors 时直接返回错误信息，不发起 POST。

风险:
- 增量构建操作（add_node 等）仍然允许保存有错误的图，因为构建过程中图通常是不完整的。
- CatBot 仍然应该在 `run` 之前先 `validate`，确认图无 errors。

## 5. `connect` 的去重逻辑只看 `from_id` 和 `to_id`，不看 handle

状态:
- fixed

复核说明:
- 当前 `server/mcp_tools/server.py` 的重复边检查已经同时比较 `from_id`、`to_id`、`from_handle`、`to_handle`。
- 旧文档里这条曾经成立，但按 2026-03-13 的当前代码复核，已不再成立。

当前行为:
- `server/mcp_tools/server.py` 在 `action == "connect"` 时，用 `from_id + to_id + from_handle + to_handle` 判断重复边。

风险:
- 当前这个具体误判已经修复。
- 但 CatBot 仍然不该因为旧记忆而回避“同一对节点不同 handle 的多条合法边”。

建议:
- 保留本文是为了纠正旧文档和旧 agent 记忆，不是为了继续把它当当前 bug。

## 6. MCP `run` 不是”弹出 UI 让用户确认”，而是直接向后端发起运行

状态:
- fixed

复核说明:
- `server/mcp_tools/workflow_tools.py` 的 `action == “run”` 分支已有安全门控: 如果未提供 `run_config` 且未设置 `confirm: true`，工具会拒绝执行并返回警告消息，要求用户提供执行配置或显式确认。

当前行为:
- `server/mcp_tools/server.py` 中 `action == "run"` 会直接 POST `/workflow/{id}/run`。
- 默认 `execution_mode` 是 `local`，默认工作目录是 `~/calculations`。

风险:
- CatBot 现有说明把它描述成“打开 run dialog，让用户在 UI 里确认”。
- 这会导致 agent 在没准备好 `run_config` 时就直接启动任务。
- 对 HPC 用户尤其危险，因为他们以为会先选集群和作业参数，实际上不会。

建议:
- CatBot 文档必须改成:
  - MCP `run` 会立即运行
  - 需要显式传 `run_config`
  - 若用户未给出运行配置，先不要调用 `run`

## 7. `create` 和前端聊天工具的行为并不一致

状态:
- fixed

复核说明 (2026-03-13):
- `src/lib/chat/workflow-tool-executor.ts` 的 `create_workflow()` 现在也会自动添加 `structure_input` 节点，和 MCP `create` 行为一致。
- 前端 chat 工具描述已更新为 `”create auto-adds a structure_input node”`。

## 8. 外部修改后的前端同步虽然已经补了一层，但仍然不该假设”屏幕就是最新图”

状态:
- fixed

复核说明 (2026-03-13):
- 每个图变更操作（`create`, `add_node`, `remove_node`, `connect`, `set_params`）的响应末尾现在都附带一个紧凑的图快照（`_graph_snapshot`）。
- 快照包含: 节点数/边数、拓扑排序后的节点列表（含类型、ID、关键参数）、所有边的连接关系。
- AI 在每次 mutation 后立即拿到最新图状态，无需额外调用 `get`。
- `get` action 仍然返回完整详细信息，不受影响。

当前行为:
- 后端已有 pending workflow update 机制，MCP 修改后会推送前端刷新。
- mutation 响应自带图快照，AI 不再需要依赖先前记忆或额外 `get` 调用来了解当前图状态。

风险:
- 前端 UI 同步仍依赖轮询机制，极端并发下可能有短暂延迟，但 AI 侧已通过响应快照消除了信息滞后。

## 给 CatBot 的最小安全写法

推荐顺序:
1. `node_types`
2. `create`
3. `get`
4. `add_node` / `set_params`
5. `connect` 时尽量显式写 `from_handle` / `to_handle`
6. `validate`
7. 再 `get` 一次确认最终图
8. 只有在用户已给出运行配置时才 `run`

不推荐:
- `create` 后立刻假设图是空的
- 省略 handle 连接复杂节点
- 把 `validate` 的 warning 当成可忽略提示
- 在没有 `run_config` 的情况下直接 `run`

## 9. `ResultsTable` 对 `id == null` 的结果行处理不一致

状态:
- fixed

复核说明 (2026-03-13):
- `ResultsTable.svelte` 已重构为使用 `selected_keys: Set<string>` 代替 `selected_ids: Set<number>`。
- 新增 `row_key(result, index)` 函数，为 null-id 行生成 `__null_${index}` 合成键。
- 所有行现在都可以正常选中、全选、导出。

## 10. `ProjectDashboard` 用伪造的 UV-Vis 收敛点喂给通用收敛图

状态:
- fixed

复核说明 (2026-03-13):
- `ProjectDashboard.svelte` 的 `orca_uvvis` 分支现在返回 `points: []`（空数组）加一条状态消息，不再构造假收敛点。
- `ConvergencePlot.svelte` 只在 `points.length > 0` 时渲染，所以 UV-Vis 不会再显示虚假收敛曲线。
