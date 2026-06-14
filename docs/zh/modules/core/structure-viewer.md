# 结构查看器

结构查看器是 CatGo 中最大的模块，用于对晶体结构、分子和表面进行交互式 3D 可视化。

**源码：** `src/lib/structure/`

## 组件

### 核心

| 组件 | 说明 |
|-----------|-------------|
| `Structure.svelte` | 主协调器，负责管理状态、控制器，并把数据传给 3D 场景 |
| `StructureScene.svelte` | Three.js 场景，负责渲染原子、化学键、晶格、标签，并处理射线拾取 |
| `StructureControls.svelte` | 控制面板，提供化学键、标签、晶格、相机等开关 |
| `StructureLegend.svelte` | 原子类型颜色图例 |
| `StructureInfoPane.svelte` | 显示化学式、空间群、密度等元数据 |

### 几何基础组件

| 组件 | 说明 |
|-----------|-------------|
| `Bond.svelte` | 用圆柱体渲染两个原子之间的化学键 |
| `Cylinder.svelte` | 通用圆柱体基础组件，被化学键和箭头复用 |
| `Arrow.svelte` | 用于力矢量（MD/优化）的箭头 |
| `Lattice.svelte` | 晶胞线框边和晶格矢量 |

### 面板与控制

| 组件 | 说明 |
|-----------|-------------|
| `LatticePane.svelte` | 编辑晶格参数（a、b、c、alpha、beta、gamma） |
| `ExportPane.svelte` | 导出 CIF、POSCAR、XYZ、EXTXYZ、JSON、GLB、OBJ 格式 |
| `MillerSlabCutterPane.svelte` | 根据 Miller 指数生成表面 slab |
| `CuttingPlaneVisualizer.svelte` | 显示切割平面的可视化预览 |
| `OptimizationPane.svelte` | 连接优化服务器进行结构弛豫 |
| `AdsorptionSitePane.svelte` | 在表面上寻找吸附位点 |
| `CubePanel.svelte` | 集成来自 CUBE 文件的密度可视化 |
| `CellSelect.svelte` | 超胞维度选择器（n x m x p） |

### 弹窗

| 组件 | 说明 |
|-----------|-------------|
| `OptimadeSearchModal.svelte` | 搜索 OPTIMADE 结构数据库 |
| `OptimadePreviewModal.svelte` | 加载前预览结构 |
| `PubchemSearchModal.svelte` | 通过 PubChem 搜索分子 |
| `PasteContentModal.svelte` | 直接粘贴结构数据 |
| `VacuumBoxModal.svelte` | 给结构添加真空盒 |

## 渲染架构

查看器通过 **Threlte** 这个 Svelte 封装使用 **Three.js**：

- **InstancedMesh** 用于高效渲染大量原子（可处理数千个原子）
- **BVH acceleration**（three-mesh-bvh）用于快速射线拾取和原子选择
- **Spatial grid** 用于超过 50 个原子的结构中的键检测
- **细节层级（LOD）** 会根据原子数量调整球体分段数
- **Depth cueing** 会将远处原子和化学键向背景色淡出，形成类似 VESTA 的深度感

## 相机与控制

- **TrackballControls** 提供轨道旋转、缩放和平移
- 支持 **Perspective** 和 **Orthographic** 两种投影模式
- 支持 **Auto-rotate** 模式
- **Camera reset** 会在切 slab 或建超胞后按晶格重新对齐
- **Gizmo** 方位小组件用于空间方向参考

## 原子交互

### 选择

- 点击可通过射线拾取选中单个原子
- 选中原子会显示索引、元素和坐标
- 支持选择和删除化学键

### 操作

- **Add atom** - 在指定位置插入新原子
- **Delete atoms** - 删除选中的原子
- **Replace atom** - 改变某个位点的元素
- **Move atoms** - 通过方向键或拖动移动原子
- **Add bonds** - 在键编辑模式下从一个原子拖到另一个原子来创建键，也支持点击两次作为备用方式
- **Freeze atoms** - 将原子标记为优化时固定，并用圆环、交叉线或变暗效果提示

### 标签

- 显示带元素符号的位点标签
- 显示原子索引
- 支持自定义标签颜色、尺寸和偏移
- 可通过设置配置

### 电荷标签

逐原子的电荷标签会把 Bader 电荷值直接显示在 3D 场景中的原子上。

**切换标签：**

- 右键点击原子，选择 **Charge Label** -> **Show/Hide charge label**，切换单个原子的电荷标签
- 右键选择 **Charge Label** -> **Show all charge labels** / **Hide all charge labels**，批量显示或隐藏
- 标签只在原子着色模式设为 **Charge** 时可见；切换到其他模式（如 Element）会隐藏标签，切回后会恢复

**调整位置：**

- 点击并拖动任意电荷标签，可在屏幕空间中重新定位
- 偏移会在相机旋转后保持，并按原子存储
- 默认位置略高于原子，以避免挡住交互

**编辑数值：**

- 双击电荷标签可行内编辑数值（Enter 确认，Escape 取消）
- 右键选择 **Charge Label** -> **Set charge value...**，可为任意原子手动输入电荷，适合没有 Bader 数据的原子

**加载电荷：**

- 通过右键 **Import** -> **Load charges** 从 ACF.dat 文件导入 Bader 电荷
- 电荷会存储为每个原子上的 `site.properties.bader_charge`

## 显示模式

### 原子着色

- **Element** - CPK/Jmol 标准颜色
- **配位数** - 按配位数着色
- **Wyckoff position** - 按对称位点着色
- **Charge** - 按 Bader 电荷值（来自 ACF.dat）着色，并支持逐原子电荷标签
- **Custom** - 用户按元素自定义颜色

### 晶格显示

- 晶胞边（线框）
- 带箭头的晶格矢量
- 可调透明度
- 周期性边界条件（PBC）镜像原子

## 关键函数

```typescript
// Structure creation & manipulation
add_atom(structure, element, position)
delete_atoms(structure, indices)
replace_atom(structure, index, new_element)
move_atom(structure, index, new_position)
move_atoms_by_displacement(structure, indices, displacement)
concatenate_structures(struct_a, struct_b)

// Analysis
get_center_of_mass(structure)
get_density(structure)
calculate_inertia_tensor(structure)
get_principal_axes(structure)
align_to_principal_axes(structure)
```

## 设置

控制结构查看器的关键设置（定义在 `settings.ts` 中）：

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `atom_radius` | number | 0.4 | 原子球半径 |
| `bond_thickness` | number | 0.15 | 键圆柱体粗细 |
| `sphere_segments` | number | 16 | 球体质量（分段数） |
| `show_image_atoms` | boolean | true | 显示 PBC 镜像原子 |
| `show_bonds` | boolean | true | 显示化学键 |
| `show_cell` | boolean | true | 显示晶胞 |
| `camera_projection` | string | "perspective" | 相机模式 |
| `color_mode` | string | "element" | 原子着色策略 |
| `auto_rotate` | boolean | false | 自动旋转模式 |
| `depth_cueing` | number | 0 | 雾化效果强度 |
