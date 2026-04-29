# 实施 Prompts Phase 4：修复空壳节点 + 对齐前后端

**日期:** 2026-03-18
**分支:** `CatGo-PRO`
**原则:** 不写新功能，只是把 Structure 界面已有的后端 API 连接到工作流节点

---

## 问题总结

经审查发现：
1. Structure 界面的 DOS/COHP/MD/Charge 分析、吸附物放置、掺杂枚举 **后端 API 完整**
2. 但对应的工作流节点 **只存元数据，不调用这些 API**
3. 修复方式：在工作流节点 handler 中调用已有的后端 API（不需要写新逻辑）

---

## 实施状态

| # | 功能 | 难度 | 状态 |
|---|------|------|------|
| 40 | dos_analysis 节点：从 HPC 加载 + 自动计算 PDOS/d-band | 中 | 🔲 |
| 41 | cohp_analysis 节点：从 HPC 加载 COHPCAR + 计算 | 中 | 🔲 |
| 42 | md_analysis 节点：从 HPC 加载轨迹 + RDF/RMSD | 中 | 🔲 |
| 43 | charge_analysis 节点：在 HPC 运行 bader + 解析 ACF.dat | 中 | 🔲 |
| 44 | adsorbate_place 节点：调用 adsorption API 自动放置 | 低 | 🔲 |
| 45 | doping_gen 节点：对齐 /build/doping API（支持组合枚举） | 低 | 🔲 |
| 46 | polymer_build/crosslink/deform/glass_transition 壳子标记 | 低 | 🔲 |

---

## Prompt 40: dos_analysis 工作流节点实现

```
请让 dos_analysis 工作流节点真正计算 DOS，而不是只存元数据。

## 背景

Structure 界面的 DosAnalysisPane 通过 session API 完整实现了 DOS 分析：
1. POST /api/dos/from-directory — 从 HPC 远程目录自动加载 vaspout.h5 或 PROCAR
2. POST /api/dos/compute — 计算 PDOS
3. POST /api/dos/dband — 计算 d-band center

工作流节点应该复用这些 API。

## 需求

修改 server/workflow/engines/analysis.py 的 dos_analysis handler：

```python
elif node_type == "dos_analysis":
    parent = step_results.get(parent_ids[0], {}) if parent_ids else {}
    work_dir = parent.get("work_dir", "")
    session_id = parent.get("session_id", "")

    if not work_dir:
        analysis_result["error"] = "No work directory from parent step"
    else:
        import httpx
        api_base = "http://localhost:8000/api"

        # Step 1: 从 HPC 远程目录加载 DOS 数据
        async with httpx.AsyncClient(timeout=60) as client:
            upload_resp = await client.post(f"{api_base}/dos/from-directory", json={
                "session_id": session_id,
                "remote_path": work_dir,
            })
            if upload_resp.status_code != 200:
                analysis_result["error"] = f"DOS upload failed: {upload_resp.text}"
            else:
                dos_session = upload_resp.json()
                dos_session_id = dos_session.get("session_id", "")

                # Step 2: 计算总 DOS
                total_resp = await client.post(f"{api_base}/dos/total", json={
                    "session_id": dos_session_id,
                    "sigma": params.get("sigma", 0.05),
                    "emin": params.get("emin", -10),
                    "emax": params.get("emax", 10),
                    "ngrid": params.get("ngrid", 2000),
                })

                # Step 3: 如果参数 d_band=true，计算 d-band center
                dband_result = None
                if params.get("d_band", True):
                    # 选取所有过渡金属原子
                    dband_resp = await client.post(f"{api_base}/dos/dband", json={
                        "session_id": dos_session_id,
                        "sigma": 0.05,
                        "occupied_only_center": True,
                    })
                    if dband_resp.status_code == 200:
                        dband_result = dband_resp.json()

                analysis_result.update({
                    "dos_session_id": dos_session_id,
                    "total_dos": total_resp.json() if total_resp.status_code == 200 else None,
                    "dband": dband_result,
                    "efermi": dos_session.get("efermi"),
                })

                # 清理 session
                await client.delete(f"{api_base}/dos/{dos_session_id}")
```

## 注意
- 使用 httpx 调用本地 API（和 MCP server 用同样的模式）
- session 用完后清理，避免内存泄漏
- 需要 HPC 连接（parent 节点的 work_dir 在远程）

## 文件清单
- 修改: server/workflow/engines/analysis.py

## 验证
```bash
cd server && python -c "from workflow.engines.analysis import execute_analysis_node; print('OK')"
```
```

---

## Prompt 41: cohp_analysis 工作流节点实现

```
请让 cohp_analysis 工作流节点真正计算 COHP。

## 背景

需要 LOBSTER 输出的 COHPCAR.lobster 文件。
后端 API: POST /api/cohp/from-remote (从 HPC 加载) + POST /api/cohp/data (计算 COHP)

## 需求

修改 analysis.py 的 cohp_analysis handler：

```python
elif node_type == "cohp_analysis":
    parent = step_results.get(parent_ids[0], {}) if parent_ids else {}
    work_dir = parent.get("work_dir", "")
    session_id = parent.get("session_id", "")

    if not work_dir:
        analysis_result["error"] = "No work directory from parent step"
    else:
        import httpx
        api_base = "http://localhost:8000/api"

        async with httpx.AsyncClient(timeout=60) as client:
            # 从 HPC 加载 COHPCAR
            cohp_path = f"{work_dir}/COHPCAR.lobster"
            upload_resp = await client.post(f"{api_base}/cohp/from-remote", json={
                "session_id": session_id,
                "remote_path": cohp_path,
            })
            if upload_resp.status_code != 200:
                analysis_result["error"] = f"COHP upload failed (need LOBSTER output): {upload_resp.text}"
            else:
                cohp_session = upload_resp.json()
                cohp_session_id = cohp_session.get("session_id", "")
                bonds = cohp_session.get("bonds", [])

                # 计算所有 total bonds 的 COHP
                bond_indices = [b["bond_index"] for b in bonds if b.get("is_total")]
                if bond_indices:
                    data_resp = await client.post(f"{api_base}/cohp/data", json={
                        "session_id": cohp_session_id,
                        "bond_indices": bond_indices[:20],  # 限制避免过大
                        "include_orbitals": False,
                    })
                    if data_resp.status_code == 200:
                        analysis_result.update(data_resp.json())

                analysis_result["cohp_session_id"] = cohp_session_id
                analysis_result["n_bonds"] = len(bonds)
                await client.delete(f"{api_base}/cohp/{cohp_session_id}")
```

## 文件清单
- 修改: server/workflow/engines/analysis.py
```

---

## Prompt 42: md_analysis 工作流节点实现

```
请让 md_analysis 工作流节点真正分析轨迹。

## 背景

后端 API: POST /api/md/rdf/compute, /api/md/rmsd/compute 等
需要轨迹文件（从 HPC work_dir 下载）

## 需求

修改 analysis.py 的 md_analysis handler：

```python
elif node_type == "md_analysis":
    parent = step_results.get(parent_ids[0], {}) if parent_ids else {}
    work_dir = parent.get("work_dir", "")
    session_id = parent.get("session_id", "")
    requested = params.get("analyses", "rmsd,rdf").split(",")

    if not work_dir:
        analysis_result["error"] = "No work directory from parent step"
    else:
        from utils.hpc_client import pool
        hpc = pool.get_connection(session_id) if session_id else None

        if not hpc:
            analysis_result["error"] = "HPC session unavailable for trajectory download"
        else:
            # 下载轨迹文件
            import base64
            traj_files = ["XDATCAR", "vasprun.xml", "dump.lammpstrj", "traj.xyz"]
            traj_content = None
            traj_format = "pdb"

            for fname in traj_files:
                try:
                    result = await hpc.conn.run(f"cat {work_dir}/{fname}", check=True)
                    traj_content = result.stdout
                    if "XDATCAR" in fname:
                        traj_format = "vasp-xdatcar"
                    elif "lammpstrj" in fname:
                        traj_format = "lammpstrj"
                    elif "xyz" in fname:
                        traj_format = "xyz"
                    break
                except Exception:
                    continue

            if not traj_content:
                analysis_result["error"] = "No trajectory file found in work directory"
            else:
                traj_b64 = base64.b64encode(traj_content.encode()).decode()
                import httpx
                api_base = "http://localhost:8000/api"

                async with httpx.AsyncClient(timeout=120) as client:
                    if "rdf" in requested:
                        rdf_resp = await client.post(f"{api_base}/md/rdf/compute", json={
                            "trajectory_b64": traj_b64,
                            "format": traj_format,
                            "n_bins": 100,
                        })
                        if rdf_resp.status_code == 200:
                            analysis_result["rdf"] = rdf_resp.json()

                    if "rmsd" in requested:
                        rmsd_resp = await client.post(f"{api_base}/md/rmsd/compute", json={
                            "trajectory_b64": traj_b64,
                            "format": traj_format,
                        })
                        if rmsd_resp.status_code == 200:
                            analysis_result["rmsd"] = rmsd_resp.json()

                analysis_result["requested_analyses"] = requested
                analysis_result["trajectory_format"] = traj_format
```

## 文件清单
- 修改: server/workflow/engines/analysis.py
```

---

## Prompt 43: charge_analysis 运行 Bader + 解析结果

```
请让 charge_analysis 工作流节点在 HPC 上运行 bader 命令并解析结果。

## 需求

charge_analysis 需要 parent 节点的 VASP static 计算输出（CHGCAR + AECCAR0 + AECCAR2）。
在 HPC 上运行 bader，然后解析 ACF.dat。

```python
elif node_type == "charge_analysis":
    parent = step_results.get(parent_ids[0], {}) if parent_ids else {}
    work_dir = parent.get("work_dir", "")
    session_id = parent.get("session_id") or parent.get("hpc_session_id", "")
    method = params.get("method", "bader")

    if not work_dir:
        analysis_result["error"] = "No work directory from parent step"
    else:
        from utils.hpc_client import pool
        hpc = pool.get_connection(session_id) if session_id else None

        if not hpc:
            analysis_result["error"] = "HPC session unavailable"
        else:
            # 检查必需文件
            check = await hpc.conn.run(
                f"test -f {work_dir}/CHGCAR && test -f {work_dir}/AECCAR0 && test -f {work_dir}/AECCAR2",
                check=False,
            )
            if check.exit_status != 0:
                analysis_result["error"] = (
                    "Bader analysis requires CHGCAR + AECCAR0 + AECCAR2. "
                    "Make sure parent calculation has LAECHG=True in INCAR."
                )
            else:
                # 运行 bader
                bader_cmd = f"cd {work_dir} && bader CHGCAR -ref AECCAR0 AECCAR2"
                bader_result = await hpc.conn.run(bader_cmd, check=False)

                if bader_result.exit_status != 0:
                    analysis_result["error"] = f"Bader command failed: {bader_result.stderr}"
                else:
                    # 解析 ACF.dat
                    acf_result = await hpc.conn.run(f"cat {work_dir}/ACF.dat", check=False)
                    if acf_result.exit_status == 0:
                        charges = _parse_acf_dat(acf_result.stdout)
                        analysis_result.update({
                            "method": method,
                            "charges": charges,
                            "n_atoms": len(charges),
                            "work_dir": work_dir,
                        })


def _parse_acf_dat(content: str) -> list[dict]:
    """Parse Bader ACF.dat output into per-atom charges."""
    charges = []
    for line in content.strip().split("\n"):
        parts = line.split()
        if len(parts) >= 5 and parts[0].isdigit():
            charges.append({
                "index": int(parts[0]),
                "x": float(parts[1]),
                "y": float(parts[2]),
                "z": float(parts[3]),
                "charge": float(parts[4]),
                "min_dist": float(parts[5]) if len(parts) > 5 else None,
                "volume": float(parts[6]) if len(parts) > 6 else None,
            })
    return charges
```

## 文件清单
- 修改: server/workflow/engines/analysis.py
```

---

## Prompt 44: adsorbate_place 节点调用 adsorption API

```
请让 adsorbate_place 工作流节点自动找位点并放置吸附物。

## 背景

当前 adsorbate_place 只是传递前端预配置的 structure_json。
应该改为：自动调用 /api/adsorption/sites 找位点，然后调用 /api/adsorption/place 放置。

## 需求

修改 server/workflow/engines/local.py 的 adsorbate_place handler：

```python
elif node_type == "adsorbate_place":
    # 如果前端已预配置了 structure_json，直接使用
    structure_json = params.get("structure_json", "")
    if structure_json:
        step_results[step_id] = {"structure_json": structure_json, "structure": json.loads(structure_json)}
        update_step(workflow_id, step_id, {
            "status": StepStatus.COMPLETED.value,
            "result_json": json.dumps({"source": "pre_configured"}),
        })
    else:
        # 自动模式：从父节点获取结构，找位点，放置吸附物
        parent = step_results.get(parent_ids[0], {}) if parent_ids else {}
        structure = parent.get("structure")

        if not structure:
            raise RuntimeError("No structure from parent node for adsorbate placement")

        if isinstance(structure, str):
            structure = json.loads(structure)

        import httpx
        api_base = "http://localhost:8000/api"

        async with httpx.AsyncClient(timeout=30) as client:
            # 找吸附位点
            sites_resp = await client.post(f"{api_base}/adsorption/sites", json={
                "structure": structure,
            })
            if sites_resp.status_code != 200:
                raise RuntimeError(f"Adsorption site finding failed: {sites_resp.text}")

            sites = sites_resp.json().get("sites", [])
            if not sites:
                raise RuntimeError("No adsorption sites found on surface")

            # 选择位点策略
            site_pref = params.get("site", "fcc")
            target_site = next(
                (s for s in sites if s.get("site_type") == site_pref),
                sites[0]  # fallback to first site
            )

            # 获取吸附物
            species = params.get("species", "OH")

            # 放置吸附物
            place_resp = await client.post(f"{api_base}/adsorption/place", json={
                "structure": structure,
                "site_position": target_site["position"],
                "adsorbate_name": species,
                "height_offset": params.get("height", 2.0),
            })
            if place_resp.status_code != 200:
                raise RuntimeError(f"Adsorbate placement failed: {place_resp.text}")

            result_struct = place_resp.json().get("structure")
            step_results[step_id] = {
                "structure": result_struct,
                "site_type": target_site.get("site_type"),
                "adsorbate": species,
                "n_sites_found": len(sites),
            }
            update_step(workflow_id, step_id, {
                "status": StepStatus.COMPLETED.value,
                "result_json": json.dumps({
                    "adsorbate": species,
                    "site_type": target_site.get("site_type"),
                    "n_sites": len(sites),
                }),
            })
```

## 文件清单
- 修改: server/workflow/engines/local.py
```

---

## Prompt 45: doping_gen 对齐 /build/doping API

```
请让 doping_gen 工作流节点使用和 Structure 界面相同的 /build/doping API。

## 背景

当前 doping_gen 在 local.py 中自己写了 pymatgen replace 逻辑。
Structure 界面的 DopingPane 使用 /api/build/doping，支持组合枚举。
应该统一使用后端 API。

## 需求

修改 local.py 的 doping_gen handler：

```python
elif node_type == "doping_gen":
    parent = step_results.get(parent_ids[0], {}) if parent_ids else {}
    structure = parent.get("structure")
    if not structure:
        structure_json = parent.get("structure_json")
        if structure_json:
            structure = json.loads(structure_json) if isinstance(structure_json, str) else structure_json

    if not structure:
        raise RuntimeError("No structure from parent for doping")

    dopant = params.get("dopant", "")
    host_element = params.get("target_element", "")
    count = int(params.get("count", 1))
    enumerate_all = params.get("enumerate", False)

    import httpx
    api_base = "http://localhost:8000/api"

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(f"{api_base}/build/doping", json={
            "structure": structure,
            "dopant": dopant,
            "host_element": host_element,
            "concentration": count,
            "enumerate": enumerate_all,
        })
        if resp.status_code != 200:
            raise RuntimeError(f"Doping failed: {resp.text}")

        result = resp.json()
        structures = result.get("structures", [])
        labels = result.get("labels", [])

        if len(structures) == 1:
            step_results[step_id] = {
                "structure": structures[0],
                "label": labels[0] if labels else f"{host_element}→{dopant}",
            }
        else:
            # 多结构：设置 _fan_out 给下游 batch/loop 使用
            step_results[step_id] = {
                "structures": structures,
                "labels": labels,
                "_fan_out": True,
                "n_configs": len(structures),
            }

        update_step(workflow_id, step_id, {
            "status": StepStatus.COMPLETED.value,
            "result_json": json.dumps({
                "dopant": dopant,
                "host_element": host_element,
                "n_configs": len(structures),
                "enumerate": enumerate_all,
            }),
        })
```

## 文件清单
- 修改: server/workflow/engines/local.py
```

---

## Prompt 46: 聚合物壳子节点安全标记

```
请让 polymer_build/polymer_crosslink/glass_transition/polymer_deform 节点
在运行时不崩溃，而是返回明确的 "未实现" 错误信息。

## 当前问题

这 4 个节点运行时会抛出 RuntimeError("Unknown node type")，
用户看到的是一个无意义的崩溃。

## 需求

在 local.py 中为这些节点添加明确的未实现提示：

```python
elif node_type in ("polymer_build", "polymer_crosslink", "glass_transition", "polymer_deform"):
    update_step(workflow_id, step_id, {
        "status": StepStatus.FAILED.value,
        "error_message": f"Node type '{node_type}' is not yet implemented in the workflow engine. "
                        f"Use the LAMMPS build tools in the Structure viewer for polymer simulations.",
        "error_type": "input_error",
    })
    return  # 不要继续执行后续的 completed 标记
```

注意最后的 return — 这些节点不走正常完成流程。

## 文件清单
- 修改: server/workflow/engines/local.py
```

---

## 执行顺序

```
Prompt 44 → adsorbate_place（最简单，只调 API）
Prompt 45 → doping_gen（对齐已有 API）
Prompt 46 → 聚合物壳子安全标记（最简单，加错误提示）
Prompt 40 → dos_analysis（复用 session API）
Prompt 41 → cohp_analysis（复用 session API）
Prompt 42 → md_analysis（需要下载轨迹文件）
Prompt 43 → charge_analysis（需要在 HPC 运行 bader）
```

每个 Prompt 完成后：commit → 验证 → 下一个。
