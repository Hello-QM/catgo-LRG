#!/usr/bin/env python3
"""Build VASP frequency-calc inputs from a relaxed structure (CONTCAR/POSCAR).

Bundled with the catgo-gibbs-pipeline skill so every Gibbs study doesn't re-derive
the freq setup. Writes POSCAR (selective dynamics) + INCAR (IBRION=5 finite-diff) +
KPOINTS into an output dir.

Adsorbate freq  : fix all surface atoms, free ONLY the adsorbate atoms (harmonic
                  adsorbate modes; surface phonons cancel in ΔG). Pass --free-elements
                  or --free-indices to say which atoms vibrate.
Gas-molecule freq: all atoms free (pass --gas).

Examples
--------
# *OH on a metal slab: free the O and H, fix the metal, k = parent mesh
python build_freq_inputs.py --structure CONTCAR --out ../04-freq/OH_freq \
    --free-elements O,H --kpoints "4 4 1" --ismear 1 --sigma 0.2

# H2O gas reference: all atoms free, Γ-only
python build_freq_inputs.py --structure CONTCAR --out ../04-freq/H2O_freq \
    --gas --kpoints "1 1 1" --ismear 0 --sigma 0.05
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _freq_incar(name: str, *, gas: bool, encut: float, ispin: int,
                ismear: int, sigma: float) -> str:
    # NO NCORE / NPAR for freq: IBRION=5 finite differences are most robust with
    # no band parallelization (VASP defaults NCORE=1). Setting NCORE>1 can corrupt
    # the Hessian on some builds. Keep freq small + Γ-only on a shared node instead.
    lreal = ".FALSE." if gas else "Auto"
    return (
        f"SYSTEM = {name}\n"
        "ISTART = 0\nICHARG = 2\n"
        f"ENCUT = {encut:g}\nPREC = Accurate\nEDIFF = 1E-6\nNELM = 120\nALGO = Fast\n"
        f"LREAL = {lreal}\nISMEAR = {ismear}\nSIGMA = {sigma:g}\nISPIN = {ispin}\n"
        "IBRION = 5\nNFREE = 2\nPOTIM = 0.015\nNSW = 1\n"
        "LWAVE = .FALSE.\nLCHARG = .FALSE.\n"
    )


def _kpoints(mesh: str) -> str:
    a, b, c = mesh.split()
    return f"Gamma mesh\n0\nGamma\n{a} {b} {c}\n0 0 0\n"


def build(structure, out_dir, *, gas=False, free_elements=None, free_indices=None,
          kpoints="1 1 1", encut=450.0, ispin=2, ismear=0, sigma=0.05):
    from ase.io import read, write
    from ase.constraints import FixAtoms

    atoms = read(str(structure), format="vasp")
    if not gas:
        # free only the named adsorbate atoms; fix everything else
        free = set()
        if free_indices:
            free |= {int(i) for i in free_indices}
        if free_elements:
            els = {e.strip() for e in free_elements}
            free |= {i for i, a in enumerate(atoms) if a.symbol in els}
        if not free:
            raise SystemExit("adsorbate freq needs --free-elements or --free-indices "
                             "(which atoms vibrate); or pass --gas for an all-free molecule")
        fixed = [i for i in range(len(atoms)) if i not in free]
        atoms.set_constraint(FixAtoms(indices=fixed))
    else:
        atoms.set_constraint()  # clear: all atoms free

    out = Path(out_dir).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    write(str(out / "POSCAR"), atoms, format="vasp", vasp5=True, direct=True, sort=True)
    (out / "INCAR").write_text(_freq_incar(out.name, gas=gas, encut=encut, ispin=ispin,
                                           ismear=ismear, sigma=sigma))
    (out / "KPOINTS").write_text(_kpoints(kpoints))
    nfree = "all" if gas else len(free)
    return {"out": str(out), "n_atoms": len(atoms), "n_free": nfree}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="build VASP freq inputs from a relaxed structure")
    ap.add_argument("--structure", required=True, help="relaxed CONTCAR/POSCAR")
    ap.add_argument("--out", required=True, help="output dir for the freq calc")
    ap.add_argument("--gas", action="store_true", help="molecule: free all atoms")
    ap.add_argument("--free-elements", default="", help="adsorbate elements to free, e.g. O,H")
    ap.add_argument("--free-indices", default="", help="adsorbate atom indices to free, e.g. 36,37")
    ap.add_argument("--kpoints", default="1 1 1", help='Gamma mesh, e.g. "4 4 1"')
    ap.add_argument("--encut", type=float, default=450.0)
    ap.add_argument("--ispin", type=int, default=2)
    ap.add_argument("--ismear", type=int, default=0)
    ap.add_argument("--sigma", type=float, default=0.05)
    a = ap.parse_args(argv)
    fe = [x for x in a.free_elements.split(",") if x] or None
    fi = [x for x in a.free_indices.split(",") if x] or None
    info = build(a.structure, a.out, gas=a.gas, free_elements=fe, free_indices=fi,
                 kpoints=a.kpoints, encut=a.encut, ispin=a.ispin, ismear=a.ismear,
                 sigma=a.sigma)
    print(f"freq inputs -> {info['out']} ({info['n_atoms']} atoms, {info['n_free']} free)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
