"""Generate realistic CP2K .pdos test fixture files.

Creates test files for a TiO2 (rutile) system:
- TiO2-Ti-k1-1.pdos          (Ti, non-spin-polarized)
- TiO2-O-k1-1.pdos           (O, non-spin-polarized)
- TiO2-Ti-ALPHA-k1-1.pdos    (Ti, spin-up)
- TiO2-Ti-BETA-k1-1.pdos     (Ti, spin-down)
- TiO2-O-ALPHA-k1-1.pdos     (O, spin-up)
- TiO2-O-BETA-k1-1.pdos      (O, spin-down)

Usage:
    python generate_fixtures.py
"""

import numpy as np
from pathlib import Path

HA_TO_EV = 27.211386245988
OUT_DIR = Path(__file__).parent

# --- Config ---
NBANDS = 60
FERMI_AU = -0.18543  # ~-5.04 eV (typical TiO2)

# Eigenvalue grid: from -1.5 Ha to +0.8 Ha, NBANDS points
EIGENVALUES_AU = np.linspace(-1.5, 0.8, NBANDS)


def _gaussian(x, center, sigma, amplitude):
    return amplitude * np.exp(-((x - center) ** 2) / (2 * sigma ** 2))


def _make_orbital_projections(eigenvalues_au, centers, sigmas, amps, n_orbitals):
    """Generate orbital-resolved projections as Gaussian peaks."""
    proj = np.zeros((len(eigenvalues_au), n_orbitals))
    for i in range(n_orbitals):
        for c, s, a in zip(centers[i][0], sigmas[i][0], amps[i][0]):
            proj[:, i] += _gaussian(eigenvalues_au, c, s, a)
    return proj


def _occupations(eigenvalues_au, fermi_au):
    """Step-function occupation (0K)."""
    return np.where(eigenvalues_au < fermi_au, 2.0, 0.0)


def write_pdos_file(filepath, kind, eigenvalues_au, orbital_names, projections,
                    fermi_au, spin_label=""):
    """Write a single .pdos file."""
    occs = _occupations(eigenvalues_au, fermi_au)
    iteration = 200

    with open(filepath, "w") as f:
        f.write(f"# Projected DOS for atomic kind {kind} at iteration step i = {iteration}, "
                f"E(Fermi) = {fermi_au:.5f} a.u.\n")
        header_cols = "# MO Eigenvalue [a.u.] Occupation " + " ".join(orbital_names)
        f.write(header_cols + "\n")

        for i in range(len(eigenvalues_au)):
            cols = [f"{i + 1:6d}", f"{eigenvalues_au[i]:16.8f}", f"{occs[i]:12.6f}"]
            for j in range(len(orbital_names)):
                cols.append(f"{projections[i, j]:12.8f}")
            f.write(" ".join(cols) + "\n")

    print(f"  wrote {filepath.name} ({len(eigenvalues_au)} bands, {len(orbital_names)} orbitals)")


def generate_non_spin_polarized():
    """Generate non-spin-polarized Ti + O .pdos files."""
    print("=== Non-spin-polarized TiO2 ===")

    # Ti: s, py, pz, px, dxy, dyz, dz2, dxz, dx2
    ti_orbitals = ["s", "py", "pz", "px", "dxy", "dyz", "dz2", "dxz", "dx2"]
    ti_centers = [
        [[-1.2, -0.6]], [[-0.8]], [[-0.8]], [[-0.8]],  # s, py, pz, px
        [[-0.4, 0.3]], [[-0.4, 0.3]], [[-0.5, 0.2]], [[-0.4, 0.3]], [[-0.5, 0.2]],  # d orbitals
    ]
    ti_sigmas = [
        [[0.15, 0.12]], [[0.12]], [[0.12]], [[0.12]],
        [[0.10, 0.08]], [[0.10, 0.08]], [[0.10, 0.08]], [[0.10, 0.08]], [[0.10, 0.08]],
    ]
    ti_amps = [
        [[0.05, 0.03]], [[0.02]], [[0.02]], [[0.02]],
        [[0.15, 0.10]], [[0.12, 0.08]], [[0.18, 0.12]], [[0.12, 0.08]], [[0.10, 0.06]],
    ]
    ti_proj = _make_orbital_projections(EIGENVALUES_AU, ti_centers, ti_sigmas, ti_amps, 9)
    write_pdos_file(OUT_DIR / "TiO2-Ti-k1-1.pdos", "Ti", EIGENVALUES_AU,
                    ti_orbitals, ti_proj, FERMI_AU)

    # O: s, py, pz, px
    o_orbitals = ["s", "py", "pz", "px"]
    o_centers = [
        [[-1.3, -0.7]],
        [[-0.9, -0.3]],
        [[-0.9, -0.3]],
        [[-0.9, -0.3]],
    ]
    o_sigmas = [
        [[0.12, 0.10]],
        [[0.10, 0.08]],
        [[0.10, 0.08]],
        [[0.10, 0.08]],
    ]
    o_amps = [
        [[0.08, 0.04]],
        [[0.20, 0.15]],
        [[0.20, 0.15]],
        [[0.20, 0.15]],
    ]
    o_proj = _make_orbital_projections(EIGENVALUES_AU, o_centers, o_sigmas, o_amps, 4)
    write_pdos_file(OUT_DIR / "TiO2-O-k1-1.pdos", "O", EIGENVALUES_AU,
                    o_orbitals, o_proj, FERMI_AU)


def generate_spin_polarized():
    """Generate spin-polarized ALPHA/BETA Ti + O .pdos files."""
    print("=== Spin-polarized TiO2 ===")

    rng = np.random.default_rng(42)

    # Ti ALPHA
    ti_orb = ["s", "py", "pz", "px", "dxy", "dyz", "dz2", "dxz", "dx2"]
    ti_proj_a = np.abs(rng.normal(0, 0.05, (NBANDS, 9)))
    for i, c in enumerate([-1.2, -0.8, -0.8, -0.8, -0.4, -0.4, -0.5, -0.4, -0.5]):
        ti_proj_a[:, i] += _gaussian(EIGENVALUES_AU, c, 0.12, 0.1)
    write_pdos_file(OUT_DIR / "TiO2-Ti-ALPHA-k1-1.pdos", "Ti", EIGENVALUES_AU,
                    ti_orb, ti_proj_a, FERMI_AU, "ALPHA")

    # Ti BETA (slightly shifted)
    ti_proj_b = np.abs(rng.normal(0, 0.05, (NBANDS, 9)))
    for i, c in enumerate([-1.18, -0.78, -0.78, -0.78, -0.38, -0.38, -0.48, -0.38, -0.48]):
        ti_proj_b[:, i] += _gaussian(EIGENVALUES_AU, c, 0.12, 0.09)
    write_pdos_file(OUT_DIR / "TiO2-Ti-BETA-k1-1.pdos", "Ti", EIGENVALUES_AU,
                    ti_orb, ti_proj_b, FERMI_AU, "BETA")

    # O ALPHA
    o_orb = ["s", "py", "pz", "px"]
    o_proj_a = np.abs(rng.normal(0, 0.03, (NBANDS, 4)))
    for i, c in enumerate([-1.3, -0.9, -0.9, -0.9]):
        o_proj_a[:, i] += _gaussian(EIGENVALUES_AU, c, 0.10, 0.15)
    write_pdos_file(OUT_DIR / "TiO2-O-ALPHA-k1-1.pdos", "O", EIGENVALUES_AU,
                    o_orb, o_proj_a, FERMI_AU, "ALPHA")

    # O BETA
    o_proj_b = np.abs(rng.normal(0, 0.03, (NBANDS, 4)))
    for i, c in enumerate([-1.28, -0.88, -0.88, -0.88]):
        o_proj_b[:, i] += _gaussian(EIGENVALUES_AU, c, 0.10, 0.14)
    write_pdos_file(OUT_DIR / "TiO2-O-BETA-k1-1.pdos", "O", EIGENVALUES_AU,
                    o_orb, o_proj_b, FERMI_AU, "BETA")


if __name__ == "__main__":
    generate_non_spin_polarized()
    generate_spin_polarized()
    print(f"\nAll fixtures written to {OUT_DIR}")
