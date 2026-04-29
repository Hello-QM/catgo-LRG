#!/usr/bin/env python
"""Test EOS fitting and surface energy analysis using MACE.

Runs two mini-workflows:
  1. EOS: Ni bulk at 7 volumes → Birch-Murnaghan fit → V0, B0, a0
  2. Surface energy: Ni(111) slabs at 3 thicknesses → linear extrapolation → γ

Uses MACE-MP-0 (small) as the ML potential calculator.
"""

import sys
import json
import numpy as np
from pathlib import Path

# ── Setup ──────────────────────────────────────────────────────────────────

print("Loading MACE-MP-0 (small)...")
from mace.calculators import mace_mp
calc_fn = lambda: mace_mp(model="small", default_dtype="float64")
print("  OK\n")

from ase.build import bulk, fcc111
from ase.optimize import LBFGS
from ase.filters import ExpCellFilter
from pymatgen.io.ase import AseAtomsAdaptor
from pymatgen.core.surface import SlabGenerator

adaptor = AseAtomsAdaptor()

# ══════════════════════════════════════════════════════════════════════════
# Part 1: EOS Fitting
# ══════════════════════════════════════════════════════════════════════════

print("=" * 60)
print("Part 1: EOS Fitting for Ni (FCC)")
print("=" * 60)

# Step 1a: Relax the bulk to get equilibrium structure
ni_bulk = bulk("Ni", "fcc", a=3.52, cubic=True)
ni_bulk.calc = calc_fn()
ecf = ExpCellFilter(ni_bulk)
opt = LBFGS(ecf, logfile=None)
opt.run(fmax=0.05, steps=200)
a_opt = ni_bulk.cell[0, 0]
print(f"  Relaxed lattice constant: {a_opt:.4f} A")

# Step 1b: Generate 7 strained volumes around equilibrium
scales = np.linspace(0.96, 1.04, 7)
eos_parent_results = {}

print(f"  Running {len(scales)} single-point calculations...")
for i, scale in enumerate(scales):
    atoms = bulk("Ni", "fcc", a=a_opt * scale, cubic=True)
    atoms.calc = calc_fn()
    # Just get energy at this volume (no relaxation — fixed cell)
    energy = atoms.get_potential_energy()
    volume = atoms.get_volume()
    n_atoms = len(atoms)

    step_id = f"eos_step_{i}"
    eos_parent_results[step_id] = {
        "final_energy": energy,
        "summary": {
            "energy": energy,
            "volume": volume,
            "n_atoms": n_atoms,
        },
    }
    print(f"    scale={scale:.3f}  V={volume:.2f} A^3  E={energy:.4f} eV")

# Step 1c: Call the analysis function
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
from workflow.engines.analysis import _analyze_eos

eos_result = _analyze_eos(
    parent_ids=list(eos_parent_results.keys()),
    step_results=eos_parent_results,
    params={"eos_type": "birch_murnaghan"},
)

print(f"\n  EOS Result:")
print(f"    Status:           {eos_result['status']}")
print(f"    V0:               {eos_result['v0']:.2f} A^3")
print(f"    E0:               {eos_result['e0']:.4f} eV")
print(f"    B0:               {eos_result['B0_GPa']:.1f} GPa")
print(f"    EOS model:        {eos_result['eos_model']}")
if "lattice_constant_A" in eos_result:
    print(f"    Lattice constant: {eos_result['lattice_constant_A']:.4f} A")
    print(f"    Cell type:        {eos_result['cell_type']}")
print(f"    Points used:      {eos_result['n_points']}")
print(f"\n  Reference: Ni experimental a=3.524 A, B0=186 GPa")


# ══════════════════════════════════════════════════════════════════════════
# Part 2: Surface Energy via Linear Extrapolation
# ══════════════════════════════════════════════════════════════════════════

print(f"\n{'=' * 60}")
print("Part 2: Surface Energy for Ni(111)")
print("=" * 60)

# Convert relaxed bulk to pymatgen for slab generation
ni_structure = adaptor.get_structure(ni_bulk)

thicknesses = [4, 6, 8]  # number of layers
surf_parent_results = {}

for i, n_layers in enumerate(thicknesses):
    print(f"\n  Slab with {n_layers} layers:")

    slabgen = SlabGenerator(
        ni_structure,
        (1, 1, 1),
        min_slab_size=n_layers * a_opt / np.sqrt(3),
        min_vacuum_size=10.0,
        center_slab=True,
    )
    pmg_slab = slabgen.get_slabs()[0]
    slab = adaptor.get_atoms(pmg_slab)
    slab.center(vacuum=10.0, axis=2)

    print(f"    Atoms: {len(slab)}")

    # Relax slab
    slab.calc = calc_fn()
    opt = LBFGS(slab, logfile=None)
    opt.run(fmax=0.05, steps=200)

    energy = slab.get_potential_energy()
    n_atoms = len(slab)

    # Compute surface area for verification
    cell = slab.get_cell()
    area = np.linalg.norm(np.cross(cell[0], cell[1]))
    print(f"    Energy: {energy:.4f} eV")
    print(f"    Area:   {area:.2f} A^2")

    # Store as pymatgen dict (like the workflow would)
    pmg_relaxed = adaptor.get_structure(slab)
    step_id = f"slab_step_{i}"
    surf_parent_results[step_id] = {
        "final_energy": energy,
        "structure_json": pmg_relaxed.as_dict(),
        "summary": {
            "energy": energy,
            "n_atoms": n_atoms,
        },
    }

# Call the analysis function
from workflow.engines.analysis import _analyze_surface_energy

surf_result = _analyze_surface_energy(
    parent_ids=list(surf_parent_results.keys()),
    step_results=surf_parent_results,
    params={},
)

print(f"\n  Surface Energy Result:")
print(f"    Status:         {surf_result['status']}")
print(f"    gamma:          {surf_result['gamma_eV_per_A2']:.6f} eV/A^2")
print(f"    gamma:          {surf_result['gamma_J_per_m2']:.2f} J/m^2")
print(f"    R^2:            {surf_result['r_squared']:.6f}")
print(f"    Slope (E/atom): {surf_result['slope_eV_per_atom']:.6f} eV/atom")
print(f"    Intercept:      {surf_result['intercept_eV']:.4f} eV")
print(f"    Area:           {surf_result['surface_area_A2']:.2f} A^2")
print(f"    Points used:    {surf_result['n_points']}")
print(f"\n  Reference: Ni(111) DFT = 1.92 J/m^2 (Tran et al. 2016)")

# ── Summary ────────────────────────────────────────────────────────────────

print(f"\n{'=' * 60}")
print("Summary")
print("=" * 60)
print(f"  EOS:            {'PASS' if eos_result['status'] == 'completed' else 'FAIL'}")
print(f"  Surface Energy: {'PASS' if surf_result['status'] == 'completed' else 'FAIL'}")
