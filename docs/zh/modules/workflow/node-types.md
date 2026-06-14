---
title: Node Types
description: CatGo 可用工作流节点类型目录
source: src/lib/workflow/node-definitions.ts
---

# 工作流节点类型

**Source:** `src/lib/workflow/node-definitions.ts`

## 概述

CatGo 的工作流引擎提供 70 多种节点类型，用于构建计算材料科学工作流。节点按功能分类。

## 结构节点

### 结构输入
从文件、数据库或手动输入加载结构。

### 结构变换
超胞生成、slab 切割、坐标变换。

### 结构筛选
按组成、对称性或性质筛选结构。

## 计算节点

### DFT Setup
配置 DFT 计算（VASP、QE、CP2K）。

### ML Potential
使用机器学习势（MACE、CHGNet、M3GNet）运行计算。

### 优化
使用可配置计算器进行几何弛豫。

### 分子动力学
MD 模拟配置与执行。

## 分析节点

### 电子结构
能带结构、DOS、COHP 计算。

### 性质计算
能量、力、应力、带隙、磁矩。

### 热力学
相稳定性、形成能、凸包。

## I/O Nodes

### File Reader
读取多种输入文件格式。

### File Writer
以可配置格式写出结果。

### 数据库查询
搜索 OPTIMADE、Materials Project、PubChem。

## 控制流节点

### Loop
遍历参数范围或结构列表。

### Conditional
根据计算性质进行分支。

### Aggregator
收集并行分支的结果。

## 相关内容

- [工作流引擎](/zh/modules/workflow/workflow-engine)
- [作业脚本](/zh/modules/workflow/job-scripts)
- [工作流教程](/zh/tutorials/workflows/workflows)
