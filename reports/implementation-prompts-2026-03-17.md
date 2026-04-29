# 实施 Prompts：逐步实现指南

**日期:** 2026-03-17
**使用方法:** 每个 Prompt 直接复制给 Claude 执行。按顺序执行，每个 Prompt 完成后 commit + 验证再进入下一个。

## 实施状态 (2026-03-18 更新)

**分支:** `CatGo-PRO` | **全部 14 个 Prompt 已完成** ✅

| # | 功能 | 状态 | Commit |
|---|------|------|--------|
| 1 | 轮询容错 + 指数退避 | ✅ 已完成 | `bdd7083` |
| 2 | 孤儿 Step 检测 | ✅ 已完成 | `5c02737` |
| 3 | 状态转换审计日志 | ✅ 已完成 | `f639b7c` |
| 4 | 错误分类 (remote/compute/input) | ✅ 已完成 | `7e3381d` |
| 5 | 单节点重试 + 级联失效 | ✅ 已完成 | `882833a` |
| 6 | 参数变更检测 | ✅ 已完成 | `8155a57` |
| 7 | Batch Node — DB + 后端引擎 | ✅ 已完成 | `025c7cc` |
| 8 | Batch Node — API 端点 | ✅ 已完成 | `f0517d1` |
| 9 | Batch Node — 前端面板 | ✅ 已完成 | `43c33c1` |
| 10 | 自由能 + OER 过电位 | ✅ 已完成 | `86a774e` |
| 11 | CO2RR + NRR + Volcano Plot | ✅ 已完成 | `86a774e` |
| 12 | 数据溯源 (_provenance) | ✅ 已完成 | `09a128c` |
| 13 | 静默错误消除 | ✅ 已完成 | `f5aba51` |
| 14 | 前端诊断面板 | ✅ 已完成 | `4ab2c7a` |

---

## Prompt 1: 轮询容错 + 指数退避

```
请修改 server/workflow/hpc_poll.py 和 server/workflow/hpc_execute.py，为 HPC 作业轮询增加容错和指数退避机制。

## 需求

1. 在 hpc_execute.py 的轮询循环中（调用 hpc.scheduler.get_job_status 的地方），增加 try/except：
   - SSH 异常时不崩溃，而是重试
   - 最多重试 3 次，退避时间 30s, 300s, 1200s
   - 3 次都失败后 raise RuntimeError
   - 每次失败时尝试重新获取 HPC 连接（pool.get_connection）

2. 在 hpc_poll.py 的 _watch_job_completion() 中应用同样的容错逻辑

3. 在 workflow_steps 表增加 last_polled_at 列，每次轮询成功后更新

## 参考代码（来自 jobflow-remote）

```python
# jobflow-remote 的重试模式
MAX_POLL_RETRIES = 3
RETRY_DELAYS = (30, 300, 1200)  # 30秒, 5分钟, 20分钟

# 在轮询循环中：
poll_failures = 0
while time.time() - start_time < max_wait:
    try:
        job_info = await hpc.scheduler.get_job_status(hpc.conn, job_id)
        poll_failures = 0  # 成功则重置
    except Exception as e:
        poll_failures += 1
        if poll_failures > MAX_POLL_RETRIES:
            raise RuntimeError(f"SSH polling failed {MAX_POLL_RETRIES} times: {e}")
        delay = RETRY_DELAYS[min(poll_failures - 1, len(RETRY_DELAYS) - 1)]
        logger.warning("Poll failed (%d/%d), retrying in %ds: %s",
                       poll_failures, MAX_POLL_RETRIES, delay, e)
        await asyncio.sleep(delay)
        # 尝试重连
        hpc = pool.get_connection(session_id)
        if not hpc:
            continue
        continue
```

## DB 修改

```sql
-- server/utils/workflow_db.py 的 _ensure_db() 中增加
ALTER TABLE workflow_steps ADD COLUMN last_polled_at TEXT;
```

更新轮询时：
```python
update_step(workflow_id, node_id, {"last_polled_at": datetime.now(timezone.utc).isoformat()})
```

## 文件清单
- 修改: server/workflow/hpc_execute.py（轮询循环加 try/except + 退避）
- 修改: server/workflow/hpc_poll.py（_watch_job_completion 加容错）
- 修改: server/utils/workflow_db.py（增加 last_polled_at 列）

## 验证
修改后运行：
```bash
cd server && python -c "from workflow.hpc_execute import _execute_hpc_node; print('OK')"
cd server && python -c "from workflow.hpc_poll import _watch_job_completion; print('OK')"
```
```

---

## Prompt 2: 孤儿 Step 检测

```
请修改 server/workflow/engine.py 的 recover_workflows() 函数，增加孤儿 step 检测和恢复逻辑。

## 需求

1. 在 recover_workflows() 中，除了把 running 工作流标记为 paused，还要：
   - 查找所有 status='running' 或 'queued' 的 step
   - 检查 last_polled_at 是否超过 30 分钟（如果有）
   - 对有 hpc_job_id 的 step，尝试用 sacct 查询真实状态
   - 如果 sacct 返回 FAILED/NODE_FAIL/TIMEOUT/CANCELLED → 标记 step 为 failed
   - 如果 sacct 返回 COMPLETED → 标记 step 为 completed
   - 如果无法查询（SSH 断了）→ 标记为 failed，error_message="Backend restarted, unable to verify job status"

2. 增加一个定时任务 detect_orphan_steps()，在 main.py 的 lifespan 中每 5 分钟运行一次

## 参考代码（来自 FireWorks detect_lostruns）

```python
# FireWorks 的孤儿检测思路（适配为 SQLite + asyncio）
async def detect_orphan_steps():
    """检测超过 30 分钟没有心跳的 running 步骤。"""
    from utils.workflow_db import get_db, update_step
    from utils.connection_pool import pool

    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
    with get_db() as conn:
        orphans = conn.execute("""
            SELECT id, workflow_id, hpc_job_id, hpc_session_id
            FROM workflow_steps
            WHERE status IN ('running', 'queued')
            AND (last_polled_at IS NULL OR last_polled_at < ?)
        """, (cutoff,)).fetchall()

    for step in orphans:
        hpc = pool.get_connection(step["hpc_session_id"]) if step["hpc_session_id"] else None
        if hpc and step["hpc_job_id"]:
            try:
                job_info = await hpc.scheduler.get_job_status(hpc.conn, step["hpc_job_id"])
                if job_info is None:
                    # 作业消失了
                    update_step(step["workflow_id"], step["id"], {
                        "status": "failed",
                        "error_message": "Job no longer in scheduler queue (orphan recovery)"
                    })
                elif job_info.status.upper() in ("FAILED", "F", "NODE_FAIL", "NF", "TIMEOUT", "TO", "CANCELLED", "CA", "OOM"):
                    update_step(step["workflow_id"], step["id"], {
                        "status": "failed",
                        "error_message": f"Orphan detected, SLURM status: {job_info.status}"
                    })
                elif job_info.status.upper() in ("COMPLETED", "CD"):
                    update_step(step["workflow_id"], step["id"], {
                        "status": "completed",
                    })
                # else: still running, update last_polled_at
            except Exception as e:
                logger.warning("Cannot check orphan step %s: %s", step["id"], e)
        else:
            # 无法查询 → 标记为 failed
            update_step(step["workflow_id"], step["id"], {
                "status": "failed",
                "error_message": "Backend restarted while step was running, HPC session unavailable"
            })
```

## 定时任务集成

```python
# server/main.py lifespan 中增加
import asyncio

async def _orphan_scanner():
    """每 5 分钟扫描孤儿 step。"""
    while True:
        await asyncio.sleep(300)
        try:
            from workflow.engine import detect_orphan_steps
            await detect_orphan_steps()
        except Exception as e:
            logging.getLogger(__name__).warning("Orphan scan failed: %s", e)

# 在 lifespan 的 yield 之前启动
orphan_task = asyncio.create_task(_orphan_scanner())
try:
    yield
finally:
    orphan_task.cancel()
```

## 文件清单
- 修改: server/workflow/engine.py（recover_workflows + detect_orphan_steps）
- 修改: server/main.py（定时任务）

## 验证
```bash
cd server && python -c "from workflow.engine import detect_orphan_steps; print('OK')"
```
```

---

## Prompt 3: 状态转换审计日志

```
请在 workflow_steps 表增加状态转换审计日志功能。

## 需求

1. workflow_steps 表增加 state_history TEXT DEFAULT '[]' 列
2. 每次 update_step() 改变 status 时，自动追加一条记录到 state_history
3. state_history 格式为 JSON 数组：
   [{"state": "pending", "created_on": "2026-03-17T14:00:00Z"},
    {"state": "running", "created_on": "2026-03-17T14:01:00Z"},
    {"state": "completed", "created_on": "2026-03-17T14:30:00Z"}]

## 参考代码（来自 FireWorks）

```python
# FireWorks 的 state_history 模式
class Launch:
    def _update_state_history(self, state):
        if state != self.state_history[-1]["state"]:
            self.state_history.append({
                "state": state,
                "created_on": datetime.now(timezone.utc).isoformat(),
            })
```

## 实现

修改 server/utils/workflow_db.py：

```python
import json

def update_step(workflow_id: str, step_id: str, updates: dict):
    """Update a workflow step, auto-appending to state_history if status changes."""
    with _write_lock:
        with get_db() as conn:
            # If status is changing, append to state_history
            if "status" in updates:
                row = conn.execute(
                    "SELECT status, state_history FROM workflow_steps WHERE id = ? AND workflow_id = ?",
                    (step_id, workflow_id)
                ).fetchone()
                if row and row["status"] != updates["status"]:
                    history = json.loads(row["state_history"] or "[]")
                    history.append({
                        "state": updates["status"],
                        "created_on": datetime.now(timezone.utc).isoformat(),
                    })
                    updates["state_history"] = json.dumps(history)

            # ... existing UPDATE logic ...
```

## DB 迁移

```sql
ALTER TABLE workflow_steps ADD COLUMN state_history TEXT DEFAULT '[]';
```

## 文件清单
- 修改: server/utils/workflow_db.py（update_step + schema migration）

## 验证
```bash
cd server && python -c "
from utils.workflow_db import _ensure_db, update_step, get_db
_ensure_db()
print('OK')
"
```
```

---

## Prompt 4: 错误分类（remote_error vs compute_error）

```
请在 workflow_steps 表增加错误分类字段，区分基础设施错误和计算错误。

## 需求

1. workflow_steps 表增加：
   - error_type TEXT — 'remote_error' | 'compute_error' | 'input_error' | NULL
   - retry_count INTEGER DEFAULT 0

2. 修改 server/workflow/hpc_execute.py 和 server/workflow/orchestrator.py：
   - SSH/网络异常 → error_type='remote_error'（可自动重试）
   - VASP 算法错误（ZBRENT、EDDDAV 等）→ error_type='compute_error'（不可自动重试）
   - 输入参数错误（POTCAR 缺失等）→ error_type='input_error'（需要用户干预）

3. 修改 server/workflow/node_dispatch.py 的 _execute_node() 中错误处理部分：
   - 根据异常类型设置 error_type

## 参考代码（来自 jobflow-remote）

```python
# jobflow-remote 的 RemoteError 模式
class RemoteError(Exception):
    """基础设施错误。"""
    def __init__(self, msg, no_retry=False):
        self.msg = msg
        self.no_retry = no_retry  # True = 永久失败

# 在 _execute_node 的错误处理中：
for node_id, result in zip(task_node_ids, results):
    if isinstance(result, Exception):
        error_msg = str(result)
        # 分类错误
        if isinstance(result, (ConnectionError, asyncssh.Error, OSError)):
            error_type = "remote_error"
        elif "POTCAR" in error_msg or "INCAR" in error_msg:
            error_type = "input_error"
        else:
            error_type = "compute_error"

        update_step(workflow_id, node_id, {
            "status": "failed",
            "error_message": error_msg,
            "error_type": error_type,
        })
```

## DB 迁移

```sql
ALTER TABLE workflow_steps ADD COLUMN error_type TEXT;
ALTER TABLE workflow_steps ADD COLUMN retry_count INTEGER DEFAULT 0;
```

## 文件清单
- 修改: server/utils/workflow_db.py（schema）
- 修改: server/workflow/orchestrator.py（_run_workflow 错误处理）
- 修改: server/workflow/hpc_execute.py（轮询错误分类）

## 验证
```bash
cd server && python -c "from utils.workflow_db import _ensure_db; _ensure_db(); print('OK')"
```
```

---

## Prompt 5: 单节点重试 + 级联失效

```
请实现"从这里重跑"功能：重置一个 step 及其所有下游依赖为 pending。

## 需求

### 后端

1. 在 server/utils/workflow_db.py 新增 reset_step_and_descendants()：
   - 从 workflow_edges 表构建邻接表
   - BFS 从目标 step 出发找所有后继节点
   - 批量 UPDATE status='pending', result_json='{}', error_message=NULL 等
   - 返回被重置的节点 ID 列表

2. 在 server/routers/workflow.py 新增 API：
   POST /api/workflow/{workflow_id}/steps/{step_id}/retry
   返回 {"reset_nodes": ["id1", "id2", ...]}

### 前端

3. 在 src/lib/workflow/WorkflowEditor.svelte 的节点右键菜单增加"从这里重跑"选项
4. 调用 API 后刷新 node_statuses

## 参考代码（来自 FireWorks rerun_fw）

```python
# FireWorks 的级联重跑模式
class Workflow:
    def rerun_fw(self, fw_id, updated_ids=None):
        updated_ids = updated_ids or set()
        m_fw = self.id_fw[fw_id]
        m_fw._rerun()          # 重置自己
        updated_ids.add(fw_id)
        # 递归重置所有子节点
        for child_id in self.links[fw_id]:
            if self.id_fw[child_id].state != "WAITING":
                updated_ids = updated_ids.union(self.rerun_fw(child_id, updated_ids))
        return updated_ids
```

## CatGo 实现

```python
# server/utils/workflow_db.py
from collections import deque

def reset_step_and_descendants(workflow_id: str, step_id: str) -> list[str]:
    """重置一个 step 及其所有下游依赖为 pending。"""
    with _write_lock:
        with get_db() as conn:
            # 构建邻接表
            edges = conn.execute(
                "SELECT source_id, target_id FROM workflow_edges WHERE workflow_id = ?",
                (workflow_id,)
            ).fetchall()

            adj: dict[str, list[str]] = {}
            for src, tgt in edges:
                adj.setdefault(src, []).append(tgt)

            # BFS 找所有后继
            to_reset: set[str] = set()
            queue = deque([step_id])
            while queue:
                nid = queue.popleft()
                if nid in to_reset:
                    continue
                to_reset.add(nid)
                queue.extend(adj.get(nid, []))

            # 批量重置
            ids = list(to_reset)
            placeholders = ",".join("?" * len(ids))
            conn.execute(f"""
                UPDATE workflow_steps
                SET status = 'pending', result_json = '{{}}',
                    error_message = NULL, error_type = NULL,
                    retry_count = 0,
                    started_at = NULL, completed_at = NULL
                WHERE workflow_id = ? AND id IN ({placeholders})
            """, [workflow_id, *ids])
            conn.commit()

    return ids
```

```python
# server/routers/workflow.py 新增
@router.post("/{workflow_id}/steps/{step_id}/retry")
async def api_retry_step(workflow_id: str, step_id: str):
    """Reset a step and all downstream dependencies to pending."""
    from utils.workflow_db import reset_step_and_descendants
    reset_ids = reset_step_and_descendants(workflow_id, step_id)
    if not reset_ids:
        raise HTTPException(status_code=404, detail=f"Step {step_id} not found")
    return {"reset_nodes": reset_ids, "message": f"Reset {len(reset_ids)} nodes to pending"}
```

## 前端右键菜单

在 WorkflowEditor.svelte 的节点右键菜单部分，找到现有的 context menu 代码，增加"从这里重跑"选项。
调用 `fetch(\`\${API_BASE}/workflow/\${workflow_id}/steps/\${node_id}/retry\`, { method: 'POST' })` 后刷新 node_statuses。

## 文件清单
- 修改: server/utils/workflow_db.py（reset_step_and_descendants）
- 修改: server/routers/workflow.py（新增 API）
- 修改: src/lib/workflow/WorkflowEditor.svelte（右键菜单）

## 验证
```bash
cd server && python -c "from utils.workflow_db import reset_step_and_descendants; print('OK')"
```
```

---

## Prompt 6: 参数变更检测

```
请实现 resume 时自动检测参数变化，只重跑参数改了的节点及其下游。

## 需求

1. 节点完成时，把当前参数的 hash 保存到 result_json 的 _params_hash 字段
2. resume 时（server/workflow/orchestrator.py 的 _run_workflow），加载 already_completed 后：
   - 比较每个已完成节点的 _params_hash 和当前 graph_json 中的参数 hash
   - 不一致的节点 + 所有下游 → 从 already_completed 中移除 → 重置为 pending

## 实现

```python
# 计算参数指纹
import hashlib
import json

def _compute_params_hash(params: dict) -> str:
    serialized = json.dumps(params, sort_keys=True, default=str)
    return hashlib.md5(serialized.encode()).hexdigest()
```

在 node_dispatch.py 的 _execute_node() 完成后（persist_step_result 之前）：
```python
step_results[node_id]["_params_hash"] = _compute_params_hash(params)
```

在 orchestrator.py 的 _run_workflow() 中，load_completed_results 之后：
```python
# 检查参数变更
node_params_map = {n["id"]: n.get("params") or n.get("data", {}).get("params", {}) for n in nodes}
invalidated = set()

for node_id in list(already_completed):
    saved_hash = step_results.get(node_id, {}).get("_params_hash")
    if saved_hash is None:
        continue  # 旧数据没有 hash，跳过
    current_hash = _compute_params_hash(node_params_map.get(node_id, {}))
    if saved_hash != current_hash:
        # 参数变了 → 找所有下游
        descendants = _get_descendants(node_id, edges)
        invalidated.update(descendants)
        invalidated.add(node_id)

if invalidated:
    logger.info("Params changed for %d nodes, invalidating: %s", len(invalidated), invalidated)
    already_completed -= invalidated
    for nid in invalidated:
        update_step(workflow_id, nid, {"status": "pending", "result_json": "{}"})

def _get_descendants(node_id: str, edges: list[dict]) -> set[str]:
    """BFS 找所有下游节点。"""
    from collections import deque
    adj: dict[str, list[str]] = {}
    for e in edges:
        src = e.get("source") or e.get("source_id", "")
        tgt = e.get("target") or e.get("target_id", "")
        adj.setdefault(src, []).append(tgt)
    result = set()
    queue = deque(adj.get(node_id, []))
    while queue:
        nid = queue.popleft()
        if nid in result:
            continue
        result.add(nid)
        queue.extend(adj.get(nid, []))
    return result
```

## 文件清单
- 修改: server/workflow/orchestrator.py（_run_workflow 中检测参数变更）
- 修改: server/workflow/node_dispatch.py（_execute_node 完成后保存 _params_hash）

## 验证
```bash
cd server && python -c "from workflow.orchestrator import _run_workflow; print('OK')"
```
```

---

## Prompt 7: Batch Node — 数据库 + 后端引擎

```
请实现 Batch Node 的后端部分：batch_subtasks 数据库表 + SLURM array job 执行引擎。

## 需求

### 数据库

1. 在 server/utils/batch_db.py 新建文件，包含 batch_subtasks 表的 CRUD：

```sql
CREATE TABLE IF NOT EXISTS batch_subtasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    step_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    subtask_index INTEGER NOT NULL,
    slurm_array_id TEXT,
    status TEXT DEFAULT 'pending',
    work_dir TEXT,
    energy REAL,
    result_json TEXT DEFAULT '{}',
    error_message TEXT,
    started_at TEXT,
    completed_at TEXT,
    input_hash TEXT,
    UNIQUE(step_id, subtask_index)
);
CREATE INDEX IF NOT EXISTS idx_batch_step ON batch_subtasks(step_id, status);
CREATE INDEX IF NOT EXISTS idx_batch_energy ON batch_subtasks(step_id, energy);
```

需要的函数：
- insert_subtasks_batch(workflow_id, step_id, count) — 批量插入 N 行
- update_subtask_statuses(workflow_id, step_id, statuses_dict) — 批量更新状态
- update_subtask_result(workflow_id, step_id, index, **kwargs) — 更新单个子任务结果
- get_batch_summary(workflow_id, step_id) — 聚合统计
- get_batch_results_page(workflow_id, step_id, page, per_page, sort, order, status_filter) — 分页查询
- get_failed_subtask_indices(workflow_id, step_id) — 获取失败子任务的 index 列表

### 执行引擎

2. 新建 server/workflow/batch_execute.py：

```python
async def execute_batch_hpc(
    workflow_id, node_id, node_type, structures, params, config, hpc
):
    """Execute N structures as a single SLURM array job."""
    max_concurrent = params.get("max_concurrent", 50)
    batch_dir = f"{work_dir_base}/batch_{node_id}"
    n = len(structures)

    # Phase 1: 上传所有输入（并发限流）
    sem = asyncio.Semaphore(20)
    async def upload_one(i, struct):
        async with sem:
            sub_dir = f"{batch_dir}/{i:06d}"
            await hpc.conn.run(f"mkdir -p {sub_dir}")
            await write_vasp_inputs(hpc, sub_dir, struct, params)

    await asyncio.gather(*[upload_one(i, s) for i, s in enumerate(structures)])

    # Phase 2: 生成 + 提交 SLURM array job
    script = f"""#!/bin/bash
#SBATCH --array=0-{n-1}%{max_concurrent}
#SBATCH --job-name=catgo_batch_{node_id[:8]}
#SBATCH --ntasks={params.get('ntasks', 1)}
#SBATCH --time={params.get('walltime', '24:00:00')}
#SBATCH --partition={params.get('partition', 'workq')}

cd {batch_dir}/$(printf "%06d" $SLURM_ARRAY_TASK_ID)
{params.get('vasp_command', 'vasp_std')}
"""
    job_id = await submit(hpc, script)

    # Phase 3: 轮询 sacct 批量状态
    while not all_done:
        statuses = await poll_array_status(hpc, job_id, n)
        update_subtask_statuses(workflow_id, node_id, statuses)
        await broadcast_progress(...)
        if completed + failed >= n:
            break
        await asyncio.sleep(poll_interval)

    # Phase 4: 批量收集结果
    ...
```

3. sacct 批量查询函数（放在 server/utils/slurm.py 中新增）：

```python
async def get_array_job_statuses(self, conn, array_job_id, n):
    """sacct -j <array_id> 一次返回所有子任务状态。"""
    result = await self._run(conn,
        f"sacct -j {array_job_id} -n -o JobID,State --parsable2")
    statuses = {}
    for line in (result.stdout or "").strip().split('\n'):
        if not line:
            continue
        parts = line.split('|')
        if '_' in parts[0] and '.' not in parts[0]:
            idx = int(parts[0].split('_')[1])
            statuses[idx] = parts[1].strip()
    return statuses
```

## 文件清单
- 新建: server/utils/batch_db.py
- 新建: server/workflow/batch_execute.py
- 修改: server/utils/slurm.py（增加 get_array_job_statuses）

## 验证
```bash
cd server && python -c "from utils.batch_db import ensure_batch_tables; ensure_batch_tables(); print('OK')"
cd server && python -c "from workflow.batch_execute import execute_batch_hpc; print('OK')"
```
```

---

## Prompt 8: Batch Node — API 端点

```
请为 Batch Node 实现服务端 API 端点（分页查询、聚合统计、失败重试）。

## 需求

在 server/routers/workflow.py 新增 4 个端点：

### 1. GET /{workflow_id}/steps/{step_id}/batch-summary
返回批量任务的汇总统计（不加载全部数据）。

### 2. GET /{workflow_id}/steps/{step_id}/batch-results
分页查询子任务结果。支持参数：page, per_page, sort(energy/subtask_index/status), order(asc/desc), status(筛选)。

### 3. GET /{workflow_id}/steps/{step_id}/batch-histogram
能量分布直方图（服务端计算，返回 bins + counts）。

### 4. POST /{workflow_id}/steps/{step_id}/batch-retry
重新提交失败的子任务。接收 indices 列表（可选，默认所有 failed）。重置 DB 状态 + sbatch --array=失败的indices。

## 参考实现

```python
@router.get("/{workflow_id}/steps/{step_id}/batch-summary")
async def api_batch_summary(workflow_id: str, step_id: str):
    from utils.batch_db import get_batch_summary
    return get_batch_summary(workflow_id, step_id)

@router.get("/{workflow_id}/steps/{step_id}/batch-results")
async def api_batch_results(
    workflow_id: str, step_id: str,
    page: int = 1, per_page: int = 50,
    sort: str = "energy", order: str = "asc",
    status: str | None = None,
):
    from utils.batch_db import get_batch_results_page
    return get_batch_results_page(workflow_id, step_id, page, per_page, sort, order, status)

@router.get("/{workflow_id}/steps/{step_id}/batch-histogram")
async def api_batch_histogram(workflow_id: str, step_id: str, bins: int = 30):
    from utils.batch_db import get_batch_energies
    energies = get_batch_energies(workflow_id, step_id)
    if not energies:
        return {"bins": [], "counts": []}
    import numpy as np
    counts, bin_edges = np.histogram(energies, bins=bins)
    return {
        "bins": [(bin_edges[i] + bin_edges[i+1]) / 2 for i in range(len(counts))],
        "counts": counts.tolist(),
    }

@router.post("/{workflow_id}/steps/{step_id}/batch-retry")
async def api_batch_retry(workflow_id: str, step_id: str, body: dict | None = None):
    from utils.batch_db import get_failed_subtask_indices, reset_subtasks
    indices = (body or {}).get("indices") or get_failed_subtask_indices(workflow_id, step_id)
    if not indices:
        return {"retried": 0}
    reset_subtasks(workflow_id, step_id, indices)
    # 重新提交 sbatch --array=47,203,891
    array_spec = ",".join(str(i) for i in sorted(indices))
    # ... submit logic ...
    return {"retried": len(indices), "indices": indices}
```

## 文件清单
- 修改: server/routers/workflow.py（4 个新端点）

## 验证
启动 backend 后用 curl 测试：
```bash
curl http://localhost:8000/api/workflow/test/steps/test/batch-summary
```
```

---

## Prompt 9: Batch Node — 前端 BatchStatusPanel

```
请实现 Batch Node 的前端组件 BatchStatusPanel.svelte。

## 需求

1. 新建 src/lib/workflow/BatchStatusPanel.svelte
2. 当 NodeStatusPanel 检测到节点是 batch 类型时，渲染 BatchStatusPanel

### UI 结构

```
┌─────────────────────────────────────────────────────┐
│  batch_geo_opt                    9,847 / 10,000    │
│  ████████████████████████████████████░░░  98.5%      │
│  ✅ 9,712 completed  🔄 135 running  ❌ 12 failed   │
│                                                      │
│  [Overview] [Table] [Failed]                         │
│                                                      │
│  Tab: Overview                                       │
│  ┌─ Summary ────────────────────────────────────┐   │
│  │ Energy range: -45.2 ~ -38.7 eV              │   │
│  │ Mean: -42.3 eV  Std: 1.8 eV                 │   │
│  │ Converged: 9,680 (99.7%)                     │   │
│  └──────────────────────────────────────────────┘   │
│  ┌─ Energy Distribution ────────────────────────┐   │
│  │ (histogram chart)                            │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  Tab: Table (服务端分页)                              │
│  ┌────┬──────────┬───────────┬─────────┐            │
│  │ #  │ Energy   │ Status    │ Action  │            │
│  │ 1  │ -45.21   │ ✅        │ View    │            │
│  │ 2  │ -44.98   │ ✅        │ View    │            │
│  └────┴──────────┴───────────┴─────────┘            │
│  Page 1/200  [< Prev] [Next >]                      │
│                                                      │
│  Tab: Failed                                         │
│  [Retry All Failed (12)]                             │
│  ┌────┬──────────┬──────────────────┬─────────┐     │
│  │ #  │ Index    │ Error            │ Retry   │     │
│  └────┴──────────┴──────────────────┴─────────┘     │
└─────────────────────────────────────────────────────┘
```

### 关键状态

```typescript
let summary = $state<BatchSummary | null>(null)
let results_page = $state<BatchResultPage | null>(null)
let histogram = $state<{bins: number[], counts: number[]} | null>(null)
let active_tab = $state<'overview' | 'table' | 'failed'>('overview')
let current_page = $state(1)

// 运行中时每 5 秒刷新 summary
$effect(() => {
  if (status !== 'running') return
  const timer = setInterval(async () => {
    summary = await fetchBatchSummary(workflow_id, step_id)
  }, 5000)
  return () => clearInterval(timer)
})
```

### API 调用

```typescript
const API = `${API_BASE}/workflow/${workflow_id}/steps/${step_id}`

async function fetchBatchSummary() {
  const res = await fetch(`${API}/batch-summary`)
  return res.json()
}

async function fetchBatchResults(page = 1, sort = 'energy', order = 'asc') {
  const res = await fetch(`${API}/batch-results?page=${page}&per_page=50&sort=${sort}&order=${order}`)
  return res.json()
}

async function fetchHistogram() {
  const res = await fetch(`${API}/batch-histogram?bins=30`)
  return res.json()
}

async function retryFailed() {
  await fetch(`${API}/batch-retry`, { method: 'POST' })
  await fetchBatchSummary()  // 刷新
}
```

### WebSocket 进度

在 WorkflowEditor.svelte 的 monitor 回调中增加 batch_progress 处理：
```typescript
case 'batch_progress':
  // 更新 BatchStatusPanel 的进度
  break
```

## 文件清单
- 新建: src/lib/workflow/BatchStatusPanel.svelte
- 修改: src/lib/workflow/NodeStatusPanel.svelte（检测 batch 节点时渲染 BatchStatusPanel）
- 修改: src/lib/workflow/WorkflowEditor.svelte（batch_progress WebSocket 消息处理）

## 注意
- 直方图可以用简单的 SVG bar chart 实现，不需要引入图表库
- 表格使用服务端分页，前端永远不加载超过 50 条数据
- 进度条可以用 CSS 实现（div + width 百分比）
```

---

## Prompt 10: 催化活性分析 — 自由能 + OER 过电位

```
请实现催化活性分析模块：自由能计算和 OER 过电位。

## 需求

### 1. 新建 server/workflow/catalysis/free_energy.py

```python
"""Gibbs free energy correction: G = E_DFT + ZPE - T*S"""

import math

# 物理常数
KB = 8.617333262e-5   # eV/K (Boltzmann)
HBAR = 6.582119514e-16  # eV·s (reduced Planck)
H_EV_S = 4.135667696e-15  # eV·s (Planck)

# 标准参考自由能 (eV, 298.15K, 1 atm)
REFERENCE_ENERGIES = {
    "H2_gas": -6.77,      # 从 DFT 计算获得，用户可覆盖
    "H2O_liquid": -14.22,  # 同上
    "N2_gas": -16.64,
    "CO2_gas": -22.96,
}


def compute_zpe(frequencies_cm: list[float]) -> float:
    """从频率（cm⁻¹）计算零点能 (eV)。"""
    zpe = 0.0
    for freq in frequencies_cm:
        if freq > 0:  # 忽略虚频
            # E = 0.5 * h * nu
            nu_hz = freq * 2.998e10  # cm⁻¹ → Hz
            zpe += 0.5 * H_EV_S * nu_hz
    return zpe


def compute_entropy_correction(frequencies_cm: list[float], temperature: float = 298.15) -> float:
    """从频率计算 -T*S 修正 (eV)。"""
    ts = 0.0
    for freq in frequencies_cm:
        if freq <= 0:
            continue
        nu_hz = freq * 2.998e10
        x = H_EV_S * nu_hz / (KB * temperature)
        if x > 100:
            continue  # 避免溢出
        # S_vib = k * [x/(e^x - 1) - ln(1 - e^{-x})]
        s_vib = KB * (x / (math.exp(x) - 1) - math.log(1 - math.exp(-x)))
        ts += temperature * s_vib
    return -ts


def gibbs_free_energy(
    e_dft: float,
    frequencies_cm: list[float] | None = None,
    temperature: float = 298.15,
    zpe: float | None = None,
) -> dict:
    """计算 Gibbs 自由能。"""
    if zpe is None:
        zpe = compute_zpe(frequencies_cm or [])
    ts = compute_entropy_correction(frequencies_cm or [], temperature)
    g = e_dft + zpe + ts  # ts 已经是负的
    return {
        "G": g,
        "E_DFT": e_dft,
        "ZPE": zpe,
        "TS": -ts,
        "temperature": temperature,
    }
```

### 2. 新建 server/workflow/catalysis/oer.py

```python
"""OER (Oxygen Evolution Reaction) overpotential calculation via CHE model."""


def compute_oer_overpotential(
    dG_OH: float,
    dG_O: float,
    dG_OOH: float,
    equilibrium_potential: float = 1.23,
) -> dict:
    """
    计算 OER 四步理论过电位 (CHE 模型)。

    OER 四步机制：
    1. H₂O → *OH + H⁺ + e⁻       ΔG₁ = ΔG_OH
    2. *OH → *O + H⁺ + e⁻         ΔG₂ = ΔG_O - ΔG_OH
    3. *O + H₂O → *OOH + H⁺ + e⁻ ΔG₃ = ΔG_OOH - ΔG_O
    4. *OOH → O₂ + H⁺ + e⁻       ΔG₄ = 4.92 - ΔG_OOH

    η_OER = max(ΔG₁, ΔG₂, ΔG₃, ΔG₄) / e - U_eq
    """
    step1 = dG_OH
    step2 = dG_O - dG_OH
    step3 = dG_OOH - dG_O
    step4 = 4.92 - dG_OOH  # 4.92 eV = 2 * 1.23 eV + 2 * (H₂O → O₂ correction)

    steps = [step1, step2, step3, step4]
    limiting_step = max(range(4), key=lambda i: steps[i])
    eta = steps[limiting_step] - equilibrium_potential

    return {
        "overpotential": max(eta, 0),  # eV
        "limiting_step": limiting_step + 1,
        "step_energies": steps,
        "dG_OH": dG_OH,
        "dG_O": dG_O,
        "dG_OOH": dG_OOH,
    }


def estimate_dG_OOH_from_scaling(dG_OH: float) -> float:
    """Nørskov scaling relation: ΔG_OOH = 0.84 * ΔG_OH + 3.29 eV"""
    return 0.84 * dG_OH + 3.29


def compute_adsorption_free_energy(
    e_slab_ads: float,
    e_slab: float,
    e_ref_molecule: float,
    zpe_correction: float = 0.0,
    ts_correction: float = 0.0,
) -> float:
    """
    ΔG_ads = E(slab+ads) - E(slab) - E(ref) + ΔZPE - TΔS
    """
    return e_slab_ads - e_slab - e_ref_molecule + zpe_correction - ts_correction
```

### 3. 新建 server/workflow/catalysis/__init__.py

```python
from workflow.catalysis.free_energy import gibbs_free_energy, compute_zpe, compute_entropy_correction
from workflow.catalysis.oer import compute_oer_overpotential, compute_adsorption_free_energy, estimate_dG_OOH_from_scaling
```

### 4. 实现 free_energy 工作流节点

在 server/workflow/engines/analysis.py 中实现 free_energy 和 her_analysis 节点（目前是空壳）：

```python
elif node_type == "free_energy":
    from workflow.catalysis.free_energy import gibbs_free_energy
    # 从父节点获取 DFT 能量和频率
    parent_result = step_results.get(parent_ids[0], {})
    e_dft = parent_result.get("final_energy", 0)
    frequencies = parent_result.get("frequencies", [])
    temperature = params.get("temperature", 298.15)

    result = gibbs_free_energy(e_dft, frequencies, temperature)
    step_results[step_id] = result
```

## 文件清单
- 新建: server/workflow/catalysis/__init__.py
- 新建: server/workflow/catalysis/free_energy.py
- 新建: server/workflow/catalysis/oer.py
- 修改: server/workflow/engines/analysis.py（实现 free_energy 节点）

## 验证
```bash
cd server && python -c "
from workflow.catalysis.free_energy import gibbs_free_energy
result = gibbs_free_energy(e_dft=-45.0, frequencies_cm=[3600, 1500, 500])
print(f'G = {result[\"G\"]:.4f} eV, ZPE = {result[\"ZPE\"]:.4f} eV')
"
cd server && python -c "
from workflow.catalysis.oer import compute_oer_overpotential
result = compute_oer_overpotential(dG_OH=1.0, dG_O=2.5, dG_OOH=4.2)
print(f'OER overpotential = {result[\"overpotential\"]:.3f} V, limiting step = {result[\"limiting_step\"]}')
"
```
```

---

## Prompt 11: 催化活性分析 — CO2RR + NRR + Volcano Plot

```
请实现 CO2RR、NRR 过电位计算和 Volcano Plot 数据生成。

## 需求

### 1. 新建 server/workflow/catalysis/co2rr.py

```python
"""CO2RR (CO2 Reduction Reaction) limiting potential calculation."""

def compute_co2rr_limiting_potential(
    dG_COOH: float,
    dG_CO: float,
    pathway: str = "CO",  # "CO", "HCOOH", "CH4", "CH3OH"
) -> dict:
    """
    CO2RR → CO pathway (最常见):
    1. CO₂ + H⁺ + e⁻ → *COOH     ΔG₁ = ΔG_COOH
    2. *COOH + H⁺ + e⁻ → *CO + H₂O  ΔG₂ = ΔG_CO - ΔG_COOH
    3. *CO → CO(g) + *             ΔG₃ = -ΔG_CO

    U_L = -max(ΔG₁, ΔG₂, ΔG₃) / e
    """
    if pathway == "CO":
        steps = [dG_COOH, dG_CO - dG_COOH, -dG_CO]
        step_labels = ["CO₂→*COOH", "*COOH→*CO", "*CO→CO(g)"]
    elif pathway == "HCOOH":
        steps = [dG_COOH, -dG_COOH]  # simplified
        step_labels = ["CO₂→*COOH", "*COOH→HCOOH"]
    else:
        raise ValueError(f"Unsupported CO2RR pathway: {pathway}")

    limiting_idx = max(range(len(steps)), key=lambda i: steps[i])
    limiting_potential = -steps[limiting_idx]

    return {
        "limiting_potential": limiting_potential,
        "limiting_step": limiting_idx + 1,
        "step_energies": steps,
        "step_labels": step_labels,
        "pathway": pathway,
    }
```

### 2. 新建 server/workflow/catalysis/nrr.py

```python
"""NRR (Nitrogen Reduction Reaction) overpotential calculation."""

def compute_nrr_overpotential(
    dG_N2H: float,
    dG_NNH2: float | None = None,
    dG_N: float | None = None,
    dG_NH: float | None = None,
    dG_NH2: float | None = None,
    dG_NH3: float | None = None,
    pathway: str = "distal",  # "distal", "alternating", "enzymatic"
    equilibrium_potential: float = -0.16,  # V vs RHE at 298K
) -> dict:
    """
    NRR distal pathway (6 electron transfer):
    1. N₂ + H⁺ + e⁻ → *N₂H
    2. *N₂H + H⁺ + e⁻ → *N₂H₂
    ...
    6. *NH₂ + H⁺ + e⁻ → NH₃
    """
    # Simplified: use first protonation as descriptor
    steps = [dG_N2H]  # 第一步通常是限速步
    if dG_NH3 is not None:
        steps.append(-dG_NH3)

    limiting_idx = max(range(len(steps)), key=lambda i: steps[i])
    eta = steps[limiting_idx] + equilibrium_potential

    return {
        "overpotential": max(eta, 0),
        "limiting_step": limiting_idx + 1,
        "step_energies": steps,
        "pathway": pathway,
        "dG_N2H": dG_N2H,
    }
```

### 3. 新建 server/workflow/catalysis/volcano.py

```python
"""Volcano plot data generation for catalyst screening."""

def generate_volcano_data(
    catalyst_results: list[dict],
    reaction: str = "OER",  # "OER", "HER", "CO2RR", "NRR"
    descriptor_x: str = "dG_OH",
    descriptor_y: str | None = None,  # None = use overpotential
) -> dict:
    """
    生成 Volcano plot 数据。

    catalyst_results: [
        {"name": "TiO2-Fe", "dG_OH": 1.0, "dG_O": 2.5, "dG_OOH": 4.2, "overpotential": 0.37},
        ...
    ]
    """
    points = []
    for r in catalyst_results:
        x = r.get(descriptor_x)
        if x is None:
            continue
        y = r.get(descriptor_y) if descriptor_y else -r.get("overpotential", 0)
        points.append({
            "name": r.get("name", ""),
            "x": x,
            "y": y,
            **{k: v for k, v in r.items() if k not in ("name",)},
        })

    # 理想 volcano 线（OER）
    ideal_line = None
    if reaction == "OER":
        # 左支：η = dG_OH - 1.23 （step 1 限速）
        # 右支：η = (4.92 - dG_OOH) - 1.23 ≈ (4.92 - 0.84*dG_OH - 3.29) - 1.23
        import numpy as np
        x_range = np.linspace(0.5, 2.5, 100)
        left = x_range - 1.23
        right = (4.92 - (0.84 * x_range + 3.29)) - 1.23
        y_ideal = -np.maximum(left, right)
        ideal_line = {"x": x_range.tolist(), "y": y_ideal.tolist()}

    return {
        "points": points,
        "ideal_line": ideal_line,
        "descriptor_x": descriptor_x,
        "reaction": reaction,
    }
```

### 4. 更新 __init__.py

```python
from workflow.catalysis.co2rr import compute_co2rr_limiting_potential
from workflow.catalysis.nrr import compute_nrr_overpotential
from workflow.catalysis.volcano import generate_volcano_data
```

### 5. API 端点

在 server/routers/workflow.py 增加：

```python
@router.post("/{workflow_id}/volcano-plot")
async def api_volcano_plot(workflow_id: str, body: dict):
    from workflow.catalysis.volcano import generate_volcano_data
    return generate_volcano_data(
        catalyst_results=body.get("results", []),
        reaction=body.get("reaction", "OER"),
        descriptor_x=body.get("descriptor_x", "dG_OH"),
    )
```

## 文件清单
- 新建: server/workflow/catalysis/co2rr.py
- 新建: server/workflow/catalysis/nrr.py
- 新建: server/workflow/catalysis/volcano.py
- 修改: server/workflow/catalysis/__init__.py
- 修改: server/routers/workflow.py（volcano-plot 端点）

## 验证
```bash
cd server && python -c "
from workflow.catalysis.co2rr import compute_co2rr_limiting_potential
result = compute_co2rr_limiting_potential(dG_COOH=0.5, dG_CO=-0.3)
print(f'CO2RR limiting potential = {result[\"limiting_potential\"]:.3f} V')
"
cd server && python -c "
from workflow.catalysis.volcano import generate_volcano_data
data = generate_volcano_data([
    {'name': 'TiO2-Fe', 'dG_OH': 1.0, 'overpotential': 0.37},
    {'name': 'TiO2-Co', 'dG_OH': 1.5, 'overpotential': 0.27},
], reaction='OER')
print(f'{len(data[\"points\"])} points, ideal_line has {len(data[\"ideal_line\"][\"x\"])} points')
"
```
```

---

## Prompt 12: 数据溯源（Provenance）

```
请在工作流结果中增加计算溯源记录。

## 需求

每个 HPC 节点完成后，在 result_json 中记录 _provenance 字段。

## 实现

修改 server/workflow/hpc_execute.py，在 _execute_hpc_node() 收集结果后增加：

```python
# 在 step_results[node_id] 赋值之后，persist_step_result 之前
step_results[node_id]["_provenance"] = {
    "catgo_version": "0.1.0",  # 可从 package.json 读取
    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "software": _get_software_name(node_type, params),
    "input_params": {k: v for k, v in params.items() if not k.startswith("_")},
    "input_structure_hash": hashlib.md5(
        json.dumps(parent_structure, sort_keys=True, default=str).encode()
    ).hexdigest() if parent_structure else None,
    "hpc_host": hpc.host,
    "hpc_job_id": job_id,
    "work_dir": work_dir,
    "walltime_used": _parse_walltime_from_sacct(hpc, job_id),  # 可选
    "parent_steps": _get_parent_ids(node_id, edges),
}

def _get_software_name(node_type: str, params: dict) -> str:
    if "vasp" in node_type:
        return "vasp"
    if "orca" in node_type:
        return "orca"
    sw = params.get("software", "")
    return sw or node_type
```

## 参考（来自 atomate2 TaskDoc）

atomate2 存储的溯源信息：
- calcs_reversed: 每步计算的详细记录
- custodian: 修正记录
- run_stats: 平均内存、峰值内存、墙钟时间、核数
- analysis: 体积变化、最大力、警告

CatGo 暂时不需要这么详细，但 _provenance 字段预留了扩展空间。

## 文件清单
- 修改: server/workflow/hpc_execute.py（增加 _provenance 记录）

## 验证
无需特殊验证，运行一个工作流后检查 result_json 中是否有 _provenance 字段。
```

---

## Prompt 13: 静默错误消除

```
请全局搜索并修复代码中的静默错误处理。

## 需求

搜索以下模式并逐一审查：
1. `.catch(() => {})` — 前端 TypeScript/JavaScript
2. `.catch(() => { })` — 同上
3. `except:` 后面只有 `pass` — Python
4. `except Exception:` 后面只有 `pass` 或只有 `console.error`/`logger.warning` 但没有上报

## 规则

- 影响用户操作结果的（如工作流提交、文件保存、HPC 连接）→ **必须上报错误**
- 真正的降级场景（如 WebGL 降级到 Canvas）→ **可以静默但要 log**
- 开发调试用的 → **至少 logger.debug**

## 重点文件

前端：
- src/lib/api/workflow.ts — 已修复（Bug 1），检查是否还有其他
- src/lib/api/hpc.ts — 检查连接和文件操作
- src/lib/api/project.ts — 检查项目 CRUD

后端：
- server/workflow/orchestrator.py — 检查 _run_workflow 中的 catch
- server/workflow/hpc_execute.py — 检查轮询和结果收集
- server/routers/workflow.py — 检查 API 端点
- server/routers/hpc.py — 检查 HPC 操作

## 做法

对每个找到的实例：
1. 判断分类（必须上报 / 可以静默 / 需要日志）
2. 如果是"必须上报"，改为 throw/raise 或返回错误给调用方
3. 如果是"需要日志"，至少加 logger.warning
4. 注释说明为什么可以静默（如果保留静默）

## 文件清单
- 修改: 多个文件（逐一审查）

## 验证
```bash
# 搜索剩余的静默 catch
grep -rn "\.catch(() =>" src/lib/api/ --include="*.ts" --include="*.svelte"
grep -rn "except.*:\s*$" server/ --include="*.py" -A1 | grep -B1 "pass"
```
```

---

## Prompt 14: 前端诊断面板

```
请实现一个系统状态诊断面板，显示后端连接状态、HPC 连接状态、最近错误。

## 需求

1. 后端增加错误日志收集 API
2. 前端新增 DiagnosticsPanel 组件
3. 在侧栏或设置中增加入口

## 后端

server/routers/system.py（新建）：

```python
from collections import deque
from datetime import datetime
from fastapi import APIRouter

router = APIRouter(prefix="/system", tags=["system"])

_error_log: deque[dict] = deque(maxlen=200)

def log_user_error(category: str, message: str, details: str = ""):
    _error_log.append({
        "timestamp": datetime.now().isoformat(),
        "category": category,
        "message": message,
        "details": details,
    })

@router.get("/errors")
async def get_recent_errors(limit: int = 50):
    return list(_error_log)[-limit:]

@router.get("/status")
async def get_system_status():
    from utils.connection_pool import pool
    connections = pool.list_connections()
    return {
        "backend": "connected",
        "hpc_connections": len(connections),
        "hpc_sessions": [
            {"host": c.host, "username": c.username, "uptime": c.uptime_seconds}
            for c in connections
        ],
    }
```

## 前端

```svelte
<!-- DiagnosticsPanel.svelte -->
<script lang="ts">
  import { API_BASE } from '$lib/api/config'

  let status = $state<any>(null)
  let errors = $state<any[]>([])

  async function refresh() {
    status = await fetch(`${API_BASE}/system/status`).then(r => r.json()).catch(() => null)
    errors = await fetch(`${API_BASE}/system/errors?limit=20`).then(r => r.json()).catch(() => [])
  }

  $effect(() => { refresh() })
</script>

<div class="diagnostics">
  <h3>System Status</h3>
  {#if status}
    <p>Backend: {status.backend}</p>
    <p>HPC: {status.hpc_connections} connections</p>
  {/if}

  <h3>Recent Errors</h3>
  {#each errors as err}
    <div class="error-entry">
      <span class="time">{err.timestamp}</span>
      <span class="category">[{err.category}]</span>
      <span class="message">{err.message}</span>
    </div>
  {/each}
</div>
```

## 文件清单
- 新建: server/routers/system.py
- 修改: server/main.py（注册 system router）
- 新建: src/lib/DiagnosticsPanel.svelte
- 修改: desktop/Sidebar.svelte 或 desktop/App.svelte（增加入口）
```

---

## 执行顺序总结

```
Prompt 1  → 轮询容错 + 指数退避        (hpc_poll.py, hpc_execute.py)
Prompt 2  → 孤儿 Step 检测             (engine.py, main.py)
Prompt 3  → 状态转换审计日志            (workflow_db.py)
Prompt 4  → 错误分类                   (workflow_db.py, orchestrator.py, hpc_execute.py)
Prompt 5  → 单节点重试 + 级联失效       (workflow_db.py, workflow.py, WorkflowEditor.svelte)
Prompt 6  → 参数变更检测               (orchestrator.py, node_dispatch.py)
Prompt 7  → Batch Node 后端引擎        (batch_db.py, batch_execute.py, slurm.py)
Prompt 8  → Batch Node API            (workflow.py)
Prompt 9  → Batch Node 前端           (BatchStatusPanel.svelte)
Prompt 10 → 自由能 + OER 过电位        (catalysis/)
Prompt 11 → CO2RR + NRR + Volcano     (catalysis/)
Prompt 12 → 数据溯源                   (hpc_execute.py)
Prompt 13 → 静默错误消除               (多个文件)
Prompt 14 → 诊断面板                   (system.py, DiagnosticsPanel.svelte)
```

每个 Prompt 完成后：commit → 验证 → 下一个。
