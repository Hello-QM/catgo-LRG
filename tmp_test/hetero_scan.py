#!/usr/bin/env python3
"""
异质结 Grid Scan — 交互式命令行工具

Step 1: 选文件 → ZSL匹配 → 构建异质结 → ASE可视化确认 → 确认/回退
Step 2: 对称性分析 → 网格穷举 → 导出轨迹文件 → ASE浏览全部构型

用法:
    python hetero_scan.py
"""

import sys
from pathlib import Path
import numpy as np


# ===================== 核心算法 =====================

def load_structure(path):
    from pymatgen.core import Structure
    return Structure.from_file(str(path))


def strip_vacuum(structure, tol=0.5):
    from pymatgen.core import Lattice, Structure as S
    cart = structure.cart_coords
    c_hat = structure.lattice.matrix[2]
    c_unit = c_hat / np.linalg.norm(c_hat)
    proj = cart @ c_unit
    z_min, z_max = float(proj.min()), float(proj.max())
    thickness = max(z_max - z_min, 0.1)
    shift = -z_min + tol
    new_cart = cart + shift * c_unit
    a, b = structure.lattice.matrix[0], structure.lattice.matrix[1]
    return S(Lattice([a, b, c_unit * (thickness + 2*tol)]),
             structure.species, new_cart, coords_are_cartesian=True)


def stack_slabs(substrate, film, gap=2.0, vacuum=20.0):
    from pymatgen.core import Lattice, Structure as S
    sub_cart = substrate.cart_coords.copy()
    film_frac = film.frac_coords.copy()
    strained = Lattice([substrate.lattice.matrix[0],
                        substrate.lattice.matrix[1],
                        film.lattice.matrix[2]])
    film_cart = strained.get_cartesian_coords(film_frac)
    c_unit = substrate.lattice.matrix[2]
    c_unit = c_unit / np.linalg.norm(c_unit)
    sub_top = float((sub_cart @ c_unit).max())
    film_bot = float((film_cart @ c_unit).min())
    film_cart += (sub_top + gap - film_bot) * c_unit
    total_top = float((film_cart @ c_unit).max())
    lat = Lattice([substrate.lattice.matrix[0],
                   substrate.lattice.matrix[1],
                   c_unit * (total_top + vacuum)])
    return S(lat, list(substrate.species) + list(film.species),
             np.vstack([sub_cart, film_cart]), coords_are_cartesian=True), len(substrate)


def _vec3(v2):
    """Pad 2D vector to 3D (z=0) to avoid numba cross product bug."""
    return [float(v2[0]), float(v2[1]), 0.0]


def zsl_search(substrate, film, max_area=400):
    from pymatgen.analysis.interfaces.zsl import ZSLGenerator
    sub_s, film_s = strip_vacuum(substrate), strip_vacuum(film)
    # Use 3D vectors (z=0) — numba's np.cross fails on 2D arrays
    sub_v = [_vec3(sub_s.lattice.matrix[0]), _vec3(sub_s.lattice.matrix[1])]
    film_v = [_vec3(film_s.lattice.matrix[0]), _vec3(film_s.lattice.matrix[1])]
    gen = ZSLGenerator(max_area_ratio_tol=0.09, max_length_tol=0.03, max_angle_tol=0.01)
    return list(gen(film_v, sub_v, lowest=True)), sub_s, film_s


def build_from_match(sub_s, film_s, match, gap, vacuum):
    sub_T = np.eye(3, dtype=int)
    sub_T[:2, :2] = np.array(match.substrate_transformation, dtype=int)
    film_T = np.eye(3, dtype=int)
    film_T[:2, :2] = np.array(match.film_transformation, dtype=int)
    return stack_slabs(sub_s * sub_T, film_s * film_T, gap, vacuum)


def get_2d_sym_ops(slab, symprec=0.1):
    from pymatgen.symmetry.analyzer import SpacegroupAnalyzer
    try:
        ops = SpacegroupAnalyzer(slab, symprec=symprec).get_symmetry_operations()
    except Exception:
        return [(np.eye(2), np.zeros(2))]
    out = []
    for op in ops:
        r, t = op.rotation_matrix, op.translation_vector
        if (abs(r[2,0])<1e-4 and abs(r[2,1])<1e-4 and abs(r[0,2])<1e-4 and
            abs(r[1,2])<1e-4 and abs(abs(r[2,2])-1)<1e-4 and abs(t[2])<1e-4):
            out.append((r[:2,:2].copy(), t[:2].copy()))
    return out or [(np.eye(2), np.zeros(2))]


def irreducible_zone_extent(sym_ops):
    N = 120
    seen = set()
    for i in range(N):
        for j in range(N):
            pt = np.array([i/N, j/N])
            canon = (i, j)
            for rot, trans in sym_ops:
                tr = rot @ pt + trans
                ix = round((tr[0] % 1.0) * N) % N
                iy = round((tr[1] % 1.0) * N) % N
                if (ix, iy) < canon:
                    canon = (ix, iy)
            seen.add(canon)
    fx = min(max(c[0] for c in seen) / N + 0.5/N, 1.0)
    fy = min(max(c[1] for c in seen) / N + 0.5/N, 1.0)
    return fx, fy


def grid_scan(hetero, n_sub, sym_ops, nx, ny):
    from pymatgen.core import Structure as S
    fx_max, fy_max = irreducible_zone_extent(sym_ops)
    a_vec, b_vec = hetero.lattice.matrix[0], hetero.lattice.matrix[1]
    entries = []
    for i in range(nx):
        for j in range(ny):
            fx = (i / nx) * fx_max
            fy = (j / ny) * fy_max
            sc = fx * a_vec + fy * b_vec
            cart = hetero.cart_coords.copy()
            cart[n_sub:, 0] += sc[0]
            cart[n_sub:, 1] += sc[1]
            entries.append({
                "fx": fx, "fy": fy,
                "dx": float(sc[0]), "dy": float(sc[1]),
                "structure": S(hetero.lattice, hetero.species, cart, coords_are_cartesian=True),
            })
    step_a = fx_max * np.linalg.norm(a_vec) / nx
    step_b = fy_max * np.linalg.norm(b_vec) / ny
    return entries, (fx_max, fy_max), (step_a, step_b)


def to_ase(pmg):
    from ase import Atoms
    return Atoms(
        symbols=[str(s.specie.symbol) for s in pmg],
        positions=pmg.cart_coords,
        cell=pmg.lattice.matrix,
        pbc=True,
    )


def write_extxyz(entries, path):
    lines = []
    for e in entries:
        s = e["structure"]
        lat = s.lattice.matrix
        lat_str = " ".join(f"{x:.6f}" for row in lat for x in row)
        lines.append(str(len(s)))
        lines.append(f'Lattice="{lat_str}" Properties=species:S:1:pos:R:3 pbc="T T T" '
                     f'shift_fx={e["fx"]:.4f} shift_fy={e["fy"]:.4f}')
        for site in s:
            x, y, z = site.coords
            lines.append(f"{site.specie.symbol}  {x:.6f}  {y:.6f}  {z:.6f}")
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


# ===================== 交互 =====================

def prompt(msg, default=None):
    hint = f" [{default}]" if default is not None else ""
    val = input(f"  {msg}{hint}: ").strip()
    if not val and default is not None:
        return default
    return val


def prompt_float(msg, default):
    return float(prompt(msg, str(default)))


def prompt_int(msg, default):
    return int(prompt(msg, str(default)))


def prompt_path(msg):
    while True:
        p = input(f"  {msg}: ").strip().strip('"').strip("'")
        if not p:
            continue
        path = Path(p).expanduser().resolve()
        if path.exists():
            return path
        print(f"    File not found: {path}")


def ase_view(atoms, block=True):
    """Show structure. Returns True if user confirms."""
    try:
        from ase.visualize import view
        view(atoms)
        return True
    except Exception as e:
        print(f"    ASE viewer failed: {e}")
        print(f"    Tip: pip install ase[gui]")
        return True


# ===================== 主流程 =====================

def main():
    print()
    print("=" * 55)
    print("  Heterostructure Grid Scan")
    print("  异质结对称性约化网格穷举")
    print("=" * 55)

    # ---- Step 1: 构建异质结 ----
    print()
    print("─── Step 1: Build Heterostructure ───")
    print()

    sub_path = prompt_path("Substrate file (衬底)")
    film_path = prompt_path("Film file (薄膜)")

    print()
    print(f"  Loading...")
    substrate = load_structure(sub_path)
    film_raw = load_structure(film_path)
    print(f"  Substrate: {substrate.composition.reduced_formula} ({len(substrate)} atoms)")
    print(f"  Film:      {film_raw.composition.reduced_formula} ({len(film_raw)} atoms)")

    # Lattice mismatch
    da = (film_raw.lattice.a - substrate.lattice.a) / substrate.lattice.a * 100
    db = (film_raw.lattice.b - substrate.lattice.b) / substrate.lattice.b * 100
    print(f"  Mismatch:  Δa={da:+.2f}%  Δb={db:+.2f}%")
    print()

    gap = prompt_float("Gap (Å)", 2.0)
    vacuum = prompt_float("Vacuum (Å)", 20.0)
    max_area = prompt_float("Max match area (Å²)", 400)

    while True:
        print()
        print("  ZSL matching...")
        matches, sub_s, film_s = zsl_search(substrate, film_raw, max_area)

        if not matches:
            print("  No matches found!")
            max_area = prompt_float("Try larger max area", max_area * 2)
            continue

        # Show top matches
        print(f"  Found {len(matches)} match(es). Top 5:")
        print(f"  {'#':>3}  {'Area':>8}  {'Sub T':>12}  {'Film T':>12}")
        for i, m in enumerate(matches[:5]):
            st = str(m.substrate_transformation).replace('\n', '')
            ft = str(m.film_transformation).replace('\n', '')
            print(f"  {i:>3}  {m.match_area:>8.1f}  {st:>12}  {ft:>12}")

        idx = prompt_int("Select match #", 0)
        if idx >= len(matches):
            idx = 0

        print(f"  Building heterostructure (match #{idx})...")
        hetero, n_sub = build_from_match(sub_s, film_s, matches[idx], gap, vacuum)
        n_film = len(hetero) - n_sub
        print(f"  Result: {len(hetero)} atoms ({n_sub} sub + {n_film} film)")

        # Visualize
        print()
        ans = prompt("View in ASE? (y/n)", "y")
        if ans.lower() == "y":
            print("  Opening ASE viewer... (close window to continue)")
            ase_view(to_ase(hetero))

        print()
        ans = prompt("Accept this heterostructure? (y=continue / n=redo / q=quit)", "y")
        if ans.lower() == "q":
            print("  Bye!")
            return
        if ans.lower() == "y":
            break
        # else: loop back and redo

    # ---- Step 2: Grid Scan ----
    print()
    print("─── Step 2: Grid Scan ───")
    print()

    symprec = prompt_float("Symmetry tolerance (Å)", 0.1)
    print(f"  Analyzing film 2D symmetry...")
    film_stripped = strip_vacuum(film_raw)
    sym_ops = get_2d_sym_ops(film_stripped, symprec)
    fx_max, fy_max = irreducible_zone_extent(sym_ops)
    a_len = np.linalg.norm(hetero.lattice.matrix[0])
    b_len = np.linalg.norm(hetero.lattice.matrix[1])
    print(f"  2D symmetry ops: {len(sym_ops)}")
    print(f"  Irreducible zone: {fx_max:.1%} × {fy_max:.1%} of unit cell")
    print(f"  Zone size: {fx_max*a_len:.2f} × {fy_max*b_len:.2f} Å")
    print()

    nx = prompt_int("Grid Nx", 6)
    ny = prompt_int("Grid Ny", 6)
    step_a = fx_max * a_len / nx
    step_b = fy_max * b_len / ny
    print(f"  → {nx}×{ny} = {nx*ny} structures, step ≈ {step_a:.3f} × {step_b:.3f} Å")
    print()

    print("  Generating...")
    entries, zone_ext, step_size = grid_scan(hetero, n_sub, sym_ops, nx, ny)
    print(f"  Done. {len(entries)} structures generated.")

    # Preview
    print()
    ans = prompt("Browse all in ASE viewer? (y/n)", "y")
    if ans.lower() == "y":
        print("  Opening ASE viewer... (close window to continue)")
        atoms_list = [to_ase(e["structure"]) for e in entries]
        ase_view(atoms_list)

    # Export
    print()
    default_out = f"grid_scan_{nx}x{ny}.extxyz"
    out_path = prompt(f"Output file", default_out)
    write_extxyz(entries, out_path)
    size_kb = Path(out_path).stat().st_size / 1024
    print(f"  Saved: {out_path} ({size_kb:.1f} KB, {len(entries)} frames)")

    # Summary
    print()
    print("=" * 55)
    print(f"  Substrate:    {substrate.composition.reduced_formula}")
    print(f"  Film:         {film_raw.composition.reduced_formula}")
    print(f"  Atoms:        {len(hetero)} ({n_sub} + {n_film})")
    print(f"  Sym ops:      {len(sym_ops)}")
    print(f"  Zone:         {fx_max:.1%} × {fy_max:.1%}")
    print(f"  Grid:         {nx}×{ny} = {len(entries)} points")
    print(f"  Step:         {step_a:.3f} × {step_b:.3f} Å")
    print(f"  Output:       {out_path}")
    print("=" * 55)
    print()


if __name__ == "__main__":
    main()
