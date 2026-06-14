---
title: 氢键检测教程
description: 在 MD 轨迹中检测并分析氢键
source: src/lib/md/MdHbondsPanel.svelte
---

# 氢键检测教程

学习如何在 MD 轨迹帧中检测并分析氢键。

## 前置条件

- 包含氢原子的 MD 轨迹

## 步骤 1：配置检测判据

### 几何判据

- **D-A distance cutoff:** 最大供体-受体距离（默认：3.5 A）
- **D-H-A angle cutoff:** 最小角度（默认：120 degrees）

### 供体/受体元素

选择哪些元素作为供体和受体。

## 步骤 2：运行检测

氢键会在整个轨迹中逐帧检测。

## 步骤 3：分析结果

### H-Bond 数量时间序列

跟踪氢键数量如何随时间演化。

### H-Bond 寿命

计算自相关函数以确定 H-bond 寿命。

### 供体-受体原子对

识别最常见的 H-bond 原子对。

## 步骤 4：可视化

H-bonds 可以作为虚线叠加到 3D 结构视图中。

## 相关内容

- [H-Bonds 模块](/zh/modules/md-analysis/hbonds) - API 参考
