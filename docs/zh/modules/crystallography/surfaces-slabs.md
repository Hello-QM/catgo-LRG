# 表面与 Slab

使用 Miller 指数从体相晶体生成表面 slab，添加真空层，并查找吸附位点。

**Source:** `src/lib/structure/miller-slab.ts`, `src/lib/structure/ferrox-wasm.ts`

## 概述

slab 切割器接收体相晶体，并通过以下步骤创建表面 slab：

1. 指定 Miller 指数（h, k, l）以定义表面取向
2. 设置 slab 厚度（层数）
3. 添加真空层，以便在周期性计算中分隔表面

提供两条代码路径：
- **预览（JS）** — 用于实时可视化的快速 JavaScript 预览
- **应用（WASM）** — 通过 Rust/WASM 生成最终完整 slab

## 核心函数

### Miller 指数工具

```typescript
// Normalize Miller indices by dividing by GCD
normalize_miller(h, k, l): [number, number, number]

// Validate that at least one index is non-zero
validate_miller(h, k, l): boolean

// Convert Miller indices to surface normal in Cartesian coordinates
miller_to_normal(h, k, l, lattice_matrix): number[]
```

### Slab 生成

```typescript
// JavaScript preview pipeline (fast, approximate)
generate_slab_pipeline(structure, miller, thickness, vacuum): SlabPreview

// Full WASM slab generation (accurate, final output)
wasm_generate_slab(structure, miller, min_thickness, min_vacuum): Structure

// Generate slab from configuration object
generate_slab_from_config(structure, config): Structure
```

### 晶格手性

```typescript
// Ensure slab lattice is right-handed: (a x b) . z > 0
ensure_slab_right_handed(a_vec, b_vec): { a: number[], b: number[] }
```

### 原子可见性

```typescript
// Compute per-atom visibility for animated cutting preview
get_atom_visibility(structure, cutting_plane): number[]
```

## 交互式 Slab 切割器

**MillerSlabCutterPane** 组件提供以下界面：

- **Miller 指数输入** — h、k、l 字段
- **厚度控制** — 最小 slab 厚度，单位 Angstrom
- **真空层控制** — 真空层厚度
- **实时预览** — 在结构上叠加显示切割平面
- **应用** — 生成最终 slab 并替换当前结构

### 切割平面可视化器

`CuttingPlaneVisualizer` 渲染半透明平面，用来显示表面切割晶体的位置。平面使用 `center + n*(d - c_proj)` 定位，以便居中到晶体上。

## 吸附位点

**AdsorptionSitePane** 使用 ray-casting 查找表面吸附位点：

- **Atop** — 位于表面原子正上方
- **Bridge** — 位于两个表面原子之间
- **Hollow** — 位于 3 个及以上表面原子中心上方

位点会放置在距表面约一个共价半径的位置。

## Data Flow

```
Structure.svelte
  ├── passes `structure` to MillerSlabCutterPane (editing)
  ├── passes `displayed_structure` to StructureScene (rendering)
  │   └── includes PBC image atoms from get_pbc_image_sites()
  └── cutting_atom_visibility computed from original structure only
```

## 真空层

```typescript
// Add vacuum along a lattice direction
add_vacuum_layer(structure, thickness, direction): Structure

// Interactive vacuum box modal
VacuumBoxModal.svelte  // Add vacuum in any direction(s)
```

## 约定

- slab 生成后始终强制使用右手晶格
- WASM 路径在修正手性时会调整分数 b 坐标（取负并 wrap）
- 表面法向由倒易晶格矢量计算
