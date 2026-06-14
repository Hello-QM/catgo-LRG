---
title: Clustering & PCA
description: 轨迹聚类与降维分析模块
source: src/lib/md/MdClusteringPanel.svelte
---

# 聚类与 PCA

**Source:** `src/lib/md/MdClusteringPanel.svelte`

## 概述

基于结构相似性对 MD 轨迹帧进行聚类，并通过 PCA 降维，以识别不同构象状态。

## 组件

### MdClusteringPanel

用于配置聚类和 PCA 的交互式面板。

## Algorithms

### K-Means

基于结构描述符将帧划分为 k 个簇。

### DBSCAN

基于密度的聚类方法，可自动确定簇数量。

### Hierarchical

带树状图可视化的凝聚层次聚类。

## PCA

### 主成分分析

将高维轨迹数据投影到捕获最大方差的正交主成分上。

### 可视化

在 PC1-PC2 空间中绘制帧的二维散点图，并按簇分配着色。

## 服务器 API

**Endpoint:** `POST /api/md/clustering`

## 相关内容

- [聚类教程](/zh/tutorials/md-analysis/clustering-pca)
- [动力学模块](/zh/modules/md-analysis/dynamics)
