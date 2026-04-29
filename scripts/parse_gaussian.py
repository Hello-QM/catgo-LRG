#!/usr/bin/env python3
"""
Parse Gaussian optimization .out file:
  1. Export final geometry as .xyz
  2. Plot energy vs optimization step
  3. Plot Max/RMS force vs optimization step
Usage: python parse_gaussian.py <gaussian.out>
"""

import sys
import re
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# --- atomic number to element symbol ---
ATOMIC_SYMBOL = {
    1:'H',2:'He',3:'Li',4:'Be',5:'B',6:'C',7:'N',8:'O',9:'F',10:'Ne',
    11:'Na',12:'Mg',13:'Al',14:'Si',15:'P',16:'S',17:'Cl',18:'Ar',
    19:'K',20:'Ca',21:'Sc',22:'Ti',23:'V',24:'Cr',25:'Mn',26:'Fe',
    27:'Co',28:'Ni',29:'Cu',30:'Zn',31:'Ga',32:'Ge',33:'As',34:'Se',
    35:'Br',36:'Kr',37:'Rb',38:'Sr',39:'Y',40:'Zr',41:'Nb',42:'Mo',
    43:'Tc',44:'Ru',45:'Rh',46:'Pd',47:'Ag',48:'Cd',49:'In',50:'Sn',
    51:'Sb',52:'Te',53:'I',54:'Xe',55:'Cs',56:'Ba',57:'La',72:'Hf',
    73:'Ta',74:'W',75:'Re',76:'Os',77:'Ir',78:'Pt',79:'Au',80:'Hg',
    81:'Tl',82:'Pb',83:'Bi',
}


def parse_gaussian(filename):
    with open(filename) as f:
        lines = f.readlines()

    energies = []
    max_forces = []
    rms_forces = []
    force_thresholds = (None, None)
    geometries = []  # list of list-of-(symbol, x, y, z)

    i = 0
    while i < len(lines):
        line = lines[i]

        # --- SCF energy ---
        if "SCF Done" in line:
            m = re.search(r"=\s+(-?\d+\.\d+)", line)
            if m:
                energies.append(float(m.group(1)))

        # --- convergence criteria ---
        if "Maximum Force" in line and "Threshold" not in line:
            m = re.search(r"Maximum Force\s+([\d.]+)\s+([\d.]+)", line)
            if m:
                max_forces.append(float(m.group(1)))
                force_thresholds = (force_thresholds[0], float(m.group(2))) if force_thresholds[1] is None else force_thresholds
                force_thresholds = (force_thresholds[0], float(m.group(2)))
        if "RMS     Force" in line and "Threshold" not in line:
            m = re.search(r"RMS     Force\s+([\d.]+)\s+([\d.]+)", line)
            if m:
                rms_forces.append(float(m.group(1)))
                if force_thresholds[0] is None:
                    force_thresholds = (float(m.group(2)), force_thresholds[1])

        # --- geometry (prefer Standard orientation, fallback to Input orientation) ---
        if "Standard orientation:" in line or "Input orientation:" in line:
            # skip header lines (dashes, columns, dashes)
            j = i + 5  # first atom line
            atoms = []
            while j < len(lines) and "-----" not in lines[j]:
                parts = lines[j].split()
                if len(parts) >= 6:
                    anum = int(parts[1])
                    x, y, z = float(parts[3]), float(parts[4]), float(parts[5])
                    sym = ATOMIC_SYMBOL.get(anum, f"X{anum}")
                    atoms.append((sym, x, y, z))
                j += 1
            if atoms:
                geometries.append(atoms)

        i += 1

    return energies, max_forces, rms_forces, force_thresholds, geometries


def write_xyz(atoms, filename, comment=""):
    with open(filename, "w") as f:
        f.write(f"{len(atoms)}\n")
        f.write(f"{comment}\n")
        for sym, x, y, z in atoms:
            f.write(f"{sym:2s}  {x:16.8f}  {y:16.8f}  {z:16.8f}\n")


def plot_energy(energies, outfile):
    if len(energies) < 2:
        print(f"Only {len(energies)} energy point(s), skipping energy plot.")
        return
    steps = list(range(1, len(energies) + 1))
    e_rel = [(e - energies[-1]) * 27.2114  for e in energies]  # relative to last, in eV

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(8, 8), sharex=True)

    ax1.plot(steps, energies, "o-", color="tab:blue", markersize=3)
    ax1.set_ylabel("Energy (Hartree)")
    ax1.set_title("SCF Energy vs Optimization Step")
    ax1.grid(True, alpha=0.3)

    ax2.plot(steps, e_rel, "s-", color="tab:red", markersize=3)
    ax2.set_xlabel("Optimization Step")
    ax2.set_ylabel("Relative Energy (eV)")
    ax2.axhline(0, color="gray", ls="--", lw=0.8)
    ax2.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig(outfile, dpi=150)
    plt.close()
    print(f"Energy plot saved: {outfile}")


def plot_forces(max_forces, rms_forces, thresholds, outfile):
    if len(max_forces) < 2:
        print(f"Only {len(max_forces)} force point(s), skipping force plot.")
        return
    steps = list(range(1, len(max_forces) + 1))
    rms_thresh, max_thresh = thresholds

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.semilogy(steps, max_forces, "o-", color="tab:red", markersize=3, label="Max Force")
    ax.semilogy(steps, rms_forces, "s-", color="tab:blue", markersize=3, label="RMS Force")

    if max_thresh:
        ax.axhline(max_thresh, color="tab:red", ls="--", lw=0.8, alpha=0.7, label=f"Max Threshold ({max_thresh})")
    if rms_thresh:
        ax.axhline(rms_thresh, color="tab:blue", ls="--", lw=0.8, alpha=0.7, label=f"RMS Threshold ({rms_thresh})")

    ax.set_xlabel("Optimization Step")
    ax.set_ylabel("Force (Hartree/Bohr)")
    ax.set_title("Force Convergence vs Optimization Step")
    ax.legend()
    ax.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(outfile, dpi=150)
    plt.close()
    print(f"Force plot saved: {outfile}")


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <gaussian.out>")
        sys.exit(1)

    fname = sys.argv[1]
    print(f"Parsing: {fname}")
    energies, max_forces, rms_forces, thresholds, geometries = parse_gaussian(fname)

    print(f"  SCF steps:  {len(energies)}")
    print(f"  Force data: {len(max_forces)} points")
    print(f"  Geometries: {len(geometries)} frames")

    # export last geometry as xyz
    if geometries:
        xyz_file = fname.rsplit(".", 1)[0] + "_final.xyz"
        comment = f"E = {energies[-1]:.8f} Hartree" if energies else ""
        write_xyz(geometries[-1], xyz_file, comment)
        print(f"XYZ saved: {xyz_file}")

    # export all geometries as trajectory xyz
    if len(geometries) > 1:
        traj_file = fname.rsplit(".", 1)[0] + "_traj.xyz"
        with open(traj_file, "w") as f:
            for idx, atoms in enumerate(geometries):
                e_str = f"E = {energies[idx]:.8f} Hartree" if idx < len(energies) else ""
                f.write(f"{len(atoms)}\n")
                f.write(f"Step {idx+1}  {e_str}\n")
                for sym, x, y, z in atoms:
                    f.write(f"{sym:2s}  {x:16.8f}  {y:16.8f}  {z:16.8f}\n")
        print(f"Trajectory XYZ saved: {traj_file}")

    # plots
    prefix = fname.rsplit(".", 1)[0]
    plot_energy(energies, prefix + "_energy.png")
    plot_forces(max_forces, rms_forces, thresholds, prefix + "_forces.png")


if __name__ == "__main__":
    main()
