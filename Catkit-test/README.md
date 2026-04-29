# CatKit Helper

快速生成催化反应中间体结构的工具。

## 安装依赖

```bash
# CatKit已安装，如需重新安装：
SKLEARN_ALLOW_DEPRECATED_SKLEARN_PACKAGE_INSTALL=True pip install git+https://github.com/SUNCAT-Center/CatKit.git
```

## 快速使用

### 命令行

```bash
# 生成ORR反应中间体 (Pt111)
python catkit_helper.py ORR Pt 111

# 生成HER反应中间体 (Ni111)
python catkit_helper.py HER Ni 111

# 生成CO2RR反应中间体 (Cu100)
python catkit_helper.py CO2RR_CO Cu 100
```

### Python API

```python
from catkit_helper import generate_reaction, list_reactions

# 查看支持的反应
list_reactions()

# 生成ORR反应中间体
structures = generate_reaction('ORR', surface='Pt', miller=(1,1,1))

# 生成HER反应中间体
structures = generate_reaction('HER', surface='Ni', miller=(1,1,1))

# 自定义反应路径
from catkit_helper import generate_custom_pathway
generate_custom_pathway(['CO', 'CHO', 'CH2O'], surface='Cu', miller=(1,0,0))
```

## 支持的反应

| 反应             | 名称          | 路径                                 |
| ---------------- | ------------- | ------------------------------------ |
| `ORR`            | 氧还原反应    | O2 → *OOH → *O → *OH → H2O           |
| `OER`            | 析氧反应      | H2O → *OH → *O → *OOH → O2           |
| `HER`            | 析氢反应      | H+ → *H → ½H2                        |
| `CO2RR_CO`       | CO2还原制CO   | CO2 → *COOH → *CO → CO               |
| `CO2RR_CH4`      | CO2还原制甲烷 | CO2 → *COOH → *CO → *CHO → ... → CH4 |
| `NRR`            | 氮还原反应    | *N2 → *NNH → ... → NH3               |
| `CO_oxidation`   | CO氧化        | *CO + *O → CO2                       |
| `CH4_activation` | 甲烷活化      | CH4 → *CH3 → *CH2 → *CH → *C         |

## 支持的表面

**FCC金属**: Pt, Pd, Au, Ag, Cu, Ni, Al, Rh, Ir, Co, Ru

**BCC金属**: Fe, W, Mo, Cr, V

**Miller指数**: (1,1,1), (1,0,0), (1,1,0), (2,1,1), ...

## 输出格式

所有结构保存为 `.traj` 格式（ASE trajectory），保留周期性边界条件。

```
./ORR_Pt111/
├── slab.traj      # 干净表面
├── O2.traj        # *O2
├── OOH.traj       # *OOH
├── O.traj         # *O
├── OH.traj        # *OH
└── H2O.traj       # *H2O
```

## 后续计算

生成的结构可用于：

1. **DFT计算** (VASP, QE, GPAW等)
2. **MLP优化** (MACE, CHGNet, M3GNet)
3. **反应能计算**
4. **过渡态搜索** (NEB)

```python
from ase.io import read
from ase.optimize import BFGS

# 读取结构
atoms = read('./ORR_Pt111/OH.traj')

# 设置计算器 (示例: MACE)
# from mace.calculators import MACECalculator
# atoms.calc = MACECalculator(model_path='...')

# 结构优化
# opt = BFGS(atoms)
# opt.run(fmax=0.05)
```
