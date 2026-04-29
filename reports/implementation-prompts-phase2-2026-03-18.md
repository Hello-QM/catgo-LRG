# 实施 Prompts Phase 2：弥补差距

**日期:** 2026-03-18
**分支:** `CatGo-PRO`
**前置:** Phase 1 的 14 个 Prompt 已全部完成
**目标:** 补齐与 atomate2/jobflow 的核心差距 + 完善高通量催化筛选闭环

## 实施状态

| # | 功能 | 优先级 | 状态 | Commit |
|---|------|--------|------|--------|
| 15 | not_converged 自动重跑 | P0 | ✅ | `5feff56` |
| 16 | 多结构汇聚节点 | P1 | ✅ | `0a1d99b` |
| 17 | 批量吸附物放置 | P1 | ✅ | `4825848` |
| 18 | DFT 输入生成预设 (VASP best-practice) | P1 | ✅ | `5e7b65f` |
| 19 | 动态扇出 (fan-out) | P1 | ✅ | `4c49950` |
| 20 | 测试覆盖 — 催化分析 + Batch + 参数检测 | P1 | ✅ | `85051d6` |
| 21 | 前端离线 POSCAR/XYZ 导出 | P1 | ✅ | `a82973e` |
| 22 | Custodian 扩展到 CP2K | P2 | ✅ | `672572d` |
| 23 | d-band center 描述符提取 | P2 | ✅ | `1b4e25e` |
| 24 | 结构来源链 (_lineage) | P2 | ✅ | `4c49950` |

---

## Prompt 15: not_converged 自动重跑（P0 — 动态工作流第一步）

```
请在 HPC 节点执行完成后增加自动重跑逻辑：如果 VASP relaxation 未收敛，自动用 CONTCAR 作为输入重新提交。

## 需求

1. 在 server/workflow/hpc_execute.py 的 _execute_hpc_node() 中，Step 4 (job 完成后) 添加收敛检查：
   - 读取 work_dir 中的 OUTCAR 检查收敛标志
   - 如果未收敛 + retry_count < max_continuation_runs：
     - 将 CONTCAR 复制为新提交的 POSCAR
     - 可选：NSW 翻倍
     - 重新提交 job（递归或循环）
   - 如果已达最大重试次数：标记 status="not_converged"

2. 在 WorkflowRunConfig (server/models/workflow_run.py) 中增加参数：
   - auto_continue_on_not_converged: bool = True
   - max_continuation_runs: int = 3
   - nsw_multiplier: float = 1.5  # 每次重试 NSW 乘以此系数

## 参考代码

在 hpc_execute.py Step 4 之前（约 line 300），插入：

```python
# --- Auto-continue on not_converged (like atomate2 Response(detour)) ---
# Check if VASP relaxation converged by parsing OUTCAR
if node_type in ("geo_opt", "vasp_relax", "bulk_opt", "slab_relax"):
    converged = await _check_vasp_convergence(hpc, work_dir)
    continuation_count = params.get("_continuation_count", 0)
    max_continuations = config.max_continuation_runs if hasattr(config, 'max_continuation_runs') else 3

    if not converged and continuation_count < max_continuations:
        logger.info(
            "HPC node %s/%s: not converged (attempt %d/%d), auto-continuing from CONTCAR",
            workflow_id, node_id, continuation_count + 1, max_continuations,
        )
        # Copy CONTCAR → POSCAR for continuation
        await hpc.conn.run(f"cp {work_dir}/CONTCAR {work_dir}/POSCAR", check=True)

        # Optionally increase NSW
        nsw_mult = getattr(config, 'nsw_multiplier', 1.5)
        if nsw_mult > 1.0:
            current_nsw = params.get("nsw", 100)
            new_nsw = int(current_nsw * nsw_mult)
            # 用 sed 替换 INCAR 中的 NSW（如果存在）
            await hpc.conn.run(
                f"sed -i 's/NSW *= *[0-9]*/NSW = {new_nsw}/' {work_dir}/INCAR",
                check=False,
            )

        # Update continuation counter
        params["_continuation_count"] = continuation_count + 1
        update_step(workflow_id, node_id, {
            "error_message": f"Auto-continuing ({continuation_count + 1}/{max_continuations}), CONTCAR → POSCAR",
        })
        await _broadcast(workflow_id, {
            "type": "step_status", "step_id": node_id,
            "status": "running",
            "message": f"Auto-continuing from CONTCAR (attempt {continuation_count + 2})...",
        })

        # Re-submit job (reuse same work_dir, POSCAR is now CONTCAR)
        # ... 复用 Step 2 的提交逻辑，重新 sbatch ...
        # 最简单的方式：递归调用或 goto 回 Step 2

async def _check_vasp_convergence(hpc, work_dir: str) -> bool:
    """Check if VASP relaxation converged by parsing OUTCAR tail.

    Looks for 'reached required accuracy' in the last 50 lines.
    Returns True if converged, False otherwise.
    """
    try:
        result = await hpc.conn.run(
            f"tail -50 {work_dir}/OUTCAR | grep -c 'reached required accuracy'",
            check=False,
        )
        return int(result.stdout.strip() or "0") > 0
    except Exception:
        return False  # Cannot determine — assume not converged
```

## WorkflowRunConfig 扩展

在 server/models/workflow_run.py 的 WorkflowRunConfig 中增加：

```python
auto_continue_on_not_converged: bool = Field(
    default=True,
    description="Auto-continue relaxation from CONTCAR if not converged"
)
max_continuation_runs: int = Field(
    default=3, ge=0, le=10,
    description="Maximum continuation attempts for non-converged relaxations"
)
nsw_multiplier: float = Field(
    default=1.5, ge=1.0, le=5.0,
    description="Multiply NSW by this factor on each continuation"
)
```

## 文件清单
- 修改: server/workflow/hpc_execute.py（收敛检查 + 自动重跑）
- 修改: server/models/workflow_run.py（新参数）

## 验证
```bash
cd server && python -c "from workflow.hpc_execute import _check_vasp_convergence; print('OK')"
cd server && python -c "from models.workflow_run import WorkflowRunConfig; c = WorkflowRunConfig(); print(f'auto_continue={c.auto_continue_on_not_converged}, max={c.max_continuation_runs}')"
```
```

---

## Prompt 16: 多结构汇聚节点

```
请增强 analysis 引擎的 energy_compare 节点，使其能真正聚合多个父节点的结果并排序。

## 需求

1. 修改 server/workflow/engines/analysis.py 的 energy_compare handler：
   - 从所有父节点收集 final_energy（不只是第一个）
   - 按能量排序，标记最优结构
   - 结果包含排名表

2. 新增 pick_best analysis 节点类型：
   - 从多个父节点中选择能量最低的结构
   - 将最优结构传递给下游节点

3. 在 node_sets.py 的 ANALYSIS_NODES 中注册新节点

## 参考实现

```python
# server/workflow/engines/analysis.py

elif node_type == "energy_compare":
    # 聚合所有父节点的能量结果
    entries = []
    for pid in parent_ids:
        parent = step_results.get(pid, {})
        energy = (
            parent.get("final_energy")
            or parent.get("summary", {}).get("energy_eh")
            or parent.get("summary", {}).get("final_energy")
        )
        structure = parent.get("structure")
        if energy is not None:
            entries.append({
                "step_id": pid,
                "energy_eV": float(energy),
                "structure": structure,
                "label": parent.get("node_type", pid),
            })

    # 按能量排序（最低 = 最稳定）
    entries.sort(key=lambda e: e["energy_eV"])
    for rank, entry in enumerate(entries):
        entry["rank"] = rank + 1

    if entries:
        best = entries[0]
        ref_energy = best["energy_eV"]
        for entry in entries:
            entry["relative_eV"] = entry["energy_eV"] - ref_energy
            entry["relative_meV_per_atom"] = (
                (entry["energy_eV"] - ref_energy) * 1000
                / max(entry.get("n_atoms", 1), 1)
            )

    analysis_result.update({
        "entries": entries,
        "best_step_id": entries[0]["step_id"] if entries else None,
        "n_compared": len(entries),
    })

elif node_type == "pick_best":
    # 选择能量最低的结构，传递给下游
    best_energy = float("inf")
    best_parent = None
    for pid in parent_ids:
        parent = step_results.get(pid, {})
        energy = parent.get("final_energy") or parent.get("summary", {}).get("energy_eh")
        if energy is not None and float(energy) < best_energy:
            best_energy = float(energy)
            best_parent = pid

    if best_parent:
        # 将最优结构传递给下游
        best_result = step_results[best_parent]
        analysis_result.update({
            "best_step_id": best_parent,
            "best_energy_eV": best_energy,
            "structure": best_result.get("structure"),
        })
    else:
        analysis_result["error"] = "No valid energies found in parent nodes"
```

## node_sets.py 注册

```python
ANALYSIS_NODES = {
    "dos_analysis", "cohp_analysis", "md_analysis",
    "convergence_check", "energy_compare",
    "pick_best",  # 新增
}
```

analysis.py 装饰器增加:
```python
@register_node("pick_best", engine="analysis", category="analysis")
```

## 文件清单
- 修改: server/workflow/engines/analysis.py（增强 energy_compare + 新增 pick_best）
- 修改: server/workflow/node_sets.py（注册 pick_best）

## 验证
```bash
cd server && python -c "
from workflow.engines.analysis import execute_analysis_node
print('OK')
"
```
```

---

## Prompt 17: 批量吸附物放置

```
请新增 batch_adsorbate_place 节点类型，支持对多个结构批量放置吸附物。

## 需求

1. 新建 server/workflow/engines/batch_adsorbate.py
2. 接收一组父结构（从 Batch Node 或多个 geo_opt 输出）
3. 对每个结构自动寻找吸附位点并放置指定吸附物
4. 输出所有 slab+adsorbate 结构列表，供下游 Batch Node 使用

## 参考实现

```python
"""Batch adsorbate placement for high-throughput catalyst screening."""

import logging
from typing import Any

logger = logging.getLogger(__name__)


async def execute_batch_adsorbate_node(
    workflow_id: str,
    step_id: str,
    node_type: str,
    params: dict[str, Any],
    edges: list[dict],
    step_results: dict[str, dict],
    config: Any,
    _broadcast_fn: Any,
    _get_parent_step_ids_fn: Any,
):
    """Place adsorbates on multiple slab structures for screening.

    Supports OER intermediates (*OH, *O, *OOH) and custom adsorbates.
    Finds adsorption sites using pymatgen AdsorbateSiteFinder.
    """
    from utils.workflow_db import update_step
    update_step(workflow_id, step_id, {"status": "running"})

    parent_ids = _get_parent_step_ids_fn(step_id, edges)
    adsorbates = params.get("adsorbates", ["OH"])  # 默认 OER 中间体
    site_strategy = params.get("site_strategy", "all")  # "all", "ontop", "bridge", "hollow"
    max_sites_per_struct = params.get("max_sites_per_struct", 1)  # 每个结构最多几个位点

    all_placed = []
    for pid in parent_ids:
        parent = step_results.get(pid, {})
        # 支持 batch 结果（多个结构）和单结构
        structures = parent.get("structures", [])
        if not structures and parent.get("structure"):
            structures = [parent["structure"]]

        for struct_idx, struct in enumerate(structures):
            for ads_name in adsorbates:
                placed = _place_adsorbate(struct, ads_name, site_strategy, max_sites_per_struct)
                for site_idx, placed_struct in enumerate(placed):
                    all_placed.append({
                        "structure": placed_struct,
                        "parent_step": pid,
                        "parent_index": struct_idx,
                        "adsorbate": ads_name,
                        "site_index": site_idx,
                        "label": f"{pid}_{struct_idx}_{ads_name}_{site_idx}",
                    })

    step_results[step_id] = {
        "structures": [p["structure"] for p in all_placed],
        "placement_info": all_placed,
        "n_placed": len(all_placed),
    }

    logger.info(
        "Batch adsorbate placement: %d structures × %d adsorbates → %d placed structures",
        sum(1 for _ in parent_ids), len(adsorbates), len(all_placed),
    )


def _place_adsorbate(structure_dict, adsorbate_name: str, strategy: str, max_sites: int) -> list:
    """Place an adsorbate on a slab structure using pymatgen.

    Args:
        structure_dict: pymatgen-compatible structure dict.
        adsorbate_name: Name like "OH", "O", "OOH", "H", "COOH", "CO".
        strategy: Site finding strategy.
        max_sites: Maximum number of sites to generate.

    Returns:
        List of structure dicts with adsorbate placed.
    """
    try:
        from pymatgen.core import Structure, Molecule
        from pymatgen.analysis.adsorption import AdsorbateSiteFinder

        slab = Structure.from_dict(structure_dict)
        asf = AdsorbateSiteFinder(slab)

        # Common adsorbate molecules
        ADSORBATES = {
            "OH": Molecule(["O", "H"], [[0, 0, 0], [0, 0, 0.96]]),
            "O": Molecule(["O"], [[0, 0, 0]]),
            "OOH": Molecule(["O", "O", "H"], [[0, 0, 0], [1.28, 0, 0.7], [1.28, 0.8, 1.2]]),
            "H": Molecule(["H"], [[0, 0, 0]]),
            "H2O": Molecule(["O", "H", "H"], [[0, 0, 0], [0.76, 0.59, 0], [-0.76, 0.59, 0]]),
            "COOH": Molecule(["C", "O", "O", "H"], [[0,0,0], [1.2,0,0], [-0.4,1.1,0], [-0.4,1.7,0.8]]),
            "CO": Molecule(["C", "O"], [[0, 0, 0], [0, 0, 1.13]]),
        }

        ads_mol = ADSORBATES.get(adsorbate_name)
        if ads_mol is None:
            logger.warning("Unknown adsorbate: %s, skipping", adsorbate_name)
            return []

        placed_slabs = asf.generate_adsorption_structures(ads_mol, repeat=[1, 1, 1])
        # Limit to max_sites
        result = [s.as_dict() for s in placed_slabs[:max_sites]]
        return result

    except Exception as e:
        logger.warning("Adsorbate placement failed: %s", e)
        return []
```

## 注册到 node_sets.py

```python
# 在 LOCAL_NODES 中增加
"batch_adsorbate_place",
```

在 node_dispatch.py 的 _execute_node 中增加分支:
```python
elif node_type == "batch_adsorbate_place":
    from workflow.engines.batch_adsorbate import execute_batch_adsorbate_node
    await execute_batch_adsorbate_node(...)
```

## 文件清单
- 新建: server/workflow/engines/batch_adsorbate.py
- 修改: server/workflow/node_sets.py（注册）
- 修改: server/workflow/node_dispatch.py（dispatch 分支）

## 验证
```bash
cd server && python -c "from workflow.engines.batch_adsorbate import execute_batch_adsorbate_node; print('OK')"
```
```

---

## Prompt 18: DFT 输入生成预设 (VASP best-practice defaults)

```
请新建 server/workflow/presets/ 模块，提供类似 atomate2 Maker 的 "开箱即用" INCAR 预设。

## 需求

1. 新建 server/workflow/presets/__init__.py
2. 新建 server/workflow/presets/vasp.py — VASP 计算预设
3. 在 VASP 输入生成时（server/workflow/engines/vasp.py），如果用户没有自定义 INCAR 参数，自动应用预设

## 参考实现

```python
# server/workflow/presets/vasp.py
"""VASP calculation presets inspired by atomate2 Makers.

Each preset provides sensible INCAR defaults for common calculation types.
Users can override any parameter through the workflow editor.
"""

# -- Relax preset (GGA-PBE, for bulk/slab relaxation) --
RELAX_PRESET = {
    "ALGO": "Normal",
    "EDIFF": 1e-5,         # eV — electronic convergence
    "EDIFFG": -0.02,       # eV/Å — force convergence (negative = force-based)
    "ENCUT": 520,           # eV — plane-wave cutoff (1.3× max ENMAX in POTCAR)
    "IBRION": 2,            # Conjugate gradient
    "ISIF": 3,              # Relax ions + cell shape + volume
    "ISMEAR": 0,            # Gaussian smearing (safe for all systems)
    "SIGMA": 0.05,          # eV — smearing width
    "NSW": 200,             # Max ionic steps
    "PREC": "Accurate",
    "LREAL": "Auto",        # Real-space projection (Auto for >20 atoms)
    "LORBIT": 11,           # Write DOSCAR + lm-decomposed
    "LWAVE": False,         # Don't write WAVECAR (save disk)
    "LCHARG": False,        # Don't write CHGCAR
    "NCORE": 4,             # Parallelization (adjust per cluster)
    "KSPACING": 0.3,        # Å⁻¹ — automatic k-mesh (~= 4×4×4 for typical cell)
}

# -- Static preset (single-point energy, tighter convergence) --
STATIC_PRESET = {
    **RELAX_PRESET,
    "NSW": 0,               # No ionic relaxation
    "IBRION": -1,
    "ISIF": 2,              # Only calculate stress
    "EDIFF": 1e-6,          # Tighter electronic convergence
    "ISMEAR": -5,           # Tetrahedron method (accurate for DOS)
    "LWAVE": True,          # Write WAVECAR for subsequent freq/DOS
    "LCHARG": True,         # Write CHGCAR for charge analysis
    "LAECHG": True,         # Write AECCAR for Bader analysis
}

# -- Slab relax preset (fixed bottom layers, dipole correction) --
SLAB_RELAX_PRESET = {
    **RELAX_PRESET,
    "ISIF": 2,              # Relax ions only (not cell)
    "IDIPOL": 3,            # Dipole correction along z
    "LDIPOL": True,
    "IVDW": 12,             # DFT-D3(BJ) van der Waals correction
    "EDIFFG": -0.03,        # Slightly looser for slabs
}

# -- Frequency preset (finite differences for ZPE/entropy) --
FREQ_PRESET = {
    **STATIC_PRESET,
    "IBRION": 5,            # Finite differences
    "POTIM": 0.015,         # Å — displacement magnitude
    "NFREE": 2,             # Central differences (more accurate)
    "NSW": 1,               # Required for IBRION=5
    "EDIFF": 1e-7,          # Very tight for accurate forces
    "LWAVE": False,
    "LCHARG": False,
}

# -- Band structure preset --
BAND_PRESET = {
    **STATIC_PRESET,
    "ICHARG": 11,           # Read CHGCAR, non-self-consistent
    "ISMEAR": 0,            # Gaussian for band structure
    "LORBIT": 11,
    "LWAVE": False,
}

# -- MD preset (ab initio molecular dynamics) --
MD_PRESET = {
    **RELAX_PRESET,
    "IBRION": 0,            # Molecular dynamics
    "POTIM": 1.0,           # fs — timestep
    "NSW": 5000,            # MD steps
    "SMASS": -1,            # NVE ensemble (-1 = NVE, 0 = NVT Nosé-Hoover)
    "TEBEG": 300,           # K — initial temperature
    "TEEND": 300,           # K — final temperature
    "ISIF": 2,              # No cell relaxation during MD
    "ALGO": "VeryFast",     # Faster for MD
    "EDIFF": 1e-4,          # Looser for MD
    "LWAVE": False,
    "LCHARG": False,
}

PRESETS = {
    "relax": RELAX_PRESET,
    "static": STATIC_PRESET,
    "slab_relax": SLAB_RELAX_PRESET,
    "freq": FREQ_PRESET,
    "band": BAND_PRESET,
    "md": MD_PRESET,
}

def get_preset(calc_type: str) -> dict:
    """Get INCAR preset for a calculation type.

    Args:
        calc_type: "relax", "static", "slab_relax", "freq", "band", "md"

    Returns:
        Dict of INCAR parameters. Empty dict if no preset found.
    """
    return dict(PRESETS.get(calc_type, {}))

def apply_preset(calc_type: str, user_params: dict) -> dict:
    """Merge preset defaults with user overrides.

    User parameters always take precedence over presets.
    """
    preset = get_preset(calc_type)
    preset.update(user_params)  # User overrides win
    return preset
```

## VASP 输入生成集成

在 server/workflow/engines/vasp.py 的输入生成函数中：

```python
from workflow.presets.vasp import apply_preset

def generate_vasp_inputs(node_type, params, structure, ...):
    # 根据 node_type 确定计算类型
    calc_type_map = {
        "geo_opt": "relax", "vasp_relax": "relax", "bulk_opt": "relax",
        "slab_relax": "slab_relax",
        "single_point": "static", "vasp_static": "static",
        "freq": "freq",
        "band_structure": "band",
        "vasp_md": "md",
    }
    calc_type = calc_type_map.get(node_type, "relax")

    # 应用预设 + 用户覆盖
    incar_params = apply_preset(calc_type, params.get("incar", {}))
    # ... 写入 INCAR ...
```

## 文件清单
- 新建: server/workflow/presets/__init__.py
- 新建: server/workflow/presets/vasp.py
- 修改: server/workflow/engines/vasp.py（集成预设）

## 验证
```bash
cd server && python -c "
from workflow.presets.vasp import apply_preset
params = apply_preset('slab_relax', {'ENCUT': 600})
print(f'ENCUT={params[\"ENCUT\"]}, IDIPOL={params[\"IDIPOL\"]}, IVDW={params[\"IVDW\"]}')
# 应输出: ENCUT=600, IDIPOL=3, IVDW=12
"
```
```

---

## Prompt 19: 动态扇出 (fan-out)

```
请实现工作流节点的动态扇出能力：一个节点生成多个结构后，自动为每个结构创建下游子任务。

## 需求

这是 CatGo 与 jobflow Response(replace) 对标的核心特性。

1. 在 step_results 中支持 `_fan_out` 标记：
   ```python
   step_results[node_id] = {
       "structures": [struct1, struct2, struct3],
       "_fan_out": True,
   }
   ```

2. 在 orchestrator.py 的 _run_workflow 中，layer 执行完后检查 _fan_out：
   - 如果某个节点标记了 _fan_out，为每个 structure 创建一个虚拟子节点
   - 子节点继承父节点的下游边
   - 子节点使用 Batch Node 执行（不创建真正的 DAG 节点，而是用 batch_subtasks）

3. slab_gen 节点在生成多个 slab 时设置 _fan_out=True

## 实现方式

最简单的方式：**不修改 DAG 结构**，而是让下游节点自动处理多结构输入。

```python
# server/workflow/orchestrator.py — 在 layer 执行后

for node_id in task_node_ids:
    result = step_results.get(node_id, {})
    if result.get("_fan_out") and result.get("structures"):
        # 将多结构包装为 batch 输入给下游节点
        n_structures = len(result["structures"])
        logger.info(
            "Node %s produced %d structures (fan-out), downstream will batch-execute",
            node_id, n_structures,
        )
        # 下游节点在 _execute_node 中检查父节点是否有多结构
        # 如果是，自动切换到 batch 执行模式
```

在 node_dispatch.py 的 HPC 执行路径中：
```python
# 检查父节点是否有多结构（fan-out 场景）
parent_structures = _get_parent_structures_list(node_id, edges, step_results)
if len(parent_structures) > 1:
    # 自动切换到 batch 执行
    from workflow.batch_execute import execute_batch_hpc
    await execute_batch_hpc(
        workflow_id, node_id, node_type, parent_structures, params, config, hpc
    )
else:
    # 单结构正常执行
    await _execute_hpc_node(...)
```

## 辅助函数

```python
def _get_parent_structures_list(node_id, edges, step_results) -> list:
    """Get all structures from parent nodes.

    If a parent has _fan_out with multiple structures, expand them all.
    Otherwise return the single parent structure.
    """
    parent_ids = _get_parent_ids(node_id, edges)
    structures = []
    for pid in parent_ids:
        parent = step_results.get(pid, {})
        if parent.get("_fan_out") and parent.get("structures"):
            structures.extend(parent["structures"])
        elif parent.get("structure"):
            structures.append(parent["structure"])
    return structures
```

## 文件清单
- 修改: server/workflow/node_dispatch.py（多结构检测 + batch 分派）
- 修改: server/workflow/engines/local.py（slab_gen 输出 _fan_out）

## 验证
```bash
cd server && python -c "from workflow.node_dispatch import _get_parent_structures_list; print('OK')"
```
```

---

## Prompt 20: 测试覆盖 — 催化分析 + Batch + 参数检测

```
请为 Phase 1 和 Phase 2 新增的功能编写自动化测试。

## 需求

新建以下测试文件：

### 1. server/tests/test_catalysis.py

```python
"""Tests for catalysis analysis module."""
import pytest

def test_gibbs_free_energy_basic():
    from workflow.catalysis.free_energy import gibbs_free_energy
    result = gibbs_free_energy(e_dft=-45.0, frequencies_cm=[3600, 1500, 500])
    assert result["E_DFT"] == -45.0
    assert result["ZPE"] > 0  # ZPE should be positive
    assert result["G"] < result["E_DFT"]  # G < E_DFT (ZPE - TS net negative for most systems)
    assert result["temperature"] == 298.15

def test_gibbs_ignores_imaginary_frequencies():
    from workflow.catalysis.free_energy import compute_zpe
    zpe_with_imag = compute_zpe([-200, 100, 3600])
    zpe_without = compute_zpe([100, 3600])
    assert zpe_with_imag == zpe_without  # Imaginary freq ignored

def test_oer_overpotential():
    from workflow.catalysis.oer import compute_oer_overpotential
    result = compute_oer_overpotential(dG_OH=1.0, dG_O=2.5, dG_OOH=4.2)
    assert result["overpotential"] > 0
    assert 1 <= result["limiting_step"] <= 4
    assert len(result["step_energies"]) == 4
    # Step 4: 4.92 - 4.2 = 0.72, which is < 1.23 → not limiting
    # Step 3: 4.2 - 2.5 = 1.7, which is > 1.23 → limiting
    assert result["limiting_step"] == 3

def test_oer_ideal_catalyst():
    """An ideal catalyst has η ≈ 0."""
    from workflow.catalysis.oer import compute_oer_overpotential
    # At the ideal point: all steps = 1.23 eV
    result = compute_oer_overpotential(dG_OH=1.23, dG_O=2.46, dG_OOH=3.69)
    assert result["overpotential"] == pytest.approx(0.0, abs=0.01)

def test_co2rr_limiting_potential():
    from workflow.catalysis.co2rr import compute_co2rr_limiting_potential
    result = compute_co2rr_limiting_potential(dG_COOH=0.5, dG_CO=-0.3)
    assert "limiting_potential" in result
    assert result["pathway"] == "CO"
    assert len(result["step_energies"]) == 3

def test_nrr_overpotential():
    from workflow.catalysis.nrr import compute_nrr_overpotential
    result = compute_nrr_overpotential(dG_N2H=0.5)
    assert result["overpotential"] >= 0

def test_volcano_data_generation():
    from workflow.catalysis.volcano import generate_volcano_data
    data = generate_volcano_data([
        {"name": "A", "dG_OH": 1.0, "overpotential": 0.37},
        {"name": "B", "dG_OH": 1.5, "overpotential": 0.27},
    ], reaction="OER")
    assert len(data["points"]) == 2
    assert data["ideal_line"] is not None
    assert len(data["ideal_line"]["x"]) == 100

def test_scaling_relation():
    from workflow.catalysis.oer import estimate_dG_OOH_from_scaling
    # dG_OOH ≈ 0.84 * dG_OH + 3.29
    assert estimate_dG_OOH_from_scaling(1.0) == pytest.approx(4.13, abs=0.01)
```

### 2. server/tests/test_batch_db.py

```python
"""Tests for batch subtask database operations."""
import pytest

@pytest.fixture
def batch_setup():
    from utils.batch_db import ensure_batch_tables, insert_subtasks_batch
    ensure_batch_tables()
    wf_id = "test-wf-batch"
    step_id = "test-step-batch"
    return wf_id, step_id

def test_insert_and_summary(batch_setup):
    from utils.batch_db import insert_subtasks_batch, get_batch_summary
    wf_id, step_id = batch_setup
    insert_subtasks_batch(wf_id, step_id, 100)
    summary = get_batch_summary(wf_id, step_id)
    assert summary["total"] == 100
    assert summary["pending"] == 100
    assert summary["completed"] == 0

def test_update_statuses(batch_setup):
    from utils.batch_db import (insert_subtasks_batch, update_subtask_statuses,
                                 get_batch_summary)
    wf_id, step_id = batch_setup
    insert_subtasks_batch(wf_id, step_id, 10)
    update_subtask_statuses(wf_id, step_id, {0: "COMPLETED", 1: "FAILED", 2: "RUNNING"})
    summary = get_batch_summary(wf_id, step_id)
    assert summary["completed"] >= 1
    assert summary["failed"] >= 1

def test_pagination(batch_setup):
    from utils.batch_db import insert_subtasks_batch, get_batch_results_page
    wf_id, step_id = batch_setup
    insert_subtasks_batch(wf_id, step_id, 200)
    page = get_batch_results_page(wf_id, step_id, page=1, per_page=50)
    assert len(page["items"]) == 50
    assert page["total"] == 200

def test_failed_indices(batch_setup):
    from utils.batch_db import (insert_subtasks_batch, update_subtask_statuses,
                                 get_failed_subtask_indices)
    wf_id, step_id = batch_setup
    insert_subtasks_batch(wf_id, step_id, 5)
    update_subtask_statuses(wf_id, step_id, {1: "FAILED", 3: "FAILED"})
    failed = get_failed_subtask_indices(wf_id, step_id)
    assert set(failed) == {1, 3}
```

### 3. server/tests/test_param_detection.py

```python
"""Tests for parameter change detection on resume."""
import pytest

def test_params_hash_deterministic():
    from workflow.orchestrator import _compute_params_hash
    h1 = _compute_params_hash({"ENCUT": 520, "EDIFF": 1e-5})
    h2 = _compute_params_hash({"EDIFF": 1e-5, "ENCUT": 520})  # different key order
    assert h1 == h2  # sort_keys=True makes it deterministic

def test_params_hash_changes():
    from workflow.orchestrator import _compute_params_hash
    h1 = _compute_params_hash({"ENCUT": 520})
    h2 = _compute_params_hash({"ENCUT": 600})
    assert h1 != h2

def test_get_descendants():
    from workflow.orchestrator import _get_descendants
    edges = [
        {"source": "A", "target": "B"},
        {"source": "B", "target": "C"},
        {"source": "B", "target": "D"},
        {"source": "C", "target": "E"},
    ]
    desc = _get_descendants("B", edges)
    assert desc == {"C", "D", "E"}

def test_get_descendants_no_children():
    from workflow.orchestrator import _get_descendants
    edges = [{"source": "A", "target": "B"}]
    desc = _get_descendants("B", edges)
    assert desc == set()
```

## 文件清单
- 新建: server/tests/test_catalysis.py
- 新建: server/tests/test_batch_db.py
- 新建: server/tests/test_param_detection.py

## 验证
```bash
cd server && python -m pytest tests/test_catalysis.py tests/test_param_detection.py -v
```
```

---

## Prompt 21: 前端离线 POSCAR/XYZ 导出

```
请在前端实现纯 JS 的 POSCAR 和 XYZ 格式序列化，使离线时也能导出结构。

## 需求

1. 新建 src/lib/structure/export/offline-serialize.ts
2. 实现 structure_to_poscar(structure) 和 structure_to_xyz(structure)
3. 在导出 UI 中检测 backend 是否可用，不可用时 fallback 到前端序列化

## 参考实现

```typescript
// src/lib/structure/export/offline-serialize.ts

interface Site {
  species: { element: string; oxidation_state?: number }[]
  xyz: [number, number, number]
  abc?: [number, number, number]
}

interface StructureData {
  lattice?: { matrix: number[][] }
  sites: Site[]
  charge?: number
}

/**
 * Serialize a structure to VASP POSCAR format (pure frontend, no backend needed).
 *
 * POSCAR format:
 * Line 1: Comment
 * Line 2: Scale factor
 * Lines 3-5: Lattice vectors
 * Line 6: Element symbols
 * Line 7: Element counts
 * Line 8: "Direct" or "Cartesian"
 * Lines 9+: Fractional or Cartesian coordinates
 */
export function structure_to_poscar(structure: StructureData, comment = "CatGo export"): string {
  if (!structure.lattice?.matrix) {
    throw new Error("POSCAR requires a lattice (periodic structure)")
  }

  const lines: string[] = [comment, "1.0"]

  // Lattice vectors
  for (const row of structure.lattice.matrix) {
    lines.push(`  ${row.map(v => v.toFixed(10).padStart(16)).join("")}`)
  }

  // Count elements (preserving order of first appearance)
  const element_order: string[] = []
  const element_counts: Record<string, number> = {}
  for (const site of structure.sites) {
    const el = site.species[0]?.element || "X"
    if (!(el in element_counts)) {
      element_order.push(el)
      element_counts[el] = 0
    }
    element_counts[el]++
  }

  lines.push(element_order.join("  "))
  lines.push(element_order.map(el => element_counts[el]).join("  "))
  lines.push("Direct")

  // Group sites by element, output fractional coords
  const inv = mat3_inverse(structure.lattice.matrix)
  for (const el of element_order) {
    for (const site of structure.sites) {
      if ((site.species[0]?.element || "X") !== el) continue
      const frac = site.abc || cart_to_frac(site.xyz, inv)
      lines.push(`  ${frac.map(v => v.toFixed(10).padStart(16)).join("")}`)
    }
  }

  return lines.join("\n") + "\n"
}

/**
 * Serialize a structure to XYZ format (pure frontend).
 */
export function structure_to_xyz(structure: StructureData, comment = "CatGo export"): string {
  const lines: string[] = [
    String(structure.sites.length),
    comment,
  ]
  for (const site of structure.sites) {
    const el = site.species[0]?.element || "X"
    const [x, y, z] = site.xyz
    lines.push(`${el.padEnd(4)} ${x.toFixed(8).padStart(14)} ${y.toFixed(8).padStart(14)} ${z.toFixed(8).padStart(14)}`)
  }
  return lines.join("\n") + "\n"
}

function mat3_inverse(m: number[][]): number[][] {
  const [[a,b,c],[d,e,f],[g,h,i]] = m
  const det = a*(e*i-f*h) - b*(d*i-f*g) + c*(d*h-e*g)
  if (Math.abs(det) < 1e-15) throw new Error("Singular lattice matrix")
  const inv_det = 1/det
  return [
    [(e*i-f*h)*inv_det, (c*h-b*i)*inv_det, (b*f-c*e)*inv_det],
    [(f*g-d*i)*inv_det, (a*i-c*g)*inv_det, (c*d-a*f)*inv_det],
    [(d*h-e*g)*inv_det, (b*g-a*h)*inv_det, (a*e-b*d)*inv_det],
  ]
}

function cart_to_frac(xyz: [number,number,number], inv: number[][]): [number,number,number] {
  return [
    xyz[0]*inv[0][0] + xyz[1]*inv[1][0] + xyz[2]*inv[2][0],
    xyz[0]*inv[0][1] + xyz[1]*inv[1][1] + xyz[2]*inv[2][1],
    xyz[0]*inv[0][2] + xyz[1]*inv[1][2] + xyz[2]*inv[2][2],
  ]
}
```

## 集成到导出 UI

在 VaspExport.svelte 中:
```typescript
import { structure_to_poscar } from './offline-serialize'

// 在 backend 不可用时 fallback
async function export_poscar() {
  try {
    // 先尝试 backend
    const res = await fetch(`${API_BASE}/workflow/files/serialize-structure`, { ... })
    if (res.ok) return await res.text()
  } catch { /* backend unavailable */ }
  // Fallback: 前端纯 JS 序列化
  return structure_to_poscar(current_structure)
}
```

## 文件清单
- 新建: src/lib/structure/export/offline-serialize.ts
- 修改: src/lib/structure/export/VaspExport.svelte（fallback 集成）

## 验证
pnpm check 通过即可。
```

---

## Prompt 22: Custodian 扩展到 CP2K

```
请为 CP2K 计算添加基本的错误处理器，类似 VASP 的 Custodian 集成。

## 需求

由于 Custodian 的 CP2K handler 不成熟，我们自实现一个轻量级的 CP2K 错误检测 + 修复机制。

1. 新建 server/workflow/error_handlers/cp2k.py
2. 在 CP2K 作业完成后检查常见错误并自动修复

## 参考实现

```python
"""CP2K error detection and auto-correction.

Unlike VASP (which uses Custodian), CP2K error handling is built-in
since custodian's CP2K support is minimal.
"""

import logging
import re

logger = logging.getLogger(__name__)

# Common CP2K errors and their fixes
CP2K_ERROR_HANDLERS = [
    {
        "name": "scf_not_converged",
        "pattern": r"SCF run NOT converged",
        "fix": {"OUTER_SCF_MAX_SCF": "+5", "EPS_SCF": "*10"},
        "description": "SCF did not converge — increase max steps and loosen threshold",
    },
    {
        "name": "basis_set_error",
        "pattern": r"basis set .* not found",
        "fix": None,  # Cannot auto-fix — needs user intervention
        "description": "Basis set not found — check BASIS_SET_FILE_NAME",
    },
    {
        "name": "oom",
        "pattern": r"Out of memory|SIGKILL|signal 9",
        "fix": {"PREFERRED_DIAG_LIBRARY": "ScaLAPACK"},
        "description": "Out of memory — switch diagonalization library",
    },
    {
        "name": "geometry_not_converged",
        "pattern": r"GEOMETRY OPTIMIZATION .* NOT converged",
        "fix": {"MAX_ITER": "+50"},
        "description": "Geo opt not converged — increase max iterations",
    },
]


async def check_cp2k_errors(hpc, work_dir: str) -> dict | None:
    """Parse CP2K output for errors and suggest fixes.

    Returns:
        None if no error found, or dict with error info and fix suggestion.
    """
    try:
        result = await hpc.conn.run(
            f"tail -200 {work_dir}/cp2k.out",
            check=False,
        )
        output = result.stdout or ""
    except Exception:
        return None

    for handler in CP2K_ERROR_HANDLERS:
        if re.search(handler["pattern"], output, re.IGNORECASE):
            return {
                "error_name": handler["name"],
                "description": handler["description"],
                "fix": handler["fix"],
                "auto_fixable": handler["fix"] is not None,
            }
    return None


async def apply_cp2k_fix(hpc, work_dir: str, fix: dict):
    """Apply parameter fixes to CP2K input file.

    Fix values:
    - "+N" means increment by N
    - "*N" means multiply by N
    - Direct value means replace
    """
    try:
        result = await hpc.conn.run(f"cat {work_dir}/input.inp", check=False)
        inp_content = result.stdout or ""

        for key, value in fix.items():
            if isinstance(value, str) and value.startswith("+"):
                # Increment: find current value and add
                match = re.search(rf"{key}\s+(\d+)", inp_content)
                if match:
                    new_val = int(match.group(1)) + int(value[1:])
                    inp_content = re.sub(
                        rf"{key}\s+\d+", f"{key} {new_val}", inp_content
                    )
            elif isinstance(value, str) and value.startswith("*"):
                # Multiply: find current value and multiply
                match = re.search(rf"{key}\s+([\d.eE+-]+)", inp_content)
                if match:
                    new_val = float(match.group(1)) * float(value[1:])
                    inp_content = re.sub(
                        rf"{key}\s+[\d.eE+-]+", f"{key} {new_val:.2E}", inp_content
                    )
            else:
                # Direct replacement
                inp_content = re.sub(
                    rf"{key}\s+\S+", f"{key} {value}", inp_content
                )

        # Write fixed input
        from shlex import quote
        write_cmd = f"cat > {quote(work_dir + '/input.inp')} << 'CATGO_EOF'\n{inp_content}\nCATGO_EOF"
        await hpc.conn.run(f"bash -l -c {quote(write_cmd)}", check=True)
        logger.info("Applied CP2K fix to %s", work_dir)

    except Exception as e:
        logger.warning("Failed to apply CP2K fix: %s", e)
```

## 文件清单
- 新建: server/workflow/error_handlers/__init__.py
- 新建: server/workflow/error_handlers/cp2k.py

## 验证
```bash
cd server && python -c "from workflow.error_handlers.cp2k import check_cp2k_errors; print('OK')"
```
```

---

## Prompt 23: d-band center 描述符提取

```
请实现从 VASP DOSCAR 中提取 d-band center 等催化描述符。

## 需求

1. 新建 server/workflow/catalysis/descriptors.py
2. 实现 d-band center 计算（从 DOSCAR 或 projected DOS）
3. 实现 coordination number 从结构计算
4. 结果存入 step_results 供 volcano plot 使用

## 参考实现

```python
"""Catalytic activity descriptors for structure-activity correlations.

Extracts electronic and geometric descriptors from DFT results:
- d-band center (from projected DOS)
- coordination number (from structure geometry)
- surface strain (from lattice mismatch)
"""

import math
from typing import Optional


def compute_d_band_center(
    energies: list[float],
    dos_d: list[float],
    e_fermi: float = 0.0,
) -> dict:
    """Compute d-band center from projected density of states.

    εd = ∫ E * DOS_d(E) dE / ∫ DOS_d(E) dE

    The d-band center position relative to Fermi level correlates with
    adsorption strength (Hammer-Nørskov d-band model).

    Args:
        energies: Energy grid points (eV).
        dos_d: d-orbital projected DOS at each energy point.
        e_fermi: Fermi energy (eV). Energies are shifted by this value.

    Returns:
        Dict with d_band_center, d_band_width, d_band_filling.
    """
    if len(energies) != len(dos_d) or len(energies) < 2:
        return {"error": "Invalid DOS data"}

    dE = energies[1] - energies[0]  # Uniform energy grid spacing

    # Shift to Fermi-referenced energies
    e_shifted = [e - e_fermi for e in energies]

    # Integrals (trapezoidal rule)
    integral_E_dos = sum(e * d * dE for e, d in zip(e_shifted, dos_d))
    integral_dos = sum(d * dE for d in dos_d)

    if abs(integral_dos) < 1e-10:
        return {"error": "Zero total DOS"}

    d_center = integral_E_dos / integral_dos

    # d-band width: sqrt(<E²> - <E>²)
    integral_E2_dos = sum(e**2 * d * dE for e, d in zip(e_shifted, dos_d))
    variance = integral_E2_dos / integral_dos - d_center**2
    d_width = math.sqrt(max(variance, 0))

    # d-band filling: fraction of states below Fermi level
    states_below = sum(d * dE for e, d in zip(e_shifted, dos_d) if e <= 0)
    d_filling = states_below / integral_dos if integral_dos > 0 else 0

    return {
        "d_band_center": d_center,  # eV relative to E_Fermi
        "d_band_width": d_width,     # eV
        "d_band_filling": d_filling, # 0-1
    }


def compute_coordination_number(
    structure_dict: dict,
    site_index: int,
    cutoff: float = 3.0,
) -> int:
    """Count nearest neighbors within cutoff distance.

    Args:
        structure_dict: pymatgen-compatible structure dict.
        site_index: Index of the atom to analyze.
        cutoff: Distance cutoff in Ångströms.

    Returns:
        Number of neighbors within cutoff.
    """
    sites = structure_dict.get("sites", [])
    if site_index >= len(sites):
        return 0

    target = sites[site_index]["xyz"]
    count = 0
    for i, site in enumerate(sites):
        if i == site_index:
            continue
        dx = site["xyz"][0] - target[0]
        dy = site["xyz"][1] - target[1]
        dz = site["xyz"][2] - target[2]
        dist = math.sqrt(dx*dx + dy*dy + dz*dz)
        if dist <= cutoff:
            count += 1
    return count


def compute_surface_strain(
    slab_lattice: list[list[float]],
    bulk_lattice: list[list[float]],
) -> dict:
    """Compute in-plane strain of a slab relative to bulk.

    strain = (a_slab - a_bulk) / a_bulk

    Args:
        slab_lattice: 3x3 lattice matrix of slab.
        bulk_lattice: 3x3 lattice matrix of bulk.

    Returns:
        Dict with strain_a, strain_b, strain_avg (percentage).
    """
    import math

    def vec_len(v):
        return math.sqrt(sum(x*x for x in v))

    a_slab = vec_len(slab_lattice[0])
    b_slab = vec_len(slab_lattice[1])
    a_bulk = vec_len(bulk_lattice[0])
    b_bulk = vec_len(bulk_lattice[1])

    strain_a = (a_slab - a_bulk) / a_bulk * 100
    strain_b = (b_slab - b_bulk) / b_bulk * 100

    return {
        "strain_a_pct": strain_a,
        "strain_b_pct": strain_b,
        "strain_avg_pct": (strain_a + strain_b) / 2,
    }
```

## 文件清单
- 新建: server/workflow/catalysis/descriptors.py
- 修改: server/workflow/catalysis/__init__.py（增加 import）

## 验证
```bash
cd server && python -c "
from workflow.catalysis.descriptors import compute_d_band_center
import math
energies = [i * 0.1 - 10 for i in range(200)]  # -10 to 10 eV
dos = [math.exp(-e**2) for e in energies]  # Gaussian centered at 0
result = compute_d_band_center(energies, dos, e_fermi=0.0)
print(f'd-band center = {result[\"d_band_center\"]:.4f} eV')
"
```
```

---

## Prompt 24: 结构来源链 (_lineage)

```
请在每个工作流节点完成时记录结构的完整来源链。

## 需求

每个 step_results 中增加 `_lineage` 数组，记录结构从原始输入到当前节点的完整变换历史。

## 实现

在 server/workflow/node_dispatch.py 的 _execute_node() 完成后，自动构建 lineage：

```python
# 在 step_results[node_id] 赋值之后
parent_lineage = []
for pid in _get_parent_ids(node_id, edges):
    parent = step_results.get(pid, {})
    parent_lineage.extend(parent.get("_lineage", []))

# 追加当前步骤
step_results[node_id]["_lineage"] = parent_lineage + [{
    "step": node_id,
    "node_type": node_type,
    "action": _describe_action(node_type, params),
    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}]


def _describe_action(node_type: str, params: dict) -> str:
    """Generate human-readable description of what this node did."""
    descriptions = {
        "structure_input": f"Load structure",
        "slab_gen": f"Generate slab (Miller {params.get('miller_index', '?')}, {params.get('layers', '?')} layers)",
        "geo_opt": f"Geometry optimization ({params.get('software', 'VASP')})",
        "single_point": f"Single-point energy ({params.get('software', 'VASP')})",
        "doping_gen": f"Doping: {params.get('dopant', '?')} at {params.get('site', '?')}",
        "adsorbate_place": f"Place adsorbate: {params.get('adsorbate', '?')}",
        "freq": f"Frequency calculation ({params.get('software', 'VASP')})",
        "free_energy": f"Gibbs free energy correction (T={params.get('temperature', 298.15)}K)",
    }
    return descriptions.get(node_type, f"{node_type} ({', '.join(f'{k}={v}' for k, v in list(params.items())[:3])})")
```

## 文件清单
- 修改: server/workflow/node_dispatch.py（lineage 追踪）

## 验证
```bash
cd server && python -c "from workflow.node_dispatch import _describe_action; print(_describe_action('slab_gen', {'miller_index': '110', 'layers': 3})); print('OK')"
```
```

---

## 执行顺序

```
Prompt 15 → not_converged 自动重跑      (hpc_execute.py, workflow_run.py)
Prompt 16 → 多结构汇聚                  (analysis.py, node_sets.py)
Prompt 17 → 批量吸附物放置              (batch_adsorbate.py)
Prompt 18 → DFT 输入预设                (presets/vasp.py)
Prompt 19 → 动态扇出                    (node_dispatch.py, orchestrator.py)
Prompt 20 → 测试覆盖                    (tests/)
Prompt 21 → 离线导出                    (offline-serialize.ts)
Prompt 22 → CP2K 错误处理               (error_handlers/cp2k.py)
Prompt 23 → 描述符提取                  (catalysis/descriptors.py)
Prompt 24 → 结构来源链                  (node_dispatch.py)
```

每个 Prompt 完成后：commit → 验证 → 下一个。
