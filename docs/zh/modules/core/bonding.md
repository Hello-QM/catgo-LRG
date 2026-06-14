# 键合

该模块提供自动化学键检测与分析，支持多种策略、交互式键编辑，以及配位数计算。

**源码：** `src/lib/structure/bonding.ts`、`src/lib/coordination/`

## 化学键检测策略

| 策略 | 说明 |
|----------|-------------|
| **Distance** | 当距离小于共价半径和乘以系数时判定成键 |
| **Electronegativity** | 基于距离，并加入电负性权重 |
| **VESTA** | 使用 VESTA 键长数据库进行更准确的检测 |

## 关键函数

### 键计算

```typescript
// Compute all bonds in a structure
calculate_bonding(structure, strategy?): Bond[]

// WASM-accelerated bonding (faster for large structures)
wasm_calculate_bonding(structure): Bond[]

// Get default bond length for an element pair
get_default_bond_length(elem_a, elem_b): number

// Get all bond length options for a pair
get_available_bond_lengths(elem_a, elem_b): BondLength[]
```

### 键几何

```typescript
// Compute 4x4 transform matrix for rendering a bond cylinder
compute_bond_transform(pos_a, pos_b, radius): Matrix4

// Fast bond position update after atom moves (avoids full recalculation)
update_bond_positions(bonds, new_positions): Bond[]

// Generate unique key for bond pair (avoids duplicates)
get_bond_key(index_a, index_b): string
```

### 配位分析

```typescript
// Calculate coordination number distribution
calculate_coordination(structure, bonds): CoordinationResult

// Split modes for coordination analysis
SPLIT_MODES: "by_element" | "by_structure" | "none"
```

### 邻居列表

```typescript
// WASM-accelerated neighbor finding
wasm_calculate_neighbor_list(structure, cutoff): NeighborList
```

## 键编辑

结构查看器在 **Pencil Mode > Bonds** 标签页中支持交互式键编辑。

### 创建键

可用两种方法：

- **拖拽连接** - 从一个原子点击并拖动到另一个原子。拖动过程中会有一条虚拟键跟随光标，准确显示将要创建的位置。松开到目标原子上即可确认。
- **点击-点击** - 先点击第一个原子（会出现绿色环形提示），再点击第二个原子。它适合作为不方便拖拽时的备用方式。

虚拟键预览会匹配源原子的元素颜色，并使用与真实键相同的粗细，从而提供准确预览。

### 管理键

- **选择键** - 点击已有键即可选中（黄色高亮）。Shift-click 可多选。
- **删除键** - 选中键后按 Delete 或 Backspace 删除。
- **取消** - 按 Escape 取消正在创建的键，或清空键选择。

## 配位可视化

`CoordinationBarPlot` 组件会以柱状图展示配位数分布，并支持按元素类型或结构拆分。

## 性能

- 超过 **50 个原子** 的结构使用 spatial grid，实现 O(N) 邻居搜索
- WASM 路径（`wasm_calculate_bonding`）在大结构上明显更快
- 键变换使用实例化渲染，以提高 GPU 使用效率

## 键数据结构

```typescript
interface Bond {
  from: number      // Atom index A
  to: number        // Atom index B
  from_pos: number[] // Position of atom A [x, y, z]
  to_pos: number[]   // Position of atom B [x, y, z]
  length: number     // Bond length in Angstroms
  order?: number     // Bond order (if available)
}
```
