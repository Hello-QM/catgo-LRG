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
