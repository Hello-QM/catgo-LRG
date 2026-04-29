"""
CatKit Helper 使用示例
"""

from catkit_helper import (
    generate_reaction,
    generate_custom_pathway,
    list_reactions,
    list_surfaces,
    build_surface,
    add_adsorbate
)
from ase.io import write
from ase.visualize import view  # 需要安装ase-gui


# ============================================================
# 示例1: 查看支持的反应和表面
# ============================================================

print("\n" + "="*60)
print("示例1: 查看支持的反应")
print("="*60)
list_reactions()


# ============================================================
# 示例2: 生成ORR反应中间体 (Pt111)
# ============================================================

print("\n" + "="*60)
print("示例2: ORR on Pt(111)")
print("="*60)
structures = generate_reaction('ORR', surface='Pt', miller=(1,1,1))


# ============================================================
# 示例3: 生成HER反应中间体 (多种表面)
# ============================================================

print("\n" + "="*60)
print("示例3: HER on 不同表面")
print("="*60)

for metal in ['Pt', 'Ni', 'Fe', 'Cu']:
    generate_reaction('HER', surface=metal, miller=(1,1,1),
                      output_dir=f'./HER_comparison/{metal}111')


# ============================================================
# 示例4: 生成CO2RR反应中间体 (Cu100)
# ============================================================

print("\n" + "="*60)
print("示例4: CO2RR on Cu(100)")
print("="*60)
generate_reaction('CO2RR_CO', surface='Cu', miller=(1,0,0))


# ============================================================
# 示例5: 自定义反应路径
# ============================================================

print("\n" + "="*60)
print("示例5: 自定义反应路径")
print("="*60)

# 甲醇氧化: CH3OH → CH2OH → CHOH → CHO → CO → CO2
my_intermediates = ['CH3O', 'CH2O', 'CHO', 'CO']
generate_custom_pathway(my_intermediates, surface='Pt', miller=(1,1,1),
                        output_dir='./MeOH_oxidation_Pt111')


# ============================================================
# 示例6: 手动构建和添加吸附物
# ============================================================

print("\n" + "="*60)
print("示例6: 手动构建")
print("="*60)

# 构建表面
slab = build_surface('Pd', miller=(1,1,1), layers=4, size=(2,2))
print(f"Pd(111) 2x2 表面: {len(slab)} 原子")

# 添加CO到ontop位点
slab_co = add_adsorbate(slab, 'CO', site_type='ontop')
print(f"添加CO后: {slab_co.get_chemical_formula()}")

# 保存
write('./manual_Pd111_CO.traj', slab_co)
print("保存为: ./manual_Pd111_CO.traj")


# ============================================================
# 示例7: 可视化 (需要ase-gui)
# ============================================================

# 取消注释下面这行来可视化结构
# view(structures['OH'])


print("\n" + "="*60)
print("所有示例完成!")
print("="*60)
