# 相图

面向二元、三元和四元体系的热力学稳定性分析与凸包计算。

**Source:** `src/lib/phase-diagram/`

## 概述

相图展示化学体系中化合物的热力学稳定性。CatGo 通过计算凸包来判断：

- 哪些组成在热力学上稳定
- 亚稳相的高于凸包能（不稳定性度量）
- 不稳定化合物的分解路径

## 组件

| 组件 | 说明 |
|-----------|-------------|
| `PhaseDiagram2D.svelte` | 二元（A-B）和三元（A-B-C）二维相图 |
| `PhaseDiagram3D.svelte` | 三维凸包可视化 |
| `PhaseDiagram4D.svelte` | 四元（4 组分）组成空间 |
| `PhaseDiagramControls.svelte` | 图例、颜色标尺和显示选项 |
| `PhaseDiagramInfoPane.svelte` | 所选点的稳定性信息 |
| `PhaseDiagramStats.svelte` | 统计摘要 |

## 核心函数

```typescript
// Compute thermodynamic convex hull
compute_convex_hull(entries): ConvexHull

// Calculate energy above hull for each entry
compute_e_hull(entries, hull): number[]

// Sort/filter entries by composition
sort_entries_by_composition(entries): SortedEntries

// Convert to barycentric coordinates (for ternary diagrams)
barycentric_coords(composition): [number, number]

// Full thermodynamic analysis
thermodynamic_analysis(entries): ThermodynamicResult
```

## 图类型

### 二元（二维）
- x 轴：组成分数（从 A 到 B）
- y 轴：形成能（eV/atom）
- 凸包线连接稳定相
- 凸包上方的点为亚稳或不稳定相

### 三元（三角图）
- 三个顶点表示纯元素
- 三角形内部的点表示不同组成
- 按高于凸包能着色
- 连接线表示稳定相之间的 tie line

### 三维 / 四元
- 三维凸包曲面
- 四组分体系支持交互式旋转
- 支持投影视图

## 功能

- **稳定性着色** — 稳定相（在凸包上）与亚稳相（在凸包上方）
- **交互选择** — 点击点查看组成详情
- **结构预览** — 悬停预览晶体结构
- **高于凸包能** — 定量不稳定性指标（meV/atom）
- **分解信息** — 显示不稳定化合物会分解成哪些稳定相
