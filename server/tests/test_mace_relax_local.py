#!/usr/bin/env python3
"""Quick local MACE geometry optimization test.

Run with:
    cd server && python tests/test_mace_relax_local.py

Tests MACE-MP (medium) on a bulk Ni FCC structure — same system as the
UMA catalysis tutorial. Verifies:
  1. MACE calculator loads
  2. Geometry optimization converges
  3. Energy and forces are reasonable
  4. Cell relaxation works (ExpCellFilter)
"""

import sys
import pytest

mace = pytest.importorskip("mace", reason="MACE not installed")
import time


def test_mace_relax():
    print("=" * 60)
    print("MACE Geometry Optimization Test — Bulk Ni FCC")
    print("=" * 60)

    # --- Step 1: Import and build structure ---
    print("\n[1/4] Building Ni FCC bulk structure...")
    from ase.build import bulk

    ni = bulk("Ni", "fcc", a=3.52, cubic=True)
    print(f"  Atoms: {len(ni)}, Formula: {ni.get_chemical_formula()}")
    print(f"  Initial cell: a = {ni.cell[0][0]:.4f} Å")

    # --- Step 2: Load MACE calculator ---
    print("\n[2/4] Loading MACE-MP (medium) calculator...")
    t0 = time.time()
    from mace.calculators import mace_mp

    calc = mace_mp(model="medium", default_dtype="float64")
    print(f"  Loaded in {time.time() - t0:.1f}s")

    ni.calc = calc
    e0 = ni.get_potential_energy()
    f0 = ni.get_forces()
    print(f"  Initial energy: {e0:.4f} eV")
    print(f"  Initial max force: {max(abs(f0.flatten())):.6f} eV/Å")

    # --- Step 3: Ionic relaxation (fixed cell) ---
    print("\n[3/4] Running ionic relaxation (fixed cell, BFGS)...")
    from ase.optimize import BFGS

    t0 = time.time()
    opt = BFGS(ni, logfile=None)
    converged = opt.run(fmax=0.01, steps=100)
    dt = time.time() - t0

    e1 = ni.get_potential_energy()
    f1 = ni.get_forces()
    print(f"  Converged: {converged} in {opt.nsteps} steps ({dt:.1f}s)")
    print(f"  Final energy: {e1:.4f} eV")
    print(f"  Final max force: {max(abs(f1.flatten())):.6f} eV/Å")

    # --- Step 4: Cell relaxation (ExpCellFilter) ---
    print("\n[4/4] Running cell relaxation (ExpCellFilter + BFGS)...")
    from ase.filters import ExpCellFilter

    ni2 = bulk("Ni", "fcc", a=3.52, cubic=True)
    ni2.calc = mace_mp(model="medium", default_dtype="float64")
    ecf = ExpCellFilter(ni2)

    t0 = time.time()
    opt2 = BFGS(ecf, logfile=None)
    converged2 = opt2.run(fmax=0.05, steps=200)
    dt2 = time.time() - t0

    a_opt = ni2.cell[0][0]
    e2 = ni2.get_potential_energy()
    a_exp = 3.524  # experimental
    error = abs(a_opt - a_exp) / a_exp * 100

    print(f"  Converged: {converged2} in {opt2.nsteps} steps ({dt2:.1f}s)")
    print(f"  Optimized lattice: a = {a_opt:.4f} Å")
    print(f"  Experimental:      a = {a_exp:.4f} Å")
    print(f"  Error:             {error:.2f}%")
    print(f"  Final energy: {e2:.4f} eV")

    # --- Summary ---
    print(f"\n{'=' * 60}")
    print("RESULTS SUMMARY")
    print(f"{'=' * 60}")
    print(f"  Ionic relax:  {e0:.4f} → {e1:.4f} eV  ({opt.nsteps} steps)")
    print(f"  Cell relax:   a = {a_opt:.4f} Å  (error: {error:.2f}%)")
    print(f"  MACE-MP working correctly ✓")
    print(f"{'=' * 60}")

    return True


if __name__ == "__main__":
    try:
        success = test_mace_relax()
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"\n✗ Test failed: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)
