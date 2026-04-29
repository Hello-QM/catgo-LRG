# CatGo vs atomate2/jobflow/FireWorks/QuAcc: 差距分析与下一步计划

**日期:** 2026-03-18
**背景:** CatGo-PRO 分支已完成 14 个实施 Prompt，本文评估当前状态与竞品的差距。

---

## 一、CatGo-PRO 已经追平或超越的能力

这些是 14 个 Prompt 实施后，CatGo 相对竞品的优势：

| 能力 | CatGo | atomate2/jobflow | FireWorks |
|------|-------|------------------|-----------|
| 可视化 DAG 编辑器 | ✅ 拖拽编辑 | ❌ 纯代码 | ❌ 纯代码 |
| 实时 WebSocket 状态推送 | ✅ | ❌ 需要轮询 | ❌ 需要轮询 |
| 集成 UI（结构+终端+工作流） | ✅ 一体化 | ❌ 分散工具 | ❌ 分散工具 |
| 轻量部署（无需 MongoDB） | ✅ SQLite | ❌ 需 MongoDB | ❌ 需 MongoDB |
| 轮询容错 + 指数退避 | ✅ Prompt 1 | ✅ delta_retry | ✅ |
| 孤儿作业检测 | ✅ Prompt 2 | ✅ Runner daemon | ✅ detect_lostruns |
| 状态审计日志 | ✅ Prompt 3 | ❌ | ✅ state_history |
| 错误分类 (remote/compute/input) | ✅ Prompt 4 | ✅ RemoteError | ❌ |
| 单节点重试 + 级联重置 | ✅ Prompt 5 | ❌ 需代码操作 | ✅ rerun_fw |
| 参数变更检测 | ✅ Prompt 6 | ❌ | ❌ |
| SLURM Array Job (Batch) | ✅ Prompt 7-9 | ❌ 逐个提交 | ❌ 逐个提交 |
| 催化活性分析 (OER/CO2RR/NRR) | ✅ Prompt 10-11 | ❌ | ❌ |
| Volcano Plot 数据生成 | ✅ Prompt 11 | ❌ | ❌ |
| 计算溯源 (_provenance) | ✅ Prompt 12 | ✅ TaskDoc | ❌ |
| 诊断面板 | ✅ Prompt 14 | ❌ | ❌ |

**结论:** CatGo-PRO 在**催化活性分析**和 **Batch Node** 上已经形成独有优势，这是 atomate2 和 FireWorks 都不具备的。

---

## 二、他们能做但 CatGo 还做不了的（核心差距）

### 🔴 差距 1: 动态工作流（Critical — jobflow 核心特性）

**jobflow 的 Response 机制:**
```python
@job
def relax(structure):
    result = run_vasp(structure)
    if not result.converged:
        return Response(detour=relax(result.structure))  # 运行时动态插入重跑
    return result
```

支持三种运行时图变更:
- `replace`: 用子工作流替换当前节点
- `detour`: 在当前节点和下游之间插入新步骤
- `addition`: 在工作流末尾追加步骤

**CatGo 现状:** DAG 在编辑器中定义后是**完全静态**的。不支持运行时根据计算结果修改图结构。

**影响:** 无法实现：
- 不收敛自动重跑（NSW 翻倍）
- 根据能量差决定是否追加精细计算
- slab_gen 生成 N 个表面后自动扇出 N 条并行支路

**建议优先级:** 🔴 P0 — 这是 atomate2 用户选择 atomate2 而非 CatGo 的首要原因

---

### ✅ ~~差距 2: Custodian 自动错误修正~~ — 已实现

> **2026-03-18 更新:** 经深入代码审查，CatGo 已集成 Custodian（13 个 VASP 错误处理器）。
> 详见 `server/models/workflow_run.py` (lines 441-532) 和 `server/workflow/hpc_submit.py`。

**CatGo 已有的 Custodian 能力:**

| 错误 | Handler | 状态 |
|------|---------|------|
| ZBRENT | VaspErrorHandler | ✅ |
| EDDDAV | VaspErrorHandler | ✅ |
| Frozen job | FrozenJobErrorHandler (timeout=3600s) | ✅ |
| POTCAR 问题 | VaspErrorHandler | ✅ |
| Walltime 超时 | WalltimeHandler (buffer=300s) | ✅ |
| k-point mesh 对称性 | MeshSymmetryErrorHandler | ✅ |
| Smearing 错误 | IncorrectSmearingHandler | ✅ |
| LRF+WAVECAR | LrfCommutatorHandler | ✅ |
| 收敛失败 | NonConvergingErrorHandler + UnconvergedErrorHandler | ✅ |
| Aliasing | AliasingErrorHandler | ✅ |
| Drift | DriftErrorHandler | ✅ |
| POTIM 步长 | PotimErrorHandler | ✅ |
| Sigma 过大 | LargeSigmaHandler | ✅ |

**仍有差距:**
- Custodian 仅支持 **VASP**，CP2K/ORCA/Gaussian/xTB 没有错误自动修复
- 没有跨重启的智能参数调优（同一个错误反复出现时不会升级策略）
- `custodian_max_errors` 默认 5 次，没有细粒度的"第 N 次用不同策略"逻辑

---

### 🟡 差距 3: not_converged 自动重试（Important）

**atomate2 的做法:** `Response(detour=new_job)` 让不收敛的 relaxation 自动用 CONTCAR 作为输入重跑。

**CatGo 现状:** `not_converged` 被视为已完成，resume 跳过它。用户需要手动"从这里重跑"（Prompt 5）。

**建议:** 在 `_execute_hpc_node()` 完成后检查收敛状态，自动用 CONTCAR 重跑，最多 N 次。

---

### 🟡 差距 4: 多结构汇聚节点（Important）

**用户场景:**
```
geo_opt_site_1 ─┐
geo_opt_site_2 ─┼→ compare_energies → pick_best
geo_opt_site_3 ─┘
```

**CatGo 现状:** `_get_parent_structure()` 只返回第一个父节点的结构。`compare_energies` analysis 节点已有（但只处理单输入）。

**建议:** 扩展 analysis 节点支持多父节点输入比较。

---

### 🟡 差距 5: 测试覆盖率不足（Important）

**atomate2:** 完善的 pytest 套件（>500 个测试），CI 在每次 PR 上跑。

**CatGo 现状（经审查，比预想好）:**
- Vitest 前端测试: 90+ 文件 (4,259 行)
- Playwright E2E: 35+ 文件 (3,609 行)
- Python backend: 15 文件 (2,878 行) in `server/tests/`
- Rust catgo-graph: 9 文件 (~170KB)
- GitHub Actions CI 已有 (`test.yml` + `lint.yml`)

**但仍有显著差距:**
- Python 测试覆盖率未度量，无阈值强制
- Rust 测试不在 CI 中运行
- E2E 测试标记 `continue-on-error`（失败不阻止合并）
- 新增的 Prompt 1-14 功能均无对应测试

**建议优先补充:**
- `test_catalysis.py` — 自由能/过电位计算正确性验证
- `test_batch_db.py` — Batch 子任务 CRUD
- `test_param_detection.py` — 参数变更检测逻辑

---

### 🟢 差距 6: 完整的 DFT 输入生成（Lower Priority）

**atomate2 Makers 提供:**
- `StaticMaker` — 已有合理的 INCAR 默认值（ENCUT, EDIFF, ISMEAR 等）
- `RelaxMaker` — 力收敛标准预设
- `BandStructureMaker` — 自动计算高对称路径
- `ElasticMaker` — 弹性常数计算（6 个应变方向）
- `PhononMaker` — 声子计算（有限位移法）

**CatGo 现状:** VASP 输入生成支持基本参数，但没有 atomate2 级别的 "开箱即用" 预设。

**影响:** 用户需要手动设置 INCAR 参数，没有 "best practice defaults"。

---

### 🟢 差距 7: QuAcc 的多后端支持（Lower Priority）

**QuAcc 特色:** 同一个工作流可以在多个 executor 之间切换：
- Parsl (多站点并行)
- Dask (本地集群)
- Covalent (云原生)
- Prefect (企业级)
- jobflow (传统 HPC)

**CatGo 现状:** 只支持直接 SSH + SLURM/PBS。不支持 Parsl/Dask 等现代 executor。

**评估:** 对大多数用户（单 HPC 集群）不是问题。多站点用户可能倾向 QuAcc。

---

## 三、下一步实施计划

### Phase 1: 补齐核心差距（P0，1-2 周）

| # | 任务 | 对标 | 预估难度 |
|---|------|------|---------|
| A | **动态工作流 — 条件重试 (not_converged 自动重跑)** | jobflow Response | 中 |
|   | `_execute_hpc_node` 返回后检查收敛，自动用 CONTCAR 重跑 | | |
|   | 节点参数增加 `auto_continue_on_not_converged` + `max_continuation_runs` | | |
| B | **~~Custodian 错误处理器集成~~** ✅ 已有 | atomate2 Custodian | — |
|   | 13 个 VASP handler 已集成，仅需扩展 CP2K/ORCA 支持 | | |
| C | **新功能测试补充** | atomate2 pytest | 中 |
|   | test_catalysis.py, test_batch_db.py, test_param_detection.py | | |
|   | 确保 CI 覆盖新增 Prompt 1-14 功能 | | |

### Phase 2: 增强高通量能力（P1，2-4 周）

| # | 任务 | 对标 | 预估难度 |
|---|------|------|---------|
| D | **多结构汇聚节点** | jobflow Flow | 中 |
|   | analysis 节点支持多父节点输入 + 能量比较/排序 | | |
| E | **结构扇出（动态 fan-out）** | jobflow Response(replace) | 高 |
|   | slab_gen 生成 N 个表面后自动创建 N 条并行支路 | | |
| F | **DFT 输入生成预设** | atomate2 Makers | 中 |
|   | RelaxPreset, StaticPreset, FreqPreset with best-practice INCAR defaults | | |
| G | **大文件拆分** | — | 低 |
|   | 每周拆一个大文件 (App.svelte → 4 files, etc.) | | |

### Phase 3: 差异化竞争力（P2，1-2 月）

| # | 任务 | 说明 |
|---|------|------|
| H | **ML 预筛选集成** | 用 MACE/CHGNet 做快速预筛选，只对有前景的结构跑 DFT |
| I | **离线 POSCAR/XYZ 导出** | 前端纯 JS 序列化，不依赖 Python backend |
| J | **多站点调度** | 支持同时提交到多个 HPC 集群 |
| K | **Windows/macOS CI** | 跨平台自动测试 |

---

## 四、战略定位

```
                    代码灵活性
                        ↑
                        |
           atomate2 ●   |
                        |
                QuAcc ● |
                        |
         FireWorks ●    |
                        |
    ────────────────────●──────────────── → 易用性/UX
                     CatGo
                        |
```

**CatGo 的打法不是在代码灵活性上追赶 atomate2**（那是它的主场），而是在**易用性 + 催化分析 + 高通量 batch 能力**上形成差异化优势。

核心公式：**CatGo = atomate2 的可靠性 + FireWorks 的状态管理 + 独有的催化分析 + GUI 体验**

下一步最关键的事：
1. **动态工作流（至少条件重试）** — 这是 "玩具" 和 "生产工具" 的分水岭
2. **多结构汇聚 + 结构扇出** — 完善高通量催化筛选闭环
3. **新功能测试覆盖** — 14 个 Prompt 的功能均无自动化测试

> 注：Custodian VASP 错误修复已集成（13 个 handler），这块不再是差距。
