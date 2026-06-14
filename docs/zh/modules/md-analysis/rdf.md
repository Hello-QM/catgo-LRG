---
title: 径向分布函数
description: RDF 计算与可视化模块
source: src/lib/rdf/RdfPlot.svelte
---

# 径向分布函数

**源码：** `src/lib/rdf/RdfPlot.svelte`、`src/lib/rdf/calc-rdf.ts`

## 概览

该模块可以从结构和 MD 轨迹中计算并可视化径向分布函数 g(r)。它支持按元素对计算 RDF，也支持多帧平均。

## 组件

### RdfPlot

带元素对选择功能的交互式 RDF 图。

## 计算

### 客户端（calc-rdf.ts）

在浏览器中使用成对计数和周期性边界条件快速计算 RDF。

### 服务器端

`POST /api/md/rdf` - 对大轨迹使用 NumPy 加速的服务器端计算。

## 参数

- `r_max` - 最大距离截断
- `n_bins` - 直方图 bin 数
- `element_pairs` - 要计算的元素对
- `frame_range` - 要包含的轨迹帧范围

## 功能

### 多帧平均

对轨迹帧上的 g(r) 求平均，以获得更好的统计结果。

### 配位数

积分 g(r)，得到随距离变化的配位数。

### 峰分析

自动检测第一峰和最近邻距离。

## 相关

- [RDF 教程](/zh/tutorials/md-analysis/rdf-analysis)
- [动力学模块](/zh/modules/md-analysis/dynamics)
