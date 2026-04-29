from energydiagram import EnergyDiagram, DiagramConfig
import matplotlib
matplotlib.use('TkAgg')
import matplotlib.pyplot as plt
import pandas as pd
import dataclasses

@dataclasses.dataclass
class GasPhaseEnergy:
    E_H2: float = -6.77
    E_C2H2: float = -22.98
    E_C2H4: float = -32.04
    G_H2: float = -6.89
    G_C2H2: float = -22.90
    G_C2H4: float = -31.38

gas_energy = GasPhaseEnergy()
# get the data from the excel file
def plot_energy_diagram():
# get the steps and energies from the dataframe
    reactioncoordinate = pd.read_excel("energy_info.xlsx", index_col=0).index.to_list()
    energy_list = pd.read_excel("energy_info.xlsx", index_col=0)["Energy_profile"].to_list()
    gibbs_list = pd.read_excel("energy_info.xlsx", index_col=0)["Gibbs_profile"].to_list()


    # 创建测试数据
    config = DiagramConfig(
        figure_size=(24, 12),
        energy_label_format=".2f",
        vertical_spacing=0.1
    )
    diagram = EnergyDiagram(config)

    # 添加路径
    diagram.add_energy_path(reactioncoordinate, gibbs_list, color="steelblue", label="Demo")

    # add the horizontal line for the C2H4
    gibbs_C2H4 = gas_energy.G_C2H4 - gas_energy.G_H2 - gas_energy.G_C2H2
    #plt.axhline(energy_C2H4, color="red", label="C2H4")
    
    diagram.ax.axhline(gibbs_C2H4, color="black",linestyle="--",alpha=0.5,linewidth=2)
    text_obj = diagram.ax.text(0.5, gibbs_C2H4+0.1, 
             f"$C_2H_4(g)$: {gibbs_C2H4:.2f} eV", 
             ha="center", va="bottom", fontsize=28, 
             color="black", picker=True,
             gid="C2H4_gas",zorder=5)
    
    print(diagram.text_labels)
    # 启用交互
    
    # 交互模式
    plt.ion()
    fig, ax = diagram.render()
    diagram.text_labels.append(text_obj)
    diagram.enable_interaction()
    plt.show()

    # 操作提示
    print("操作指南：")
    print("1. 单击选择标签（黄色高亮）")
    print("2. 使用方向键调整位置")
    print("3. Shift+方向键加速移动")
    print("4. 关闭窗口后自动保存")

    input("调整完成后按Enter保存...")
    diagram.save("keyboard_adjusted.png", dpi=300)
    plt.ioff()

if __name__ == "__main__":
    plot_energy_diagram()