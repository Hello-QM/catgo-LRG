"""Water layer generation API endpoint using spc216 tiling for water
packing and optional LAMMPS TIP4P/2005 equilibration."""

import logging
import os
import shutil
import subprocess
import tempfile
import traceback

import numpy as np
from fastapi import APIRouter, HTTPException

from catgo.models.water_layer import WaterLayerParams, WaterLayerRequest, WaterLayerResult
from catgo.utils import ase_to_pymatgen, pymatgen_to_ase

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/water-layer", tags=["water-layer"])

# Element masses for LAMMPS slab atom types
ELEMENT_MASSES = {
    'H': 1.008, 'He': 4.003, 'Li': 6.941, 'Be': 9.012, 'B': 10.81, 'C': 12.01,
    'N': 14.01, 'O': 16.00, 'F': 19.00, 'Ne': 20.18, 'Na': 22.99, 'Mg': 24.31,
    'Al': 26.98, 'Si': 28.09, 'P': 30.97, 'S': 32.07, 'Cl': 35.45, 'Ar': 39.95,
    'K': 39.10, 'Ca': 40.08, 'Sc': 44.96, 'Ti': 47.87, 'V': 50.94, 'Cr': 52.00,
    'Mn': 54.94, 'Fe': 55.85, 'Co': 58.93, 'Ni': 58.69, 'Cu': 63.55, 'Zn': 65.38,
    'Ga': 69.72, 'Ge': 72.64, 'As': 74.92, 'Se': 78.96, 'Br': 79.90, 'Kr': 83.80,
    'Rb': 85.47, 'Sr': 87.62, 'Y': 88.91, 'Zr': 91.22, 'Nb': 92.91, 'Mo': 95.96,
    'Ru': 101.1, 'Rh': 102.9, 'Pd': 106.4, 'Ag': 107.9, 'Cd': 112.4,
    'In': 114.8, 'Sn': 118.7, 'Sb': 121.8, 'Te': 127.6, 'I': 126.9,
    'Cs': 132.9, 'Ba': 137.3, 'La': 138.9, 'Ce': 140.1, 'Hf': 178.5,
    'Ta': 180.9, 'W': 183.8, 'Re': 186.2, 'Os': 190.2, 'Ir': 192.2,
    'Pt': 195.1, 'Au': 197.0, 'Pb': 207.2, 'Bi': 209.0,
}

# Covalent radii (Å) for LJ repulsion between slab atoms and water.
# Source: Cordero et al. (2008), Dalton Trans. 2832-2838.
COVALENT_RADII = {
    'H': 0.31, 'He': 0.28, 'Li': 1.28, 'Be': 0.96, 'B': 0.84, 'C': 0.76,
    'N': 0.71, 'O': 0.66, 'F': 0.57, 'Ne': 0.58, 'Na': 1.66, 'Mg': 1.41,
    'Al': 1.21, 'Si': 1.11, 'P': 1.07, 'S': 1.05, 'Cl': 1.02, 'Ar': 1.06,
    'K': 2.03, 'Ca': 1.76, 'Sc': 1.70, 'Ti': 1.60, 'V': 1.53, 'Cr': 1.39,
    'Mn': 1.39, 'Fe': 1.32, 'Co': 1.26, 'Ni': 1.24, 'Cu': 1.32, 'Zn': 1.22,
    'Ga': 1.22, 'Ge': 1.20, 'As': 1.19, 'Se': 1.20, 'Br': 1.20, 'Kr': 1.16,
    'Rb': 2.20, 'Sr': 1.95, 'Y': 1.90, 'Zr': 1.75, 'Nb': 1.64, 'Mo': 1.54,
    'Ru': 1.46, 'Rh': 1.42, 'Pd': 1.39, 'Ag': 1.45, 'Cd': 1.44,
    'In': 1.42, 'Sn': 1.39, 'Sb': 1.39, 'Te': 1.38, 'I': 1.39,
    'Cs': 2.44, 'Ba': 2.15, 'La': 2.07, 'Ce': 2.04, 'Hf': 1.75,
    'Ta': 1.70, 'W': 1.62, 'Re': 1.51, 'Os': 1.44, 'Ir': 1.41,
    'Pt': 1.36, 'Au': 1.36, 'Pb': 1.46, 'Bi': 1.48,
}


def calculate_n_water(xy_area: float, water_height: float, density: float) -> int:
    """Estimate number of water molecules from density formula (for frontend display)."""
    molecular_weight = 18.015
    avogadro = 6.022e23
    water_volume_cm3 = xy_area * water_height * 1e-24
    n_molecules = round(density * water_volume_cm3 * avogadro / molecular_weight)
    return max(n_molecules, 0)


def _find_spc216() -> str:
    """Find spc216.gro water box coordinates.

    Resolution order:
    1. Bundled copy in server/data/spc216.gro (no external dependency)
    2. GMXDATA env var
    3. GROMACS gmx binary auto-detection
    """
    # 1. Bundled copy (shipped with CatGO — works everywhere)
    # __file__ = server/catgo/routers/water_layer.py → up 3 dirs to server/
    server_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    bundled = os.path.join(server_dir, "data", "spc216.gro")
    if os.path.exists(bundled):
        return bundled

    # 2. Check GMXDATA env var
    gmxdata = os.environ.get("GMXDATA")
    if gmxdata:
        path = os.path.join(gmxdata, "top", "spc216.gro")
        if os.path.exists(path):
            return path

    # 3. Auto-detect from GROMACS installation
    gmx_bin = shutil.which("gmx")
    if gmx_bin:
        try:
            result = subprocess.run(
                [gmx_bin, "-h"],
                capture_output=True, text=True, timeout=10,
            )
            for line in (result.stdout + result.stderr).split("\n"):
                if "Data prefix:" in line:
                    prefix = line.split("Data prefix:")[1].strip()
                    path = os.path.join(prefix, "share", "gromacs", "top", "spc216.gro")
                    if os.path.exists(path):
                        return path
        except Exception:
            pass

    raise RuntimeError(
        "Cannot find spc216.gro water box. The bundled file at "
        f"{bundled} is missing. Reinstall CatGO or set GMXDATA env var."
    )


def _load_spc216(filepath: str) -> tuple[np.ndarray, float]:
    """Load spc216.gro water box positions.

    Returns (positions_Å (648, 3), box_side_Å).
    Positions are wrapped to [0, box) as rigid molecules (O determines shift,
    H atoms follow) to ensure correct tiling behaviour.
    """
    positions: list[list[float]] = []
    with open(filepath) as f:
        f.readline()  # title
        n_atoms = int(f.readline().strip())
        for _ in range(n_atoms):
            line = f.readline()
            x = float(line[20:28]) * 10.0  # nm → Å
            y = float(line[28:36]) * 10.0
            z = float(line[36:44]) * 10.0
            positions.append([x, y, z])
        box_line = f.readline().split()
        box_size = float(box_line[0]) * 10.0  # cubic box side in Å

    pos = np.array(positions)
    n_mol = len(pos) // 3

    # spc216 positions may be centered at origin ([-L/2, L/2]).
    # Wrap each molecule as a rigid unit so O lands in [0, L).
    for m in range(n_mol):
        o_idx = m * 3
        shift = np.floor(pos[o_idx] / box_size) * box_size
        pos[o_idx] -= shift
        pos[o_idx + 1] -= shift
        pos[o_idx + 2] -= shift

    return pos, box_size


def pack_water_spc216(
    slab_positions: np.ndarray,
    cell: np.ndarray,
    z_start: float,
    z_end: float,
    min_distance: float,
) -> np.ndarray:
    """Fill [z_start, z_end] with water by tiling pre-equilibrated spc216.gro.

    Unlike ``gmx solvate`` (which computes tiling count from diagonal box
    elements only), this function computes the full Cartesian bounding box
    of the triclinic fill region and tiles enough copies of spc216 to cover
    it completely.  This fixes the under-filling bug for non-orthogonal cells
    (e.g. hexagonal γ = 120°) where ``gmx solvate`` missed up to ~25% of
    the cell volume.

    Algorithm:
    1. Load spc216.gro (216 molecules in 18.62 Å cubic box, ~1 g/cm³).
    2. Compute Cartesian bounding box of the target cell's fill region.
    3. Tile spc216 along Cartesian axes to completely cover the bbox.
    4. Filter by fractional coordinates: a,b ∈ [0,1), c ∈ [c_start, c_end].
    5. Remove molecules with any atom closer than *min_distance* to a slab
       atom (PBC-aware in a,b via ASE neighbor_list MIC).

    Returns (N*3, 3) array of [O,H,H, O,H,H, ...] in Å, or empty array.
    """
    spc_path = _find_spc216()
    spc_positions, spc_box = _load_spc216(spc_path)
    n_spc_mol = len(spc_positions) // 3

    cell_inv = np.linalg.inv(cell)

    # Convert z bounds to fractional c-coordinate
    frac_c_start = (np.array([0.0, 0.0, z_start]) @ cell_inv)[2]
    frac_c_end = (np.array([0.0, 0.0, z_end]) @ cell_inv)[2]
    if frac_c_start > frac_c_end:
        frac_c_start, frac_c_end = frac_c_end, frac_c_start

    logger.info(
        "Cell (Å): a=[%.3f, %.3f, %.3f], b=[%.3f, %.3f, %.3f], "
        "c=[%.3f, %.3f, %.3f]",
        *cell[0], *cell[1], *cell[2],
    )
    logger.info(
        "spc216 tiling: frac_c=[%.4f, %.4f] (z=[%.1f, %.1f] Å), "
        "min_dist=%.1f Å",
        frac_c_start, frac_c_end, z_start, z_end, min_distance,
    )

    # Compute Cartesian bounding box of the fill region (the parallelepiped
    # slice defined by frac_a,b ∈ [0,1), frac_c ∈ [c_start, c_end]).
    vertices = []
    for fa in [0.0, 1.0]:
        for fb in [0.0, 1.0]:
            for fc in [frac_c_start, frac_c_end]:
                vertices.append(fa * cell[0] + fb * cell[1] + fc * cell[2])
    vertices_arr = np.array(vertices)
    bbox_min = vertices_arr.min(axis=0) - 1.0  # 1 Å buffer for H atoms
    bbox_max = vertices_arr.max(axis=0) + 1.0

    n_tiles = np.ceil((bbox_max - bbox_min) / spc_box).astype(int)
    n_tiles = np.maximum(n_tiles, 1)
    logger.info(
        "Tiling spc216: %d×%d×%d copies (bbox %.1f×%.1f×%.1f Å)",
        *n_tiles,
        *(bbox_max - bbox_min),
    )

    # Tile spc216 along Cartesian axes and filter by fractional coordinates
    kept: list[tuple[np.ndarray, np.ndarray, np.ndarray]] = []
    for ix in range(n_tiles[0]):
        for iy in range(n_tiles[1]):
            for iz in range(n_tiles[2]):
                offset = bbox_min + np.array([ix, iy, iz]) * spc_box
                for m in range(n_spc_mol):
                    o = spc_positions[m * 3] + offset
                    frac = o @ cell_inv
                    if (0 <= frac[0] < 1 and 0 <= frac[1] < 1
                            and frac_c_start <= frac[2] <= frac_c_end):
                        h1 = spc_positions[m * 3 + 1] + offset
                        h2 = spc_positions[m * 3 + 2] + offset
                        kept.append((o, h1, h2))

    logger.info("After fractional filtering: %d water molecules", len(kept))

    if not kept:
        return np.empty((0, 3))

    # Remove water molecules overlapping with slab atoms.
    # Use ASE's neighbor_list with PBC in a,b for correct MIC distances,
    # especially important for non-orthogonal (hexagonal/triclinic) cells.
    if len(slab_positions) > 0:
        from ase import Atoms as AseAtoms
        from ase.neighborlist import neighbor_list as ase_neighbor_list

        n_slab = len(slab_positions)
        # Build combined Atoms: slab + water (O, H, H per molecule)
        all_pos = np.vstack(
            [slab_positions]
            + [np.array([o, h1, h2]) for o, h1, h2 in kept]
        )
        all_syms = ["He"] * n_slab + ["O", "H", "H"] * len(kept)

        check_atoms = AseAtoms(
            symbols=all_syms,
            positions=all_pos,
            cell=cell,
            pbc=[True, True, False],  # PBC in a,b only (not c — vacuum above)
        )

        # Find all atom pairs within min_distance
        i_arr, j_arr = ase_neighbor_list("ij", check_atoms, min_distance)

        remove_mol: set[int] = set()
        for k in range(len(i_arr)):
            ai, aj = int(i_arr[k]), int(j_arr[k])
            ai_slab = ai < n_slab
            aj_slab = aj < n_slab
            if ai_slab != aj_slab:  # one slab, one water
                water_idx = aj if ai_slab else ai
                mol_idx = (water_idx - n_slab) // 3
                remove_mol.add(mol_idx)

        if remove_mol:
            kept = [m for i, m in enumerate(kept) if i not in remove_mol]

    n_after_slab = len(kept)
    logger.info(
        "After slab overlap removal: %d water molecules", n_after_slab,
    )

    if not kept:
        return np.empty((0, 3))

    # Remove water-water overlaps across cell PBC boundaries.
    # The spc216 tile boundaries don't align with the triclinic cell,
    # so molecules at opposite cell faces can be too close through PBC.
    # Use ASE's MIC (minimum image convention) for correct PBC distances.
    from ase import Atoms as AseAtoms

    OH_CUTOFF = 1.3  # Å — same as standard O-H bond detection cutoff

    # Build temporary ASE Atoms with just water for PBC distance check
    water_syms: list[str] = []
    water_pos: list[np.ndarray] = []
    mol_of_atom: list[int] = []  # maps atom index → molecule index
    for i, (o, h1, h2) in enumerate(kept):
        water_syms.extend(["O", "H", "H"])
        water_pos.extend([o, h1, h2])
        mol_of_atom.extend([i, i, i])

    water_atoms = AseAtoms(
        symbols=water_syms,
        positions=water_pos,
        cell=cell,
        pbc=True,
    )

    n_w = len(kept)
    remove_set: set[int] = set()

    # For each water O, check if any H from a DIFFERENT molecule is
    # within OH_CUTOFF (using MIC).  If so, the two molecules overlap.
    o_atom_indices = list(range(0, len(water_atoms), 3))  # O at 0,3,6,...
    h_atom_indices = []
    for m in range(n_w):
        h_atom_indices.append(m * 3 + 1)
        h_atom_indices.append(m * 3 + 2)

    for i_mol, o_idx in enumerate(o_atom_indices):
        if i_mol in remove_set:
            continue
        for h_idx in h_atom_indices:
            j_mol = mol_of_atom[h_idx]
            if j_mol == i_mol or j_mol in remove_set:
                continue
            dist = water_atoms.get_distance(o_idx, h_idx, mic=True)
            if dist < OH_CUTOFF:
                remove_set.add(max(i_mol, j_mol))

    if remove_set:
        kept = [m for i, m in enumerate(kept) if i not in remove_set]
        logger.info(
            "Removed %d water molecules due to PBC water-water overlap",
            len(remove_set),
        )

    n_kept = len(kept)
    if not kept:
        return np.empty((0, 3))

    # Flatten to (N*3, 3) array: [O, H, H, O, H, H, ...]
    result = np.empty((n_kept * 3, 3))
    for i, (o, h1, h2) in enumerate(kept):
        result[i * 3] = o
        result[i * 3 + 1] = h1
        result[i * 3 + 2] = h2

    return result


def _cell_to_lammps_box(cell: np.ndarray) -> dict:
    """Convert cell matrix to LAMMPS box parameters."""
    a_vec, b_vec, c_vec = cell[0], cell[1], cell[2]
    xhi = np.linalg.norm(a_vec)
    xy = np.dot(b_vec, a_vec / xhi)
    yhi = np.sqrt(np.dot(b_vec, b_vec) - xy**2)
    xz = np.dot(c_vec, a_vec / xhi)
    yz = (np.dot(b_vec, c_vec) - xy * xz) / yhi
    zhi = np.sqrt(np.dot(c_vec, c_vec) - xz**2 - yz**2)
    return {"xhi": xhi, "yhi": yhi, "zhi": zhi, "xy": xy, "xz": xz, "yz": yz}


def _cart_to_lammps(positions: np.ndarray, cell: np.ndarray, box: dict) -> np.ndarray:
    """Transform Cartesian positions to LAMMPS coordinate system."""
    cell_inv = np.linalg.inv(cell.T)
    frac = positions @ cell_inv.T
    lmp = np.zeros_like(positions)
    lmp[:, 0] = frac[:, 0] * box["xhi"] + frac[:, 1] * box["xy"] + frac[:, 2] * box["xz"]
    lmp[:, 1] = frac[:, 1] * box["yhi"] + frac[:, 2] * box["yz"]
    lmp[:, 2] = frac[:, 2] * box["zhi"]
    return lmp


def _lammps_to_cart(lmp_coords: np.ndarray, cell: np.ndarray, box: dict) -> np.ndarray:
    """Transform LAMMPS coordinates back to Cartesian."""
    frac = np.zeros_like(lmp_coords)
    frac[:, 2] = lmp_coords[:, 2] / box["zhi"]
    frac[:, 1] = (lmp_coords[:, 1] - frac[:, 2] * box["yz"]) / box["yhi"]
    frac[:, 0] = (lmp_coords[:, 0] - frac[:, 1] * box["xy"] - frac[:, 2] * box["xz"]) / box["xhi"]
    return frac @ cell


def _write_lammps_data(
    filepath: str,
    positions: np.ndarray,
    symbols: list[str],
    box: dict,
    is_tri: bool,
    n_slab_atoms: int,
    n_water: int,
    slab_elem_to_type: dict[str, int],
    n_atom_types: int,
) -> None:
    """Write a LAMMPS data file for the combined slab+water system."""
    n_total = len(positions)
    n_bonds = n_water * 2
    n_angles = n_water

    with open(filepath, "w") as f:
        f.write("LAMMPS data file for slab + TIP4P/2005 water\n\n")
        f.write(f"    {n_total} atoms\n")
        f.write(f"    {n_bonds} bonds\n")
        f.write(f"    {n_angles} angles\n\n")
        f.write(f"    {n_atom_types} atom types\n")
        f.write(f"    1 bond types\n")
        f.write(f"    1 angle types\n\n")

        # Box bounds
        if is_tri:
            f.write(f"    0 {box['xhi']:.10f} xlo xhi\n")
            f.write(f"    0 {box['yhi']:.10f} ylo yhi\n")
            f.write(f"    0 {box['zhi']:.10f} zlo zhi\n")
            f.write(f"    {box['xy']:.10f} {box['xz']:.10f} {box['yz']:.10f} xy xz yz\n\n")
        else:
            f.write(f"    0 {box['xhi']:.10f} xlo xhi\n")
            f.write(f"    0 {box['yhi']:.10f} ylo yhi\n")
            f.write(f"    0 {box['zhi']:.10f} zlo zhi\n\n")

        # Masses
        f.write("Masses\n\n")
        f.write("    1 15.9994 # O_water\n")
        f.write("    2 1.0079  # H_water\n")
        for el, tid in slab_elem_to_type.items():
            f.write(f"    {tid} {ELEMENT_MASSES.get(el, 1.0):.4f} # {el}\n")
        f.write("\n")

        # Atoms: id mol type charge x y z
        f.write("Atoms\n\n")
        mol_id = 0
        for i in range(n_total):
            x, y, z = positions[i]
            if i < n_slab_atoms:
                atype = slab_elem_to_type[symbols[i]]
                mol_id_cur = 0  # slab atoms: mol 0
                charge = 0.0
            else:
                water_idx = i - n_slab_atoms
                mol_id_cur = water_idx // 3 + 1  # each water = 1 molecule
                if water_idx % 3 == 0:
                    atype = 1  # O
                    charge = -1.1794
                else:
                    atype = 2  # H
                    charge = 0.5897
            f.write(f"    {i + 1} {mol_id_cur} {atype} {charge:.4f} {x:.10f} {y:.10f} {z:.10f}\n")
        f.write("\n")

        # Bonds: O-H bonds for each water molecule
        f.write("Bonds\n\n")
        bond_id = 0
        for w in range(n_water):
            o_id = n_slab_atoms + w * 3 + 1  # 1-indexed
            bond_id += 1
            f.write(f"{bond_id} 1 {o_id} {o_id + 1}\n")
            bond_id += 1
            f.write(f"{bond_id} 1 {o_id} {o_id + 2}\n")
        f.write("\n")

        # Angles: H-O-H for each water molecule
        f.write("Angles\n\n")
        for w in range(n_water):
            o_id = n_slab_atoms + w * 3 + 1
            f.write(f"{w + 1} 1 {o_id + 1} {o_id} {o_id + 2}\n")
        f.write("\n")


def equilibrate_water_lammps(
    combined_atoms,
    n_slab_atoms: int,
    n_water: int,
    temperature: float,
    steps: int,
) -> None:
    """Run LAMMPS TIP4P/2005 equilibration on water molecules (slab atoms frozen).

    Modifies combined_atoms positions in-place.
    Uses TIP4P/2005 parameters from https://github.com/saeid-lab/TIP4P-Lammps
    with SHAKE constraints for rigid water geometry.

    TIP4P/2005 parameters (real units: kcal/mol, Å, fs):
    - O: epsilon=0.18521, sigma=3.1589, q=-1.1794 (on M-site, 0.1546 Å from O)
    - H: epsilon=0.0, sigma=0.0, q=+0.5897
    - O-H bond: k=1000.0, r0=0.9572 Å (SHAKE constrained)
    - H-O-H angle: k=100.0, theta0=104.52° (SHAKE constrained)
    - LJ cutoff: 12.0 Å, PPPM 1e-4
    """
    import tempfile
    from lammps import lammps

    positions = combined_atoms.get_positions()
    cell = np.array(combined_atoms.get_cell())
    symbols = combined_atoms.get_chemical_symbols()
    n_total = len(combined_atoms)

    box = _cell_to_lammps_box(cell)
    lmp_coords = _cart_to_lammps(positions, cell, box)
    is_tri = abs(box["xy"]) > 1e-8 or abs(box["xz"]) > 1e-8 or abs(box["yz"]) > 1e-8

    # Atom types: 1=O_water, 2=H_water, 3+=slab elements
    slab_elem_to_type = {}
    for i in range(n_slab_atoms):
        el = symbols[i]
        if el not in slab_elem_to_type:
            slab_elem_to_type[el] = len(slab_elem_to_type) + 3

    n_atom_types = 2 + len(slab_elem_to_type)

    # Write LAMMPS data file
    with tempfile.NamedTemporaryFile(mode="w", suffix=".data", delete=False) as tmp:
        data_file = tmp.name

    _write_lammps_data(
        data_file, lmp_coords, symbols, box, is_tri,
        n_slab_atoms, n_water, slab_elem_to_type, n_atom_types,
    )

    l = lammps(cmdargs=["-log", "none", "-screen", "none"])
    try:
        l.command("units real")
        l.command("atom_style full")
        l.command("boundary p p p")

        # Read data file
        l.command(f'read_data {data_file}')

        # TIP4P/2005 force field
        # pair_style lj/cut/tip4p/long otype htype btype atype qdist cutoff
        l.command("pair_style lj/cut/tip4p/long 1 2 1 1 0.1546 12")
        l.command("kspace_style pppm/tip4p 1.0e-4")

        # Pair coefficients
        # Water-water: TIP4P/2005 O-O LJ
        l.command("pair_coeff 1 1 0.18521 3.1589")  # O-O (TIP4P/2005)
        l.command("pair_coeff 2 2 0.0 0.0")          # H-H
        l.command("pair_coeff 1 2 0.0 0.0")          # O-H

        # Slab-water: LJ repulsion based on covalent radii.
        # sigma_cross = (sigma_slab + sigma_OW) / 2, Lorentz-Berthelot mixing.
        # sigma_slab derived from covalent radius: r_cov * 2^(5/6) so that
        # the LJ minimum (at r = sigma * 2^(1/6)) sits at r_cov + r_OW_eff.
        sigma_OW = 3.1589  # TIP4P/2005 oxygen sigma
        eps_repulse = 0.1  # kcal/mol — mild repulsion, enough to prevent penetration
        for el, tid in slab_elem_to_type.items():
            r_cov = COVALENT_RADII.get(el, 1.5)
            # LJ minimum at r_min = sigma * 2^(1/6).
            # We want r_min ≈ r_cov + r_OW/2 (half-sigma of oxygen as effective radius).
            # sigma_slab = 2 * r_cov (diameter-like), then mix with sigma_OW.
            sigma_slab = 2.0 * r_cov
            sigma_cross = (sigma_slab + sigma_OW) / 2.0
            l.command(f"pair_coeff 1 {tid} {eps_repulse:.4f} {sigma_cross:.4f}")  # O_water - slab
            l.command(f"pair_coeff 2 {tid} 0.0 1.0")  # H_water - slab (no LJ)
            l.command(f"pair_coeff {tid} {tid} 0.0 1.0")  # slab-slab (frozen, no interaction needed)

        # Cross terms between different slab types (all frozen, no interaction needed)
        slab_tids = sorted(slab_elem_to_type.values())
        for ii in range(len(slab_tids)):
            for jj in range(ii + 1, len(slab_tids)):
                l.command(f"pair_coeff {slab_tids[ii]} {slab_tids[jj]} 0.0 1.0")
        l.command("pair_modify tail yes")

        # Bond and angle styles (harmonic, but SHAKE will constrain them)
        l.command("bond_style harmonic")
        l.command("angle_style harmonic")
        l.command("bond_coeff 1 1000.0 0.9572")   # O-H (TIP4P/2005)
        l.command("angle_coeff 1 100.0 104.52")    # H-O-H (TIP4P/2005)

        # Neighbor settings
        l.command("neighbor 3.0 bin")
        l.command("neigh_modify delay 0 every 1 check yes")

        # Groups: freeze slab, equilibrate water
        l.command(f"group slab id 1:{n_slab_atoms}")
        l.command(f"group water id {n_slab_atoms + 1}:{n_total}")
        l.command("fix freeze slab setforce 0.0 0.0 0.0")

        # SHAKE constraints for rigid water geometry (bonds + angles)
        l.command("fix water_shake water shake 1.0e-4 100 0 b 1 a 1")

        # Initialize velocities for water only
        l.command(f"velocity water create {temperature} 12345 dist gaussian")

        # Minimize then NVT equilibration
        l.command("minimize 1.0e-4 1.0e-6 1000 10000")
        l.command(f"fix nvt_water water nvt temp {temperature} {temperature} 200.0")
        l.command("timestep 1.0")
        l.command(f"run {steps}")

        # Extract updated positions
        new_x = l.gather_atoms("x", 1, 3)
        new_lmp_coords = np.array(new_x).reshape(n_total, 3)
        new_cart = _lammps_to_cart(new_lmp_coords, cell, box)

        # Only update water positions
        positions[n_slab_atoms:] = new_cart[n_slab_atoms:]
        combined_atoms.set_positions(positions)

    finally:
        l.close()
        import os
        os.unlink(data_file)


@router.post("/add", response_model=WaterLayerResult)
def add_water_layer(request: WaterLayerRequest) -> WaterLayerResult:
    """Add a water layer to a structure by filling a z-region and removing overlaps.

    Algorithm:
    1. Convert structure to ASE Atoms
    2. Check if z_end exceeds c-axis; if so, expand c-axis
    3. Fill entire z_start–z_end region with water at specified density
    4. Remove whole water molecules that overlap with existing atoms
    5. Append remaining water atoms
    6. (Optional) LAMMPS TIP4P equilibration of water positions
    7. Convert back to pymatgen format
    """
    try:
        params = request.params or WaterLayerParams()

        # Convert to ASE
        atoms = pymatgen_to_ase(request.structure)
        n_slab_atoms = len(atoms)
        positions = atoms.get_positions()
        cell = np.array(atoms.get_cell())

        c_len = atoms.get_cell().lengths()[2]

        z_start = params.z_start
        z_end = params.z_end

        if z_start >= z_end:
            raise HTTPException(
                status_code=400,
                detail=f"z_start ({z_start:.2f} Å) must be less than z_end ({z_end:.2f} Å)",
            )

        # Auto-expand c-axis if z_end exceeds current cell
        c_axis_adjusted = False
        new_c_length = c_len
        # Use c-axis z-component for comparison (handles tilted cells)
        c_z = cell[2, 2]
        if z_end > c_z:
            # Add a small buffer (2 Å) above z_end
            new_c_length = c_len * ((z_end + 2.0) / c_z)
            c_axis_adjusted = True
            new_cell = cell.copy()
            new_cell[2] = cell[2] * (new_c_length / c_len)
            atoms.set_cell(new_cell)
            cell = new_cell
            logger.info(
                "c-axis expanded: %.1f → %.1f Å (z_end=%.1f exceeded c_z=%.1f)",
                c_len, new_c_length, z_end, c_z,
            )

        logger.info(
            "Water fill: %d slab atoms, z=[%.1f, %.1f] Å",
            len(atoms), z_start, z_end,
        )

        # Estimate number of water molecules from density
        a_vec, b_vec = cell[0], cell[1]
        xy_area = np.linalg.norm(np.cross(a_vec, b_vec))
        water_height = z_end - z_start
        n_water_target = calculate_n_water(xy_area, water_height, params.density)

        if n_water_target == 0:
            return WaterLayerResult(
                structure=request.structure,
                n_water_molecules=0,
                n_atoms_added=0,
                n_water_filled=0,
                n_water_removed=0,
                z_start=z_start,
                z_end=z_end,
                c_axis_adjusted=c_axis_adjusted,
                new_c_length=new_c_length,
                message="Region too small for any water molecules.",
            )

        # Pack water by tiling pre-equilibrated spc216.gro (~1 g/cm³)
        water_positions = pack_water_spc216(
            slab_positions=positions,
            cell=cell,
            z_start=z_start,
            z_end=z_end,
            min_distance=params.min_distance,
        )

        n_water_placed = len(water_positions) // 3

        if n_water_placed == 0:
            return WaterLayerResult(
                structure=request.structure,
                n_water_molecules=0,
                n_atoms_added=0,
                n_water_filled=n_water_target,
                n_water_removed=0,
                z_start=z_start,
                z_end=z_end,
                c_axis_adjusted=c_axis_adjusted,
                new_c_length=new_c_length,
                message="Could not place any water molecules. Try adjusting z range or min_distance.",
            )

        # Append water atoms to structure
        combined = atoms.copy()
        for i in range(n_water_placed):
            base = i * 3
            combined.append("O")
            combined.positions[-1] = water_positions[base]
            combined.append("H")
            combined.positions[-1] = water_positions[base + 1]
            combined.append("H")
            combined.positions[-1] = water_positions[base + 2]

        # Optional LAMMPS TIP4P equilibration
        equilibrated = False
        if params.equilibrate:
            try:
                logger.info(
                    "Running LAMMPS TIP4P equilibration: T=%.0f K, %d steps...",
                    params.equil_temperature, params.equil_steps,
                )
                equilibrate_water_lammps(
                    combined, n_slab_atoms, n_water_placed,
                    params.equil_temperature, params.equil_steps,
                )
                equilibrated = True
                logger.info("LAMMPS equilibration completed.")
            except Exception as eq_err:
                logger.warning("LAMMPS equilibration failed: %s", eq_err)

        result_structure = ase_to_pymatgen(combined)

        # Preserve original site properties and set water atoms as mobile
        original_sites = request.structure.sites
        for i, site in enumerate(result_structure.sites):
            if i < n_slab_atoms:
                site.properties = original_sites[i].properties
            else:
                site.properties = {"selective_dynamics": [True, True, True]}

        # Compute actual water density in fill region
        molecular_weight = 18.015
        avogadro = 6.022e23
        fill_volume_ang3 = xy_area * water_height  # Å³
        fill_volume_cm3 = fill_volume_ang3 * 1e-24
        actual_density = (n_water_placed * molecular_weight) / (avogadro * fill_volume_cm3) if fill_volume_cm3 > 0 else 0.0
        logger.info(
            "Water density: %.3f g/cm³ (%d molecules in %.1f ų = %.2e cm³)",
            actual_density, n_water_placed, fill_volume_ang3, fill_volume_cm3,
        )

        # Build result message
        parts = [f"Packed {n_water_placed} water molecules ({n_water_placed * 3} atoms) in z=[{z_start:.1f}, {z_end:.1f}] Å"]
        parts.append(f"density: {actual_density:.3f} g/cm³")
        if n_water_placed < n_water_target:
            parts.append(f"requested {n_water_target}, placed {n_water_placed}")
        if c_axis_adjusted:
            parts.append(f"c-axis expanded to {new_c_length:.1f} Å")
        if params.equilibrate:
            parts.append("equilibrated with TIP4P" if equilibrated else "equilibration failed")

        return WaterLayerResult(
            structure=result_structure,
            n_water_molecules=n_water_placed,
            n_atoms_added=n_water_placed * 3,
            n_water_filled=n_water_target,
            n_water_removed=n_water_target - n_water_placed,
            z_start=z_start,
            z_end=z_end,
            c_axis_adjusted=c_axis_adjusted,
            new_c_length=new_c_length,
            equilibrated=equilibrated,
            actual_density=actual_density,
            message="; ".join(parts),
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error adding water layer: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/health")
def water_layer_health():
    """Health check for water layer endpoint."""
    return {"status": "healthy", "service": "water-layer"}
