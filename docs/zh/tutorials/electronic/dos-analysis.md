---
title: DOS 分析教程
description: 如何在 CatGo 中可视化和分析态密度
source: src/lib/electronic/DosPlot.svelte
---

# DOS 分析教程

学习如何根据 DFT 计算结果绘制总态密度和投影态密度。

## 前置条件

- 已完成并包含 DOS 输出的 DFT 计算
- 文件：vasprun.xml、DOSCAR 或 HDF5 数据

## 步骤 1：加载 DOS 数据

通过电子分析面板上传态密度数据。

### 支持的格式

- VASP：`vasprun.xml`、`DOSCAR`
- HDF5：包含 DOS 数组的 `.h5` 文件
- JSON：预处理后的 DOS JSON

## 步骤 2：配置图像

### 能量范围

设置相对于费米能级的能量窗口。

### 投影类型

在总 DOS、原子投影 DOS 或轨道投影 DOS 之间选择。

### 自旋极化

对于自旋极化计算，spin-up 和 spin-down 通道会分开显示。

## 步骤 3：分析特征

### 峰识别

将鼠标悬停在峰上，以识别贡献该峰的轨道和原子。

### 积分

选择能量范围以计算积分 DOS 和电子数。

## 步骤 4：导出

导出为 SVG、PNG 或 JSON 数据。

## 相关内容

- [能带结构](/zh/tutorials/electronic/band-structure) - 电子能带结构可视化
- [DOS 模块](/zh/modules/electronic/dos) - API 参考
