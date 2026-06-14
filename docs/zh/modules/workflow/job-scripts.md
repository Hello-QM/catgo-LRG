---
title: Job Scripts
description: HPC 作业脚本生成与管理
source: src/lib/workflow/JobScriptWorkplace.svelte
---

# 作业脚本

**Source:** `src/lib/workflow/JobScriptWorkplace.svelte`, `src/lib/workflow/job-script-store.svelte.ts`

## 概述

生成并管理用于 SLURM、PBS 和其他调度系统的 HPC 作业脚本，并与工作流引擎集成以支持自动提交。

## 组件

### JobScriptWorkplace

用于创建和管理作业脚本的交互式编辑器。

## 调度器支持

### SLURM

生成包含资源规格的 `sbatch` 脚本。

### PBS/Torque

为基于 PBS 的集群生成 `qsub` 脚本。

## 功能

### 模板系统

为常见 DFT 程序（VASP、QE、LAMMPS）提供预配置模板。

### Resource 配置

- 节点数、任务数、内存
- Wall time
- 队列/分区选择
- GPU allocation

### Environment 模块

配置软件依赖所需的 module load。

## 服务器 API

**Endpoints:**
- `POST /api/hpc/submit` — Submit a job
- `GET /api/hpc/status` — 检查作业状态

## 相关内容

- [工作流引擎](/zh/modules/workflow/workflow-engine)
- [项目仪表盘](/zh/modules/workflow/project-dashboard)
