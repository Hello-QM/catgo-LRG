# src/lib/workflow/ - 工作流系统 UI

可视化工作流编辑器和项目管理视图。

## 文件概览

| 文件 | 职责 | 行数 |
|------|------|------|
| `WorkflowEditor.svelte` | SVG 工作流图编辑器 | ~2000 |
| `ProjectListView.svelte` | 项目列表视图（网格卡片） | ~200 |
| `ProjectDashboard.svelte` | 项目详情（结果表格/图表 + 工作流侧栏） | ~400 |

## WorkflowEditor.svelte

### 核心状态

```typescript
let nodes = $state<WfNode[]>([])        // 工作流节点
let edges = $state<WfEdge[]>([])        // 连线
let sel_nodes = $state(new Set<string>()) // 选中节点
let pan = $state({ x: 0, y: 0 })       // 画布平移
let zoom = $state(1)                     // 画布缩放
let history = $state<{nodes, edges}[]>([]) // 撤销栈
let node_statuses = $state<Record<string, string>>({}) // 执行状态
let sim_running = $state(false)          // 是否正在运行
```

### 功能

- **SVG 图编辑**: 节点拖拽、连线绘制、框选、复制粘贴、撤销/重做
- **节点配置面板**: 右侧属性编辑器
- **执行控制**: 运行配置对话框、HPC 任务脚本
- **WebSocket 监控**: `workflow_api.connect_workflow_monitor()` 实时状态
- **Chat 集成**: ChatPane 组件，工作流工具执行器
- **自动保存**: 图变化自动调用 `workflow_api.update_workflow(id, {graph_json})`

### 快捷键

- Ctrl+Z/Y: 撤销/重做
- Ctrl+C/V: 复制/粘贴节点
- Delete/Backspace: 删除选中
- Ctrl+S: 保存

## ProjectListView.svelte

### Props

```typescript
onselect: (project_id: string) => void   // 进入项目详情
on_all_workflows?: () => void             // 显示全部工作流列表
onclose?: () => void                      // 返回结构查看器
ondbchange?: () => void                   // 数据库变更通知
```

### API 调用

- `project_api.list_projects()` — 加载项目列表（5s 超时）
- `project_api.create_project(name, description)` — 创建项目
- `project_api.delete_project(id)` — 删除项目

### 错误处理

- 检查 "abort" 错误 → 显示 "Cannot connect to backend server"

## ProjectDashboard.svelte

### Props

```typescript
project_id: string                          // 项目 ID
onback: () => void                          // 返回项目列表
on_open_workflow: (workflow_id: string) => void  // 打开工作流编辑器
onclose?: () => void                        // 关闭
ondbchange?: () => void                     // 数据库变更通知
```

### 核心状态

```typescript
let project = $state<ProjectDetail | null>(null)  // 项目详情
let results = $state<EnrichedResult[]>([])         // 结果数据
let active_tab = $state<'table' | 'plot'>('table') // 结果视图切换
```

### API 调用

```typescript
project_api.get_project(id)                // 加载项目（含工作流列表）
project_api.get_enriched_results(id)       // 加载结果表格
project_api.update_project(id, { name })   // 重命名
workflow_api.create_workflow()              // 新建工作流
project_api.assign_workflow_to_project()   // 关联工作流到项目
```

### UI 结构

- **摘要栏**: 结果数、化学式种类、能量范围、工作流数
- **工作流侧栏**: 带进度条和状态颜色编码
- **结果标签页**: ResultsTable（表格）和 ResultsPlot（图表）

## Plugin Node System (Phase 3)

### [2026-03-03] WorkflowNodePlugin 动态节点注册

**架构:** 插件通过 `WorkflowNodePlugin` 基类定义自定义工作流节点。后端注册后通过 `GET /api/plugins/workflow-nodes` 暴露给前端。

**前端集成:**
- `node-definitions.ts` 新增 `load_plugin_nodes(api_base)` — 从后端加载插件节点定义，合并到 `NODE_DEFINITIONS`
- `get_sidebar_categories()` 自动为插件节点添加 "Plugin" 分类
- `is_plugin_node(type)` — 判断节点是否来自插件
- `on_drop()` 无需修改 — 插件节点已在 `NODE_DEFINITIONS` 中，守卫自动通过

**后端集成:**
- `server/plugins/base.py` — `WorkflowNodePlugin` 基类（`node_type`, `node_definition`, `execute()`)
- `server/plugins/manager.py` — `_workflow_node_plugins` 注册表 + `get_workflow_node()` / `has_workflow_node()` / `get_all_workflow_nodes()`
- `server/utils/workflow_engine.py` — 执行分发链新增 `_has_plugin_node()` + `_execute_plugin_node()`
- `server/routers/plugins.py` — `GET /plugins/workflow-nodes` 端点

**调用前端 `load_plugin_nodes()`:** 应在 WorkflowEditor mount 时调用，传入 API base URL（如 `http://localhost:8000/api`）。

## Known Bugs

### [2026-03-26] Plotly data must NEVER be stored in `$state` — causes infinite reactive loop

**问题:** 将 Plotly API 响应数据（traces/layout/annotations）存入 `$state` 变量后，Svelte 5 创建深层 proxy 树。任何读取该 state 的 `$effect` 会触发无限循环 → 浏览器卡死 ("Page Unresponsive")。

**根因:** `$state` 对嵌套对象的每个属性创建 reactive proxy。Plotly 响应有大量嵌套数组（坐标点、样式配置），proxy 树巨大。`$effect` 中 `Plotly.react(div, data.traces, ...)` 读取 proxy → 触发依赖追踪 → state 变化 → effect 重跑 → 无限循环。

**修复:** 不使用 `$state` 存储 Plotly 数据。fetch 完成后直接调用 `Plotly.react(plot_div, data.traces, layout, config)` 操作 DOM，完全绕过 Svelte 响应式系统。

**正确模式:**
```javascript
// 在组件 mount 时预加载 Plotly
let Plotly: any = null
lazy_load_plotly().then(p => { Plotly = p })

// 持久化 div（不条件渲染）
// <div bind:this={plot_div}></div>

// fetch 后直接渲染到 DOM
async function render() {
  const data = await fetch(url).then(r => r.json())
  if (plot_div && Plotly) {
    Plotly.react(plot_div, data.traces, data.layout, config) // 纯 DOM，无 $state
  }
}
```

**注意:** 现有的 ConvergencePlot/DosPlot 不受影响，因为它们从简单 `$state` 数组构建 traces（不是从 API 直接赋值深层对象），且 Plotly 通常已被其他组件缓存。

### [2026-04-14] CatBot MCP 工具风暴 → WebKit 渲染爆炸（根因 + 修复）

**现象**
- 用户让 CatBot 生成包含 ≥ 10 个节点的 workflow（如 OER 自由能图，30 节点 / 39 边）
- Tauri 桌面窗口表现出两种故障之一：
  1. 白屏，Ctrl+鼠标无响应，CPU 0%（WebKitGTK 渲染线程死锁）
  2. 风扇狂转，`top` 看到 WebKitWebProcess 180% CPU、15 GB RAM

数据本身并不大——30 节点 + 39 边总计 7.7 KB JSON。不是数据量问题。

**真正的根因：MCP 工具链连续 push `pending_navigate_workflow` 造成前端 reactive 风暴**

后端 `server/catgo/mcp_tools/workflow_tools.py` 里几乎每个 mutation 工具（`create` / `add_node` / `batch` / `connect` / `set_params` / `remove_node`）完成时都调用 `_push_workflow_navigate(wf_id)`，把 `workflow_id` 写入 `view_capture._pending_workflow_id`。

Claude 一次对话里连续 5-6 次调这些工具（例如事故 A 序列：`create → batch → connect → validate` 间加上读类调用，期间 3-4 次命中 push）。每次 push 都在 500 ms 内被前端 `poll_structure_updates()` 循环（`src/lib/structure/controllers/tool-handler.ts::poll_structure_updates`）消费，原始代码无条件：

```ts
if (data.workflow_id) {
  pending_navigate_workflow.id = data.workflow_id  // 每次都写，即使相同 id
}
```

而 Svelte 5 的 `$state` setter **不判等**——同值写入也触发订阅者。一次 poll 到的单个 id 写入导致以下**全量级联**：

```
pending_navigate_workflow.id = X
  ↓ App.svelte $effect
handle_sidebar_open_workflow(X)
  ↓ 如果 workflow 已打开
workflow_reload_seq.seq++
  ↓ WorkflowEditor $effect
reload_from_server()
  ↓ 整体赋值
nodes = graph.nodes.map(...)   // 30 个深 $state proxy 重建
edges = graph.edges            // 39 条
  ↓ 依赖 nodes/edges 的全部 $derived 重算
workflow_json = to_workflow_json(nodes, edges)   // JSON.stringify 30 节点
orphan_set = ...                                  // 遍历 30 × 39
mm_bounds = ...
  ↓ "sync to shared state" $effect
nodes.map(...) + edges.map(...) + Object.assign(active_workflow, ...)
  ↓ ChatPane $effect
workflow_context.value = build_workflow_context(active_workflow)
broadcast_chat_context()  // postMessage 到 popouts
```

这条链路本身不慢（一次 50-200 ms）。但 Claude 每 5-15 秒又触发一次 push；前端 poll 500 ms 一次；**3-6 次触发在 WebKit 单线程事件循环上叠加** → webview 撑不住。具体表现取决于时序窗口：渲染线程先堵死就白屏（A），JS 进入依赖循环就 180% CPU（B）。

**曾错误尝试并回滚：把 `nodes/edges` 改成 `$state.raw`**。见下一小节。

**正确修复（只动前端一个文件）**

`src/lib/structure/controllers/tool-handler.ts::handle_pending_update`：

```ts
if (data.workflow_id) {
  const current_id = active_workflow.id
  const already_queued = pending_navigate_workflow.id === data.workflow_id
  if (current_id === data.workflow_id && !already_queued) {
    // 已打开同一 workflow — 只 nudge reload，不重写 pending_navigate
    workflow_reload_seq.seq++
  } else if (!already_queued) {
    pending_navigate_workflow.id = data.workflow_id
  }
  // else: 已在队列中，丢弃本次写入
}
```

三个分支：
1. 已打开该 workflow → `workflow_reload_seq++`（WorkflowEditor 会执行 `reload_from_server`，触发一次级联，而非重新 mount 组件）
2. pending 里已经是相同 id → 直接丢弃（App.svelte 的 `$effect` 还没消费，重复写入多余）
3. 真正是一个新 id → 正常写入

这把 N 次"remount 级联"折叠成**最多 1 次 reload 级联**。配合 Svelte 的批量调度，`workflow_reload_seq++` 连写多次也只触发 1 次 effect 重跑。

**为什么不在后端去重？** 想过——`view_capture._pending_workflow_id` 这层可以判断"上次 push 相同 id 就不更新"，但后端看不到前端是否真的已经 consume 过、是否仍在处理中。前端才是"我现在的状态"的权威。

**为什么不去掉 `_push_workflow_navigate` 在 `batch`/`connect` 等后续 mutation 里的调用？** 因为那些调用的初衷是"让前端知道 workflow 变了、可能要重新渲染"。去掉会让前端漏掉变化。保留 push + 前端去重 = 兼容性最好。

---

### [2026-04-14] When to use `$state.raw` vs `$state` (约定)

#### Why it matters — 两次真实事故

**事故 A（深 $state 白屏）**：CatBot 用 `catgo_workflow action=batch` 一次性 append 30 节点。深 `$state<WfNode[]>` 给每个 node、每个 `params`/`inputs`/`outputs` 建 Proxy。batch 过程中多次增量赋值 = 多轮巨型 proxy tree 重建，WebKitGTK 渲染线程挂死几秒后被杀，**webview 整张变白屏**（Tauri 的 Rust 壳还活着）。现象：CPU 0%，无 error 无 console，风扇不转。

**事故 B（$state.raw 级联循环）**：为了修 A，把 `nodes`/`edges` 改成 `$state.raw`。结果 load_workflow 一次整体赋值后，下游那些**细粒度 derived**（`selected_node = nodes.find(..)`、`orphan_set`、`workflow_json = to_workflow_json(nodes, edges)`）因为 raw 不能追踪字段访问，全部退化为"nodes 引用一变就整体重算"。多个 effect 读这些 derived 又有副作用写 `node_statuses` 或调 `schedule_save`，形成反馈闭环。现象：**WebKit 进程狂飙 180% CPU、15 GB RAM、风扇狂转**。

两次方向相反的失败教会我们：**$state 的"深/浅"选择不是性能 vs 正确性，而是依赖追踪粒度的取舍**。

#### Decision tree

判断一个变量要不要用 `$state.raw`：

1. 是否有任何 `$derived` / `$effect` 读该变量的**元素字段**（不只是 `.length`、`.[idx]` 整体）？
   - `x.find(y => y.id === ...)` ← **字段访问**
   - `x.map(y => y.name)` ← **字段访问**
   - `x.filter(y => y.active)` ← **字段访问**
   - `x.length` / `x[i] ?? null` ← 整体访问，OK

   **是 → 用深 `$state`（结束）**

2. 是否有子组件 `bind:x={...}` 双向绑定它？
   - **是 → 用深 `$state`（结束）**

3. 是否有任何 in-place mutation（`x.push`、`x[i]=`、`x.field=`）？
   - **是 → 用深 `$state`（结束）**

4. 元素是不是"大"（嵌套对象、数组可能很长）？
   - **是 → 可考虑 `$state.raw`**
   - 否 → 用普通 `$state` 就行，proxy 开销忽略

#### 当前项目的分类（审计结果）

✅ **保持 `$state`（深追踪）**：
- `WorkflowEditor.svelte`: `nodes`, `edges`（有 `nodes.find()` 等细粒度 derived — 必须深）
- `OptimizationPane.svelte`: `energy_history`（有 `.map(h => h.energy)` derived）
- `ProjectDashboard.svelte`: `results`, `tracked_steps`
- `BatchPanel.svelte` / `MultiStructurePreview.svelte`: `structures`
- `WorkflowDAGViewer.svelte`: `tasks`（有 `tasks[idx] = ...` in-place 写入）

✅ **可以用 `$state.raw`（浅追踪，仅整体读写）**：
- `WorkflowEditor.svelte`: `edit_3d_structure`, `edit_3d_trajectory`, `edit_3d_bulk`, `edit_3d_initial_generated`, `edit_3d_vibration`, `edit_3d_adsorption_sites`, `energy_diagram_pathways`（都只是整体赋值给子组件 prop，不被细粒度 derived 消费）
- `Structure.svelte`: `wl_hashes`, `slice_atoms_info`（仅 `?.find(h => h.sbu_index === x)` 在模板里直接读，不在 derived/effect 里）
- `JobDetailPane.svelte`, `OptimizationPane.svelte`: `trajectory_frames`（模板里 `.length` / `[idx]`）
- `WorkflowDAGViewer.svelte`: `links`（整体赋值）
- `BatchStatusPanel.svelte`: `results_page`, `histogram`（整体赋值自 fetch）

#### 如果 batch 性能真的有问题，正确的缓解方式

**不要**通过切换到 `$state.raw` 来"优化"。正确做法：

1. **批量写入单次化**：多步 append 合并成一次 `nodes = [...nodes, ...all_new]`，避免 N 次 reactive trigger
2. **保留深 $state**，让 Svelte 细粒度追踪真实变化
3. 如果仍慢，考虑把大字段（如 `params`）提出来存 `Map<id, params>`，而 `nodes` 只存 `{id, type, x, y}` 这种轻量 header

#### 审计命令

```bash
# 候选 raw：找出只做整体赋值的 $state 数组
rg '\$state<' --type svelte

# 对候选变量 V，看是否符合 raw 条件
V=nodes
rg "\\$derived.*\\b${V}\\b|\\b${V}\\.(find|filter|map|some|every|reduce)" src/

# 检查是否被 bind:
rg "bind:${V}" src/

# 检查是否有 in-place mutation（有则不能 raw，也应该审视是否重构成 immutable）
rg "\\b${V}\\.(push|splice|pop|shift|unshift|sort)\\b|\\b${V}\\[\\d+\\]\\s*=" src/
```

---

### [2026-03-14] Re-run after failure shows stale "failed" status (已修复)

**问题:** 工作流在 HPC 上失败后，用户修改参数（如赝势路径）重新提交，UI 立即显示失败而不会实际重新运行。

**根因:** 两个竞态条件叠加：
1. `POST /run` 创建后台任务后立即返回，但后台任务还没来得及将 step 状态重置为 "pending"
2. 前端连接 WebSocket 时，WebSocket handler 从 DB 读到的 step 状态仍然是上一次的 "failed"
3. `on_initial_state` 回调用旧的 "failed" 状态覆盖了前端刚设置的 "pending" 状态
4. 如果 HPC SSH 连接在两次运行之间断开，后台任务会立即失败，WebSocket 连接时已经是 "failed" 状态

**修复:**
1. `api_run_workflow` 在创建后台任务之前预先验证 HPC 连接是否存活，给出明确错误
2. `api_run_workflow` 在创建后台任务之前将所有 step 状态重置为 "pending"
3. WebSocket handler 检测到有活跃任务时，将旧的 "failed"/"completed" 状态覆盖为 "pending"

## 2025-02 变更

- ProjectListView 和 ProjectDashboard 从 workflow-folder API 改为使用 project API
- 工作流关联使用 `assign_workflow_to_project()` 而非 `assign_workflow_to_folder()`
- WorkflowEditor: `initial_workflow_id` prop 支持从侧边栏直接打开工作流
- 状态徽章颜色: draft(灰), running(蓝), completed(绿), failed(红)
