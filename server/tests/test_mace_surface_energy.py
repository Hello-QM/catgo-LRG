#!/usr/bin/env python3
"""MACE surface energy calculation — UMA Catalysis Tutorial Part 2.

Replicates the surface energy workflow from the UMA tutorial:
  1. Optimize bulk Ni FCC (cell relaxation)
  2. Generate slabs at 3 thicknesses for 4 facets
  3. Relax each slab with MACE
  4. Linear extrapolation → surface energy per facet
  5. Compare with DFT literature values

Run with:
    cd server && python tests/test_mace_surface_energy.py

Expected runtime: ~2-5 minutes (12 slab relaxations).
"""

import sys
import time


def test_surface_energy():
    print("=" * 70)
    print("MACE Surface Energy Calculation — Ni(111), (100), (110), (211)")
    print("=" * 70)

    # --- Step 1: Bulk optimization ---
    print("\n[Step 1] Optimizing bulk Ni FCC...")
    from ase.build import bulk
    from ase.filters import ExpCellFilter
    from ase.optimize import LBFGS

    ni_bulk = bulk("Ni", "fcc", a=3.52, cubic=True)

    from mace.calculators import mace_mp
    calc = mace_mp(model="medium", default_dtype="float64")
    ni_bulk.calc = calc

    ecf = ExpCellFilter(ni_bulk)
    opt = LBFGS(ecf, logfile=None)
    opt.run(fmax=0.05, steps=200)

    a_opt = ni_bulk.cell[0][0]
    E_bulk_total = ni_bulk.get_potential_energy()
    N_bulk = len(ni_bulk)
    E_bulk_per_atom = E_bulk_total / N_bulk

    print(f"  Optimized lattice: a = {a_opt:.4f} Å")
    print(f"  Bulk energy/atom:  {E_bulk_per_atom:.6f} eV")

    # --- Step 2-4: Surface energy for each facet ---
    import numpy as np
    from pymatgen.core import Structure
    from pymatgen.core.surface import SlabGenerator
    from pymatgen.io.ase import AseAtomsAdaptor

    adaptor = AseAtomsAdaptor()
    ni_structure = adaptor.get_structure(ni_bulk)

    facets = [(1, 1, 1), (1, 0, 0), (1, 1, 0), (2, 1, 1)]
    thicknesses = [4, 6, 8]  # layers
    surface_energies_SI = {}
    all_fit_data = {}

    t_total = time.time()

    for facet in facets:
        facet_str = "".join(map(str, facet))
        print(f"\n{'=' * 60}")
        print(f"[Step 2-4] Ni({facet_str}) surface energy")
        print(f"{'=' * 60}")

        n_atoms_list = []
        energies_list = []
        last_slab = None

        for n_layers in thicknesses:
            print(f"\n  Thickness: {n_layers} layers")

            # Generate slab
            slabgen = SlabGenerator(
                ni_structure,
                facet,
                min_slab_size=n_layers * a_opt / np.sqrt(sum(h**2 for h in facet)),
                min_vacuum_size=10.0,
                center_slab=True,
            )
            pmg_slab = slabgen.get_slabs()[0]
            slab = adaptor.get_atoms(pmg_slab)
            slab.center(vacuum=10.0, axis=2)

            print(f"    Atoms: {len(slab)}")

            # Relax with MACE
            slab.calc = mace_mp(model="medium", default_dtype="float64")
            opt = LBFGS(slab, logfile=None)
            t0 = time.time()
            opt.run(fmax=0.05, steps=300)
            dt = time.time() - t0

            E_slab = slab.get_potential_energy()
            n_atoms_list.append(len(slab))
            energies_list.append(E_slab)
            last_slab = slab
            print(f"    Energy: {E_slab:.2f} eV ({opt.nsteps} steps, {dt:.1f}s)")

        # Linear fit: E_slab = slope * N + intercept
        coeffs = np.polyfit(n_atoms_list, energies_list, 1)
        slope = coeffs[0]
        intercept = coeffs[1]

        # Surface energy from intercept
        cell = last_slab.get_cell()
        area = np.linalg.norm(np.cross(cell[0], cell[1]))
        gamma = intercept / (2 * area)  # eV/Å²
        gamma_SI = gamma * 16.0218  # J/m²

        print(f"\n  Linear fit:")
        print(f"    Slope:     {slope:.6f} eV/atom (cf. bulk {E_bulk_per_atom:.6f})")
        print(f"    Intercept: {intercept:.2f} eV")
        print(f"    Area:      {area:.2f} Å²")
        print(f"\n  Surface energy:")
        print(f"    γ = {gamma:.6f} eV/Å² = {gamma_SI:.2f} J/m²")

        surface_energies_SI[facet] = gamma_SI
        all_fit_data[facet] = {
            "n_atoms": n_atoms_list,
            "energies": energies_list,
            "slope": slope,
            "intercept": intercept,
        }

    total_time = time.time() - t_total

    # --- Step 5: Comparison with literature ---
    print(f"\n{'=' * 70}")
    print("COMPARISON WITH DFT LITERATURE (Tran et al., 2016)")
    print(f"{'=' * 70}")

    lit_values = {
        (1, 1, 1): 1.92,
        (1, 0, 0): 2.21,
        (1, 1, 0): 2.29,
        (2, 1, 1): 2.24,
    }

    print(f"{'Facet':<12} {'MACE':>10} {'DFT Lit':>10} {'Error':>8}")
    print(f"{'-'*12} {'-'*10} {'-'*10} {'-'*8}")

    for facet in facets:
        facet_str = f"Ni({facet[0]}{facet[1]}{facet[2]})"
        mace_val = surface_energies_SI[facet]
        lit_val = lit_values[facet]
        diff = abs(mace_val - lit_val) / lit_val * 100
        print(f"{facet_str:<12} {mace_val:>8.2f} J/m² {lit_val:>6.2f} J/m² {diff:>6.1f}%")

    # Check ordering
    ordered_facets = sorted(surface_energies_SI.keys(), key=lambda f: surface_energies_SI[f])
    print(f"\nEnergy ordering: {' < '.join(f'({f[0]}{f[1]}{f[2]})' for f in ordered_facets)}")
    print(f"Expected:        (111) < (100) < (110) ≈ (211)")

    lowest = ordered_facets[0]
    print(f"\nMost stable facet: ({lowest[0]}{lowest[1]}{lowest[2]})")
    print(f"Expected:          (111)")
    print(f"Match: {'YES' if lowest == (1,1,1) else 'NO'}")

    print(f"\nTotal time: {total_time:.0f}s")
    print(f"{'=' * 70}")

    return True


if __name__ == "__main__":
    try:
        success = test_surface_energy()
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"\n✗ Test failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
