"""Shared fixtures for CatGo server tests.

Provides common test infrastructure: FastAPI TestClient, sample structures
(FCC Cu crystal and H2O molecule) used across all test modules.
"""

import sys
from pathlib import Path

import pytest

# Ensure server/ is on sys.path so `main`, `routers`, etc. are importable
_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)


def pytest_configure(config):
    """Register custom markers used across the test suite."""
    config.addinivalue_line("markers", "unit: fast, isolated unit tests")
    config.addinivalue_line("markers", "slow: tests that may take several seconds (e.g. large supercells)")
    config.addinivalue_line("markers", "integration: tests requiring external services or full app stack")


@pytest.fixture(scope="session")
def app():
    """Import and return the FastAPI application instance.

    Session-scoped so the app is only created once per test run.
    """
    from main import app as _app
    return _app


@pytest.fixture(scope="session")
def client(app):
    """Create a Starlette/httpx TestClient bound to the FastAPI app.

    Session-scoped to reuse the same client across all tests, avoiding
    repeated startup/shutdown overhead.
    """
    from starlette.testclient import TestClient
    with TestClient(app) as c:
        yield c


@pytest.fixture
def cu_structure():
    """Return an FCC Cu structure (4 atoms, a=3.615 A) as a pymatgen-compatible dict.

    This is a standard cubic unit cell suitable for testing periodic
    structure operations like supercell, defect creation, and strain.
    """
    a = 3.615  # Cu lattice parameter in Angstroms
    return {
        "@module": "pymatgen.core.structure",
        "@class": "Structure",
        "charge": 0,
        "lattice": {
            "@module": "pymatgen.core.lattice",
            "@class": "Lattice",
            "matrix": [[a, 0, 0], [0, a, 0], [0, 0, a]],
            "pbc": [True, True, True],
            "a": a, "b": a, "c": a,
            "alpha": 90, "beta": 90, "gamma": 90,
            "volume": a**3,
        },
        "sites": [
            {"species": [{"element": "Cu", "occu": 1}], "abc": [0.0, 0.0, 0.0], "xyz": [0.0, 0.0, 0.0], "label": "Cu", "properties": {}},
            {"species": [{"element": "Cu", "occu": 1}], "abc": [0.5, 0.5, 0.0], "xyz": [a/2, a/2, 0.0], "label": "Cu", "properties": {}},
            {"species": [{"element": "Cu", "occu": 1}], "abc": [0.5, 0.0, 0.5], "xyz": [a/2, 0.0, a/2], "label": "Cu", "properties": {}},
            {"species": [{"element": "Cu", "occu": 1}], "abc": [0.0, 0.5, 0.5], "xyz": [0.0, a/2, a/2], "label": "Cu", "properties": {}},
        ],
    }


@pytest.fixture
def h2o_molecule():
    """Return a simple H2O molecule (3 atoms) as a pymatgen-compatible dict.

    Non-periodic structure useful for testing molecular operations
    and ensuring endpoints correctly distinguish molecules from crystals.
    """
    return {
        "@module": "pymatgen.core.structure",
        "@class": "Molecule",
        "charge": 0,
        "spin_multiplicity": 1,
        "sites": [
            {"species": [{"element": "O", "occu": 1}], "xyz": [0.0, 0.0, 0.0], "label": "O", "properties": {}},
            {"species": [{"element": "H", "occu": 1}], "xyz": [0.757, 0.586, 0.0], "label": "H", "properties": {}},
            {"species": [{"element": "H", "occu": 1}], "xyz": [-0.757, 0.586, 0.0], "label": "H", "properties": {}},
        ],
    }
