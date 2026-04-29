"""
End-to-end tests for all AI tool endpoints.

Tests every endpoint that the AI tools call, both frontend (structure-tools.ts)
and MCP (mcp_server.py) paths. Requires the backend server to be running on
localhost:8000.

This is a standalone test script, not designed for pytest auto-discovery.
Run directly:
    conda run -n catgo python tests/test_ai_tools_e2e.py
    conda run -n catgo python tests/test_ai_tools_e2e.py -v          # verbose
    conda run -n catgo python tests/test_ai_tools_e2e.py -k vasp     # filter
"""

import json
import sys
import time
import traceback
from dataclasses import dataclass, field

import pytest

# Skip entire module when collected by pytest — this is a standalone script
pytestmark = pytest.mark.skip(reason="Standalone E2E test script, not a pytest module")

import httpx

API_BASE = "http://localhost:8000/api"
TIMEOUT = 30.0

# ── Test Fixtures ──────────────────────────────────────────────────────────

NACL_STRUCTURE = {
    "lattice": {
        "matrix": [
            [5.6903, 0.0, 0.0],
            [0.0, 5.6903, 0.0],
            [0.0, 0.0, 5.6903],
        ],
        "a": 5.6903, "b": 5.6903, "c": 5.6903,
        "alpha": 90.0, "beta": 90.0, "gamma": 90.0,
    },
    "sites": [
        {"xyz": [0.0, 0.0, 0.0], "species": [{"element": "Na", "occu": 1.0}]},
        {"xyz": [0.0, 2.845, 2.845], "species": [{"element": "Na", "occu": 1.0}]},
        {"xyz": [2.845, 0.0, 2.845], "species": [{"element": "Na", "occu": 1.0}]},
        {"xyz": [2.845, 2.845, 0.0], "species": [{"element": "Na", "occu": 1.0}]},
        {"xyz": [2.845, 2.845, 2.845], "species": [{"element": "Cl", "occu": 1.0}]},
        {"xyz": [2.845, 0.0, 0.0], "species": [{"element": "Cl", "occu": 1.0}]},
        {"xyz": [0.0, 2.845, 0.0], "species": [{"element": "Cl", "occu": 1.0}]},
        {"xyz": [0.0, 0.0, 2.845], "species": [{"element": "Cl", "occu": 1.0}]},
    ],
}

SI_STRUCTURE = {
    "lattice": {
        "matrix": [[0.0, 2.715, 2.715], [2.715, 0.0, 2.715], [2.715, 2.715, 0.0]],
        "a": 3.84, "b": 3.84, "c": 3.84,
        "alpha": 60.0, "beta": 60.0, "gamma": 60.0,
    },
    "sites": [
        {"species": [{"element": "Si", "occu": 1.0}], "abc": [0.0, 0.0, 0.0], "xyz": [0.0, 0.0, 0.0]},
        {"species": [{"element": "Si", "occu": 1.0}], "abc": [0.25, 0.25, 0.25], "xyz": [1.3575, 1.3575, 1.3575]},
    ],
}

# Slab structure for adsorption/water tests (NaCl 001 slab with vacuum)
NACL_SLAB = {
    "lattice": {
        "matrix": [
            [5.6903, 0.0, 0.0],
            [0.0, 5.6903, 0.0],
            [0.0, 0.0, 25.0],
        ],
        "a": 5.6903, "b": 5.6903, "c": 25.0,
        "alpha": 90.0, "beta": 90.0, "gamma": 90.0,
    },
    "sites": [
        {"xyz": [0.0, 0.0, 0.0], "species": [{"element": "Na", "occu": 1.0}]},
        {"xyz": [0.0, 2.845, 2.845], "species": [{"element": "Na", "occu": 1.0}]},
        {"xyz": [2.845, 0.0, 2.845], "species": [{"element": "Na", "occu": 1.0}]},
        {"xyz": [2.845, 2.845, 0.0], "species": [{"element": "Na", "occu": 1.0}]},
        {"xyz": [2.845, 2.845, 2.845], "species": [{"element": "Cl", "occu": 1.0}]},
        {"xyz": [2.845, 0.0, 0.0], "species": [{"element": "Cl", "occu": 1.0}]},
        {"xyz": [0.0, 2.845, 0.0], "species": [{"element": "Cl", "occu": 1.0}]},
        {"xyz": [0.0, 0.0, 2.845], "species": [{"element": "Cl", "occu": 1.0}]},
    ],
}


@dataclass
class TestResult:
    name: str
    passed: bool
    message: str
    duration_ms: float = 0.0


@dataclass
class TestSuite:
    results: list[TestResult] = field(default_factory=list)
    verbose: bool = False

    def record(self, name: str, passed: bool, msg: str, duration_ms: float = 0.0):
        self.results.append(TestResult(name, passed, msg, duration_ms))
        icon = "✓" if passed else "✗"
        time_str = f" ({duration_ms:.0f}ms)" if duration_ms else ""
        if passed:
            print(f"  {icon} {name}{time_str}")
        else:
            print(f"  {icon} {name}{time_str} — {msg}")

    def summary(self):
        passed = sum(1 for r in self.results if r.passed)
        failed = sum(1 for r in self.results if not r.passed)
        total = len(self.results)
        print(f"\n{'='*60}")
        print(f"Results: {passed}/{total} passed, {failed} failed")
        if failed:
            print(f"\nFailed tests:")
            for r in self.results:
                if not r.passed:
                    print(f"  ✗ {r.name}: {r.message}")
        print(f"{'='*60}")
        return failed == 0


# ── Helper ─────────────────────────────────────────────────────────────────

def timed_request(client: httpx.Client, method: str, url: str, **kwargs):
    """Make a request and return (response, duration_ms)."""
    t0 = time.monotonic()
    resp = client.request(method, url, **kwargs)
    dt = (time.monotonic() - t0) * 1000
    return resp, dt


# ── Test Categories ────────────────────────────────────────────────────────

def test_health(client: httpx.Client, suite: TestSuite):
    """Server health check."""
    print("\n── Health ──")
    resp, dt = timed_request(client, "GET", f"{API_BASE}/../health")
    suite.record("health_check", resp.status_code == 200, f"status={resp.status_code}", dt)


def test_vasp_tools(client: httpx.Client, suite: TestSuite):
    """VASP input generation tools."""
    print("\n── VASP Input Generation ──")

    # GET calculation types
    resp, dt = timed_request(client, "GET", f"{API_BASE}/vasp/calculation-types")
    suite.record("vasp_calc_types", resp.status_code == 200,
                 f"status={resp.status_code}", dt)

    # POST generate
    resp, dt = timed_request(client, "POST", f"{API_BASE}/vasp/generate", json={
        "structure": NACL_STRUCTURE,
        "calculation_type": "scf",
        "encut": 450,
        "kspacing": 0.04,
    })
    ok = resp.status_code == 200
    if ok:
        data = resp.json()
        has_incar = "incar" in data or "INCAR" in str(data)
        suite.record("vasp_generate_scf", has_incar,
                     f"status={resp.status_code}, has_incar={has_incar}", dt)
    else:
        suite.record("vasp_generate_scf", False, f"status={resp.status_code}: {resp.text[:200]}", dt)

    # POST generate opt
    resp, dt = timed_request(client, "POST", f"{API_BASE}/vasp/generate", json={
        "structure": SI_STRUCTURE,
        "calculation_type": "opt",
    })
    suite.record("vasp_generate_opt", resp.status_code == 200,
                 f"status={resp.status_code}", dt)


def test_qe_tools(client: httpx.Client, suite: TestSuite):
    """Quantum ESPRESSO input generation tools."""
    print("\n── QE Input Generation ──")

    # GET templates
    resp, dt = timed_request(client, "GET", f"{API_BASE}/qe/templates")
    suite.record("qe_templates", resp.status_code == 200,
                 f"status={resp.status_code}", dt)

    # POST input
    resp, dt = timed_request(client, "POST", f"{API_BASE}/qe/input", json={
        "structure": SI_STRUCTURE,
        "calculation": "scf",
        "ecutwfc": 60,
    })
    ok = resp.status_code == 200
    if ok:
        data = resp.json()
        has_input = "input_file" in data or "input" in str(data).lower()
        suite.record("qe_generate_scf", has_input,
                     f"status={resp.status_code}", dt)
    else:
        suite.record("qe_generate_scf", False, f"status={resp.status_code}: {resp.text[:200]}", dt)


def test_lammps_tools(client: httpx.Client, suite: TestSuite):
    """LAMMPS input generation tools."""
    print("\n── LAMMPS Input Generation ──")

    # GET pair_styles
    resp, dt = timed_request(client, "GET", f"{API_BASE}/lammps/pair_styles")
    suite.record("lammps_pair_styles", resp.status_code == 200,
                 f"status={resp.status_code}", dt)

    # POST input
    resp, dt = timed_request(client, "POST", f"{API_BASE}/lammps/input", json={
        "structure": NACL_STRUCTURE,
        "simulation_type": "minimize",
        "pair_style": "lj/cut",
    })
    ok = resp.status_code == 200
    if ok:
        data = resp.json()
        suite.record("lammps_generate_minimize", True,
                     f"status={resp.status_code}", dt)
    else:
        suite.record("lammps_generate_minimize", False,
                     f"status={resp.status_code}: {resp.text[:200]}", dt)

    # POST validate
    resp, dt = timed_request(client, "POST", f"{API_BASE}/lammps/validate", json={
        "structure": NACL_STRUCTURE,
        "simulation_type": "minimize",
        "pair_style": "lj/cut",
    })
    suite.record("lammps_validate", resp.status_code == 200,
                 f"status={resp.status_code}", dt)


def test_build_tools(client: httpx.Client, suite: TestSuite):
    """Structure building tools (doping, water, passivation)."""
    print("\n── Build Tools ──")

    # Doping
    resp, dt = timed_request(client, "POST", f"{API_BASE}/build/doping", json={
        "structure": NACL_STRUCTURE,
        "dopant": "K",
        "host_element": "Na",
        "concentration": 1,
    })
    ok = resp.status_code == 200
    if ok:
        data = resp.json()
        has_structure = "structure" in data or "structures" in data
        suite.record("doping_Na_to_K", has_structure,
                     f"status={resp.status_code}, has_structure={has_structure}", dt)
    else:
        suite.record("doping_Na_to_K", False,
                     f"status={resp.status_code}: {resp.text[:200]}", dt)

    # Water layer
    resp, dt = timed_request(client, "POST", f"{API_BASE}/water-layer/add", json={
        "structure": NACL_SLAB,
        "params": {
            "z_start": 5.0,
            "z_end": 15.0,
            "min_distance": 2.0,
        },
    })
    ok = resp.status_code == 200
    if ok:
        data = resp.json()
        suite.record("water_layer", True,
                     f"n_water={data.get('n_water_molecules', '?')}", dt)
    else:
        suite.record("water_layer", False,
                     f"status={resp.status_code}: {resp.text[:200]}", dt)

    # Adsorption sites
    resp, dt = timed_request(client, "POST", f"{API_BASE}/adsorption/sites", json={
        "structure": NACL_SLAB,
    })
    ok = resp.status_code == 200
    if ok:
        data = resp.json()
        n_sites = len(data.get("sites", []))
        suite.record("adsorption_sites", n_sites >= 0,
                     f"found {n_sites} sites", dt)
    else:
        # Adsorption may legitimately fail for non-slab structures
        suite.record("adsorption_sites", False,
                     f"status={resp.status_code}: {resp.text[:200]}", dt)

    # Passivation (needs bulk reference)
    resp, dt = timed_request(client, "POST", f"{API_BASE}/pseudo-hydrogen/passivate", json={
        "slab": NACL_SLAB,
        "bulk": NACL_STRUCTURE,
    })
    # May fail for NaCl (ionic, not ideal for passivation) but endpoint should respond
    suite.record("passivation_endpoint", resp.status_code in (200, 400, 422),
                 f"status={resp.status_code}", dt)


def test_structure_ops(client: httpx.Client, suite: TestSuite):
    """Structure manipulation endpoints (atom ops, supercell, slab)."""
    print("\n── Structure Operations ──")

    # Add atom
    resp, dt = timed_request(client, "POST", f"{API_BASE}/structure-ops/add-atom", json={
        "structure": SI_STRUCTURE,
        "element": "H",
        "position": [0.0, 0.0, 3.0],
    })
    suite.record("add_atom", resp.status_code == 200,
                 f"status={resp.status_code}", dt)

    # Delete atoms
    resp, dt = timed_request(client, "POST", f"{API_BASE}/structure-ops/delete-atoms", json={
        "structure": NACL_STRUCTURE,
        "indices": [0],
    })
    suite.record("delete_atoms", resp.status_code == 200,
                 f"status={resp.status_code}", dt)

    # Supercell (uses "scaling" array, not na/nb/nc)
    resp, dt = timed_request(client, "POST", f"{API_BASE}/structure-ops/supercell", json={
        "structure": SI_STRUCTURE,
        "scaling": [2, 2, 2],
    })
    ok = resp.status_code == 200
    if ok:
        data = resp.json()
        struct = data.get("structure", data)
        n_sites = len(struct.get("sites", []))
        suite.record("supercell_2x2x2", n_sites == 16,
                     f"sites={n_sites} (expected 16)", dt)
    else:
        suite.record("supercell_2x2x2", False,
                     f"status={resp.status_code}: {resp.text[:200]}", dt)

    # Slab (uses miller_index array + min_slab_size/min_vacuum_size)
    resp, dt = timed_request(client, "POST", f"{API_BASE}/structure-ops/generate-slab", json={
        "structure": NACL_STRUCTURE,
        "miller_index": [1, 0, 0],
        "min_slab_size": 10.0,
        "min_vacuum_size": 15.0,
    })
    suite.record("cut_slab_100", resp.status_code == 200,
                 f"status={resp.status_code}", dt)


def test_mcp_discovery_tools(client: httpx.Client, suite: TestSuite):
    """Discovery/GET endpoints used by MCP tools."""
    print("\n── MCP Discovery Tools ──")

    endpoints = [
        ("vasp_calc_types", "GET", "/vasp/calculation-types"),
        ("qe_templates", "GET", "/qe/templates"),
        ("lammps_pair_styles", "GET", "/lammps/pair_styles"),
    ]

    for name, method, path in endpoints:
        resp, dt = timed_request(client, method, f"{API_BASE}{path}")
        ok = resp.status_code == 200
        if ok:
            data = resp.json()
            suite.record(f"mcp_{name}", True,
                         f"keys={list(data.keys()) if isinstance(data, dict) else len(data)}", dt)
        else:
            suite.record(f"mcp_{name}", False,
                         f"status={resp.status_code}", dt)


def test_analysis_sessions(client: httpx.Client, suite: TestSuite):
    """Analysis session endpoints (DOS, Bands, COHP) — tests session lifecycle.

    Note: These require actual VASP output files. We test that the endpoints
    respond correctly even without valid files (expected 400/422 for bad input).
    """
    print("\n── Analysis Session Endpoints ──")

    # DOS upload - should reject without a valid file
    resp, dt = timed_request(client, "POST", f"{API_BASE}/dos/upload",
                              files={"file": ("test.h5", b"not a real file", "application/octet-stream")})
    suite.record("dos_upload_reject_invalid",
                 resp.status_code in (400, 422, 500),
                 f"status={resp.status_code} (expected rejection of invalid file)", dt)

    # Bands upload - should reject without a valid file
    resp, dt = timed_request(client, "POST", f"{API_BASE}/bands/upload",
                              files={"file": ("vasprun.xml", b"<xml>invalid</xml>", "text/xml")})
    suite.record("bands_upload_reject_invalid",
                 resp.status_code in (400, 422, 500),
                 f"status={resp.status_code} (expected rejection of invalid file)", dt)

    # COHP upload - should reject without a valid file
    resp, dt = timed_request(client, "POST", f"{API_BASE}/cohp/upload-cohpcar",
                              files={"file": ("COHPCAR.lobster", b"invalid data", "application/octet-stream")})
    suite.record("cohp_upload_reject_invalid",
                 resp.status_code in (400, 422, 500),
                 f"status={resp.status_code} (expected rejection of invalid file)", dt)

    # DOS compute - should reject without valid session
    resp, dt = timed_request(client, "POST", f"{API_BASE}/dos/compute", json={
        "session_id": "nonexistent-session-id",
        "groups": [{"atoms": [0], "channels": ["s"], "label": "test"}],
    })
    suite.record("dos_compute_reject_no_session",
                 resp.status_code in (404, 400, 422),
                 f"status={resp.status_code} (expected session not found)", dt)

    # Bands data - should reject without valid session
    resp, dt = timed_request(client, "POST", f"{API_BASE}/bands/data", json={
        "session_id": "nonexistent-session-id",
    })
    suite.record("bands_data_reject_no_session",
                 resp.status_code in (404, 400, 422),
                 f"status={resp.status_code} (expected session not found)", dt)


def test_md_analysis(client: httpx.Client, suite: TestSuite):
    """MD analysis endpoints — stateless, accept trajectory data directly."""
    print("\n── MD Analysis ──")

    # RDF requires trajectory data - test that endpoint exists and validates
    resp, dt = timed_request(client, "POST", f"{API_BASE}/md/distances/rdf", json={
        "trajectory": {},
        "params": {"r_max": 10.0, "n_bins": 100},
    })
    suite.record("md_rdf_endpoint_exists",
                 resp.status_code in (200, 400, 422),
                 f"status={resp.status_code}", dt)

    # RMSD (endpoint is /md/rmsd/rmsd)
    resp, dt = timed_request(client, "POST", f"{API_BASE}/md/rmsd/rmsd", json={
        "trajectory_b64": "",
        "format": "xyz",
    })
    suite.record("md_rmsd_endpoint_exists",
                 resp.status_code in (200, 400, 422),
                 f"status={resp.status_code}", dt)

    # H-bonds
    resp, dt = timed_request(client, "POST", f"{API_BASE}/md/hbonds/detect", json={
        "trajectory": {},
    })
    suite.record("md_hbonds_endpoint_exists",
                 resp.status_code in (200, 400, 422),
                 f"status={resp.status_code}", dt)

    # Clustering (endpoint is /md/clustering/rmsd-cluster)
    resp, dt = timed_request(client, "POST", f"{API_BASE}/md/clustering/rmsd-cluster", json={
        "trajectory_b64": "",
        "format": "xyz",
        "method": "dbscan",
    })
    suite.record("md_clustering_endpoint_exists",
                 resp.status_code in (200, 400, 422),
                 f"status={resp.status_code}", dt)


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    verbose = "-v" in sys.argv or "--verbose" in sys.argv
    keyword = None
    for i, arg in enumerate(sys.argv):
        if arg == "-k" and i + 1 < len(sys.argv):
            keyword = sys.argv[i + 1].lower()

    suite = TestSuite(verbose=verbose)

    # Check server first
    try:
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(f"{API_BASE}/../health")
            if resp.status_code != 200:
                print(f"Server not healthy: {resp.status_code}")
                sys.exit(1)
    except httpx.ConnectError:
        print("Backend server not running at localhost:8000")
        print("Start it with: conda run -n catgo python -m uvicorn server.main:app --reload")
        sys.exit(1)

    print(f"CatBot Tools E2E Tests")
    print(f"{'='*60}")

    test_functions = [
        ("health", test_health),
        ("vasp", test_vasp_tools),
        ("qe", test_qe_tools),
        ("lammps", test_lammps_tools),
        ("build", test_build_tools),
        ("structure", test_structure_ops),
        ("mcp", test_mcp_discovery_tools),
        ("analysis", test_analysis_sessions),
        ("md", test_md_analysis),
    ]

    with httpx.Client(timeout=TIMEOUT) as client:
        for name, func in test_functions:
            if keyword and keyword not in name:
                continue
            try:
                func(client, suite)
            except Exception as e:
                suite.record(f"{name}_CRASH", False, f"Exception: {e}")
                if verbose:
                    traceback.print_exc()

    ok = suite.summary()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
