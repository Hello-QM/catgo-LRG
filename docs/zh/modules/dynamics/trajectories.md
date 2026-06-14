# 轨迹与分子动力学

播放、分析并导出多种文件格式的分子动力学轨迹。

**Source:** `src/lib/trajectory/`

## 支持的格式

| 格式 | 扩展名 | 说明 |
|--------|-----------|-------------|
| XYZ | `.xyz` | 多帧 XYZ（帧之间用 header 分隔） |
| Extended XYZ | `.extxyz` | 包含晶格和属性的多帧格式 |
| ASE Trajectory | `.traj` | ASE 原生二进制格式 |
| XDATCAR | `XDATCAR` | VASP 分子动力学输出 |
| HDF5 | `.hdf5`, `.h5` | 层次化数据格式（多帧） |

## 核心函数

### 加载

```typescript
// Load trajectory from file
load_trajectory_file(content, filename): Trajectory

// Validate trajectory data
validate_trajectory(trajectory): ValidationResult

// Get trajectory metadata
get_trajectory_stats(trajectory): TrajectoryStats
```

### 流式读取与索引

对于大型轨迹文件（>100 MB），该模块支持索引访问：

```typescript
// Build index for random frame access (avoids reading entire file)
build_frame_index(content, format): FrameIndex[]

// FrameIndex contains byte offsets for fast seeking
interface FrameIndex {
  byte_offset: number
  estimated_size: number
}
```

## 组件

| 组件 | 说明 |
|-----------|-------------|
| `Trajectory.svelte` | 带动画控制的主轨迹播放器 |
| `TrajectoryInfoPane.svelte` | 帧数、时长和属性元数据 |
| `TrajectoryExportPane.svelte` | 导出单帧或帧范围 |
| `TrajectoryError.svelte` | 无效轨迹的错误显示 |

## 播放控制

- **播放/暂停** — 按帧播放动画
- **帧滑块** — 拖动到任意帧
- **FPS 控制** — 调整播放速度
- **前进/后退一步** — 单帧步进
- **循环模式** — 连续循环播放

## 可视化模式

轨迹查看器可以与分析图并排显示：

- **结构 + 散点图** — 三维结构与逐帧属性散点图
- **结构 + 直方图** — 三维结构与属性分布直方图

可绘制的属性包括：
- 每帧能量
- 力（最大值、平均值）
- 温度
- 应力/压力
- 自定义逐帧属性（来自 EXTXYZ）

## 设置

| 设置项 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `trajectory_fps` | number | 10 | 播放速度（帧/秒） |
| `trajectory_auto_play` | boolean | false | 加载后自动播放 |
| `trajectory_display_mode` | string | "structure" | 显示布局模式 |

## 性能

- **帧索引**支持随机访问 GB 级轨迹文件
- 二进制格式（`.traj`、`.h5`）比文本格式（`.xyz`）更节省内存
- 对 gzip 压缩轨迹进行懒解压
- 只把当前帧的原子位置发送到 GPU
