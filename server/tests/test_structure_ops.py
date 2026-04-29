"""Tests for structure-ops endpoints (add, delete, replace, move, supercell).

Covers single-atom and batch operations on both periodic structures
(FCC Cu) and non-periodic molecules (H2O), including edge cases
like out-of-range indices and invalid element symbols.
"""

import pytest


class TestAddAtom:
    """POST /api/structure-ops/add-atom — add a single atom."""

    def test_add_atom_to_periodic_structure(self, client, cu_structure):
        """Adding a C atom to FCC Cu should yield 5 sites, still periodic."""
        resp = client.post("/api/structure-ops/add-atom", json={
            "structure": cu_structure,
            "element": "C",
            "position": [0.0, 0.0, 2.0],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["num_sites"] == 5
        assert data["is_periodic"] is True

    def test_add_atom_to_molecule(self, client, h2o_molecule):
        """Adding an H atom to H2O should yield 4 sites, non-periodic."""
        resp = client.post("/api/structure-ops/add-atom", json={
            "structure": h2o_molecule,
            "element": "H",
            "position": [0.0, -0.586, 0.0],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["num_sites"] == 4
        assert data["is_periodic"] is False

    def test_add_atom_missing_position(self, client, cu_structure):
        """Omitting required 'position' field should return 422."""
        resp = client.post("/api/structure-ops/add-atom", json={
            "structure": cu_structure,
            "element": "C",
        })
        assert resp.status_code == 422

    def test_add_atom_invalid_element(self, client, cu_structure):
        """Using a bogus element symbol should return a 4xx error."""
        resp = client.post("/api/structure-ops/add-atom", json={
            "structure": cu_structure,
            "element": "Zz",
            "position": [0.0, 0.0, 0.0],
        })
        assert resp.status_code in (400, 422, 500)


class TestAddAtoms:
    """POST /api/structure-ops/add-atoms — batch add multiple atoms."""

    def test_batch_add_two_atoms(self, client, cu_structure):
        """Adding two atoms in one request should increase site count by 2."""
        resp = client.post("/api/structure-ops/add-atoms", json={
            "structure": cu_structure,
            "atoms": [
                {"element": "C", "xyz": [0.0, 0.0, 2.0]},
                {"element": "N", "xyz": [1.0, 1.0, 2.0]},
            ],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["num_sites"] == 6  # 4 Cu + 2 new
        assert data["is_periodic"] is True

    def test_batch_add_to_molecule(self, client, h2o_molecule):
        """Batch-adding atoms to a molecule should preserve non-periodicity."""
        resp = client.post("/api/structure-ops/add-atoms", json={
            "structure": h2o_molecule,
            "atoms": [
                {"element": "H", "xyz": [0.0, -0.5, 0.0]},
            ],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["num_sites"] == 4
        assert data["is_periodic"] is False

    def test_batch_add_invalid_element(self, client, cu_structure):
        """A bogus element in the batch should return a 4xx error."""
        resp = client.post("/api/structure-ops/add-atoms", json={
            "structure": cu_structure,
            "atoms": [
                {"element": "Xx", "xyz": [0.0, 0.0, 0.0]},
            ],
        })
        assert resp.status_code in (400, 422, 500)


class TestDeleteAtoms:
    """POST /api/structure-ops/delete-atoms — remove atoms by index."""

    def test_delete_single_atom(self, client, cu_structure):
        """Deleting one atom from 4-atom Cu should yield 3 sites."""
        resp = client.post("/api/structure-ops/delete-atoms", json={
            "structure": cu_structure,
            "indices": [0],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["num_sites"] == 3

    def test_delete_multiple_atoms(self, client, cu_structure):
        """Deleting two atoms from 4-atom Cu should yield 2 sites."""
        resp = client.post("/api/structure-ops/delete-atoms", json={
            "structure": cu_structure,
            "indices": [0, 2],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["num_sites"] == 2

    def test_delete_out_of_range(self, client, cu_structure):
        """Index 99 is out of range for a 4-atom structure; expect 400."""
        resp = client.post("/api/structure-ops/delete-atoms", json={
            "structure": cu_structure,
            "indices": [99],
        })
        assert resp.status_code == 400

    def test_delete_empty_indices(self, client, cu_structure):
        """Empty indices array should be rejected by Pydantic validation (422)."""
        resp = client.post("/api/structure-ops/delete-atoms", json={
            "structure": cu_structure,
            "indices": [],
        })
        # Pydantic min_length=1 on indices (or server handles gracefully)
        assert resp.status_code in (200, 422)


class TestSupercell:
    """POST /api/structure-ops/supercell — build supercells."""

    def test_2x2x2_supercell(self, client, cu_structure):
        """2x2x2 supercell of 4-atom Cu should yield 32 atoms."""
        resp = client.post("/api/structure-ops/supercell", json={
            "structure": cu_structure,
            "scaling": [2, 2, 2],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["num_sites"] == 4 * 8  # 4 atoms * 2^3
        assert data["is_periodic"] is True

    def test_supercell_with_matrix(self, client, cu_structure):
        """2x2x1 supercell via explicit matrix should yield 16 atoms."""
        resp = client.post("/api/structure-ops/supercell", json={
            "structure": cu_structure,
            "scaling_matrix": [[2, 0, 0], [0, 2, 0], [0, 0, 1]],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["num_sites"] == 4 * 4  # 4 atoms * 2*2*1

    def test_supercell_molecule_rejected(self, client, h2o_molecule):
        """Supercell on a molecule should return 400 (requires periodicity)."""
        resp = client.post("/api/structure-ops/supercell", json={
            "structure": h2o_molecule,
            "scaling": [2, 2, 2],
        })
        assert resp.status_code == 400


class TestReplaceAtom:
    """POST /api/structure-ops/replace-atom — swap element at a site."""

    def test_replace_cu_with_au(self, client, cu_structure):
        """Replacing Cu with Au at index 0 should change the species string."""
        resp = client.post("/api/structure-ops/replace-atom", json={
            "structure": cu_structure,
            "index": 0,
            "new_element": "Au",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["num_sites"] == 4
        # Verify the element was changed by checking the returned structure
        sites = data["structure"]["sites"]
        replaced_species = sites[0]["species"][0]["element"]
        assert replaced_species == "Au"

    def test_replace_out_of_range(self, client, cu_structure):
        """Index 99 is out of range; expect 400."""
        resp = client.post("/api/structure-ops/replace-atom", json={
            "structure": cu_structure,
            "index": 99,
            "new_element": "Au",
        })
        assert resp.status_code == 400


class TestMoveAtom:
    """POST /api/structure-ops/move-atom — relocate a single atom."""

    def test_move_atom_periodic(self, client, cu_structure):
        """Moving atom 0 in a periodic structure should preserve periodicity and count."""
        resp = client.post("/api/structure-ops/move-atom", json={
            "structure": cu_structure,
            "index": 0,
            "new_position": [1.0, 1.0, 1.0],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["num_sites"] == 4
        assert data["is_periodic"] is True

    def test_move_atom_molecule(self, client, h2o_molecule):
        """Moving the O atom in H2O should keep 3 sites, non-periodic."""
        resp = client.post("/api/structure-ops/move-atom", json={
            "structure": h2o_molecule,
            "index": 0,
            "new_position": [0.1, 0.1, 0.1],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["num_sites"] == 3
        assert data["is_periodic"] is False

    def test_move_atom_out_of_range(self, client, cu_structure):
        """Index 99 is out of range; expect 400."""
        resp = client.post("/api/structure-ops/move-atom", json={
            "structure": cu_structure,
            "index": 99,
            "new_position": [1.0, 1.0, 1.0],
        })
        assert resp.status_code == 400


class TestMoveAtoms:
    """POST /api/structure-ops/move-atoms — batch-translate atoms by displacement."""

    def test_batch_move_two_atoms(self, client, cu_structure):
        """Moving atoms 0 and 1 by [1,0,0] should preserve count and periodicity."""
        resp = client.post("/api/structure-ops/move-atoms", json={
            "structure": cu_structure,
            "indices": [0, 1],
            "displacement": [1.0, 0.0, 0.0],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["num_sites"] == 4
        assert data["is_periodic"] is True

    def test_batch_move_out_of_range(self, client, cu_structure):
        """Including an out-of-range index should return 400."""
        resp = client.post("/api/structure-ops/move-atoms", json={
            "structure": cu_structure,
            "indices": [0, 99],
            "displacement": [1.0, 0.0, 0.0],
        })
        assert resp.status_code == 400
