"""
Phase 2 AnalyzerPlugin — automated tests (pytest-compatible).

Usage:
    # Standalone:
    #    python tests/test_phase2_analyzer.py
    #
    # Pytest:
    #    SERVER_PORT=8000 python -m pytest tests/test_phase2_analyzer.py -v
"""

import json
import os
import sys

import pytest

try:
    import requests
except ImportError:
    pytest.skip("requests not installed", allow_module_level=True)

PORT = int(os.environ.get("SERVER_PORT", 8000))
BASE = f"http://localhost:{PORT}/api"

# ─── Test structures ─────────────────────────────────────────────

CU_FCC = {
    "@module": "pymatgen.core.structure",
    "@class": "Structure",
    "lattice": {
        "matrix": [
            [0.0, 1.805, 1.805],
            [1.805, 0.0, 1.805],
            [1.805, 1.805, 0.0],
        ]
    },
    "sites": [
        {
            "species": [{"element": "Cu", "occu": 1}],
            "abc": [0.0, 0.0, 0.0],
            "xyz": [0.0, 0.0, 0.0],
        }
    ],
}

TIO2_RUTILE = {
    "@module": "pymatgen.core.structure",
    "@class": "Structure",
    "lattice": {
        "matrix": [
            [4.584, 0.0, 0.0],
            [0.0, 4.584, 0.0],
            [0.0, 0.0, 2.953],
        ]
    },
    "sites": [
        {"species": [{"element": "Ti", "occu": 1}], "abc": [0.0, 0.0, 0.0], "xyz": [0.0, 0.0, 0.0]},
        {"species": [{"element": "Ti", "occu": 1}], "abc": [0.5, 0.5, 0.5], "xyz": [2.292, 2.292, 1.4765]},
        {"species": [{"element": "O", "occu": 1}], "abc": [0.3053, 0.3053, 0.0], "xyz": [1.3995, 1.3995, 0.0]},
        {"species": [{"element": "O", "occu": 1}], "abc": [0.6947, 0.6947, 0.0], "xyz": [3.1845, 3.1845, 0.0]},
        {"species": [{"element": "O", "occu": 1}], "abc": [0.1947, 0.8053, 0.5], "xyz": [0.8925, 3.6915, 1.4765]},
        {"species": [{"element": "O", "occu": 1}], "abc": [0.8053, 0.1947, 0.5], "xyz": [3.6915, 0.8925, 1.4765]},
    ],
}


def _server_available():
    try:
        requests.get(f"http://localhost:{PORT}/health", timeout=3)
        return True
    except Exception:
        return False


def _bond_histogram_available():
    """Check if the bond-histogram plugin is loaded."""
    if not _server_available():
        return False
    try:
        r = requests.get(f"{BASE}/plugins/", timeout=5)
        if r.status_code == 200:
            names = [p["name"] for p in r.json().get("plugins", [])]
            return "bond-histogram" in names
    except Exception:
        pass
    return False


pytestmark = pytest.mark.skipif(
    not _bond_histogram_available(),
    reason=f"bond-histogram plugin not available on port {PORT}",
)


class TestPhase2Analyzer:
    def test_health(self):
        r = requests.get(f"http://localhost:{PORT}/health", timeout=5)
        assert r.status_code == 200

    def test_plugins_list(self):
        r = requests.get(f"{BASE}/plugins/", timeout=5)
        assert r.status_code == 200
        data = r.json()
        names = [p["name"] for p in data["plugins"]]
        assert "bond-histogram" in names, f"bond-histogram not in: {names}"

    def test_analyzers_list(self):
        r = requests.get(f"{BASE}/plugins/analyzers", timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert "analyzers" in data
        assert data["total"] >= 1
        ids = [a["analyzer_id"] for a in data["analyzers"]]
        assert "bond_histogram" in ids
        bh = next(a for a in data["analyzers"] if a["analyzer_id"] == "bond_histogram")
        assert bh["output_type"] == "bar_plot"
        assert "input_schema" in bh
        assert "structure" in bh["input_schema"].get("properties", {})

    def test_run_analyzer_cu(self):
        r = requests.post(
            f"{BASE}/plugins/analyzers/bond_histogram/run",
            json={"structure": CU_FCC, "n_bins": 20, "max_distance": 3.0},
            timeout=30,
        )
        assert r.status_code == 200, f"status {r.status_code}: {r.text[:200]}"
        data = r.json()
        assert data["analyzer_id"] == "bond_histogram"
        assert data["output_type"] == "bar_plot"
        result = data["result"]
        assert "series" in result
        assert len(result["series"]) >= 1
        s = result["series"][0]
        assert isinstance(s["x"], list) and len(s["x"]) > 0
        assert isinstance(s["y"], list) and len(s["y"]) > 0
        assert len(s["x"]) == len(s["y"])
        assert any(y > 0 for y in s["y"])

    def test_run_analyzer_tio2(self):
        r = requests.post(
            f"{BASE}/plugins/analyzers/bond_histogram/run",
            json={"structure": TIO2_RUTILE, "n_bins": 50, "max_distance": 4.0},
            timeout=30,
        )
        assert r.status_code == 200
        data = r.json()
        result = data["result"]
        s = result["series"][0]
        assert len(s["x"]) == 50
        total_bonds = sum(s["y"])
        assert total_bonds > 0

    def test_run_analyzer_defaults(self):
        r = requests.post(
            f"{BASE}/plugins/analyzers/bond_histogram/run",
            json={"structure": TIO2_RUTILE},
            timeout=30,
        )
        assert r.status_code == 200
        data = r.json()
        result = data["result"]
        s = result["series"][0]
        assert len(s["x"]) == 30, f"default n_bins should be 30, got {len(s['x'])}"

    def test_analyzer_not_found(self):
        r = requests.post(
            f"{BASE}/plugins/analyzers/nonexistent_analyzer/run",
            json={"structure": CU_FCC},
            timeout=5,
        )
        assert r.status_code == 404

    def test_invalid_input(self):
        r = requests.post(
            f"{BASE}/plugins/analyzers/bond_histogram/run",
            json={"structure": {"invalid": True}},
            timeout=10,
        )
        assert r.status_code == 500

    def test_plugin_detail(self):
        r = requests.get(f"{BASE}/plugins/bond-histogram", timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == "bond-histogram"
        assert data["plugin_type"] == "analyzer"
        assert data["enabled"] is True
        assert data["extra"]["analyzer_id"] == "bond_histogram"
        assert data["extra"]["output_type"] == "bar_plot"


# ─── Standalone runner ────────────────────────────────────────────

if __name__ == "__main__":
    passed = 0
    failed = 0

    def _run_test(name, func):
        global passed, failed
        try:
            func()
            print(f"  PASS  {name}")
            passed += 1
        except AssertionError as e:
            print(f"  FAIL  {name}: {e}")
            failed += 1
        except requests.ConnectionError:
            print(f"  SKIP  {name}: backend not running (http://localhost:{PORT})")
            failed += 1
        except Exception as e:
            print(f"  FAIL  {name}: {type(e).__name__}: {e}")
            failed += 1

    print(f"\n{'='*60}")
    print(f" Phase 2 AnalyzerPlugin Tests")
    print(f" Backend: http://localhost:{PORT}")
    print(f"{'='*60}\n")

    try:
        requests.get(f"http://localhost:{PORT}/health", timeout=3)
    except requests.ConnectionError:
        print(f"ERROR: Backend not running on port {PORT}")
        sys.exit(1)

    suite = TestPhase2Analyzer()
    _run_test("1. Health check", suite.test_health)
    _run_test("2. Plugin list", suite.test_plugins_list)
    _run_test("3. Analyzers list", suite.test_analyzers_list)
    _run_test("4. Run analyzer - Cu FCC", suite.test_run_analyzer_cu)
    _run_test("5. Run analyzer - TiO2", suite.test_run_analyzer_tio2)
    _run_test("6. Default params", suite.test_run_analyzer_defaults)
    _run_test("7. Analyzer not found", suite.test_analyzer_not_found)
    _run_test("8. Invalid input", suite.test_invalid_input)
    _run_test("9. Plugin detail", suite.test_plugin_detail)

    print(f"\n{'─'*60}")
    print(f" Results: {passed} passed, {failed} failed")
    print(f"{'─'*60}\n")
    sys.exit(0 if failed == 0 else 1)
