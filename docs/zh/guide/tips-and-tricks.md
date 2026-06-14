# 技巧与提示

这里整理了一些实用建议，帮助你更好地使用 CatGo。

## 键盘快捷键参考

### 相机

| 按键 | 操作 |
|-----|--------|
| 方向键 | 旋转结构（俯仰和偏航） |
| W / S | 滚转结构（逆时针 / 顺时针） |
| R | 重置到与晶格对齐的相机视图 |
| F | 切换全屏 |

### 选择与编辑

| 按键 | 操作 |
|-----|--------|
| Click | 选择原子 |
| Shift+Click | 添加/移除选择中的原子 |
| Double-click | 清空选择 |
| Delete / Backspace | 删除选中的原子、化学键或测量 |
| Ctrl+Z / Cmd+Z | 撤销 |
| Ctrl+Shift+Z / Cmd+Shift+Z | 重做 |
| Drag atom-to-atom (bond mode) | 在两个原子之间创建键，并显示虚拟键预览 |
| Escape (bond mode) | 取消正在拖拽创建的键，或清空键选择 |

### 原子操作

| 按键 | 操作 |
|-----|--------|
| Arrow keys (with selection) | 按步长移动选中原子（默认 0.1 A） |
| Shift+Arrow keys | 按 10 倍步长移动选中原子 |
| Shift+Alt+Drag | 不先点击也可拖动选中原子 |
| Shift+Drag (left button) | 旋转选中原子（pitch/yaw） |
| Shift+Drag (right button) | 滚转选中原子 |
| X / Y / Z | 按住键时将旋转锁定到对应轴 |

### 界面

| 按键 | 操作 |
|-----|--------|
| I | 切换信息面板 |
| Escape | 按优先级关闭面板 / 退出模式 |
| Ctrl+Enter / Cmd+Enter | 从粘贴弹窗导入 |

### 轨迹播放

| 按键 | 操作 |
|-----|--------|
| Space | 播放 / 暂停 |
| A / D | 上一帧 / 下一帧 |
| Ctrl+A / Ctrl+D | 跳到第一帧 / 最后一帧 |
| J / L | 后退 / 前进 10 帧 |
| PageUp / PageDown | 后退 / 前进 25 帧 |
| 0-9 | 跳到轨迹百分比位置 |
| + / - | 提高 / 降低播放速度 |

## 鼠标控制

| 操作 | 鼠标 |
|--------|-------|
| 旋转 | 左键拖动 |
| 滚转 | 右键拖动 |
| 缩放 | 滚轮 |
| 平移 | Shift+拖动 或 Ctrl/Cmd+拖动 |
| 选择原子 | 点击 |
| 多选 | Shift+点击 |
| 清空选择 | 双击背景 |

## 性能技巧

### 大结构（>1000 原子）

- **降低球体分段数** - 在设置中降低 `sphere_segments`（默认 20；大体系可尝试 12-16）
- **关闭化学键** - 对键检测较慢的大结构，把 `show_bonds` 设为 "never"
- **关闭镜像原子** - 如果不需要 PBC 可视化，关闭 `show_image_atoms`
- **使用等尺寸原子** - 启用 `same_size_atoms` 简化渲染

### 大轨迹

- **索引式加载** 会对超过 25 MB（文本）或 50 MB（二进制）的文件自动启用
- **降低 FPS** - 如果掉帧，降低播放速度
- **增大 chunk size** - 更大的 `chunk_size` 会加快解析，但会占用更多内存
- **限制内存帧数** - 根据可用 RAM 调整 `max_frames_in_memory`

### 渲染质量与速度

| 设置 | 性能 | 质量 |
|---------|-------------|---------|
| `sphere_segments` 12 | 快 | 球体略有棱角 |
| `sphere_segments` 20 | 默认 | 质量较好 |
| `sphere_segments` 48 | 慢 | 球体平滑 |
| `depth_cueing` 0 | 无额外开销 | 无雾化 |
| `depth_cueing` 0.5 | 少量额外开销 | 轻微深度感 |

## 自定义

### 原子颜色

CatGo 提供六种内置配色：

| 配色 | 风格 |
|--------|-------|
| **Vesta** | 行业标准（默认） |
| **Jmol** | Jmol 分子查看器颜色 |
| **Alloy** | 金属风格色板 |
| **Pastel** | 柔和、低饱和颜色 |
| **Muted** | 去饱和色调 |
| **Dark Mode** | 为深色背景优化 |

如需按元素自定义颜色，将 `atom_color_mode` 设为 "custom"，并在图例面板中分配颜色。

### 按属性着色

可将 `atom_color_mode` 切换为按下列属性为原子着色：

- **Element** - 标准周期表颜色
- **Coordination number** - 成键邻居数量
- **Wyckoff position** - 对称等价位点

色标（`atom_color_scale`）可以设置为任意 D3 interpolation function（viridis、plasma、inferno、magma 等）。

### 背景

- 将 `background_color` 设为任意十六进制颜色
- 将 `background_opacity` 设为 0 可获得透明背景，适合叠加到幻灯片上

### 标签

- 启用 `show_site_labels` 可在原子上显示元素符号
- 启用 `show_site_indices` 可显示索引号
- 调整 `site_label_size`、`site_label_color` 和 `site_label_offset` 可控制位置和样式

## 导出技巧

### 发表级图片

1. 将 `background_opacity` 设为 0（透明）或 1（纯白/纯黑）
2. 将 `sphere_segments` 提高到 48，让球体更平滑
3. 调整 `atom_radius` 到合适的视觉权重
4. 导出为 **GLB** 或 **OBJ**，用于 Blender、PowerPoint 或其他渲染软件
5. 也可以直接从全屏查看器截图

### VASP 工作流

1. 从 OPTIMADE 导入 CIF，或从文件加载结构
2. 使用 slab cutter 创建表面
3. 使用 pencil mode 或 adsorption site finder 添加吸附物
4. 导出为 POSCAR，直接用于 VASP

### 批处理

对于大量结构，可以使用 CatGo 与 pymatgen 兼容的 JSON 格式：

1. 将结构导出为 JSON
2. 使用 Python/pymatgen 脚本处理
3. 重新导入结果

## 常见工作流

### 表面催化设置

1. 导入体相催化剂（例如来自 OPTIMADE 的 Pt）
2. 用 Miller slab cutter 切出 (111) slab
3. 构建 2x2x1 超胞以获得足够表面积
4. 寻找吸附位点（atop、bridge、hollow）
5. 使用 pencil mode 添加吸附分子
6. 冻结底部 2 层
7. 使用 MACE 或 CHGNet 优化
8. 导出为 POSCAR，用于生产级 DFT

### 快速结构检查

1. 拖放 CIF/POSCAR 文件
2. 按 **I** 查看化学式、空间群、晶格参数
3. 切换化学键和晶胞显示，检查结构
4. 如有需要，导出为其他格式

## 键合策略

CatGo 提供三种键检测方法：

| 策略 | 说明 | 适合场景 |
|----------|-------------|----------|
| **Solid angle** | 几何 solid angle 判据（默认） | 通用场景 |
| **Electronegativity ratio** | 基于 Pauling 电负性差异 | 离子/共价材料 |
| **Atomic radii** | 共价半径和加容差 | 简单分子 |

如果键显示不正确，可以尝试在设置中切换键合策略。

## 对称性算法

空间群检测提供两种算法：

| 算法 | 说明 |
|-----------|-------------|
| **Moyo**（默认） | 现代对称性查找器，对多数结构准确 |
| **Spglib** | 经典算法，兼容性更广 |

如果检测到的空间群看起来不正确，可以调整 `symmetry.symprec`（默认 1e-4）。更宽松的容差会找到更高对称性。
