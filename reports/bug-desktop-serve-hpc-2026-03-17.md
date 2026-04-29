# Bug Report: HPC 相关问题汇总

**日期:** 2026-03-17
**状态:** 已修复（2026-03-17）

---

## 背景

`tauri:dev` 和 `desktop:serve` 的关键架构差异：

| | `tauri:dev` | `desktop:serve` |
|---|---|---|
| 数据库 | Rust SQLite (`src-tauri/src/db.rs`)，持久化，backend 通过 `db/open` 共享同一文件 | WASM SQLite (`db-wasm.ts`)，内存中运行，通过 Vite 中间件 `/__db/write` 延迟写盘 |
| API 路由 | 前端直接 fetch 到 `http://localhost:8000/api`（`config.ts`） | 同上，前端也直接 fetch 到 backend 端口，不经过 Vite |
| 进程管理 | Tauri sidecar 管理 Python backend 生命周期 | `concurrently` 并行启动 Vite + Python，独立进程 |

---

## Bug 1（严重）: `run_workflow()` 同步失败被静默吞掉 ✅ 已修复

**文件:** `src/lib/api/workflow.ts:152-195`

### 问题

`run_workflow()` 在提交作业前，需要把前端本地数据库中的工作流同步到 Python backend。但同步链路上有 **三处静默错误处理**，任何一处失败后执行仍继续：

```typescript
// 第 160 行 — db/open 失败被 .catch(() => {}) 静默吞掉
await fetch(`${API_BASE}/workflow/db/open?path=${encodeURIComponent(dbInfo.path)}`, {
  method: `POST`,
}).catch(() => {})  // ← BUG: 如果 backend 的 db 路径不存在，静默忽略

// 第 175-178 行 — sync 失败只 console.error，不阻止执行
if (!sync_resp.ok) {
  const err = await sync_resp.text().catch(() => sync_resp.statusText)
  console.error(`[run_workflow] sync failed:`, sync_resp.status, err)
  // ← BUG: 没有 return 或 throw，继续执行到第 184 行
}

// 第 179-181 行 — 异常被 catch 吞掉
} catch (err) {
  console.error(`[run_workflow] sync error:`, err)
  // ← BUG: 没有 rethrow，继续执行到第 184 行
}

// 第 184 行 — 无论上面是否成功，都调用 /run
const response = await fetch(`${API_BASE}/workflow/${id}/run`, { ... })
```

### 后果

在 `desktop:serve` 模式下：
1. `db_get_current()` 返回相对路径 `server/data/catgo_results.db`
2. `POST /workflow/db/open?path=server/data/catgo_results.db` — backend 用 `Path(path).exists()` 检查，相对路径在 backend 工作目录下可能找不到 → **404**
3. `.catch(() => {})` 吞掉 404 → backend 数据库没有切换
4. `POST /workflow/` 同步工作流 → 写入 backend 的**默认** DB（可能不是前端在用的那个）
5. `POST /workflow/{id}/run` → backend 从默认 DB 读取工作流，可能读到旧版本或找不到

### 为什么 `tauri:dev` 不受影响

Tauri 的 `db-local.ts` 使用 Rust SQLite 命令操作同一个 DB 文件。`db_get_current()` 返回的是 Rust 端管理的绝对路径，`/db/open` 能正确打开。

---

## Bug 2（中等）: WASM 数据库写盘存在竞态 ✅ 已修复

**文件:** `src/lib/api/db-wasm.ts:194-209`

### 问题

WASM SQLite 的写盘是 **防抖延迟** 的：

```typescript
function schedule_flush(): void {
  if (flush_timer) clearTimeout(flush_timer)
  flush_timer = setTimeout(flush_now, 1000)  // ← 1 秒延迟
}
```

每次数据库写操作只调用 `schedule_flush()`，实际写盘在 1 秒后。如果用户在创建/修改工作流后立即点击 "Run"：

1. 工作流变更存在 WASM 内存中，尚未写盘
2. `run_workflow()` 调 `/db/open` → backend 读盘上的旧数据
3. 同步到 backend 的工作流是**过时**的

### `run_workflow()` 没有调 `flush_now()`

`workflow.ts` 中的 `run_workflow()` 没有在同步前调用 `flush_now()` 来确保数据已写盘。

---

## Bug 3（低）: `db/open` 端点的路径解析 ✅ 已修复

**文件:** `server/routers/workflow.py:1445-1457`

### 问题

```python
@router.post("/db/open")
async def api_open_db(path: str):
    p = Path(path)
    if not p.exists():  # ← 使用相对路径时，取决于 backend 的 cwd
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    set_active_db_path(str(p))
```

`Path(path).exists()` 使用 backend 的当前工作目录解析相对路径。在 `desktop:serve` 模式下：
- Backend 的 cwd 是 `server/`（由 `python server/main.py` 决定）
- 前端传的路径是 `server/data/catgo_results.db`
- `Path("server/data/catgo_results.db")` 在 `server/` cwd 下解析为 `server/server/data/...` → **不存在**

### 为什么 `tauri:dev` 不受影响

Tauri 通过 `db-local.ts` 获取的是 Rust 端的绝对路径。

---

## Bug 4（信息）: Vite 不代理 WebSocket，但可能不是问题

**文件:** `vite.desktop.config.ts:441-446`

### 现状

Vite desktop server 的 WebSocket upgrade handler 只处理 `/api/pty/session`：

```typescript
server.httpServer!.on(`upgrade`, (req, socket, head) => {
  if (req.url === `/api/pty/session`) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit(`connection`, ws, req))
  }
  // 其他 WebSocket 路径被忽略
})
```

### 分析

**这可能不是 bug**。前端的 WebSocket 连接（HPC connect、workflow monitor）都直接连 `ws://localhost:8000/api/...`（从 `config.ts` 的 `WS_BASE` 构建），不经过 Vite dev server 端口。所以不需要 Vite 代理。

但如果存在 CORS 问题（WebSocket 跨端口连接），浏览器可能会拒绝连接。需要验证。

---

## 修复建议

### Bug 1 修复方案

`run_workflow()` 中同步失败应该**阻止执行**并返回有意义的错误：

```typescript
export async function run_workflow(id: string, config: WorkflowRunConfig) {
  const db = await getLocal()
  if (db) {
    // 先确保写盘（修复 Bug 2）
    if ('flush_now' in db) await (db as any).flush_now()

    const dbInfo = await db.db_get_current()
    // db/open 失败不能静默
    const openResp = await fetch(`${API_BASE}/workflow/db/open?path=...`, { method: 'POST' })
    if (!openResp.ok) {
      throw new Error(`Failed to open database on backend: ${await openResp.text()}`)
    }
    // sync 失败也不能静默
    const syncResp = await fetch(`${API_BASE}/workflow/`, { ... })
    if (!syncResp.ok) {
      throw new Error(`Failed to sync workflow to backend: ${await syncResp.text()}`)
    }
  }
  // 现在才安全地调用 /run
  const response = await fetch(`${API_BASE}/workflow/${id}/run`, { ... })
  return handle_response(response)
}
```

### Bug 3 修复方案

`db/open` 端点应该尝试多种路径解析：

```python
@router.post("/db/open")
async def api_open_db(path: str):
    p = Path(path)
    if not p.exists():
        # 尝试从项目根目录解析
        project_root = Path(__file__).resolve().parent.parent.parent
        p = project_root / path
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    set_active_db_path(str(p.resolve()))
```

---

## Bug 5（严重）: NodeStatusPanel HPC 连接状态与实际不一致 ✅ 已修复

**文件:** `src/lib/workflow/NodeStatusPanel.svelte:104-140`
**影响:** `tauri:dev` 和 `desktop:serve` 均受影响

### 问题

超算明明已经连接上了，但节点状态面板显示 "HPC not connected"。

### 根因

`hpc_session` 的匹配逻辑依赖三层 fallback：

```typescript
const hpc_sid = $derived(step_info?.hpc_session_id ?? (node_params?.hpc_session_id as string) ?? null)
const hpc_host = $derived(step_info?.hpc_host ?? null)
const is_hpc_step = $derived(!!hpc_sid || !!step_info?.work_dir)

const hpc_session = $derived.by(() => {
  // 1. 精确 session_id 匹配
  // 2. host 匹配（username@host）
  // 3. 单一 session fallback（sessions.length === 1）
  ...
})
```

**在工作流未运行过时**，`step_info` 为 `null`（DB 里没有执行记录），导致：
- `hpc_sid` = `null`（`step_info` 是 null，`node_params.hpc_session_id` 通常也是 undefined，因为 HPC session 是在 RunConfigDialog 的 `default_session_id` 统一设置的，不写入每个节点的 params）
- `hpc_host` = `null`
- `is_hpc_step` = `false`
- **三层 fallback 全部失败** → `hpc_session = null` → 显示 "HPC not connected"

**即使工作流跑过了**，用户断开重连 HPC 后 session_id 变了：
- 第 1 层精确匹配失败（旧 session_id ≠ 新 session_id）
- 第 2 层 host 匹配**可能成功**（如果 `step_info.hpc_host` 有值）
- 但 `hpc_host` 格式是 `username@host`，需要 DB 里 `workflow_steps.hpc_host` 有记录

### 核心问题

`is_hpc_step` 的判断**不够**。一个节点是否是 HPC 步骤，应该看**节点类型**（`vasp_relax`、`geo_opt` 等计算节点天然需要 HPC），而不是看有没有 `step_info.work_dir` 或 `hpc_session_id`。

### 修复建议

```typescript
// 通过节点类型判断是否是 HPC 步骤，而不是依赖 step_info
const HPC_NODE_TYPES = new Set([
  'vasp_relax', 'vasp_static', 'vasp_md', 'bulk_opt', 'slab_relax',
  'geo_opt', 'single_point', 'cell_opt', 'md', 'freq',
  // ... 所有需要超算的节点类型
])
const is_hpc_step = $derived(
  HPC_NODE_TYPES.has(node_type) || !!hpc_sid || !!step_info?.work_dir
)

// 或者更简单：直接看 hpc_session_store 是否有任何活跃连接
const hpc_session = $derived.by(() => {
  const sessions = hpc_session_store.sessions
  // 1. 精确 session_id 匹配
  if (hpc_sid) {
    const exact = sessions.find(s => s.session_id === hpc_sid)
    if (exact) return exact
  }
  // 2. host 匹配
  if (hpc_host) {
    const byHost = sessions.find(s => `${s.username}@${s.host}` === hpc_host)
    if (byHost) return byHost
  }
  // 3. 对于 HPC 类型节点，有任何活跃 session 就显示已连接
  if (is_hpc_step && sessions.length >= 1) {
    return sessions[0]
  }
  return null
})
```

---

## Bug 6（严重）: VASP 作业失败后状态卡在 running ✅ 已修复

**文件:** `server/workflow/python_engine.py:786-830`
**影响:** `tauri:dev` 和 `desktop:serve` 均受影响

### 问题

当超算节点崩溃（NODE_FAIL）导致 VASP 作业失败时，前端状态仍显示 "running"。

### 根因

轮询循环中，当作业从 `squeue` 消失时的处理逻辑有缺陷：

```python
# 第 790-803 行
job_info = await hpc.scheduler.get_job_status(hpc.conn, job_id)
if job_info is None:
    # Job not found — may have completed and left squeue
    poll_state = poll_state.update("UNKNOWN")
    check = await hpc.conn.run(
        f"test -f {work_dir}/OUTCAR || test -f {work_dir}/*.out",
        check=False,
    )
    if check.exit_status == 0:
        logger.info("Job %s completed (no longer in queue)", job_id)
        break  # ← 误判为 completed！
    # Still waiting
    continue  # ← 无限轮询直到 7 天超时！
```

**问题 1：`get_job_status` 返回 None 时没有用 `sacct` 验证**

`get_job_status()` 实际上**已经**内部尝试了 `sacct`（第 638-658 行）。如果 `sacct` 也返回 None，说明作业确实完全消失了。但轮询循环在 `job_info is None` 时只检查 OUTCAR 是否存在，不验证作业是成功还是失败退出。

**问题 2：OUTCAR 存在 ≠ 作业成功**

当节点崩溃时：
- OUTCAR 可能已经部分写入（作业跑了一会） → `test -f OUTCAR` 返回 0 → **误判为 completed**
- 或者 OUTCAR 不存在 → `continue` → 无限轮询直到 7 天超时 → 前端一直显示 running

**问题 3：SSH 断开时轮询直接崩溃**

如果 SSH 连接也断了，`hpc.scheduler.get_job_status(hpc.conn, job_id)` 抛 SSH 异常。虽然 `asyncio.gather(return_exceptions=True)` 能捕获并标记 step 为 failed，但 **广播可能发不到前端**：

1. Backend 广播 `step_status: failed` 到 asyncio Queue
2. WebSocket handler 从 Queue 读取并发送
3. 但前端的 WebSocket 可能也因为网络问题断了
4. 前端 WebSocket 重连最多 5 次，每次指数退避
5. 重连成功时收到 `initial_state`，**这时应该能拿到正确的 DB 状态**
6. 但如果 5 次重连都失败 → 前端永远卡在 running

**问题 4：NodeStatusPanel 的 15 秒 DB 轮询只在 running/queued 时工作**

```typescript
// NodeStatusPanel.svelte
$effect(() => {
  if (status !== `running` && status !== `queued`) return
  const interval = setInterval(async () => {
    const steps = await api.list_steps(workflow_id)
    step_info = steps?.find(s => s.id === node_id) ?? null
    if (step_info?.status && status && step_info.status !== status) {
      onstatus_sync?.(node_id, step_info.status)
    }
  }, 15_000)
  return () => clearInterval(interval)
})
```

这个 DB 轮询**只在状态是 running 或 queued 时才工作**。如果前端认为状态是 running，它确实会每 15 秒查一次 DB。但前提是 `/api/workflow/{id}/steps` 这个 API 调用能成功 — 如果 backend 也有问题，就查不到。

### 最可能的失败场景

1. VASP 作业在超算上运行，节点崩溃
2. SLURM 标记作业为 NODE_FAIL，作业从 `squeue` 消失
3. `get_job_status()` 内部 `squeue` 返回空，尝试 `sacct`
4. `sacct` 返回 `NODE_FAIL` 状态 → `get_job_status` 返回 `JobInfo(status="NODE_FAIL")`
5. 轮询循环第 811 行匹配到 `NODE_FAIL` → raise RuntimeError → step 标记为 failed ✅
6. **但 backend 广播 failed 消息时，前端 WebSocket 可能断了**
7. 前端 15 秒 DB 轮询通过 `list_steps` API 应该能拿到最新状态
8. **如果 API 调用成功，前端应该能更新** → 除非 `onstatus_sync` 回调在 WorkflowEditor 中没正确处理

### 另一种失败场景（更可能）

1. VASP 运行中，用户关闭了 CatGo 或者刷新了页面
2. 重新打开时，workflow monitor WebSocket 重新连接
3. WebSocket handler 发送 `initial_state`
4. **但 Python engine 的后台 task 可能已经结束了**（进程重启/crash）
5. DB 中 step 状态可能仍然是 "running"（因为没来得及更新）
6. 前端收到 `initial_state` 显示 running
7. 没有活跃的后台任务在轮询 → **状态永远卡在 running**

### 修复建议

**1. 轮询循环增加 `sacct` 双重验证：**

```python
if job_info is None:
    # Job left queue — check sacct for final status
    sacct_info = await hpc.scheduler.get_job_status_sacct(hpc.conn, job_id)
    if sacct_info:
        sacct_status = (sacct_info.status or "").upper()
        if sacct_status in ("FAILED", "NODE_FAIL", "TIMEOUT", "CANCELLED", "OOM"):
            raise RuntimeError(f"Job {job_id} failed: {sacct_status}")
        elif sacct_status in ("COMPLETED", "CD"):
            break
    # sacct also empty — check output files
    check = await hpc.conn.run(f"test -f {work_dir}/OUTCAR", check=False)
    if check.exit_status == 0:
        break
    continue
```

**2. Backend 重启时检测孤儿 running 步骤：**

在 `recover_workflows()` 中，如果发现 step 状态是 "running" 但没有活跃的后台任务，应该启动一个 watcher 或标记为 "unknown"。

**3. 前端增加超时检测：**

如果 WebSocket monitor 收到 `initial_state` 时步骤是 running，但超过一定时间（如 30 分钟）没有收到任何 `step_status` 更新，主动查一次后端状态。

---

## 验证步骤

### Bug 1-3 验证（desktop:serve）
1. 启动 `pnpm desktop:serve`
2. 创建工作流，添加 VASP 节点
3. 连接 HPC
4. 点击 Run → 检查浏览器 Console 是否有 `[run_workflow] sync failed` 或 `sync error`
5. 检查 Python backend 日志是否有 `File not found` 或 404 错误

### Bug 5 验证（tauri:dev）
1. 启动 `pnpm tauri:dev`
2. 连接超算
3. 创建新工作流，添加 `vasp_relax` 节点
4. **不运行**，直接点开节点查看状态面板
5. 观察 HPC 连接状态 → 应该显示已连接但实际显示未连接

---

## 修复记录（2026-03-17）

### Bug 1 + Bug 2
**`src/lib/api/workflow.ts`** — `run_workflow()` 重写：
- 移除 `.catch(() => {})` 和无 return 的 error 处理
- `db/open` 和 sync 失败现在 `throw new Error()`，阻止 `/run` 执行
- 同步前调用 `flush_now()` 确保 WASM DB 已写盘

**`src/lib/api/db-wasm.ts`** — `flush_now()` 改为 `export`

### Bug 3
**`server/routers/workflow.py`** — `api_open_db()` 增加 project root fallback：
- 相对路径在 cwd 找不到时，尝试从项目根目录解析
- 始终使用 `p.resolve()` 存储绝对路径

### Bug 5
**`src/lib/workflow/NodeStatusPanel.svelte`** — `is_hpc_step` 改为节点类型判断：
- 新增 `HPC_NODE_TYPES` 集合，包含所有计算节点类型
- 额外检查 `node_params?.software` 作为通用判断
- session fallback 放宽为 `sessions.length >= 1`

### Bug 6（三层修复）
1. **`server/workflow/python_engine.py`** — 轮询循环 sacct 验证：
   - 作业从 squeue 消失时，先用 `get_job_status_sacct()` 查终态
   - `NODE_FAIL`/`TIMEOUT`/`CANCELLED`/`OOM` → 立即 raise
   - 用 `hasattr` 保护，PBS/Local scheduler 不受影响

2. **`server/workflow/engine.py`** — `recover_workflows()` 增加 step 恢复：
   - 重启时将 `running`/`submitting`/`queued` 的 step 标记为 `failed`
   - 附带错误信息 "Backend restarted while step was running"

3. **`src/lib/workflow/WorkflowEditor.svelte`** — 前端 stale-running 检测：
   - `on_initial_state` 有 running 步骤时启动 2 分钟定时器
   - 每次收到 `step_status` 重置定时器
   - 超时后通过 `list_steps` API 查询后端真实状态
   - 同时覆盖 `running` 和 `queued` 的 stale 检测
   - 若步骤仍在运行则自动重新调度
