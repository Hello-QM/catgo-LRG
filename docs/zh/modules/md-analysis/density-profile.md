---
title: 密度剖面
description: 空间密度分布分析模块
source: src/lib/md/MdDensityPanel.svelte
---

# 密度分布

**Source:** `src/lib/md/MdDensityPanel.svelte`

## 概述

从 MD 轨迹沿晶胞轴计算密度剖面，适用于分析界面、限域和层状结构。

## 组件

### MdDensityPanel

用于密度剖面计算和可视化的交互式面板。

## 功能

### 轴向选择

沿 a、b 或 c 晶格方向计算密度。

### 元素筛选

计算特定元素类型的密度剖面。

### 多帧平均

对轨迹帧上的密度进行平均。

## 服务器 API

**Endpoint:** `POST /api/md/density`

## 相关内容

- [RDF 模块](/zh/modules/md-analysis/rdf)
- [动力学模块](/zh/modules/md-analysis/dynamics)
