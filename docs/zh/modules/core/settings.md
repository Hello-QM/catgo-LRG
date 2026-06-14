# 设置

统一设置 schema 包含 40+ 个可配置属性，并应用于所有部署目标。

**源码：** `src/lib/settings.ts`

## 概览

所有可配置项都集中定义在 `settings.ts` 中，包括类型、说明、最小/最大值和默认值。Web 应用、VSCode 扩展、桌面应用和 Jupyter widget 共用同一套 schema。

## 按类别划分的设置

### 原子显示

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `atom_radius` | number | 0.4 | 原子球半径（A） |
| `sphere_segments` | number | 16 | 球体质量（越大越平滑） |
| `color_mode` | string | "element" | 着色方式：element、coordination、wyckoff、custom |
| `color_scale` | string | "Jmol" | 元素着色所用色标 |
| `show_image_atoms` | boolean | true | 显示 PBC 镜像原子 |

### 化学键显示

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `show_bonds` | boolean | true | 显示化学键 |
| `bond_thickness` | number | 0.15 | 键圆柱体半径 |
| `bonding_strategy` | string | "distance" | 策略：distance、electronegativity、VESTA |

### 标签

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `show_site_labels` | boolean | false | 显示原子标签 |
| `show_indices` | boolean | false | 显示原子索引号 |
| `label_color` | string | "white" | 标签文字颜色 |
| `label_size` | number | 14 | 标签字体大小（px） |
| `label_offset` | number[] | [0, 0] | 标签位置偏移 |

### 相机

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `camera_projection` | string | "perspective" | 投影：perspective、orthographic |
| `camera_fov` | number | 50 | 视场角（度） |
| `zoom_min` | number | 1 | 最小缩放距离 |
| `zoom_max` | number | 1000 | 最大缩放距离 |
| `rotation_damping` | number | 0.2 | 旋转平滑系数 |
| `auto_rotate` | boolean | false | 自动旋转模式 |

### 晶格 / 晶胞

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `show_cell` | boolean | true | 显示晶胞线框 |
| `show_cell_vectors` | boolean | true | 显示晶格矢量箭头 |
| `cell_opacity` | number | 1.0 | 晶胞边透明度 |

### 光照

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `ambient_light` | number | 0.5 | 环境光强度 |
| `directional_light` | number | 0.8 | 方向光强度 |
| `depth_cueing` | number | 0 | 雾化效果强度（0 表示关闭） |

### 控制

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `rotation_speed` | number | 1.0 | 鼠标旋转灵敏度 |
| `zoom_speed` | number | 1.0 | 滚轮缩放灵敏度 |
| `pan_speed` | number | 1.0 | 中键平移灵敏度 |

### 轨迹

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `trajectory_fps` | number | 10 | 播放速度（帧/秒） |
| `trajectory_auto_play` | boolean | false | 加载后自动播放 |
| `trajectory_display_mode` | string | "structure" | 布局模式 |

### 对称性

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `symprec` | number | 0.01 | 对称性容差（A） |
| `symmetry_algorithm` | string | "moyo" | 后端：moyo、spglib |

### 原子操作

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `keyboard_step_size` | number | 0.1 | 方向键移动距离（A） |
| `frozen_atom_indicator` | string | "ring" | 视觉样式：ring、crosshatch、dimmed |

## 平台上下文

设置可以限定到特定部署上下文：

| 上下文 | 说明 |
|---------|-------------|
| `web` | 浏览器 Web 应用 |
| `editor` | VSCode 扩展 |
| `notebook` | Jupyter / Marimo 小组件 |
| `all` | 所有平台（默认） |

## 设置 Schema

每个设置按下面的结构定义：

```typescript
{
  key: string           // Setting identifier
  type: "number" | "string" | "boolean"
  default: any          // Default value
  description: string   // Human-readable description
  min?: number          // Minimum (for numbers)
  max?: number          // Maximum (for numbers)
  options?: string[]    // Valid values (for enums)
  context?: string[]    // Platform contexts
}
```

## 持久化

- **Web app** - 设置存储在 `localStorage`
- **Desktop app** - 设置通过 Tauri IPC 持久化，重启后保留
- **VSCode** - 设置位于 VSCode 工作区/用户配置
- **Jupyter** - 设置作为 widget props 传入
