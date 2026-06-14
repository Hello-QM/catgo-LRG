# 密度可视化

使用三维等值面和二维切片平面可视化 CUBE 文件中的体数据。

**Source:** `src/lib/cube/`

## 概述

密度可视化模块读取包含体数据（电子密度、分子轨道、静电势）的 Gaussian/VASP CUBE 文件，并将其渲染为叠加在原子结构上的交互式三维等值面或二维截面。

## 组件

| 组件 | 说明 |
|-----------|-------------|
| `CubeViewer.svelte` | 主 cube 数据查看器 |
| `CubeScene.svelte` | 用于三维密度渲染的 Three.js 场景 |
| `CubeControls.svelte` | 等值面阈值、不透明度、颜色和切片控制 |
| `IsosurfaceMesh.svelte` | Renders the 3D isosurface mesh |
| `SlicePlane.svelte` | 穿过数据体的二维截面平面 |

## 核心函数

```typescript
// Parse CUBE file format
parse_cube_file(content: string): CubeData

// Generate isosurface mesh at a given threshold
compute_isosurface(cube_data, isovalue): IsosurfaceMesh

// Extract 2D cross-section
create_slice_plane(cube_data, plane_origin, plane_normal): SliceData
```

## CUBE File Format

CUBE 格式包含：
- 原子位置和元素
- 三维网格尺寸（nx、ny、nz）
- 网格上的体数据（每个网格点一个数值）
- 定义空间网格的原点和轴向量

## 功能

- **等值面渲染** — 固定数值处的三维曲面（例如电子密度 = 0.05）
- **可调阈值** — 用滑块改变等值面数值
- **双等值面** — 同时显示正负瓣（例如轨道）
- **不透明度控制** — 从透明到不透明的等值面
- **颜色控制** — 可自定义曲面颜色
- **切片平面** — 穿过数据体的二维颜色映射截面
- **叠加到结构上** — 等值面与原子和化学键一起渲染

## Integration

结构查看器中的 `CubePanel.svelte` 组件把密度可视化直接集成到主结构查看器中，可同时显示原子结构和体数据。

## 服务器 API

Python 服务器提供额外的 CUBE 文件处理能力：

```
GET  /api/cube/parse     — Parse CUBE file on server
POST /api/cube/process   — Process volumetric data
```
