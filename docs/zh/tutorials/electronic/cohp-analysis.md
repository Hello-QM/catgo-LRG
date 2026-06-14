---
title: COHP 分析教程
description: 如何在 CatGo 中分析晶体轨道 Hamilton 布居
source: src/lib/electronic/CohpPlot.svelte
---

# COHP 分析教程

学习如何可视化并解读用于化学成键分析的 COHP（Crystal Orbital Hamilton Population）数据。

## 前置条件

- LOBSTER 计算输出文件
- COHPCAR.lobster 或等效数据

## 步骤 1：加载 COHP 数据

通过电子分析面板上传 COHP 数据文件。

### 支持的格式

- LOBSTER：`COHPCAR.lobster`
- JSON：预处理后的 COHP 数据

## 步骤 2：选择键合原子对

选择原子对以分析其成键/反键相互作用。

### 原子对选择

从结构查看器或下拉列表中选择特定原子对。

## 步骤 3：解读图像

### 成键与反键

- 负 COHP（右侧）：成键相互作用
- 正 COHP（左侧）：反键相互作用

### 积分 COHP（ICOHP）

积分 COHP 值用于量化键强度。数值越负，成键越强。

## 步骤 4：导出

导出图像和数据，用于发表或进一步分析。

## 相关内容

- [能带结构](/zh/tutorials/electronic/band-structure) - 电子结构可视化
- [COHP 模块](/zh/modules/electronic/cohp) - API 参考
