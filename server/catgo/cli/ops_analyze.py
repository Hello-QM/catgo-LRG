"""analyze-group handlers: dos / band / cohp / freq. (session, params)->OpResult.

Offline import-mode; mutates=False; structure unchanged.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from catgo.cli.adapter import OpError
from catgo.cli.registry import OpResult


def _dump(path, obj) -> None:
    Path(path).write_text(json.dumps(obj, indent=2))


def freq(session, params: dict) -> OpResult:
    from catgo.cli.vib import parse_outcar_freqs, write_mode_animation
    from catgo.utils.gibbs_calculator import calc_adsorbed, calc_gas

    src = params.get("input")
    if not src:
        raise OpError("freq requires an OUTCAR path")
    data = parse_outcar_freqs(src)

    mode = params.get("mode", "adsorbed")
    T = float(params.get("T", 298.15))
    cutoff = float(params.get("freq_cutoff", 50.0))
    if data.num_imaginary:
        print(f"warning: {data.num_imaginary} imaginary mode(s) excluded "
              f"from Gibbs correction", file=sys.stderr)
    if mode == "adsorbed":
        g = calc_adsorbed(data.real_freqs_cm, data.imag_freqs_cm, T, cutoff)
    elif mode == "gas":
        g = calc_gas(data.real_freqs_cm, data.imag_freqs_cm, data.positions,
                     data.masses_amu, data.atom_types, T,
                     float(params.get("P", 1.0)) * 1e5,
                     int(params.get("unpaired", 0)))
    else:
        raise OpError(f"--mode must be adsorbed|gas, got '{mode}'")

    artifact = None
    anim_note = ""
    if not params.get("no_anim"):
        if data.num_imaginary == 0:
            anim_note = "  (0 imaginary - not a TS; no animation)"
        else:
            out = params.get("out")
            if not out:
                raise OpError("-o/--out required to write the TS animation "
                              "(or pass --no-anim)")
            syms = params.get("symbols")
            if not syms:
                raise OpError("--symbols (comma-separated, one per atom) "
                              "required for the animation")
            symbols = [s.strip() for s in str(syms).split(",")]
            mi = int(params.get("mode_index", -1))
            if mi >= 0:
                idx = mi
            elif data.imag_mode_indices:
                idx = data.imag_mode_indices[0]   # first imaginary mode
            else:
                raise OpError(
                    "no imaginary modes; pass --mode-index for a real mode")
            write_mode_animation(
                data, mode_index=idx, out=Path(out),
                frames=int(params.get("frames", 20)),
                amplitude=float(params.get("amplitude", 0.5)),
                symbols=symbols)
            artifact = Path(out)

    if params.get("dump"):
        _dump(params["dump"], g)

    msg = (f"G_corr={g['g_corr_ev']:.4f} eV  ZPE={g['zpe_ev']:.4f}  "
           f"H_corr={g['h_corr_ev']:.4f}  TS={g['ts_vib_ev']:.4f}  "
           f"imaginary={data.num_imaginary}{anim_note}")
    return OpResult(ok=True, message=msg, artifact=artifact, structure=None)


def dos(session, params: dict) -> OpResult:
    from catgo.cli._extpath import ensure_extension
    from catgo.cli.plotting import PlotSpec, render

    src = params.get("input")
    if not src or not str(src).lower().endswith((".h5", ".hdf5")):
        raise OpError("dos expects a vaspout.h5 file (.h5)")
    if not Path(src).exists():
        raise OpError(f"vaspout.h5 not found: {src}")
    ensure_extension("dos-analysis", "catgo_dos")
    from catgo_dos.io import read_vaspout_h5
    from catgo_dos.pdos import compute_pdos
    try:
        vdata = read_vaspout_h5(str(src))
    except Exception as exc:  # noqa: BLE001
        raise OpError(f"failed to parse vaspout.h5: {exc}") from exc

    atoms_p = params.get("atoms", "all")
    if atoms_p in ("all", None):
        atoms = list(range(vdata.nions))
    else:
        try:
            atoms = [int(x) for x in str(atoms_p).split(",")]
        except ValueError as exc:
            raise OpError(
                f"--atoms must be comma-separated integers or 'all', "
                f"got '{atoms_p}'") from exc

    channels = params.get("channels", "spd")
    res = compute_pdos(vdata, atoms, channels)

    from catgo_dos.dband import compute_d_center
    try:
        dband = compute_d_center(vdata, atoms)
        dband_val = float(getattr(dband, "eps_rel",
                                   getattr(dband, "center", dband)))
    except (TypeError, ValueError, IndexError, AttributeError) as exc:
        # Narrow catch: catgo_dos returns NaN-DBandCenter for non-d
        # systems natively (no exception). This fires only on real
        # errors (bad atoms, shape skew, version drift) — surface them.
        import sys as _sys
        print(f"warning: d-band fallback ({exc.__class__.__name__}: {exc})",
              file=_sys.stderr)
        dband_val = float("nan")

    energy = list(res.grid)
    total = list(res.pdos.sum(axis=0))   # collapse spins -> (ngrid,)
    spec = PlotSpec(
        kind="dos", x=energy,
        series=[("PDOS", total, {})],
        xlabel="E - E_f (eV)", ylabel="DOS (states/eV)",
        vlines=[0.0])
    out = Path(params["out"]) if params.get("out") else Path("dos.pdf")
    render(spec, out, bool(params.get("edit")), bool(params.get("latex")))
    if params.get("dump"):
        _dump(params["dump"], {"energy": energy, "pdos": total,
                               "d_band_center_eV": dband_val})
    return OpResult(ok=True,
                    message=f"d-band center = {dband_val:.4f} eV -> {out}",
                    artifact=out, structure=None)


def cohp(session, params: dict) -> OpResult:
    from catgo.cli._extpath import ensure_extension
    from catgo.cli.plotting import PlotSpec, render

    src = params.get("input")
    if not src or "cohpcar" not in str(src).lower():
        raise OpError("cohp expects a COHPCAR.lobster file")
    if not Path(src).exists():
        raise OpError(f"COHPCAR not found: {src}")
    ensure_extension("cohp-analysis", "catgo_cohp")
    from catgo_cohp.io import parse_cohpcar
    try:
        cd = parse_cohpcar(str(src))
    except Exception as exc:  # noqa: BLE001
        raise OpError(f"failed to parse COHPCAR: {exc}") from exc

    # catgo_cohp ships `energies` already shifted to E_f = 0 (per
    # COHPData docstring) and the real `cohp`/`icohp` arrays have shape
    # (nspin, ncols, npoints) with the Average channel at col-index 0.
    # The test stub uses a 2D shape (n_pairs+1, npoints) with the
    # Average at row 0. Handle both: collapse to a 1D "average" series.
    import numpy as _np
    cohp_arr = _np.asarray(cd.cohp)
    icohp_arr = _np.asarray(cd.icohp)
    if cohp_arr.ndim == 3:
        # (nspin, ncols, npoints) -> sum spins, take Average col (0)
        avg_cohp = cohp_arr.sum(axis=0)[0]
        avg_icohp = icohp_arr.sum(axis=0)[0]
    else:
        # 2D fallback (n_pairs+1, npoints): row 0 = average.
        avg_cohp = cohp_arr[0]
        avg_icohp = icohp_arr[0]

    e = list(cd.energies)
    # pCOHP convention: sign-flip so bonding is positive.
    avg = [-float(v) for v in avg_cohp]
    # Energies are already E - E_f, so the Fermi level sits at 0 eV.
    fi = min(range(len(e)), key=lambda k: abs(e[k] - 0.0))
    icohp_ef = float(avg_icohp[fi])

    spec = PlotSpec(
        kind="cohp", x=e, series=[("-pCOHP (avg)", avg, {})],
        xlabel="E - E_f (eV)", ylabel="-pCOHP",
        vlines=[0.0])
    out = Path(params["out"]) if params.get("out") else Path("cohp.pdf")
    render(spec, out, bool(params.get("edit")), bool(params.get("latex")))
    if params.get("dump"):
        _dump(params["dump"], {"energy": e, "neg_pcohp_avg": avg,
                               "icohp_at_Ef": icohp_ef})
    return OpResult(ok=True,
                    message=f"ICOHP at E_f = {icohp_ef:.4f} -> {out}",
                    artifact=out, structure=None)
