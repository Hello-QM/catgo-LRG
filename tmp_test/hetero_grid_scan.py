#!/usr/bin/env python3
"""
Heterostructure Grid Scan — 对称性约化的横向平移穷举搜索

用法:
    python hetero_grid_scan.py substrate.cif film.cif --nx 6 --ny 6 --gap 2.0 --vacuum 20.0

功能:
    1. 读取 substrate 和 film 结构文件 (CIF/POSCAR/XYZ)
    2. ZSL 晶格匹配 → 构建异质结
    3. 分析 film 的 2D 对称性 → 确定不可约楔形区
    4. 在不可约区内均匀撒 N×N 网格 → 平移 film 原子
    5. 输出所有位移构型为 multi-frame extXYZ 轨迹文件

依赖: pip install pymatgen ase numpy
"""

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np


# =====================================================================
# 1. 结构 I/O
# =====================================================================

def load_structure(path: str):
    """Load structure from CIF/POSCAR/XYZ file via pymatgen."""
    from pymatgen.core import Structure
    return Structure.from_file(path)


def structure_to_extxyz(structure, comment: str = "") -> str:
    """Convert pymatgen Structure to extended XYZ string."""
    lines = [str(len(structure))]

    # Build comment line with lattice info
    lat = structure.lattice.matrix
    lat_str = " ".join(f"{x:.6f}" for row in lat for x in row)
    pbc_str = "T T T" if any(structure.lattice.pbc) else "F F F"
    lines.append(f'Lattice="{lat_str}" Properties=species:S:1:pos:R:3 pbc="{pbc_str}" {comment}')

    for site in structure:
        el = site.specie.symbol
        x, y, z = site.coords
        lines.append(f"{el}  {x:.6f}  {y:.6f}  {z:.6f}")

    return "\n".join(lines)


# =====================================================================
# 2. 异质结构建
# =====================================================================

def strip_vacuum(structure, tol: float = 0.5):
    """Remove vacuum from a slab by compressing c-axis."""
    from pymatgen.core import Lattice, Structure

    cart = structure.cart_coords
    c_hat = structure.lattice.matrix[2]
    c_len = np.linalg.norm(c_hat)
    c_unit = c_hat / c_len

    proj = cart @ c_unit
    z_min, z_max = float(proj.min()), float(proj.max())
    thickness = max(z_max - z_min, 0.1)

    new_c_len = thickness + 2 * tol
    shift = -z_min + tol
    new_cart = cart + shift * c_unit

    a_vec = structure.lattice.matrix[0]
    b_vec = structure.lattice.matrix[1]
    new_lattice = Lattice([a_vec, b_vec, c_unit * new_c_len])

    return Structure(new_lattice, structure.species, new_cart, coords_are_cartesian=True)


def stack_slabs(substrate, film, gap: float = 2.0, vacuum: float = 20.0):
    """Stack film on top of substrate with gap and vacuum.

    Returns (heterostructure, n_atoms_substrate).
    """
    from pymatgen.core import Lattice, Structure

    sub_cart = substrate.cart_coords.copy()
    sub_species = list(substrate.species)

    # Strain film to match substrate a,b
    film_frac = film.frac_coords.copy()
    strained_lattice = Lattice([
        substrate.lattice.matrix[0],
        substrate.lattice.matrix[1],
        film.lattice.matrix[2],
    ])
    film_cart = strained_lattice.get_cartesian_coords(film_frac)
    film_species = list(film.species)

    # Project onto substrate c-direction
    sub_c_hat = substrate.lattice.matrix[2]
    sub_c_unit = sub_c_hat / np.linalg.norm(sub_c_hat)

    sub_top = float((sub_cart @ sub_c_unit).max())
    film_bottom = float((film_cart @ sub_c_unit).min())

    # Shift film above substrate
    shift = (sub_top + gap - film_bottom) * sub_c_unit
    film_cart_shifted = film_cart + shift

    # New c-axis to include everything + vacuum
    total_top = float((film_cart_shifted @ sub_c_unit).max())
    new_c_vec = sub_c_unit * (total_top + vacuum)

    new_lattice = Lattice([
        substrate.lattice.matrix[0],
        substrate.lattice.matrix[1],
        new_c_vec,
    ])

    all_cart = np.vstack([sub_cart, film_cart_shifted])
    all_species = sub_species + film_species

    hetero = Structure(new_lattice, all_species, all_cart, coords_are_cartesian=True)
    return hetero, len(substrate)


def zsl_match_and_build(substrate, film, gap, vacuum, max_area=400):
    """ZSL lattice match two slabs and build the first match.

    Returns (heterostructure, n_atoms_substrate, match_info_str).
    """
    from pymatgen.analysis.interfaces.zsl import ZSLGenerator

    sub_s = strip_vacuum(substrate)
    film_s = strip_vacuum(film)

    # Extract lattice vectors as 3D (z=0) — numba's np.cross fails on 2D
    def _v3(v): return [float(v[0]), float(v[1]), 0.0]
    sub_vecs = [_v3(sub_s.lattice.matrix[0]), _v3(sub_s.lattice.matrix[1])]
    film_vecs = [_v3(film_s.lattice.matrix[0]), _v3(film_s.lattice.matrix[1])]

    gen = ZSLGenerator(max_area_ratio_tol=0.09, max_length_tol=0.03, max_angle_tol=0.01)
    matches = list(gen(film_vecs, sub_vecs, lowest=True))

    if not matches:
        print("ERROR: No ZSL matches found. Try increasing max_area or tolerances.")
        sys.exit(1)

    # Use first (best) match
    match = matches[0]
    sub_transform = np.eye(3, dtype=int)
    sub_transform[:2, :2] = np.array(match.substrate_transformation, dtype=int)
    film_transform = np.eye(3, dtype=int)
    film_transform[:2, :2] = np.array(match.film_transformation, dtype=int)

    sub_sc = sub_s * sub_transform
    film_sc = film_s * film_transform

    hetero, n_sub = stack_slabs(sub_sc, film_sc, gap, vacuum)

    # Compute strain
    sub_sl = match.substrate_sl_vectors
    film_sl = match.film_sl_vectors
    area = float(match.match_area)

    info = f"area={area:.1f} A^2, sub_T={match.substrate_transformation}, film_T={match.film_transformation}"
    return hetero, n_sub, info


# =====================================================================
# 3. 2D 对称性分析
# =====================================================================

def get_2d_symmetry_operations(slab, symprec: float = 0.1):
    """Extract 2D in-plane symmetry operations from a slab."""
    from pymatgen.symmetry.analyzer import SpacegroupAnalyzer

    try:
        analyzer = SpacegroupAnalyzer(slab, symprec=symprec)
        sym_ops = analyzer.get_symmetry_operations()
    except Exception as e:
        print(f"  Warning: symmetry analysis failed ({e}), using identity only")
        return [(np.eye(2), np.zeros(2))]

    ops_2d = []
    tol = 1e-4

    for op in sym_ops:
        rot = op.rotation_matrix
        trans = op.translation_vector

        if (abs(rot[2, 0]) < tol and abs(rot[2, 1]) < tol and
            abs(rot[0, 2]) < tol and abs(rot[1, 2]) < tol and
            abs(abs(rot[2, 2]) - 1.0) < tol and abs(trans[2]) < tol):
            ops_2d.append((rot[:2, :2].copy(), trans[:2].copy()))

    if not ops_2d:
        ops_2d = [(np.eye(2), np.zeros(2))]

    print(f"  2D symmetry: {len(ops_2d)} in-plane ops from {len(sym_ops)} total")
    return ops_2d


def get_irreducible_zone_extent(sym_ops_2d):
    """Determine the bounding box of the irreducible wedge."""
    N = 120
    seen = set()

    for i in range(N):
        for j in range(N):
            fx, fy = i / N, j / N
            pt = np.array([fx, fy])
            canonical = (i, j)

            for rot, trans in sym_ops_2d:
                transformed = rot @ pt + trans
                ix = round((transformed[0] % 1.0) * N) % N
                iy = round((transformed[1] % 1.0) * N) % N
                if (ix, iy) < canonical:
                    canonical = (ix, iy)

            seen.add(canonical)

    if not seen:
        return (1.0, 1.0)

    fx_max = max(c[0] for c in seen) / N + 0.5 / N
    fy_max = max(c[1] for c in seen) / N + 0.5 / N
    fx_max = min(fx_max, 1.0)
    fy_max = min(fy_max, 1.0)

    print(f"  Irreducible zone: [0, {fx_max:.3f}] x [0, {fy_max:.3f}] = {fx_max*fy_max*100:.1f}% of cell")
    return (fx_max, fy_max)


# =====================================================================
# 4. Grid Scan — 在不可约区内平移 film 原子
# =====================================================================

@dataclass
class GridScanEntry:
    shift_frac: tuple
    shift_cart: tuple
    structure: object  # pymatgen Structure
    n_atoms: int


def generate_grid_scan(heterostructure, n_atoms_substrate: int,
                       sym_ops_2d, n_grid_x: int, n_grid_y: int):
    """Generate shifted heterostructures within the irreducible zone.

    Returns list of GridScanEntry.
    """
    from pymatgen.core import Structure

    fx_max, fy_max = get_irreducible_zone_extent(sym_ops_2d)

    lattice = heterostructure.lattice
    a_vec = lattice.matrix[0]
    b_vec = lattice.matrix[1]
    a_len = np.linalg.norm(a_vec)
    b_len = np.linalg.norm(b_vec)

    step_a = fx_max * a_len / n_grid_x
    step_b = fy_max * b_len / n_grid_y

    print(f"  Grid: {n_grid_x} x {n_grid_y} = {n_grid_x * n_grid_y} points")
    print(f"  Step size: {step_a:.3f} x {step_b:.3f} Angstrom")

    entries = []
    n_total = len(heterostructure)

    for i in range(n_grid_x):
        for j in range(n_grid_y):
            fx = (i / n_grid_x) * fx_max
            fy = (j / n_grid_y) * fy_max

            shift_cart = fx * a_vec + fy * b_vec

            cart = heterostructure.cart_coords.copy()
            cart[n_atoms_substrate:, 0] += shift_cart[0]
            cart[n_atoms_substrate:, 1] += shift_cart[1]

            shifted = Structure(lattice, heterostructure.species, cart,
                                coords_are_cartesian=True)

            entries.append(GridScanEntry(
                shift_frac=(fx, fy),
                shift_cart=tuple(float(x) for x in shift_cart),
                structure=shifted,
                n_atoms=n_total,
            ))

    return entries, (fx_max, fy_max), (step_a, step_b)


# =====================================================================
# 5. 主程序
# =====================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Heterostructure Grid Scan: symmetry-reduced lateral shift search",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic: 6x6 grid scan with default parameters
  python hetero_grid_scan.py substrate.cif film.cif

  # Custom grid density and gap
  python hetero_grid_scan.py sub.vasp film.vasp --nx 10 --ny 10 --gap 2.5

  # Skip ZSL matching (already matched slabs)
  python hetero_grid_scan.py hetero.cif film.cif --no-match --n-sub 36

  # Output to specific file
  python hetero_grid_scan.py sub.cif film.cif -o my_scan.extxyz
""",
    )
    parser.add_argument("substrate", help="Substrate structure file (CIF/POSCAR/XYZ)")
    parser.add_argument("film", help="Film structure file (CIF/POSCAR/XYZ)")
    parser.add_argument("--nx", type=int, default=6, help="Grid points along a (default: 6)")
    parser.add_argument("--ny", type=int, default=6, help="Grid points along b (default: 6)")
    parser.add_argument("--gap", type=float, default=2.0, help="Interlayer gap in Angstrom (default: 2.0)")
    parser.add_argument("--vacuum", type=float, default=20.0, help="Vacuum in Angstrom (default: 20.0)")
    parser.add_argument("--symprec", type=float, default=0.1, help="Symmetry tolerance (default: 0.1)")
    parser.add_argument("--max-area", type=float, default=400, help="Max ZSL match area (default: 400)")
    parser.add_argument("--no-match", action="store_true",
                        help="Skip ZSL matching (substrate is already the heterostructure)")
    parser.add_argument("--n-sub", type=int, default=0,
                        help="Number of substrate atoms (required with --no-match)")
    parser.add_argument("-o", "--output", default=None,
                        help="Output file path (default: grid_scan_NxN.extxyz)")

    args = parser.parse_args()

    print(f"=" * 60)
    print(f"Heterostructure Grid Scan")
    print(f"=" * 60)

    # Load structures
    print(f"\n[1/5] Loading structures...")
    substrate = load_structure(args.substrate)
    film_raw = load_structure(args.film)
    print(f"  Substrate: {substrate.composition.reduced_formula} ({len(substrate)} atoms)")
    print(f"  Film: {film_raw.composition.reduced_formula} ({len(film_raw)} atoms)")

    # Build heterostructure
    if args.no_match:
        if args.n_sub <= 0:
            print("ERROR: --n-sub is required when using --no-match")
            sys.exit(1)
        hetero = substrate
        n_sub = args.n_sub
        print(f"\n[2/5] Skipping ZSL match (pre-built heterostructure, {n_sub} substrate atoms)")
    else:
        print(f"\n[2/5] ZSL lattice matching...")
        hetero, n_sub, match_info = zsl_match_and_build(
            substrate, film_raw, args.gap, args.vacuum, args.max_area,
        )
        print(f"  Match: {match_info}")
        print(f"  Heterostructure: {len(hetero)} atoms ({n_sub} sub + {len(hetero) - n_sub} film)")

    # Symmetry analysis
    print(f"\n[3/5] Analyzing film 2D symmetry...")
    film_stripped = strip_vacuum(film_raw)
    sym_ops = get_2d_symmetry_operations(film_stripped, symprec=args.symprec)

    # Grid scan
    print(f"\n[4/5] Generating grid scan structures...")
    entries, zone_ext, step_size = generate_grid_scan(
        hetero, n_sub, sym_ops, args.nx, args.ny,
    )
    print(f"  Generated {len(entries)} structures")

    # Write output
    output_path = args.output or f"grid_scan_{args.nx}x{args.ny}.extxyz"
    print(f"\n[5/5] Writing trajectory to {output_path}...")

    frames = []
    for entry in entries:
        comment = (
            f"shift_fx={entry.shift_frac[0]:.4f} "
            f"shift_fy={entry.shift_frac[1]:.4f} "
            f"shift_x={entry.shift_cart[0]:.4f} "
            f"shift_y={entry.shift_cart[1]:.4f}"
        )
        frames.append(structure_to_extxyz(entry.structure, comment))

    content = "\n".join(frames) + "\n"
    Path(output_path).write_text(content, encoding="utf-8")

    file_size = Path(output_path).stat().st_size
    print(f"  Written: {file_size / 1024:.1f} KB")

    # Summary
    print(f"\n{'=' * 60}")
    print(f"Summary:")
    print(f"  Symmetry ops:      {len(sym_ops)}")
    print(f"  Irreducible zone:  {zone_ext[0]:.1%} x {zone_ext[1]:.1%} of unit cell")
    print(f"  Grid:              {args.nx} x {args.ny} = {len(entries)} points")
    print(f"  Step size:         {step_size[0]:.3f} x {step_size[1]:.3f} Angstrom")
    print(f"  Output:            {output_path}")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
