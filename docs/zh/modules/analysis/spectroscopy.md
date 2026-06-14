# 光谱与电子结构

X 射线衍射图谱、径向分布函数、能带结构、态密度以及 Brillouin 区可视化。

**源码：** `src/lib/xrd/`、`src/lib/rdf/`、`src/lib/bands/`、`src/lib/brillouin/`

## X 射线衍射（XRD）

从晶体结构计算粉末 XRD 图谱。

### 关键函数

```typescript
// Calculate XRD pattern for a structure
calculate_xrd_pattern(structure, radiation?): XrdPattern

// Compare XRD patterns across multiple structures
calculate_xrd_structure(structures, radiation?): XrdComparison
```

### 辐射源

| 来源 | 波长（A） |
|--------|---------------|
| Cu Ka | 1.5406 |
| Mo Ka | 0.7107 |
| Ag Ka | 0.5609 |
| W La | 1.4764 |

### 组件

`XrdPlot.svelte` - 交互式 XRD 图谱显示，支持峰标签、2-theta 范围选择和多结构叠加。

---

## 径向分布函数（RDF）

计算用于结构分析的成对相关函数 g(r)。

### 关键函数

```typescript
// RDF for a specific element pair
calculate_rdf(structure, options): RdfResult

// All pair RDFs at once
calculate_all_pair_rdfs(structure, options): Map<string, RdfResult>
```

### 选项

```typescript
interface RdfOptions {
  cutoff: number          // Maximum distance (A)
  bins: number            // Number of histogram bins
  center_species?: string // Central element filter
  neighbor_species?: string // Neighbor element filter
  use_pbc: boolean        // Apply periodic boundary conditions
}
```

### 组件

`RdfPlot.svelte` - g(r) 随距离变化的折线图，支持元素对选择和平滑。

---

## 能带结构

沿高对称路径可视化电子能带结构 E(k)。

### 组件

| 组件 | 说明 |
|-----------|-------------|
| `Bands.svelte` | 能带结构 E(k) 折线图 |
| `Dos.svelte` | 态密度图 |
| `BandsAndDos.svelte` | 并排显示能带 + DOS |
| `BrillouinBandsDos.svelte` | Brillouin 区 + 能带 + DOS 的组合视图 |

### 数据格式

```typescript
interface BandData {
  kpoints: number[][]      // k-point coordinates
  eigenvalues: number[][]  // Energy values per band per k-point
  efermi: number           // Fermi energy (eV)
  labels: string[]         // High-symmetry point labels (Gamma, X, M, etc.)
  label_positions: number[] // x-coordinates of labels
}

interface DosData {
  energies: number[]       // Energy grid (eV)
  densities: number[]      // DOS values
  efermi: number           // Fermi energy (eV)
}
```

---

## Brillouin 区

交互式 3D 可视化第一 Brillouin 区，并显示高对称点和 k 路径。

### 关键函数

```typescript
// Compute reciprocal lattice vectors
compute_reciprocal_lattice(lattice_matrix): number[][]

// Compute Brillouin zone polyhedron
compute_brillouin_zone(reciprocal_lattice): BrillouinZone

// Identify high-symmetry k-points
compute_high_symmetry_points(lattice_type): HighSymmetryPoints

// Get k-path coordinates for band structure
get_path_coords(bz, path_labels): PathCoords
```

### 组件

| 组件 | 说明 |
|-----------|-------------|
| `BrillouinZone.svelte` | 主 3D 查看器 |
| `BrillouinZoneScene.svelte` | 带区面、边和 k 点的 Three.js 场景 |
| `BrillouinZoneControls.svelte` | 切换面、边、标签和路径 |
| `BrillouinZoneInfoPane.svelte` | 倒易晶格参数 |
| `BrillouinZoneExportPane.svelte` | 导出可视化结果 |

### 功能

- 透明多面体渲染
- 高对称点标签（Gamma、X、M、R、K、L 等）
- 沿 Brillouin 区的 k 路径可视化
- 交互式旋转和缩放
- 与能带结构和 DOS 的组合视图
