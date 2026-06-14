---
title: 氢键
description: 氢键检测与分析模块
source: src/lib/md/MdHbondsPanel.svelte
---

# 氢键

**Source:** `src/lib/md/MdHbondsPanel.svelte`

## 概述

在 MD 轨迹帧中使用几何判据（距离和角度截断）检测氢键，并提供随时间变化的氢键数量及供体-受体对统计。

## 组件

### MdHbondsPanel

用于配置氢键检测并查看结果的交互式面板。

## 检测判据

### 几何参数

- `d_cutoff` — 最大供体-受体距离（默认：3.5 A）
- `angle_cutoff` — 最小 D-H-A 角（默认：120 度）

### Element 配置

- 供体元素（通常为 N、O）
- 受体元素（通常为 N、O、F）

## 功能

### Time Series

氢键数量随帧数变化。

### 配对统计

出现最频繁的供体-受体对。

### 寿命分析

氢键自相关和寿命估计。

## 服务器 API

**Endpoint:** `POST /api/md/hbonds`

## 相关内容

- [氢键教程](/zh/tutorials/md-analysis/hbond-detection)
- [动力学模块](/zh/modules/md-analysis/dynamics)
