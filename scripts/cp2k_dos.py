#!/usr/bin/env python3
"""CP2K PDOS post-processing script.

Parses CP2K .pdos output files, applies Gaussian broadening, aligns to Fermi
level, and generates total/projected DOS plots.

Usage:
    # Plot total DOS from all .pdos files in current directory
    python cp2k_dos.py

    # Specify files and Fermi level
    python cp2k_dos.py -f *ALPHA*.pdos -f *BETA*.pdos --fermi -0.18

    # Export broadened data to CSV
    python cp2k_dos.py --export dos_out.csv

    # PDOS by orbital type
    python cp2k_dos.py --orbital-pdos

    # Custom energy range and broadening
    python cp2k_dos.py --emin -10 --emax 5 --sigma 0.1

CP2K .pdos file format:
    Line 1: # Projected DOS for atomic kind <KIND> at iteration step i = <N>,
            E(Fermi) = <EF> a.u.
    Line 2: # MO Eigenvalue [a.u.] Occupation s py pz px ...
    Data:   <MO> <eigenvalue> <occupation> <orbital contributions...>
"""

import argparse
import glob
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

# Constants
HA_TO_EV = 27.211386245988  # 1 Hartree in eV


@dataclass
class PDOSData:
    """Parsed data from a single .pdos file."""

    filename: str
    kind: str  # atomic kind (e.g., "Si", "O")
    spin: str  # "ALPHA", "BETA", or ""
    fermi_au: float  # Fermi energy in a.u. from header
    eigenvalues_au: np.ndarray = field(repr=False)  # in a.u.
    occupations: np.ndarray = field(repr=False)
    orbitals: dict[str, np.ndarray] = field(repr=False)  # name -> contributions
    orbital_names: list[str] = field(default_factory=list)

    @property
    def eigenvalues_ev(self) -> np.ndarray:
        return self.eigenvalues_au * HA_TO_EV

    @property
    def fermi_ev(self) -> float:
        return self.fermi_au * HA_TO_EV

    @property
    def total_dos_weights(self) -> np.ndarray:
        """Sum of all orbital contributions per eigenvalue."""
        return sum(self.orbitals.values())


def parse_pdos_file(filepath: str) -> PDOSData:
    """Parse a CP2K .pdos file."""
    path = Path(filepath)
    lines = path.read_text().splitlines()

    # Parse header line 1: extract kind, Fermi energy
    header = lines[0]
    kind_match = re.search(r"atomic kind\s+(\w+)", header)
    kind = kind_match.group(1) if kind_match else "unknown"

    fermi_match = re.search(r"E\(Fermi\)\s*=\s*([-\d.Ee+]+)\s*a\.u\.", header)
    fermi_au = float(fermi_match.group(1)) if fermi_match else 0.0

    # Detect spin channel from filename
    spin = ""
    fname = path.name.upper()
    if "ALPHA" in fname:
        spin = "ALPHA"
    elif "BETA" in fname:
        spin = "BETA"

    # Parse column headers (line 2)
    col_header = lines[1].lstrip("#").split()
    # Typical: MO, Eigenvalue, [a.u.], Occupation, s, py, pz, px, ...
    # Find where orbital columns start (after "Occupation")
    orbital_start_idx = None
    for i, name in enumerate(col_header):
        if name.lower() == "occupation":
            orbital_start_idx = i + 1
            break
    if orbital_start_idx is None:
        # Fallback: assume columns are MO, Eigenvalue, [a.u.], Occupation, orbitals...
        orbital_start_idx = 4

    orbital_names = col_header[orbital_start_idx:]
    # Data column indices: col 0 = MO, col 1 = eigenvalue, col 2 = occupation,
    # col 3+ = orbitals (after removing unit label "[a.u.]")
    # But actual data lines don't have the [a.u.] token, so need to handle offset

    # Parse data
    data_lines = [l for l in lines[2:] if l.strip() and not l.strip().startswith("#")]
    if not data_lines:
        raise ValueError(f"No data found in {filepath}")

    data = np.loadtxt(data_lines)
    # data columns: MO_index, eigenvalue_au, occupation, orbital1, orbital2, ...
    eigenvalues_au = data[:, 1]
    occupations = data[:, 2]

    orbitals = {}
    for i, name in enumerate(orbital_names):
        col_idx = 3 + i
        if col_idx < data.shape[1]:
            orbitals[name] = data[:, col_idx]

    return PDOSData(
        filename=str(path),
        kind=kind,
        spin=spin,
        fermi_au=fermi_au,
        eigenvalues_au=eigenvalues_au,
        occupations=occupations,
        orbitals=orbitals,
        orbital_names=orbital_names,
    )


def gaussian_broaden(
    eigenvalues: np.ndarray,
    weights: np.ndarray,
    energy_grid: np.ndarray,
    sigma: float,
) -> np.ndarray:
    """Apply Gaussian broadening to discrete eigenvalues.

    Args:
        eigenvalues: discrete energy levels (eV)
        weights: weight of each eigenvalue (orbital contribution or 1.0 for TDOS)
        energy_grid: uniform energy grid (eV)
        sigma: Gaussian width (eV)

    Returns:
        Broadened DOS on energy_grid
    """
    dos = np.zeros_like(energy_grid)
    prefactor = 1.0 / (sigma * np.sqrt(2.0 * np.pi))
    for e, w in zip(eigenvalues, weights):
        dos += w * prefactor * np.exp(-0.5 * ((energy_grid - e) / sigma) ** 2)
    return dos


def collect_pdos_files(patterns: list[str] | None) -> list[str]:
    """Find .pdos files matching patterns, or all in current dir."""
    if patterns:
        files = []
        for pat in patterns:
            files.extend(glob.glob(pat))
        return sorted(set(files))
    # Default: all .pdos files in current directory
    return sorted(glob.glob("*.pdos"))


def aggregate_orbital_type(name: str) -> str:
    """Map orbital name to angular momentum type (s, p, d, f)."""
    name = name.lower()
    if name == "s":
        return "s"
    if name in ("px", "py", "pz", "p"):
        return "p"
    if name in ("dxy", "dyz", "dz2", "dxz", "dx2", "dx2-y2", "d", "d-2", "d-1", "d0", "d+1", "d+2"):
        return "d"
    if name.startswith("f") or name in ("f-3", "f-2", "f-1", "f0", "f+1", "f+2", "f+3"):
        return "f"
    return name


def main():
    parser = argparse.ArgumentParser(
        description="CP2K PDOS post-processing: broadening, alignment, and plotting."
    )
    parser.add_argument(
        "-f", "--files", action="append", default=None,
        help="Glob pattern for .pdos files (repeatable). Default: *.pdos",
    )
    parser.add_argument(
        "--fermi", type=float, default=None,
        help="Override Fermi energy (eV). Default: read from .pdos header.",
    )
    parser.add_argument(
        "--sigma", type=float, default=0.05,
        help="Gaussian broadening width in eV (default: 0.05)",
    )
    parser.add_argument(
        "--emin", type=float, default=None,
        help="Minimum energy relative to Fermi (eV). Default: auto.",
    )
    parser.add_argument(
        "--emax", type=float, default=None,
        help="Maximum energy relative to Fermi (eV). Default: auto.",
    )
    parser.add_argument(
        "--npoints", type=int, default=3000,
        help="Number of energy grid points (default: 3000)",
    )
    parser.add_argument(
        "--orbital-pdos", action="store_true",
        help="Plot PDOS decomposed by orbital type (s, p, d, f)",
    )
    parser.add_argument(
        "--atom-pdos", action="store_true",
        help="Plot PDOS decomposed by atomic kind",
    )
    parser.add_argument(
        "--export", type=str, default=None,
        help="Export broadened DOS to CSV file",
    )
    parser.add_argument(
        "--no-plot", action="store_true",
        help="Skip plotting (useful with --export)",
    )
    parser.add_argument(
        "--spin-polarized", action="store_true",
        help="Plot spin-up (positive) and spin-down (negative) separately",
    )

    args = parser.parse_args()

    # Collect and parse files
    files = collect_pdos_files(args.files)
    if not files:
        print("Error: no .pdos files found.", file=sys.stderr)
        print("Use -f to specify file patterns, or run in a directory with .pdos files.", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(files)} .pdos file(s):")
    pdos_list: list[PDOSData] = []
    for f in files:
        try:
            pdos = parse_pdos_file(f)
            pdos_list.append(pdos)
            n_orb = len(pdos.orbital_names)
            print(f"  {Path(f).name}: kind={pdos.kind}, spin={pdos.spin or 'none'}, "
                  f"states={len(pdos.eigenvalues_au)}, orbitals={n_orb} ({', '.join(pdos.orbital_names[:5])}{'...' if n_orb > 5 else ''})")
        except Exception as e:
            print(f"  Warning: failed to parse {f}: {e}", file=sys.stderr)

    if not pdos_list:
        print("Error: no files parsed successfully.", file=sys.stderr)
        sys.exit(1)

    # Determine Fermi energy
    if args.fermi is not None:
        fermi_ev = args.fermi
        print(f"\nFermi energy (user override): {fermi_ev:.4f} eV")
    else:
        # Use Fermi from first file (they should all be the same)
        fermi_ev = pdos_list[0].fermi_ev
        print(f"\nFermi energy (from header): {fermi_ev:.4f} eV ({pdos_list[0].fermi_au:.6f} a.u.)")

    # Determine energy range
    all_eigs = np.concatenate([p.eigenvalues_ev - fermi_ev for p in pdos_list])
    emin = args.emin if args.emin is not None else max(all_eigs.min() - 1.0, -30.0)
    emax = args.emax if args.emax is not None else min(all_eigs.max() + 1.0, 30.0)
    energy_grid = np.linspace(emin, emax, args.npoints)
    print(f"Energy range: [{emin:.2f}, {emax:.2f}] eV (relative to E_F), {args.npoints} points")
    print(f"Gaussian broadening: sigma = {args.sigma} eV")

    # --- Compute broadened DOS ---

    # Total DOS (sum of all kinds)
    tdos = np.zeros_like(energy_grid)
    tdos_alpha = np.zeros_like(energy_grid)
    tdos_beta = np.zeros_like(energy_grid)

    # Per-kind DOS
    kind_dos: dict[str, np.ndarray] = {}
    kind_dos_alpha: dict[str, np.ndarray] = {}
    kind_dos_beta: dict[str, np.ndarray] = {}

    # Per-orbital-type DOS
    orbital_dos: dict[str, np.ndarray] = {}
    orbital_dos_alpha: dict[str, np.ndarray] = {}
    orbital_dos_beta: dict[str, np.ndarray] = {}

    for pdos in pdos_list:
        eigs = pdos.eigenvalues_ev - fermi_ev

        # Total contribution from this file
        total_w = pdos.total_dos_weights
        broadened = gaussian_broaden(eigs, total_w, energy_grid, args.sigma)

        tdos += broadened
        if pdos.spin == "ALPHA":
            tdos_alpha += broadened
        elif pdos.spin == "BETA":
            tdos_beta += broadened

        # Per kind
        k = pdos.kind
        kind_dos[k] = kind_dos.get(k, np.zeros_like(energy_grid)) + broadened
        if pdos.spin == "ALPHA":
            kind_dos_alpha[k] = kind_dos_alpha.get(k, np.zeros_like(energy_grid)) + broadened
        elif pdos.spin == "BETA":
            kind_dos_beta[k] = kind_dos_beta.get(k, np.zeros_like(energy_grid)) + broadened

        # Per orbital type
        for orb_name, orb_weights in pdos.orbitals.items():
            orb_type = aggregate_orbital_type(orb_name)
            b = gaussian_broaden(eigs, orb_weights, energy_grid, args.sigma)
            orbital_dos[orb_type] = orbital_dos.get(orb_type, np.zeros_like(energy_grid)) + b
            if pdos.spin == "ALPHA":
                orbital_dos_alpha[orb_type] = orbital_dos_alpha.get(orb_type, np.zeros_like(energy_grid)) + b
            elif pdos.spin == "BETA":
                orbital_dos_beta[orb_type] = orbital_dos_beta.get(orb_type, np.zeros_like(energy_grid)) + b

    has_spin = bool(tdos_alpha.any() and tdos_beta.any())
    if has_spin:
        print("Spin-polarized calculation detected (ALPHA + BETA channels)")

    # --- Export ---
    if args.export:
        export_path = Path(args.export)
        columns = {"Energy_eV": energy_grid, "TDOS": tdos}
        if has_spin:
            columns["TDOS_alpha"] = tdos_alpha
            columns["TDOS_beta"] = tdos_beta
        if args.atom_pdos:
            for k, dos in sorted(kind_dos.items()):
                columns[f"PDOS_{k}"] = dos
        if args.orbital_pdos:
            for orb, dos in sorted(orbital_dos.items()):
                columns[f"PDOS_{orb}"] = dos

        header_parts = [f"{name}" for name in columns]
        data_out = np.column_stack(list(columns.values()))
        np.savetxt(
            export_path, data_out,
            header=" ".join(header_parts),
            fmt="%.8e",
            delimiter=",",
            comments="# ",
        )
        print(f"\nExported to {export_path} ({len(columns)} columns)")

    # --- Plot ---
    if args.no_plot:
        return

    orbital_colors = {
        "s": "#e41a1c",
        "p": "#377eb8",
        "d": "#4daf4a",
        "f": "#984ea3",
    }
    # Generate distinct colors for atom kinds
    kind_cmap = plt.cm.Set1
    kind_list = sorted(kind_dos.keys())
    kind_colors = {k: kind_cmap(i / max(len(kind_list), 1)) for i, k in enumerate(kind_list)}

    n_panels = 1 + int(args.atom_pdos) + int(args.orbital_pdos)
    fig, axes = plt.subplots(n_panels, 1, figsize=(8, 3.5 * n_panels), sharex=True, squeeze=False)
    axes = axes.flatten()
    panel_idx = 0

    # Panel 1: Total DOS
    ax = axes[panel_idx]
    if has_spin and args.spin_polarized:
        ax.fill_between(energy_grid, tdos_alpha, alpha=0.3, color="#377eb8", label="Spin up")
        ax.plot(energy_grid, tdos_alpha, color="#377eb8", lw=0.8)
        ax.fill_between(energy_grid, -tdos_beta, alpha=0.3, color="#e41a1c", label="Spin down")
        ax.plot(energy_grid, -tdos_beta, color="#e41a1c", lw=0.8)
        ax.axhline(0, color="gray", lw=0.5)
    else:
        ax.fill_between(energy_grid, tdos, alpha=0.3, color="#377eb8")
        ax.plot(energy_grid, tdos, color="#377eb8", lw=1.0, label="Total DOS")
    ax.axvline(0, color="k", ls="--", lw=0.8, label="$E_F$")
    ax.set_ylabel("DOS (states/eV)")
    ax.set_title("Total Density of States")
    ax.legend(frameon=False)
    panel_idx += 1

    # Panel 2: Atom-projected DOS
    if args.atom_pdos:
        ax = axes[panel_idx]
        for k in kind_list:
            color = kind_colors[k]
            if has_spin and args.spin_polarized:
                ax.plot(energy_grid, kind_dos_alpha.get(k, 0), color=color, lw=1.0, label=f"{k} (up)")
                ax.plot(energy_grid, -kind_dos_beta.get(k, 0), color=color, lw=1.0, ls="--", label=f"{k} (down)")
            else:
                ax.fill_between(energy_grid, kind_dos[k], alpha=0.2, color=color)
                ax.plot(energy_grid, kind_dos[k], color=color, lw=1.0, label=k)
        if has_spin and args.spin_polarized:
            ax.axhline(0, color="gray", lw=0.5)
        ax.axvline(0, color="k", ls="--", lw=0.8)
        ax.set_ylabel("PDOS (states/eV)")
        ax.set_title("Atom-Projected DOS")
        ax.legend(frameon=False, ncol=min(len(kind_list), 4))
        panel_idx += 1

    # Panel 3: Orbital-projected DOS
    if args.orbital_pdos:
        ax = axes[panel_idx]
        for orb in ["s", "p", "d", "f"]:
            if orb not in orbital_dos:
                continue
            color = orbital_colors.get(orb, "gray")
            if has_spin and args.spin_polarized:
                ax.plot(energy_grid, orbital_dos_alpha.get(orb, 0), color=color, lw=1.0, label=f"{orb} (up)")
                ax.plot(energy_grid, -orbital_dos_beta.get(orb, 0), color=color, lw=1.0, ls="--", label=f"{orb} (down)")
            else:
                ax.fill_between(energy_grid, orbital_dos[orb], alpha=0.2, color=color)
                ax.plot(energy_grid, orbital_dos[orb], color=color, lw=1.0, label=orb)
        if has_spin and args.spin_polarized:
            ax.axhline(0, color="gray", lw=0.5)
        ax.axvline(0, color="k", ls="--", lw=0.8)
        ax.set_ylabel("PDOS (states/eV)")
        ax.set_title("Orbital-Projected DOS")
        ax.legend(frameon=False)
        panel_idx += 1

    axes[-1].set_xlabel("$E - E_F$ (eV)")
    axes[-1].set_xlim(emin, emax)
    fig.tight_layout()
    plt.savefig("dos_plot.png", dpi=200, bbox_inches="tight")
    print(f"\nPlot saved to dos_plot.png")
    plt.show()


if __name__ == "__main__":
    main()
