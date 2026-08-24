"""Integration tests for the workflow quickbuild HTTP endpoints.

Validates that every registered recipe in ``_quickbuild_recipes`` builds a
workflow end-to-end through the FastAPI app — same code path the
:catgo_quickbuild MCP tool exercises, and the same path the UI button strip
in the workflow editor hits.

These tests run against a fully wired backend (TestClient drives the full
app), so a regression in any of:

  - recipe registry shape
  - workflow create endpoint
  - _push_workflow_navigate post-build hook
  - _handle_quickbuild's coercion of recipe → graph_json

shows up here instead of in a live CatBot prompt.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _disable_external_material_fetch(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep this backend integration test hermetic.

    OPTIMADE transport has its own tests.  Quickbuild only needs to prove that
    a failed optional prefetch still builds a valid workflow.
    """
    async def _not_found(*_args, **_kwargs):
        return None

    from catgo.mcp_tools import workflow_tools
    monkeypatch.setattr(workflow_tools, "_fetch_structure_by_mp_id", _not_found)


@pytest.fixture(scope="module")
def client() -> TestClient:
    # Tests run with cwd=server/ (pytest.ini's rootdir), so `main` resolves
    # to server/main.py — same module the production uvicorn target loads.
    from main import app
    return TestClient(app)


def test_quickbuild_recipes_endpoint_lists_all_recipes(client: TestClient) -> None:
    """GET /workflow/quickbuild/recipes returns the full registry, with
    each entry carrying id + label + node_count + edge_count.
    """
    resp = client.get("/api/workflow/quickbuild/recipes")
    assert resp.status_code == 200
    recipes = resp.json()
    ids = {r["id"] for r in recipes}
    # The eight stock recipes the UI surfaces.
    assert ids == {"HER", "OER", "ORR", "NRR", "CO2RR_2e", "NEB", "slow_growth", "DOS"}
    for r in recipes:
        assert isinstance(r["label"], str) and r["label"]
        assert isinstance(r["node_count"], int) and r["node_count"] >= 3
        assert isinstance(r["edge_count"], int) and r["edge_count"] >= 2


@pytest.mark.parametrize(
    "recipe",
    ["HER", "OER", "ORR", "NRR", "CO2RR_2e", "NEB", "slow_growth", "DOS"],
)
def test_quickbuild_post_builds_workflow_for_each_recipe(
    client: TestClient, recipe: str,
) -> None:
    """POST /workflow/quickbuild produces a workflow with the right shape
    for every recipe in the registry.
    """
    resp = client.post(
        "/api/workflow/quickbuild",
        json={"recipe": recipe, "material_id": "mp-126"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["ok"] is True
    assert data["workflow_id"], "expected a workflow id back"
    assert recipe in data["message"] or data["message"].startswith("Built ")


def test_quickbuild_rejects_unknown_recipe(client: TestClient) -> None:
    """Unknown recipe names must surface as an error message — the handler
    returns ok=False so the UI can show the failure inline.
    """
    resp = client.post(
        "/api/workflow/quickbuild",
        json={"recipe": "DOESNOTEXIST"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["ok"] is False
    assert "Unknown recipe" in data["message"]


def test_quickbuild_omits_material_id_falls_back_to_viewer(client: TestClient) -> None:
    """Skipping material_id should still succeed — the workflow then seeds
    its structure_input from the viewer's current panel.
    """
    resp = client.post(
        "/api/workflow/quickbuild",
        json={"recipe": "HER"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["ok"] is True
    assert data["workflow_id"]


def test_quickbuild_custom_name_used(client: TestClient) -> None:
    """The optional name parameter overrides the default 'Recipe (material)'
    title.
    """
    resp = client.post(
        "/api/workflow/quickbuild",
        json={"recipe": "DOS", "material_id": "mp-126", "name": "my-custom-dos-run"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["ok"] is True
    assert "my-custom-dos-run" in data["message"]


def test_run_api_blocks_surface_free_energy_without_clean_slab_relaxation(
    client: TestClient,
) -> None:
    """The API guard protects non-CatBot clients and visual-editor runs too."""
    graph = {
        "nodes": [
            {"id": "si", "type": "structure_input", "params": {}},
            {"id": "slab", "type": "slab_gen", "params": {}},
            {"id": "ads", "type": "adsorbate_place", "params": {}},
            {"id": "opt", "type": "geo_opt", "params": {}},
            {"id": "freq", "type": "freq", "params": {}},
            {"id": "fe", "type": "free_energy", "params": {}},
        ],
        "edges": [
            {"id": "e1", "from": "si", "to": "slab"},
            {"id": "e2", "from": "slab", "to": "ads"},
            {"id": "e3", "from": "ads", "to": "opt"},
            {"id": "e4", "from": "opt", "to": "freq"},
            {"id": "e5", "from": "freq", "to": "fe"},
        ],
    }
    created = client.post(
        "/api/workflow/",
        json={"name": "invalid-unrelaxed-slab", "graph_json": json.dumps(graph)},
    )
    assert created.status_code == 201, created.text

    run = client.post(
        f"/api/workflow/{created.json()['id']}/run",
        json={"execution_mode": "local"},
    )

    assert run.status_code == 409
    assert "does not consume a relaxed clean slab" in run.json()["detail"]
