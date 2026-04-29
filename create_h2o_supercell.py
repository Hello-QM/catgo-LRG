#!/usr/bin/env python3
"""
为水分子创建10x10x10超胞
"""

import json
from pymatgen.core import Structure, Lattice
from pymatgen.io.vasp import Poscar

def create_h2o_supercell():
    # 读取H2O结构
    with open('Structures/H2O.json', 'r') as f:
        data = json.load(f)
    
    # 提取原子坐标和元素
    atoms_data = data['PC_Compounds'][0]['atoms']
    coords_data = data['PC_Compounds'][0]['coords'][0]
    
    # 转换元素符号 (8=O, 1=H)
    elements = []
    for elem in atoms_data['element']:
        if elem == 8:
            elements.append('O')
        elif elem == 1:
            elements.append('H')
        else:
            elements.append(f'Element{elem}')
    
    # 提取坐标
    coords = []
    for i in range(len(atoms_data['aid'])):
        x = coords_data['x'][i]
        y = coords_data['y'][i]
        z = coords_data['y'][i]  # 原文件中z和y相同，使用y
        coords.append([x, y, z])
    
    # 创建初始晶格（小的盒子，足够容纳一个水分子）
    # 水分子大约是2.8Å，我们给它20Å的盒子
    lattice = Lattice.cubic(20.0)
    
    # 创建结构
    structure = Structure(lattice, elements, coords)
    
    # 创建10x10x10超胞
    supercell = structure * [10, 10, 10]
    
    # 保存到POSCAR文件
    poscar = Poscar(supercell)
    poscar.write_file('H2O_10x10x10.vasp')
    
    # 同时保存为JSON格式
    with open('Structures/H2O_10x10x10.json', 'w') as f:
        json.dump(supercell.as_dict(), f, indent=2)
    
    print(f"水分子超胞已创建:")
    print(f"  原子数: {len(structure.sites)}")
    print(f"  超胞原子数: {len(supercell.sites)}")
    print(f"  超胞尺寸: 10x10x10")
    print(f"  POSCAR文件: H2O_10x10x10.vasp")
    print(f"  JSON文件: Structures/H2O_10x10x10.json")
    
    return supercell

if __name__ == '__main__':
    create_h2o_supercell()