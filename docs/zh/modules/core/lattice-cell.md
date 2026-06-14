# 晶格与晶胞操作

用于处理晶格参数、坐标转换和晶胞操作的函数。

**Source:** `src/lib/structure/lattice-ops.ts`, `src/lib/structure/pbc.ts`

## 晶格表示

晶格以 3x3 矩阵存储，其中**行向量为晶格矢量**（pymatgen 约定）：

```
matrix = [
  [a1, a2, a3],   // a-vector
  [b1, b2, b3],   // b-vector
  [c1, c2, c3]    // c-vector
]
```

分数坐标到笛卡尔坐标转换：`xyz = M^T * abc`

## 核心函数

### 参数转换

```typescript
// Convert lattice parameters to 3x3 matrix
params_to_matrix(a, b, c, alpha, beta, gamma): number[][]

// Extract lattice parameters from matrix
matrix_to_params(matrix): { a, b, c, alpha, beta, gamma }
```

### 坐标转换

```typescript
// Cartesian (xyz) to fractional (abc) coordinates
cartesian_to_fractional(xyz, lattice_matrix): number[]

// Fractional (abc) to Cartesian (xyz) coordinates
fractional_to_cartesian(abc, lattice_matrix): number[]
```

### Cell Manipulation

```typescript
// Update specific lattice parameters
update_lattice_params(structure, { a?, b?, c?, alpha?, beta?, gamma? }): Structure

// Apply a 3x3 transformation matrix to the lattice
apply_transform_matrix(structure, transform): Structure

// Rotate/scale/shear lattice
transform_lattice(structure, matrix): Structure

// Ensure right-handed coordinate system
ensure_right_handed(lattice_matrix): number[][]
```

### Vacuum & Bounding Box

```typescript
// Add vacuum layer along a direction (for slab preparation)
add_vacuum_layer(structure, vacuum_thickness, direction): Structure

// Wrap a molecule in an orthogonal bounding box
wrap_molecule_in_box(structure, padding): Structure
```

### 周期性边界条件

```typescript
// Wrap fractional coordinates to [0, 1) range
wrap_to_unit_cell(structure): Structure

// Find atoms near cell edges that need periodic images
find_image_atoms(structure, tolerance): ImageAtom[]

// Generate PBC image atoms for visualization
get_pbc_image_sites(structure): Site[]
```

## 交互式晶格编辑

**LatticePane** 组件（`LatticePane.svelte`）提供编辑晶格参数的界面：

- 直接输入 a、b、c（单位 Angstrom）以及 alpha、beta、gamma（单位度）
- 实时更新三维可视化
- 应用变换矩阵
- Volume display

## 约定

- **晶格矩阵的行**为晶格矢量（pymatgen 约定）
- **角度**在用户界面中使用度，内部使用弧度
- **Lengths** are in Angstroms
- 强制使用右手坐标系 — `(a x b) . c > 0`
