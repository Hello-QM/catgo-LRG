# 结构优化

本教程介绍如何使用本地或服务器端计算器弛豫原子位置，并在需要时优化晶胞。

## 概览

CatGo 支持两种优化模式：

| 模式 | 计算器 | 运行位置 | 是否需要网络/后端 |
|------|-----------|---------|-----------------|
| **Local** | UFF（Universal Force Field）、VSEPR | 浏览器（WASM） | 否 |
| **Server** | EMT、xTB、MACE、CHGNet、M3GNet | Python 后端 | 是 |

服务器模式支持多种 **优化算法**：

| 优化器 | 用途 | 依赖 |
|-----------|---------|----------|
| **BFGS** | 寻找局部能量极小值（默认） | ASE（已包含） |
| **Sella Minimize** | 带 trust-radius 控制的替代极小化器 | [Sella](https://github.com/zadorlab/sella) |
| **Sella TS Search** | 寻找过渡态，也就是鞍点 | [Sella](https://github.com/zadorlab/sella) |
| **IRC** | 从过渡态追踪反应路径 | [Sella](https://github.com/zadorlab/sella) |

## 本地优化（UFF）

UFF 优化器通过 WebAssembly 完全在浏览器中运行，不需要配置服务器。

### 步骤

1. 加载一个结构
2. 点击工具栏中的 **Optimize** 按钮
3. 选择 **Local (UFF)** 作为优化器类型
4. 设置收敛参数：
   - **fmax** - 力收敛阈值，默认 0.05 eV/A
   - **Max steps** - 最大优化步数，默认 100
5. 点击 **Start**

UFF 很快，但只适合粗略几何优化。生产级计算建议使用服务器端机器学习势。

## 服务器优化（机器学习势）

服务器端优化可以使用更准确的机器学习势。

### 服务器设置

启动 Python 计算服务器：

```bash
cd server
pip install -r requirements.txt
python main.py
```

服务器运行在 `http://localhost:8000`。CatGo 会自动检测服务器，连接成功时显示绿色状态指示。

### 可用计算器

| 计算器 | 适用体系 | 速度 | 精度 |
|-----------|---------|-------|----------|
| **EMT** | 简单金属（Cu、Ag、Au、Ni、Pd、Pt、Al） | 非常快 | 元素覆盖有限 |
| **xTB** | 分子和有机体系 | 快 | 对有机体系较好 |
| **MACE** | 通用材料 | 中等 | 高 |
| **CHGNet** | 无机晶体 | 中等 | 高 |
| **M3GNet** | 通用材料 | 中等 | 较好 |

### xTB 方法

使用 xTB 时，可以选择具体方法：

| 方法 | 说明 |
|--------|-------------|
| GFN2-xTB | 最准确（默认） |
| GFN1-xTB | 更快，精度略低 |
| GFN0-xTB | 最快，精度最低 |
| GFN-FF | 力场近似 |
| IPEA1-xTB | 为电离势修改过的参数 |

### MACE 模型

使用 MACE 时，可以选择模型尺寸：

| 模型 | 说明 |
|-------|-------------|
| small | 最快，精度较低 |
| medium | 速度和精度平衡（默认） |
| large | 最准确，最慢 |

也支持用户训练的 MACE 模型路径。

### 优化步骤

1. 确认服务器正在运行，在 `server/` 目录中执行 `python main.py`
2. 加载结构
3. 点击工具栏中的 **Optimize**（闪电图标）
4. 选择 **Server (ML Potentials)**，并选择计算器
5. 选择 **Optimizer Method**：
   - **BFGS** - 标准极小化器（默认，用于寻找局部极小值）
   - **Sella Minimize** - 带 trust-radius 控制的替代极小化器
   - **Sella TS Search** - 寻找过渡态（鞍点）
   - **IRC** - 从过渡态追踪反应路径
6. 设置参数：
   - **fmax** - 力收敛标准，默认 0.05 eV/A
   - **Max steps** - 最大迭代步数，默认 100
   - **Optimize cell** - 启用后弛豫晶格参数，仅适用于周期体系
7. 点击 **Optimize**

## 实时进度

优化过程中，CatGo 会显示：

- **Energy chart** - 能量随步数变化的实时 SVG 图
- **Step counter** - 当前步数 / 最大步数
- **Current energy** - 当前总能量，单位 eV
- **Current fmax** - 当前最大力，单位 eV/A
- **3D structure** - 原子移动时实时更新的 3D 结构

进度通过 WebSocket 流式传输，因此更新会比较平滑。

## 选择性动力学（冻结原子）

可以冻结部分原子，使其在优化过程中保持不动：

1. **选择原子**，点击或 Shift+点击要冻结的原子
2. 通过上下文菜单或控制面板将其标记为 **frozen**
3. 冻结原子会显示视觉标记，例如圆环、交叉线或变暗；具体样式可在设置中配置
4. 启动优化，冻结原子会保持固定

常见用途：

- 表面 slab 计算中冻结底层原子
- 缺陷研究中冻结体相区域，只弛豫缺陷附近
- 吸附物优化中冻结基底

### 片段提取

如果在开始优化前已经选中原子，可以选择：

- **Fix unselected atoms** - 只在原位优化选中原子，未选中原子固定
- **Extract fragment** - 把选中原子提取为孤立分子优化，随后合并回原结构

## 使用 Sella 搜索过渡态

[Sella](https://github.com/zadorlab/sella) 是与 ASE 集成的鞍点优化器。它可以寻找过渡态并追踪反应路径，这些能力是 BFGS 不能提供的。

### 安装 Sella

Sella 是可选依赖。请在服务器环境中安装：

```bash
pip install setuptools-scm                  # needed on Python 3.13+
pip install --no-build-isolation sella
```

如果没有安装 Sella，BFGS 优化器仍然始终可用；当你尝试使用 Sella 优化器时，CatGo 会显示清晰错误。

### 寻找过渡态

1. 从接近期望过渡态的结构开始，例如迁移原子位于路径中点附近
2. 打开优化面板，进入 **Server** 模式
3. 选择计算器，例如 **MACE** 或 **EMT**
4. 将 **Optimizer Method** 设为 **Sella TS Search**
5. 点击 **Optimize**

TS search 会使结构沿能量上坡方向移动，趋向鞍点。收敛后，你会得到过渡态几何；最终能量可用于读取活化能。

::: tip
与能量下降的极小化不同，TS search 通常会提高能量，这是正常现象。优化器要寻找的是一个力为零的点，该点沿一个方向（反应坐标）为极大值，而沿其他方向为极小值。
:::

### 追踪反应路径（IRC）

获得过渡态后，可以用 IRC 追踪最小能量路径：

1. 加载过渡态几何
2. 将 **Optimizer Method** 设为 **IRC**
3. 可选设置 **Step size (dx)**；更小的值会得到更平滑的路径
4. 点击 **Optimize**

IRC 会从过渡态沿最速下降路径走向最近的极小值，从而给出反应路径。

### Sella 参数

- **Trust radius**（Sella Minimize / TS Search）- 控制最大步长。更小的值更保守但更慢。留空则使用 Sella 默认值。
- **Step size dx**（IRC）- IRC 步长，单位 Angstrom。更小的值路径更平滑，但需要更多步数。

## 导出结果

优化完成后：

- **Save structure** - 将最终优化结构导出为 extXYZ
- **Save trajectory** - 将完整优化路径（所有步）导出为带能量元数据的多帧 extXYZ

轨迹导出可用于检查收敛情况，也可用于制作能量路径可视化。

## 取消

随时点击 **Cancel** 停止优化。结构会回退到最后一个已完成步。

## 故障排查

**检测不到服务器**

确认 Python 服务器正在 8000 端口运行。检查终端是否有报错。健康检查端点为 `http://localhost:8000/health`。

**计算器不可用**

某些计算器需要额外 Python 包。请检查服务器终端输出中的缺失依赖。

**优化不收敛**

尝试增加 `max_steps`、放宽 `fmax`，或使用不同计算器。对金属体系，EMT 可能比机器学习势收敛更快。

**"Element not supported" 错误**

每个计算器支持的元素集合不同。EMT 只支持部分金属；xTB 适用于大多数有机元素；MACE 和 CHGNet 覆盖周期表中的大部分元素。

**"Sella is not installed" 错误**

Sella 是可选依赖。可用下面的命令安装：

```bash
pip install setuptools-scm              # Python 3.13+ only
pip install --no-build-isolation sella
```

**TS Search 不收敛**

过渡态搜索比极小化更依赖初始构型。尝试从更接近期望 TS 的几何开始，或增加 `max_steps`。良好的初始猜测对 TS search 非常关键。
