---
title: 动力学（RMSD/RMSF）
description: MD 轨迹的结构偏差指标
source: src/lib/md/MdDynamicsPanel.svelte
---

# 动力学（RMSD/RMSF）

**Source:** `src/lib/md/MdDynamicsPanel.svelte`, `src/lib/md/MdAnalysisPane.svelte`

## 概述

从 MD 轨迹计算 RMSD（均方根偏差）和 RMSF（均方根涨落），用于量化结构稳定性和逐原子柔性。

## 组件

### MdDynamicsPanel

用于 RMSD/RMSF 计算和可视化的交互式面板。

### MdAnalysisPane

统筹所有 MD 分析工具的父面板。

## Metrics

### RMSD

衡量结构随时间相对于参考帧的变化程度。

### RMSF

衡量每个原子围绕其平均位置的平均涨落。

## 服务器 API

**Endpoint:** `POST /api/md/rmsd`

## Parameters

- `reference_frame` — 参考帧 index（默认：0）
- `atom_selection` — 纳入计算的原子
- `alignment` — 计算前是否对齐帧

## 相关内容

- [RMSD/RMSF 教程](/zh/tutorials/md-analysis/rmsd-rmsf)
- [RDF 模块](/zh/modules/md-analysis/rdf)
