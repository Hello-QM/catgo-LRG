---
title: 模块参考
description: 所有 CatGo 模块的 API 文档
---

# 模块参考

这里按类别整理了 CatGo 所有模块的完整参考文档。

## 核心

| 模块 | 说明 |
|--------|-------------|
| [结构查看器](/zh/modules/core/structure-viewer) | 原子、化学键和晶格的 3D 交互式可视化 |
| [文件 I/O](/zh/modules/core/file-io) | 解析和导出晶体/分子结构文件 |
| [晶格与晶胞](/zh/modules/core/lattice-cell) | 晶格参数、坐标转换和晶胞操作 |
| [键合](/zh/modules/core/bonding) | 键检测、键编辑和配位分析 |
| [设置](/zh/modules/core/settings) | 跨平台可配置属性 |

## 晶体学

| 模块 | 说明 |
|--------|-------------|
| [表面与 Slab](/zh/modules/crystallography/surfaces-slabs) | Miller 指数 slab 生成、真空层、吸附位点 |
| [对称性](/zh/modules/crystallography/symmetry) | 空间群检测、Wyckoff 位置、Bravais 晶格 |
| [超胞](/zh/modules/crystallography/supercells) | 周期晶胞扩展和变换 |

## 电子结构

| 模块 | 说明 |
|--------|-------------|
| [能带结构](/zh/modules/electronic/band-structure) | 电子能带结构绘图与分析 |
| [态密度](/zh/modules/electronic/dos) | 总 DOS 和投影 DOS 可视化 |
| [COHP](/zh/modules/electronic/cohp) | 晶体轨道 Hamilton 布居分析 |

## MD 分析

| 模块 | 说明 |
|--------|-------------|
| [径向分布](/zh/modules/md-analysis/rdf) | 径向分布函数 |
| [动力学（RMSD/RMSF）](/zh/modules/md-analysis/dynamics) | 结构偏差指标 |
| [密度剖面](/zh/modules/md-analysis/density-profile) | 空间密度分布 |
| [氢键](/zh/modules/md-analysis/hbonds) | 氢键检测与分析 |
| [聚类与 PCA](/zh/modules/md-analysis/clustering) | 轨迹聚类和降维 |

## 动力学与优化

| 模块 | 说明 |
|--------|-------------|
| [轨迹](/zh/modules/dynamics/trajectories) | MD 轨迹播放和流式加载 |
| [优化](/zh/modules/dynamics/optimization) | 使用多种计算器进行结构弛豫 |

## 分析与光谱

| 模块 | 说明 |
|--------|-------------|
| [光谱分析](/zh/modules/analysis/spectroscopy) | XRD、RDF、能带结构、态密度 |
| [相图](/zh/modules/analysis/phase-diagrams) | 热力学稳定性和凸包 |
| [组成](/zh/modules/analysis/composition) | 化学式处理和组成图表 |
| [周期表](/zh/modules/analysis/periodic-table) | 带属性数据的交互式元素浏览器 |

## 工作流

| 模块 | 说明 |
|--------|-------------|
| [工作流引擎](/zh/modules/workflow/workflow-engine) | 可视化工作流构建器和执行引擎 |
| [节点类型](/zh/modules/workflow/node-types) | 70+ 种工作流节点类型目录 |
| [作业脚本](/zh/modules/workflow/job-scripts) | HPC 作业脚本生成（SLURM、PBS） |
| [项目仪表盘](/zh/modules/workflow/project-dashboard) | 项目管理和结果可视化 |

## AI 与语言

| 模块 | 说明 |
|--------|-------------|
| [聊天系统](/zh/modules/ai/chat-system) | AI 助手架构和 LLM 集成 |
| [工作流工具](/zh/modules/ai/workflow-tools) | AI 可调用的工作流创建工具 |
| [文献导入](/zh/modules/ai/literature-import) | 论文解析和工作流生成 |

## 交互

| 模块 | 说明 |
|--------|-------------|
| [手势追踪](/zh/modules/interaction/gesture-tracking) | MediaPipe 手部追踪集成 |
| [语音控制](/zh/modules/interaction/voice-control) | 语音转文本和语音命令 |
| [Atom Art](/zh/modules/interaction/atom-art) | 语音驱动的原子放置 |

## 集成

| 模块 | 说明 |
|--------|-------------|
| [密度可视化](/zh/modules/integrations/density-visualization) | CUBE 文件等值面和切片平面 |
| [数据库集成](/zh/modules/integrations/database-integration) | OPTIMADE、Materials Project、PubChem 搜索 |

## 服务器

| 模块 | 说明 |
|--------|-------------|
| [MCP 服务器](/zh/modules/server/mcp-server) | Model Context Protocol 服务器 |
| [REST API](/zh/modules/server/rest-api) | 用于程序化访问的 HTTP API |
