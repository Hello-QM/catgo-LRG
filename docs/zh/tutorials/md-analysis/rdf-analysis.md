---
title: RDF 分析教程
description: 如何从 MD 轨迹计算并可视化径向分布函数
source: src/lib/rdf/RdfPlot.svelte
---

# RDF 分析教程

学习如何从分子动力学轨迹中计算径向分布函数（RDF）。

## 前置条件

- 一个 MD 轨迹文件（.extxyz、.traj、.hdf5）
- 已在 CatGo 查看器中加载的轨迹

## 步骤 1：加载轨迹

使用文件导入对话框或拖放操作加载 MD 轨迹。

## 步骤 2：配置 RDF 参数

### 元素对

选择要计算 RDF 的元素对（例如 O-H、Si-O）。

### 截断距离

设置用于原子对计数的最大距离（通常为 8-12 Angstroms）。

### 分箱数量

调整直方图分辨率（默认：200 bins）。

## 步骤 3：计算并可视化

点击 "Compute RDF" 生成图像。计算会遍历所有轨迹帧。

### 多帧平均

RDF 会在选定帧上取平均，以获得更好的统计质量。

## 步骤 4：解读结果

### 峰位置

第一个峰表示最近邻距离。后续峰揭示配位壳层结构。

### 配位数

对 g(r) 积分可获得配位数。

## 步骤 5：导出

将图像保存为 SVG/PNG，或将原始数据导出为 CSV。

## 相关内容

- [RDF 模块](/zh/modules/md-analysis/rdf) - API 参考
- [轨迹](/zh/tutorials/visualization/trajectories) - 加载 MD 轨迹
