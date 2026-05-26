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


# ---------------------------------------------------------------------------
# Task 3.1 — catgo_md trajectory analysis
# ---------------------------------------------------------------------------

# Actions verified green against the real 6-frame crystal fixture
# (mp-1184225.extxyz). These don't require water.
MD_CASES = [
    # fixture mp-1184225 is Fe3W (no oxygen) — use Fe so rdf finds atoms.
    ("rdf", {"selection_1": {"element": "Fe"}, "selection_2": {"element": "Fe"}}, ["r", "g_r"]),
    ("msd", {"timestep_ps": 1.0}, ["tau_ps", "msd_angstrom2"]),
    ("rmsd", {"ref_frame": 0}, ["rmsd_angstroms"]),
    ("rmsf", {}, ["rmsf_angstroms"]),
    ("clustering", {"method": "dbscan", "eps": 1.0}, ["labels", "n_clusters_found"]),
    ("dimreduce", {"method": "pca", "n_components": 2}, ["embedding"]),
    ("dihedrals", {"atom_quartets": [[0, 1, 2, 3]]}, ["dihedrals_deg"]),
    ("planar_density", {"plane": "xy"}, ["density", "x_edges"]),
    # hbonds/hbond_lifetime return a valid contract (empty results) on a
    # non-water crystal — the detector simply finds zero H-bonds, which is
    # correct behavior, so the JSON + required keys are still present.
    ("hbonds", {}, ["count_per_frame"]),
    ("hbond_lifetime", {}, ["autocorrelation"]),
]

# Actions whose handler is generic & correct, but whose functional test cannot
# be verified with the available crystal fixture — they hard-error (HTTP 400)
# because mp-1184225 has no O/H atoms. They need a WATER trajectory.
# The action stays in _MD_ROUTES / the tool; only the test is xfail'd.
MD_CASES_WATER = [
    ("water_orientation", {}, ["bin_centers_angstrom"]),
    ("cavitation", {}, ["delta_g_cav_eV"]),
]


@requires_backend
@pytest.mark.asyncio
@pytest.mark.parametrize("action,extra,keys", MD_CASES)
async def test_md_actions(action, extra, keys):
    import json as _j
    from catgo.mcp_tools.server_claude_code import _handle_md
    from tests._mcp_fixtures import trajectory_b64
    args = {"action": action, "trajectory_b64": trajectory_b64(), "format": "extxyz", **extra}
    async with httpx.AsyncClient(timeout=120) as c:
        out = await _handle_md(c, args)
    text = out[0].text
    assert "failed" not in text.lower(), text[:200]
    data = _j.loads(text)
    for k in keys:
        assert k in data, f"{action} result missing {k}"


@requires_backend
@pytest.mark.asyncio
@pytest.mark.xfail(reason="needs water trajectory fixture", strict=False)
@pytest.mark.parametrize("action,extra,keys", MD_CASES_WATER)
async def test_md_actions_water(action, extra, keys):
    import json as _j
    from catgo.mcp_tools.server_claude_code import _handle_md
    from tests._mcp_fixtures import trajectory_b64
    args = {"action": action, "trajectory_b64": trajectory_b64(), "format": "extxyz", **extra}
    async with httpx.AsyncClient(timeout=120) as c:
        out = await _handle_md(c, args)
    text = out[0].text
    assert "failed" not in text.lower(), text[:200]
    data = _j.loads(text)
    for k in keys:
        assert k in data, f"{action} result missing {k}"


# ---------------------------------------------------------------------------
# Task 4.1 — catgo_input (LAMMPS / QE / VASP input generation + vasp_presets)
# ---------------------------------------------------------------------------


@requires_backend
@pytest.mark.asyncio
async def test_input_vasp_incar_content():
    from catgo.mcp_tools.server_claude_code import _handle_input
    from tests._mcp_fixtures import load_cif_as_dict, TIO2_CIF
    async with httpx.AsyncClient(timeout=60) as c:
        out = await _handle_input(c, {"action": "vasp", "structure": load_cif_as_dict(TIO2_CIF),
                                      "calculation_type": "scf"})
    text = out[0].text
    assert "ENCUT" in text and "PREC" in text, text[:200]


@requires_backend
@pytest.mark.asyncio
async def test_input_qe_control_namelist():
    from catgo.mcp_tools.server_claude_code import _handle_input
    from tests._mcp_fixtures import load_cif_as_dict, TIO2_CIF
    async with httpx.AsyncClient(timeout=60) as c:
        out = await _handle_input(c, {"action": "qe", "structure": load_cif_as_dict(TIO2_CIF),
                                      "calculation": "scf"})
    assert "&control" in out[0].text.lower()


@requires_backend
@pytest.mark.asyncio
async def test_input_lammps_pair_style():
    from catgo.mcp_tools.server_claude_code import _handle_input
    from tests._mcp_fixtures import load_cif_as_dict, TIO2_CIF
    async with httpx.AsyncClient(timeout=60) as c:
        out = await _handle_input(c, {"action": "lammps", "structure": load_cif_as_dict(TIO2_CIF)})
    assert "pair_style" in out[0].text


@requires_backend
@pytest.mark.asyncio
async def test_input_vasp_presets_direct():
    from catgo.mcp_tools.server_claude_code import _handle_input
    async with httpx.AsyncClient(timeout=30) as c:
        out = await _handle_input(c, {"action": "vasp_presets", "preset_name": "relax"})
    text = out[0].text
    assert "ENCUT" in text and "IBRION" in text


def test_stdio_server_serves_menu_b():
    from catgo.mcp_tools.server_claude_code import TOOLS as MENU_B
    import catgo.mcp_tools.server as stdio
    served = {t.name for t in stdio.list_tools_sync()}
    expected = {t.name for t in MENU_B}
    assert expected.issubset(served), f"stdio missing: {expected - served}"


# ---------------------------------------------------------------------------
# Task 6.1 — schema + parity drift-guard tests (pure introspection, no backend)
# ---------------------------------------------------------------------------


def test_new_tools_present():
    from catgo.mcp_tools.server_claude_code import TOOLS
    names = {t.name for t in TOOLS}
    assert {"catgo_md", "catgo_input"}.issubset(names)


def test_new_actions_in_enums():
    from catgo.mcp_tools.server_claude_code import TOOLS
    by = {t.name: t for t in TOOLS}
    s = by["catgo_structure"].inputSchema["properties"]["action"]["enum"]
    assert {"defect", "strain", "water_layer"}.issubset(set(s))
    a = by["catgo_analyze"].inputSchema["properties"]["action"]["enum"]
    assert {"energy", "calculators"}.issubset(set(a))
    assert "dft_input" not in a   # dead action removed


def test_drift_guard_every_menu_a_endpoint_folded_or_excluded():
    """Every backend endpoint reachable via the granular Menu A registry must be
    EITHER reachable via a consolidated Menu B (tool, action) OR on the explicit
    EXCLUDED list with a documented reason. A future new Menu A endpoint with
    neither a fold nor an exclusion entry FAILS this test (drift guard).
    """
    from catgo.mcp_tools.tools import TOOLS as MENU_A
    from catgo.mcp_tools.server_claude_code import _MD_ROUTES, _INPUT_ROUTES
    menu_a_endpoints = {t.get("endpoint") for t in MENU_A if isinstance(t.get("endpoint"), str)}

    # Endpoints deliberately NOT folded into a Menu B mega-tool, each with a reason.
    EXCLUDED = {
        # bands/cohp/dos-from-file analysis: session-based, require completed-calc
        # output directories as fixtures that the consolidated suite does not ship.
        "/bands/data", "/bands/from-directory", "/bands/projections",
        "/cohp/data", "/dos/total", "/dos/dband", "/dos/from-directory",
        # kmc: depends on the optional `mykmc` package which is absent in this env.
        "kmc/scan-potential", "kmc/simulate",
    }

    # Endpoints reachable via a Menu B mega-tool action.
    folded = set(_MD_ROUTES.values()) | {ep for _, ep, _ in _INPUT_ROUTES.values()}
    folded |= {"/build/defect", "/build/strain", "/pseudo-hydrogen/passivate",
               "/water-layer/add", "/optimize/energy", "/optimize/calculators"}

    # Endpoint families covered by Menu B mega-tools (catgo_structure ops,
    # catgo_heterostructure/moire/nanotube, catgo_view, catgo_input qe/vasp/lammps,
    # catgo_analyze dos/optimize/symmetry/analysis/adsorption, catgo_system chat,
    # catgo_fetch).
    COVERED_PREFIXES = ("/structure-ops", "/heterostructure", "/moire", "/nanotube",
                        "/view", "/qe", "/vasp", "/lammps", "/dos", "/optimize",
                        "/symmetry", "/analysis", "/adsorption", "/chat", "/fetch")

    unaccounted = []
    for ep in menu_a_endpoints:
        # __direct__/__special__ are pseudo-endpoints handled inline by the Menu B
        # mega-tools (catalysis/fetch/workflow/set-lattice/vasp_presets), not HTTP routes.
        if ep.startswith("__direct__") or ep.startswith("__special__"):
            continue
        norm = ep if ep.startswith("/") else "/" + ep
        # EXCLUDED is checked before COVERED_PREFIXES so /dos/total etc. count as
        # excluded rather than being silently swallowed by the /dos prefix.
        if ep in EXCLUDED or norm in EXCLUDED:
            continue
        if norm in folded or ep in folded:
            continue
        if ep.startswith(COVERED_PREFIXES) or norm.startswith(COVERED_PREFIXES):
            continue
        unaccounted.append(ep)
    assert not unaccounted, f"endpoints neither folded nor excluded: {unaccounted}"
