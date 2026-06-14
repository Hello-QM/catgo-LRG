# 组成

化学式处理、元素分析与组成可视化。

**Source:** `src/lib/composition/`

## 概述

组成模块提供结构化学组成的分析与展示工具，支持多种图表类型和化学式格式化选项。

## 核心函数

```typescript
// Get element amounts from structure
get_elem_amounts(structure): Record<string, number>

// Format chemical formula with HTML subscripts
format_chemical_formula(composition): string

// Sort elements alphabetically
alphabetical_formula(composition): string

// Sort by electronegativity
electro_neg_formula(composition): string

// Get unique element list
get_elements(structure): string[]

// WASM-accelerated composition analysis
wasm_get_composition(structure): Composition
```

## 可视化 组件

| 组件 | 说明 |
|-----------|-------------|
| `Composition.svelte` | 主要组成显示容器 |
| `BarChart.svelte` | 元素比例水平条形图 |
| `BubbleChart.svelte` | 按元素含量缩放的气泡图 |
| `PieChart.svelte` | 组成饼图 |
| `Formula.svelte` | 格式化化学式渲染 |

## Chart 功能

- 元素颜色遵循 CPK/Jmol 约定
- 悬停提示显示精确含量和百分比
- 提供多种图表类型以适应不同可视化偏好
- Responsive sizing
