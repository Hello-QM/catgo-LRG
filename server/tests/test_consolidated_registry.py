import sys, pytest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import httpx
from tests._mcp_fixtures import load_cif_as_dict, TIO2_CIF

LIVE = "http://localhost:8000/api"

def _backend_up() -> bool:
    try:
        return httpx.get(LIVE.replace("/api", "/"), timeout=2).status_code == 200
    except Exception:
        return False

requires_backend = pytest.mark.skipif(not _backend_up(), reason="backend :8000 not running")

@requires_backend
@pytest.mark.asyncio
async def test_structure_defect_creates_vacancy():
    from catgo.mcp_tools.server_claude_code import _handle_structure
    struct = load_cif_as_dict(TIO2_CIF)
    async with httpx.AsyncClient(timeout=60) as c:
        out = await _handle_structure(c, {
            "action": "defect", "structure": struct,
            "defect_type": "vacancy", "site_index": 0, "supercell": "1x1x1",
        })
    text = out[0].text.lower()
    assert "defect" in text or "vacanc" in text or "atoms" in text
    assert "viewer updated" in text  # success marker; guards against the "Unknown action" echo
    assert "failed" not in text and "error" not in text and "unknown action" not in text


@requires_backend
@pytest.mark.asyncio
async def test_structure_strain_changes_lattice():
    from catgo.mcp_tools.server_claude_code import _handle_structure
    struct = load_cif_as_dict(TIO2_CIF)
    async with httpx.AsyncClient(timeout=60) as c:
        out = await _handle_structure(c, {
            "action": "strain", "structure": struct,
            "strain_type": "hydrostatic", "magnitude": 0.05, "n_steps": 1,
        })
    text = out[0].text.lower()
    assert "strain" in text and "failed" not in text and "viewer updated" in text


@requires_backend
@pytest.mark.asyncio
async def test_structure_water_layer_adds_water():
    from catgo.mcp_tools.server_claude_code import _handle_structure
    struct = load_cif_as_dict(TIO2_CIF)
    async with httpx.AsyncClient(timeout=120) as c:
        out = await _handle_structure(c, {
            "action": "water_layer", "structure": struct,
            "params": {"z_start": 0.0, "z_end": 12.0, "density": 0.997},
        })
    text = out[0].text.lower()
    assert "h2o" in text and "failed" not in text


@requires_backend
@pytest.mark.asyncio
async def test_structure_passivate_adds_pseudo_h():
    """Real slab+bulk pair: cut a TiO2(110) slab from TiO2 bulk, then passivate."""
    from catgo.mcp_tools.server_claude_code import _handle_structure
    bulk = load_cif_as_dict(TIO2_CIF)
    async with httpx.AsyncClient(timeout=120) as c:
        slab_resp = await c.post(
            f"{LIVE}/structure-ops/generate-slab",
            json={"structure": bulk, "miller_index": [1, 1, 0],
                  "min_slab_size": 6.0, "min_vacuum_size": 12.0},
        )
        assert slab_resp.status_code == 200, slab_resp.text
        slab = slab_resp.json()["slabs"][0]
        out = await _handle_structure(c, {
            "action": "passivate", "slab": slab, "bulk": bulk,
        })
    text = out[0].text.lower()
    assert "passivate" in text and "pseudo-h" in text
    assert "failed" not in text and "viewer updated" in text


@requires_backend
@pytest.mark.asyncio
async def test_analyze_calculators_lists():
    from catgo.mcp_tools.server_claude_code import _handle_analyze
    async with httpx.AsyncClient(timeout=30) as c:
        out = await _handle_analyze(c, {"action": "calculators"})
    text = out[0].text
    assert "calculators" in text
    # guard against the "Unknown analyze action 'calculators'. Valid: ..." echo,
    # which also contains the word "calculators"
    assert "unknown analyze action" not in text.lower()


@requires_backend
@pytest.mark.asyncio
async def test_analyze_energy_returns_number():
    from catgo.mcp_tools.server_claude_code import _handle_analyze
    from tests._mcp_fixtures import load_cif_as_dict, TIO2_CIF
    async with httpx.AsyncClient(timeout=120) as c:
        out = await _handle_analyze(c, {
            "action": "energy", "structure": load_cif_as_dict(TIO2_CIF), "model": "mace",
        })
    text = out[0].text
    assert "energy" in text.lower() and "failed" not in text.lower()
    # guard against the "Unknown analyze action 'energy'. Valid: ..." echo,
    # which also contains the word "energy"
    assert "unknown analyze action" not in text.lower()
