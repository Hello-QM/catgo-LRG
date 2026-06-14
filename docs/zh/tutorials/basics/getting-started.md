# 快速上手

本教程会带你在 CatGo 中加载第一个晶体结构，熟悉 3D 查看器，并导出结果。

## 加载结构

CatGo 支持多种加载结构的方式：

### 拖放

最简单的方法是把结构文件（`.cif`、`.poscar`、`.xyz`、`.extxyz`、`.json`）直接拖到 3D 查看器中。压缩文件（`.gz`、`.zip`）同样支持。

### 文件选择器

点击工具栏中的 **Import** 按钮，打开文件浏览器对话框。

### 粘贴内容

点击 **Paste** 按钮（或工具栏中的粘贴图标）打开文本弹窗。直接粘贴 CIF、POSCAR 或 XYZ 内容，然后按 **Ctrl+Enter**（macOS 上为 **Cmd+Enter**）导入。

### 数据库搜索

使用 **OPTIMADE** 或 **PubChem** 搜索弹窗，从在线数据库查找结构。详情见[数据库搜索教程](/zh/tutorials/structures/database-search)。

## 操作 3D 查看器

结构加载后，可以用鼠标和键盘与它交互：

### 鼠标控制

| 操作 | 控制方式 |
|--------|---------|
| 旋转 | 左键拖动 |
| 滚转 | 右键拖动 |
| 缩放 | 滚轮 |
| 平移 | Shift + 拖动（或 Ctrl/Cmd + 拖动） |

### 键盘控制

| 按键 | 操作 |
|-----|--------|
| 方向键 | 旋转结构（俯仰和偏航） |
| W / S | 滚转结构 |
| R | 将相机重置为默认视图 |
| F | 切换全屏 |
| I | 切换信息面板 |
| Escape | 关闭已打开的面板或退出编辑模式 |

## 选择原子

- **点击** 原子即可选中；信息面板会显示元素、索引和坐标。
- **Shift+点击** 可向选择集中添加或移除原子。
- **双击** 背景可清空选择。
- **Delete** 或 **Backspace** 会从结构中删除选中的原子。

## 切换显示选项

使用 **Controls** 面板（齿轮图标）调整查看器：

| 选项 | 说明 |
|--------|-------------|
| Show Bonds | 切换键显示 |
| Show Cell | 显示晶胞线框 |
| Show Image Atoms | 显示晶胞边界上的 PBC 镜像原子 |
| Show Labels | 在原子上显示元素符号 |
| Camera Projection | 在透视投影和正交投影之间切换 |
| Color Scheme | 在 Vesta、Jmol、Alloy、Pastel、Muted、Dark Mode 中选择配色 |
| Atom Radius | 调整原子球半径 |
| Depth Cueing | 添加雾化深度效果 |

## 查看结构属性

按 **I** 或点击信息图标打开 **Info Pane**，其中会显示：

- 化学式和组成
- 空间群和晶系（通过 Spglib/Moyo）
- 晶格参数（a、b、c、alpha、beta、gamma）
- 晶胞体积和密度
- 位点数量

## 导出

点击工具栏中的 **Export** 按钮保存结构：

| 格式 | 扩展名 | 用途 |
|--------|-----------|----------|
| CIF | `.cif` | 标准晶体学交换格式 |
| POSCAR | `.poscar` | VASP 输入文件 |
| XYZ | `.xyz` | 简单笛卡尔坐标 |
| Extended XYZ | `.extxyz` | 带晶格和属性的 XYZ |
| JSON | `.json` | 与 Pymatgen 兼容的 JSON |
| GLB | `.glb` | 用于演示的 3D 模型 |
| OBJ | `.obj` | 用于渲染软件的 3D 模型 |

## 撤销 / 重做

所有结构修改（添加、删除、移动原子，切 slab，建超胞）都支持撤销和重做：

- **Ctrl+Z**（macOS 上为 Cmd+Z）- 撤销
- **Ctrl+Shift+Z**（macOS 上为 Cmd+Shift+Z）- 重做

## 下一步

- [构建 Slab](/zh/tutorials/structures/building-slabs) - 根据 Miller 指数生成表面 slab
- [运行结构优化](/zh/tutorials/structures/optimization) - 使用机器学习势弛豫结构
- [搜索数据库](/zh/tutorials/structures/database-search) - 从 OPTIMADE、Materials Project 和 PubChem 查找结构
