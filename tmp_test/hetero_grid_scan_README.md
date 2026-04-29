# 异质结对称性约化网格穷举搜索

## 方法原理

在异质结（heterostructure）中寻找最优堆叠位置时，需要扫描 film 相对于 substrate 的所有横向平移 $(\Delta x, \Delta y)$。暴力穷举整个单胞计算量大，但利用 film 层的二维对称性可以大幅缩减搜索空间。

### 核心思路

$$
\text{全单胞搜索空间} \xrightarrow{\text{2D对称性约化}} \text{不可约楔形区} \xrightarrow{N \times M \text{ 均匀网格}} \text{候选构型集}
$$

### 算法流程

**Step 1 — 构建异质结**

1. 输入 substrate 和 film 两个 slab 结构
2. 去除真空层（strip vacuum）
3. ZSL（Zur and McGill Substrate-Layer）晶格匹配：在容差范围内搜索使 film 和 substrate 晶格共度的超胞变换矩阵
4. 对 film 施加应变使其 $\mathbf{a}, \mathbf{b}$ 精确匹配 substrate
5. 按指定 gap 和 vacuum 堆叠为异质结

**Step 2 — 对称性分析与网格穷举**

1. 对 film 结构进行三维空间群分析（pymatgen `SpacegroupAnalyzer`）
2. 筛选纯二维 in-plane 对称操作：旋转矩阵满足

$$
R = \begin{pmatrix} r_{11} & r_{12} & 0 \\ r_{21} & r_{22} & 0 \\ 0 & 0 & \pm 1 \end{pmatrix}, \quad t_z \approx 0
$$

3. 提取 $2 \times 2$ 旋转子矩阵 $R_{2D}$ 和二维平移 $\mathbf{t}_{2D}$
4. 用精细内部网格（$120 \times 120$）确定不可约楔形区的范围 $(f_x^{\max}, f_y^{\max})$
5. 在 $[0, f_x^{\max}) \times [0, f_y^{\max})$ 内均匀放置用户指定的 $N \times M$ 网格点
6. 对每个网格点 $(f_x, f_y)$，计算笛卡尔平移量：

$$
\Delta \mathbf{r} = f_x \cdot \mathbf{a} + f_y \cdot \mathbf{b}
$$

7. 仅平移 film 原子（索引 $\geq N_{\text{sub}}$），substrate 原子不动
8. 输出 $N \times M$ 个构型

### 对称性缩减效果

| Film 对称性 | 2D 操作数 | 不可约区占比 | 缩减倍数 |
|------------|----------|------------|---------|
| p1（无对称性） | 1 | 100% | 1× |
| p2（二重旋转） | 2 | 50% | 2× |
| p4（四重旋转） | 4 | 25% | 4× |
| p4mm（正方+镜面） | 8 | 12.5% | 8× |
| p6mm（六方+镜面） | 12–16 | 8–11% | 9–12× |

用户设定的网格密度 $N \times M$ 是在不可约区内的密度，输出构型数 = $N \times M$。对称性决定的是**搜索区域大小**（从而影响步长），不是减少输出数量。

### 步长计算

$$
\Delta a = \frac{f_x^{\max} \cdot |\mathbf{a}|}{N}, \quad \Delta b = \frac{f_y^{\max} \cdot |\mathbf{b}|}{M}
$$

例如：$|\mathbf{a}| = 10$ Å 的单胞，p4mm 对称性下 $f_x^{\max} \approx 0.33$，设 $N = 5$：

$$
\Delta a = \frac{0.33 \times 10}{5} = 0.67 \;\text{Å}
$$

---

## 使用方法

### 命令行交互版

```bash
cd tmp_test
python hetero_scan.py
```

运行后按提示操作：

```
Step 1: Build Heterostructure
  Substrate file (衬底): POSCAR_low       ← 输入文件路径
  Film file (薄膜): POSCAR_up
  Gap (Å) [2.0]:                           ← 回车用默认值
  View in ASE? (y/n) [y]:                  ← 弹窗确认结构
  Accept? (y=continue / n=redo / q=quit):  ← 不满意输 n 重选

Step 2: Grid Scan
  Grid Nx [6]:
  Grid Ny [6]:
  Browse all in ASE viewer? (y/n) [y]:     ← 浏览全部构型
  Output file [grid_scan_6x6.extxyz]:      ← 指定输出路径
```

### 命令行批处理版

```bash
python hetero_grid_scan.py substrate.cif film.cif --nx 8 --ny 8 --gap 2.5 -o scan.extxyz
```

参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--nx` | 6 | 不可约区内 a 方向网格数 |
| `--ny` | 6 | 不可约区内 b 方向网格数 |
| `--gap` | 2.0 | 层间距（Å） |
| `--vacuum` | 20.0 | 真空层（Å） |
| `--symprec` | 0.1 | 对称性容差（Å） |
| `--max-area` | 400 | ZSL 匹配最大面积（Å²） |
| `--no-match` | - | 跳过 ZSL（已匹配的异质结） |
| `--n-sub` | - | 与 `--no-match` 配合，指定 substrate 原子数 |
| `-o` | `grid_scan_NxN.extxyz` | 输出文件 |

### CatGO 图形界面版

在 CatGO Structure Viewer 中：

1. **Build Tools → Hetero → Slab** 模式
2. 加载 substrate 和 film → Search → 选择 match → Build
3. Build 完成后出现 **Stacking Grid Scan** 折叠区域
4. 设置 Grid Nx/Ny 和 Symmetry tolerance → Run Grid Scan
5. 结果表格中点击查看每个构型
6. Export .extxyz / Save to Database / Export to HPC

---

## 输出格式

输出为 multi-frame extended XYZ 文件，每帧包含：

- 原子数
- Lattice 矩阵
- `shift_fx`、`shift_fy`：分数坐标位移
- 所有原子的元素符号和笛卡尔坐标

```
108
Lattice="8.33 0.00 0.00 0.00 8.33 0.00 0.00 0.00 28.50" ... shift_fx=0.0000 shift_fy=0.0000
Cu  0.000000  0.000000  0.500000
Cu  2.083000  0.000000  0.500000
...
108
Lattice="8.33 0.00 0.00 0.00 8.33 0.00 0.00 0.00 28.50" ... shift_fx=0.0556 shift_fy=0.0000
Cu  0.000000  0.000000  0.500000
...
```

可用以下工具打开：

- **CatGO**：拖入即可逐帧浏览
- **ASE**：`ase gui grid_scan_6x6.extxyz`
- **OVITO**：直接打开，支持帧动画
- **Python**：`from ase.io import read; frames = read("scan.extxyz", index=":")`

---

## 后续工作流

生成轨迹文件后，典型的后续流程：

```
grid_scan.extxyz (N×M 构型)
    ↓
MLP 快速单点能 (MACE/CHGNet, ~1s/构型)
    ↓
能量排序 → 选出 Top-K 最低能构型
    ↓
DFT 精确优化 (VASP geo_opt, ~小时/构型)
    ↓
最优堆叠位置
```

在 CatGO Workflow 中可以自动完成：

```
structure_input → batch_generate (grid scan) → map → geo_opt (MLP) → aggregate → pick_best
```

---

## 依赖

```bash
pip install pymatgen ase numpy matplotlib
```

---

## 文件清单

| 文件 | 用途 |
|------|------|
| `hetero_scan.py` | 交互式命令行工具（推荐） |
| `hetero_grid_scan.py` | 批处理命令行工具 |
| `hetero_grid_scan_gui.py` | tkinter 图形界面（实验性） |
| `hetero_grid_scan_viewer.py` | matplotlib 可视化查看器 |
