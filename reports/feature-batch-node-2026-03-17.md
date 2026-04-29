# Feature 需求：Batch Node — 单节点管理万级子任务

**日期:** 2026-03-17
**关联:** `reports/high-throughput-catalysis-gap-analysis-2026-03-17.md`

---

## 设计核心

**不是 10,000 个 DAG 节点，而是 1 个 Batch Node 内部管理 10,000 个 SLURM 子任务。**

```
前端 DAG（保持简洁）:

  bulk → slab_gen → batch_doping → batch_geo_opt → activity_analysis
                                       │
                                 内部: SLURM array job
                                 --array=0-9999%50
```

---

## 技术框架要求

### 现有框架可以复用的部分

| 组件 | 现状 | 能否复用 |
|------|------|---------|
| DAG 编辑器 | SVG 节点 + 边 | ✅ Batch node 就是一个普通节点，只是内部行为不同 |
| WebSocket 广播 | `_broadcast()` + asyncio Queue | ✅ 新增 `batch_progress` 消息类型即可 |
| SSH/HPC 连接 | asyncssh + HPCConnection | ✅ `sbatch --array` 和普通 `sbatch` 用同一个连接 |
| SQLite 数据库 | workflow_steps 表 | ⚠️ 需要扩展（见下方） |
| 前端状态推送 | WorkflowEditor + NodeStatusPanel | ⚠️ 需要新增 BatchStatusPanel |
| Custodian | 生成 run_custodian.py 脚本 | ✅ 每个子任务独立运行 custodian |

### 需要新增的技术组件

#### 1. 数据库：子任务表（SQLite 新表）

现有 `workflow_steps` 表存储的是 DAG 节点级别。Batch node 需要一个子任务表：

```sql
CREATE TABLE batch_subtasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    step_id TEXT NOT NULL,          -- 对应的 batch node ID
    workflow_id TEXT NOT NULL,
    subtask_index INTEGER NOT NULL, -- 0, 1, 2, ... N-1
    slurm_array_id TEXT,            -- "12345_0", "12345_1", ...
    status TEXT DEFAULT 'pending',  -- pending/submitted/running/completed/failed
    work_dir TEXT,                  -- HPC 上的子目录
    energy REAL,                    -- 提取的能量（快速排序用）
    result_json TEXT DEFAULT '{}',  -- 详细结果
    error_message TEXT,
    started_at TEXT,
    completed_at TEXT,
    input_hash TEXT,                -- 输入结构 hash（去重/重试判断）

    UNIQUE(step_id, subtask_index)
);

CREATE INDEX idx_batch_step ON batch_subtasks(step_id, status);
CREATE INDEX idx_batch_energy ON batch_subtasks(step_id, energy);
```

**为什么不用现有的 workflow_steps？**
- workflow_steps 是 DAG 节点级别，和前端编辑器一一对应
- batch_subtasks 是内部管理表，前端不需要把每个子任务画成节点
- 10,000 行子任务 + 高频状态更新，需要独立索引

**SQLite 能承受 10,000-100,000 行吗？** 可以。
- SQLite 单表百万行读写性能无问题
- WAL 模式下读写并发没问题
- 批量 UPDATE（`sacct` 返回后一次更新几百行）用事务包裹即可

**百万行呢？** 也可以，但需要注意：
- 必须有索引（已加）
- 批量插入用 `executemany` 而非循环 `execute`
- 前端绝不全量加载，只用分页 API

#### 2. 后端：Batch 执行引擎

新文件 `server/workflow/engines/batch.py`：

```python
"""Batch HPC execution engine — single SLURM array job for N structures."""

import asyncio
import json
import time
from typing import Any

from utils.workflow_db import update_step
from workflow.engine import _broadcast


# SLURM array job 状态映射
COMPLETED_STATES = {"COMPLETED", "CD"}
FAILED_STATES = {"FAILED", "F", "NODE_FAIL", "NF", "TIMEOUT", "TO",
                 "CANCELLED", "CA", "OOM", "OUT_OF_MEMORY"}
RUNNING_STATES = {"RUNNING", "R", "COMPLETING", "CG"}


async def execute_batch_hpc(
    workflow_id: str,
    node_id: str,
    node_type: str,
    structures: list[dict],     # 从上游节点传来的结构列表
    params: dict[str, Any],
    config: "WorkflowRunConfig",
    hpc: "HPCConnection",
):
    """Execute N structures as a single SLURM array job."""

    max_concurrent = params.get("max_concurrent", 50)
    batch_dir = f"{config.work_dir_base}/batch_{node_id}"
    n = len(structures)

    # ── Phase 1: 上传所有输入 ──
    await _broadcast(workflow_id, {
        "type": "batch_progress",
        "step_id": node_id,
        "phase": "uploading",
        "total": n,
        "completed": 0,
    })

    await hpc.conn.run(f"mkdir -p {batch_dir}")

    # 批量上传（并发但限流）
    sem = asyncio.Semaphore(20)  # 最多 20 个并发 SSH 写入

    async def upload_one(i, struct):
        async with sem:
            sub_dir = f"{batch_dir}/{i:06d}"
            await hpc.conn.run(f"mkdir -p {sub_dir}")
            await write_vasp_inputs(hpc, sub_dir, struct, params)
            # 写入 DB
            insert_subtask(workflow_id, node_id, i, sub_dir)

    await asyncio.gather(*[upload_one(i, s) for i, s in enumerate(structures)])

    # ── Phase 2: 提交 SLURM array job ──
    script = _render_array_job_script(batch_dir, params, n, max_concurrent)
    job_id = await hpc.scheduler.submit_job(hpc.conn, script_content=script,
                                             job_name=f"catgo_batch_{node_id[:8]}",
                                             work_dir=batch_dir)

    update_subtasks_slurm_id(workflow_id, node_id, job_id)

    await _broadcast(workflow_id, {
        "type": "batch_progress",
        "step_id": node_id,
        "phase": "submitted",
        "total": n,
        "slurm_job_id": job_id,
    })

    # ── Phase 3: 轮询 sacct 获取所有子任务状态 ──
    poll_interval = params.get("poll_interval", 30)
    max_wait = 7 * 24 * 3600

    start_time = time.time()
    while time.time() - start_time < max_wait:
        await asyncio.sleep(poll_interval)

        # sacct 一次查询所有子任务
        statuses = await get_array_job_statuses(hpc, job_id, n)

        completed = sum(1 for s in statuses.values() if s in COMPLETED_STATES)
        failed = sum(1 for s in statuses.values() if s in FAILED_STATES)
        running = sum(1 for s in statuses.values() if s in RUNNING_STATES)
        pending = n - completed - failed - running

        # 批量更新 DB
        update_subtask_statuses(workflow_id, node_id, statuses)

        # 广播进度
        await _broadcast(workflow_id, {
            "type": "batch_progress",
            "step_id": node_id,
            "phase": "running",
            "total": n,
            "completed": completed,
            "failed": failed,
            "running": running,
            "pending": pending,
        })

        if completed + failed >= n:
            break

    # ── Phase 4: 收集结果 ──
    await _broadcast(workflow_id, {
        "type": "batch_progress",
        "step_id": node_id,
        "phase": "collecting",
        "total": n,
    })

    # 批量读取能量（并发限流）
    async def collect_one(i):
        async with sem:
            sub_dir = f"{batch_dir}/{i:06d}"
            result = await try_read_vasp_output(hpc, sub_dir)
            if result:
                update_subtask_result(workflow_id, node_id, i,
                                      status="completed", energy=result.get("energy"),
                                      result_json=json.dumps(result))
            return result

    results = await asyncio.gather(*[collect_one(i) for i in range(n)])

    # 汇总
    summary = compute_batch_summary(results)
    return {"batch_size": n, "summary": summary, "job_id": job_id}


def _render_array_job_script(batch_dir, params, n, max_concurrent):
    """生成 SLURM array job 脚本。"""
    return f"""#!/bin/bash
#SBATCH --array=0-{n-1}%{max_concurrent}
#SBATCH --job-name=catgo_batch
#SBATCH --ntasks={params.get('ntasks', 1)}
#SBATCH --cpus-per-task={params.get('cpus_per_task', 1)}
#SBATCH --time={params.get('walltime', '24:00:00')}
#SBATCH --partition={params.get('partition', 'workq')}

cd {batch_dir}/$(printf "%06d" $SLURM_ARRAY_TASK_ID)
{params.get('vasp_command', 'vasp_std')}
"""
```

#### 3. 后端：子任务查询 API（服务端分页 + 聚合）

```python
# routers/workflow.py 新增

@router.get("/{workflow_id}/steps/{step_id}/batch-summary")
async def api_batch_summary(workflow_id: str, step_id: str):
    """批量任务的汇总统计（不加载全部数据）。"""
    with get_db() as conn:
        row = conn.execute("""
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
                SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running,
                MIN(energy) as min_energy,
                MAX(energy) as max_energy,
                AVG(energy) as avg_energy
            FROM batch_subtasks
            WHERE workflow_id = ? AND step_id = ?
        """, (workflow_id, step_id)).fetchone()
    return dict(row)


@router.get("/{workflow_id}/steps/{step_id}/batch-results")
async def api_batch_results(
    workflow_id: str, step_id: str,
    page: int = 1, per_page: int = 50,
    sort: str = "energy", order: str = "asc",
    status: str | None = None,
):
    """分页查询子任务结果。"""
    with get_db() as conn:
        where = "workflow_id = ? AND step_id = ?"
        args = [workflow_id, step_id]
        if status:
            where += " AND status = ?"
            args.append(status)

        total = conn.execute(f"SELECT COUNT(*) FROM batch_subtasks WHERE {where}", args).fetchone()[0]

        safe_sort = sort if sort in ("energy", "subtask_index", "status", "completed_at") else "subtask_index"
        safe_order = "DESC" if order == "desc" else "ASC"
        offset = (page - 1) * per_page

        rows = conn.execute(f"""
            SELECT subtask_index, status, energy, error_message, work_dir, completed_at
            FROM batch_subtasks WHERE {where}
            ORDER BY {safe_sort} {safe_order}
            LIMIT ? OFFSET ?
        """, [*args, per_page, offset]).fetchall()

    return {"total": total, "page": page, "per_page": per_page, "results": [dict(r) for r in rows]}


@router.get("/{workflow_id}/steps/{step_id}/batch-histogram")
async def api_batch_histogram(workflow_id: str, step_id: str, bins: int = 30):
    """能量分布直方图（服务端计算）。"""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT energy FROM batch_subtasks
            WHERE workflow_id = ? AND step_id = ? AND energy IS NOT NULL
        """, (workflow_id, step_id)).fetchall()

    energies = [r[0] for r in rows]
    if not energies:
        return {"bins": [], "counts": []}

    import numpy as np
    counts, bin_edges = np.histogram(energies, bins=bins)
    return {
        "bins": [(bin_edges[i] + bin_edges[i+1]) / 2 for i in range(len(counts))],
        "counts": counts.tolist(),
    }


@router.post("/{workflow_id}/steps/{step_id}/batch-retry")
async def api_batch_retry(workflow_id: str, step_id: str, indices: list[int] | None = None):
    """重新提交失败的子任务。"""
    with get_db() as conn:
        if indices is None:
            # 重试所有失败的
            rows = conn.execute("""
                SELECT subtask_index FROM batch_subtasks
                WHERE workflow_id = ? AND step_id = ? AND status = 'failed'
            """, (workflow_id, step_id)).fetchall()
            indices = [r[0] for r in rows]

        if not indices:
            return {"retried": 0}

        # 重置状态
        placeholders = ",".join("?" * len(indices))
        conn.execute(f"""
            UPDATE batch_subtasks
            SET status = 'pending', error_message = NULL, energy = NULL,
                result_json = '{{}}', started_at = NULL, completed_at = NULL
            WHERE workflow_id = ? AND step_id = ? AND subtask_index IN ({placeholders})
        """, [workflow_id, step_id, *indices])
        conn.commit()

    # 重新提交 SLURM array job（只包含失败的 index）
    array_spec = ",".join(str(i) for i in sorted(indices))
    # sbatch --array=47,203,891 script.sh
    hpc = get_hpc_connection(workflow_id, step_id)
    await hpc.scheduler.submit_job(hpc.conn,
        script_content=...,  # 复用原脚本
        extra_args=f"--array={array_spec}",
    )

    return {"retried": len(indices), "indices": indices}
```

#### 4. 前端：BatchStatusPanel 组件

新文件 `src/lib/workflow/BatchStatusPanel.svelte`：

```
需要的前端依赖（全部已有）:
- Svelte 5 runes ($state, $derived, $effect)
- 现有的 fetch/API 层
- 图表: 可用现有的 <Plot> 或新增轻量 histogram 组件
- 虚拟滚动: 不需要，服务端分页即可
```

关键状态：
```typescript
let summary = $state<BatchSummary | null>(null)
let results_page = $state<BatchResultPage | null>(null)
let histogram = $state<HistogramData | null>(null)
let active_tab = $state<'overview' | 'table' | 'failed'>('overview')

// 轮询：batch 运行中时每 5 秒刷新 summary
$effect(() => {
  if (status !== 'running') return
  const timer = setInterval(async () => {
    summary = await api.getBatchSummary(workflow_id, step_id)
  }, 5000)
  return () => clearInterval(timer)
})
```

---

## 出错了怎么修复

### 错误分类与修复路径

#### 类型 1: 部分子任务失败（最常见）

**原因：** 节点崩溃（NODE_FAIL）、内存不足（OOM）、VASP 算法不收敛

**检测：** `sacct -j <array_job_id>` 返回每个子任务的状态

**修复：**
```
前端: BatchStatusPanel "Failed" tab → "Retry All Failed" 按钮
  ↓
后端: POST /batch-retry → sbatch --array=47,203,891 script.sh
  ↓
只重提交失败的子任务，已完成的不受影响
```

**关键：** 失败子任务的 work_dir 保留在 HPC 上。用户可以通过文件浏览器检查错误日志，修改参数后重试。

#### 类型 2: SLURM array job 整体失败

**原因：** 脚本错误（所有子任务都失败）、partition 不存在、账户欠费

**检测：** `sacct` 返回所有子任务都是 FAILED

**修复：**
1. 前端显示错误摘要："所有子任务失败，共同错误：SBATCH: error: invalid partition"
2. 用户修改节点参数（如 partition）
3. 右键 → "从这里重跑" → 全部重新提交

#### 类型 3: SSH 连接断开（轮询中断）

**原因：** 网络不稳定、SSH session 超时

**检测：** `get_array_job_statuses()` 抛 SSH 异常

**修复方案 — 三层防护：**

```python
# 第 1 层：SSH 重连重试（已有）
# hpc_client.py 的 _run() 有 timeout + 重试

# 第 2 层：轮询循环容错
while time.time() - start_time < max_wait:
    try:
        statuses = await get_array_job_statuses(hpc, job_id, n)
    except Exception as e:
        logger.warning("Batch poll failed (SSH?): %s, retrying in 60s", e)
        await asyncio.sleep(60)
        # 尝试重新获取 HPC 连接
        hpc = pool.get_connection(session_id)
        if not hpc:
            logger.warning("HPC session lost, waiting for reconnect...")
            continue
        continue  # 不崩溃，继续轮询
    # ... 正常处理

# 第 3 层：Backend 重启恢复
# recover_workflows() 中检测 batch node
# 从 batch_subtasks 表恢复状态
# 用 sacct 查询实际状态并同步
```

#### 类型 4: Backend 进程重启（轮询 task 丢失）

**原因：** 代码热重载、手动重启、crash

**检测：** DB 中 batch node status = "running"，但没有活跃的 asyncio task

**修复方案：**

```python
# recover_workflows() 中新增 batch 恢复逻辑
async def recover_batch_nodes(workflow_id: str):
    """恢复中断的 batch 轮询。"""
    with get_db() as conn:
        # 找到所有 running 的 batch step
        batch_steps = conn.execute("""
            SELECT DISTINCT step_id, slurm_array_id
            FROM batch_subtasks
            WHERE workflow_id = ? AND status IN ('submitted', 'running')
        """, (workflow_id,)).fetchall()

    for step_id, array_job_id in batch_steps:
        if not array_job_id:
            continue
        # 用 sacct 查真实状态
        hpc = find_hpc_connection_for_step(workflow_id, step_id)
        if hpc:
            statuses = await get_array_job_statuses(hpc, array_job_id, ...)
            update_subtask_statuses(workflow_id, step_id, statuses)
            # 如果还有 running 的子任务，启动 watcher
            if any(s in RUNNING_STATES for s in statuses.values()):
                spawn_batch_watcher(workflow_id, step_id, array_job_id)
```

#### 类型 5: 子任务输出文件损坏

**原因：** 节点崩溃时 VASP 正在写文件

**检测：** 结果收集阶段 `try_read_vasp_output()` 返回 None 或解析错误

**修复：**
```python
async def collect_one(i):
    try:
        result = await try_read_vasp_output(hpc, sub_dir)
        if result:
            update_subtask_result(... status="completed", ...)
        else:
            update_subtask_result(... status="failed",
                error_message="Output files missing or incomplete")
    except Exception as e:
        update_subtask_result(... status="failed",
            error_message=f"Result parsing error: {e}")
```

用户看到 "Output files missing" → 点 Retry → 重新计算

#### 类型 6: 磁盘空间不足（HPC 上）

**原因：** 10,000 个 VASP 计算可能占 TB 级空间

**预防：**
```python
# 提交前检查磁盘空间
result = await hpc.conn.run(f"df -h {batch_dir} | tail -1")
available_gb = parse_disk_space(result.stdout)
estimated_gb = n * params.get("estimated_size_gb", 0.5)  # 每个 ~500MB
if available_gb < estimated_gb * 1.2:
    raise RuntimeError(
        f"Insufficient disk space: {available_gb:.0f} GB available, "
        f"~{estimated_gb:.0f} GB needed for {n} calculations"
    )
```

**自动清理（可选）：**
- 子任务完成后，只保留 CONTCAR + OUTCAR + vasprun.xml
- 删除 WAVECAR、CHGCAR 等大文件（参数可控）

---

## 错误修复流程图

```
子任务失败
  │
  ├─ 部分失败（常见）
  │    └→ 前端 "Failed" tab → "Retry Failed" → sbatch --array=失败的indices
  │
  ├─ 全部失败（脚本错误）
  │    └→ 检查错误 → 改参数 → "从这里重跑"
  │
  ├─ SSH 断开
  │    └→ 轮询自动重试 → 重连后继续 → 用 sacct 同步状态
  │
  ├─ Backend 重启
  │    └→ recover_batch_nodes() → sacct 查真实状态 → 启动 watcher
  │
  ├─ 输出损坏
  │    └→ 标记为 failed → 用户 Retry
  │
  └─ 磁盘满
       └→ 提交前预检查 → 完成后自动清理大文件
```

---

## 对现有技术栈的影响

| 组件 | 影响 | 工作量 |
|------|------|--------|
| **SQLite** | 新增 `batch_subtasks` 表，无 schema 破坏 | 低 |
| **python_engine.py** | 新增 batch 执行路径，不修改已有逻辑 | 中 |
| **routers/workflow.py** | 新增 4 个 API endpoint | 中 |
| **WorkflowEditor.svelte** | 识别 batch node 类型，渲染 BatchStatusPanel | 中 |
| **BatchStatusPanel.svelte** | 全新组件 | 中 |
| **node-definitions.ts** | 新增 batch_geo_opt 等节点定义 | 低 |
| **WebSocket 协议** | 新增 `batch_progress` 消息类型 | 低 |
| **MongoDB** | ❌ 不需要 | — |
| **Celery/Redis** | ❌ 不需要 | — |
| **新的前端库** | ❌ 不需要 | — |

**结论：不需要新的技术框架。** 现有的 SQLite + asyncio + Svelte + SLURM 完全足够。核心工作是：
1. 新增一个 DB 表
2. 新增一个执行引擎模块
3. 新增几个 API
4. 新增一个前端组件

---

## 实现优先级

```
Week 1:
  ├── batch_subtasks 表 + DB 函数
  ├── SLURM array job 提交 + 轮询
  └── batch-summary / batch-results API

Week 2:
  ├── BatchStatusPanel 前端组件（进度环 + 表格 + 直方图）
  ├── batch-retry API + 前端按钮
  └── SSH 断开容错 + backend 重启恢复

Week 3:
  ├── 批量吸附物放置（结合 batch node）
  ├── 磁盘空间预检查 + 自动清理
  └── 集成测试（100 个结构端到端）
```
