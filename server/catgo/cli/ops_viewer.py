"""viewer-group handlers: push / pull. (session, params) -> OpResult.

needs_server=True at the registry layer; auto-start hook in
__init__/_run_op + shell.run ensures session.link is set before the
handler runs.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

from catgo.cli.adapter import OpError
from catgo.cli.registry import OpResult


def push(session, params: dict) -> OpResult:
    inp = params.get("input")
    panel = params.get("panel") or None   # "" -> None (server picks)
    link = session.link
    if link is None:
        raise OpError("push: server link unavailable (auto-start hook bug)")

    if inp:
        src = Path(inp)
        if not src.exists():
            raise OpError(f"push input not found: {src}")
        resp = link.push_structure(src, panel)
    else:
        if session.structure is None:
            raise OpError(
                "push requires <input> file or a loaded session structure")
        with tempfile.NamedTemporaryFile(
                suffix=".vasp", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            session.save(tmp_path)
            resp = link.push_structure(tmp_path, panel)
        finally:
            try:
                tmp_path.unlink()
            except OSError:
                pass

    s = session.structure
    formula = s.composition.reduced_formula if s is not None else "?"
    nsites = s.num_sites if s is not None else resp.get("num_sites", "?")
    panel_used = resp.get("panel_id", panel or "default")
    return OpResult(
        ok=True,
        message=f"pushed {formula} ({nsites} sites) -> viewer panel={panel_used}",
        artifact=None, structure=None)


_FMT_EXT = {"poscar": ".vasp", "cif": ".cif", "xyz": ".xyz",
            "extxyz": ".extxyz"}


def pull(session, params: dict) -> OpResult:
    panel = params.get("panel") or None
    fmt = params.get("format", "poscar")
    link = session.link
    if link is None:
        raise OpError("pull: server link unavailable (auto-start hook bug)")

    data = link.pull_structure(fmt, panel)
    ext = _FMT_EXT.get(fmt, ".vasp")
    with tempfile.NamedTemporaryFile(suffix=ext, mode="wb",
                                      delete=False) as tmp:
        tmp.write(data)
        tmp_path = Path(tmp.name)
    try:
        session.load(tmp_path)
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass

    out = params.get("out")
    suffix = ""
    if out:
        session.save(out)
        suffix = f" -> {out}"

    s = session.structure
    formula = s.composition.reduced_formula if s is not None else "?"
    nsites = s.num_sites if s is not None else "?"
    return OpResult(
        ok=True,
        message=f"pulled {formula} ({nsites} sites) <- viewer "
                f"panel={panel or 'default'}{suffix}",
        artifact=Path(out) if out else None,
        structure=s)
