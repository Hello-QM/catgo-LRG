---
title: RMSD 与 RMSF 教程
description: 从 MD 轨迹计算结构偏差指标
source: src/lib/md/MdDynamicsPanel.svelte
---

# RMSD 与 RMSF 教程

学习如何从分子动力学轨迹中计算均方根偏差（RMSD）和均方根波动（RMSF）。

## 前置条件

- 已在 CatGo 中加载的 MD 轨迹

## 步骤 1：打开 MD 分析

从侧边栏进入 MD 分析面板。

## 步骤 2：计算 RMSD

### 参考帧

选择用于 RMSD 计算的参考帧（默认：第一帧）。

### 原子选择

选择要纳入计算的原子（所有原子、仅主链，或自定义选择）。

### 结果

RMSD 时间序列显示结构相对于参考帧的漂移。达到平衡的体系通常会出现平台区。

## 步骤 3：计算 RMSF

### 逐原子波动

RMSF 显示每个原子在轨迹中的平均位移。

### 可视化

RMSF 值可以映射为 3D 查看器中的原子颜色或尺寸。

## 步骤 4：导出

导出时间序列数据或逐原子 RMSF 值。

## 相关内容

- [动力学模块](/zh/modules/md-analysis/dynamics) - API 参考
- [轨迹回放](/zh/tutorials/visualization/trajectories) - 加载轨迹
