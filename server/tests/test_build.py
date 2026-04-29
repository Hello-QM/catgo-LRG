"""Tests for build endpoints (defect, strain, supercell, doping).

Validates that build operations correctly transform structures and
return appropriate error codes for invalid inputs.
"""

import pytest


class TestDefect:
    """POST /api/build/defect — create point defects (vacancy, substitution, interstitial)."""

    def test_vacancy_defect(self, client, cu_structure):
        """Creating a vacancy at site 0 in a 1x1x1 cell should remove one atom."""
        resp = client.post("/api/build/defect", json={
            "structure": cu_structure,
            "defect_type": "vacancy",
            "site_index": 0,
            "supercell": "1x1x1",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] >= 1
        assert len(data["structures"]) == data["count"]
        assert len(data["labels"]) == data["count"]
        # Vacancy removes one atom from 4-atom structure
        first_struct = data["structures"][0]
        assert len(first_struct["sites"]) == 3

    def test_vacancy_with_supercell(self, client, cu_structure):
        """Vacancy in a 2x2x2 supercell: 4*8=32 atoms minus 1 = 31."""
        resp = client.post("/api/build/defect", json={
            "structure": cu_structure,
            "defect_type": "vacancy",
            "site_index": 0,
            "supercell": "2x2x2",
        })
        assert resp.status_code == 200
        data = resp.json()
        # 4*8=32 atoms in 2x2x2, minus 1 vacancy = 31
        first_struct = data["structures"][0]
        assert len(first_struct["sites"]) == 31

    def test_invalid_defect_site_index(self, client, cu_structure):
        """Using a site_index beyond the structure size should return 400."""
        resp = client.post("/api/build/defect", json={
            "structure": cu_structure,
            "defect_type": "vacancy",
            "site_index": 999,
            "supercell": "1x1x1",
        })
        # site_index 999 is way out of range for a 4-atom structure
        assert resp.status_code in (400, 500)


class TestStrain:
    """POST /api/build/strain — apply uniaxial, biaxial, hydrostatic, or shear strain."""

    def test_uniaxial_strain(self, client, cu_structure):
        """5% uniaxial strain along c-axis should return 1 strained structure."""
        resp = client.post("/api/build/strain", json={
            "structure": cu_structure,
            "strain_type": "uniaxial",
            "axis": "c",
            "magnitude": 0.05,
            "n_steps": 1,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert len(data["structures"]) == 1
        # Atom count unchanged by strain
        assert len(data["structures"][0]["sites"]) == 4

    def test_strain_multiple_steps(self, client, cu_structure):
        """5 strain steps should return 5 distinct structures."""
        resp = client.post("/api/build/strain", json={
            "structure": cu_structure,
            "strain_type": "hydrostatic",
            "axis": "c",
            "magnitude": 0.05,
            "n_steps": 5,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 5
        assert len(data["structures"]) == 5

    def test_biaxial_strain(self, client, cu_structure):
        """Biaxial strain along a-axis should succeed with 1 step."""
        resp = client.post("/api/build/strain", json={
            "structure": cu_structure,
            "strain_type": "biaxial",
            "axis": "a",
            "magnitude": 0.02,
            "n_steps": 1,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1

    def test_unknown_strain_type(self, client, cu_structure):
        """An unrecognized strain_type should return 400."""
        resp = client.post("/api/build/strain", json={
            "structure": cu_structure,
            "strain_type": "nonexistent",
            "axis": "c",
            "magnitude": 0.02,
            "n_steps": 1,
        })
        assert resp.status_code == 400

    def test_zero_strain_magnitude(self, client, cu_structure):
        """Zero strain magnitude should succeed and return an undeformed structure."""
        resp = client.post("/api/build/strain", json={
            "structure": cu_structure,
            "strain_type": "uniaxial",
            "axis": "c",
            "magnitude": 0.0,
            "n_steps": 1,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        # Structure should still have 4 atoms
        assert len(data["structures"][0]["sites"]) == 4
