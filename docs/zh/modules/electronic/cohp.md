---
title: COHP
description: 晶体轨道 Hamilton 布居（COHP）分析模块
source: src/lib/electronic/CohpPlot.svelte
---

# COHP

**Source:** `src/lib/electronic/CohpPlot.svelte`, `src/lib/electronic/CohpAnalysisPane.svelte`

## 概述

COHP 模块用于可视化晶体轨道 Hamilton 布居数据，以分析化学键。COHP 会把能带结构能量分解为特定原子对的成键与反键贡献。

## 组件

### CohpPlot

带成键/反键区域的交互式 COHP 绘图组件。

### CohpAnalysisPane

用于选择原子对和分析选项的控制项。

## 数据格式

- `energies` — Energy grid
- `cohp_data` — 每个原子对的 COHP 数值
- `icohp` — 积分 COHP 数值
- `atom_pairs` — 原子对 index 列表

## 功能

### 键对选择

选择特定原子对进行 COHP 可视化。

### 积分 COHP（ICOHP）

通过积分 COHP 曲线得到的定量键强度指标。

### 多原子对比较

比较多个原子对之间的成键相互作用。

## 服务器 API

**Endpoint:** `POST /api/cohp`

## 相关内容

- [COHP 教程](/zh/tutorials/electronic/cohp-analysis)
- [能带结构模块](/zh/modules/electronic/band-structure)
