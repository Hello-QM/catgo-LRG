from energydiagram import EnergyDiagram, DiagramConfig
import matplotlib
#matplotlib.use('TkAgg')  # 明确指定后端
import matplotlib.pyplot as plt

# 创建简单路径
diagram = EnergyDiagram(DiagramConfig())
steps = ["A", "TS", "B", "TS2", "C"]
energies = [0.0, 1.2, 0.8, 1.5, -0.5]
diagram.add_energy_path(steps, energies, color="navy")

# 交互模式
plt.ion()
diagram.render()
plt.show()

input("拖拽标签测试...")  # 在此阶段进行拖拽操作
diagram.save("drag_test.png")
plt.ioff()

