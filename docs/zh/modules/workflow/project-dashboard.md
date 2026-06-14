---
title: 项目仪表盘
description: 项目管理与结果可视化
source: src/lib/workflow/ProjectDashboard.svelte
---

# 项目仪表盘

**Source:** `src/lib/workflow/ProjectDashboard.svelte`, `src/lib/workflow/ResultsTable.svelte`

## 概述

项目仪表盘提供所有工作流、执行状态和已收集结果的概览，并支持以表格和图形方式比较结果。

## 组件

### ProjectDashboard

带项目概览的主仪表盘视图。

### ProjectListView

带状态指示器的项目列表。

### NodeStatusPanel

单个工作流节点的详细状态。

### ResultsTable

跨工作流运行的计算结果表格视图。

### ResultsPlot

用于结果比较的交互式散点图/条形图。

## 功能

### 工作流状态追踪

运行中工作流的实时状态更新。

### 结果汇总

收集并比较多个工作流运行的结果。

### Export

将结果导出为 CSV、JSON 或可用于论文发表的表格。

## 相关内容

- [工作流引擎](/zh/modules/workflow/workflow-engine)
- [节点类型](/zh/modules/workflow/node-types)
