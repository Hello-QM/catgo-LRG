---
title: 态密度
description: 总态密度与投影态密度可视化模块
source: src/lib/electronic/DosPlot.svelte
---

# 态密度

**Source:** `src/lib/electronic/DosPlot.svelte`, `src/lib/electronic/DosAnalysisPane.svelte`

## 概述

DOS 模块用于可视化 DFT 计算得到的总态密度和投影态密度，支持按原子和按轨道投影。

## 组件

### DosPlot

交互式 DOS 绘图组件。

### DosAnalysisPane

DOS 数据分析控制项。

### DosPlotWindow

独立 DOS 查看窗口。

## 数据格式

- `energies` — 相对于 Fermi 能级的能量网格
- `total_dos` — Total DOS values
- `pdos` — 按原子和轨道投影的 DOS
- `spin` — 自旋通道（自旋极化时为 up/down）

## 功能

### 投影类型

- Total DOS
- 原子投影 DOS
- 轨道投影 DOS（s、p、d、f）
- 元素投影 DOS

### Integration

在能量区间上交互式积分，以计算电子数。

## 服务器 API

**Endpoint:** `POST /api/dos`

## 相关内容

- [DOS 教程](/zh/tutorials/electronic/dos-analysis)
- [能带结构模块](/zh/modules/electronic/band-structure)
