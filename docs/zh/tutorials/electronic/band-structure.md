---
title: 能带结构教程
description: 如何在 CatGo 中绘制和分析电子能带结构
source: src/lib/electronic/BandPlot.svelte
---

# 能带结构教程

学习如何可视化和分析 DFT 计算得到的电子能带结构。

## 前置条件

- 已完成的 DFT 能带结构计算（VASP、Quantum ESPRESSO 等）
- 输出文件：vasprun.xml、EIGENVAL 或 HDF5 能带数据

## 步骤 1：加载能带数据

通过电子分析面板上传能带结构数据。

### 支持的格式

- VASP：`vasprun.xml`、`EIGENVAL`
- HDF5：包含能带数据数组的 `.h5` 文件
- JSON：预处理后的能带结构 JSON

## 步骤 2：配置图像

### 设置费米能级

程序会从计算输出中自动检测费米能级。你也可以在设置面板中手动调整。

### 高对称点

CatGo 会自动标注 k-path 上的高对称点。也可以通过 k 点配置设置自定义标签。

## 步骤 3：分析特征

### 带隙检测

程序会自动计算并显示带隙（直接带隙或间接带隙）。

### 轨道投影

启用轨道成分叠加后，可以用彩色 fat bands 查看 s、p、d 轨道贡献。

### D-Band 分析

对于过渡金属，程序会自动计算 d-band 中心和宽度。

## 步骤 4：导出

将图像导出为 SVG、PNG，或将处理后的数据保存为 JSON 以便进一步分析。

## 相关内容

- [DOS 分析](/zh/tutorials/electronic/dos-analysis) - 用态密度补充能带结构分析
- [COHP 分析](/zh/tutorials/electronic/cohp-analysis) - 基于电子结构的成键分析
- [能带结构模块](/zh/modules/electronic/band-structure) - API 参考
