# Feature 需求：工作流精细控制

**日期:** 2026-03-17
**来源:** 与 atomate2/jobflow/FireWorks 架构对比后总结
**关联:** `reports/comparison-atomate2-jobflow-2026-03-17.md`, `reports/bug-desktop-serve-hpc-2026-03-17.md`

---

## 背景

当前 CatGo 工作流系统只支持两种粗粒度操作：
- **全量运行** — 从头执行所有节点
- **全量恢复** — 跳过已完成节点，重跑剩余的

用户需要更精细的控制：改参数后只重跑受影响的部分、从失败节点恢复、处理多结构汇聚等。

---

## Feature 1（P0）：单节点重试 — "从这里重跑"

### 用户场景

```
structure_input → geo_opt(ENCUT=400) → static → analysis
                     ↑ 失败了，用户改成 ENCUT=520
```

用户期望：右键 `geo_opt` → "从这里重跑" → 只重跑 geo_opt + static + analysis，保留 structure_input 的结果。

### 当前问题

没有单节点重试的 API。用户只能 Resume 整个工作流，但如果失败节点的 status 已经是 `completed`（参数改了但状态没变），Resume 会跳过它。

### 需要实现

#### 后端 API

```
POST /api/workflow/{workflow_id}/steps/{step_id}/retry
Response: { "reset_nodes": ["geo_opt_1", "static_1", "analysis_1"] }
```

#### 后端逻辑（workflow_db.py）

```python
def reset_step_and_descendants(workflow_id: str, step_id: str) -> list[str]:
    """重置一个节点及其所有下游依赖为 pending。"""
    with get_db() as conn:
        # 1. 从 edges 表构建邻接表
        edges = conn.execute(
            "SELECT source_id, target_id FROM workflow_edges WHERE workflow_id = ?",
            (workflow_id,)
        ).fetchall()

        adj = defaultdict(list)
        for src, tgt in edges:
            adj[src].append(tgt)

        # 2. BFS 找所有后继节点
        to_reset = set()
        queue = deque([step_id])
        while queue:
            nid = queue.popleft()
            if nid in to_reset:
                continue
            to_reset.add(nid)
            queue.extend(adj.get(nid, []))

        # 3. 批量重置
        placeholders = ",".join("?" * len(to_reset))
        conn.execute(f"""
            UPDATE workflow_steps
            SET status = 'pending', result_json = '{{}}',
                error_message = NULL, started_at = NULL, completed_at = NULL
            WHERE workflow_id = ? AND id IN ({placeholders})
        """, [workflow_id, *to_reset])
        conn.commit()

    return list(to_reset)
```

#### 路由（routers/workflow.py）

```python
@router.post("/{workflow_id}/steps/{step_id}/retry")
async def api_retry_step(workflow_id: str, step_id: str):
    """Reset a step and all downstream dependencies, then resume."""
    reset_ids = reset_step_and_descendants(workflow_id, step_id)
    return {"reset_nodes": reset_ids, "message": f"Reset {len(reset_ids)} nodes"}
```

#### 前端（WorkflowEditor.svelte）

- 节点右键菜单增加 "从这里重跑"
- 调用 API → 更新 `node_statuses` → 弹出 RunConfigDialog → Resume

### 参考

- FireWorks: `lpad rerun_fws -i <ID>`
- jobflow-remote: `jf job rerun -jid <ID>`

---

## Feature 2（P0）：参数变更检测

### 用户场景

工作流跑完了，用户改了 `geo_opt` 的 KPOINTS 从 4×4×4 到 6×6×6，点 Resume 期望只重跑 geo_opt 及其下游。

### 当前问题

`load_completed_results()` 只检查 `status`，不检查参数是否变化。改了参数后 Resume 仍然跳过已完成的节点。

### 需要实现

#### 1. 完成时保存参数指纹

在 `_execute_node()` 完成后，把参数 hash 存入 result_json：

```python
import hashlib, json

def _compute_params_hash(params: dict) -> str:
    """Compute a stable hash of node parameters."""
    serialized = json.dumps(params, sort_keys=True, default=str)
    return hashlib.md5(serialized.encode()).hexdigest()

# 在 persist_step_result 之前：
step_results[node_id]["_params_hash"] = _compute_params_hash(params)
```

#### 2. Resume 时比对

在 `_run_workflow()` 中，加载完 `already_completed` 后，检查每个已完成节点的参数是否变化：

```python
# 构建当前参数 map
node_params_map = {n["id"]: n.get("params", {}) for n in nodes}

# 检查参数变更
invalidated = set()
for node_id in list(already_completed):
    saved_hash = step_results.get(node_id, {}).get("_params_hash")
    current_hash = _compute_params_hash(node_params_map.get(node_id, {}))
    if saved_hash and saved_hash != current_hash:
        # 参数变了 → 级联失效
        descendants = get_descendants(node_id, edges)
        invalidated.update(descendants)
        invalidated.add(node_id)

# 从 already_completed 中移除需要重跑的节点
already_completed -= invalidated

# 重置 DB 中的状态
for nid in invalidated:
    update_step(workflow_id, nid, {"status": "pending", "result_json": "{}"})
```

#### 3. 前端提示

Resume 前弹窗提示："检测到以下节点的参数已修改，将重新执行：geo_opt_1, static_1"

---

## Feature 3（P1）：多结构汇聚节点

### 用户场景

优化 10 个不同的吸附位点，然后比较能量选最优：

```
ads_site_1 → geo_opt_1 ─┐
ads_site_2 → geo_opt_2 ─┼→ compare_energies → best_structure
ads_site_3 → geo_opt_3 ─┘
```

### 当前问题

`_get_parent_structure()` 只返回第一个父节点的结构。`merge` 节点也只传递第一个父节点的结果。

### 需要实现

#### 1. 新函数：获取所有父节点结果

```python
def _get_all_parent_results(
    node_id: str, edges: list[dict], step_results: dict
) -> dict[str, dict]:
    """返回所有父节点的结果，key 是父节点 ID。"""
    parent_ids = _get_parent_ids(node_id, edges)
    return {pid: step_results[pid] for pid in parent_ids if pid in step_results}
```

#### 2. 新节点类型：compare_energies

```python
# 在 local.py 或新文件中
async def execute_compare_energies(workflow_id, node_id, params, edges, step_results):
    all_parents = _get_all_parent_results(node_id, edges, step_results)

    results = []
    for pid, result in all_parents.items():
        energy = result.get("final_energy")
        structure = result.get("structure") or result.get("structure_json")
        if energy is not None:
            results.append({"parent_id": pid, "energy": energy, "structure": structure})

    # 按能量排序
    results.sort(key=lambda r: r["energy"])

    # 最优结构传递给下游
    best = results[0] if results else None
    step_results[node_id] = {
        "comparison": results,
        "best_energy": best["energy"] if best else None,
        "structure": best["structure"] if best else None,
    }
```

#### 3. 前端：compare 节点的状态面板

显示所有输入结构的能量对比表：

| Parent | Energy (eV) | Rank |
|--------|------------|------|
| geo_opt_1 | -45.23 | 1 (best) |
| geo_opt_2 | -44.91 | 2 |
| geo_opt_3 | -43.67 | 3 |

---

## Feature 4（P1）：not_converged 自动重试

### 用户场景

geo_opt 跑了 100 步（NSW=100）没有收敛，期望自动用 CONTCAR 继续跑。

### 当前问题

`not_converged` 被视为已完成，Resume 时跳过。没有自动重试机制。

### 需要实现

#### 节点参数

在 geo_opt 类型节点中增加：

```json
{
  "auto_continue_on_not_converged": true,
  "max_continuation_runs": 3,
  "nsw_multiplier": 1.0
}
```

#### 执行逻辑

在 `_execute_hpc_node()` 中，作业完成后检查收敛：

```python
# 作业完成后
output_structure = await _try_read_output_structure(hpc, work_dir, node_type)
converged = await _check_convergence(hpc, work_dir, node_type, params)

if not converged and params.get("auto_continue_on_not_converged", True):
    run_count = params.get("_continuation_count", 0)
    max_runs = params.get("max_continuation_runs", 3)

    if run_count < max_runs:
        logger.info("Not converged, continuing from CONTCAR (run %d/%d)", run_count + 1, max_runs)

        # 用 CONTCAR 替换 POSCAR
        await hpc.conn.run(f"cp {work_dir}/CONTCAR {work_dir}/POSCAR")

        # 更新参数
        params["_continuation_count"] = run_count + 1

        # 重新提交作业
        await _submit_and_poll(workflow_id, node_id, node_type, params, ...)
        return  # 递归或循环

    # 超过最大重试次数
    step_results[node_id]["status"] = "not_converged"
```

### 参考

- atomate2: `Response(detour=new_relaxation_job)` 动态插入新步骤
- Custodian: 自动修复 + 重启 VASP

---

## Feature 5（P2）：批量结构扇出（动态工作流）

### 用户场景

slab_gen 生成了 3 个不同取向的表面，每个都需要单独优化：

```
bulk → slab_gen ─→ [运行时动态生成]
                     slab_001 → geo_opt_001
                     slab_010 → geo_opt_010
                     slab_111 → geo_opt_111
```

### 当前问题

DAG 是静态的，不支持运行时生成新节点。

### 需要实现

这是最复杂的 feature，涉及：
1. 执行引擎支持动态修改 DAG
2. DB schema 支持动态创建的 step
3. 前端编辑器能显示运行时生成的节点
4. WebSocket 广播新节点的创建事件

### 短期替代方案

用户手动在编辑器中创建多个 geo_opt 节点，每个连接不同的 structure_input。虽然繁琐但可行。

### 参考

- jobflow: `Response(replace=Flow([job1, job2, job3]))`
- FireWorks: `FWAction(additions=[fw1, fw2, fw3])`

---

## 实现路线图

```
Phase 1（近期 — 1-2 周）:
  ├── Feature 1: 单节点重试 + 级联失效
  │     ├── 后端: reset_step_and_descendants() + API endpoint
  │     ├── 前端: 右键菜单 "从这里重跑"
  │     └── 测试: 失败节点改参数后重跑，验证下游级联
  │
  ├── Feature 2: 参数变更检测
  │     ├── 后端: _compute_params_hash() + resume 时比对
  │     ├── 前端: Resume 前提示参数变更
  │     └── 测试: 改参数后 Resume，验证只重跑变化部分
  │
  └── Bug 修复（来自 bug report）:
        ├── 孤儿作业检测（recover_workflows 查询 sacct）
        ├── 区分 remote_error vs failed
        └── HPC 连接状态准确性

Phase 2（中期 — 2-4 周）:
  ├── Feature 3: 多结构汇聚节点
  │     ├── _get_all_parent_results()
  │     ├── compare_energies 节点类型
  │     └── 前端: 能量对比表
  │
  └── Feature 4: not_converged 自动重试
        ├── CONTCAR → POSCAR 自动续跑
        ├── max_continuation_runs 参数
        └── 前端: 显示续跑次数和收敛进度

Phase 3（远期 — 1-2 月）:
  └── Feature 5: 批量结构扇出
        ├── 运行时动态创建节点
        ├── DB schema 扩展
        └── 前端: 动态节点显示
```

---

## 与现有架构的兼容性

| Feature | 需要修改的文件 | 破坏性变更? |
|---------|-------------|-----------|
| 单节点重试 | `workflow_db.py`, `routers/workflow.py`, `WorkflowEditor.svelte` | 否，新增 API |
| 参数变更检测 | `python_engine.py`, `resume.py` | 否，向后兼容（旧数据无 `_params_hash` 则跳过检测） |
| 多结构汇聚 | `python_engine.py`, `local.py`, 新节点类型 | 否，新增功能 |
| 自动续跑 | `python_engine.py` | 否，默认关闭 |
| 批量扇出 | `python_engine.py`, `workflow_db.py`, `WorkflowEditor.svelte` | 可能需要 DB schema 变更 |
