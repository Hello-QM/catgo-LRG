"""``catgo view`` / ``catgo gui`` — open structure/trajectory file(s) in the viewer.

Mirrors ``ase gui``:

* ``catgo view POSCAR``      — single structure (or a trajectory if the file is
  itself multi-frame, e.g. XDATCAR / .traj — the server auto-detects).
* ``catgo view */POSCAR``    — many single-frame files stacked into ONE
  trajectory, one frame per file (shell expands the glob; we get a path list).
* ``catgo view a.traj b.traj`` — concatenate multiple trajectories end to end.

Frame selection follows ase gui: a global ``-n/--image-number SLICE`` and a
per-file ``filename@SLICE`` override (``traj.xyz@:10``, ``a.traj@-1``). SLICE is
a number or a python-slice-like ``START:STOP:STEP`` (negatives count from end).

Reuses the existing ``POST /api/view/upload-and-load`` push channel. The
single-file, whole-file path goes through the server's full parser set (cif /
vasp / xyz / qe / outcar / lammps / xdatcar / .traj ...). Any sliced or
multi-file request is read with ASE and written as a combined ``.extxyz`` the
server ingests as a trajectory, covering every format ASE can read.
"""
from __future__ import annotations

import re
import sys
import tempfile
import webbrowser
from pathlib import Path

# int, ":STOP", "START:STOP", "START:STOP:STEP" — all with optional minus signs.
_SLICE_RE = re.compile(r"^-?\d+(:-?\d*(:-?\d*)?)?$|^:-?\d*(:-?\d*)?$")


def _split_at(raw: str) -> "tuple[str, str | None]":
    """Split a ``filename@SLICE`` arg. Returns (filename, slice_str|None).

    Only splits when the part after the last ``@`` parses as a slice, so a
    literal ``@`` in a path is left alone (matches ase's behaviour).
    """
    base, sep, sl = raw.rpartition("@")
    if sep and base and _SLICE_RE.match(sl):
        return base, sl
    return raw, None


def _natural_key(name: str) -> list:
    """Sort key so ``step_2`` orders before ``step_10`` (frame order sanity)."""
    return [int(tok) if tok.isdigit() else tok.lower()
            for tok in re.split(r"(\d+)", name)]


def _read_frames(specs: "list[tuple[str, str | None]]", default_slice: str) -> list:
    """Read every selected frame of every file via ASE, in order."""
    from catgo.cli.adapter import OpError

    try:
        from ase.io import read
        from ase.utils import string2index
    except ImportError as exc:  # ASE is a hard backend dep, but be explicit
        raise OpError(f"sliced/multi-file view needs ASE: {exc}") from exc

    images: list = []
    for fname, sl in specs:
        idx = string2index(sl if sl is not None else default_slice)
        try:
            frames = read(fname, index=idx)
        except Exception as exc:  # ASE raises many concrete types
            raise OpError(f"could not read {fname}: {exc}") from exc
        if isinstance(frames, list):
            images.extend(frames)
        else:
            images.append(frames)

    if not images:
        raise OpError("no frames could be read from the given file(s)")
    return images


def _write_extxyz(images: list) -> Path:
    from ase.io import write
    with tempfile.NamedTemporaryFile(suffix=".extxyz", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    write(str(tmp_path), images, format="extxyz")
    return tmp_path


def _linear_interpolate(images: list, n: int) -> list:
    """Linear, minimum-image interpolation of N frames between two endpoints."""
    import numpy as np
    from ase.geometry import find_mic

    a0, a1 = images
    dR = find_mic(
        a1.get_positions() - a0.get_positions(), a0.get_cell(), a0.get_pbc()
    )[0]
    c0 = np.array(a0.get_cell())
    c1 = np.array(a1.get_cell())
    out = [a0]
    for k in range(1, n + 1):
        t = k / (n + 1)
        at = a0.copy()
        at.set_cell(c0 * (1 - t) + c1 * t, scale_atoms=False)
        at.set_positions(a0.get_positions() + t * dR)
        out.append(at)
    out.append(a1)
    return out


def _interpolate(images: list, n: int, method: str = "idpp",
                 mic: bool = False) -> list:
    """Insert N frames between 2 endpoints. Default IDPP (image-dependent pair
    potential), which spreads atoms along a physically smoother path than a
    straight linear interpolation; falls back to linear if IDPP fails."""
    from catgo.cli.adapter import OpError

    if len(images) != 2:
        raise OpError(
            f"--interpolate needs exactly 2 endpoint frames, got {len(images)}"
        )
    if len(images[0]) != len(images[1]):
        raise OpError("--interpolate endpoints have different atom counts")

    if method == "linear":
        return _linear_interpolate(images, n)

    # IDPP: build a linear-seeded chain, then optimise pair distances. ASE's
    # idpp writes idpp.traj/idpp.log into cwd, so run it inside a tempdir.
    import contextlib
    import os
    import tempfile

    try:
        from ase.mep import NEB

        chain = (
            [images[0]]
            + [images[0].copy() for _ in range(n)]
            + [images[1]]
        )
        # method only matters when running NEB forces (we don't); set it to
        # silence ase's aseneb→improvedtangent default-change warning.
        neb = NEB(chain, method="improvedtangent")
        with tempfile.TemporaryDirectory() as td:
            cwd = os.getcwd()
            os.chdir(td)
            try:
                neb.interpolate(method="idpp", mic=mic)
            finally:
                os.chdir(cwd)
        return chain
    except Exception as exc:  # IDPP can diverge / not converge — degrade safely
        print(
            f"warning: IDPP interpolation failed ({exc}); using linear",
            file=sys.stderr,
        )
        return _linear_interpolate(images, n)


def _graph(images: list, expr: str):
    """Evaluate a per-frame ``expr`` over the images (ase-gui graph syntax).

    Symbols mirror ase gui: ``i`` (frame), ``s`` (path length), ``e`` (epot+ekin),
    ``epot``, ``ekin``, ``fmax``, ``fave``, ``T``, plus ``E`` (energy array),
    ``R``/``F``/``A`` (positions/forces/cell) and ``d(i,j)``/``a(i,j,k)`` helpers.
    Returns ``(names, xy)`` with ``xy`` shaped ``(nvars, nframes)``.
    """
    from math import sqrt

    import numpy as np
    import ase.units as units
    from ase.constraints import FixAtoms
    from ase.geometry import find_mic

    from catgo.cli.adapter import OpError

    def _dynamic(atoms):
        mask = np.ones(len(atoms), bool)
        for c in atoms.constraints:
            if isinstance(c, FixAtoms):
                mask[c.index] = False
        return mask

    def _energy(atoms):
        try:
            return atoms.get_potential_energy()
        except Exception:
            return float("nan")

    def _forces(atoms):
        try:
            return atoms.get_forces(apply_constraint=False)
        except Exception:
            return None

    def d(n1, n2):
        return sqrt(((R[n1] - R[n2]) ** 2).sum())

    def a(n1, n2, n3):
        v1 = R[n1] - R[n2]
        v2 = R[n3] - R[n2]
        arg = np.vdot(v1, v2) / sqrt((v1 ** 2).sum() * (v2 ** 2).sum())
        arg = min(1.0, max(-1.0, float(arg)))
        return 180.0 * np.arccos(arg) / np.pi

    code = compile(expr + ",", "<catgo-graph>", "eval")
    E = np.array([_energy(at) for at in images])
    # eval() runs a user-supplied math formula (ase-gui `-g` semantics). It is the
    # caller's own local CLI argument — same trust boundary as the shell they
    # typed it in, never remote input. We still sandbox: `__builtins__` is emptied
    # so the expression cannot reach __import__/open/exec, leaving only the
    # per-frame data symbols below plus a few safe numeric builtins.
    _safe = {"abs": abs, "min": min, "max": max, "pow": pow,
             "len": len, "round": round, "sum": sum}
    ns = {"__builtins__": {}, "E": E, "d": d, "a": a, **_safe}
    rows = []
    s = 0.0
    n = len(images)
    for i in range(n):
        at = images[i]
        ns["i"] = i
        ns["s"] = s
        ns["R"] = R = at.get_positions()
        ns["A"] = at.get_cell()
        F = _forces(at)
        if F is not None:
            ns["F"] = F
        mask = _dynamic(at)
        if F is not None and len(F):
            f = ((F * mask[:, None]) ** 2).sum(1) ** 0.5
            ns["fmax"] = float(f.max())
            ns["fave"] = float(f.mean())
        ns["epot"] = epot = float(E[i])
        try:
            ekin = at.get_kinetic_energy()
        except Exception:
            ekin = 0.0
        ns["ekin"] = ekin
        ns["e"] = epot + ekin
        ndyn = int(mask.sum())
        if ndyn > 0:
            ns["T"] = 2.0 * ekin / (3.0 * ndyn * units.kB)
        try:
            val = eval(code, ns)  # noqa: S307 — expr is a user-supplied formula
        except NameError as exc:
            raise OpError(
                f"graph expr references an unavailable symbol: {exc}"
            ) from exc
        rows.append([float(x) for x in val])
        if i + 1 < n:
            try:
                dR = find_mic(
                    images[i + 1].positions - R, at.get_cell(), at.get_pbc()
                )[0]
                s += sqrt((dR ** 2).sum())
            except Exception:
                pass

    names = [t.strip() for t in expr.split(",")]
    return names, np.array(rows).T


def _emit_graph(names: list, xy, out: "str | None") -> None:
    from pathlib import Path

    from catgo.cli.adapter import OpError

    nvars, nframes = xy.shape

    def _rows():
        for j in range(nframes):
            yield "\t".join(f"{xy[k, j]:.6g}" for k in range(nvars))

    print("# " + "\t".join(names))
    for line in _rows():
        print(line)

    if not out:
        return
    ext = Path(out).suffix.lower()
    if ext in (".png", ".pdf", ".svg", ".jpg", ".jpeg"):
        try:
            import matplotlib

            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
        except ImportError as exc:
            raise OpError(f"plot output needs matplotlib: {exc}") from exc
        fig, ax = plt.subplots()
        x = xy[0]
        for k in range(1, nvars):
            ax.plot(x, xy[k], marker="o", label=names[k])
        ax.set_xlabel(names[0])
        if nvars > 1:
            ax.legend()
        fig.tight_layout()
        fig.savefig(out, dpi=150)
        print(f"# wrote plot -> {out}")
    else:
        Path(out).write_text(
            "# " + "\t".join(names) + "\n" + "\n".join(_rows()) + "\n"
        )
        print(f"# wrote data -> {out}")


def _is_local(base_url: str) -> bool:
    return "localhost" in base_url or "127.0.0.1" in base_url


def _find_gui_app() -> "Path | None":
    """Locate the installed CatGo desktop GUI executable.

    Only meaningful in a packaged build: the frozen ``catgo-server`` backend
    sits next to the GUI binary (``CatGo.exe`` / ``CatGo`` / the .app's MacOS
    dir). Returns None for a dev / pip install (no bundled GUI to launch).
    """
    if not getattr(sys, "frozen", False):
        return None
    exe = Path(sys.executable)
    me = exe.name.lower()
    for name in ("CatGo.exe", "CatGo", "catgo.exe", "catgo"):
        cand = exe.parent / name
        if cand.exists() and cand.name.lower() != me:
            return cand
    # macOS .app: backend in CatGo.app/Contents/MacOS next to the GUI binary,
    # or one level up in the bundle.
    for up in (exe.parent, exe.parent.parent):
        for name in ("CatGo", "catgo"):
            cand = up / name
            if cand.exists() and cand.is_file() and cand.name.lower() != me:
                return cand
    return None


def _wait_for_backend(timeout: float = 40.0):
    """Poll ServerLink.discover() until a backend answers, or timeout → None."""
    import time

    from catgo.cli.server_link import ServerLink

    delay = 0.3
    waited = 0.0
    while waited < timeout:
        link = ServerLink.discover()
        if link is not None:
            return link
        time.sleep(delay)
        waited += delay
        delay = min(delay * 1.5, 2.0)
    return None


def cmd_view(args) -> int:
    from catgo.cli.adapter import OpError
    from catgo.cli.server_link import ServerLink

    # Parse filename@SLICE; validate the (stripped) paths exist.
    specs = [_split_at(f) for f in args.files]
    missing = [fn for fn, _ in specs if not Path(fn).exists()]
    if missing:
        print(f"error: file(s) not found: {', '.join(missing)}", file=sys.stderr)
        return 1
    if getattr(args, "sort", "natural") != "none":
        specs = sorted(specs, key=lambda s: _natural_key(s[0]))

    default_slice = getattr(args, "image_number", ":") or ":"
    has_slice = default_slice != ":" or any(sl is not None for _, sl in specs)
    graph = getattr(args, "graph", None)
    interp = getattr(args, "interpolate", None)
    terminal = getattr(args, "terminal", False)
    out = getattr(args, "out", None)
    as_traj = (
        len(specs) > 1
        or getattr(args, "traj", False)
        or has_slice
        or interp is not None
    )

    # Read frames via ASE when we need them (graph maths, interpolation, or any
    # trajectory build). A plain single whole-file view skips this.
    images = None
    if as_traj or graph:
        try:
            images = _read_frames(specs, default_slice)
            if interp is not None:
                images = _interpolate(
                    images, interp,
                    method=getattr(args, "interp_method", "idpp"),
                )
        except OpError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1

    # Graph: print the per-frame table (and optionally save a plot/data file).
    if graph:
        try:
            names, xy = _graph(images, graph)
            _emit_graph(names, xy, out)
        except OpError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1

    # Terminal mode: never touch the viewer. Convert-to-file if -o given without
    # a graph; otherwise the graph output above was the whole point.
    if terminal:
        if not graph and not out:
            print("error: -t/--terminal needs --graph and/or -o/--out",
                  file=sys.stderr)
            return 1
        if out and not graph:
            from ase.io import write
            write(out, images if images is not None else
                  _read_frames(specs, default_slice))
            print(f"wrote {out}")
        return 0

    # Discover a running server; otherwise bring one up. Prefer launching the
    # full desktop app (so the structure shows in the real GUI) when packaged;
    # fall back to a headless backend + browser for a dev / pip install.
    link = ServerLink.discover()
    started_headless = False
    launched_gui = False
    if link is None:
        if getattr(args, "no_autostart", False):
            print(
                "error: --no-autostart: server unreachable; "
                "start `catgo serve` first",
                file=sys.stderr,
            )
            return 2
        gui = _find_gui_app()
        if gui is not None:
            import subprocess
            try:
                subprocess.Popen([str(gui)], start_new_session=True)
            except OSError as exc:
                print(f"error: failed to launch CatGo: {exc}", file=sys.stderr)
                return 2
            print("Launching CatGo…")
            link = _wait_for_backend()
            launched_gui = True
            if link is None:
                print(
                    "error: launched CatGo but its backend didn't come up in time",
                    file=sys.stderr,
                )
                return 2
        else:
            try:
                from catgo.cli._autostart import spawn_daemon_and_wait

                link = spawn_daemon_and_wait()
                started_headless = True
            except OpError as exc:
                print(f"error: {exc}", file=sys.stderr)
                return 2

    panel = getattr(args, "panel", "") or None

    tmp_path: Path | None = None
    try:
        if images is not None:
            tmp_path = _write_extxyz(images)
            link.push_structure(tmp_path, panel)
            summary = (
                f"trajectory ({len(images)} frames from {len(specs)} file(s))"
                if len(images) > 1
                else f"structure (1 frame from {len(specs)} file(s))"
            )
        else:
            # whole single file → full server-side parser set, original bytes
            link.push_structure(specs[0][0], panel)
            summary = Path(specs[0][0]).name
    except OpError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink()
            except OSError:
                pass

    # Headless backend we spawned → no window; open the served web UI so the
    # push is visible. GUI we launched → it IS the window, don't open a browser.
    if started_headless and _is_local(link.base_url):
        webbrowser.open(link.base_url + "/")
        print(f"opened {summary} -> {link.base_url}/")
    elif launched_gui:
        print(f"launched CatGo — opened {summary}")
    else:
        print(f"opened {summary} -> CatGo viewer ({link.base_url})")
    return 0
