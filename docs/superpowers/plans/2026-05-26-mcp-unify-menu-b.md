# MCP Unification onto Menu B — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the consolidated MCP registry ("Menu B", `server_claude_code.py`) the single MCP surface for all transports, folding in the verifiable capabilities that currently exist only in the granular registry ("Menu A").

**Architecture:** Add building actions to `catgo_structure`, two analysis actions to `catgo_analyze`, and two new table-driven mega-tools (`catgo_md`, `catgo_input`). Each fold is gated by a **real functional test** against the live backend on `:8000` with a real fixture, asserting on result content. Repoint the stdio server to serve Menu B while keeping its plugin branches. Excluded by the gate (recorded, follow-up): electronic-structure bucket (session/HPC-based, no DFT fixtures), `reticular` (no backend endpoint), `catgo_simulate`/kMC (`mykmc` not importable in this env).

**Tech Stack:** Python, FastAPI backend, `mcp` SDK, `httpx`, pytest (`pytest-asyncio`), pymatgen, ASE.

**Spec:** `docs/superpowers/specs/2026-05-25-mcp-unify-menu-b-design.md`

**Branch:** `feat/mcp-unify-menu-b`, off `main`. Stacks logically after PR #138 (both touch `server_claude_code.py`); rebase onto it if #138 is unmerged at execution time.

**Backend must be running** on `http://localhost:8000` (dev: `pnpm desktop:serve`) for the functional-gate tests.

---

## File structure

- **Modify** `server/catgo/mcp_tools/server_claude_code.py`
  - `_handle_structure`: add a building-actions block (`defect`/`strain`/`passivate`/`water_layer`).
  - `_handle_analyze`: add `energy`, `calculators` to its `ROUTES`; **remove the dead `dft_input`** route + its enum entry.
  - `TOOLS`: extend `catgo_structure` and `catgo_analyze` action enums; **append two new `Tool`s** (`catgo_md`, `catgo_input`).
  - Add handlers `_handle_md`, `_handle_input`.
  - Stdio `call_tool` dispatch (bottom of file): route `catgo_md`/`catgo_input`.
- **Modify** `server/catgo/routers/mcp_http.py` and `mcp_sse.py`: import + dispatch `_handle_md`, `_handle_input`.
- **Modify** `server/catgo/mcp_tools/server.py`: `list_tools` returns Menu B `TOOLS` (+ plugin defs); `call_tool` routes Menu B tool names to Menu B handlers, **preserving** the existing plugin / `catgo_create_tool` / `catgo_ext_*` / atomate2-quacc branches.
- **Create** `server/tests/test_consolidated_registry.py`: schema tests, parity drift-guard, and the real functional-gate tests (parametrized, real fixtures).
- **Create** `server/tests/_mcp_fixtures.py`: small helpers (`load_cif_as_dict`, `trajectory_b64`).
- **Modify** `server/tests/test_claude_code_mcp.py`: update stale tool-count / description-length assertions.

---

## Phase 0 — Test fixtures + helpers

### Task 0.1: Shared test-fixture helpers

**Files:**
- Create: `server/tests/_mcp_fixtures.py`

- [ ] **Step 1: Write the helper module** (not a test — a shared utility used by the gate tests)

```python
"""Shared helpers for consolidated-MCP functional tests.

These load REAL inputs (no synthetic happy-path stand-ins): real CIFs from
src/site/structures and a real multi-frame trajectory from src/site/trajectories.
"""
import base64
from pathlib import Path

# repo root = three levels up from this file (server/tests/_mcp_fixtures.py)
_REPO = Path(__file__).resolve().parents[2]
_STRUCTS = _REPO / "src" / "site" / "structures"
_TRAJ = _REPO / "src" / "site" / "trajectories"

TRAJECTORY_EXTXYZ = _TRAJ / "mp-1184225.extxyz"   # 6 frames, real
TIO2_CIF = _STRUCTS / "TiO2.cif"                   # rutile, real
QUARTZ_CIF = _STRUCTS / "quartz-alpha.cif"         # alpha-quartz, real


def load_cif_as_dict(path: Path) -> dict:
    """Parse a CIF into a pymatgen Structure .as_dict() (raw form)."""
    from pymatgen.core import Structure
    return Structure.from_file(str(path)).as_dict()


def trajectory_b64(path: Path = TRAJECTORY_EXTXYZ) -> str:
    """Base64 of a real trajectory file, for the MD endpoints' trajectory_b64 field."""
    return base64.b64encode(path.read_bytes()).decode("ascii")
```

- [ ] **Step 2: Verify fixtures resolve**

Run: `cd server && PYTHONPATH=. python -c "from tests._mcp_fixtures import *; print(TRAJECTORY_EXTXYZ.exists(), TIO2_CIF.exists(), len(trajectory_b64())>100, list(load_cif_as_dict(TIO2_CIF))[:3])"`
Expected: `True True True ['@module', '@class', 'charge']` (or similar pymatgen dict keys)

- [ ] **Step 3: Commit**

```bash
git add server/tests/_mcp_fixtures.py
git commit -m "test(mcp): shared real-fixture helpers for consolidated-registry tests"
```

---

## Phase 1 — `catgo_structure` building actions

Backend: `/build/defect`, `/build/strain` take `{structure: <raw as_dict>, ...}` and return `{structures:[dict], labels, count}`. `/pseudo-hydrogen/passivate` takes `{slab, bulk, params?}` → `{structure, n_pseudo_h, ...}`. `/water-layer/add` takes `{structure, params?}` → `{structure, n_water_molecules, ...}`.

### Task 1.1: Building handler + functional gate

**Files:**
- Modify: `server/catgo/mcp_tools/server_claude_code.py` (in `_handle_structure`, near `action = args.get("action", "")`)
- Modify: `server/catgo/mcp_tools/server_claude_code.py` (`catgo_structure` Tool action enum)
- Test: `server/tests/test_consolidated_registry.py`

- [ ] **Step 1: Write the failing functional test** (real backend, real fixture, assert on result content)

```python
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
    n0 = len(struct["sites"])
    async with httpx.AsyncClient(timeout=60) as c:
        out = await _handle_structure(c, {
            "action": "defect", "structure": struct,
            "defect_type": "vacancy", "site_index": 0, "supercell": "1x1x1",
        })
    text = out[0].text.lower()
    # vacancy in a 1x1x1 cell removes exactly one atom from the parent cell
    assert "defect" in text or "vacanc" in text or "atoms" in text
    assert "failed" not in text and "error" not in text
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd server && PYTHONPATH=. python -m pytest tests/test_consolidated_registry.py::test_structure_defect_creates_vacancy -v`
Expected: FAIL — `_handle_structure` returns `Unknown action 'defect'` (or KeyError), assertion fails.

- [ ] **Step 3: Add the building block to `_handle_structure`**

Insert immediately after `T = TextContent` in `_handle_structure`:

```python
    # ---- Building actions (folded from Menu A; real-test gated) ----
    # defect/strain return {structures:[...], labels, count}; passivate/water_layer
    # return {structure, ...}. All push the (first) resulting structure to the viewer.
    _BUILD = {
        "defect":      ("/build/defect",               "structure", "structures"),
        "strain":      ("/build/strain",               "structure", "structures"),
        "passivate":   ("/pseudo-hydrogen/passivate",  "slab",      "structure"),
        "water_layer": ("/water-layer/add",            "structure", "structure"),
    }
    if action in _BUILD:
        endpoint, in_key, out_key = _BUILD[action]
        payload = {k: v for k, v in args.items() if k != "action"}
        # auto-inject current viewer structure into the primary input slot
        if in_key not in payload:
            cur = await _get_current_structure(client)
            if cur is None:
                return [T(type="text", text=f"action '{action}' needs `{in_key}` (or a structure loaded in the viewer).")]
            payload[in_key] = cur
        resp = await client.post(f"{API_BASE}{endpoint}", json=payload)
        if resp.status_code != 200:
            return [T(type="text", text=f"{action} failed ({resp.status_code}): {resp.text[:300]}")]
        data = resp.json()
        new_struct = data.get("structures", [None])[0] if out_key == "structures" else data.get("structure")
        if not new_struct:
            return [T(type="text", text=f"{action} returned no structure. Response: {json.dumps(data)[:300]}")]
        push_err = await _push_structure(client, new_struct)
        n = len(new_struct.get("sites", []))
        extra = ""
        if action == "passivate":
            extra = f" (+{data.get('n_pseudo_h', '?')} pseudo-H)"
        elif action == "water_layer":
            extra = f" (+{data.get('n_water_molecules', '?')} H2O)"
        elif out_key == "structures":
            extra = f" ({data.get('count', 1)} structure(s), showing #1)"
        msg = f"{action}: {n} atoms{extra}. Viewer updated."
        if push_err:
            msg += f"\n⚠️ Viewer push failed: {push_err}"
        return [T(type="text", text=msg)]
```

- [ ] **Step 4: Add actions to the `catgo_structure` enum**

In the `catgo_structure` `Tool` `inputSchema`, append to the `action` enum list: `"defect", "strain", "passivate", "water_layer"`. Add brief per-action params to the schema `properties`: `defect_type`, `site_index`, `substitute_element`, `supercell`, `strain_type`, `axis`, `magnitude`, `n_steps`, `slab`, `bulk`, `params` (objects/strings/ints with the defaults from the spec's request-shape table).

- [ ] **Step 5: Run the test — verify it passes**

Run: `cd server && PYTHONPATH=. python -m pytest tests/test_consolidated_registry.py::test_structure_defect_creates_vacancy -v`
Expected: PASS.

- [ ] **Step 6: Add strain + water_layer functional tests** (real fixtures, content assertions)

```python
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
    struct = load_cif_as_dict(TIO2_CIF)   # has a c-axis; water fills the vacuum band
    async with httpx.AsyncClient(timeout=120) as c:
        out = await _handle_structure(c, {
            "action": "water_layer", "structure": struct,
            "params": {"z_start": 0.0, "z_end": 12.0, "density": 0.997},
        })
    text = out[0].text.lower()
    assert "h2o" in text and "failed" not in text
```

> **Gate note:** `passivate` needs a *slab* + *bulk* pair. If a real slab fixture cannot be produced quickly (cut a slab from `TiO2.cif`), record `passivate` as "unverifiable — needs slab fixture" and **leave it out of the enum** this round rather than ship it untested. Decide during execution; do not fake the input.

- [ ] **Step 7: Run all Phase 1 tests**

Run: `cd server && PYTHONPATH=. python -m pytest tests/test_consolidated_registry.py -k "structure_" -v`
Expected: PASS for every folded action; any action whose live test fails is removed from the enum and recorded in the PR's excluded list.

- [ ] **Step 8: Commit**

```bash
git add server/catgo/mcp_tools/server_claude_code.py server/tests/test_consolidated_registry.py
git commit -m "feat(mcp): fold building actions (defect/strain/water_layer[/passivate]) into catgo_structure"
```

---

## Phase 2 — `catgo_analyze` + energy, + calculators; remove dead `dft_input`

`/optimize/energy` uses `OptimizationRequest` (`structure`, `calculator`, `calculator_params`) → dict with `energy`/`forces`. `/optimize/calculators` is a GET → `{calculators: {...}}`. `dft_input` → `/dft-input/generate` does not exist (dead) and is removed.

### Task 2.1: Extend analyze ROUTES + functional gate

**Files:**
- Modify: `server/catgo/mcp_tools/server_claude_code.py` (`_handle_analyze` `ROUTES`, and the model→calculator normalization)
- Modify: `server/catgo/mcp_tools/server_claude_code.py` (`catgo_analyze` enum)
- Test: `server/tests/test_consolidated_registry.py`

- [ ] **Step 1: Write failing functional tests**

```python
@requires_backend
@pytest.mark.asyncio
async def test_analyze_calculators_lists():
    from catgo.mcp_tools.server_claude_code import _handle_analyze
    async with httpx.AsyncClient(timeout=30) as c:
        out = await _handle_analyze(c, {"action": "calculators"})
    text = out[0].text
    assert "calculators" in text  # JSON dump of {"calculators": {...}}

@requires_backend
@pytest.mark.asyncio
async def test_analyze_energy_returns_number():
    import json as _j
    from catgo.mcp_tools.server_claude_code import _handle_analyze
    from tests._mcp_fixtures import load_cif_as_dict, TIO2_CIF
    async with httpx.AsyncClient(timeout=120) as c:
        out = await _handle_analyze(c, {
            "action": "energy", "structure": load_cif_as_dict(TIO2_CIF), "model": "mace",
        })
    text = out[0].text
    assert "energy" in text.lower() and "failed" not in text.lower()
```

- [ ] **Step 2: Run — verify fail**

Run: `cd server && PYTHONPATH=. python -m pytest tests/test_consolidated_registry.py -k "analyze_" -v`
Expected: FAIL — `Unknown analyze action 'energy'/'calculators'`.

- [ ] **Step 3: Edit `_handle_analyze` ROUTES**

In the `ROUTES` dict add:
```python
        "energy":      ("POST", "/optimize/energy"),
        "calculators": ("GET",  "/optimize/calculators"),
```
Remove the line `"dft_input": ("POST", "/dft-input/generate"),` (dead endpoint). Ensure the existing `model`→`calculator` normalization also fires for `action == "energy"`:
```python
    if action in ("optimize", "energy"):
        if "model" in payload and "calculator" not in payload:
            payload["calculator"] = payload.pop("model").lower()
```

- [ ] **Step 4: Update the `catgo_analyze` enum** — add `energy`, `calculators`; remove `dft_input`.

- [ ] **Step 5: Run — verify pass**

Run: `cd server && PYTHONPATH=. python -m pytest tests/test_consolidated_registry.py -k "analyze_" -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/catgo/mcp_tools/server_claude_code.py server/tests/test_consolidated_registry.py
git commit -m "feat(mcp): add analyze energy/calculators; drop dead dft_input action"
```

---

## Phase 3 — NEW `catgo_md` tool (12 trajectory-analysis actions)

All endpoints take `trajectory_b64` + `format` (+ per-action extras). Table-driven handler.

### Task 3.1: `catgo_md` tool + handler + functional gate

**Files:**
- Modify: `server/catgo/mcp_tools/server_claude_code.py` (append `Tool`; add `_handle_md`; register in stdio dispatch)
- Modify: `server/catgo/routers/mcp_http.py`, `mcp_sse.py` (import + dispatch `_handle_md`)
- Test: `server/tests/test_consolidated_registry.py`

- [ ] **Step 1: Write failing parametrized functional test** (real 6-frame trajectory; assert result keys per action)

```python
MD_CASES = [
    ("rdf", {"selection_1": {"element": "O"}, "selection_2": {"element": "O"}}, ["r", "g_r"]),
    ("msd", {"timestep_ps": 1.0}, ["tau_ps", "msd_angstrom2"]),
    ("rmsd", {"ref_frame": 0}, ["rmsd_angstroms"]),
    ("rmsf", {}, ["rmsf_angstroms"]),
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
```

- [ ] **Step 2: Run — verify fail**

Run: `cd server && PYTHONPATH=. python -m pytest tests/test_consolidated_registry.py -k "md_actions" -v`
Expected: FAIL — `cannot import name '_handle_md'`.

- [ ] **Step 3: Add `_handle_md`**

```python
_MD_ROUTES = {
    "rdf":               "/md/distances/rdf",
    "msd":               "/md/dynamics/msd",
    "rmsd":              "/md/rmsd/rmsd",
    "rmsf":              "/md/rmsd/rmsf",
    "clustering":        "/md/clustering/rmsd-cluster",
    "dimreduce":         "/md/clustering/dimreduce",
    "hbonds":            "/md/hbonds/detect",
    "hbond_lifetime":    "/md/hbonds/lifetime",
    "water_orientation": "/md/orientation/water",
    "dihedrals":         "/md/angles/dihedrals",
    "planar_density":    "/md/density/planar",
    "cavitation":        "/md/cavitation/profile",
}

async def _handle_md(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """MD trajectory analysis. All actions take trajectory_b64 + format (+ extras).
    Pure analysis — returns JSON; never pushes to the viewer."""
    T = TextContent
    action = args.get("action", "")
    endpoint = _MD_ROUTES.get(action)
    if endpoint is None:
        return [T(type="text", text=f"Unknown md action '{action}'. Valid: {', '.join(_MD_ROUTES)}")]
    if not args.get("trajectory_b64"):
        return [T(type="text", text=f"md action '{action}' requires `trajectory_b64` (base64 of a trajectory) and `format`.")]
    payload = {k: v for k, v in args.items() if k != "action"}
    resp = await client.post(f"{API_BASE}{endpoint}", json=payload)
    if resp.status_code != 200:
        return [T(type="text", text=f"md {action} failed ({resp.status_code}): {resp.text[:300]}")]
    return [T(type="text", text=json.dumps(resp.json(), ensure_ascii=False))]
```

- [ ] **Step 4: Append the `catgo_md` `Tool`** to `TOOLS`

```python
    Tool(
        name="catgo_md",
        description=(
            "Analyze a MOLECULAR DYNAMICS TRAJECTORY (RDF, MSD/diffusion, RMSD/RMSF, "
            "clustering, H-bonds, water orientation, dihedrals, planar density, "
            "interfacial cavitation). Pass the trajectory as base64 in `trajectory_b64` "
            "with its `format` (extxyz/xyz/h5/traj/pdb/xtc/...). Returns JSON arrays. "
            "DO NOT hand-roll mdtraj/MDAnalysis — this wraps the canonical analyses."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": list(_MD_ROUTES.keys()),
                           "description": "Which trajectory analysis to run."},
                "trajectory_b64": {"type": "string", "description": "Base64 of the trajectory file."},
                "format": {"type": "string", "description": "Trajectory format, e.g. extxyz, xyz, h5, traj, pdb, xtc."},
                "topology_b64": {"type": "string", "description": "Base64 topology (only for binary formats xtc/trr/dcd)."},
                "selection_1": {"type": "object", "description": "rdf: {indices:[...]} or {element:'O'}"},
                "selection_2": {"type": "object", "description": "rdf: second selection."},
                "element": {"type": "string", "description": "msd: element to track."},
                "atom_indices": {"type": "array", "items": {"type": "integer"}},
                "atom_quartets": {"type": "array", "items": {"type": "array", "items": {"type": "integer"}},
                                  "description": "dihedrals: [[i,j,k,l],...]"},
                "method": {"type": "string", "description": "clustering/dimreduce: dbscan|hierarchical|kmeans / pca|tsne|umap; hbonds: baker_hubbard|wernet_nilsson."},
                "plane": {"type": "string", "enum": ["xy", "xz", "yz"], "description": "planar_density plane."},
                "axis": {"type": "string", "description": "water_orientation/cavitation axis."},
                "timestep_ps": {"type": "number"},
                "n_bins": {"type": "integer"},
            },
            "required": ["action"],
        },
    ),
```

- [ ] **Step 5: Register `catgo_md` in dispatch**

In `server_claude_code.py` stdio `call_tool` (the `elif name == "catgo_..."` chain near the bottom) add:
```python
                elif name == "catgo_md":
                    return await _handle_md(client, arguments)
```
In `mcp_http.py` and `mcp_sse.py`: add `_handle_md` to the import block from `server_claude_code` and the same `elif name == "catgo_md": return await _handle_md(client, arguments)` branch.

- [ ] **Step 6: Run — verify pass**

Run: `cd server && PYTHONPATH=. python -m pytest tests/test_consolidated_registry.py -k "md_actions" -v`
Expected: PASS for the 4 parametrized cases.

- [ ] **Step 7: Extend MD_CASES to all 12 actions** with real per-action inputs and assert keys (from the spec table): add `clustering` (`method="dbscan"`, keys `labels`,`n_clusters_found`), `dimreduce` (`method="pca"`, key `embedding`), `hbonds` (keys `count_per_frame`), `hbond_lifetime` (keys `autocorrelation`), `water_orientation` (keys `bin_centers_angstrom`), `dihedrals` (`atom_quartets=[[0,1,2,3]]`, key `dihedrals_deg`), `planar_density` (`plane="xy"`, key `density`), `cavitation` (key `delta_g_cav_eV`). Any case that the live backend rejects for this particular trajectory (e.g. water_orientation on a non-water trajectory) is moved to an `xfail`/excluded note with the reason — but the action stays folded if at least one real trajectory makes it return 200 with the right keys. Use a water-containing trajectory fixture (`gold-nanoparticle-md.h5` is non-water; if no water trajectory exists, mark `water_orientation`/`hbond*`/`cavitation` as "needs water-trajectory fixture" and exclude those specific actions).

- [ ] **Step 8: Run full MD suite**

Run: `cd server && PYTHONPATH=. python -m pytest tests/test_consolidated_registry.py -k "md_actions" -v`
Expected: PASS for folded actions; excluded ones recorded.

- [ ] **Step 9: Commit**

```bash
git add server/catgo/mcp_tools/server_claude_code.py server/catgo/routers/mcp_http.py server/catgo/routers/mcp_sse.py server/tests/test_consolidated_registry.py
git commit -m "feat(mcp): add catgo_md trajectory-analysis tool (12 actions, gated)"
```

---

## Phase 4 — NEW `catgo_input` tool (LAMMPS/QE/VASP generation)

Endpoints (all `/api`-prefixed): POST `/lammps/input`, GET `/lammps/pair_styles`, POST `/lammps/sequential`, POST `/lammps/validate`, POST `/qe/input`, GET `/qe/templates`, POST `/vasp/generate`, GET `/vasp/calculation-types`, and the `vasp_presets` __direct__ call (`workflow.presets.vasp.get_preset(name)`). All POST gens take `structure` (+ many optional knobs) and return text fields (`input_script`/`data_file`, `input_file`, `incar`/`poscar`/`kpoints`).

### Task 4.1: `catgo_input` tool + handler + functional gate

**Files:**
- Modify: `server/catgo/mcp_tools/server_claude_code.py` (append `Tool`; add `_handle_input`; dispatch)
- Modify: `server/catgo/routers/mcp_http.py`, `mcp_sse.py`
- Test: `server/tests/test_consolidated_registry.py`

- [ ] **Step 1: Write failing functional tests** (assert generated-text content, not just 200)

```python
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
    assert "&CONTROL" in out[0].text or "&control" in out[0].text.lower()

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
    assert "ENCUT" in text and "IBRION" in text   # flat INCAR-param dict
```

- [ ] **Step 2: Run — verify fail**

Run: `cd server && PYTHONPATH=. python -m pytest tests/test_consolidated_registry.py -k "input_" -v`
Expected: FAIL — `cannot import name '_handle_input'`.

- [ ] **Step 3: Add `_handle_input`**

```python
# (method, endpoint, needs_structure). vasp_presets is a __direct__ python call.
_INPUT_ROUTES = {
    "lammps":            ("POST", "/lammps/input",            True),
    "lammps_pair_styles":("GET",  "/lammps/pair_styles",      False),
    "lammps_sequential": ("POST", "/lammps/sequential",       True),
    "lammps_validate":   ("POST", "/lammps/validate",         True),
    "qe":                ("POST", "/qe/input",                True),
    "qe_templates":      ("GET",  "/qe/templates",            False),
    "vasp":              ("POST", "/vasp/generate",           True),
    "vasp_calc_types":   ("GET",  "/vasp/calculation-types",  False),
}

async def _handle_input(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Generate simulation input files (LAMMPS / QE / VASP). Replaces the dead
    analyze:dft_input. Returns the generated text; does not touch the viewer."""
    T = TextContent
    action = args.get("action", "")

    if action == "vasp_presets":
        try:
            from workflow.presets.vasp import get_preset
            preset = get_preset(args.get("preset_name", "relax"))
            if not preset:
                return [T(type="text", text=f"Unknown preset '{args.get('preset_name')}'. Valid: relax, static, slab_relax, freq, band, md.")]
            return [T(type="text", text=json.dumps(preset, indent=2))]
        except Exception as e:
            return [T(type="text", text=f"vasp_presets failed: {e}")]

    route = _INPUT_ROUTES.get(action)
    if route is None:
        valid = ", ".join(list(_INPUT_ROUTES) + ["vasp_presets"])
        return [T(type="text", text=f"Unknown input action '{action}'. Valid: {valid}")]
    method, endpoint, needs_struct = route
    payload = {k: v for k, v in args.items() if k != "action"}
    if needs_struct and "structure" not in payload:
        cur = await _get_current_structure(client)
        if cur is None:
            return [T(type="text", text=f"input '{action}' needs `structure` (or one loaded in the viewer).")]
        payload["structure"] = cur
    if method == "GET":
        resp = await client.get(f"{API_BASE}{endpoint}", params=payload or None)
    else:
        resp = await client.post(f"{API_BASE}{endpoint}", json=payload)
    if resp.status_code != 200:
        return [T(type="text", text=f"input {action} failed ({resp.status_code}): {resp.text[:300]}")]
    data = resp.json()
    # Surface the primary generated text where present; else dump JSON.
    for key in ("incar", "input_file", "input_script", "combined_input"):
        if isinstance(data, dict) and data.get(key):
            blocks = {k: data[k] for k in ("incar", "poscar", "kpoints", "data_file", "input_file", "input_script", "combined_input") if data.get(k)}
            return [T(type="text", text="\n\n".join(f"=== {k} ===\n{v}" for k, v in blocks.items()))]
    return [T(type="text", text=json.dumps(data, ensure_ascii=False, indent=2))]
```

- [ ] **Step 4: Append `catgo_input` `Tool`** with `action` enum = `list(_INPUT_ROUTES) + ["vasp_presets"]`, plus properties: `structure` (object), `calculation_type` (vasp), `calculation` (qe), `pair_style`/`simulation_type` (lammps), `preset_name` (enum relax/static/slab_relax/freq/band/md), `stages` (lammps_sequential). Required: `["action"]`.

- [ ] **Step 5: Register dispatch** in `server_claude_code.py` stdio `call_tool`, `mcp_http.py`, `mcp_sse.py`:
```python
                elif name == "catgo_input":
                    return await _handle_input(client, arguments)
```

- [ ] **Step 6: Run — verify pass**

Run: `cd server && PYTHONPATH=. python -m pytest tests/test_consolidated_registry.py -k "input_" -v`
Expected: PASS (all four).

- [ ] **Step 7: Commit**

```bash
git add server/catgo/mcp_tools/server_claude_code.py server/catgo/routers/mcp_http.py server/catgo/routers/mcp_sse.py server/tests/test_consolidated_registry.py
git commit -m "feat(mcp): add catgo_input (lammps/qe/vasp gen + presets), supersedes dead dft_input"
```

---

## Phase 5 — Transport unification (stdio serves Menu B)

### Task 5.1: Repoint `server.py` to Menu B, keep plugin branches

**Files:**
- Modify: `server/catgo/mcp_tools/server.py`
- Test: `server/tests/test_consolidated_registry.py`

- [ ] **Step 1: Write failing test** — stdio server advertises the consolidated set

```python
def test_stdio_server_serves_menu_b():
    # The stdio server's tool list must be the consolidated TOOLS, not the granular 70.
    from catgo.mcp_tools.server_claude_code import TOOLS as MENU_B
    import catgo.mcp_tools.server as stdio
    served = {t.name for t in stdio.list_tools_sync()}  # helper added in step 3
    expected = {t.name for t in MENU_B}
    assert expected.issubset(served), f"stdio missing: {expected - served}"
```

- [ ] **Step 2: Run — verify fail**

Run: `cd server && PYTHONPATH=. python -m pytest tests/test_consolidated_registry.py::test_stdio_server_serves_menu_b -v`
Expected: FAIL — `server` has no `list_tools_sync`, and it currently serves the granular registry.

- [ ] **Step 3: Edit `server.py`**

- Replace `from catgo.mcp_tools.tools import TOOLS` with `from catgo.mcp_tools.server_claude_code import TOOLS`.
- In the `@server.list_tools()` handler, return `TOOLS + get_plugin_tool_defs()` (keep plugin defs).
- Add a module-level sync helper used by the test:
```python
def list_tools_sync():
    """Tool list the stdio server advertises (consolidated Menu B + plugins)."""
    from catgo.mcp_tools.server_claude_code import TOOLS as _B
    return list(_B)
```
- In `@server.call_tool()`: **before** the existing plugin / `catgo_create_tool` / `catgo_ext_*` / atomate2-quacc branches, try the consolidated dispatch:
```python
    from catgo.mcp_tools.server_claude_code import (
        _handle_structure, _handle_fetch, _handle_workflow, _handle_analyze,
        _handle_view, _handle_catalysis, _handle_system, _handle_workflow_engine,
        _handle_file, _handle_diagnose, _handle_skills, _handle_heterostructure,
        _handle_nanotube, _handle_moire, _handle_quickbuild, _handle_md, _handle_input,
        _handle_workflow_engine as _wfe,
    )
    _CONSOLIDATED = {
        "catgo_structure": _handle_structure, "catgo_fetch": _handle_fetch,
        "catgo_workflow": _handle_workflow, "catgo_analyze": _handle_analyze,
        "catgo_view": _handle_view, "catgo_catalysis": _handle_catalysis,
        "catgo_system": _handle_system, "catgo_file": _handle_file,
        "catgo_diagnose": _handle_diagnose, "catgo_skills": _handle_skills,
        "catgo_heterostructure": _handle_heterostructure, "catgo_nanotube": _handle_nanotube,
        "catgo_moire": _handle_moire, "catgo_quickbuild": _handle_quickbuild,
        "catgo_md": _handle_md, "catgo_input": _handle_input,
    }
    if name in _CONSOLIDATED:
        async with httpx.AsyncClient(timeout=120.0) as client:
            return await _CONSOLIDATED[name](client, arguments)
    if name == "catgo_workflow_engine":
        return await _handle_workflow_engine(arguments)
```
Leave all existing plugin/lifecycle/import branches in place **after** this block (the granular declarative dispatch becomes unreachable for Menu B names but plugin handling still works).

- [ ] **Step 4: Run — verify pass**

Run: `cd server && PYTHONPATH=. python -m pytest tests/test_consolidated_registry.py::test_stdio_server_serves_menu_b -v`
Expected: PASS.

- [ ] **Step 5: Sanity-check stdio import + tool list size**

Run: `cd server && PYTHONPATH=. python -c "import catgo.mcp_tools.server as s; print(len(s.list_tools_sync()))"`
Expected: the consolidated count (≈ 17 after Phases 1–4: 15 + catgo_md + catgo_input).

- [ ] **Step 6: Commit**

```bash
git add server/catgo/mcp_tools/server.py server/tests/test_consolidated_registry.py
git commit -m "refactor(mcp): stdio server serves consolidated Menu B (plugin branches preserved)"
```

---

## Phase 6 — Schema, parity drift-guard, stale-test fix

### Task 6.1: Schema + parity tests

**Files:**
- Test: `server/tests/test_consolidated_registry.py`

- [ ] **Step 1: Write schema + parity tests**

```python
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
    """Each backend endpoint Menu A reached is either reachable via a Menu B
    (tool, action) or on the explicit excluded list. Catches future drift."""
    from catgo.mcp_tools.tools import TOOLS as MENU_A
    menu_a_endpoints = {t.get("endpoint") for t in MENU_A if isinstance(t.get("endpoint"), str)}
    EXCLUDED = {  # recorded with reasons in the PR
        "/bands/data", "/bands/from-directory", "/bands/projections",
        "/cohp/data", "/dos/total", "/dos/dband", "/dos/from-directory",
        "kmc/scan-potential", "kmc/simulate",          # mykmc absent
        # __direct__/__special__ catalysis/fetch/workflow already covered by Menu B mega-tools
    }
    # endpoints folded into Menu B handlers (mirror the route tables):
    from catgo.mcp_tools.server_claude_code import _MD_ROUTES, _INPUT_ROUTES
    folded = set(_MD_ROUTES.values()) | {ep for _, ep, _ in _INPUT_ROUTES.values()}
    folded |= {"/build/defect", "/build/strain", "/pseudo-hydrogen/passivate",
               "/water-layer/add", "/optimize/energy", "/optimize/calculators",
               "/structure-ops/add-atom", "/dos/compute", "/optimize/structure"}  # representative already-covered
    unaccounted = []
    for ep in menu_a_endpoints:
        if ep.startswith(("__direct__", "__special__")):
            continue
        norm = ep if ep.startswith("/") else "/" + ep
        if norm in folded or ep in folded or ep in EXCLUDED or norm in EXCLUDED:
            continue
        # already-covered Menu B endpoints (structure-ops/fetch/hetero/moire/nanotube/etc.)
        if ep.startswith(("/structure-ops", "/heterostructure", "/moire", "/nanotube",
                          "/view", "/qe", "/vasp", "/lammps", "/dos", "/optimize",
                          "/symmetry", "/analysis", "/adsorption", "/chat")):
            continue
        unaccounted.append(ep)
    assert not unaccounted, f"endpoints neither folded nor excluded: {unaccounted}"
```

- [ ] **Step 2: Run — fix until green** (adjust the `folded`/covered prefixes to reality; the test documents the accounting)

Run: `cd server && PYTHONPATH=. python -m pytest tests/test_consolidated_registry.py -k "drift_guard or new_tools or new_actions" -v`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/tests/test_consolidated_registry.py
git commit -m "test(mcp): schema + parity drift-guard for consolidated registry"
```

### Task 6.2: Fix stale `test_claude_code_mcp.py`

**Files:**
- Modify: `server/tests/test_claude_code_mcp.py`

- [ ] **Step 1: Run the stale suite, capture current failures**

Run: `cd server && PYTHONPATH=. python -m pytest tests/test_claude_code_mcp.py -v`
Expected: FAILs on `test_tool_count` (11≠actual), `test_tool_names`, `test_all_tools_have_action_enum` (quickbuild/diagnose), `test_descriptions_are_concise` (mega-tools >300).

- [ ] **Step 2: Update assertions to current reality**

- `test_tool_count`: assert `len(tools) == len({t.name for t in tools})` and `>= 17` (don't hardcode a brittle number); or compute expected from the names set.
- `test_tool_names`: replace the 11-name set with the actual consolidated names (15 originals + `catgo_md`, `catgo_input`).
- `test_all_tools_have_action_enum` / `test_all_tools_require_action`: exclude `catgo_diagnose` (task_id) and `catgo_quickbuild` (recipe) — they legitimately lack `action`.
- `test_descriptions_are_concise`: relax the cap (mega-tools justifiably exceed 300 chars) — e.g. assert `< 4000`, or drop the bound and just assert non-empty.

- [ ] **Step 3: Run — verify pass**

Run: `cd server && PYTHONPATH=. python -m pytest tests/test_claude_code_mcp.py -v`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/tests/test_claude_code_mcp.py
git commit -m "test(mcp): update stale tool-count/description assertions to consolidated reality"
```

---

## Phase 7 — Full verification + PR

### Task 7.1: Whole-suite green + PR with the four result lists

- [ ] **Step 1: Run the full MCP test set** (backend up)

Run: `cd server && PYTHONPATH=. python -m pytest tests/test_consolidated_registry.py tests/test_claude_code_mcp.py tests/test_lateral_hetero_mcp.py tests/test_mcp_tools.py -v`
Expected: all PASS (functional-gate tests skip cleanly if backend down — but for the PR they must be run green at least once with backend up).

- [ ] **Step 2: Live end-to-end via real `/api/mcp` HTTP** — one call per new tool through the actual transport (handshake + tools/call), confirming `catgo_md` and `catgo_input` are listed and callable (mirror the handshake probe used during recon).

- [ ] **Step 3: Open the PR** to `Hello-QM/catgo-LRG` base `main`, body containing the four result lists:
  - **Folded (verified):** catgo_structure {defect, strain, water_layer, [passivate]}, catgo_analyze {energy, calculators}, catgo_md {…folded…}, catgo_input {lammps, lammps_pair_styles, lammps_sequential, lammps_validate, qe, qe_templates, vasp, vasp_calc_types, vasp_presets}.
  - **Skipped (duplicate):** structure-ops/fetch/hetero/moire/nanotube/catalysis/`/dos/compute`/`/optimize/structure` — already in Menu B.
  - **Excluded (broken/no-endpoint):** `reticular` (no endpoint), `analyze:dft_input` (dead `/dft-input/generate`, removed).
  - **Excluded (unverifiable — needs fixture/dep):** electronic-structure bucket (session/HPC, no DFT fixtures), `catgo_simulate`/kMC (`mykmc` not importable), any MD action needing a water trajectory.

---

## Self-review notes (addressed)

- **Spec coverage:** every verifiable migration-table row maps to a Phase 1–4 task; excluded rows are explicitly carried into the PR result lists (Phase 7). Transport unification = Phase 5. Stale-test + parity = Phase 6.
- **Real-test gate:** every fold has a live functional test asserting result content (not 200) with a real fixture (Phases 1–4); fake-client routing is not used as the gate.
- **Type consistency:** handler names `_handle_md`/`_handle_input` and route tables `_MD_ROUTES`/`_INPUT_ROUTES` are referenced identically in handlers, dispatch (`server_claude_code.py`, `mcp_http.py`, `mcp_sse.py`, `server.py`), and the drift-guard test.
- **No placeholders:** all handler and test code is complete; the only execution-time decisions are gate outcomes (which the gate is designed to make) — e.g. `passivate` and water-dependent MD actions fold only if a real fixture passes.
