# 对称性

使用 WASM 加速算法进行空间群检测、Wyckoff 位置识别和对称性分析。

**Source:** `src/lib/symmetry/`

## Algorithms

提供两个对称性后端，二者都编译为 WASM：

| Algorithm | Package | Description |
|-----------|---------|-------------|
| **Moyo** | `@spglib/moyo-wasm` | 现代 Rust 重新实现，推荐使用 |
| **Spglib** | spglib（通过 WASM） | 经典 C 库，广泛使用的参考实现 |

## 核心函数

### 空间群检测

```typescript
// Analyze structure symmetry (space group, point group, crystal system)
analyze_structure_symmetry(structure, algorithm?, tolerance?): SymmetryResult

// Get space group from structure
wasm_get_spacegroup(structure): SpaceGroupInfo
```

### Wyckoff Positions

```typescript
// Identify Wyckoff positions for all atoms
wyckoff_positions_from_moyo(structure): WyckoffResult[]

// Map Wyckoff positions to display atoms (including image atoms)
map_wyckoff_to_all_atoms(wyckoff_result, num_display_atoms): WyckoffMap
```

### 对称操作

```typescript
// Apply symmetry operations to generate equivalent positions
apply_symmetry_operations(structure, operations): Site[]

// Initialize WASM module (called once)
ensure_moyo_wasm_ready(): Promise<void>

// Serialize structure for symmetry analysis
to_cell_json(structure): CellJSON
```

## Symmetry Result

```typescript
interface SymmetryResult {
  spacegroup_number: number      // International Tables number (1-230)
  spacegroup_symbol: string      // Hermann-Mauguin symbol (e.g., "Fm-3m")
  point_group: string            // Point group symbol
  crystal_system: string         // cubic, hexagonal, tetragonal, etc.
  bravais_lattice: string        // P, I, F, A, B, C, R
  wyckoff_positions: WyckoffSite[]
}
```

## Wyckoff Display

Wyckoff 位置可用于结构查看器中的原子着色：
- 每个唯一 Wyckoff 位点使用不同颜色
- `color_mode: "wyckoff"` 设置会启用该模式
- 有助于直观识别对称等价原子

## Bravais Lattices

该模块可识别全部 14 种 Bravais 晶格类型：

| Symbol | Type |
|--------|------|
| P | Primitive |
| I | Body-centered |
| F | Face-centered |
| A, B, C | Base-centered |
| R | Rhombohedral |

## 设置

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `symprec` | number | 0.01 | 对称性精度容差（Angstrom） |
| `symmetry_algorithm` | string | "moyo" | Backend: "moyo" or "spglib" |

## 组件

- **SymmetryStats.svelte** — 显示空间群、点群和晶系
- **WyckoffTable.svelte** — Wyckoff 位置表，包含重数、字母和位点对称性
