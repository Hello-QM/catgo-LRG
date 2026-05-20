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
                              "(or pass --no_anim)")
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
                    "no imaginary modes; pass --mode_index for a real mode")
            write_mode_animation(
                data, mode_index=idx, out=Path(out),
                frames=int(params.get("frames", 20)),
                amplitude=float(params.get("amplitude", 0.5)),
                symbols=symbols)
            artifact = Path(out)

    if params.get("dump"):
        _dump(params["dump"], g)

    # ---- Optional IR spectrum (real modes only) -------------------------
    ir_out = params.get("ir_spectrum") or ""
    ir_note = ""
    if ir_out:
        from catgo.cli.ir import (
            compute_ir_spectrum, parse_born_charges,
            write_ir_plot, write_ir_text,
        )
        text = Path(src).read_text(errors="ignore")
        born = parse_born_charges(text, data.total_atoms)
        # Sentinel: registry has no Optional-float Param surface yet
        # (P1 backlog item); a negative value means "auto".
        emin_raw = params.get("ir_emin")
        emax_raw = params.get("ir_emax")
        emin = float(emin_raw) if emin_raw is not None and float(emin_raw) >= 0 else None
        emax = float(emax_raw) if emax_raw is not None and float(emax_raw) >= 0 else None
        spec = compute_ir_spectrum(
            data.real_freqs_cm,
            data.eigenvectors_for_real(),
            born=born,
            emin=emin, emax=emax,
            sigma=float(params.get("ir_sigma", 10.0)),
        )
        ext = Path(ir_out).suffix.lower()
        if ext in (".pdf", ".png", ".svg"):
            write_ir_plot(spec, ir_out,
                          edit=bool(params.get("edit")),
                          latex=bool(params.get("latex")))
        else:
            write_ir_text(spec, ir_out)
        ir_note = (
            f"  (IR spec: {spec.n_modes} modes, "
            f"{'BEC' if spec.used_bec else 'uniform'} -> {ir_out})"
        )

    msg = (f"G_corr={g['g_corr_ev']:.4f} eV  ZPE={g['zpe_ev']:.4f}  "
           f"H_corr={g['h_corr_ev']:.4f}  TS={g['ts_vib_ev']:.4f}  "
           f"imaginary={data.num_imaginary}{anim_note}{ir_note}")
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

    # --- multi-group PDOS path (F3) ----------------------------------------
    groups_spec = params.get("groups", "") or ""
    if groups_spec:
        from catgo.cli.pdos_groups import parse_groups_spec
        from catgo_dos.pdos import compute_pdos_groups
        from catgo_dos.dband import compute_d_center
        group_dicts = parse_groups_spec(groups_spec, vdata.nions)
        results = compute_pdos_groups(vdata, group_dicts)
        series: list = []
        for grp, res in zip(group_dicts, results):
            total = list(res.pdos.sum(axis=0))   # collapse spins
            series.append((grp["label"], total, {}))
        grid = list(results[0].grid) if results else []
        spec = PlotSpec(
            kind="dos", x=grid, series=series,
            xlabel="E - E_f (eV)", ylabel="DOS (states/eV)",
            vlines=[0.0],
        )
        out = Path(params["out"]) if params.get("out") else Path("dos.pdf")
        render(spec, out, bool(params.get("edit")), bool(params.get("latex")))

        # Per-group d-band centers (only when the group's channel spec
        # mentions 'd' — avoids nan rows for s/p-only groups).
        dband_parts: list[str] = []
        for grp in group_dicts:
            if "d" not in grp["channels"]:
                continue
            try:
                dband = compute_d_center(vdata, grp["atoms"])
                val = float(getattr(dband, "eps_rel",
                                     getattr(dband, "center", dband)))
            except (TypeError, ValueError, IndexError, AttributeError):
                val = float("nan")
            dband_parts.append(f"{grp['label']}={val:.4f}")
        dband_msg = (f"  (d-band centers: {', '.join(dband_parts)})"
                     if dband_parts else "")

        if params.get("dump"):
            _dump(params["dump"], {
                "energy": grid,
                "groups": [{
                    "label": g["label"],
                    "atoms": g["atoms"],
                    "channels": g["channels"],
                    "pdos": list(r.pdos.sum(axis=0)),
                } for g, r in zip(group_dicts, results)],
            })
        return OpResult(
            ok=True,
            message=f"{len(group_dicts)} PDOS groups -> {out}{dband_msg}",
            artifact=out, structure=None,
        )

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
        print(f"warning: d-band fallback ({exc.__class__.__name__}: {exc})",
              file=sys.stderr)
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
    import numpy as np
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

    # catgo_cohp ships cohp/icohp as (nspin, ncols, npoints) with the
    # Average bond at col index 0; energies are already shifted so that
    # E_f = 0 (cohp/io.py docstring). Sum over spin, take the Average.
    cohp_3d = np.asarray(cd.cohp)
    icohp_3d = np.asarray(cd.icohp)
    avg_cohp = cohp_3d.sum(axis=0)[0]                 # -> (npoints,)
    avg_icohp = icohp_3d.sum(axis=0)[0]
    e = np.asarray(cd.energies)
    # pCOHP plotting convention: sign-flip so bonding is positive.
    avg_neg = (-avg_cohp).tolist()
    # ICOHP at E_f: sample the integrated average at the Fermi level (E=0).
    fi = int(np.argmin(np.abs(e)))
    icohp_ef = float(avg_icohp[fi])

    spec = PlotSpec(
        kind="cohp", x=e.tolist(),
        series=[("-pCOHP (avg, spin-summed)", avg_neg, {})],
        xlabel="E - E_f (eV)", ylabel="-pCOHP",
        vlines=[0.0])
    out = Path(params["out"]) if params.get("out") else Path("cohp.pdf")
    render(spec, out, bool(params.get("edit")), bool(params.get("latex")))
    if params.get("dump"):
        _dump(params["dump"], {"energy": e.tolist(),
                               "neg_pcohp_avg": avg_neg,
                               "icohp_at_Ef": icohp_ef})
    return OpResult(ok=True,
                    message=f"ICOHP at E_f = {icohp_ef:.4f} -> {out}",
                    artifact=out, structure=None)


def band(session, params: dict) -> OpResult:
    from catgo.cli.plotting import PlotSpec, render

    src = params.get("input")
    if not src:
        raise OpError("band requires a vasprun.xml path")
    if not Path(src).exists():
        raise OpError(f"vasprun.xml not found: {src}")
    try:
        from pymatgen.io.vasp.outputs import Vasprun
        vr = Vasprun(str(src), parse_projected_eigen=False)
        bs = vr.get_band_structure(line_mode=True)
    except Exception as exc:  # noqa: BLE001
        raise OpError(f"failed to parse band structure: {exc}") from exc

    gap = bs.get_band_gap()
    gap_ev = float(gap.get("energy") or 0.0)
    kind = "direct" if gap.get("direct") else "indirect"

    # Plot ALL bands per spin (publication-grade). Label only the first
    # band of each spin channel and only when the system is spin-polarized
    # (otherwise the legend gets crowded for no information).
    dists = list(bs.distance)
    multi_spin = len(bs.bands) > 1
    spin_colors = ["C0", "C3"]   # up, down
    series = []
    for si, (spin, bands_arr) in enumerate(bs.bands.items()):
        color = spin_colors[si] if si < len(spin_colors) else None
        spin_name = getattr(spin, "name", str(spin))
        for bi in range(len(bands_arr)):
            label = (spin_name if multi_spin and bi == 0 else "")
            style = {"color": color} if color else {}
            series.append((label, list(bands_arr[bi]), style))
    spec = PlotSpec(
        kind="band", x=dists, series=series or [("", [], {})],
        xlabel="k-path", ylabel="E - E_f (eV)",
        vlines=[], hlines=[0.0])      # y=0 = Fermi reference
    out = Path(params["out"]) if params.get("out") else Path("band.pdf")
    render(spec, out, bool(params.get("edit")), bool(params.get("latex")))
    if params.get("dump"):
        _dump(params["dump"], {"distance": dists,
                               "band_gap_eV": gap_ev, "kind": kind})
    return OpResult(
        ok=True,
        message=f"band gap = {gap_ev:.4f} eV ({kind}) -> {out}",
        artifact=out, structure=None)
