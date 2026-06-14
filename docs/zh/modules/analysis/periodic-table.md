# 元素周期表

交互式周期表浏览器，支持按属性着色，并提供全部 118 种元素的完整数据。

**Source:** `src/lib/periodic-table/`, `src/lib/element/`

## 组件

| 组件 | 说明 |
|-----------|-------------|
| `PeriodicTable.svelte` | 完整交互式周期表 |
| `PeriodicTableControls.svelte` | 属性选择器和颜色标尺控制 |
| `PropertySelect.svelte` | 用于选择显示属性的下拉框 |
| `TableInset.svelte` | 图例/颜色标尺嵌入视图 |
| `ElementTile.svelte` | 显示元素符号和值的单个元素格 |

## Element Detail 组件

| 组件 | 说明 |
|-----------|-------------|
| `ElementHeading.svelte` | 元素名称、符号和原子序数 |
| `ElementPhoto.svelte` | 元素外观图片 |
| `ElementStats.svelte` | 包含完整数据的属性表 |
| `BohrAtom.svelte` | Bohr 原子模型示意图 |
| `Nucleus.svelte` | 原子核可视化 |

## Element Database

元素数据库（`src/lib/element/data.ts`）包含全部 118 种元素的完整数据：

### 可用属性

| Category | Properties |
|----------|-----------|
| **身份信息** | 元素符号、名称、原子序数 |
| **Mass** | Atomic mass (u) |
| **半径** | 原子半径、共价半径、离子半径（A） |
| **Electronegativity** | Pauling scale |
| **位置** | 周期（行）、族（列）、区块（s/p/d/f） |
| **分类** | 金属、非金属、类金属、稀有气体、卤素、过渡金属、镧系、锕系、碱金属、碱土金属 |
| **物理性质** | 熔点、沸点、密度、比热 |
| **电子性质** | 电子排布、电离能、电子亲和能 |
| **发现历史** | 发现者、发现年份 |
| **外观** | 描述和颜色 |

## 功能

- **按属性着色** — 根据任意数值属性给元素着色（电负性、原子半径、密度等）
- **颜色标尺** — viridis、plasma、turbo 以及其他 D3 颜色插值器
- **点击选择** — 查看完整元素详情
- **悬停提示** — 快速预览属性
- **类别高亮** — 高亮元素类别（金属、非金属等）
- **响应式布局** — 适配容器尺寸
