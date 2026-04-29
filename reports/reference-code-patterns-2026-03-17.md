# 参考代码模式：atomate2 / jobflow / FireWorks / jobflow-remote / quacc

**日期:** 2026-03-17
**用途:** CatGo 实施时直接参考的代码模式，按功能分类

---

## 1. 动态工作流（Fan-out / Detour / Replace）

### 1.1 jobflow Response 类

**文件:** `jobflow/src/jobflow/core/job.py`

```python
@dataclass
class Response(typing.Generic[T]):
    output: T = None
    detour: Flow | Job | list[Job] = None      # 在当前节点和下游之间插入
    addition: Flow | Job | list[Job] = None    # 在工作流末尾追加
    replace: Flow | Job | list[Job] = None     # 用子工作流替换当前节点
    stored_data: dict[Hashable, Any] = None
    stop_children: bool = False                 # 阻止下游节点执行
    stop_jobflow: bool = False                  # 终止整个工作流
```

**CatGo 借鉴点：** `_execute_node()` 返回值增加类似语义：
```python
@dataclass
class NodeResponse:
    result: dict = None
    retry: bool = False           # 用不同参数重跑自己
    fan_out: list[dict] = None    # 动态创建 N 个子节点
    stop_downstream: bool = False # 阻止下游
```

### 1.2 atomate2 AdsorptionMaker — 运行时 fan-out

**文件:** `atomate2/src/atomate2/vasp/jobs/adsorption.py`

```python
@job
def run_adslabs_job(adslab_structures, relax_maker, static_maker) -> Response:
    """运行时为每个吸附构型创建 relax+static 作业对。"""
    adsorption_jobs = []
    ads_outputs = defaultdict(list)

    for i, ad_structure in enumerate(adslab_structures):
        ads_job = relax_maker.make(structure=ad_structure)
        ads_job.append_name(f"adsconfig_{i}")
        adsorption_jobs.append(ads_job)

        static_job = static_maker.make(structure=ads_job.output.structure)
        static_job.append_name(f"static_adsconfig_{i}")
        adsorption_jobs.append(static_job)

        ads_outputs["static_energy"].append(static_job.output.output.energy)

    ads_flow = Flow(adsorption_jobs, ads_outputs)
    return Response(replace=ads_flow)  # ← 关键：替换自己为 N 个子作业
```

**CatGo 借鉴点：** Batch Node 的 fan-out 逻辑可以参考这个模式，但用 SLURM array job 替代逐个提交。

### 1.3 atomate2 ConvergenceMaker — 递归重试直到收敛

**文件:** `atomate2/src/atomate2/aims/jobs/convergence.py`

```python
@dataclass
class ConvergenceMaker(Maker):
    convergence_field: str          # 要收敛的参数名（如 "k_grid"）
    convergence_steps: list         # 参数值列表（如 [4, 6, 8, 10, 12]）
    epsilon: float = 0.001          # 收敛阈值

    @job
    def make(self, structure, prev_dir=None, convergence_data=None,
             prev_output_value=None):
        # ... 检查是否收敛 ...

        if idx < len(self.convergence_steps) and not converged:
            # 还没收敛 → 用下一个参数值再跑一次
            next_base_job = self.maker.make(structure, prev_dir=prev_dir)
            next_base_job.update_maker_kwargs({
                "_set": {f"input_set_generator->user_params->"
                         f"{self.convergence_field}": self.convergence_steps[idx]}
            }, dict_mod=True)

            # 递归：创建下一轮的 convergence check
            next_job = self.make(
                structure,
                prev_dir=next_base_job.output.dir_name,
                convergence_data=convergence_data,
                prev_output_value=getattr(next_base_job.output.output, self.criterion_name),
            )
            replace_flow = Flow([next_base_job, next_job], output=next_base_job.output)
            return Response(replace=replace_flow)  # ← 替换自己为"计算+检查"

        # 已收敛 → 返回结果
        return ConvergenceSummary.from_data(structure, convergence_data)
```

**CatGo 借鉴点：** not_converged 自动重试可以参考此模式。在 `_execute_hpc_node()` 完成后检查收敛，未收敛则用 CONTCAR 重新提交。

### 1.4 run_locally() 中 Response 的执行顺序

**文件:** `jobflow/src/jobflow/managers/local.py`

```python
def _run_job(job, parents):
    response = job.run(store=store)

    if response.stop_children:
        stopped_parents.add(job.uuid)
    if response.stop_jobflow:
        return None, True

    # 执行顺序：replace → detour → addition
    if response.replace is not None:
        _run(response.replace)    # 替换当前节点
    if response.detour is not None:
        _run(response.detour)     # 插入到下游之前
    if response.addition is not None:
        _run(response.addition)   # 追加到工作流末尾

    return response, False
```

---

## 2. 孤儿作业检测 + 心跳

### 2.1 FireWorks 心跳线程

**文件:** `fireworks/core/rocket.py`

```python
def ping_launch(launchpad, launch_id, stop_event, master_thread):
    """后台线程：每 PING_TIME_SECS 秒 ping 一次 LaunchPad。"""
    while not stop_event.is_set() and master_thread.is_alive():
        stop_event.wait(PING_TIME_SECS)  # 默认 3600 秒
        do_ping(launchpad, launch_id)

def do_ping(launchpad, launch_id):
    if launchpad:
        launchpad.ping_launch(launch_id)  # 更新 MongoDB 中的时间戳
    else:
        # 离线模式：写本地文件
        with open("FW_ping.json", "w") as f:
            f.write(f'{{"ping_time": "{datetime.now(timezone.utc).isoformat()}"}}')
```

**CatGo 适配：** 不需要独立线程。在轮询循环中每次 poll 时更新 `workflow_steps.last_polled_at`：
```python
# python_engine.py 轮询循环中
while time.time() - start_time < max_wait:
    await asyncio.sleep(interval)
    # 更新心跳
    update_step(workflow_id, node_id, {"last_polled_at": _now()})
    # 查询状态...
```

### 2.2 FireWorks detect_lostruns()

**文件:** `fireworks/core/launchpad.py`

```python
def detect_lostruns(self, expiration_secs=RUN_EXPIRATION_SECS, fizzle=False, rerun=False):
    """查找超过 expiration_secs 没有心跳的 RUNNING 作业。"""
    cutoff_timestr = (now - timedelta(seconds=expiration_secs)).isoformat()

    # 查询条件：状态是 RUNNING，且最后一次心跳早于 cutoff
    lostruns_query = {
        "state": "RUNNING",
        "state_history": {
            "$elemMatch": {
                "state": "RUNNING",
                "updated_on": {"$lte": cutoff_timestr}
            }
        }
    }

    bad_launch_data = self.launches.find(lostruns_query, {"launch_id": 1, "fw_id": 1})

    for ld in bad_launch_data:
        lost_launch_ids.append(ld["launch_id"])

    if fizzle:
        for lid in lost_launch_ids:
            self.mark_fizzled(lid)
    if rerun:
        for fw_id in lost_fw_ids:
            self.rerun_fw(fw_id)

    return lost_launch_ids, lost_fw_ids, inconsistent_fw_ids
```

**CatGo 适配（SQLite 版）：**
```python
# recover_workflows() 或定时任务中
async def detect_orphan_steps():
    """检测超过 30 分钟没有心跳的 running 步骤。"""
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
    with get_db() as conn:
        orphans = conn.execute("""
            SELECT id, workflow_id, hpc_job_id, hpc_session_id
            FROM workflow_steps
            WHERE status IN ('running', 'queued')
            AND (last_polled_at IS NULL OR last_polled_at < ?)
        """, (cutoff,)).fetchall()

    for step in orphans:
        # 尝试用 sacct 查真实状态
        hpc = pool.get_connection(step["hpc_session_id"])
        if hpc and step["hpc_job_id"]:
            job_info = await hpc.scheduler.get_job_status(hpc.conn, step["hpc_job_id"])
            if job_info and job_info.status in FAILED_STATES:
                update_step(step["workflow_id"], step["id"], {
                    "status": "failed",
                    "error_message": f"Orphan detected, SLURM status: {job_info.status}"
                })
            elif job_info is None:
                # 作业消失了，标记为 failed
                update_step(step["workflow_id"], step["id"], {
                    "status": "failed",
                    "error_message": "Job no longer in scheduler queue (orphan recovery)"
                })
```

---

## 3. 重试 + 指数退避

### 3.1 jobflow-remote 重试机制

**文件:** `jobflow-remote/src/jobflow_remote/jobs/jobcontroller.py`

```python
@contextlib.contextmanager
def lock_job_for_update(self, query, max_step_attempts, delta_retry, ...):
    with self.lock_job(filter=db_filter) as lock:
        try:
            yield lock
        except RemoteError as e:
            error = f"Remote error: {e.msg}"
            no_retry = e.no_retry
        except Exception:
            error = traceback.format_exc()

        if error:
            step_attempts = doc["remote"]["step_attempts"]
            no_retry = no_retry or step_attempts >= max_step_attempts

            if no_retry:
                # 不可重试 → 终态
                lock.update_on_release = {"$set": {
                    "state": "REMOTE_ERROR",
                    "remote.error": error,
                }}
            else:
                # 可重试 → 指数退避
                step_attempts += 1
                delta = delta_retry[min(step_attempts, len(delta_retry)) - 1]
                retry_time = datetime.now(timezone.utc) + timedelta(seconds=delta)
                lock.update_on_release = {"$set": {
                    "remote.step_attempts": step_attempts,
                    "remote.retry_time_limit": retry_time,
                    "remote.error": error,
                }}
```

**默认配置：**
```python
max_step_attempts: int = 3
delta_retry: tuple = (30, 300, 1200)  # 30秒, 5分钟, 20分钟
```

**CatGo 适配：**
```python
# python_engine.py 轮询循环中
MAX_POLL_RETRIES = 3
RETRY_DELAYS = [30, 300, 1200]
poll_failures = 0

while time.time() - start_time < max_wait:
    try:
        job_info = await hpc.scheduler.get_job_status(hpc.conn, job_id)
        poll_failures = 0  # 成功则重置
    except Exception as e:
        poll_failures += 1
        if poll_failures > MAX_POLL_RETRIES:
            raise RuntimeError(f"SSH polling failed {MAX_POLL_RETRIES} times: {e}")
        delay = RETRY_DELAYS[min(poll_failures, len(RETRY_DELAYS)) - 1]
        logger.warning("Poll failed (%d/%d), retrying in %ds: %s",
                       poll_failures, MAX_POLL_RETRIES, delay, e)
        await asyncio.sleep(delay)
        # 尝试重连
        hpc = pool.get_connection(session_id)
        if not hpc:
            continue
        continue
```

### 3.2 错误分类

```python
class RemoteError(Exception):
    """基础设施错误（SSH 断开、文件传输失败等）。"""
    def __init__(self, msg, no_retry=False):
        self.msg = msg
        self.no_retry = no_retry  # True = 永久失败，False = 可重试
```

**CatGo 适配 — 在 workflow_steps 表增加列：**
```sql
ALTER TABLE workflow_steps ADD COLUMN error_type TEXT;
-- 'remote_error' = SSH/网络问题，可重试
-- 'compute_error' = VASP 算法错误，不可重试
-- 'input_error' = 输入参数错误，需要用户干预
ALTER TABLE workflow_steps ADD COLUMN retry_count INTEGER DEFAULT 0;
ALTER TABLE workflow_steps ADD COLUMN last_polled_at TEXT;
```

---

## 4. 级联重跑（Rerun + 下游重置）

### 4.1 FireWorks rerun_fw() — 递归级联

**文件:** `fireworks/core/firework.py`

```python
class Workflow:
    def rerun_fw(self, fw_id, updated_ids=None):
        """重跑一个 Firework 并递归重置所有下游。"""
        updated_ids = updated_ids or set()
        m_fw = self.id_fw[fw_id]
        m_fw._rerun()          # 重置自己
        updated_ids.add(fw_id)
        updated_ids.union(self.refresh(fw_id, updated_ids))

        # 递归重置所有子节点
        for child_id in self.links[fw_id]:
            if self.id_fw[child_id].state != "WAITING":
                updated_ids = updated_ids.union(self.rerun_fw(child_id, updated_ids))
        return updated_ids

class Firework:
    def _rerun(self):
        """重置单个 Firework 的状态。"""
        self.archived_launches.extend(self.launches)  # 归档旧的执行记录
        self.launches = []
        self.state = "WAITING"
```

**CatGo 已适配版本（见 feature-workflow-controls-2026-03-17.md）：**
```python
def reset_step_and_descendants(workflow_id, step_id):
    # BFS 找所有后继 → 批量 UPDATE status='pending'
```

---

## 5. 状态审计日志

### 5.1 FireWorks state_history

**文件:** `fireworks/core/firework.py`

```python
class Launch:
    def _update_state_history(self, state):
        """每次状态变化追加一条记录。"""
        if state != self.state_history[-1]["state"]:
            self.state_history.append({
                "state": state,
                "created_on": datetime.now(timezone.utc),
            })
            if state in ["RUNNING", "RESERVED"]:
                self.touch_history()  # 加 updated_on

    def touch_history(self, update_time=None):
        """心跳更新最后一条记录的时间戳。"""
        self.state_history[-1]["updated_on"] = update_time or datetime.now(timezone.utc)
```

**典型 state_history 数组：**
```json
[
    {"state": "READY",    "created_on": "2024-01-15T10:00:00Z"},
    {"state": "RESERVED", "created_on": "2024-01-15T10:01:00Z", "updated_on": "2024-01-15T10:01:05Z"},
    {"state": "RUNNING",  "created_on": "2024-01-15T10:02:00Z", "updated_on": "2024-01-15T14:15:30Z"},
    {"state": "COMPLETED","created_on": "2024-01-15T14:16:00Z"}
]
```

**CatGo 适配 — 在 workflow_steps 表增加 state_history JSON 列：**
```sql
ALTER TABLE workflow_steps ADD COLUMN state_history TEXT DEFAULT '[]';
```
```python
def _append_state_history(workflow_id, step_id, new_state):
    with get_db() as conn:
        row = conn.execute("SELECT state_history FROM workflow_steps WHERE id = ?", (step_id,)).fetchone()
        history = json.loads(row[0] or "[]")
        history.append({"state": new_state, "created_on": _now()})
        conn.execute("UPDATE workflow_steps SET state_history = ? WHERE id = ?",
                     (json.dumps(history), step_id))
        conn.commit()
```

---

## 6. 数据溯源（Provenance）

### 6.1 atomate2 TaskDoc 模型

**文件:** `emmet-core/emmet/core/tasks.py`

```python
class TaskDoc(CoreTaskDoc):
    """完整的计算任务文档。"""
    calcs_reversed: list[Calculation]     # 每步计算的详细记录（最新的在前）
    custodian: list[CustodianDoc]         # custodian 修正记录
    analysis: AnalysisDoc                 # 分析结果
    run_stats: dict[str, RunStatistics]   # 运行统计

class AnalysisDoc(BaseModel):
    delta_volume: float           # 体积变化
    delta_volume_percent: float   # 体积变化百分比
    max_force: float              # 最大力
    warnings: list[str]           # 如 "Volume change > 20%"
    errors: list[str]             # 如 "Bad structure (atoms are too close!)"

class RunStatistics(BaseModel):
    average_memory: float         # 平均内存 (KB)
    max_memory: float             # 峰值内存
    elapsed_time: float           # 墙钟时间
    system_time: float            # 系统时间
    user_time: float              # 用户时间
    total_time: float             # 总 CPU 时间
    cores: int                    # 使用核数

class CustodianDoc(BaseModel):
    corrections: list             # custodian 应用的修正列表
    job: dict                     # 作业配置
```

**CatGo 适配 — result_json 中增加 _provenance：**
```python
step_results[node_id]["_provenance"] = {
    "catgo_version": "0.1.0",
    "timestamp": _now(),
    "software": "vasp",
    "software_version": parse_vasp_version_from_outcar(outcar_content),
    "input_params": params,
    "potcar_titles": parse_potcar_titles(potcar_content),
    "run_stats": {
        "elapsed_time": parse_elapsed_time(outcar_content),
        "max_memory": parse_max_memory(outcar_content),
        "cores": params.get("ntasks", 1),
    },
    "analysis": {
        "delta_volume": (final_vol - initial_vol) / initial_vol * 100,
        "max_force": max_force,
        "warnings": warnings,
    },
    "custodian_corrections": parse_custodian_log(work_dir),
    "parent_steps": _get_parent_ids(node_id, edges),
    "hpc_host": hpc.host,
    "hpc_job_id": job_id,
}
```

---

## 7. Custodian 集成

### 7.1 atomate2 默认 VASP 处理器

**文件:** `atomate2/src/atomate2/vasp/run.py`

```python
DEFAULT_HANDLERS = (
    VaspErrorHandler(),
    MeshSymmetryErrorHandler(),
    UnconvergedErrorHandler(),
    NonConvergingErrorHandler(),
    PotimErrorHandler(),
    PositiveEnergyErrorHandler(),
    FrozenJobErrorHandler(),
    StdErrHandler(),
    LargeSigmaHandler(),
    IncorrectSmearingHandler(),
    KspacingMetalHandler(),
)

DEFAULT_VALIDATORS = (VasprunXMLValidator(), VaspFilesValidator())
```

### 7.2 quacc 透明 Custodian 集成

**文件:** `quacc/src/quacc/settings.py`

```python
# 默认启用，用户无需配置
VASP_USE_CUSTODIAN: bool = True
VASP_CUSTODIAN_MAX_ERRORS: int = 5
VASP_CUSTODIAN_HANDLERS: list[str] = [
    "VaspErrorHandler", "MeshSymmetryErrorHandler", "UnconvergedErrorHandler",
    "NonConvergingErrorHandler", "PotimErrorHandler", "FrozenJobErrorHandler",
    "StdErrHandler", "LargeSigmaHandler", "IncorrectSmearingHandler",
    "PositiveEnergyErrorHandler", "WalltimeHandler", "KspacingMetalHandler"
]
```

**CatGo 当前方式：** 生成 `run_custodian.py` 脚本上传到 HPC。可以参考 quacc 的 handler 列表确保覆盖全面。

### 7.3 atomate2 should_stop_children()

**文件:** `atomate2/src/atomate2/vasp/run.py`

```python
def should_stop_children(task_doc, handle_unsuccessful=SETTINGS.VASP_HANDLE_UNSUCCESSFUL):
    """根据计算结果决定是否停止下游节点。"""
    if task_doc.state != TaskState.SUCCESS:
        if handle_unsuccessful is True:
            return True    # 标记完成但停止下游
        if handle_unsuccessful == "error":
            raise RuntimeError(f"VASP calculation failed: {task_doc.dir_name}")
        # handle_unsuccessful is False → 继续执行下游
    return False
```

---

## 8. quacc 特有模式

### 8.1 装饰器式工作流定义

**文件:** `quacc/src/quacc/recipes/vasp/slabs.py`

```python
@flow
def slab_to_ads_flow(slab, adsorbate, run_static=True, make_ads_kwargs=None):
    """表面吸附工作流 — 纯函数，无类继承。"""
    relax_job_, static_job_ = customize_funcs(
        ["relax_job", "static_job"],
        [relax_job, static_job],
        param_swaps=job_params,
    )
    return slab_to_ads_subflow(
        slab, adsorbate, relax_job_,
        static_job=static_job_ if run_static else None,
        make_ads_kwargs=make_ads_kwargs,
    )

@subflow
def slab_to_ads_subflow(slab, adsorbate, relax_job, static_job=None, make_ads_kwargs=None):
    """动态 fan-out：为每个吸附构型创建作业。"""
    adslabs = make_adsorbate_structures(slab, adsorbate, **(make_ads_kwargs or {}))
    results = []
    for adslab in adslabs:
        result = relax_job(adslab)
        if static_job:
            result = static_job(result["atoms"])
        results.append(result)
    return results
```

### 8.2 多执行引擎切换

**文件:** `quacc/src/quacc/wflow_tools/decorators.py`

```python
def job(_func=None, **kwargs):
    settings = get_settings()
    if settings.WORKFLOW_ENGINE == "dask":
        from dask import delayed
        return delayed(wrapper, **kwargs)
    elif settings.WORKFLOW_ENGINE == "parsl":
        from parsl import python_app
        return python_app(wrapped_fn, **kwargs)
    elif settings.WORKFLOW_ENGINE == "prefect":
        from prefect import task
        return task(_func, **kwargs)
    elif settings.WORKFLOW_ENGINE == "jobflow":
        return _get_jobflow_wrapped_func(_func, **kwargs)
    else:
        return _func  # 本地直接执行
```

**CatGo 借鉴点：** CatGo 的执行引擎已经有 Python/Rust 两条路径。可以参考 quacc 的模式，让节点定义与执行后端解耦。

### 8.3 ML 势场预筛选

**文件:** `quacc/src/quacc/recipes/mlp/core.py`

```python
@job
def relax_job(atoms, method="mace-mp-0", relax_cell=False, **calc_kwargs):
    """ML 势场快速优化 — 秒级完成。"""
    calc = pick_calculator(method, **calc_kwargs)
    # 支持: mace-mp-0, chgnet, m3gnet, sevennet, orb, fairchem
    dyn = Runner(atoms, calc).run_opt(relax_cell=relax_cell, **opt_flags)
    return Summarize(...).opt(dyn)
```

**CatGo 借鉴点：** 高通量筛选中，先用 ML 预筛 10,000 → top 100，再用 DFT 精确计算。

---

## 9. 分布式锁（适用于未来多 Worker 场景）

### 9.1 jobflow-remote MongoLock

**文件:** `jobflow-remote/src/jobflow_remote/utils/db.py`

```python
class MongoLock:
    """MongoDB 文档级分布式锁。"""

    def acquire(self):
        lock_set = {self.LOCK_KEY: self.lock_id, self.LOCK_TIME_KEY: now}
        update = {"$set": lock_set}

        result = self.collection.find_one_and_update(
            {**self.filter, self.LOCK_KEY: None},  # 只匹配未锁定的文档
            update,
            upsert=False,
            return_document=ReturnDocument.AFTER,
        )
        if result and self.get_lock_id(result) == self.lock_id:
            self.locked_document = result

    def release(self, exc_type, exc_val, exc_tb):
        # 异常时不应用 update_on_release（原子回滚）
        if exc_type is None and self.update_on_release:
            update = {**{"$set": {self.LOCK_KEY: None}}, **self.update_on_release}
        else:
            update = {"$set": {self.LOCK_KEY: None}}
        self.collection.update_one({"_id": self.locked_document["_id"]}, update)
```

**CatGo 当前不需要：** 单进程 asyncio 不需要分布式锁。但如果未来引入多 Worker，可以用 SQLite 的 `BEGIN EXCLUSIVE` 模拟。

---

## 10. OutputReference（延迟引用）

### 10.1 jobflow OutputReference

**文件:** `jobflow/src/jobflow/core/reference.py`

```python
class OutputReference:
    """延迟引用：job.output["key"].nested 创建引用链，执行时才解析。"""

    def __init__(self, uuid, attributes=()):
        self.uuid = uuid
        self.attributes = attributes  # (("i", "key"), ("a", "nested"))

    def __getitem__(self, item):
        return OutputReference(self.uuid, (*self.attributes, ("i", item)))

    def __getattr__(self, item):
        return OutputReference(self.uuid, (*self.attributes, ("a", item)))

    def resolve(self, store):
        """从 store 获取数据，然后重放属性链。"""
        data = store.get_output(self.uuid)
        for attr_type, attr in self.attributes:
            data = data[attr] if attr_type == "i" else getattr(data, attr)
        return data
```

**使用方式：**
```python
job1 = relax(structure)
job2 = static(job1.output.structure)  # 自动创建 DAG 边
# job1.output.structure 是 OutputReference(uuid=job1.uuid, attributes=(("a","structure"),))
# 执行 job2 时，resolve → 从 store 取 job1 的输出 → 取 .structure 属性
```

**CatGo 暂不需要：** 当前 GUI 编辑器通过手动连线定义依赖，`step_results[parent_id]` 传递数据。如果未来支持代码定义工作流，可以引入。

---

## 文档索引

| 来源 | 关键模式 | CatGo 参考价值 |
|------|---------|---------------|
| atomate2 `AdsorptionMaker` | 吸附能完整工作流 | 高 — 直接参考实现催化工作流 |
| atomate2 `ConvergenceMaker` | 递归收敛重试 | 高 — not_converged 自动续跑 |
| atomate2 `run_vasp()` | Custodian handler 配置 | 中 — 确认 CatGo custodian 脚本覆盖全面 |
| atomate2 `TaskDoc` | 计算溯源模型 | 高 — result_json 增加 _provenance |
| jobflow `Response` | 动态工作流控制词汇 | 高 — NodeResponse 返回值设计 |
| jobflow `run_locally()` | Response 处理逻辑 | 中 — 执行引擎参考 |
| jobflow `OutputReference` | 延迟数据引用 | 低 — GUI 编辑器不需要 |
| FireWorks `detect_lostruns()` | 孤儿作业检测 | 高 — SQLite 版已适配 |
| FireWorks `ping_launch()` | 心跳机制 | 高 — 轮询循环内更新 last_polled_at |
| FireWorks `rerun_fw()` | 级联重跑 | 高 — reset_step_and_descendants 已参考 |
| FireWorks `state_history` | 状态审计日志 | 中 — 增加 state_history 列 |
| jobflow-remote `check_run_status()` | SLURM 批量状态查询 | 高 — batch node 轮询参考 |
| jobflow-remote `lock_job_for_update()` | 重试+指数退避 | 高 — 轮询容错已适配 |
| jobflow-remote `RemoteError` | 错误分类 | 高 — remote_error vs compute_error |
| quacc `@job/@flow/@subflow` | 装饰器式工作流 | 中 — 未来代码模式 |
| quacc `slab_to_ads_flow` | 催化工作流 | 高 — 直接参考 |
| quacc `pick_calculator()` | ML 势场抽象 | 中 — ML 预筛选集成 |
| quacc 透明 Custodian | Calculator 层错误处理 | 中 — 长期改进方向 |
