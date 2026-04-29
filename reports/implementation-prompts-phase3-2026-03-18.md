# 实施 Prompts Phase 3：Clean Frontend + Backend

**日期:** 2026-03-18
**分支:** `CatGo-PRO`
**目标:** 修复空壳节点、接通前端-后端断链、清理重复代码，让用户看到一个干净可用的产品

---

## 问题总结

经深度审查，CatGo 存在三类问题：

1. **空壳节点** — 前端有定义，后端是 TODO（condition/loop/merge/polymer 等）
2. **前端断链** — 后端功能已实现，但前端看不到（DiagnosticsPanel/催化结果/VolcanoPlot）
3. **重复实现** — Phase 1+2 和已有功能重叠（VASP presets/d-band/Gibbs）

## 实施状态

| # | 功能 | 优先级 | 状态 |
|---|------|--------|------|
| 25 | condition/loop/merge 控制流实现 | P0 | ✅ |
| 26 | charge_analysis handler 修复 | P0 | ✅ |
| 27 | 前端节点注册 (pick_best, batch_adsorbate_place) | P0 | ✅ |
| 28 | DiagnosticsPanel 接入桌面 App | P0 | ✅ |
| 29 | NodeStatusPanel 催化结果显示 | P1 | ✅ |
| 30 | VolcanoPlot 前端组件 | P1 | ✅ |
| 31 | BatchStatusPanel 条件修复 | P1 | ✅ |
| 32 | 清理重复代码 (presets 对齐) | P1 | ✅ |
| 33 | VASP preset 选择器 UI | P1 | ✅ |
| 34 | 结构来源链 (Lineage) UI | P2 | ✅ |
| 35 | export_data 真实导出 | P2 | ✅ |
| 36 | her_analysis 实现 | P2 | ✅ |
| 37 | auto-retry 状态在 NodeStatusPanel 显示 | P1 | ✅ |
| 38 | CP2K error handler 集成到执行路径 | P1 | ✅ |
| 39 | 离线导出增加主动入口 | P2 | ✅ |

---

## Prompt 25: condition/loop/merge 控制流实现（P0）

```
请实现工作流控制流节点 condition、loop、merge 的后端逻辑。
当前这三个节点在 server/workflow/engines/local.py 中只是标记 completed 但不做任何评估。
这导致 14 个工作流模板中约 6 个实际跑不通（如 Batch Surface、Full Catalysis Pipeline 等）。

## 需求

### 1. condition 节点
在 local.py 中实现条件评估逻辑。

前端已定义的参数（node-defs/logic.ts）：
- check_type: "energy_diff" | "max_force" | "converged" | "n_steps"
- operator: "lt" | "gt" | "eq" | "lte" | "gte"
- threshold: number (默认 0.01)

后端需要：
- 读取父节点的结果
- 根据 check_type 提取对应的值（energy_diff → 取两个父节点能量差，max_force → 取最大力，converged → 布尔值，n_steps → 步数）
- 与 threshold 做比较
- 将结果存入 step_results[node_id] = { "condition_met": True/False, "value": ..., "threshold": ... }
- 根据结果决定下游走哪条边（通过 source_handle "true"/"false"）

```python
# server/workflow/engines/local.py — condition 实现

elif node_type == "condition":
    # 读取父节点结果
    parent_results = [step_results.get(pid, {}) for pid in parent_ids]
    check_type = params.get("check_type", "converged")
    operator = params.get("operator", "lt")
    threshold = float(params.get("threshold", 0.01))

    # 提取检查值
    if check_type == "energy_diff" and len(parent_results) >= 2:
        e1 = parent_results[0].get("final_energy") or parent_results[0].get("summary", {}).get("energy_eh", 0)
        e2 = parent_results[1].get("final_energy") or parent_results[1].get("summary", {}).get("energy_eh", 0)
        value = abs(float(e1 or 0) - float(e2 or 0))
    elif check_type == "max_force":
        parent = parent_results[0] if parent_results else {}
        value = parent.get("max_force") or parent.get("summary", {}).get("max_force", 0)
    elif check_type == "converged":
        parent = parent_results[0] if parent_results else {}
        # 1.0 if converged, 0.0 if not
        value = 1.0 if parent.get("converged", False) else 0.0
        threshold = 0.5  # converged → value=1.0 > 0.5 → condition_met
        operator = "gt"
    elif check_type == "n_steps":
        parent = parent_results[0] if parent_results else {}
        value = parent.get("n_steps") or parent.get("summary", {}).get("n_steps", 0)
    else:
        value = 0

    # 比较
    ops = {"lt": lambda a, b: a < b, "gt": lambda a, b: a > b,
           "eq": lambda a, b: abs(a - b) < 1e-10, "lte": lambda a, b: a <= b,
           "gte": lambda a, b: a >= b}
    condition_met = ops.get(operator, ops["lt"])(float(value), threshold)

    step_results[step_id] = {
        "condition_met": condition_met,
        "check_type": check_type,
        "value": float(value),
        "threshold": threshold,
        "operator": operator,
    }
    # 将父结构传递给下游
    for pid in parent_ids:
        if "structure" in step_results.get(pid, {}):
            step_results[step_id]["structure"] = step_results[pid]["structure"]
            break
```

### 2. loop 节点
前端参数（node-defs/logic.ts）：
- loop_type: "structures" | "parameters"
- max_iterations: number (默认 10, max 100)

后端需要：
- 如果 loop_type == "structures"：从父节点获取 structures 列表，为每个结构执行下游子图
- 如果 loop_type == "parameters"：根据参数范围迭代

**最简实现：** loop 节点将父节点的 structures 列表标记为 _fan_out，让 Prompt 19 的 fan-out 机制处理。

```python
elif node_type == "loop":
    loop_type = params.get("loop_type", "structures")
    parent = step_results.get(parent_ids[0], {}) if parent_ids else {}

    if loop_type == "structures":
        structures = parent.get("structures", [])
        if not structures and parent.get("structure"):
            structures = [parent["structure"]]
        step_results[step_id] = {
            "structures": structures,
            "_fan_out": True,
            "n_iterations": len(structures),
        }
    elif loop_type == "parameters":
        # 参数迭代 — 暂时传递父结构
        step_results[step_id] = {
            "structure": parent.get("structure"),
            "n_iterations": params.get("max_iterations", 10),
        }
```

### 3. merge 节点
后端需要：
- 收集所有父节点的结果
- 汇聚结构列表和能量数据
- 传递给下游

```python
elif node_type == "merge":
    merged_structures = []
    merged_energies = []
    for pid in parent_ids:
        parent = step_results.get(pid, {})
        if parent.get("structures"):
            merged_structures.extend(parent["structures"])
        elif parent.get("structure"):
            merged_structures.append(parent["structure"])
        energy = parent.get("final_energy") or parent.get("summary", {}).get("energy_eh")
        if energy is not None:
            merged_energies.append({"step_id": pid, "energy": float(energy)})

    step_results[step_id] = {
        "structures": merged_structures,
        "energies": merged_energies,
        "n_merged": len(merged_structures),
    }
```

## 关于 orchestrator 中 condition 的边选择

在 orchestrator.py 的 _run_workflow 中，执行完 condition 节点后，需要根据 condition_met 过滤下游节点。

在 _topo_sort 后的 layer 执行中，检查每个节点的父节点是否是 condition 节点，如果是，只有匹配的 handle（"true"/"false"）的边才执行。

```python
# orchestrator.py — 在 "Skip already-completed nodes" 检查后增加：
# Check if any parent is a condition node — skip if condition doesn't match
skip_due_to_condition = False
for pid in [e.get("source") or e.get("from", "") for e in edges
            if (e.get("target") or e.get("to", "")) == node_id]:
    parent_result = step_results.get(pid, {})
    if "condition_met" in parent_result:
        # Find the edge from this parent to this node
        for e in edges:
            src = e.get("source") or e.get("from", "")
            tgt = e.get("target") or e.get("to", "")
            if src == pid and tgt == node_id:
                handle = e.get("sourceHandle", "")
                met = parent_result["condition_met"]
                if handle == "true" and not met:
                    skip_due_to_condition = True
                elif handle == "false" and met:
                    skip_due_to_condition = True
                break
if skip_due_to_condition:
    logger.info("Workflow %s: skipping %s (condition not met)", workflow_id, node_id)
    update_step(workflow_id, node_id, {"status": "skipped"})
    completed_steps += 1
    continue
```

## 文件清单
- 修改: server/workflow/engines/local.py（condition/loop/merge 实现）
- 修改: server/workflow/orchestrator.py（condition 边选择逻辑）

## 验证
```bash
cd server && python -c "
from workflow.engines.local import execute_local_node
print('OK')
"
```
```

---

## Prompt 26: charge_analysis handler 修复（P0）

```
请修复 charge_analysis 节点的后端 handler 缺失问题。

## 当前问题
charge_analysis 在 node_sets.py 中被归类为 HPC_ANALYSIS_NODES，走 HPC 执行路径。
但它不像 geo_opt 那样需要提交作业 — 它应该在已有的 CHGCAR/AECCAR 上运行 Bader。

## 需求

在 analysis.py 中添加 charge_analysis handler。

由于 Bader 分析需要 HPC 上的文件（CHGCAR + AECCAR0 + AECCAR2），
handler 应该：
1. 读取父节点的 work_dir
2. 在 HPC 上运行 bader 命令
3. 解析 ACF.dat 输出
4. 返回 per-atom charges

```python
# 在 analysis.py 中添加 charge_analysis handler
elif node_type == "charge_analysis":
    method = params.get("method", "bader")
    parent = step_results.get(parent_ids[0], {}) if parent_ids else {}
    work_dir = parent.get("work_dir", "")

    if not work_dir:
        analysis_result["error"] = "No work directory from parent step"
    else:
        analysis_result.update({
            "method": method,
            "work_dir": work_dir,
            "status": "requires_hpc",
            "message": f"Bader analysis requires running 'bader CHGCAR -ref AECCAR0 AECCAR2' in {work_dir}",
        })
```

同时在 node_sets.py 中将 charge_analysis 从 HPC_ANALYSIS_NODES 移到 ANALYSIS_NODES，
因为它是后处理分析而非 HPC 计算。

## 文件清单
- 修改: server/workflow/engines/analysis.py
- 修改: server/workflow/node_sets.py
```

---

## Prompt 27: 前端节点注册（P0）

```
请将 Phase 2 新增的后端节点类型注册到前端 NODE_DEFINITIONS。

## 需求

### 1. 在 src/lib/workflow/node-defs/analysis.ts 中添加 pick_best：

```typescript
pick_best: {
  type: `pick_best`,
  label: `Pick Best`,
  color: `#10b981`,
  icon: `\u{1F3C6}`,  // 🏆
  category: `Analysis`,
  description: `Select the lowest-energy structure from multiple parent calculations`,
  inputs: [`data`],
  outputs: [`structure`],
  default_params: {},
  help_text: `**Pick Best** — Compares energies from all parent nodes and selects the most stable structure for downstream use.`,
  param_schema: [],
},
```

### 2. 在 src/lib/workflow/node-defs/utility.ts 中添加 batch_adsorbate_place：

```typescript
batch_adsorbate_place: {
  type: `batch_adsorbate_place`,
  label: `Batch Adsorbate`,
  color: `#f59e0b`,
  icon: `\u{1F9EA}`,  // 🧪
  category: `Tools`,
  description: `Place adsorbates on multiple slab structures for high-throughput screening`,
  inputs: [`structures`],
  outputs: [`structures`],
  default_params: { adsorbates: `OH`, max_sites_per_struct: 1, site_strategy: `all` },
  help_text: `**Batch Adsorbate Placement** — Places OER/HER/CO2RR intermediates on multiple structures using pymatgen AdsorbateSiteFinder.`,
  param_schema: [
    {
      key: `adsorbates`, label: `Adsorbates`, type: `string`, default: `OH`,
      group: `Adsorbate`,
      help: `Comma-separated: OH, O, OOH, H, H2O, COOH, CO`,
    },
    {
      key: `max_sites_per_struct`, label: `Max Sites per Structure`, type: `number`,
      default: 1, min: 1, max: 10, group: `Adsorbate`,
    },
    {
      key: `site_strategy`, label: `Site Strategy`, type: `select`, default: `all`,
      group: `Adsorbate`,
      options: [
        { label: `All sites`, value: `all` },
        { label: `On-top only`, value: `ontop` },
        { label: `Bridge only`, value: `bridge` },
        { label: `Hollow only`, value: `hollow` },
      ],
    },
  ],
},
```

### 3. 在 node-defs/index.ts 的 ANALYSIS_TYPE_OPTIONS 中添加 pick_best：

```typescript
{ value: `pick_best`, label: `Pick Best Structure` },
```

在 TOOL_TYPE_OPTIONS 中添加 batch_adsorbate_place：

```typescript
{ value: `batch_adsorbate_place`, label: `Batch Adsorbate` },
```

## 文件清单
- 修改: src/lib/workflow/node-defs/analysis.ts
- 修改: src/lib/workflow/node-defs/utility.ts
- 修改: src/lib/workflow/node-defs/index.ts
```

---

## Prompt 28: DiagnosticsPanel 接入桌面 App（P0）

```
请将已创建的 DiagnosticsPanel.svelte 接入桌面应用。

## 需求

在 desktop/App.svelte 中：
1. 在 landing page 的卡片区域添加一个 "System Status" 卡片
2. 或者在侧栏底部添加一个小的状态指示器（后端连接状态 + 错误计数）
3. 点击后打开 DiagnosticsPanel（可以用 modal 或 popout window）

最简方案：在侧栏底部添加状态栏。

读取 desktop/Sidebar.svelte，找到底部区域（lab link 附近），在那里添加：

```svelte
<script>
  import DiagnosticsPanel from '$lib/DiagnosticsPanel.svelte'
  let show_diagnostics = $state(false)
</script>

<!-- 在侧栏底部 -->
<button class="sidebar-status-btn" onclick={() => show_diagnostics = !show_diagnostics}>
  System Status
</button>

{#if show_diagnostics}
  <div class="diagnostics-overlay">
    <DiagnosticsPanel />
  </div>
{/if}
```

## 文件清单
- 修改: desktop/Sidebar.svelte 或 desktop/App.svelte
```

---

## Prompt 29: NodeStatusPanel 催化结果显示（P1）

```
请在 NodeStatusPanel.svelte 中为催化分析节点添加结果显示。

## 需求

读取 NodeStatusPanel.svelte 的 cached_summary 结构，为以下节点类型添加结果显示 section：

### 1. free_energy 节点结果
当 node_type 是 free_energy 且 cached_summary 有数据时：

```svelte
{#if node_type === `free_energy` && cached_summary.G !== undefined}
  <div class="sp-section">
    <div class="sp-section-title">Free Energy Correction</div>
    <div class="sp-info-grid">
      <div class="sp-info-row">
        <span class="sp-info-label">G (Gibbs)</span>
        <span class="sp-info-value mono">{cached_summary.G.toFixed(4)} eV</span>
      </div>
      <div class="sp-info-row">
        <span class="sp-info-label">E_DFT</span>
        <span class="sp-info-value mono">{cached_summary.E_DFT.toFixed(4)} eV</span>
      </div>
      <div class="sp-info-row">
        <span class="sp-info-label">ZPE</span>
        <span class="sp-info-value mono">{cached_summary.ZPE.toFixed(4)} eV</span>
      </div>
      <div class="sp-info-row">
        <span class="sp-info-label">T×S</span>
        <span class="sp-info-value mono">{cached_summary.TS.toFixed(4)} eV</span>
      </div>
      <div class="sp-info-row">
        <span class="sp-info-label">Temperature</span>
        <span class="sp-info-value mono">{cached_summary.temperature} K</span>
      </div>
    </div>
  </div>
{/if}
```

### 2. energy_compare 节点结果
当 node_type 是 energy_compare 且有 entries 数组：

```svelte
{#if node_type === `energy_compare` && cached_summary.entries?.length}
  <div class="sp-section">
    <div class="sp-section-title">Energy Comparison ({cached_summary.n_compared} structures)</div>
    <table class="sp-energy-table">
      <thead><tr><th>Rank</th><th>Step</th><th>Energy (eV)</th><th>Relative (meV/atom)</th></tr></thead>
      <tbody>
        {#each cached_summary.entries as entry}
          <tr class:best={entry.rank === 1}>
            <td>{entry.rank}</td>
            <td>{entry.step_id.slice(0, 8)}</td>
            <td class="mono">{entry.energy_eV.toFixed(4)}</td>
            <td class="mono">{entry.relative_meV_per_atom?.toFixed(1) ?? `—`}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
```

### 3. condition 节点结果

```svelte
{#if node_type === `condition` && cached_summary.condition_met !== undefined}
  <div class="sp-section">
    <div class="sp-section-title">Condition Check</div>
    <div class="sp-info-grid">
      <div class="sp-info-row">
        <span class="sp-info-label">Result</span>
        <span class="sp-info-value">{cached_summary.condition_met ? `✅ Condition met` : `❌ Condition not met`}</span>
      </div>
      <div class="sp-info-row">
        <span class="sp-info-label">{cached_summary.check_type}</span>
        <span class="sp-info-value mono">{cached_summary.value} {cached_summary.operator} {cached_summary.threshold}</span>
      </div>
    </div>
  </div>
{/if}
```

在 result_json 的 cached_summary 里读取这些字段。注意 cached_summary 来自 step_info 的 result_json 解析。

## 文件清单
- 修改: src/lib/workflow/NodeStatusPanel.svelte
```

---

## Prompt 30: VolcanoPlot 前端组件（P1）

```
请新建 src/lib/workflow/VolcanoPlot.svelte，用 SVG 实现 Volcano Plot。

## 需求

一个独立的 Svelte 5 组件，接收 volcano 数据并渲染 SVG 散点图。

Props:
- points: { name: string; x: number; y: number }[]
- ideal_line: { x: number[]; y: number[] } | null
- x_label: string (默认 "ΔG_OH (eV)")
- y_label: string (默认 "-η (V)")

特性：
- SVG 坐标轴 + 网格线
- 散点（每个催化剂一个圆点，hover 显示名称）
- 理想 volcano 线（红色虚线）
- Responsive（根据容器宽度自适应）

不需要引入图表库，用纯 SVG 实现（像 BatchStatusPanel 的直方图那样）。

在 NodeStatusPanel 中为有 volcano 数据的结果渲染此组件。
也在新的 CatalysisResultsPanel 中使用（如果创建的话）。

## 文件清单
- 新建: src/lib/workflow/VolcanoPlot.svelte
- 修改: src/lib/workflow/NodeStatusPanel.svelte（集成）
```

---

## Prompt 31: BatchStatusPanel 条件修复（P1）

```
请修复 BatchStatusPanel 的渲染条件，使其能正确检测 batch 节点。

## 当前问题
条件 is_batch_node = node_type.includes('batch') 永远为 false，
因为没有节点类型名称包含 "batch"。

## 修复方案

改为检测步骤的 result_json 是否包含 batch 数据：

```svelte
// 改为从 step_info 检测 batch 状态
const is_batch_node = $derived(
  node_type === 'batch_adsorbate_place'
  || (step_info?.result_json && (() => {
    try {
      const r = JSON.parse(step_info.result_json)
      return r.batch_result || r._fan_out
    } catch { return false }
  })())
)
```

或者更简单地，检查后端是否有 batch_subtasks 数据：

```svelte
let has_batch_data = $state(false)

$effect(() => {
  if (!workflow_id || !node_id) return
  fetch(`${API_BASE}/workflow/${workflow_id}/steps/${node_id}/batch-summary`)
    .then(r => r.ok ? r.json() : null)
    .then(data => { has_batch_data = data && data.total > 0 })
    .catch(() => { has_batch_data = false })
})

const is_batch_node = $derived(
  node_type === 'batch_adsorbate_place' || has_batch_data
)
```

## 文件清单
- 修改: src/lib/workflow/NodeStatusPanel.svelte
```

---

## Prompt 32: 清理重复代码（P1）

```
请清理 Phase 1+2 引入的重复实现。

## 需要清理的重复

### 1. server/workflow/presets/vasp.py — 与前端 node-defs 重复
前端 node-defs/calculation.ts 已经为每个计算类型定义了 INCAR 默认值。
后端 presets/vasp.py 的默认值应该与前端保持一致，并标注为 "backend defaults, frontend overrides"。

**操作：** 不删除 presets/vasp.py（后端输入生成需要它），但在注释中说明它和前端的关系。
确保后端预设值和前端 node-defs 的 default 值完全一致：

对比并修正：
- 前端 geo_opt: ISIF=2, NSW=200, EDIFFG=-0.02
- 后端 RELAX_PRESET: ISIF=3, NSW=200, EDIFFG=-0.02
→ 不一致！前端 geo_opt 默认 ISIF=2（只 relax ions），后端是 ISIF=3（relax all）
→ 原因：前端 geo_opt 用于 slab 场景（ISIF=2），后端 RELAX_PRESET 用于 bulk（ISIF=3）
→ 保持差异但添加注释说明

### 2. 后端 catalysis/descriptors.py d-band 与 DOS session API
两者并存是合理的（descriptors.py 用于纯计算，DOS session 用于交互分析）。
不需要删除，但需要在 descriptors.py 添加注释：

```python
# Note: d-band center can also be computed interactively via the DOS
# analysis session (/api/dos/dband). This function is for non-interactive
# workflow pipeline usage where a full DOS session isn't needed.
```

## 文件清单
- 修改: server/workflow/presets/vasp.py（添加注释）
- 修改: server/workflow/catalysis/descriptors.py（添加注释）
```

---

## Prompt 33: VASP preset 选择器 UI（P1）

```
请在 NodeConfigPanel.svelte 中为 VASP 计算节点添加预设选择器。

## 需求

当编辑 geo_opt/single_point/cell_opt/md/freq 节点且 software=vasp 时，
在参数面板顶部显示一个 "Preset" 下拉：

- None (manual)
- Relax (default)
- Static
- Slab Relax
- Frequency
- Band Structure
- Molecular Dynamics

选择预设后，自动填充对应的 INCAR 参数到表单中。

## 实现

在 NodeConfigPanel.svelte 中：

```svelte
{#if is_vasp_node}
  <div class="preset-selector">
    <label>INCAR Preset:</label>
    <select onchange={(e) => apply_preset(e.target.value)}>
      <option value="">Manual</option>
      <option value="relax">Relax</option>
      <option value="static">Static (tight)</option>
      <option value="slab_relax">Slab Relax (IDIPOL+D3)</option>
      <option value="freq">Frequency</option>
      <option value="band">Band Structure</option>
      <option value="md">Molecular Dynamics</option>
    </select>
  </div>
{/if}
```

apply_preset 从后端 `/api/workflow/vasp-presets/{name}` 获取参数并填充到表单。

## 文件清单
- 修改: src/lib/workflow/NodeConfigPanel.svelte
```

---

## Prompt 34: 结构来源链 Lineage UI（P2）

```
请为结构来源链添加 UI 显示。

## 需求

在 NodeStatusPanel 中，当节点的 result_json 包含 _lineage 数组时，
显示一个面包屑导航：

```
TiO₂ bulk → Slab (110) → Fe doping → Geo Opt (VASP) → Freq → Free Energy
```

每一步显示为一个小标签，hover 显示时间戳。

```svelte
{#if cached_summary._lineage?.length}
  <div class="sp-section">
    <div class="sp-section-title">Structure History</div>
    <div class="sp-lineage">
      {#each cached_summary._lineage as step, i}
        <span class="sp-lineage-step" title={step.timestamp}>
          {step.action}
        </span>
        {#if i < cached_summary._lineage.length - 1}
          <span class="sp-lineage-arrow">→</span>
        {/if}
      {/each}
    </div>
  </div>
{/if}
```

## 文件清单
- 修改: src/lib/workflow/NodeStatusPanel.svelte
```

---

## Prompt 35: export_data 真实导出（P2）

```
请实现 export_data 节点的实际导出功能。

## 当前问题
export_data 在 local.py 中只是标记 completed，不做任何实际导出。

## 需求

根据 params.format 将父节点的结构/结果导出到指定格式：

```python
elif node_type == "export_data":
    export_format = params.get("format", "json")
    parent = step_results.get(parent_ids[0], {}) if parent_ids else {}

    if export_format == "json":
        import json
        step_results[step_id] = {
            "exported": True,
            "format": "json",
            "data": json.dumps(parent, default=str),
        }
    elif export_format == "csv":
        # 如果父节点有 entries（来自 energy_compare），导出为 CSV
        entries = parent.get("entries") or parent.get("summary", {}).get("entries", [])
        if entries:
            header = ",".join(entries[0].keys()) if entries else ""
            rows = [",".join(str(v) for v in e.values()) for e in entries]
            step_results[step_id] = {
                "exported": True,
                "format": "csv",
                "data": header + "\n" + "\n".join(rows),
            }
    elif export_format in ("cif", "poscar"):
        structure = parent.get("structure")
        if structure:
            step_results[step_id] = {
                "exported": True,
                "format": export_format,
                "structure": structure,
            }
```

## 文件清单
- 修改: server/workflow/engines/local.py
```

---

## Prompt 36: her_analysis 实现（P2）

```
请实现 her_analysis 节点，用于检查 NRR 催化剂的 HER 竞争反应选择性。

## 需求

HER 选择性分析：比较 *H 吸附自由能和 *N₂H 吸附自由能。
如果 |ΔG_H| < |ΔG_N₂H|，HER 更有利（催化剂对 NRR 选择性差）。

```python
elif node_type == "her_analysis":
    # Collect adsorption energies from parent results
    parent_results = {pid: step_results.get(pid, {}) for pid in parent_ids}

    # Find H and N2H adsorption energies
    dG_H = None
    dG_N2H = None
    for pid, result in parent_results.items():
        summary = result.get("summary", result)
        if summary.get("adsorbate") == "H":
            dG_H = summary.get("G") or summary.get("dG_ads")
        elif summary.get("adsorbate") in ("N2H", "NNH"):
            dG_N2H = summary.get("G") or summary.get("dG_ads")

    if dG_H is not None and dG_N2H is not None:
        her_favorable = abs(float(dG_H)) < abs(float(dG_N2H))
        analysis_result.update({
            "dG_H": float(dG_H),
            "dG_N2H": float(dG_N2H),
            "her_favorable": her_favorable,
            "selectivity": "HER" if her_favorable else "NRR",
            "selectivity_gap": abs(float(dG_N2H)) - abs(float(dG_H)),
        })
    else:
        analysis_result["error"] = "Missing H or N2H adsorption energy from parent nodes"
```

## 文件清单
- 修改: server/workflow/engines/analysis.py
- 修改: server/workflow/node_sets.py（确认 her_analysis 在 ANALYSIS_NODES 中）
```

---

## Prompt 37: auto-retry 状态在 NodeStatusPanel 显示（P1）

```
Prompt 15 实现了 not_converged 自动重跑，但用户在 NodeStatusPanel 中看不到重跑状态。

## 需求

在 NodeStatusPanel 中，当节点正在自动重跑时显示 continuation 信息：

```svelte
<!-- 在 status === 'running' 的状态区域附近 -->
{#if step_info?.error_message?.includes('Auto-continuing')}
  <div class="sp-section">
    <div class="sp-continuation-badge">
      Auto-continuing from CONTCAR...
    </div>
    <div class="sp-info-row">
      <span class="sp-info-label">Attempt</span>
      <span class="sp-info-value mono">
        {step_info.error_message.match(/\((\d+\/\d+)\)/)?.[1] ?? '?'}
      </span>
    </div>
  </div>
{/if}
```

error_message 的格式是 "Auto-continuing (1/3), CONTCAR → POSCAR"，从中提取 attempt 信息。

## 文件清单
- 修改: src/lib/workflow/NodeStatusPanel.svelte
```

---

## Prompt 38: CP2K error handler 集成到执行路径（P1）

```
Prompt 22 创建了 server/workflow/error_handlers/cp2k.py，但没有在 CP2K 执行路径中调用它。

## 需求

在 server/workflow/hpc_execute.py 的 _execute_hpc_node() 中，
当 CP2K 作业完成后（类似 VASP 的 convergence check），调用 CP2K 错误检查：

```python
# 在 Step 4 之前（job 完成后），为 CP2K 节点添加错误检查
if engine_key == "cp2k":
    from workflow.error_handlers.cp2k import check_cp2k_errors, apply_cp2k_fix

    error_info = await check_cp2k_errors(hpc, work_dir)
    if error_info and error_info.get("auto_fixable"):
        continuation_count = params.get("_continuation_count", 0)
        max_continuations = config.max_continuation_runs

        if continuation_count < max_continuations:
            logger.info("CP2K node %s: error '%s', applying fix and retrying",
                       node_id, error_info["error_name"])
            await apply_cp2k_fix(hpc, work_dir, error_info["fix"])
            params["_continuation_count"] = continuation_count + 1
            # Re-submit (similar to VASP auto-continue logic)
            ...
```

## 文件清单
- 修改: server/workflow/hpc_execute.py
```

---

## Prompt 39: 离线导出增加主动入口（P2）

```
Prompt 21 的离线导出只在后端不可用时作为 fallback 触发。用户无法主动选择使用前端导出。

## 需求

在 ExportPane.svelte（src/lib/structure/export/）中，为 POSCAR 和 XYZ 格式
添加一个 "Quick Export (no backend)" 按钮：

```svelte
<button class="quick-export-btn" onclick={quick_export_poscar}>
  Quick POSCAR (offline)
</button>
```

点击后直接调用 offline-serialize.ts 的 structure_to_poscar()，
不经过后端，直接下载文件。

这让用户在不启动后端的情况下也能导出结构。

## 文件清单
- 修改: src/lib/structure/ExportPane.svelte 或 src/lib/structure/export/VaspExport.svelte
```

---

## Phase 2 遗留问题追踪

以下是 Phase 2 每个 Prompt 的完整对账：

| Phase 2 | 后端代码 | 前端集成 | 遗留问题 | Phase 3 修复 |
|---------|---------|---------|---------|------------|
| P15: auto-retry | ✅ | ⚠️ 不显示重跑状态 | 用户不知道在重跑 | Prompt 37 |
| P16: pick_best | ✅ | ❌ 前端未注册 | 不能拖拽添加 | Prompt 27 |
| P17: batch_adsorbate | ✅ | ❌ 前端未注册 | 不能拖拽添加 | Prompt 27 |
| P18: VASP presets | ✅ | ❌ 没有下拉/与前端重复 | 不可见 | Prompt 32+33 |
| P19: fan-out | ✅ | ⚠️ 依赖 loop（空壳） | 实际不工作 | Prompt 25 |
| P20: tests | ✅ 12 pass | ✅ | — | — |
| P21: offline export | ✅ | ⚠️ 只是 fallback | 无主动入口 | Prompt 39 |
| P22: CP2K errors | ✅ 函数存在 | ❌ 没被调用 | 死代码 | Prompt 38 |
| P23: descriptors | ✅ | ❌ 结果不显示/重复 | 与 DOS session 重复 | Prompt 32 |
| P24: lineage | ✅ | ❌ 没有 UI | 不可见 | Prompt 34 |

---

## 执行顺序

```
P0 — 解锁核心功能:
Prompt 25 → condition/loop/merge 控制流      ← 最关键，解锁工作流模板
Prompt 26 → charge_analysis 修复            ← 防止运行时报错
Prompt 27 → 前端节点注册                    ← 用户能看到新节点
Prompt 28 → DiagnosticsPanel 接入           ← 用户能看到系统状态

P1 — 结果可见:
Prompt 29 → 催化结果显示                    ← 用户能看到计算结果
Prompt 30 → VolcanoPlot                     ← 催化筛选可视化
Prompt 31 → BatchStatusPanel 修复           ← 批量任务面板能渲染
Prompt 32 → 清理重复代码                    ← 代码卫生
Prompt 33 → VASP preset 选择器             ← 降低使用门槛
Prompt 37 → auto-retry 状态显示            ← 用户知道在重跑
Prompt 38 → CP2K error handler 集成        ← 修复死代码

P2 — 锦上添花:
Prompt 34 → Lineage UI                      ← 溯源可视化
Prompt 35 → export_data 实现               ← 数据导出
Prompt 36 → her_analysis 实现              ← NRR 选择性分析
Prompt 39 → 离线导出主动入口              ← 不需要后端的导出
```

每个 Prompt 完成后：commit → 验证 → 下一个。
