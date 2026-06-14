# 常见问题

## 通用

### CatGo 是什么？

CatGo 是一个**面向计算材料科学的 AI 驱动工作台**。它把 3D 结构查看器、带 HPC 编排能力的节点式工作流编辑器，以及自然语言 AI 助手（CatBot）整合在一起。CatGo 可作为桌面应用（Tauri）使用，也可作为 VS Code 扩展使用。

### 支持哪些文件格式？

**导入：** CIF、POSCAR/VASP、XYZ、Extended XYZ、ASE Trajectory（.traj）、HDF5、XDATCAR、CUBE，以及压缩变体（.gz、.zip、.bz2）

**导出：** CIF、POSCAR、XYZ、Extended XYZ、JSON（pymatgen 兼容）、GLB、OBJ

### CatGo 需要联网吗？

核心查看器完全在浏览器中运行，不需要服务器。由 WASM 支撑的功能（键合、slab 生成、对称性）也在本地运行。不过，下面这些功能需要 Python 后端：

- 结构优化（服务器端计算器）
- 数据库搜索（OPTIMADE、Materials Project、PubChem）
- VASP 输入生成

### CatGo 是免费开源的吗？

是的。CatGo 是开源项目，并托管在 GitHub 上。

---

## 结构查看器

### 为什么没有显示化学键？

可能有几个原因：

1. **键合被禁用** - 检查设置中的 `show_bonds` 是否设为 "always"（而不是 "never"）
2. **键合策略不合适** - 尝试在设置中切换 solid angle、electronegativity ratio 和 atomic radii
3. **原子距离太远** - 如果结构没有周期性边界条件，或原子间距很大，可能检测不到键
4. **分子模式** - 如果 `show_bonds` 设为 "crystals"，非周期结构不会显示键

### 为什么切 slab 后结构倒过来了？

Slab 切割器会强制使用满足 (a x b) . z > 0 的右手晶格。如果初始旋转矩阵产生了左手晶格，矢量会被修正。按 **R** 重置相机，可以重新对齐到新的晶格矢量。

### 为什么原子重叠了？

可能原因包括：

- 启用了镜像原子（`show_image_atoms`），并且当前视角让镜像原子和原始原子重叠
- 结构存在非常短的键长（可在信息面板检查晶格参数）
- 原子半径设置过大，请在设置中减小 `atom_radius`

### 如何修改原子颜色？

1. **Color scheme** - 在设置中修改全局配色（Vesta、Jmol、Alloy、Pastel、Muted、Dark Mode）
2. **按元素修改** - 点击颜色图例中的元素，打开颜色选择器
3. **按属性着色** - 将 `atom_color_mode` 切换为 "coordination" 或 "wyckoff"

### 如何在优化中冻结原子？

1. 选择要冻结的原子（点击 + Shift+点击）
2. 右键并在上下文菜单中选择 "Freeze"
3. 冻结原子会显示视觉标记（圆环、交叉线或变暗）
4. 优化过程中，冻结原子会保持在原位

### 如何撤销修改？

按 **Ctrl+Z**（macOS 上为 Cmd+Z）撤销，按 **Ctrl+Shift+Z** 重做。它适用于所有结构修改：添加/删除原子、切 slab、建超胞等。

---

## 桌面应用

### 如何安装桌面应用？

见[安装指南](/zh/guide/installation)和[桌面构建指南](/zh/developer/desktop-build)。macOS、Windows 和 Linux 的预构建二进制文件可在 GitHub Releases 页面获取。

### 可以双击文件打开吗？

可以。桌面应用会为 `.cif`、`.poscar`、`.vasp`、`.contcar`、`.xyz`、`.extxyz`、`.traj` 和 `.json` 注册文件关联。双击这些文件会直接在 CatGo 中打开。在 macOS 上，关联文件还会在 Finder 中显示自定义 CatGo 文档图标。

### 桌面应用包含 Python 服务器吗？

打包版桌面构建（`pnpm bundle`）包含 Python 计算服务器。标准构建（`pnpm tauri:build`）不包含，你需要单独运行服务器。

---

## 优化

### 应该使用哪个计算器？

| 使用场景 | 推荐计算器 |
|----------|----------------------|
| 快速测试 / 金属 | EMT |
| 有机分子 | xTB（GFN2） |
| 无机晶体 | MACE（medium）或 CHGNet |
| 通用材料 | MACE（medium） |
| 最高精度 | MACE（large） |
| 不需要服务器 | UFF（本地、浏览器端） |

### 为什么检测不到服务器？

1. 确认 Python 服务器正在运行：`cd server && python main.py`
2. 检查 8000 端口是否被其他进程占用
3. 确认服务器在终端中启动时没有报错
4. 健康检查端点应能响应：`http://localhost:8000/health`

### 为什么优化提示 "element not supported"？

每个计算器支持的元素有限：

- **EMT** - 只支持 Cu、Ag、Au、Ni、Pd、Pt、Al
- **xTB** - 支持大多数有机元素（H、C、N、O、S、P、卤素等）
- **MACE/CHGNet/M3GNet** - 支持周期表中的大多数元素

请切换到支持当前结构元素的计算器。

### 可以优化晶胞形状吗？

可以，但需要服务器端计算器。在优化面板中启用 **Optimize cell**。它会使用 ExpCellFilter 进行类似 NPT 的弛豫。本地 UFF 优化器不支持该功能。

---

## 数据库搜索

### 为什么数据库搜索失败？

OPTIMADE 和 PubChem 搜索都需要运行在 `localhost:8000` 的 Python 后端。后端会代理 API 请求，以避免 CORS 限制。使用 `cd server && python main.py` 启动服务器。

### 如何获取 Materials Project API key？

1. 在 [materialsproject.org](https://materialsproject.org/) 创建账户
2. 进入 dashboard，复制你的 API key
3. 在 CatGo 的 OPTIMADE 搜索弹窗中点击 "Add API key" 并粘贴
4. 该 key 会存储在浏览器的 localStorage 中

### OPTIMADE 和 PubChem 有什么区别？

- **OPTIMADE** 搜索晶体结构数据库（周期性、有晶格），适合体相材料、表面等
- **PubChem** 搜索分子化合物数据库（非周期、无晶格），适合有机分子、药物、小分子

---

## 轨迹

### 为什么我的轨迹加载不了？

1. 检查文件格式，支持格式包括 .extxyz、.xyz、.traj、.h5/.hdf5、XDATCAR
2. 大文件（>50 MB）加载可能需要一些时间，因为 CatGo 需要索引帧
3. 支持压缩文件（.gz、.zip），但解压会增加耗时
4. 查看浏览器控制台中的解析错误

### 如何控制播放速度？

使用播放控制中的 FPS 滑块，或在播放时按 **+** / **-**。范围可配置，默认是 0.2-60 FPS。

### 可以导出某一帧吗？

切换到目标帧，然后使用标准 Export 面板，将当前结构保存为任意支持格式。

---

## WASM / 性能

### 为什么 WASM 没有加载？

1. 确认 WASM 包存在于 `extensions/rust-wasm/pkg/`
2. 检查浏览器是否支持 WebAssembly（现代浏览器都支持）
3. 查看浏览器控制台中的具体错误信息
4. 如果从源码构建，请在 `extensions/rust/` 中运行 `wasm-pack build`

### 原子很多时查看器很慢，怎么办？

见[性能技巧](/zh/guide/tips-and-tricks#performance-tips)。关键操作包括：

- 降低 `sphere_segments`（可以尝试 12）
- 对非常大的结构关闭化学键
- 关闭镜像原子
- 启用 `same_size_atoms`

### CatGo 使用多少内存？

内存占用取决于结构大小和轨迹长度：

- 100 原子结构：约 1 MB
- 带化学键的 10,000 原子结构：约 50 MB
- 1000 帧轨迹：约 100-500 MB，取决于原子数量

调整 `max_frames_in_memory` 可以控制轨迹播放的内存使用。

---

## 工作流 {#workflows}

### 工作流引擎是什么？

工作流引擎允许你把多步计算流程构建为可视化节点图。你可以连接节点（DFT 计算、结构变换、分析）、配置参数，并在 HPC 集群上运行整个流程。分步说明见[工作流教程](/zh/tutorials/workflows/workflows)。

### 需要安装 VASP 吗？

对于 DFT 计算节点（VASP Relax、VASP Static、VASP MD、Electronic、Frequency），需要安装 VASP。你需要能通过 SSH 访问 HPC 集群，并具备有效赝势（POTCAR 文件）。机器学习势节点（MLP Relax、MLP MD）则需要集群上安装 MACE、CHGNet 或 M3GNet。结构变换和分析节点在 CatGo 服务器本地运行，不需要 HPC 访问。

### 如何连接 HPC 集群？

1. 在侧边栏打开 **HPC** 面板（终端图标）
2. 输入集群 hostname、用户名和认证方式（密码或 SSH key）
3. 连接后，该会话会在当前 CatGo 会话期间保持可用
4. 启动工作流时选择这个会话

### 工作流失败了，如何调试？

1. 在工作流编辑器中点击红色的 **failed node**
2. 在节点详情面板查看 **error message**
3. 点击 **Files** 下载集群上的 OUTCAR 或其他输出文件
4. 常见原因：
   - **POTCAR not found** - 确认赝势位于集群上的预期目录
   - **Walltime exceeded** - 增加运行配置中的 walltime
   - **Memory error** - 降低 NCORE 或增加节点数
   - **Convergence failure** - 启用 Custodian 自动修复错误

### 可以恢复失败的工作流吗？

不能直接恢复。如果某一步失败，工作流会停止，下游节点会标记为 skipped。你可以：

1. 修复问题（调整参数、增加资源）
2. 从最后一个成功结构开始创建新工作流
3. 如果服务器在工作流中途崩溃，重启后会自动恢复

### Custodian 是什么，应该启用吗？

Custodian 是 VASP 计算的自动错误处理器，来自 atomate2/custodian 项目。它会检测常见 VASP 错误并自动应用修复，例如在 EDDDAV 失败时切换优化算法，或 walltime 超时时从 CONTCAR 重启。它默认启用，并推荐用于生产工作流。只有在需要原始 VASP 执行过程用于调试时才关闭它。

### 如何使用自定义作业脚本？

在运行配置对话框中选择一个预设（SLURM、PBS、Shaheen-III）并修改，或者从头编写自己的脚本。脚本模板支持 `{nodes}`、`{ntasks}`、`{walltime}` 等变量，它们会由资源配置填充。

### 没有 HPC 集群也能运行工作流吗？

部分可以。结构变换节点（slab 生成、超胞、缺陷生成等）和分析节点会在 CatGo 服务器本地运行。但 DFT 计算（VASP）和机器学习势计算需要 HPC 集群。对于只在本地运行的流程，可以把结构变换和[本地优化](/zh/tutorials/structures/optimization)功能串起来。

### 结果存在哪里？

所有完成的 DFT 和 MLP 计算都会自动存入服务器上的 ASE 数据库。你可以在 **Project Dashboard** 中浏览结果（表格和图表视图），也可以通过 ASE Python API 查询数据库。结果包含结构、能量、力和工作流元数据。

### 如何导出工作流结果？

1. 打开当前工作流的 **Project Dashboard**
2. 使用 **Table** 视图查看所有结果
3. 点击 **Export** 下载 JSON 或 CSV
4. 也可以在工作流末尾添加 **Export** 节点，自动保存为 JSON、CSV、CIF 或 POSCAR 格式

### 多个工作流可以同时运行吗？

每个工作流相互独立，但同一时间只能有一个工作流处于 actively running 状态。你可以同时拥有多个草稿或已完成状态的工作流。

### 工作流运行期间服务器崩溃会怎样？

工作流引擎会在重启后自动恢复。它会检查 HPC 集群上的作业状态，提取离线期间完成的作业结果，并从下一个待运行 layer 继续。不需要手动干预。

---

## 贡献

### 如何报告 bug？

在 [GitHub 仓库](https://github.com/Hello-QM/catgo-LRG/issues)中创建 issue，并包含：

- 复现步骤
- 期望行为与实际行为
- 浏览器/平台信息
- 样例文件（如适用）

### 如何贡献代码？

设置说明、代码规范和 PR 流程见[贡献指南](/zh/developer/contributing)。
