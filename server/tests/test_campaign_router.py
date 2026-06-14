"""POST /api/campaign/new scaffolds an md-orchestration campaign on disk."""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from catgo.routers.campaign import router


def _client():
    app = FastAPI()
    app.include_router(router, prefix="/api")
    return TestClient(app)


def test_create_campaign_scaffolds_saa_her(tmp_path):
    r = _client().post("/api/campaign/new", json={
        "name": "SAA HER", "base": str(tmp_path), "template": "saa_her"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["ok"] is True
    root = tmp_path / "SAA-HER"                    # readable slug, never a hash
    assert (root / "plan.md").is_file()
    assert (root / "calc" / "02-activity-dGH" / "INDEX.md").is_file()
    assert data["path"].endswith("SAA-HER")
    assert data["template"] == "saa_her"


def test_create_campaign_blank_default(tmp_path):
    r = _client().post("/api/campaign/new", json={
        "name": "My Study", "base": str(tmp_path)})
    assert r.status_code == 200
    assert (tmp_path / "My-Study" / "README.md").is_file()


def test_bad_template_is_400(tmp_path):
    r = _client().post("/api/campaign/new", json={
        "name": "x", "base": str(tmp_path), "template": "bogus"})
    assert r.status_code == 400


def test_empty_name_is_400(tmp_path):
    r = _client().post("/api/campaign/new", json={
        "name": "   ", "base": str(tmp_path)})
    assert r.status_code == 400
