# 超胞

通过沿晶格方向复制晶胞来扩展周期结构。

**Source:** `src/lib/structure/lattice-ops.ts`, `src/lib/structure/ferrox-wasm.ts`

## 概述

超胞生成会把原始晶胞扩展为 n x m x p，并复制所有原子、相应缩放晶格。常用于：

- 为 DFT 或 MD 创建更大的模拟胞
- 可视化扩展晶体结构
- 构建低缺陷浓度的缺陷超胞

## 核心函数

```typescript
// Generate n x m x p supercell
generate_supercell_struct(structure, nx, ny, nz): Structure

// Apply arbitrary transformation matrix (3x3)
get_supercell_structure(structure, transform_matrix): Structure
```

## Interactive UI

**CellSelect** 组件提供简单的超胞尺寸选择器：

- 输入 n、m、p（沿 a、b、c 的重复次数）
- 一键生成超胞
- 超胞扩展后相机会自动重新对齐

## How It Works

1. 缩放晶格矩阵：`new_lattice = diag(n, m, p) * original_lattice`
2. 对每个分数坐标为 `(fa, fb, fc)` 的原始原子：
   - 为 `i=0..n-1`、`j=0..m-1`、`k=0..p-1` 生成位于 `((fa + i)/n, (fb + j)/m, (fc + k)/p)` 的副本
3. 保留所有原子属性（元素、占位率、电荷）

## 变换矩阵

对于非对角扩展（例如旋转晶胞），使用变换矩阵方法：

```typescript
// Example: 2x2x1 supercell with 45-degree rotation
const transform = [
  [1, 1, 0],
  [-1, 1, 0],
  [0, 0, 1]
]
get_supercell_structure(structure, transform)
```

新晶格为 `M * old_lattice`，原子位置也会相应映射。
