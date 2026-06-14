# 图库

这里展示 CatGo 在材料科学工作流中的可视化能力。

## 晶体结构

### 体相晶体

- **Diamond (C)** - 经典 FCC 金刚石立方结构，具有四面体键合
- **Perovskite (SrTiO3)** - 立方钙钛矿，包含 TiO6 八面体、晶格矢量和镜像原子
- **Rocksalt (NaCl)** - 交替 Na/Cl 子晶格的离子晶体
- **Wurtzite (ZnO)** - 带极性表面的六方结构

### 复杂结构

- **Metal-Organic Framework (MOF-5)** - 大晶胞，包含有机 linker 和 Zn4O cluster
- **Zeolite (MFI)** - 具有孔道系统的多孔硅酸盐骨架
- **Layered Material (MoS2)** - 具有 Mo-S 键的范德华层状结构

## 表面 Slab

### Miller 指数表面

- **Cu(111)** - 密排 FCC 表面，4 层 slab，15 A 真空层
- **Fe(110)** - BCC 表面，常用于催化研究
- **TiO2(110) Rutile** - 带 bridging oxygen rows 的金属氧化物表面

### Slab 切割器效果

- **切割平面预览** - 在体相晶体上叠加半透明平面，展示 (110) 切面
- **前后对比** - 将体相 FCC Cu 转换为带真空层的 (111) slab
- **吸附位点** - 在 Pt(111) 表面识别 atop、bridge 和 hollow 位点

## 光谱与分析

### 能带结构

- **Si band structure** - 沿高对称 k 路径的电子能带，并高亮带隙
- **Band structure + DOS** - GaAs 的能带结构和态密度并排显示

### X 射线衍射

- **XRD pattern** - 石英（SiO2）的模拟粉末衍射图谱，并带峰标签

### 径向分布函数

- **RDF plot** - 非晶 SiO2 的 g(r)，展示 Si-O、O-O 和 Si-Si pair correlation

## 相图

### 二元相图

- **Li-Fe-O** - 2D 凸包；稳定相位于凸包上，不稳定相按 above-hull energy 着色

### 三元相图

- **Li-Mn-O** - 3D 三元图，带凸包面和稳定化合物标签

### 四元相图

- **Li-Fe-Mn-O** - 交互式 3D 四面体，显示凸包面和相稳定性

## 密度可视化

### CUBE 文件等值面

- **Benzene HOMO** - 带正负叶瓣的分子轨道（蓝/红）
- **Electron density** - Si 晶体总电荷密度等值面
- **Slice plane** - 穿过钙钛矿电子密度的 2D 截面

## 轨迹播放

### 分子动力学

- **Water box MD** - 液态水轨迹播放，并显示能量图
- **Surface diffusion** - 金属表面上 adatom 在 1000 帧中的跃迁

### 优化路径

- **Geometry relaxation** - 优化过程中结构的演化和能量收敛图
- **Cell optimization** - NPT 弛豫过程中晶格参数的变化

## 组成与周期表

### 组成图

- **Pie chart** - 高熵合金（HEA）的元素组成
- **Bubble chart** - 按尺寸比例展示元素组成

### 交互式周期表

- **Element explorer** - 悬停查看属性（原子质量、电负性、电子构型）
- **Heat map mode** - 按所选属性为周期表着色

## 多平台

### 桌面应用（Tauri）

- **Native window** - CatGo 作为独立 macOS/Windows/Linux 应用运行
- **File associations** - 双击 CIF 文件即可直接在 CatGo 中打开

### VSCode 扩展

- **Editor integration** - 结构查看器嵌入 VSCode 面板，并与 CIF 文件编辑并排使用

### Jupyter Widget

- **Notebook visualization** - 在 Jupyter notebook 中内联渲染交互式 3D 结构

## 显示模式

### 原子着色

- **Element colors** - 标准 Vesta/Jmol CPK 颜色
- **Coordination number** - 按邻居数量为原子着色（viridis 色标）
- **Wyckoff positions** - 按对称位点为原子着色

### 视觉效果

- **Depth cueing** - 在大型 MOF 结构上通过雾化效果增强深度感
- **Orthographic vs. perspective** - 同一结构在两种投影模式中的效果
- **Dark vs. light theme** - 结构查看器在深色和浅色主题下的效果

---

*如需向图库贡献截图或可视化结果，请查看[贡献指南](/zh/developer/contributing)。*
