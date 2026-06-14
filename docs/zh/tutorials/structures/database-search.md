# 搜索结构数据库

CatGo 集成了三个用于查找晶体结构和分子的在线数据库：**OPTIMADE**、**Materials Project** 和 **PubChem**。

## OPTIMADE 搜索

[OPTIMADE](https://www.optimade.org/) 是用于查询晶体结构数据库的标准化 API。CatGo 支持同时搜索多个 OPTIMADE provider。

### 打开搜索

点击工具栏中的 **OPTIMADE** 按钮（或数据库图标），打开搜索弹窗。

### 按化学式搜索

1. 在 **Formula** 字段中输入化学式，例如 `NaCl`、`Fe2O3`、`SrTiO3`
2. 点击 **Search** 或按 Enter
3. 结果会显示结构 ID、化学式、位点数量和晶系

化学式会自动归一化为 OPTIMADE 格式，也就是元素按字母顺序排序。

### 按元素搜索

1. 在 **Elements** 字段中输入元素符号，例如 `Fe, O`
2. 打开 **Elements only**，查找只包含这些元素的结构
3. 设置可选筛选项：
   - **Nelements** - 精确元素种类数，或最小/最大范围
   - **Nsites** - 原子位点数量的最小/最大范围

### 使用周期表

点击嵌入式周期表中的任意元素，即可立即搜索包含该元素的结构。

### 选择 Provider

使用 **Database** 下拉框选择 provider：

- **Materials Project** - 大型计算材料数据库
- **AFLOW** - 面向材料发现的自动化流程数据库
- **COD** - Crystallography Open Database，包含实验结构
- 以及更多兼容 OPTIMADE 的数据库

### Materials Project 数据增强

如果配置了 **Materials Project API key**，来自 MP 的搜索结果会带有额外计算性质：

- 带隙（eV）
- 凸包以上能量（eV/atom），用于衡量稳定性
- 晶系和空间群
- 形成能

添加 API key：

1. 在搜索弹窗中点击 **Add API key**
2. 输入来自 [materialsproject.org](https://materialsproject.org/) 的 key
3. 该 key 会保存在浏览器本地（localStorage）

### 导入结构

点击任意结果上的 **Import**，即可加载到 3D 查看器。对于 OPTIMADE 结果，可能会先出现预览弹窗，展示结构后再确认导入。

## PubChem 搜索

[PubChem](https://pubchem.ncbi.nlm.nih.gov/) 提供分子化合物数据。它适合有机分子、药物和小分子体系。

### PubChem 搜索入口

点击工具栏中的 **PubChem** 按钮，打开搜索弹窗。

### 搜索方式

- **按名称** - 输入化合物名，例如 `benzene`、`aspirin`、`caffeine`
- **按分子式** - 输入分子式，例如 `C6H6`、`H2O`
- **按元素** - 点击周期表中的元素

CatGo 会自动判断你输入的是名称还是分子式。

### 结果

结果会显示：

- PubChem Compound ID（CID）
- 分子式
- 化合物名称
- 分子量
- 组成饼图

### 导入

点击 **Import** 加载分子的 3D 结构。PubChem 化合物会作为分子加载，不带周期晶格。3D 坐标来自 PubChem 计算得到的构象数据。

## 关键差异

| 功能 | OPTIMADE | PubChem |
|---------|----------|---------|
| 结构类型 | 晶体（周期性） | 分子（非周期） |
| 晶格 | 有 | 无 |
| 周期边界 | pbc = [true, true, true] | pbc = [false, false, false] |
| 搜索参数 | 化学式、元素、nsites | 名称、分子式、元素 |
| 认证 | 可选（MP API key） | 无 |
| 需要服务器 | 是，需要后端代理以避免 CORS | 是，需要后端代理以避免 CORS |

## 服务器要求

两个数据库搜索功能都会通过 Python 后端转发请求，以处理 CORS 限制。请确认服务器正在运行：

```bash
cd server
python main.py
```

## 使用建议

- **先宽后窄** - 先按元素搜索，再用化学式或位点数量缩小范围。
- **使用 MP API key** - 带隙、稳定性等增强性质能显著提高筛选效率。
- **导入后导出** - 结构导入后，可用 Export 面板保存为需要的格式，例如 CIF、POSCAR 等。
- **结合结构工具** - 从 OPTIMADE 导入体相晶体后，可以用 slab cutter 创建表面。
