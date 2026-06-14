---
title: 能带结构
description: 电子能带结构绘图与分析模块
source: src/lib/electronic/BandPlot.svelte
---

# 能带结构

**源码：** `src/lib/electronic/BandPlot.svelte`、`src/lib/electronic/BandAnalysisPane.svelte`

## 概览

能带结构模块用于交互式可视化 DFT 计算得到的电子能带结构。它支持自旋极化能带、轨道投影（fat bands），以及自动带隙检测。

## 组件

### BandPlot

主绘图组件会把能带结构数据渲染为交互式 D3 图表。

**Props:**

- `band_data` - 能带结构数据对象
- `fermi_energy` - 以 eV 为单位的 Fermi 能级
- `show_projections` - 启用轨道投影叠加层

### BandAnalysisPane

用于能带结构分析控制和结果展示的侧边面板。

## 数据格式

### 能带数据结构

能带结构数据遵循以下格式：

- `kpoints` - k 点坐标数组
- `distances` - k 路径累计距离
- `bands` - 本征值二维数组 [band_index][k_index]
- `labels` - 高对称点标签和位置
- `projections` - 可选的轨道成分数据

## 功能

### 轨道投影（Fat Bands）

把轨道成分（s、p、d、f）叠加为带有颜色和宽度变化的能带。

### D-Band 分析

自动计算过渡金属的 d-band center 和 width。

### 带隙检测

自动识别直接/间接带隙。

## 服务器 API

**端点：** `POST /api/bands`

将原始 DFT 输出处理为能带结构数据格式。

## 相关

- [能带结构教程](/zh/tutorials/electronic/band-structure)
- [DOS 模块](/zh/modules/electronic/dos)
- [COHP 模块](/zh/modules/electronic/cohp)
