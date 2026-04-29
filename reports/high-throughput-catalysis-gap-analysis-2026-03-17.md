# 高通量催化剂筛选工作流：差距分析

**日期:** 2026-03-17
**场景:** 结构切面 → 高通量掺杂（~10,000 结构） → DFT 优化 → OER/CO2RR/NRR 活性评估

---

## 工作流分解

```
Step 1: bulk_structure
  ↓
Step 2: slab_gen (切面，Miller indices)
  ↓
Step 3: doping_gen (高通量掺杂，生成 ~10,000 结构)
  ↓  ↓  ↓  ... ↓  (扇出)
Step 4: geo_opt × 10,000 (DFT 结构优化)
  ↓  ↓  ↓  ... ↓
Step 5: adsorbate_place × N_intermediates (放置 *OH, *O, *OOH 等中间体)
  ↓  ↓  ↓  ... ↓
Step 6: single_point / geo_opt (吸附体系 DFT)
  ↓  ↓  ↓  ... ↓  (汇聚)
Step 7: free_energy_correction (ZPE + 熵修正)
  ↓
Step 8: overpotential_calculation (理论过电位)
  ↓
Step 9: volcano_plot / ranking (活性排序)
```

实际计算量：
- 10,000 基底结构 × 4 个 OER 中间体 (*OH, *O, *OOH, *H₂O) = **~40,000 个 DFT 作业**
- 如果加上 CO2RR (6 个中间体) 和 NRR (6 个中间体)，总量可达 **~160,000 个作业**

---

## 逐步能力分析

### Step 1-2: 结构 → 切面 ✅ 完全支持

| 功能 | CatGo | atomate2 |
|------|-------|----------|
| Miller 指数切面 | ✅ `slab_gen` 节点 + `MillerSlabCutterPane` | ✅ pymatgen `SlabGenerator` |
| 多取向枚举 | ✅ 前端 UI 支持 | ✅ 代码控制 |
| 真空层设置 | ✅ | ✅ |
| 表面终止选择 | ✅ | ✅ |

**CatGo 优势：** 可视化实时预览切面效果，拖拽调节参数。

---

### Step 3: 高通量掺杂 ⚠️ 部分支持

| 功能 | CatGo | atomate2 |
|------|-------|----------|
| 单元素替换掺杂 | ✅ `POST /build/doping`（枚举所有唯一配置） | ✅ pymatgen `SubstitutionTransformation` |
| 多元素组合替换 | ✅ `POST /build/substitution`（组合积） | ✅ 代码循环 |
| 枚举上限 | ⚠️ 硬编码 50（doping）/ 500（substitution） | 无限制（用户控制） |
| 生成 10,000 结构 | ❌ 超过上限 | ✅ Python 循环生成 |
| 对称性去重 | ✅ pymatgen `EnumerateStructureTransformation` | ✅ 同 |

**差距：**
- CatGo 的掺杂枚举有硬编码上限（50/500），无法生成 10,000 结构
- 需要提升上限或改为分批生成
- atomate2 通过 Python 脚本无限制生成，用户自控

**建议：**
- 移除或提高硬编码上限，改为用户可配置
- 增加"批量掺杂"节点，支持多元素 × 多浓度的笛卡尔积
- 结果写入数据库而非全部加载到内存

---

### Step 4: 10,000 个 DFT 优化 ❌ 严重不足

这是**最大的瓶颈**。

| 功能 | CatGo | atomate2/jobflow-remote | FireWorks |
|------|-------|------------------------|-----------|
| 提交 10,000 作业 | ❌ 需手动建 10,000 个节点 | ✅ `Response(replace=Flow([...]))` | ✅ 批量插入 |
| 并发作业管理 | ⚠️ `asyncio.gather` 同一层全部并发 | ✅ Runner daemon 控制并发数 | ✅ qlaunch rapidfire |
| 作业限流/节流 | ❌ 无 | ✅ worker 配置并发上限 | ✅ `-m N` 参数 |
| 失败重试 | ❌ 无自动重试 | ✅ 3 次指数退避 | ✅ `rerun_fws` |
| 结果聚合 | ❌ 无批量查询 | ✅ MongoDB 查询 | ✅ MongoDB |
| 进度追踪 | ⚠️ WebSocket（单工作流） | ✅ `jf job list -s RUNNING` | ✅ `lpad get_wflows` |

**CatGo 当前架构面对 10,000 作业的问题：**

1. **DAG 不支持动态扇出：** 必须在编辑器里手动创建 10,000 个 `geo_opt` 节点 — 不可能
2. **内存问题：** `asyncio.gather` 同时启动 10,000 个轮询协程
3. **SQLite 瓶颈：** 10,000 行 step 记录的频繁读写，加上单文件锁
4. **无限流控制：** 超算 queue 通常限制同时提交的作业数（如 SLURM `MaxSubmitJobs`）
5. **前端渲染：** SVG 编辑器画 10,000 个节点会卡死

**atomate2/jobflow-remote 如何做到：**

```python
# jobflow: 动态生成 10,000 个作业
@job
def screen_all_dopants(structures: list[Structure]):
    jobs = [RelaxMaker().make(s) for s in structures]
    flow = Flow(jobs)
    return Response(replace=flow)

# jobflow-remote Runner 限流：
# worker config 中设置 max_jobs=50，同时最多 50 个作业在 SLURM 队列
```

**建议（分三个层次）：**

#### 短期：Array Job 模式
- 一个"批量优化"节点接收结构列表
- 生成一个 SLURM array job（`#SBATCH --array=1-10000`）
- 单次 `sbatch` 提交，SLURM 自行调度
- 轮询 `sacct -j <array_job_id>` 获取所有子任务状态
- 这是最简单且 HPC 友好的方案

#### 中期：Fan-out 引擎
- `loop` 节点实现：接收结构列表，为每个结构动态创建子节点
- 并发限制：最多 N 个作业同时在 SLURM 队列
- 结果汇聚：所有子作业完成后合并结果

#### 远期：分布式任务队列
- 引入 Celery 或类似的任务队列
- CatGo backend 作为任务生产者，HPC worker 作为消费者
- 类似 jobflow-remote 的 Runner daemon 架构

---

### Step 5: 吸附物放置 ⚠️ 部分支持

| 功能 | CatGo | atomate2 |
|------|-------|----------|
| 自动找吸附位点 | ✅ Alpha Shape 算法 | ✅ pymatgen `AdsorbateSiteFinder` |
| 预设吸附物 | ✅ ~20 种 (*OH, *O, *OOH 等) | ✅ pymatgen 分子库 |
| 单结构放置 | ✅ | ✅ |
| 批量放置（10,000 结构） | ❌ 需逐个手动操作 | ✅ 代码循环 |
| 多种吸附物并行 | ❌ 每次只放一种 | ✅ 循环 + fan-out |

**差距：**
- CatGo 的 `adsorbate_place` 是单结构操作，没有批量模式
- 对 10,000 结构各放 4 种 OER 中间体 = 40,000 次操作，无法手动完成

**建议：**
- 增加"批量吸附物放置"节点，接收结构列表 + 吸附物列表
- 自动为每个结构找位点，在最稳定位点放置每种吸附物
- 输出：`{structure_id: {adsorbate: [placed_structures]}}`

---

### Step 6-7: 吸附体系 DFT + 自由能修正 ⚠️ 部分支持

| 功能 | CatGo | atomate2 |
|------|-------|----------|
| 吸附体系 geo_opt | ✅ VASP geo_opt 节点 | ✅ `SlabRelaxMaker` |
| 频率计算（ZPE） | ✅ freq 节点 | ✅ `PhononMaker` 或 VASP freq |
| 自由能修正 | ❌ `free_energy` 节点是空壳 | ❌ 也没有内置 |
| 温度/电位修正 | ❌ | ❌ |

**两边都没有：** 从 DFT 能量 + 频率到 Gibbs 自由能的自动计算管线。这通常是用户自己的 post-processing 脚本。

**建议：**
- 实现 `free_energy` 节点逻辑：
  ```
  G = E_DFT + ZPE - T*S
  ZPE = Σ(½ħω_i)  (来自频率计算)
  S = Σ[ħω_i/(T*(exp(ħω_i/kT)-1)) - k*ln(1-exp(-ħω_i/kT))]
  ```
- 常用参考值内置：H₂O(l), H₂(g), N₂(g), CO₂(g) 的标准自由能

---

### Step 8-9: 过电位 + 活性排序 ❌ 不支持

| 功能 | CatGo | atomate2 | 专用工具 |
|------|-------|----------|---------|
| OER 过电位 | ❌ | ❌ | CatKit (废弃) |
| CO2RR 限制电位 | ❌ | ❌ | 无 |
| NRR 过电位 | ❌ | ❌ | 无 |
| Volcano 图 | ❌ | ❌ | SPOCK |
| Scaling relations | ❌ | ❌ | 用户脚本 |
| 描述符提取 | ❌ d-band center 等 | ❌ | 用户脚本 |

**重要发现：atomate2 也没有内置催化活性评估！** 这是整个 Materials Project 生态的空白。

**建议：** 这是 CatGo 的**差异化机会**。实现以下功能可以超越 atomate2：

#### OER 过电位计算

```python
# 标准 OER 四步机制
# H₂O → *OH → *O → *OOH → O₂

def compute_oer_overpotential(dG_OH, dG_O, dG_OOH):
    """计算理论 OER 过电位 (CHE 模型)."""
    step1 = dG_OH                    # H₂O → *OH + H⁺ + e⁻
    step2 = dG_O - dG_OH             # *OH → *O + H⁺ + e⁻
    step3 = dG_OOH - dG_O            # *O → *OOH + H⁺ + e⁻
    step4 = 4.92 - dG_OOH            # *OOH → O₂ + H⁺ + e⁻
    eta = max(step1, step2, step3, step4) / 1 - 1.23  # V
    return eta
```

#### Scaling Relation（OER 经验公式）

```python
# Nørskov 标度关系
dG_OOH = 0.84 * dG_OH + 3.29  # eV (经验)
# 只需计算 dG_OH 和 dG_O 即可估算 OER 活性
```

#### Volcano Plot

```python
# 以 dG_O - dG_OH 为描述符
# x 轴：dG_O - dG_OH
# y 轴：-η (理论过电位)
# 理想值：dG_O - dG_OH ≈ 1.6 eV
```

---

## atomate2 能做但 CatGo 做不了的

| 能力 | 原因 |
|------|------|
| **动态扇出 10,000 作业** | CatGo DAG 是静态的，无 `Response(replace=...)` |
| **分布式作业管理** | CatGo 用单进程 asyncio，无 daemon/worker 架构 |
| **MongoDB 级结果查询** | CatGo 用 SQLite，不适合 10,000+ 行高频读写 |
| **失败自动重试** | CatGo 没有重试机制 |
| **作业限流** | CatGo 没有并发控制，同层全部提交 |
| **工作流组合复用** | atomate2 的 Maker 可以嵌套组合；CatGo 模板不支持嵌套 |

## CatGo 能做但 atomate2 做不好的

| 能力 | 原因 |
|------|------|
| **可视化工作流编辑** | atomate2 纯代码 |
| **实时状态推送** | atomate2 需要 `jf job list` 主动查 |
| **一体化 UI** | 结构查看器 + 终端 + 文件浏览器 + 工作流在同一 App |
| **零配置部署** | 不需要 MongoDB、不需要配置 worker |
| **交互式吸附位点选择** | 3D 预览 + 点击选择位点 |

## 两边都做不了的

| 能力 | 现状 |
|------|------|
| **OER/CO2RR/NRR 过电位计算** | 都没有内置 |
| **Scaling relations** | 都没有内置 |
| **Volcano plot** | 都没有内置（SPOCK 是独立工具） |
| **ML 加速筛选** | OCP/fairchem 是独立项目 |
| **自由能自动修正** | 都需要用户脚本 |

---

## 建议的实现路线图

### Phase 1: 基础设施（解决 10,000 作业问题）

```
1.1 SLURM Array Job 节点
    - 单次 sbatch --array=1-N
    - 轮询 sacct 获取所有子任务状态
    - 估计工作量：3-5 天

1.2 掺杂枚举上限提升
    - 移除 50/500 硬编码限制
    - 分批生成 + 流式写入
    - 估计工作量：1 天

1.3 批量吸附物放置
    - 接收结构列表 + 吸附物列表
    - 自动找位点 + 放置
    - 估计工作量：2-3 天
```

### Phase 2: 催化活性分析（差异化功能）

```
2.1 free_energy 节点实现
    - G = E_DFT + ZPE - TS
    - 内置参考值 (H₂O, H₂, N₂, CO₂)
    - 估计工作量：2-3 天

2.2 OER/HER 过电位节点
    - CHE 模型计算
    - Scaling relation 估算
    - 估计工作量：2 天

2.3 CO2RR/NRR 活性评估节点
    - 多步反应路径自由能图
    - 限制电位计算
    - 估计工作量：3 天

2.4 Volcano Plot 可视化
    - 描述符 vs 过电位散点图
    - 前端交互式图表
    - 估计工作量：2 天
```

### Phase 3: 智能筛选（超越 atomate2）

```
3.1 ML 预筛选集成
    - 接入 OCP/fairchem API 做快速预筛
    - DFT 只验证 ML 预测的 top candidates
    - 将 10,000 → 100-500 个 DFT 作业

3.2 自适应工作流
    - 根据初步结果动态调整筛选范围
    - 收敛检查 + 条件分支

3.3 描述符数据库
    - d-band center, 配位数, 表面能等
    - 跨项目查询和对比
```

---

## 总结

**现有架构能做什么：**
- 切面 ✅、掺杂（≤50 个）⚠️、吸附物放置（单个）⚠️、DFT 优化（单个）✅

**做不了什么：**
- 10,000 结构的批量提交和管理 ❌
- OER/CO2RR/NRR 过电位计算 ❌
- 自由能修正 ❌
- 活性排序和 Volcano plot ❌

**最大的架构瓶颈：** 静态 DAG + 单进程 asyncio 无法处理 10,000 级别的作业扇出

**最大的功能空白：** 催化活性评估（但 atomate2 也没有，这是差异化机会）

**最务实的短期方案：** SLURM Array Job 节点 — 一个 `sbatch --array=1-10000` 解决批量提交问题，不需要重构整个工作流引擎
