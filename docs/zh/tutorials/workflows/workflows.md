# 使用工作流引擎

CatGo 的工作流引擎可以构建、运行和监控多步计算流程，从简单的 DFT 结构弛豫，到完整的催化筛选流水线都可以覆盖。工作流以可视化节点图的形式设计，并可在远程 HPC 集群或本地执行。

## 前置条件

- CatGo 桌面应用或 Web 应用
- Python 后端服务器正在运行（`cd server && python main.py`）
- DFT 计算：需要能通过 SSH 访问安装了 VASP 的 HPC 集群
- 机器学习势计算：需要 HPC 集群上安装 MACE、CHGNet 或 M3GNet

## 打开工作流编辑器

1. 点击标签栏中的 **+** 按钮，并选择 **Workflow**
2. 新的工作流标签页会打开，其中包含可视化图编辑器

如果已经有工作流标签页，点击该标签页即可切回。

## 创建第一个工作流

### 从模板开始

最快的入门方式是使用内置模板：

1. 在工作流工具栏中点击 **Templates**
2. 从可用模板中选择：

| 模板 | 说明 |
|----------|-------------|
| Band Structure | Relax -> Static -> 能带结构计算 |
| Adsorption Screening | 并行 DFT + MLP 弛豫，并比较能量 |
| MLP MD Pipeline | Structure -> MLP MD -> Analysis -> Export |
| Batch Surface | 遍历表面 -> Relax -> Merge -> Analyze |
| Defect Screening | Supercell -> Defect generation -> Loop -> Relax -> Compare |
| Heterostructure Study | 构建界面 -> Relax -> DOS + COHP 分析 |

3. 模板图会加载到编辑器中，你可以自由修改。

### 从零构建

1. **添加节点** - 右键点击画布，或使用节点面板添加计算节点
2. **连接节点** - 从输出 handle 拖到输入 handle，创建边
3. **配置参数** - 点击任意节点，在右侧打开参数面板

### 节点类型概览

节点按类别分组：

**输入：**

- **Structure Input** - 从文件、数据库或编辑器加载结构

**DFT 计算**（在 HPC 上运行）：

- **VASP Relax** - 几何优化
- **VASP Static** - 单点能计算
- **VASP MD** - 从头算分子动力学
- **Electronic** - DOS、Bader 电荷、COHP 分析
- **Frequency** - 振动分析和 ZPE

**机器学习势**（在 HPC 上运行）：

- **MLP Relax** - 使用 MACE、CHGNet 或 M3GNet 快速弛豫
- **MLP MD** - 长时间尺度分子动力学

**结构变换**（本地运行）：

- **Slab Generation** - 根据 Miller 指数切表面
- **Supercell** - 扩展周期晶胞
- **Defect Generation** - 创建空位、替位、间隙缺陷
- **Adsorbate Placement** - 将吸附物分子放置到表面位点
- **Doping** - 带对称性枚举的替位掺杂
- **Strain/Deformation** - 单轴、双轴、静水、剪切应变
- **Heterostructure** - ZSL 晶格匹配和堆叠
- **Nanotube** - 将二维片层卷成纳米管
- **Water Solvation** - 添加显式水层
- **Passivation** - 用 pseudo-hydrogen 钝化悬挂键

**分析**（本地运行）：

- **DOS Analysis** - d-band center、投影 DOS
- **COHP Analysis** - LOBSTER 键合分析
- **MD Analysis** - RMSD、RDF、MSD、密度剖面
- **Convergence Check** - 检查计算收敛性
- **Energy Compare** - 排序并比较能量
- **Charge Analysis** - Bader 或 DDEC6 电荷分析
- **Free Energy Diagram** - 反应路径热力学
- **Export** - 将结果保存为 JSON、CSV、CIF 或 POSCAR

**逻辑：**

- **Condition** - 基于能量、力或收敛标准进行分支
- **Loop** - 遍历结构集合或参数扫描
- **Merge** - 等待所有输入完成后再继续

## 配置节点参数

点击任意节点即可打开配置面板。参数会按类别分组。

### VASP Relax 示例

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| ENCUT | 520 eV | 平面波截断能 |
| EDIFF | 1e-5 | 电子步收敛标准 |
| EDIFFG | -0.02 | 离子步收敛标准（力判据，eV/A） |
| ISIF | 3 | 应力张量设置：2 = 固定晶胞，3 = 全弛豫，4 = 固定体积 |
| NSW | 200 | 最大离子步数 |
| IBRION | 2 | 优化器：1 = Quasi-Newton，2 = CG，3 = FIRE |
| KPOINTS | 4x4x4 | k 点网格 |
| double_relax | false | 运行两次 VASP（atomate2 模式） |
| NCORE | 4 | 每个能带的并行核心数 |

### MLP Relax 示例

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| model | MACE-MP | ML potential：MACE-MP、CHGNet、M3GNet |
| fmax | 0.01 | 力收敛标准（eV/A） |

### Slab Generation 示例

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| Miller indices | (1,1,1) | 表面取向 |
| Layers | 4 | 原子层数 |
| Vacuum | 15 A | 真空层厚度 |
| Supercell | 2x2 | 面内超胞扩展 |

## 运行工作流

### 1. 配置 HPC 连接

运行前需要一个活动的 HPC 会话：

1. 打开 **HPC** 面板（侧边栏中的终端图标）
2. 通过 SSH 连接到你的集群
3. 记下会话名称，启动工作流时需要选择它

### 2. 设置运行配置

点击工作流工具栏中的 **Run**，打开运行配置对话框：

| 设置 | 说明 |
|---------|-------------|
| HPC Session | 选择要使用的集群连接 |
| Job Script | 选择预设（SLURM、PBS、Shaheen-III）或编写自定义脚本 |
| Base Directory | 集群上的工作目录，默认 `~/calculations` |
| Nodes | 计算节点数量 |
| Tasks | MPI task 数量 |
| CPUs/Task | 每个 task 的 OpenMP 线程数 |
| Walltime | 最大作业时长（HH:MM:SS） |
| Custodian | 启用自动错误处理（推荐） |

### 3. 启动

点击 **Start** 开始执行。工作流引擎会：

1. 将节点按执行 layer 排序（拓扑顺序）
2. 逐层执行；同一层中的节点并行运行
3. 对 HPC 节点：生成输入文件、提交作业、轮询完成状态
4. 对本地节点：立即在服务器上执行
5. 将结果（结构、能量）传递给下游依赖节点

### 作业脚本预设

| 预设 | 调度器 | 说明 |
|--------|-----------|-------|
| Generic SLURM | SLURM | 适用于多数 SLURM 集群 |
| Generic PBS | PBS | 适用于 PBS/Torque 集群 |
| Shaheen-III | SLURM | KAUST 专用，包含 module loading |

你可以修改任意预设，也可以编写自己的作业脚本模板。

## 监控执行

工作流运行后，编辑器会显示实时状态：

| 状态 | 颜色 | 含义 |
|--------|-------|---------|
| Pending | 灰色 | 等待依赖 |
| Queued | 紫色 | 作业已提交，正在调度队列中等待 |
| Running | 蓝色 | 正在计算 |
| Completed | 绿色 | 成功完成 |
| Failed | 红色 | 发生错误 |
| Skipped | 灰色 | 因上游失败而跳过 |

### 工作流控制

| 操作 | 说明 |
|--------|-------------|
| **Pause** | 暂停执行；正在运行的作业继续，新作业不会启动 |
| **Resume** | 从暂停位置继续 |
| **Cancel** | 停止工作流并标记为 failed |

### 检查作业输出

点击已完成节点可查看结果：

- **Energy** - 总能量、每原子能量
- **Forces** - 最大力、力收敛情况
- **Structure** - 输出结构（CONTCAR）
- **Files** - 下载 OUTCAR、OSZICAR、vasprun.xml 等
- **Convergence** - OSZICAR 能量随离子步变化图

## 查看结果

### Results Dashboard

打开 **Project Dashboard**，在一个地方查看所有工作流结果：

- **Table view** - 可排序列：化学式、能量、energy/atom、体积、节点类型
- **Plot view** - 用散点图或柱状图比较能量
- **Filter** - 按化学式、节点类型或工作流名称筛选
- **Export** - 将结果下载为 JSON 或 CSV

### ASE 数据库

所有完成的 DFT 和 MLP 计算都会自动连同元数据存入 ASE 数据库：

- Workflow ID 和 step ID
- 节点类型（vasp_relax、mlp_md 等）
- 能量、力、应力
- 原子结构

你可以从 project dashboard 查询数据库，也可以直接使用 ASE Python API 查询。

## Custodian 错误处理

启用后（推荐），Custodian 会自动处理常见 VASP 错误：

| 错误 | 自动修复 |
|-------|---------------|
| ZBRENT failure | 使用不同 IBRION 重启 |
| EDDDAV/EDWAV | 切换到 algo=Normal/Fast |
| KPOINTS too dense | 降低网格密度 |
| Charge mixing issues | 调整 AMIX/BMIX |
| Walltime exceeded | 超过作业时限时从 CONTCAR 自动重启 |

在把某个 step 标记为 failed 前，Custodian 最多重试 5 次（可配置）。

## 示例工作流

### 能带结构计算

```
Structure Input -> VASP Relax -> VASP Static (dense k-grid) -> DOS Analysis
```

1. 添加 **Structure Input** 节点并加载晶体
2. 连接到 **VASP Relax** 节点（ISIF=3 表示全晶胞弛豫）
3. 连接到 **VASP Static** 节点，设置 ISMEAR=-5（tetrahedron method）和 NEDOS=3001
4. 连接到 **DOS Analysis** 节点，提取 d-band center

### 表面催化（NRR）流水线

```
Structure Input
    -> Bulk Opt (9x9x9 k-grid, ISIF=3)
    -> Slab Gen (111, 4 layers, 15A vacuum)
    -> Slab Relax (ISIF=2, freeze bottom layers)
    -> Loop: Adsorbate sites (ontop, bridge, fcc, hcp)
        -> Slab Relax -> Frequency
    -> Merge
    -> Reference Molecules (N2, H2, NH3)
    -> Free Energy Diagram
```

该流程会计算吸附能、ZPE 修正，并生成氮还原反应的自由能图。

### 缺陷筛选

```
Structure Input
    -> Supercell (2x2x2)
    -> Defect Gen (vacancy)
    -> Loop: Each defect site
        -> VASP Relax
    -> Merge
    -> Energy Compare
```

该流程会枚举对称唯一的空位位点，分别弛豫，并按形成能排序。

## 工作流恢复

工作流引擎会自动把状态保存到数据库。如果服务器崩溃或重启：

1. 启动时，引擎会检查未完成的工作流
2. 查询 HPC 集群上的作业状态
3. 如果服务器离线期间有作业完成，会提取结果
4. 工作流会从下一个 pending layer 继续

不需要人工干预；恢复过程完全自动。

## 下一步

- [工作流节点参考](/zh/modules/workflow/workflow-engine) - 每种节点类型的详细参数
- [结构优化](/zh/tutorials/structures/optimization) - 不使用工作流的本地优化
- [桌面应用](/zh/tutorials/desktop/desktop-app) - 标签页管理和 HPC 终端
- [FAQ](/zh/reference/faq#workflows) - 常见工作流问题和故障排查
