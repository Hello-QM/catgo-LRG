#! /usr/bin/env python

import os
import subprocess
import dataclasses
import sys
from ase.io import read, write
from ase.db import connect
import pandas as pd
import numpy as np
from energydiagram import EnergyDiagram, DiagramConfig
import matplotlib
matplotlib.use('TkAgg')
import matplotlib.pyplot as plt

@dataclasses.dataclass
class GasPhaseEnergy:
    E_H2: float = -6.77
    E_C2H2: float = -22.98
    E_C2H4: float = -32.04
    G_H2: float = -6.89
    G_C2H2: float = -22.90
    G_C2H4: float = -31.38

gas_energy = GasPhaseEnergy()

# Specify the parent directories to search
parent_dirs = ["slab", "C2H2_H2","C2H2_2H", "C2H3_H", "C2H4","C2H4_H2","C2H4_2H","C2H5_H","C2H6"]

# Output ASE database name
db_name = "structures.db"

def find_scf_directories(base_dir):
    """
    Search for scf directories, prioritizing **/TS/**/scf > **/IDM/**/scf > regular **/scf.
    """
    ts_scf_dirs = []
    idm_scf_dirs = []
    regular_scf_dirs = []
    
    for root, dirs, files in os.walk(base_dir):
        if os.path.basename(root) == "scf":
            # Check if scf is in TS or IDM subdirectories
            if "TS" in root.split(os.sep):
                ts_scf_dirs.append(root)
            elif "IDM" in root.split(os.sep):
                idm_scf_dirs.append(root)
            else:
                regular_scf_dirs.append(root)

    # Return directories in priority order
    return ts_scf_dirs + idm_scf_dirs + regular_scf_dirs

def get_energy_from_scf(scf_dirs):
    # read the scf/vasprun.xml
    energy_dict = {}
    original_dir = os.getcwd()
    for scf_dir in scf_dirs:
        vasprun_path = os.path.join(scf_dir, "vasprun.xml")
        if os.path.isfile(vasprun_path):
            os.chdir(scf_dir)
            proc = subprocess.Popen(["ge"],
                             stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE,
                             text=True)
            inputs = "1\n"
            stdout, stderr = proc.communicate(inputs)
            if proc.returncode != 0:
                print(f"ge执行失败于 {scf_dir}: {stderr}")
                continue
            # 解析输出获取能量
            # 获取最后一行
            energy_str = stdout.split('\n')[-2]
            # 提取能量值
            energy = float(energy_str)
            energy_dict[scf_dir] = energy
            #vasprun = read(vasprun_path)
            #energy = vasprun.get_potential_energy()
            #energy_dict[os.path.basename(scf_dir)] = energy
            os.chdir(original_dir)
        else:
            print(f"vasprun.xml not found in {scf_dir}")
    energy_list = list(energy_dict.values())
    #print(energy_list,len(energy_list))
    return energy_dict, energy_list

def get_gibbs_energy_from_freq(freq_dirs):
    # go the freq dir and use vaspkit to get the gibbs energy
    gibbs_corr_dict = {}
    for freq_dir in freq_dirs:
        if not os.path.isdir(freq_dir):
            print(f"Frequency directory not found: {freq_dir}")
            continue
            
        try:
            # 保存当前工作目录
            original_dir = os.getcwd()
            os.chdir(freq_dir)
            
            # 使用subprocess与vaspkit交互
            proc = subprocess.Popen(['vaspkit'], 
                                  stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE,
                                  text=True)
            
            # 发送输入参数：501 + 温度353.2 K
            inputs = "501\n353.2\n"
            stdout, stderr = proc.communicate(inputs)
            
            if proc.returncode != 0:
                print(f"vaspkit执行失败于 {freq_dir}: {stderr}")
                continue
                
            # 解析输出获取G(T)
            gibbs_line = None
            for line in stdout.split('\n'):
                if "G(T)" in line:
                    gibbs_line = line
                    
            if gibbs_line:
                # 取最后一个匹配行，分割后取倒数第二列
                gibbs_value = float(gibbs_line.strip().split()[-2])
               
                gibbs_corr_dict[freq_dir] = gibbs_value
                #print(f"Gibbs自由能 @353.2K ({freq_dir}): {gibbs_value:.4f} eV")
            else:
                print(f"未找到G(T)值于 {freq_dir}")
            
        except Exception as e:
            print(f"处理 {freq_dir} 时发生错误: {str(e)}")
        finally:
            # 恢复原始工作目录
            os.chdir(original_dir)
    gibbs_list = list(gibbs_corr_dict.values())
    return gibbs_corr_dict, gibbs_list

def save_energy_info(
    energy_list: list, 
    gibbs_list: list, 
    energy_profile_list: list, 
    gibbs_profile_list: list, 
    reactioncoordinate: list
    ):
    # save the energy info to a excel file
    # create a dataframe
    # Use the reactioncoordinate as the index
    df = pd.DataFrame(
        {"Energy": energy_list, "Gibbs": gibbs_list, 
         "Energy_profile": energy_profile_list, "Gibbs_profile": gibbs_profile_list}, 
        index=reactioncoordinate
        )
    # save the dataframe to a excel file
    df.to_excel("energy_info.xlsx", index=True)
    


def plot_energy_profile(energy_profile_list, gibbs_profile_list, reactioncoordinate):
    # plot the energy profile
    # create a energy diagram
    diagram = EnergyDiagram(DiagramConfig(
        figure_size=(28, 12),
        energy_label_format=".2f",
        vertical_spacing=0.1,
        font_size_xtick=14,
        font_size_ytick=24,
        font_size_xlabel=28,
        font_size_ylabel=28,
        font_size_legend=24,
        base_spacing=2,
        hline_ratio=0.4,
        ts_spacing_ratio=0.4,
        vline_ratio=0.4
    ))
    diagram.add_energy_path(reactioncoordinate, gibbs_profile_list, color="navy", label="Pd3")
    
    
    # add the horizontal line for the C2H4
    #energy_C2H4 = energy_profile_list[0] + gas_energy.E_C2H4 - gas_energy.E_H2 - gas_energy.E_C2H2
    gibbs_C2H4 = gas_energy.G_C2H4 - gas_energy.G_H2 - gas_energy.G_C2H2
    #plt.axhline(energy_C2H4, color="red", label="C2H4")
    
    plt.axhline(gibbs_C2H4, color="black",linestyle="--",alpha=0.5,linewidth=2)
    plt.text(0.5, gibbs_C2H4+0.1, 
             f"$C_2H_4(g)$: {gibbs_C2H4:.2f} eV", 
             ha="center", va="bottom", fontsize=28, 
             color="black", picker=True,
             gid="C2H4_gas")
    
    plt.ion()
    fig, ax = diagram.render()
    plt.show()
    
    input("Press Enter to continue...")
    diagram.save("energy_profile.png", dpi=300)
    
    plt.ioff()


def handle_energy(
    energy_list: list, 
    gibbs_list: list, 
    reactioncoordinate: list
    ) -> tuple[list, list, list, list]: 
    # calculate the energy and gibbs energy of gas phase
    Energy_dict = {}
    Gibbs_dict = {}
    TS_G1 = ["TS1", "TS2", "TS3"]
    TS_G2 = ["TS4", "TS5", "TS6"]
    
    for i, key in enumerate(reactioncoordinate):
        if key == "slab":
            Energy_dict[key] = energy_list[i] + 2*gas_energy.E_H2 + gas_energy.E_C2H2
            Gibbs_dict[key] = energy_list[i] + 2*gas_energy.G_H2 + gas_energy.G_C2H2
        elif key == "C2H2_H2" or key == "C2H2_2H" or key == "C2H3_H" or key == "C2H4" or key in TS_G1:
            Energy_dict[key] = energy_list[i] + gas_energy.E_H2
            Gibbs_dict[key] = energy_list[i] + gibbs_list[i-1] + gas_energy.G_H2
        elif key == "C2H4_H2" or key == "C2H4_2H" or key == "C2H5_H" or key == "C2H6" or key in TS_G2:
            Energy_dict[key] = energy_list[i]
            Gibbs_dict[key] = energy_list[i] + gibbs_list[i-1]
        else:
            print(f"Unknown key: {key}")
    
    # Handle the energy and gibbs energy for energy_profile_plot
    # Transform the Energy_dict and Gibbs_dict to list
    energy_list = list(Energy_dict.values())
    gibbs_list = list(Gibbs_dict.values())
    
    energy_profile_plot = [e-energy_list[0] for e in energy_list]
    gibbs_profile_plot = [g-gibbs_list[0] for g in gibbs_list]
    
    return energy_list, gibbs_list, energy_profile_plot, gibbs_profile_plot
            


def save_all_to_current_directory(scf_dirs, db_name):
    """
    Save POSCAR files to the ASE database, and also save as .traj and .xyz files in the current directory.
    """
    base_dir = os.getcwd()  # Current working directory
    xyz_name = "structures.xyz"
    traj_name = "structures.traj"

    with connect(db_name) as db:
        with open(xyz_name, "w") as xyz_file:  # Open structures.xyz for appending
            for scf_dir in scf_dirs:
                poscar_path = os.path.join(scf_dir, "POSCAR")
                
                if os.path.isfile(poscar_path):
                    try:
                        # Read the POSCAR file
                        structure = read(poscar_path, format="vasp")

                        # Save to the ASE database
                        db.write(structure, data={"path": scf_dir})

                        # Append to the .xyz file
                        write(xyz_file, structure, format="xyz")

                        # Append to the .traj file
                        traj_path = os.path.join(base_dir, traj_name)
                        write(traj_path, structure, append=True)

                        print(f"Saved {poscar_path} to database, .traj, and .xyz.")
                    except Exception as e:
                        print(f"Failed to process {poscar_path}: {e}")

def main():
    # check whether the energy_info.xlsx exists
    save_structures = input("Do you want to save/update the structures to the database? (y/n)")
    if save_structures == "y":
        all_scf_dirs = []
        for parent_dir in parent_dirs:
            if os.path.isdir(parent_dir):
                scf_dirs = find_scf_directories(parent_dir)
                # substitute the scf dirs with freq dirs
                # e.g. **/**/scf -> **/**/freq
                freq_dirs = [os.path.join(os.path.dirname(scf_dir), "freq") for scf_dir in scf_dirs]
                all_scf_dirs.extend(scf_dirs)
            else:
                print(f"Directory not found: {parent_dir}")
        save_all_to_current_directory(all_scf_dirs, db_name)
    else:
        print("Skip the saving structures to the database")
        
    if os.path.isfile("energy_info.xlsx"):
        print("energy_info.xlsx exists, skip the calculation")
        reactioncoordinate = [
            "slab", "$C_2H_2 + H_2$","TS1",
            "$C_2H_2 + 2H$", "TS2", "$C_2H_3 + H$", 
            "TS3", "$C_2H_4$", "$C_2H_4 + H_2$","TS4", 
            "$C_2H_4 + 2H$","TS5", "$C_2H_5 + H$","TS6", 
            "$C_2H_6$",
        ]
        # update the reactioncoordinate information in the energy_info.xlsx
        df = pd.read_excel("energy_info.xlsx", index_col=0)
        df.index = reactioncoordinate
        df.to_excel("energy_info.xlsx", index=True)
        reactioncoordinate = df.index.to_list()
        energy_list = pd.read_excel("energy_info.xlsx", index_col=0)["Energy_profile"].to_list()
        gibbs_list = pd.read_excel("energy_info.xlsx", index_col=0)["Gibbs_profile"].to_list()
        plot_energy_profile(energy_list, gibbs_list, reactioncoordinate)
        
    else:
        all_scf_dirs = []
        all_freq_dirs = []
        for parent_dir in parent_dirs:
            if os.path.isdir(parent_dir):
                scf_dirs = find_scf_directories(parent_dir)
                # substitute the scf dirs with freq dirs
                # e.g. **/**/scf -> **/**/freq
                freq_dirs = [os.path.join(os.path.dirname(scf_dir), "freq") for scf_dir in scf_dirs]
                all_scf_dirs.extend(scf_dirs)
                all_freq_dirs.extend(freq_dirs)
            else:
                print(f"Directory not found: {parent_dir}")
        
        # check the freq dirs
        freq_dirs = []
        for freq_dir in all_freq_dirs:
            if os.path.isdir(freq_dir):
                freq_dirs.append(freq_dir)
            else:
                continue
        
        energy_dict, energy_list = get_energy_from_scf(all_scf_dirs)
        gibbs_corr_dict, gibbs_list = get_gibbs_energy_from_freq(freq_dirs)
        
        reactioncoordinate = [
            "slab", "C2H2_H2","TS1",
            "C2H2_2H", "TS2", "C2H3_H", 
            "TS3", "C2H4", "C2H4_H2","TS4", 
            "C2H4_2H","TS5", "C2H5_H","TS6", 
            "C2H6"
        ]
        
        energy_list, gibbs_list, energy_profile_plot, gibbs_profile_plot = handle_energy(energy_list, gibbs_list, reactioncoordinate)
        
        save_energy_info(energy_list, gibbs_list, energy_profile_plot, gibbs_profile_plot, reactioncoordinate)
        plot_energy_profile(energy_profile_plot, gibbs_profile_plot, reactioncoordinate)
    
    
    

if __name__ == "__main__":
    main()