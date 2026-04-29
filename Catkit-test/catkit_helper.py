"""
CatKit Helper - 快速生成催化反应中间体结构

用法:
    from catkit_helper import generate_reaction, list_reactions

    # 查看支持的反应
    list_reactions()

    # 生成ORR反应中间体 (所有中间体保存在一个traj文件中)
    generate_reaction('ORR', surface='Pt', miller=(1,1,1))
    # 输出: ./ORR_Pt111/pathway.traj (包含所有中间体)

    # 躺式吸附
    add_adsorbate_lying(slab, 'CO2')  # CO2平躺
    add_adsorbate_lying(slab, 'O2')   # O2平躺
"""

import numpy as np
from catkit.gen.surface import SlabGenerator
from catkit.gen.adsorption import Builder
from catkit.build import molecule
from ase.build import bulk
from ase.io import write, read
from ase.io.trajectory import Trajectory
from ase import Atoms
import os
import warnings
warnings.filterwarnings('ignore')


# ============================================================
# 预定义反应路径
# ============================================================

REACTIONS = {
    'ORR': {
        'name': 'Oxygen Reduction Reaction (氧还原反应)',
        'pathway': 'O2 → *OOH → *O + H2O → *OH + H2O → 2H2O',
        'intermediates': ['O2', 'OOH', 'O', 'OH', 'H2O'],
    },
    'OER': {
        'name': 'Oxygen Evolution Reaction (析氧反应)',
        'pathway': 'H2O → *OH → *O → *OOH → O2',
        'intermediates': ['OH', 'O', 'OOH'],
    },
    'HER': {
        'name': 'Hydrogen Evolution Reaction (析氢反应)',
        'pathway': 'H+ + e- → *H → ½H2',
        'intermediates': ['H'],
    },
    'CO2RR_CO': {
        'name': 'CO2 Reduction to CO (CO2还原制CO)',
        'pathway': 'CO2 → *COOH → *CO → CO',
        'intermediates': ['COOH', 'CO'],
    },
    'CO2RR_CH4': {
        'name': 'CO2 Reduction to CH4 (CO2还原制甲烷)',
        'pathway': 'CO2 → *COOH → *CO → *CHO → *CH2O → *CH3O → CH4',
        'intermediates': ['COOH', 'CO', 'CHO', 'CH2O', 'CH3O'],
    },
    'CO2RR_HCOOH': {
        'name': 'CO2 Reduction to HCOOH (CO2还原制甲酸)',
        'pathway': 'CO2 → *OCHO → HCOOH',
        'intermediates': ['OCHO'],
    },
    'NRR': {
        'name': 'Nitrogen Reduction Reaction (氮还原反应)',
        'pathway': '*N2 → *NNH → *NNH2 → *N + NH3 → *NH → *NH2 → NH3',
        'intermediates': ['N2', 'NNH', 'NNH2', 'N', 'NH', 'NH2', 'NH3'],
    },
    'CO_oxidation': {
        'name': 'CO Oxidation (CO氧化)',
        'pathway': '*CO + *O → CO2',
        'intermediates': ['CO', 'O'],
    },
    'CH4_activation': {
        'name': 'Methane Activation (甲烷活化)',
        'pathway': 'CH4 → *CH3 → *CH2 → *CH → *C',
        'intermediates': ['CH3', 'CH2', 'CH', 'C'],
    },
    'RWGS': {
        'name': 'Reverse Water-Gas Shift (逆水煤气变换)',
        'pathway': 'CO2 + H2 → CO + H2O',
        'intermediates': ['CO2', 'H', 'COOH', 'CO', 'OH', 'H2O'],
    },
}

# 吸附物位点偏好和吸附模式
ADSORBATE_CONFIG = {
    # 单原子 - hollow位点
    'H': {'site': 'hollow', 'mode': 'upright'},
    'O': {'site': 'hollow', 'mode': 'upright'},
    'N': {'site': 'hollow', 'mode': 'upright'},
    'C': {'site': 'hollow', 'mode': 'upright'},
    # 双原子
    'OH': {'site': 'ontop', 'mode': 'upright'},
    'CO': {'site': 'ontop', 'mode': 'upright'},
    'NH': {'site': 'hollow', 'mode': 'upright'},
    'CH': {'site': 'hollow', 'mode': 'upright'},
    # 三原子及以上
    'H2O': {'site': 'ontop', 'mode': 'upright'},
    'NH2': {'site': 'ontop', 'mode': 'upright'},
    'NH3': {'site': 'ontop', 'mode': 'upright'},
    'CH2': {'site': 'bridge', 'mode': 'upright'},
    'CH3': {'site': 'ontop', 'mode': 'upright'},
    'COOH': {'site': 'ontop', 'mode': 'upright'},
    'CHO': {'site': 'ontop', 'mode': 'upright'},
    'OCHO': {'site': 'bridge', 'mode': 'bidentate'},  # 甲酸根双齿
    'CH2O': {'site': 'ontop', 'mode': 'upright'},
    'CH3O': {'site': 'ontop', 'mode': 'upright'},
    # 分子吸附 - 可躺可立
    'O2': {'site': 'bridge', 'mode': 'lying'},   # O2倾向躺式
    'N2': {'site': 'bridge', 'mode': 'lying'},   # N2倾向躺式
    'CO2': {'site': 'ontop', 'mode': 'lying'},   # CO2躺式
    'OOH': {'site': 'ontop', 'mode': 'upright'},
    'NNH': {'site': 'bridge', 'mode': 'upright'},
    'NNH2': {'site': 'bridge', 'mode': 'upright'},
}

# 晶格常数 (Å)
LATTICE_CONSTANTS = {
    # FCC metals
    'Pt': ('fcc', 3.92), 'Pd': ('fcc', 3.89), 'Au': ('fcc', 4.08),
    'Ag': ('fcc', 4.09), 'Cu': ('fcc', 3.61), 'Ni': ('fcc', 3.52),
    'Al': ('fcc', 4.05), 'Rh': ('fcc', 3.80), 'Ir': ('fcc', 3.84),
    # BCC metals
    'Fe': ('bcc', 2.87), 'W': ('bcc', 3.16), 'Mo': ('bcc', 3.15),
    'Cr': ('bcc', 2.88), 'V': ('bcc', 3.02),
    # HCP metals (用fcc近似)
    'Co': ('fcc', 3.54), 'Ru': ('fcc', 3.83), 'Ti': ('fcc', 4.11),
    'Zn': ('fcc', 3.94),
}

# 躺式吸附分子的几何参数
LYING_MOLECULES = {
    'O2': {'symbols': 'OO', 'bond_length': 1.21, 'height': 2.0},
    'N2': {'symbols': 'NN', 'bond_length': 1.10, 'height': 2.0},
    'CO2': {'symbols': 'OCO', 'bond_lengths': [1.16, 1.16], 'height': 2.5},
    'C2H4': {'symbols': 'CCHH', 'bond_length': 1.34, 'height': 2.0},  # 乙烯
}


def list_reactions():
    """列出所有支持的催化反应"""
    print("=" * 70)
    print("支持的催化反应")
    print("=" * 70)
    for key, info in REACTIONS.items():
        print(f"\n{key}:")
        print(f"  名称: {info['name']}")
        print(f"  路径: {info['pathway']}")
        print(f"  中间体: {', '.join(info['intermediates'])}")
    print("\n" + "=" * 70)


def list_surfaces():
    """列出所有支持的表面元素"""
    print("=" * 50)
    print("支持的表面元素")
    print("=" * 50)
    print("\nFCC金属: Pt, Pd, Au, Ag, Cu, Ni, Al, Rh, Ir, Co, Ru")
    print("BCC金属: Fe, W, Mo, Cr, V")
    print("\nMiller指数示例: (1,1,1), (1,0,0), (1,1,0), (2,1,1)")
    print("=" * 50)


def build_surface(element, miller=(1,1,1), layers=4, size=(3,3), vacuum=12):
    """
    构建催化剂表面

    Parameters
    ----------
    element : str
        元素符号，如 'Pt', 'Cu', 'Fe'
    miller : tuple
        Miller指数，如 (1,1,1), (1,0,0)
    layers : int
        原子层数
    size : tuple
        超胞大小
    vacuum : float
        真空层厚度 (Å)

    Returns
    -------
    slab : Atoms
        表面结构
    """
    if element not in LATTICE_CONSTANTS:
        raise ValueError(f"不支持的元素: {element}. 支持: {list(LATTICE_CONSTANTS.keys())}")

    crystal, a = LATTICE_CONSTANTS[element]
    bulk_struct = bulk(element, crystal, a=a)

    gen = SlabGenerator(
        bulk_struct,
        miller_index=miller,
        layers=layers,
        vacuum=vacuum,
        fixed=2,
        standardize_bulk=True
    )
    return gen.get_slab(size=size)


def add_adsorbate(slab, adsorbate_name, site_type=None, site_index=0, mode=None):
    """
    在表面添加吸附物 (直立模式)

    Parameters
    ----------
    slab : Atoms
        表面结构
    adsorbate_name : str
        吸附物名称，如 'CO', 'OH', 'H'
    site_type : str, optional
        位点类型: 'ontop', 'bridge', 'hollow'. 默认自动选择
    site_index : int
        同类型位点中的索引
    mode : str, optional
        吸附模式: 'upright', 'lying'. 默认根据分子类型选择

    Returns
    -------
    struct : Atoms
        吸附后的结构
    """
    config = ADSORBATE_CONFIG.get(adsorbate_name, {'site': 'ontop', 'mode': 'upright'})

    if site_type is None:
        site_type = config['site']
    if mode is None:
        mode = config['mode']

    # 躺式吸附用手动方法
    if mode == 'lying' and adsorbate_name in LYING_MOLECULES:
        return add_adsorbate_lying(slab, adsorbate_name, site_index=site_index)

    # 直立吸附用CatKit
    mol = molecule(adsorbate_name)[0]

    builder = Builder(slab)
    site_types = builder.get_connectivity()

    type_map = {'ontop': 1, 'bridge': 2, 'hollow': 3}
    target_type = type_map.get(site_type, 1)

    available = np.where(site_types == target_type)[0]
    if len(available) == 0:
        available = np.where(site_types == 1)[0]

    idx = available[site_index % len(available)]

    return builder.add_adsorbate(mol, bonds=[0], index=idx)


def add_adsorbate_lying(slab, adsorbate_name, site_index=0):
    """
    添加躺式吸附分子

    Parameters
    ----------
    slab : Atoms
        表面结构
    adsorbate_name : str
        分子名称: 'O2', 'N2', 'CO2', 'C2H4'
    site_index : int
        位点索引

    Returns
    -------
    struct : Atoms
        吸附后的结构
    """
    if adsorbate_name not in LYING_MOLECULES:
        raise ValueError(f"躺式吸附不支持: {adsorbate_name}. 支持: {list(LYING_MOLECULES.keys())}")

    mol_info = LYING_MOLECULES[adsorbate_name]
    slab_copy = slab.copy()

    # 获取表面最高原子的z坐标
    surface_z = slab_copy.positions[:, 2].max()
    height = mol_info['height']

    # 获取吸附位点坐标
    builder = Builder(slab_copy)
    coords = builder.get_coordinates()
    site_coord = coords[site_index % len(coords)]

    # 构建躺式分子
    if adsorbate_name == 'O2':
        d = mol_info['bond_length']
        mol = Atoms('OO', positions=[
            [site_coord[0] - d/2, site_coord[1], surface_z + height],
            [site_coord[0] + d/2, site_coord[1], surface_z + height],
        ])
    elif adsorbate_name == 'N2':
        d = mol_info['bond_length']
        mol = Atoms('NN', positions=[
            [site_coord[0] - d/2, site_coord[1], surface_z + height],
            [site_coord[0] + d/2, site_coord[1], surface_z + height],
        ])
    elif adsorbate_name == 'CO2':
        d = mol_info['bond_lengths'][0]
        mol = Atoms('OCO', positions=[
            [site_coord[0] - d, site_coord[1], surface_z + height],
            [site_coord[0], site_coord[1], surface_z + height],
            [site_coord[0] + d, site_coord[1], surface_z + height],
        ])
    else:
        raise ValueError(f"未实现: {adsorbate_name}")

    result = slab_copy + mol
    result.cell = slab_copy.cell
    result.pbc = slab_copy.pbc

    return result


def generate_reaction(reaction_name, surface='Pt', miller=(1,1,1),
                      layers=4, size=(3,3), vacuum=12, output_dir=None,
                      save_separate=False):
    """
    生成指定催化反应的所有中间体结构

    Parameters
    ----------
    reaction_name : str
        反应名称，如 'ORR', 'HER', 'CO2RR_CO'
    surface : str
        表面元素，如 'Pt', 'Cu', 'Fe'
    miller : tuple
        Miller指数，如 (1,1,1)
    layers : int
        原子层数
    size : tuple
        超胞大小
    vacuum : float
        真空层厚度 (Å)
    output_dir : str, optional
        输出目录，默认自动生成
    save_separate : bool
        是否同时保存单独的traj文件

    Returns
    -------
    structures : dict
        {中间体名称: Atoms对象}

    输出文件
    --------
    pathway.traj : 包含所有中间体的trajectory文件 (按反应顺序)
    intermediates.txt : 中间体列表说明

    Example
    -------
    >>> structures = generate_reaction('ORR', surface='Pt', miller=(1,1,1))
    >>> # 读取pathway.traj查看所有中间体
    >>> from ase.io import read
    >>> all_structures = read('./ORR_Pt111/pathway.traj', index=':')
    """
    if reaction_name not in REACTIONS:
        print(f"未知反应: {reaction_name}")
        list_reactions()
        return None

    reaction = REACTIONS[reaction_name]

    # 设置输出目录
    if output_dir is None:
        miller_str = ''.join(map(str, miller))
        output_dir = f'./{reaction_name}_{surface}{miller_str}'
    os.makedirs(output_dir, exist_ok=True)

    # 构建表面
    slab = build_surface(surface, miller=miller, layers=layers, size=size, vacuum=vacuum)

    print(f"\n{'='*60}")
    print(f"反应: {reaction['name']}")
    print(f"路径: {reaction['pathway']}")
    print(f"表面: {surface}{miller}, {len(slab)} 原子")
    print(f"输出: {output_dir}")
    print(f"{'='*60}\n")

    structures = {}
    pathway_structures = []  # 按顺序存储所有结构
    info_lines = []  # 记录每个结构的信息

    # 0. 干净表面
    slab.info['name'] = 'slab'
    structures['slab'] = slab
    pathway_structures.append(slab)
    info_lines.append("0: slab (干净表面)")
    print(f"0. slab (干净表面)")

    # 生成各中间体
    for i, ads_name in enumerate(reaction['intermediates'], 1):
        try:
            struct = add_adsorbate(slab, ads_name)
            struct.info['name'] = ads_name  # 存储名称到info

            structures[ads_name] = struct
            pathway_structures.append(struct)

            config = ADSORBATE_CONFIG.get(ads_name, {})
            site = config.get('site', 'ontop')
            mode = config.get('mode', 'upright')

            info_lines.append(f"{i}: {ads_name} ({site}, {mode})")
            print(f"{i}. {ads_name} ({site}, {mode})")

            # 可选：同时保存单独文件
            if save_separate:
                write(f'{output_dir}/{ads_name}.traj', struct)

        except Exception as e:
            print(f"✗ {ads_name}: {e}")
            info_lines.append(f"{i}: {ads_name} (失败: {e})")

    # 保存pathway.traj (包含所有结构)
    pathway_file = f'{output_dir}/pathway.traj'
    traj = Trajectory(pathway_file, 'w')
    for struct in pathway_structures:
        traj.write(struct)
    traj.close()

    # 保存说明文件
    with open(f'{output_dir}/intermediates.txt', 'w') as f:
        f.write(f"反应: {reaction['name']}\n")
        f.write(f"路径: {reaction['pathway']}\n")
        f.write(f"表面: {surface}{miller}\n")
        f.write(f"\n结构列表 (pathway.traj中的顺序):\n")
        f.write("-" * 40 + "\n")
        for line in info_lines:
            f.write(line + "\n")
        f.write("-" * 40 + "\n")
        f.write(f"\n读取方法:\n")
        f.write(f"  from ase.io import read\n")
        f.write(f"  structures = read('{pathway_file}', index=':')\n")
        f.write(f"  # structures[0] = slab\n")
        for i, ads_name in enumerate(reaction['intermediates'], 1):
            f.write(f"  # structures[{i}] = {ads_name}\n")

    print(f"\n完成! 共 {len(pathway_structures)} 个结构")
    print(f"  → {pathway_file}")
    print(f"  → {output_dir}/intermediates.txt")

    return structures


def generate_custom_pathway(intermediates, surface='Pt', miller=(1,1,1),
                            output_dir=None, **kwargs):
    """
    生成自定义反应路径的中间体

    Parameters
    ----------
    intermediates : list
        中间体列表，如 ['CO', 'CHO', 'CH2O', 'CH3O', 'CH4']
    surface : str
        表面元素
    miller : tuple
        Miller指数

    Returns
    -------
    structures : dict

    Example
    -------
    >>> generate_custom_pathway(['CO', 'H', 'CHO'], surface='Cu', miller=(1,1,1))
    """
    if output_dir is None:
        miller_str = ''.join(map(str, miller))
        output_dir = f'./custom_{surface}{miller_str}'
    os.makedirs(output_dir, exist_ok=True)

    slab = build_surface(surface, miller=miller, **kwargs)

    print(f"\n{'='*60}")
    print(f"自定义路径: {' → '.join(intermediates)}")
    print(f"表面: {surface}{miller}")
    print(f"{'='*60}\n")

    structures = {'slab': slab}
    pathway_structures = [slab]

    print(f"0. slab (干净表面)")

    for i, ads_name in enumerate(intermediates, 1):
        try:
            struct = add_adsorbate(slab, ads_name)
            struct.info['name'] = ads_name
            structures[ads_name] = struct
            pathway_structures.append(struct)
            print(f"{i}. {ads_name}")
        except Exception as e:
            print(f"✗ {ads_name}: {e}")

    # 保存pathway.traj
    pathway_file = f'{output_dir}/pathway.traj'
    traj = Trajectory(pathway_file, 'w')
    for struct in pathway_structures:
        traj.write(struct)
    traj.close()

    print(f"\n完成! → {pathway_file}")
    return structures


# ============================================================
# 命令行接口
# ============================================================

if __name__ == '__main__':
    import sys

    if len(sys.argv) < 2:
        print("用法: python catkit_helper.py <反应名> [表面元素] [Miller指数]")
        print("示例: python catkit_helper.py ORR Pt 111")
        print("      python catkit_helper.py HER Ni 111")
        print("      python catkit_helper.py CO2RR_CO Cu 100")
        print("\n可用反应:")
        for r in REACTIONS:
            print(f"  - {r}")
        sys.exit(0)

    reaction = sys.argv[1]
    surface = sys.argv[2] if len(sys.argv) > 2 else 'Pt'
    miller_str = sys.argv[3] if len(sys.argv) > 3 else '111'
    miller = tuple(int(x) for x in miller_str)

    generate_reaction(reaction, surface=surface, miller=miller)
