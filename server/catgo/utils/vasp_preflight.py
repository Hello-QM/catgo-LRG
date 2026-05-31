"""Shared VASP cluster-config preflight: probe a live HPC host over SSH.

Used by both the REST endpoint (routers/hpc.py, for the "Test configuration"
button and the in-browser CatBot validate_hpc_config tool) and the backend MCP
tool (catgo_validate_config, for SDK agents). Returns plain dicts so both
callers can shape their own response.
"""

from __future__ import annotations

import logging
import shlex

logger = logging.getLogger(__name__)

_LAUNCHERS = {"srun", "mpirun", "mpiexec", "ibrun", "jsrun", "aprun"}


async def run_vasp_preflight(
    hpc,
    potcar_root: str,
    potcar_functional: str = "potpaw_PBE",
    vasp_command: str = "",
    elements: list[str] | None = None,
    module_loads: str = "",
    python_env: str = "",
) -> tuple[bool, list[dict], str]:
    """Validate VASP cluster settings against the live remote host.

    Checks POTCAR root/functional dirs exist, that each element's POTCAR (or the
    tree generally) is present, and that the VASP binary resolves under the real
    module-load + conda environment. Returns (success, checks, message) where
    each check is {name, ok, severity, detail} and `success` is gated on the
    "error"-severity checks only (the binary check is advisory "warn").
    """
    from catgo.workflow.engine.submitter import _POTCAR_VARIANTS

    elements = elements or []
    root = (potcar_root or "").strip().rstrip("/")
    func = (potcar_functional or "potpaw_PBE").strip()
    checks: list[dict] = []

    async def run(cmd: str):
        return await hpc.run_on_owner(lambda: hpc.conn.run(cmd, check=False))

    if not root:
        return False, [{"name": "POTCAR root directory", "ok": False,
                        "severity": "error", "detail": "POTCAR root is not configured"}], \
            "POTCAR root not configured"

    base = f"{root}/{func}"
    try:
        r = await run(f"test -d {shlex.quote(root)} && echo OK || echo NO")
        root_ok = "OK" in (r.stdout or "")
        checks.append({"name": "POTCAR root directory", "ok": root_ok, "severity": "error",
                       "detail": root if root_ok else f"not found: {root}"})

        func_ok = False
        if root_ok:
            r = await run(f"test -d {shlex.quote(base)} && echo OK || echo NO")
            func_ok = "OK" in (r.stdout or "")
            checks.append({"name": f"Functional directory ({func})", "ok": func_ok, "severity": "error",
                           "detail": base if func_ok else f"not found: {base}"})

        if func_ok:
            if elements:
                missing = []
                for el in elements:
                    variant = _POTCAR_VARIANTS.get(el, el)
                    p = f"{base}/{variant}/POTCAR"
                    rr = await run(f"test -f {shlex.quote(p)} && echo OK || echo NO")
                    if "OK" not in (rr.stdout or ""):
                        missing.append(f"{el} -> {variant}")
                checks.append({"name": "Element POTCARs", "ok": not missing, "severity": "error",
                               "detail": "all present" if not missing else "missing: " + ", ".join(missing)})
            else:
                rr = await run(
                    f"find {shlex.quote(base)} -maxdepth 2 -name POTCAR -type f 2>/dev/null | head -500 | wc -l"
                )
                try:
                    count = int((rr.stdout or "0").strip())
                except ValueError:
                    count = 0
                checks.append({"name": "Element POTCARs available", "ok": count > 0, "severity": "error",
                               "detail": f"{count} element directories contain a POTCAR" if count > 0
                                         else "no */POTCAR found under the functional directory"})

        # VASP binary — resolved under the SAME environment prelude the job
        # script uses (module loads + conda/env activation), not a bare login
        # shell. Advisory (warn): some binaries only exist on compute nodes.
        cmd = (vasp_command or "").strip()
        if cmd:
            toks = [t for t in cmd.split() if not t.startswith("-")]
            bins = [t for t in toks if t not in _LAUNCHERS]
            binname = bins[-1] if bins else (toks[-1] if toks else "")
            if binname:
                prelude = "\n".join(p for p in ((module_loads or "").strip(), (python_env or "").strip()) if p)
                probe = f"command -v {shlex.quote(binname)} >/dev/null 2>&1 && echo OK || echo NO"
                rr = await run(f"{prelude}\n{probe}" if prelude else probe)
                bok = "OK" in (rr.stdout or "")
                where = "with module loads + env" if prelude else "on login PATH"
                checks.append({"name": f"VASP binary ({binname})", "ok": bok, "severity": "warn",
                               "detail": f"resolved {where}" if bok
                                         else f"not found ({where}); check the run command, module loads, "
                                              "or note it may live only on compute nodes"})
    except Exception as exc:
        logger.error("VASP preflight failed: %s", exc, exc_info=True)
        return False, checks, str(exc)

    success = all(c["ok"] for c in checks if c["severity"] == "error")
    return success, checks, ""
