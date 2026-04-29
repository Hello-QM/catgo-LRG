# CatGo vs atomate2/jobflow/FireWorks: 架构对比与借鉴

**日期:** 2026-03-17

---

## 架构层次对比

| 层 | atomate2 生态 | CatGo |
|---|---|---|
| **工作流定义** | jobflow (`Job`, `Flow`, `Response`, `Maker`) | 前端 SVG DAG 编辑器 + JSON graph |
| **执行引擎** | jobflow-remote (daemon) 或 FireWorks (MongoDB) | Python shim (`python_engine.py`) 或 Rust engine |
| **状态持久化** | MongoDB (原子锁 + 文档级事务) | SQLite (`catgo_results.db`) |
| **HPC 交互** | SSH + qtoolkit (SLURM/PBS 抽象) | SSH + asyncssh + 自实现 SLURM/PBS |
| **错误修正** | Custodian (进程内监控 + 自动修复) | Custodian (通过生成脚本集成) |
| **结果存储** | MongoDB + GridFS/S3 (大对象分离) | SQLite `result_json` 字段 |

---

## CatGo 的优势

### 1. 可视化 DAG 编辑器
atomate2/jobflow 是纯代码定义工作流，用户需要写 Python。CatGo 提供图形化拖拽编辑器，门槛低很多。

### 2. 实时 WebSocket 状态推送
atomate2 依赖用户主动查询（`jf job list`）。CatGo 通过 WebSocket 实时推送状态变化到前端，用户体验更好。

### 3. 集成式 UI
结构查看器、终端、文件浏览器、工作流编辑器在同一个 App 里。atomate2 的各组件是分散的。

### 4. 轻量部署
不需要 MongoDB，只需要一个 SQLite 文件。atomate2 需要 MongoDB + 配置 worker + 配置 daemon。

---

## CatGo 的不足与可借鉴之处

### 1. 状态持久化不可靠（严重）

**atomate2/jobflow-remote 的做法：**
- MongoDB 文档级原子锁（`find_one_and_update`）
- 每个状态转换都是原子操作，不可能出现中间状态
- 16 个精细状态：WAITING → READY → CHECKED_OUT → UPLOADED → SUBMITTED → RUNNING → RUN_FINISHED → DOWNLOADED → COMPLETED

**FireWorks 的做法：**
- 每个状态转换记录到 `state_history` 数组（含时间戳），形成完整审计日志
- 乐观锁 + workflow 级锁防止并发修改

**CatGo 的问题：**
- SQLite 写入依赖 `_write_lock`（Python 线程锁），backend 崩溃时锁和内存状态一起丢失
- `desktop:serve` 模式下 WASM SQLite 有 1 秒延迟写盘，同步到 backend 时可能丢数据
- 没有状态转换审计日志

**建议：**
- 每次状态转换记录时间戳和来源（如 `state_history` 数组）
- 确保所有状态写入是原子的（SQLite WAL 模式 + 事务）
- 考虑在 step 表增加 `state_history` JSON 字段

---

### 2. 孤儿作业检测（严重）

**FireWorks 的做法：**
- 心跳机制：运行中的 Rocket 每小时 ping 一次 LaunchPad（更新 `state_history.updated_on`）
- `detect_lostruns`：查找超过 4 小时没有心跳的 RUNNING 作业，标记为 FIZZLED
- 虽然不是自动的（需要 cron），但机制完善

**jobflow-remote 的做法：**
- Runner daemon 每 30 秒轮询 scheduler queue
- 作业从队列消失 → 自动检测为 RUN_FINISHED
- Runner 自身通过 supervisord 管理，死了会重启

**CatGo 的问题：**
- Backend 重启后调用 `recover_workflows()` 把所有 running 工作流标记为 paused
- 但**不检查 HPC 上作业的实际状态** — 不知道作业是完成了还是失败了
- 没有心跳机制
- 没有定期扫描孤儿 running step 的逻辑

**建议：**
- `recover_workflows()` 中：对每个 running/queued step，尝试用保存的 `hpc_job_id` + `hpc_session_id` 查询 `sacct` 获取真实状态
- 增加后台定时任务（如每 5 分钟），扫描所有 status="running" 但没有活跃 asyncio task 的 step，启动 watcher
- 在 step 表记录 `last_polled_at` 时间戳，检测超时

---

### 3. 动态工作流（重要）

**jobflow 的 Response 机制：**

```python
@job
def relax(structure):
    result = run_vasp(structure)
    if not result.converged:
        # 运行时动态插入新步骤
        new_job = relax(result.structure)
        return Response(detour=new_job)
    return result
```

支持三种运行时图变更：
- `replace`：用子工作流替换当前节点（UUID 不变，下游引用自动解析）
- `detour`：在当前节点和下游之间插入新步骤
- `addition`：在工作流末尾追加步骤

**CatGo 的问题：**
- DAG 在编辑器中定义后是静态的
- 不支持运行时根据计算结果动态修改图
- 例如：收敛检查失败后自动重跑、根据能量差异决定是否需要额外计算

**建议：**
- 考虑在 `_execute_node` 返回值中支持 `detour`/`addition` 语义
- 至少支持"条件重试"：如果 VASP 没有收敛，自动用更保守的参数重新提交
- 可以在节点参数中增加 `max_retries` 和 `retry_strategy`

---

### 4. 工作流定义与执行解耦（重要）

**jobflow 的架构：**
- `Job` 和 `Flow` 是纯数据对象，不知道自己在哪里运行
- 同一个 Flow 可以 `run_locally()`、提交到 FireWorks、或用 jobflow-remote 执行
- `job.run(store)` — 执行逻辑和存储后端通过参数注入

**CatGo 的问题：**
- 工作流定义（前端 JSON graph）和执行逻辑（`python_engine.py`）紧密耦合
- 切换执行后端（如从 Python 到 Rust）需要重写执行逻辑
- 没有 `OutputReference` 类似的延迟引用机制，节点间数据传递通过 `step_results` dict

**建议：**
- 引入类似 `OutputReference` 的机制，让节点间依赖显式化
- 目前的 `step_results[parent_id]["structure"]` 模式足够简单，暂时不需要过度抽象

---

### 5. 作业失败后的精细处理（重要）

**atomate2 的 Custodian 集成：**
- 11 个默认 VASP 错误处理器，覆盖常见失败模式
- `should_stop_children()` 根据任务结果决定是否停止下游节点
- `VASP_HANDLE_UNSUCCESSFUL` 设置控制失败行为（报错/继续/标记）

**jobflow-remote 的重试机制：**
- `max_step_attempts = 3`，指数退避 (30s, 300s, 1200s)
- `RemoteError(no_retry=True)` 区分可重试和不可重试错误
- 16 个精细状态区分"远程基础设施错误"(`REMOTE_ERROR`) 和"计算逻辑错误"(`FAILED`)

**CatGo 的问题：**
- 只有 6 个状态（pending, running, completed, failed, skipped, not_converged）
- 不区分"SSH 断了"和"VASP 算错了"
- 没有自动重试机制
- 作业从 squeue 消失时只检查 OUTCAR 是否存在，不验证内容（可能误判）

**建议：**
- 区分 `failed`（计算逻辑错误）和 `remote_error`（基础设施错误，如 SSH 断开）
- 对 `remote_error` 类型的失败自动重试（最多 3 次，指数退避）
- 作业从队列消失时，优先查 `sacct` 获取退出状态，而不是只检查 OUTCAR

---

### 6. Maker/模板模式（中等）

**atomate2 的 Maker 模式：**

```python
@dataclass
class RelaxMaker(Maker):
    name: str = "relax"
    force_field: str = "PBE"

    @job
    def make(self, structure):
        return run_relaxation(structure, self.force_field)

# 使用：
maker = RelaxMaker(force_field="PBEsol")
flow = maker.make(my_structure)
```

- Dataclass 序列化清晰
- `update_kwargs()` 创建修改后的副本
- Powerups 可以在提交前修改任何 Maker 的参数

**CatGo 的对应：**
- 节点参数通过 JSON `params` 存储
- 模板系统存在（`workflow templates`）
- 但没有 Maker 的嵌套组合能力

**评估：** CatGo 的可视化编辑器在很大程度上替代了 Maker 模式的需求。用户通过拖拽和参数面板配置工作流，不需要写代码。这是不同的设计哲学，各有优势。

---

### 7. 数据传递机制（中等）

**jobflow 的 OutputReference：**

```python
job1 = relax(structure)
job2 = static(job1.output.structure)  # 隐式依赖
# job2 自动等待 job1 完成，从 store 中获取 job1 的输出结构
```

- 延迟引用，执行时才解析
- 引用关系自动构建 DAG 边
- 支持嵌套属性访问 `job.output["key"].nested`

**CatGo 的做法：**
- 边在编辑器中手动连接
- 数据通过 `step_results[parent_id]` 传递
- 没有类型安全或引用解析

**建议：**
- 当前方案对于 GUI 编辑器足够
- 如果未来支持代码定义工作流（API），可以考虑引入 OutputReference

---

## 优先级排序

| 优先级 | 改进项 | 难度 | 影响 |
|---|---|---|---|
| P0 | 孤儿作业检测 + recover_workflows 改进 | 中 | 解决"状态卡在 running"的根本原因 |
| P0 | 区分 remote_error vs failed + 自动重试 | 中 | 大幅提升 HPC 作业可靠性 |
| P1 | sacct 二次验证（作业从 squeue 消失时） | 低 | 防止误判完成/无限轮询 |
| P1 | 状态转换审计日志 | 低 | 方便调试，追踪状态变化历史 |
| P2 | 动态工作流（条件重试/detour） | 高 | 支持自适应计算 |
| P2 | 后台定时扫描孤儿 step | 中 | 自动修复而非依赖用户干预 |
| P3 | OutputReference 式数据传递 | 高 | 仅在支持代码定义工作流时需要 |

---

---

## Feature 需求：工作流精细控制

### Feature 1（P0）：单节点重试 — "从这里重跑"

**用户场景：**
```
structure_input → geo_opt(ENCUT=400) → static → analysis
                     ↑ 失败了，用户改成 ENCUT=520
```

用户期望：右键 `geo_opt` → "从这里重跑" → 只重跑 geo_opt + static + analysis，保留 structure_input 的结果。

**需要实现：**

1. **后端 API：** `POST /workflow/{id}/steps/{step_id}/retry`
   - 把该节点的 status 重置为 `pending`，清除 `result_json`、`error_message`
   - **级联失效**：自动重置所有下游节点（通过 edges 遍历所有后继）为 `pending`
   - 不触碰上游已完成的节点
   - 返回被重置的节点 ID 列表

2. **后端实现（workflow_db.py）：**
   ```python
   def reset_step_and_descendants(workflow_id: str, step_id: str) -> list[str]:
       """Reset a step and all its downstream dependencies to pending."""
       # 从 edges 表构建邻接表
       # BFS/DFS 从 step_id 出发找所有后继
       # UPDATE workflow_steps SET status='pending', result_json='{}',
       #   error_message=NULL, started_at=NULL, completed_at=NULL
       #   WHERE id IN (step_id, ...descendants)
       # 返回被重置的 ID 列表
   ```

3. **前端 UI（WorkflowEditor.svelte）：**
   - 节点右键菜单增加 "从这里重跑"
   - 调用 API 后刷新 `node_statuses`
   - 然后自动调用 `resume`

**参考：** FireWorks 的 `lpad rerun_fws -i <ID>` + `--task-level` 选项

---

### Feature 2（P0）：参数变更检测

**用户场景：** 工作流跑完了，用户改了中间某个节点的参数（如 KPOINTS 网格），点 Resume 期望只重跑变化的部分。

**当前问题：** Resume 只检查 `status`，不检查参数是否变化。改了参数后 resume 仍然跳过已完成的节点。

**需要实现：**

1. **持久化参数快照：** 节点完成时，把当前参数的 hash 保存到 `result_json` 中
   ```python
   step_results[node_id]["_params_hash"] = hashlib.md5(
       json.dumps(params, sort_keys=True).encode()
   ).hexdigest()
   ```

2. **Resume 时比对：** `load_completed_results()` 中比较 `_params_hash` 和当前 `graph_json` 里的参数
   ```python
   current_hash = compute_params_hash(graph_node_params)
   saved_hash = result.get("_params_hash")
   if current_hash != saved_hash:
       # 参数变了 → 不跳过，标记为需要重跑
       invalidated_nodes.add(step_id)
   ```

3. **级联失效：** 参数变化的节点 + 所有下游节点都标记为需要重跑

---

### Feature 3（P1）：多结构汇聚节点

**用户场景：** 优化 10 个不同的吸附位点，然后比较能量选最优。

```
structure_1 → geo_opt_1 ─┐
structure_2 → geo_opt_2 ─┼→ compare_energies → best_structure
structure_3 → geo_opt_3 ─┘
```

**当前问题：** `_get_parent_structure()` 只返回第一个父节点的结构，`merge` 节点也只传递第一个父节点的结果。

**需要实现：**

1. **`_get_all_parent_results()`：** 返回所有父节点的结果 dict
   ```python
   def _get_all_parent_results(node_id, edges, step_results):
       parent_ids = _get_parent_ids(node_id, edges)
       return {pid: step_results[pid] for pid in parent_ids if pid in step_results}
   ```

2. **Analysis 节点支持多输入：** 比较能量、选最优结构等
3. **前端显示：** compare 节点的状态面板显示所有输入结构的能量对比表

---

### Feature 4（P1）：not_converged 自动重试

**用户场景：** geo_opt 跑了 100 步没有收敛，期望自动增加 NSW 重跑。

**当前问题：** `not_converged` 被视为完成（`status in ("completed", "not_converged")`），resume 时跳过。

**需要实现：**

1. **节点参数增加 `auto_retry_on_not_converged`**（默认 true）
2. **重试策略：**
   - 读取上一次的 CONTCAR 作为新的输入结构
   - NSW 翻倍（或用户配置的倍数）
   - 最多重试 N 次（默认 3）
3. **实现位置：** `_execute_hpc_node()` 完成后检查收敛状态
   ```python
   if not converged and params.get("auto_retry_on_not_converged", True):
       retry_count = step_results[node_id].get("_retry_count", 0)
       if retry_count < max_retries:
           # 用 CONTCAR 替换 POSCAR，增加 NSW
           step_results[node_id]["_retry_count"] = retry_count + 1
           # 重新提交
   ```

**参考：** atomate2 的 `Response(detour=new_relaxation_job)` 模式

---

### Feature 5（P2）：批量结构扇出

**用户场景：** 一个 slab_gen 节点生成了多个表面取向（001, 010, 111），每个都需要单独优化。

```
bulk_structure → slab_gen ─→ [动态生成 N 个 geo_opt 节点]
                               geo_opt_001
                               geo_opt_010
                               geo_opt_111
```

**当前问题：** DAG 是静态的，不能运行时生成新节点。

**需要实现：**

1. **节点返回值支持 `fan_out` 语义：**
   ```python
   step_results[node_id] = {
       "structures": [slab_001, slab_010, slab_111],
       "_fan_out": True,  # 标记需要为每个结构创建子节点
   }
   ```

2. **执行引擎检测 `_fan_out`：** 动态创建后续节点并添加到 DAG
3. **前端显示：** 扇出的子节点显示为一个"组"，折叠/展开

**参考：** jobflow 的 `Response(replace=Flow([job1, job2, job3]))` 模式

**评估：** 这是最复杂的 feature，建议放在最后。短期内用户可以手动在编辑器中创建多个节点。

---

### 实现路线图

```
Phase 1（近期）:
  ├── Feature 1: 单节点重试 + 级联失效
  ├── Feature 2: 参数变更检测
  └── Bug 6 修复: 孤儿作业检测

Phase 2（中期）:
  ├── Feature 3: 多结构汇聚
  ├── Feature 4: not_converged 自动重试
  └── Bug 5 修复: HPC 连接状态准确性

Phase 3（远期）:
  └── Feature 5: 批量结构扇出（动态工作流）
```

---

## 总结

CatGo 和 atomate2 的设计哲学不同：

- **atomate2**: 面向计算材料科学研究者，代码优先，强调可复现性和灵活性
- **CatGo**: 面向更广泛的用户群，GUI 优先，强调易用性和集成体验

CatGo 不需要照搬 atomate2 的全部架构（MongoDB、Maker 模式、OutputReference），但应该借鉴其**可靠性机制**：

1. **状态持久化要原子且可审计** — 这是生产级工作流系统的基础
2. **孤儿作业检测要自动化** — 不能依赖用户手动发现"卡住了"
3. **失败要分类** — 基础设施错误可重试，计算错误不可重试
4. **作业状态要从 scheduler 真实查询** — 不能仅靠文件存在来推断
5. **单节点重试 + 级联失效** — GUI 应用的核心交互，右键"从这里重跑"
6. **参数变更感知** — 改了参数后 resume 应该知道哪些节点需要重跑
