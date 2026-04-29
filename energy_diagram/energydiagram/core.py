import matplotlib.pyplot as plt
import numpy as np
from scipy.interpolate import CubicSpline
from typing import List, Dict, Union
from dataclasses import dataclass
import matplotlib.font_manager as fm
from .interaction import LabelEditorMixin
import os
import yaml

@dataclass
class DiagramConfig:
    """Configuration for energy diagram styling"""
    # 图表尺寸 (单位: 英寸)
    figure_size: tuple = (18, 12)
    
    # 字体文件路径 (支持TTF/OTF)
    _module_dir = os.path.dirname(os.path.abspath(__file__))
    _settings_path = os.path.join(_module_dir, "SETTINGS.yaml")
    
    try:
        with open(_settings_path, "r") as f:
            settings = yaml.safe_load(f)
        font_path: str = settings["font_path"]
    except FileNotFoundError:
        raise RuntimeError(f"SETTINGS.yaml not found in module directory: {_module_dir}")
    except KeyError:
        raise RuntimeError("SETTINGS.yaml missing 'font_path' configuration")
    
    # Font size
    font_size_legend: float = 14
    font_size_xlabel: float = 24
    font_size_ylabel: float = 24
    font_size_xtick: float = 16
    font_size_ytick: float = 16
    font_size_text: float = 24
    xtick_rotation: float = 0
    frameon: bool = False
    tick_length: float = 10
    tick_width: float = 2.5
    spine_width: float = 2.0
    spine_visible: bool = True
    
    # 能量标签格式 (遵循Python格式规范)
    energy_label_format: str = ".2f"  # 示例：1.23
    
    # 线条基础样式
    line_width: float = 2.5          # 主路径线宽
    dash_pattern: tuple = (4, 2)     # 虚线样式 (线段长, 间隔长)
    
    # 标签垂直间距 (单位: eV)
    vertical_spacing: float = 0.1    # 控制同一位置不同催化剂标签的最小间距
    
    # 过渡态样式 (字典形式)
    ts_style: dict = None            
    
    # 新增手动调整配置
    manual_label_adjust: dict = None  # 格式: {(row, col): (dx, dy)}
    
    # Set spacing of energy path
    base_spacing: float = 1.0    
    hline_ratio: float = 0.2
    ts_spacing_ratio: float = 0.4
    vline_ratio: float = 0.4

    # Set range of y-axis
    dy_min: float = 0.2  # y - dy_min = y_min
    dy_max: float = 0.2  # y + dy_max = y_max

    def __post_init__(self):
        # 设置过渡态默认样式
        self.ts_style = self.ts_style or {
            'linewidth': 2.5,
            'linestyle': '--',
            'dashes': self.dash_pattern,  # 添加虚线样式
            'alpha': 0.8
        }

class EnergyDiagram(LabelEditorMixin):
    def __init__(self, config: DiagramConfig = None):
        self.config = config or DiagramConfig()
        self._init_font()
        self.fig, self.ax = plt.subplots(figsize=self.config.figure_size)
        self.energy_paths = []
        self._xticks_cache = None
        self.text_labels = []  # 初始化标签存储
        self.init_label_editing()  # 初始化编辑功能
        
    def _init_font(self):
        """Initialize custom font configuration"""
        try:
            self.font_prop = fm.FontEntry(
                fname=self.config.font_path,
                name='DiagramFont'
            )
            fm.fontManager.ttflist.insert(0, self.font_prop)
        except Exception as e:
            raise RuntimeError(f"Font initialization failed: {str(e)}")

        plt.rcParams.update({
            'font.family': 'sans-serif',
            'font.sans-serif': [self.font_prop.name],
            'axes.unicode_minus': False
        })
    
    def add_energy_path(self, 
                      coordinates: List[str],
                      energies: Union[List[float], np.ndarray],
                      color: str = 'black',
                      label: str = None,
                      style: dict = None):
        """
        Add an energy path to the diagram
        """
        if len(coordinates) != len(energies):
            raise ValueError("Coordinates and energies must have same length")
            
        self.energy_paths.append({
            'coordinates': coordinates,
            'energies': np.asarray(energies),
            'color': color,
            'label': label,
            'style': style or {}
        })
    
    def _plot_transition_state(self, x_start, x_end, y_start, y_mid, y_end, color):
        """Plot transition state curve using cubic spline"""
        # 第一段：起点到顶点
        spline1 = CubicSpline([x_start, (x_start + x_end)/2], 
                            [y_start, y_mid], bc_type=((1, 0), (1, 0)))
        x1_curve = np.linspace(x_start, (x_start + x_end)/2, 50)
        y1_curve = spline1(x1_curve)

        # 第二段：顶点到终点
        spline2 = CubicSpline([(x_start + x_end)/2, x_end], 
                            [y_mid, y_end], bc_type=((1, 0), (1, 0)))
        x2_curve = np.linspace((x_start + x_end)/2, x_end, 50)
        y2_curve = spline2(x2_curve)

        # 合并绘制
        self.ax.plot(np.concatenate([x1_curve, x2_curve]),
                   np.concatenate([y1_curve, y2_curve]),
                   color=color,
                   **self.config.ts_style)
    
    def _plot_energy_segment(self, ax, path_data):
        """Plot individual energy path segments"""
        coordinates = path_data['coordinates']
        energies = path_data['energies']
        color = path_data['color']
        label = path_data['label']
        style = path_data['style']
        
        tick_positions = []

        hline_len = self.config.base_spacing * self.config.hline_ratio
        ts_space = self.config.base_spacing * self.config.ts_spacing_ratio
        vline_len = self.config.base_spacing * self.config.vline_ratio

        n_hline = 0
        n_ts = 0
        n_vline = 0

        for i, (coord, energy) in enumerate(zip(coordinates, energies)):
            if "TS" in coord:
                # 绘制过渡态曲线
                x_start = n_hline * hline_len + n_vline * vline_len + n_ts * ts_space
                x_end = x_start + ts_space
                self._plot_transition_state(x_start, x_end,
                                          energies[i-1], energies[i],
                                          energies[i+1], color)
                n_ts += 1
                tick_positions.append((x_start + x_end)/2)
        
            else:
                # 绘制水平线段
                x_start = n_hline * hline_len + n_vline * vline_len + n_ts * ts_space
                x_end = x_start + hline_len
                ax.plot([x_start, x_end], [energy, energy], 
                       color=color, linewidth=self.config.line_width,
                       label=label if i == 0 else None, **style)
                n_hline += 1
                tick_positions.append((x_start + x_end)/2)

                plot_done = False
                try:
                    next_is_ts = "TS" in coordinates[i+1]
                except:
                    plot_done = True

                if next_is_ts:
                    continue
                elif not plot_done:
                    # 绘制虚线段
                    x_start = x_end
                    x_end = x_start + vline_len
                    ax.plot([x_start, x_end], [energy, energies[i+1]], linestyle='--',
                           color=color, linewidth=self.config.line_width,**style)
                    n_vline += 1
        
        return tick_positions
    
    def _adjust_label_positions(self, energies_matrix: np.ndarray) -> np.ndarray:
        """Adjust energy label positions to prevent overlap"""
        adjusted = energies_matrix.copy()
        for col in range(energies_matrix.shape[1]):
            column = [(adjusted[row, col], row) for row in range(energies_matrix.shape[0])]
            column.sort()
            
            for k in range(1, len(column)):
                prev_val, prev_idx = column[k-1]
                curr_val, curr_idx = column[k]
                
                if curr_val - prev_val < self.config.vertical_spacing:
                    delta = self.config.vertical_spacing - (curr_val - prev_val)
                    adjusted[curr_idx, col] += delta
        return adjusted
    
    def add_label_adjustment(self, position: tuple, offset: tuple):
        """
        添加单个标签的位置调整
        :param position: (row, col) 元组,row-路径索引,col-坐标点索引
        :param offset: (dx, dy) 坐标偏移量
        """
        if not self.config.manual_label_adjust:
            self.config.manual_label_adjust = {}
        self.config.manual_label_adjust[position] = offset

    def _apply_manual_adjustments(self, adjusted_energies: np.ndarray) -> np.ndarray:
        """应用手动调整到标签位置"""
        if self.config.manual_label_adjust:
            for (row, col), (dx, dy) in self.config.manual_label_adjust.items():
                if 0 <= row < adjusted_energies.shape[0] and 0 <= col < adjusted_energies.shape[1]:
                    adjusted_energies[row, col] += dy  # 仅调整垂直位置
        return adjusted_energies

    def enable_interaction(self):
        """启用交互功能"""
        self._connect_editor_events()  # 使用混入类的方法
        print("交互功能已启用：支持拖拽标签和使用方向键微调位置")

    def render(self):
        """Finalize and render the diagram"""
        self.text_labels = []  # 清空旧标签
        # 绘制所有路径
        for path in self.energy_paths:
            tick_positions = self._plot_energy_segment(self.ax, path)
        
        # 计算坐标范围和标签位置
        all_energies = np.concatenate([p['energies'] for p in self.energy_paths])
        self.ax.set_ylim(all_energies.min()-self.config.dy_min, all_energies.max()+self.config.dy_max)
        
        # 设置X轴
        if self.energy_paths:
            base_coords = self.energy_paths[0]['coordinates']
            xticks = tick_positions
            self.ax.set_xticks(xticks)
            self.ax.set_xticklabels(base_coords, fontsize=self.config.font_size_xtick, fontweight='bold',rotation=self.config.xtick_rotation)
            
            # 添加能量标签
            energies_matrix = np.array([p['energies'] for p in self.energy_paths])
            adjusted_energies = self._adjust_label_positions(energies_matrix)
            adjusted_energies = self._apply_manual_adjustments(adjusted_energies)
            for col, tick in enumerate(xticks):
                for row in range(adjusted_energies.shape[0]):
                    # 获取手动调整的偏移量
                    dx = 0
                    dy = 0.015  # 默认垂直偏移
                    if self.config.manual_label_adjust:
                        adjust = self.config.manual_label_adjust.get((row, col), (0, 0))
                        dx, dy = adjust[0], adjust[1] + 0.015
                    
                    text_obj = self.ax.text(
                        tick + dx, 
                        adjusted_energies[row, col] + dy,
                        f"{energies_matrix[row, col]:{self.config.energy_label_format}}",
                        fontsize=self.config.font_size_text, 
                        ha='center', 
                        va='bottom',
                        picker=True,        # 保持 picker=True 以支持拖拽
                        gid=f"label_{row}_{col}",
                        zorder=5  # 确保标签在顶层
                    )
                    self.text_labels.append(text_obj)
        
        # 设置图例和样式
        self.ax.tick_params(axis='y', which='major', labelsize=self.config.font_size_ytick)
        self.ax.tick_params(axis='both', which='major', length=self.config.tick_length, width=self.config.tick_width)
        self.ax.legend(loc='best', prop={'size': self.config.font_size_legend, 'weight': 'bold'},frameon=self.config.frameon or False)
        self.ax.grid(True, axis='y', linestyle='--', alpha=0.6)
        self.ax.set_ylabel("Free Energy (eV)", fontsize=self.config.font_size_ylabel, labelpad=12, fontweight='bold')
        self.ax.set_xlabel("Reaction Coordinate", fontsize=self.config.font_size_xlabel, labelpad=12, fontweight='bold')
        for spine in self.ax.spines.values():
            spine.set_linewidth(self.config.spine_width or 2.0)
        
        if self.config.spine_visible is not True:
            self.ax.spines['top'].set_visible(False)
            self.ax.spines['bottom'].set_visible(False)
            self.ax.spines['right'].set_visible(False)
            # 设置x轴刻度标签为空
            self.ax.set_xticklabels([])
            self.ax.set_xticks([])
            self.ax.set_xlabel("")
    
        
        # 在渲染完成后启用交互
        # self.enable_interaction()
        return self.fig, self.ax
    
    def save(self, filename: str, dpi: int = 300, **kwargs):
        """Save the diagram to file"""
        self.fig.tight_layout()
        self.fig.savefig(filename, dpi=dpi, bbox_inches='tight', **kwargs)
        plt.close(self.fig)

if __name__ == "__main__":
    # 创建可交互图表
    diagram = EnergyDiagram(DiagramConfig(figure_size=(18, 12)))

    # 添加复杂路径
    complex_steps = ["A", "TS1", "B", "TS2", "C", "TS3", "D"]
    energies_data = [0.0, 1.3, 0.6, 1.7, 0.3, 1.1, -0.8]

    diagram.add_energy_path(complex_steps, energies_data, color="teal", label="Complex Path")

    # 进入交互模式
    plt.ion()
    fig, ax = diagram.render()
    plt.show()

    # 在GUI界面中：
    # 1. 点击选择要调整的标签
    # 2. 使用方向键微调位置（Shift加速）
    # 3. 按Enter确认位置
    # 4. 执行保存
    input("Adjust labels and press Enter to save...")
    diagram.save("interactive_diagram.png")
    plt.ioff() 