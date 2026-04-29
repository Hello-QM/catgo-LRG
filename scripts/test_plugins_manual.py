#!/usr/bin/env python3
"""
CatGO Plugin System — Manual Test Suite

Tests all 6 phases of the plugin system via HTTP API calls.
Run alongside `pnpm desktop:serve` to verify plugin functionality.

Usage:
    python scripts/test_plugins_manual.py [--port 8000] [--phase 0 2 5] [--no-color]
"""

import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

try:
    import httpx
except ImportError:
    print("ERROR: httpx is required. Install with: pip install httpx")
    sys.exit(1)


# ── Color helpers ──────────────────────────────────────────────────────────

USE_COLOR = True


def _supports_color() -> bool:
    if os.environ.get("NO_COLOR"):
        return False
    if sys.platform == "win32":
        # Enable ANSI on Windows 10+
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
            return True
        except Exception:
            return False
    return hasattr(sys.stdout, "isatty") and sys.stdout.isatty()


def green(s: str) -> str:
    return f"\033[32m{s}\033[0m" if USE_COLOR else s


def red(s: str) -> str:
    return f"\033[31m{s}\033[0m" if USE_COLOR else s


def yellow(s: str) -> str:
    return f"\033[33m{s}\033[0m" if USE_COLOR else s


def cyan(s: str) -> str:
    return f"\033[36m{s}\033[0m" if USE_COLOR else s


def bold(s: str) -> str:
    return f"\033[1m{s}\033[0m" if USE_COLOR else s


def ok(msg: str) -> None:
    print(f"    {green('✓')} {msg}")


def fail(msg: str) -> None:
    print(f"    {red('✗')} {msg}")


def warn(msg: str) -> None:
    print(f"    {yellow('!')} {msg}")


def info(msg: str) -> None:
    print(f"    {cyan('·')} {msg}")


# ── Test data ──────────────────────────────────────────────────────────────

CU_FCC = {
    "lattice": {"matrix": [[3.6, 0, 0], [0, 3.6, 0], [0, 0, 3.6]]},
    "sites": [
        {"species": [{"element": "Cu", "occu": 1}], "abc": [0, 0, 0], "xyz": [0, 0, 0]},
        {"species": [{"element": "Cu", "occu": 1}], "abc": [0.5, 0.5, 0], "xyz": [1.8, 1.8, 0]},
        {"species": [{"element": "Cu", "occu": 1}], "abc": [0.5, 0, 0.5], "xyz": [1.8, 0, 1.8]},
        {"species": [{"element": "Cu", "occu": 1}], "abc": [0, 0.5, 0.5], "xyz": [0, 1.8, 1.8]},
    ],
}

# Project root — resolve relative to this script
PROJECT_ROOT = Path(__file__).resolve().parent.parent
PDOS_DIR = PROJECT_ROOT / "tests" / "fixtures" / "cp2k-pdos"


# ── HTTP helpers ───────────────────────────────────────────────────────────


def get(client: httpx.Client, path: str) -> httpx.Response:
    """GET with endpoint logging."""
    print(f"  GET {path}")
    r = client.get(path)
    if r.status_code >= 400:
        fail(f"HTTP {r.status_code}")
        try:
            body = r.json()
            print(f"      {json.dumps(body, indent=2)[:500]}")
        except Exception:
            print(f"      {r.text[:500]}")
    return r


def post(client: httpx.Client, path: str, **kwargs: Any) -> httpx.Response:
    """POST with endpoint logging."""
    print(f"  POST {path}")
    r = client.post(path, **kwargs)
    if r.status_code >= 400:
        fail(f"HTTP {r.status_code}")
        try:
            body = r.json()
            print(f"      {json.dumps(body, indent=2)[:500]}")
        except Exception:
            print(f"      {r.text[:500]}")
    return r


# ── Phase tests ────────────────────────────────────────────────────────────


def phase0_calculator(client: httpx.Client) -> bool:
    """Phase 0: Calculator Plugin — LJ calculator registration + optimization."""
    passed = True

    # List calculators
    r = get(client, "/api/optimize/calculators")
    if r.status_code != 200:
        return False

    data = r.json()
    calcs = data.get("calculators", {})
    total = len(calcs)
    plugin_count = sum(1 for c in calcs.values() if c.get("is_plugin"))
    builtin_count = total - plugin_count

    if "lennard_jones" in calcs:
        lj = calcs["lennard_jones"]
        ok(f"Found {total} calculators ({builtin_count} built-in + {plugin_count} plugin)")
        ok(f"lennard_jones: available={lj.get('available')}, is_plugin={lj.get('is_plugin')}")
    else:
        fail(f"lennard_jones not found in {list(calcs.keys())}")
        passed = False

    # Run optimization with LJ
    payload = {
        "structure": CU_FCC,
        "calculator": "lennard_jones",
        "fmax": 0.05,
        "steps": 100,
    }
    r = post(client, "/api/optimize/structure", json=payload)
    if r.status_code != 200:
        passed = False
    else:
        result = r.json()
        if result.get("success"):
            steps = result.get("steps_taken", "?")
            energy = result.get("final_energy", "?")
            fmax = result.get("final_fmax", "?")
            ok(f"Converged in {steps} steps, E={energy} eV, fmax={fmax}")
        else:
            msg = result.get("message", "unknown error")
            fail(f"Optimization failed: {msg}")
            passed = False

    return passed


def phase1_reader(client: httpx.Client) -> bool:
    """Phase 1: Reader Plugin — CP2K DOS reader registration + file upload."""
    passed = True

    # List plugins, check reader appears
    r = get(client, "/api/plugins/")
    if r.status_code != 200:
        return False

    data = r.json()
    plugins = data.get("plugins", [])
    reader_names = [p["name"] for p in plugins if p.get("plugin_type") == "reader"]

    if "cp2k-dos-reader" in reader_names:
        ok(f"Reader plugin found: cp2k-dos-reader")
    else:
        fail(f"cp2k-dos-reader not in plugins: {[p['name'] for p in plugins]}")
        passed = False

    # Upload PDOS files
    if not PDOS_DIR.exists():
        fail(f"Fixture dir not found: {PDOS_DIR}")
        return False

    pdos_files = sorted(PDOS_DIR.glob("*.pdos"))
    if not pdos_files:
        fail("No .pdos files found in fixtures")
        return False

    info(f"Uploading {len(pdos_files)} PDOS files from {PDOS_DIR.name}/")

    files = []
    opened = []
    try:
        for p in pdos_files:
            f = open(p, "rb")
            opened.append(f)
            files.append(("files", (p.name, f, "application/octet-stream")))

        r = post(client, "/api/plugins/readers/upload", files=files, data={"reader_id": "cp2k_pdos"})
    finally:
        for f in opened:
            f.close()

    if r.status_code != 200:
        passed = False
    else:
        result = r.json()
        rdata = result.get("data", {})
        nions = rdata.get("nions", "?")
        nspin = rdata.get("nspin", "?")
        nbands = rdata.get("nbands", "?")
        efermi = rdata.get("efermi", "?")
        session_id = rdata.get("session_id", "?")
        ok(f"DOS session created: {session_id}")
        ok(f"nions={nions}, nspin={nspin}, nbands={nbands}, efermi={efermi}")

    return passed


def phase2_analyzer(client: httpx.Client) -> bool:
    """Phase 2: Analyzer Plugin — Bond histogram registration + execution."""
    passed = True

    # List analyzers
    r = get(client, "/api/plugins/analyzers")
    if r.status_code != 200:
        return False

    data = r.json()
    analyzers = data.get("analyzers", [])
    ids = [a.get("analyzer_id") for a in analyzers]

    if "bond_histogram" in ids:
        ok(f"Analyzer found: bond_histogram")
    else:
        fail(f"bond_histogram not in analyzers: {ids}")
        passed = False

    # Run bond histogram on Cu FCC
    payload = {
        "structure": CU_FCC,
        "cutoff": 3.5,
    }
    r = post(client, "/api/plugins/analyzers/bond_histogram/run", json=payload)
    if r.status_code != 200:
        passed = False
    else:
        result = r.json()
        analyzer_id = result.get("analyzer_id", "?")
        output_type = result.get("output_type", "?")
        res_data = result.get("result", {})

        if isinstance(res_data, dict):
            # Try to extract histogram info
            bins = res_data.get("bins") or res_data.get("labels") or res_data.get("x", [])
            values = res_data.get("values") or res_data.get("counts") or res_data.get("y", [])
            n_bins = len(bins) if isinstance(bins, list) else "?"
            max_val = max(values) if isinstance(values, list) and values else "?"
            ok(f"analyzer_id={analyzer_id}, output_type={output_type}")
            ok(f"Histogram: {n_bins} bins, max_count={max_val}")
            if isinstance(bins, list) and len(bins) >= 2:
                info(f"Bond length range: {bins[0]:.3f} - {bins[-1]:.3f} Å")
        else:
            ok(f"analyzer_id={analyzer_id}, output_type={output_type}")
            info(f"Result: {json.dumps(res_data)[:200]}")

    return passed


def phase3_workflow(client: httpx.Client) -> bool:
    """Phase 3: Workflow Node Plugin — LAMMPS NVT node registration."""
    passed = True

    r = get(client, "/api/plugins/workflow-nodes")
    if r.status_code != 200:
        return False

    data = r.json()
    nodes = data.get("nodes", [])
    types = [n.get("type") for n in nodes]

    if "lammps_nvt_plugin" in types:
        ok(f"Workflow node found: lammps_nvt_plugin")
        node = next(n for n in nodes if n["type"] == "lammps_nvt_plugin")
        defn = node.get("definition", {})

        # Print node definition summary
        inputs = defn.get("inputs", [])
        outputs = defn.get("outputs", [])
        params = defn.get("param_schema") or defn.get("parameters") or defn.get("params", {})

        ok(f"Inputs: {[i.get('name', i) if isinstance(i, dict) else i for i in inputs]}")
        ok(f"Outputs: {[o.get('name', o) if isinstance(o, dict) else o for o in outputs]}")
        if params:
            if isinstance(params, dict):
                param_keys = list(params.get("properties", params).keys())[:5]
            else:
                param_keys = str(params)[:80]
            ok(f"Parameters: {param_keys}")
        else:
            info("No param_schema defined")
    else:
        fail(f"lammps_nvt_plugin not in workflow-nodes: {types}")
        passed = False

    return passed


def phase4_mcp(client: httpx.Client) -> bool:
    """Phase 4: MCP Tool Registration — verify all plugins discovered."""
    passed = True

    r = get(client, "/api/plugins/")
    if r.status_code != 200:
        return False

    data = r.json()
    plugins = data.get("plugins", [])
    total = data.get("total", len(plugins))

    ok(f"Total plugins registered: {total}")
    print()

    expected_types = {"calculator", "reader", "analyzer", "workflow_node"}
    found_types = set()

    for p in plugins:
        name = p.get("name", "?")
        ptype = p.get("plugin_type", "?")
        enabled = p.get("enabled", False)
        found_types.add(ptype)

        status = green("enabled") if enabled else red("disabled")
        print(f"    {cyan('·')} {name:<30s} type={ptype:<15s} {status}")

    print()
    missing = expected_types - found_types
    if missing:
        fail(f"Missing plugin types: {missing}")
        passed = False
    else:
        ok(f"All 4 plugin types represented: {sorted(found_types)}")

    return passed


def phase5_frontend(client: httpx.Client) -> bool:
    """Phase 5: Frontend Integration Check — verify metadata completeness."""
    passed = True
    checks = []

    # Check calculator has is_plugin marker
    r = get(client, "/api/plugins/calculators")
    if r.status_code == 200:
        calcs = r.json().get("calculators", [])
        has_plugin_marker = any(c.get("is_plugin") for c in calcs)
        if has_plugin_marker:
            ok("Calculator plugins have is_plugin=True marker")
            checks.append(True)
        else:
            fail("No calculator with is_plugin=True found")
            checks.append(False)
    else:
        checks.append(False)

    # Check analyzers have input_schema
    r = get(client, "/api/plugins/analyzers")
    if r.status_code == 200:
        analyzers = r.json().get("analyzers", [])
        has_schema = any(a.get("input_schema") for a in analyzers)
        if has_schema:
            ok("Analyzer plugins have input_schema for dynamic forms")
        elif analyzers:
            warn("Analyzers found but no input_schema defined (optional)")
        else:
            warn("No analyzer plugins found")
        checks.append(True)  # schema is optional
    else:
        checks.append(False)

    # Check workflow-nodes have complete definition
    r = get(client, "/api/plugins/workflow-nodes")
    if r.status_code == 200:
        nodes = r.json().get("nodes", [])
        if nodes:
            node = nodes[0]
            defn = node.get("definition", {})
            has_inputs = "inputs" in defn
            has_outputs = "outputs" in defn
            if has_inputs and has_outputs:
                ok("Workflow nodes have complete definitions (inputs + outputs)")
                checks.append(True)
            else:
                fail(f"Incomplete node definition: inputs={has_inputs}, outputs={has_outputs}")
                checks.append(False)
        else:
            warn("No workflow nodes found")
            checks.append(True)
    else:
        checks.append(False)

    passed = all(checks)
    return passed


# ── Main ───────────────────────────────────────────────────────────────────

PHASES = [
    (0, "Calculator Plugin", phase0_calculator),
    (1, "Reader Plugin", phase1_reader),
    (2, "Analyzer Plugin", phase2_analyzer),
    (3, "Workflow Node Plugin", phase3_workflow),
    (4, "MCP Tool Registration", phase4_mcp),
    (5, "Frontend Integration Check", phase5_frontend),
]


def main() -> None:
    global USE_COLOR

    parser = argparse.ArgumentParser(description="CatGO Plugin System — Manual Test Suite")
    parser.add_argument("--port", type=int, default=8000, help="Backend port (default: 8000)")
    parser.add_argument("--phase", type=int, nargs="*", help="Run specific phases (e.g. --phase 0 2)")
    parser.add_argument("--no-color", action="store_true", help="Disable ANSI colors")
    args = parser.parse_args()

    if args.no_color:
        USE_COLOR = False
    else:
        USE_COLOR = _supports_color()

    base_url = f"http://localhost:{args.port}"
    selected = set(args.phase) if args.phase is not None else {0, 1, 2, 3, 4, 5}

    # Header
    print()
    print(bold("══════════════════════════════════════════"))
    print(bold("  CatGO Plugin System — Manual Test Suite"))
    print(f"  Server: {cyan(base_url)}")
    print(bold("══════════════════════════════════════════"))
    print()

    # Connection check
    try:
        with httpx.Client(base_url=base_url, timeout=5.0) as client:
            client.get("/api/optimize/calculators")
    except (httpx.ConnectError, httpx.ConnectTimeout):
        print(red("  ERROR: Cannot connect to backend!"))
        print()
        print("  Start the backend first:")
        print(f"    {cyan('pnpm desktop:serve')}")
        print()
        sys.exit(1)

    # Run phases
    results: dict[int, bool | None] = {}

    with httpx.Client(base_url=base_url, timeout=30.0) as client:
        for phase_num, phase_name, phase_fn in PHASES:
            if phase_num not in selected:
                continue

            print(f"{bold(f'[Phase {phase_num}]')} {phase_name} {'·' * (40 - len(phase_name))}")

            try:
                t0 = time.time()
                passed = phase_fn(client)
                dt = time.time() - t0
                results[phase_num] = passed
                status = green("PASS") if passed else red("FAIL")
                print(f"  ── Phase {phase_num}: {status} ({dt:.1f}s) ──")
            except Exception as e:
                results[phase_num] = False
                print(f"  ── Phase {phase_num}: {red('ERROR')} ──")
                fail(f"{type(e).__name__}: {e}")
                traceback.print_exc(limit=3)

            print()

    # Summary
    total = len(results)
    passed_count = sum(1 for v in results.values() if v)
    failed_count = total - passed_count

    print(bold("══════════════════════════════════════════"))
    print(f"  {bold('Summary')}: {green(f'PASS: {passed_count}/{total}')}", end="")
    if failed_count:
        print(f", {red(f'FAIL: {failed_count}/{total}')}", end="")
    print()

    for phase_num, phase_name, _ in PHASES:
        if phase_num not in results:
            continue
        status = green("✓") if results[phase_num] else red("✗")
        print(f"    {status} Phase {phase_num}: {phase_name}")

    print(bold("══════════════════════════════════════════"))
    print()

    sys.exit(0 if failed_count == 0 else 1)


if __name__ == "__main__":
    main()
