# 重构计划：工作流引擎文件拆分

**日期:** 2026-03-17
**目标:** 拆分 `python_engine.py` (1100+ 行) 和 `hpc_client.py` (2000+ 行)，为后续可靠性改进、Batch Node、百万级高通量筛选打好架构基础。
**原则:** 只拆文件，不改功能。所有现有行为保持不变。

---

## python_engine.py 拆分方案

```
server/workflow/python_engine.py (1100+ 行) →

server/workflow/
  ├── orchestrator.py        — _run_workflow, topo sort, 层执行循环, resume skip
  │                            (~200 行)
  ├── node_dispatch.py       — _execute_node, 节点类型分发 (if VASP/ORCA/LOCAL/...)
  │                            (~100 行)
  ├── hpc_execute.py         — _execute_hpc_node 主流程
  │                            (~150 行)
  ├── hpc_submit.py          — 输入上传, _render_job_script, sbatch 提交
  │                            (~250 行)
  ├── hpc_poll.py            — 轮询循环, sacct 验证, _watch_job_completion
  │                            (~150 行)
  ├── result_collect.py      — _try_read_output_structure, 频率/能量提取
  │                            (~150 行)
  ├── resume.py              — 已存在，不动
  └── python_engine.py       — 保留为入口 (re-export start_workflow_python 等)
```

## hpc_client.py 拆分方案

```
server/utils/hpc_client.py (2000+ 行) →

server/utils/
  ├── hpc_client.py          — HPCConnection, 连接池, is_alive, keepalive
  │                            (~600 行)
  ├── slurm.py               — SLURMScheduler (submit, get_job_status, sacct, cancel)
  │                            (~400 行)
  ├── pbs.py                 — PBSScheduler
  │                            (~300 行)
  └── ssh_file_ops.py        — upload/download, SFTP fallback, read/write remote file
  │                            (~400 行)
```

## 未来扩展文件（本次不创建，只预留位置）

```
server/workflow/
  ├── batch_execute.py       — batch node 完整生命周期 (SLURM array job)
  ├── batch_submit.py        — --array 脚本生成 + 分批上传
  ├── batch_poll.py          — sacct 批量状态查询 + 进度广播
  ├── batch_collect.py       — 批量结果提取 (流式写 DB)
  ├── batch_retry.py         — 失败子任务重提交
  ├── ml_screen.py           — ML 势场批量推理 (OCP/MACE/CHGNet)
  ├── structure_gen.py       — 批量掺杂/替换枚举 (生成器模式)
  └── catalysis/
      ├── free_energy.py     — G = E_DFT + ZPE - TS
      ├── oer.py             — OER 过电位
      ├── co2rr.py           — CO2RR 限制电位
      ├── nrr.py             — NRR 过电位
      ├── scaling.py         — Scaling relations
      └── volcano.py         — Volcano plot 数据

server/utils/
  └── batch_db.py            — batch_subtasks 表 CRUD
```

## 共用关系

```
                     orchestrator.py
                    /              \
            node_dispatch.py        node_dispatch.py
               |                        |
         hpc_execute.py           batch_execute.py (未来)
          (单个作业)                 (万级作业)
          /    |    \              /     |      \
   hpc_submit  hpc_poll  result  batch_submit  batch_poll  batch_collect
         \      |      /              \       |       /
          slurm.py / pbs.py          slurm.py (--array)
          ssh_file_ops.py            ssh_file_ops.py
          hpc_client.py              hpc_client.py
```

## 实施路线

```
Week 1: 拆 python_engine.py + hpc_client.py（不加新功能）
Week 2: 可靠性（重试+退避+孤儿检测）→ 改 hpc_poll.py + engine.py
Week 3: 单节点重试 + 参数检测 → 改 orchestrator.py + workflow_db.py
Week 4-5: Batch Node → 新增 batch_*.py + batch_db.py
Week 6: 催化分析 → 新增 catalysis/
```
