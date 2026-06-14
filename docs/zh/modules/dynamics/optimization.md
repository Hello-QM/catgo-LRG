# 优化

使用多种计算后端进行结构弛豫和能量计算，并支持实时进度流式输出。

**Source:** `src/lib/api/compute.ts`, `src/lib/structure/OptimizationPane.svelte`, `server/routers/`

## 可用计算器

| 计算器 | 方法 | 说明 | 适用场景 |
|-----------|--------|-------------|----------|
| **EMT** | 有效介质理论 | 快速经验势 | 金属（Al、Cu、Ag、Au、Ni、Pd、Pt） |
| **xTB GFN2** | 半经验 DFT | 含色散校正的紧束缚方法 | 有机分子、分子晶体 |
| **xTB GFN1** | 半经验 DFT | 比 GFN2 更快但精度较低 | 大型有机体系 |
| **xTB GFN0** | 半经验方法 | 最快的 xTB 变体 | 筛选、预优化 |
| **xTB GFN-FF** | 力场 | xTB 参数化力场 | 非常快速的预弛豫 |
| **MACE** | 机器学习 | 等变神经网络势 | 通用、高精度 |
| **CHGNet** | 机器学习 | 晶体 Hamilton 图网络 | 无机材料 |
| **M3GNet** | 机器学习 | 材料三体图网络 | 无机材料 |
| **UFF** | 力场（WASM） | 通用力场 | 浏览器内快速优化 |

## 核心函数

### 客户端（TypeScript）

```typescript
// List available calculators and their status
fetchCalculators(): Promise<Calculator[]>

// Check if server is running
check_server_available(): Promise<boolean>

// HTTP-based optimization (returns final result)
optimize_structure(structure, calculator, options): Promise<OptimizationResult>

// WebSocket streaming (real-time step-by-step updates)
optimize_structure_ws(structure, calculator, options, onStep): Promise<OptimizationResult>

// In-browser UFF optimization via WASM (no server needed)
wasm_optimize_structure(structure): Structure
```

### 服务器端（Python）

FastAPI 服务器暴露以下端点：

- `GET /api/optimize/calculators` — 列出可用计算器
- `POST /api/optimize/structure` — 优化结构（HTTP）
- `GET /api/optimize/ws` — WebSocket 流式优化
- `GET /api/optimize/energy` — 单点能计算

## 优化器方法

除了选择计算器（能量/力引擎），还可以选择驱动搜索过程的**优化算法**：

| 优化器 | 类型 | 说明 | 适用场景 |
|-----------|------|-------------|----------|
| **BFGS** | 极小化器 | 拟 Newton 局部极小化器（ASE 默认） | 寻找稳定结构（局部极小值） |
| **Sella Minimize** | 极小化器 | 信赖半径极小化器（[Sella](https://github.com/zadorlab/sella) `order=0`） | BFGS 的替代方案，有时更稳健 |
| **Sella TS Search** | 鞍点 | 过渡态搜索器（[Sella](https://github.com/zadorlab/sella) `order=1`） | 寻找反应能垒和过渡态 |
| **IRC** | 反应路径 | 内禀反应坐标（[Sella](https://github.com/zadorlab/sella)） | 从过渡态追踪最低能量路径 |

::: tip 什么是过渡态？
**过渡态**（TS）是反应物到产物最低能量路径上的最高能点。它给出**活化能**，即体系发生反应必须跨越的能垒。Sella 的 TS Search 会在势能面上寻找这些鞍点。
:::

### Sella 参数

使用 Sella Minimize 或 Sella TS Search 时：

| 参数 | 说明 | 默认值 |
|-----------|-------------|---------|
| `delta0`（信赖半径） | 用于步长控制的初始信赖半径 | 自动（Sella 默认） |

使用 IRC 时：

| 参数 | 说明 | 默认值 |
|-----------|-------------|---------|
| `dx`（步长） | IRC 步长，单位 Angstrom | 自动（Sella 默认） |

### 安装 Sella

Sella 是可选依赖。没有它服务器也能工作，BFGS 始终可用。若要启用 Sella 优化器：

```bash
# Python 3.13+ requires setuptools-scm first
pip install setuptools-scm

# Install Sella (use --no-build-isolation on Python 3.13+)
pip install --no-build-isolation sella
```

如果未安装 Sella 却选择了 Sella 优化器，服务器会返回包含安装说明的明确错误信息。

更多细节见 [Sella GitHub 仓库](https://github.com/zadorlab/sella)。

## 优化选项

| 选项 | 类型 | 说明 |
|--------|------|-------------|
| `calculator` | string | 计算器名称（如 "mace"、"xtb_gfn2"） |
| `optimizer` | string | 优化算法：`bfgs`、`sella_min`、`sella_ts`、`irc` |
| `fmax` | number | 力收敛判据（eV/A） |
| `max_steps` | number | 最大优化步数 |
| `optimize_cell` | boolean | 同时弛豫晶胞形状/体积 |
| `frozen_atoms` | number[] | 需要固定的原子 index |

## 实时进度

WebSocket 优化会流式返回逐步更新：

```typescript
interface OptimizationStep {
  step: number          // Current step number
  energy: number        // Total energy (eV)
  fmax: number          // Maximum force (eV/A)
  structure: Structure  // Current atomic positions
  converged: boolean    // Whether fmax < threshold
}
```

UI 会显示：
- 能量收敛曲线
- 最大力（fmax）收敛曲线
- 每一步实时更新三维结构
- 步数计数器和状态

## Frozen Atoms

原子可以标记为“固定”，从优化中排除：

- **环形标记** — 固定原子周围的圆环
- **交叉阴影** — 图案化叠层
- **变暗** — 降低不透明度

固定原子会以 index 数组传递给优化器。

## 组件

| 组件 | 说明 |
|-----------|-------------|
| `OptimizationPane.svelte` | 计算器选择、选项、运行/停止控制 |
| 能量/力收敛图 | 优化过程中的实时折线图 |

## 架构

```
Browser                          Server
┌──────────────┐    HTTP/WS     ┌───────────────────────────┐
│ Optimization │ ──────────────→│ FastAPI Server             │
│ Pane         │                │  ├── Calculators (energy)  │
│              │←────────────── │  │   ├── EMT               │
│ (real-time   │   step data    │  │   ├── xTB               │
│  updates)    │                │  │   ├── MACE              │
└──────────────┘                │  │   ├── CHGNet            │
                                │  │   └── M3GNet            │
                                │  └── Optimizers (search)   │
                                │      ├── BFGS (default)    │
                                │      ├── Sella Minimize    │
                                │      ├── Sella TS Search   │
                                │      └── IRC               │
┌──────────────┐                └───────────────────────────┘
│ WASM (UFF)   │ ← no server needed
└──────────────┘
```
