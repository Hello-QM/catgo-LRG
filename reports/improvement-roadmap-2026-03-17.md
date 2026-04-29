# CatGo 综合提升路线图

**日期:** 2026-03-17
**关联文档:**
- `reports/bug-desktop-serve-hpc-2026-03-17.md` — HPC 相关 bug
- `reports/feature-workflow-controls-2026-03-17.md` — 工作流精细控制
- `reports/feature-batch-node-2026-03-17.md` — Batch Node 万级子任务
- `reports/high-throughput-catalysis-gap-analysis-2026-03-17.md` — 高通量催化差距分析
- `reports/comparison-atomate2-jobflow-2026-03-17.md` — 与 atomate2 对比

---

## 一、可靠性工程（P0）

### 1.1 静默错误消除

**现状：** 代码库中大量 `.catch(() => {})` 和空 `catch {}` 把错误藏起来，用户看到的是"什么都没发生"而不是"出了什么错"。

**今天发现的实例：**

| 位置 | 模式 | 后果 |
|------|------|------|
| `workflow.ts:160` | `.catch(() => {})` | DB 同步失败静默，作业提交到空数据 |
| `workflow.ts:175-180` | `console.error` 但不阻止执行 | 同步失败后仍然提交作业 |
| `python_engine.py:790` | 轮询无 try/except | SSH 断开导致整个 task 崩溃 |
| `TerminalPanel.svelte:224` | `catch {}` | WebGL 加载失败但不知道原因 |

**行动计划：**

1. 全局搜索 `.catch(() => {})` 和 `catch {}` / `catch { }` / `except: pass`
2. 对每个实例分类：
   - **必须上报**：影响用户操作结果的（如工作流提交、文件保存）
   - **可以静默**：真正的降级场景（如 WebGL 降级到 Canvas）
   - **需要日志**：开发调试需要但用户不需要看到的
3. 引入前端错误通知机制：
   ```typescript
   // 统一错误上报
   import { toast } from '$lib/notifications'

   // 替换静默 catch
   await fetch(...).catch(err => {
     toast.error(`Failed to sync workflow: ${err.message}`)
     throw err  // 让调用方知道失败了
   })
   ```

### 1.2 状态一致性

**现状：** 多处前后端状态不同步：
- NodeStatusPanel 的 HPC 连接状态与实际不一致（Bug 5）
- 工作流状态卡在 running（Bug 6）
- WASM 数据库和 Python backend 数据不一致（Bug 1-3）

**行动计划：**

1. 增加"状态断言"检查：
   ```python
   # 定期任务：每 5 分钟扫描不一致状态
   async def audit_workflow_states():
       for step in get_running_steps():
           if not is_task_active(step.workflow_id):
               # 没有活跃 task 但 step 是 running → 孤儿
               logger.warning("Orphan step: %s", step.id)
               # 尝试用 sacct 查真实状态
               ...
   ```

2. 前端增加"最后更新时间"指示器：
   - 如果某个 running 节点超过 10 分钟没有收到 WebSocket 更新，显示警告图标
   - 点击可手动刷新状态

---

## 二、测试体系（P0）

### 2.1 现状

整个项目没有自动化测试。所有 bug 都是用户在使用中发现的。

### 2.2 测试优先级

#### 第一批：关键路径（防止回归）

```
tests/
├── server/
│   ├── test_workflow_db.py          # 工作流 CRUD、状态转换
│   ├── test_workflow_engine.py      # 执行引擎、轮询逻辑
│   ├── test_hpc_scheduler.py        # SLURM 状态解析、sacct 输出解析
│   ├── test_structure_parse.py      # CIF/POSCAR/XYZ/JSON 解析
│   └── test_vasp_input.py           # INCAR/KPOINTS/POTCAR 生成
└── frontend/
    ├── test_workflow_sync.ts         # run_workflow 同步链路
    └── test_pty_transport.ts         # PTY 传输层
```

#### 关键测试用例

```python
# test_workflow_engine.py

def test_recover_workflows_resets_running_to_paused():
    """Backend 重启后 running 工作流应该变成 paused。"""
    create_workflow_with_status("running")
    recover_workflows()
    assert get_workflow(wf_id).status == "paused"

def test_slurm_node_fail_detected():
    """SLURM NODE_FAIL 应该被正确检测为失败。"""
    mock_sacct_output = "12345|vasp_job|NODE_FAIL|workq|1|00:05:00|24:00:00|..."
    job_info = parse_sacct_line(mock_sacct_output)
    assert job_info.status == "NODE_FAIL"

def test_job_disappeared_from_squeue_checks_sacct():
    """squeue 看不到作业时应该查 sacct 而不是只看 OUTCAR。"""
    # mock squeue 返回空
    # mock sacct 返回 NODE_FAIL
    # 期望：raise RuntimeError，而不是 break（误判完成）

def test_run_workflow_sync_failure_blocks_execution():
    """sync 失败时不应该继续提交作业。"""
    # mock POST /workflow/ 返回 500
    # 期望：run_workflow 抛异常，不调用 /run
```

#### CI 集成

```yaml
# .github/workflows/test.yml
- 在 Linux 和 Windows 上都跑
- Python 测试：pytest
- 前端检查：pnpm check
- 未来：Playwright e2e 测试
```

---

## 三、代码架构（P1）

### 3.1 大文件拆分

| 文件 | 当前行数 | 拆分建议 |
|------|---------|---------|
| `desktop/App.svelte` | 3500+ | → `TabManager.svelte` + `PaneRenderer.svelte` + `ModalManager.svelte` + `AppShell.svelte` |
| `Structure.svelte` | 3500+ | → `StructureToolbar.svelte` + `StructureToolExecutor.ts` + `StructureState.svelte.ts` |
| `StructureScene.svelte` | 3100+ | → `SceneLighting.svelte` + `AtomInteraction.svelte` + `SceneOverlays.svelte` |
| `hpc_client.py` | 2000+ | → `ssh_connection.py` + `slurm.py` + `pbs.py` + `connection_pool.py` |
| `python_engine.py` | 1100+ | → `batch.py` + `hpc_submit.py` + `poll.py` + `result_collect.py` |

**原则：** 不做大规模重构，每次 PR 拆一个文件，保持功能不变。

### 3.2 Svelte 5 响应式规范

今天发现的 `$state` proxy spread 问题不是孤例。需要建立团队规范：

```markdown
## Svelte 5 $state 规范（写入 desktop/CLAUDE.md ✅ 已完成）

1. 修改深层 $state 对象时，直接 mutate 属性，不要 spread 替换
2. $derived.by 对数组/对象 prop 的深层变化追踪不可靠，用 $effect + $state 替代
3. @const 在 {#each} 中是响应式的，但依赖链必须通过 $state proxy
```

---

## 四、数据溯源（P1）

### 4.1 计算溯源记录

**现状：** `result_json` 只存输出结果，不记录输入参数和环境。

**建议：** 每个 step 完成时记录 `_provenance`：

```python
step_results[node_id]["_provenance"] = {
    "catgo_version": "0.1.0",
    "timestamp": "2026-03-17T14:30:00Z",
    "input_params": params,                    # 完整 INCAR 参数
    "input_structure_hash": md5(poscar),        # 输入结构指纹
    "software": "vasp",
    "software_version": parse_vasp_version(outcar),  # 从 OUTCAR 提取
    "potcar_titles": ["PAW_PBE Ti 08Apr2002", ...],  # 从 POTCAR 提取
    "hpc_host": "shaheen.hpc.kaust.edu.sa",
    "hpc_job_id": "12345",
    "walltime_used": "04:23:17",
    "nodes": 1,
    "ntasks": 96,
    "parent_steps": ["structure_input_1", "slab_gen_1"],  # 来源链
}
```

**价值：**
- 论文复现：记录了完整的计算条件
- 调试：知道失败时用的什么参数
- 审计：追踪结构从哪来的（bulk → slab → doping → optimize 完整链路）

### 4.2 结构来源链

每个结构应该记录它的"家谱"：

```json
{
  "structure": { ... },
  "_lineage": [
    {"step": "structure_input_1", "action": "load from MP: mp-2664 (TiO₂)"},
    {"step": "slab_gen_1", "action": "Miller (1,1,0), 3 layers, 15Å vacuum"},
    {"step": "doping_1", "action": "Ti→Fe at site 4"},
    {"step": "geo_opt_1", "action": "VASP PBE relax, ENCUT=520, converged"}
  ]
}
```

---

## 五、离线 / 断网体验（P1）

### 5.1 现状

Tauri 桌面应用理应有良好的离线体验，但目前：

| 功能 | 是否需要 backend | 应该需要吗 |
|------|-----------------|-----------|
| 查看结构 | ❌ 前端渲染 | ❌ 正确 |
| 编辑结构（加原子/删原子） | ❌ 前端 WASM | ❌ 正确 |
| 导出 CIF/POSCAR | ✅ Python pymatgen | ❌ 应该纯前端 |
| 导出 XYZ | ✅ Python ASE | ❌ 应该纯前端 |
| 创建/编辑工作流 | ❌ 前端 | ❌ 正确 |
| 运行工作流 | ✅ Python backend | ✅ 必须 |
| AI 聊天 | ✅ Python backend | ✅ 必须 |

### 5.2 建议

POSCAR/XYZ 这些简单格式的序列化完全可以在前端实现（不依赖 pymatgen），让用户在 backend 未启动时也能导出结构。

---

## 六、用户反馈闭环（P2）

### 6.1 诊断面板

新增一个"系统状态"面板（可从侧栏或设置中打开）：

```
┌─────────────────────────────────────────────────┐
│  System Status                           🔄 刷新 │
├─────────────────────────────────────────────────┤
│  Backend:     ● Connected (localhost:8000)       │
│  HPC:         ● shaheen (reny0b) — 2h uptime    │
│  Database:    ● catgo_results.db (12.3 MB)       │
│  Workflows:   2 running, 1 paused, 15 completed │
│                                                  │
│  ┌─ Recent Errors (last 24h) ─────────────────┐ │
│  │ 14:30 [workflow] sync failed: 404           │ │
│  │ 14:28 [HPC] SSH connection lost            │ │
│  │ 13:15 [VASP] Job 12345 NODE_FAIL           │ │
│  └────────────────────────────────────────────┘ │
│                                                  │
│  [📋 Copy Diagnostic Info]  [📤 Export Logs]     │
└─────────────────────────────────────────────────┘
```

### 6.2 错误日志收集

```python
# 后端：环形缓冲区存最近 200 条错误
from collections import deque

_error_log = deque(maxlen=200)

def log_user_error(category: str, message: str, details: str = ""):
    _error_log.append({
        "timestamp": datetime.now().isoformat(),
        "category": category,
        "message": message,
        "details": details,
    })

# API
@router.get("/system/errors")
async def get_recent_errors(limit: int = 50):
    return list(_error_log)[-limit:]
```

---

## 七、跨平台稳定性（P2）

### 7.1 现状

`server/CLAUDE.md` 记录了大量 Windows 特有 bug：
- UTF-16 BOM 文件损坏
- `shell=True` 打断 stderr 合并
- subprocess stdin 挂起
- 路径反斜杠处理
- stderr 管道死锁

所有这些都是**用户报告后才发现**的。

### 7.2 建议

1. **GitHub Actions CI：** 在 Linux + Windows + macOS 上跑 `pnpm check` + `pytest`
2. **路径处理统一：** 所有路径操作使用 `pathlib.Path`，不手动拼字符串
3. **子进程规范：**
   ```python
   # 写入 server/CLAUDE.md 的规范
   # 1. 永远不对 .exe 用 shell=True
   # 2. 永远指定 stdin=DEVNULL（除非需要交互）
   # 3. 永远同时读取 stdout 和 stderr（独立线程）
   # 4. 永远设置超时
   ```

---

## 八、性能优化（P2）

### 8.1 Tauri + NVIDIA + WebKitGTK

**已修复：** 终端禁用 WebGL（今天的修复）

**未解决：** 3D 结构查看器（Three.js）仍然使用 WebGL，在 NVIDIA + WebKitGTK 上可能有性能问题。

**建议：**
- 监控：增加 FPS 计数器（开发模式下显示）
- 大结构降级：原子数 > 10,000 时自动降低渲染质量（减少 sphere segments、禁用阴影）
- 环境变量 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 写入 Tauri 启动脚本

### 8.2 大结构处理

当前架构对超过 10,000 原子的结构没有优化：
- 键计算是 O(n²)
- 每次结构变化重新计算所有键
- 前端和后端之间传输完整结构 JSON

**建议：**
- 大结构自动禁用键显示（或只显示截断半径内的键）
- 结构差异传输（只传变化的原子，而非完整结构）
- WebWorker 中做键计算（已部分实现）

---

## 九、插件生态（P3）

### 9.1 现状

插件系统存在但不稳定：
- MCP 插件热加载依赖 mtime 扫描
- 插件 import pymatgen 导致 30s+ 冷启动
- 没有插件版本管理
- 没有插件市场/发现机制

### 9.2 建议

短期不需要大改，但可以做：
- 插件模板生成器：`catgo plugin create my-tool`
- 插件健康检查：启动时验证所有插件能正常加载
- 插件文档：每个插件的 README 自动显示在 UI 中

---

## 综合优先级

> **2026-03-18 更新:** CatGo-PRO 分支已完成标 ✅ 的项目

```
P0（近期，1-2 周）:
├── ✅ 静默错误消除 — Prompt 13
├── 🔲 关键路径测试 — workflow engine + SLURM 解析 (未实施)
├── ✅ Bug 5-6 修复 — HPC 状态准确性 + 孤儿作业 (Prompt 1-2)
├── ✅ Feature 1 — 单节点重试 (Prompt 5)
└── ✅ Feature 2 — 参数变更检测 (Prompt 6)

P1（中期，2-4 周）:
├── ✅ 数据溯源 — _provenance 字段 (Prompt 12)
├── ✅ Batch Node — SLURM array job 支持 (Prompt 7-9)
├── 🔲 大文件拆分 — 每周拆一个文件 (未实施)
├── ✅ 催化活性节点 — free_energy + OER + CO2RR + NRR + Volcano (Prompt 10-11)
└── 🔲 离线导出 — 前端 POSCAR/XYZ 序列化 (未实施)

P2（远期，1-2 月）:
├── ✅ 诊断面板 — 系统状态 + 错误日志 (Prompt 14)
├── 🔲 CI/CD — Linux + Windows + macOS (未实施)
├── 🔲 性能优化 — 大结构降级渲染 (未实施)
├── 🔲 动态工作流 — loop 节点 + 扇出 (未实施)
└── 🔲 ML 预筛选集成 — OCP/MACE (未实施)
```

---

## 总结

CatGo 最大的优势是**一体化 GUI 体验**——结构编辑、工作流设计、HPC 管理、结果分析在同一个应用里。这是 atomate2 做不到的。

最需要提升的不是功能数量，而是**可靠性**：
1. 错误不要静默吞掉
2. 状态不要和实际不一致
3. 出了问题用户要能看到发生了什么
4. 关键路径要有测试兜底

功能层面，**催化活性评估**（OER/CO2RR 过电位计算、volcano plot）是差异化机会，因为 atomate2 也没有。先把可靠性基础打好，再做高通量和催化分析，会事半功倍。
