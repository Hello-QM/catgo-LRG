# Reticular (MOF/COF) Builder — P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reticular-chemistry MOF/COF builder to CatGO that constructs crystal structures from an RCSR topology + building blocks by wrapping a vendored, jax-free fork of PORMAKE, exposed across backend / MCP / CLI / frontend.

**Architecture:** Vendor PORMAKE under `server/catgo/vendor/pormake/` with its sole jax usage (scaler.py) swapped to numpy + scipy `minimize`. A thin algorithm module wraps `pm.Builder().build_by_type(...)` and converts the resulting ASE `Atoms` to a pymatgen `Structure`. A FastAPI router (3-file builder triad like `nanotube`) serves `/api/reticular/*`. MCP entry (auto-push), CLI handler (in-process `call_route`), and a Svelte `ReticularPane` (modeled on `NanotubePane`) complete the vertical slice.

**Tech Stack:** Python (FastAPI, pydantic, numpy, scipy, ase, pymatgen, networkx), vendored PORMAKE (MIT), SvelteKit / Svelte 5 runes, `svelte-multiselect`.

**Spec:** `docs/superpowers/specs/2026-05-25-reticular-mof-builder-design.md`

**Reference patterns (read before starting):**
- Backend triad: `server/catgo/routers/nanotube.py`, `server/catgo/models/nanotube.py`, `server/catgo/utils/nanotube_algorithm.py`
- Richer error + native-pymatgen conversion: `server/catgo/routers/heterostructure.py:63-115,260-264`
- Shared structure model: `server/catgo/models/structure.py` (`Lattice`/`Site`/`Species`/`PymatgenStructure`)
- Router registry: `server/catgo/routers/__init__.py:32-33`; app wiring `server/main.py:62-93,389-390`
- MCP live schema: `server/catgo/mcp_tools/tools/nanotube_moire.py` (`TOOLS` list); mirror `server/catgo/tool_schema/building.json`
- CLI: `server/catgo/cli/ops_build.py`, `server/catgo/cli/ops.py:10-23`, adapter `server/catgo/cli/adapter.py:38-50`
- Frontend: `src/lib/api/nanotube.ts`, `src/lib/structure/NanotubePane.svelte`, `src/lib/structure/BuildPane.svelte:9-23`, `src/lib/structure/controllers/build-tools.svelte.ts:21`, `src/lib/structure/Structure.svelte:3026-3033`, i18n `src/lib/i18n/{en,zh}/structure.ts`
- Searchable select template: `src/lib/plot/ColorScaleSelect.svelte`

---

## File Structure

**Create:**
- `server/catgo/vendor/__init__.py` — namespace marker
- `server/catgo/vendor/pormake/` — vendored fork (copied from upstream `src/pormake/*` + `database/` 14 MB, jax removed)
- `server/catgo/vendor/pormake/LICENSE` — upstream MIT license (retained)
- `server/catgo/models/reticular.py` — pydantic models + 4-preset table
- `server/catgo/utils/reticular_algorithm.py` — PORMAKE wrapper → pymatgen `Structure`
- `server/catgo/routers/reticular.py` — FastAPI routes
- `server/tests/test_reticular.py` — algorithm + router tests
- `src/lib/api/reticular.ts` — typed fetch client
- `src/lib/structure/ReticularPane.svelte` — builder UI

**Modify:**
- `server/pyproject.toml` — add `networkx` dep if absent
- `server/catgo/routers/__init__.py:32` — register `reticular_router`
- `server/main.py` — import + `include_router(reticular_router, prefix="/api")`
- `server/catgo/mcp_tools/tools/nanotube_moire.py` — append MCP entry
- `server/catgo/tool_schema/building.json` — mirror MCP entry
- `server/catgo/cli/ops_build.py` — `reticular` handler
- `server/catgo/cli/ops.py` — `reg.add(Operation(name="reticular", ...))`
- `server/tests/cli/test_ops_build.py` — CLI handler test
- `src/lib/structure/controllers/build-tools.svelte.ts:21` — `BuildTab` union
- `src/lib/structure/BuildPane.svelte:9,11-23` — `BuildTab` union + `tab_defs`
- `src/lib/structure/Structure.svelte` — import + render branch
- `src/lib/i18n/en/structure.ts`, `src/lib/i18n/zh/structure.ts` — labels + content keys

---

## Phase 0 — Vendor PORMAKE, eliminate jax, add dep

### Task 0.1: Vendor the upstream source + data

**Files:**
- Create: `server/catgo/vendor/__init__.py`
- Create: `server/catgo/vendor/pormake/**` (copied tree)

- [ ] **Step 1: Clone upstream pinned and copy package + DB into the repo**

```bash
cd /tmp && rm -rf pormake-src && git clone https://github.com/Sangwon91/PORMAKE.git pormake-src
cd /tmp/pormake-src && git rev-parse HEAD   # record this commit in the LICENSE header note below
mkdir -p /home/james0001/project/catgo-LRG/server/catgo/vendor/pormake
cp -r /tmp/pormake-src/src/pormake/* /home/james0001/project/catgo-LRG/server/catgo/vendor/pormake/
cp /tmp/pormake-src/LICENSE /home/james0001/project/catgo-LRG/server/catgo/vendor/pormake/LICENSE
touch /home/james0001/project/catgo-LRG/server/catgo/vendor/__init__.py
```

The package bundles its data under `vendor/pormake/database/{bbs,topologies}` (867 `.xyz` BBs + 2407 `.cgd` topologies, ~14 MB). `database.py` resolves these via paths relative to its own file, so no path edits are needed.

- [ ] **Step 2: Drop the experimental decomposer (not used by the build path)**

```bash
rm -rf /home/james0001/project/catgo-LRG/server/catgo/vendor/pormake/experimental
```

- [ ] **Step 3: Verify import surface is intact**

The package `__init__.py` exposes: `Builder`, `BuildingBlock`, `Database`, `Locator`, `Scaler`, `Topology`. Confirm it has no remaining reference to the removed `experimental` subpackage.

Run: `grep -rn "experimental" /home/james0001/project/catgo-LRG/server/catgo/vendor/pormake/__init__.py`
Expected: no output (no import of experimental).

- [ ] **Step 4: Commit the vendored tree (pre-swap, so the swap diff is reviewable)**

```bash
cd /home/james0001/project/catgo-LRG
git add server/catgo/vendor/
git commit -m "vendor: add PORMAKE source + RCSR database (pre jax-swap)

Upstream Sangwon91/PORMAKE @ <commit-sha>, MIT. experimental/ dropped."
```

### Task 0.2: Swap jax → numpy + scipy in scaler.py

PORMAKE uses jax in exactly one file. The objective is differentiable, but for MVP we drop the analytic gradient and let L-BFGS-B use its built-in 2-point finite-difference gradient (correctness over speed; a single build is sub-second-scale and the optimization is small).

**Files:**
- Modify: `server/catgo/vendor/pormake/scaler.py`

- [ ] **Step 1: Write the failing test (scaler import is jax-free + MOF-5 builds with correct cell)**

Create `server/tests/test_reticular_scaler.py`:

```python
"""Vendored PORMAKE scaler must be jax-free and converge like upstream."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np


def test_scaler_module_has_no_jax():
    import catgo.vendor.pormake.scaler as scaler_mod
    src = open(scaler_mod.__file__).read()
    assert "import jax" not in src
    assert "jnp" not in src


def test_mof5_pcu_builds_with_expected_cell():
    """MOF-5 = pcu net + Zn4O node + BDC linker; cubic cell ~25.9 A."""
    import catgo.vendor.pormake as pm

    db = pm.Database()
    pcu = db.get_topo("pcu")
    # Resolve real bundled BB ids during implementation (see Task 1.1 note).
    zn4o = db.get_bb("N4")     # placeholder id — verify against db.bb_list
    bdc = db.get_bb("E1")      # placeholder id — verify against db.bb_list
    builder = pm.Builder()
    framework = builder.build_by_type(topology=pcu, node_bbs={0: zn4o}, edge_bbs={(0, 0): bdc})
    cell = framework.atoms.get_cell_lengths_and_angles()
    a, b, c, alpha, beta, gamma = cell
    assert 24.0 < a < 28.0
    assert np.allclose([alpha, beta, gamma], [90.0, 90.0, 90.0], atol=2.0)
    assert len(framework.atoms) > 0
```

- [ ] **Step 2: Run it to confirm it fails (jax still present)**

Run: `cd server && python -m pytest tests/test_reticular_scaler.py::test_scaler_module_has_no_jax -v`
Expected: FAIL — `"import jax" not in src` assertion fails.

- [ ] **Step 3: Edit scaler.py — remove jax imports**

Replace lines 4-5:

```python
import jax
import jax.numpy as jnp
```

with nothing (delete both lines). Keep `import numpy as np`, `import scipy as sp`, `import scipy.optimize`.

- [ ] **Step 4: Edit scaler.py — make the objective pure-numpy**

In `calc_dots`, replace `jnp.newaxis` with `np.newaxis` and `jnp.sum` with `np.sum`:

```python
        def calc_dots(s, c):
            diff = s[np.newaxis, :, :] - s[:, np.newaxis, :]
            ij_vecs = (diff[ij[:, 0], ij[:, 1], :] + ij_image) @ c
            ik_vecs = (diff[ik[:, 0], ik[:, 1], :] + ik_image) @ c
            dots = np.sum(ij_vecs * ik_vecs, axis=-1)
            return dots
```

In `objective`, replace `jnp.mean`/`jnp.square` with numpy:

```python
        def objective(s, c):
            dots = calc_dots(s, c)
            return np.mean(np.square(dots - target_dots) * weights)
```

In `fun`, replace `jnp.reshape` with `np.reshape`:

```python
        def fun(x):
            n = topology.n_slots
            s = np.reshape(x[:-9], (n, 3))
            c = np.reshape(x[-9:], (3, 3))
            return objective(s, c)
```

- [ ] **Step 5: Edit scaler.py — drop the jax gradient, use numerical jac**

Delete these three definitions:

```python
        jac = jax.jit(jax.grad(fun))

        def fun_numpy(x):
            return np.array(fun(x), dtype=np.float64)

        def jac_numpy(x):
            return np.array(jac(x), dtype=np.float64)
```

`fun` already returns a plain numpy float now, so it can be passed directly. Change the `minimize` call to drop `jac` (scipy L-BFGS-B then uses a 2-point finite-difference gradient):

```python
        result = sp.optimize.minimize(
            x0=x0,
            fun=fun,
            method="L-BFGS-B",
            bounds=bounds,
            options={"maxiter": 1000, "disp": False},
        )
```

- [ ] **Step 6: Run both scaler tests**

Run: `cd server && python -m pytest tests/test_reticular_scaler.py -v`
Expected: `test_scaler_module_has_no_jax` PASS. `test_mof5_pcu_builds_with_expected_cell` PASS once the real BB ids are filled in Task 1.1 — until then it may fail on `get_bb`. If BB ids are still unresolved at this step, mark it xfail with `@pytest.mark.xfail(reason="BB ids resolved in Task 1.1")` and revisit.

- [ ] **Step 7: Commit**

```bash
cd /home/james0001/project/catgo-LRG
git add server/catgo/vendor/pormake/scaler.py server/tests/test_reticular_scaler.py
git commit -m "vendor(pormake): swap jax->numpy/scipy in scaler.py

Objective + jac now pure numpy; L-BFGS-B uses 2-point gradient.
Eliminates jax entirely (no PyInstaller freeze risk)."
```

### Task 0.3: Add networkx dependency

**Files:**
- Modify: `server/pyproject.toml`

- [ ] **Step 1: Check whether networkx is already declared or transitively installed**

Run: `grep -n networkx server/pyproject.toml; cd server && python -c "import networkx; print(networkx.__version__)"`
Expected: either a version prints (transitively present via pymatgen) or ImportError.

- [ ] **Step 2: If not declared, add it to the dependencies array**

In `server/pyproject.toml` (the `dependencies` list, near the `pymatgen`/`scipy`/`ase` lines ~29-31), add:

```toml
"networkx>=2.8",
```

- [ ] **Step 3: Verify import resolves**

Run: `cd server && python -c "import networkx; print('ok', networkx.__version__)"`
Expected: `ok <version>`

- [ ] **Step 4: Commit**

```bash
cd /home/james0001/project/catgo-LRG
git add server/pyproject.toml
git commit -m "deps(server): declare networkx for reticular builder"
```

---

## Phase 1 — Algorithm wrapper (TDD)

### Task 1.1: Resolve preset building-block ids + write the preset table

The preset table maps friendly preset names to real bundled-DB topology + BB ids. The BB ids MUST be verified against `db.bb_list` (867 entries) — upstream BB names are short codes (e.g. `N409` = Cu paddlewheel, `N10` = BTC, per the upstream HKUST-1 example), not chemical names.

**Files:**
- Create: `server/catgo/models/reticular.py` (preset table portion)

- [ ] **Step 1: Enumerate the DB to resolve each preset's ids**

Run (interactive resolution, record the chosen ids):
```bash
cd server && python - <<'PY'
import catgo.vendor.pormake as pm
db = pm.Database()
print("topos sample:", [t for t in db.topo_list if t in ("pcu","tbo","sod","hcb")])
# Inspect candidate BBs by connection-point count to find Zn4O(6), BDC(2), Cu-pw(4), BTC(3), etc.
for name in db.bb_list[:0]:  # replace with targeted lookups while resolving
    pass
PY
```
Known anchors from upstream examples: HKUST-1 (tbo) uses node `N409` (Cu paddlewheel, cn 4) + edge `N10` (BTC, cn 3 — used as a 3-c node in tbo, not an edge). Resolve each preset's `{node_type: bb_id}` / `{edge_type: bb_id}` by matching `bb.n_connection_points` to the topology's `unique_cn` per node type. Record the final mapping in the table below.

- [ ] **Step 2: Write the preset table in `models/reticular.py`**

```python
"""Pydantic models + preset recipes for the reticular (MOF/COF) builder."""

from typing import Literal, Optional

from pydantic import BaseModel, Field

from .structure import PymatgenStructure

# Preset recipe = topology name + per-node-type BB id + per-edge-type BB id.
# node_bbs key = node type (int); edge_bbs key = edge type (tuple of two ints)
# encoded as "i,j" string for JSON friendliness, decoded in the algorithm.
# BB ids are bundled-DB codes resolved in Task 1.1 Step 1 — REPLACE placeholders.
PRESETS: dict[str, dict] = {
    "mof-5": {
        "label": "MOF-5",
        "topology": "pcu",
        "node_bbs": {0: "<Zn4O-bb-id>"},
        "edge_bbs": {"0,0": "<BDC-bb-id>"},
    },
    "hkust-1": {
        "label": "HKUST-1",
        "topology": "tbo",
        "node_bbs": {0: "N10", 1: "N409"},
        "edge_bbs": {},
    },
    "zif-8": {
        "label": "ZIF-8",
        "topology": "sod",
        "node_bbs": {0: "<Zn-bb-id>"},
        "edge_bbs": {"0,0": "<2-mim-bb-id>"},
    },
    "cof-5": {
        "label": "COF-5",
        "topology": "hcb",
        "node_bbs": {0: "<boronate-node-id>"},
        "edge_bbs": {"0,0": "<linker-id>"},
    },
}
```

(The HKUST-1 entry uses verified upstream ids `N10`/`N409` and no edge BB, matching the upstream `1_make_HKUST1.py` example. The other three placeholders MUST be replaced with resolved ids before the preset tests pass.)

- [ ] **Step 3: Commit**

```bash
cd /home/james0001/project/catgo-LRG
git add server/catgo/models/reticular.py
git commit -m "feat(reticular): preset recipe table (topology + BB ids)"
```

### Task 1.2: Algorithm wrapper — build + DB listing

**Files:**
- Create: `server/catgo/utils/reticular_algorithm.py`
- Test: `server/tests/test_reticular.py`

- [ ] **Step 1: Write failing tests for the algorithm layer**

Create `server/tests/test_reticular.py`:

```python
"""Reticular builder algorithm tests."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from pymatgen.core import Structure

from catgo.utils.reticular_algorithm import (
    build_reticular,
    list_building_blocks,
    list_topologies,
    topology_detail,
)


def test_list_topologies_returns_known_nets():
    topos = list_topologies()
    names = {t["name"] for t in topos}
    assert {"pcu", "tbo", "sod", "hcb"} <= names


def test_list_building_blocks_has_connection_counts():
    bbs = list_building_blocks(query="N409")
    assert any(b["name"] == "N409" for b in bbs)
    n409 = next(b for b in bbs if b["name"] == "N409")
    assert n409["n_connection_points"] == 4  # Cu paddlewheel


def test_topology_detail_reports_node_types_and_cn():
    detail = topology_detail("tbo")
    assert detail["name"] == "tbo"
    assert len(detail["node_types"]) == len(detail["node_cn"])
    assert all(cn > 0 for cn in detail["node_cn"])


def test_build_hkust1_advanced():
    struct = build_reticular(
        topology="tbo",
        node_bbs={0: "N10", 1: "N409"},
        edge_bbs={},
    )
    assert isinstance(struct, Structure)
    assert struct.num_sites > 0
    assert struct.lattice.volume > 0


def test_build_rejects_incompatible_bb():
    with pytest.raises(ValueError):
        # A 2-connection BB cannot fill a 4-coordinated vertex.
        build_reticular(topology="tbo", node_bbs={0: "N10", 1: "N10"}, edge_bbs={})
```

- [ ] **Step 2: Run tests to confirm they fail (module missing)**

Run: `cd server && python -m pytest tests/test_reticular.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'catgo.utils.reticular_algorithm'`.

- [ ] **Step 3: Implement the algorithm module**

Create `server/catgo/utils/reticular_algorithm.py`:

```python
"""Wrap vendored PORMAKE to build MOF/COF structures and list DB contents.

Pure functions; no FastAPI/pydantic imports. Errors raised as ValueError so the
router maps them to HTTP 400.
"""

from __future__ import annotations

import logging

from pymatgen.core import Structure
from pymatgen.io.ase import AseAtomsAdaptor

logger = logging.getLogger(__name__)

_DB = None


def _db():
    """Lazily construct the PORMAKE Database (scans bundled data dir once)."""
    global _DB
    if _DB is None:
        import catgo.vendor.pormake as pm

        _DB = pm.Database()
    return _DB


def list_topologies(query: str | None = None) -> list[dict]:
    """Return [{name, n_edge_types}] for all bundled RCSR nets (optionally filtered)."""
    names = _db().topo_list
    if query:
        q = query.lower()
        names = [n for n in names if q in n.lower()]
    return [{"name": n} for n in sorted(names)]


def list_building_blocks(query: str | None = None) -> list[dict]:
    """Return [{name, n_connection_points}] for bundled BBs (optionally filtered)."""
    db = _db()
    names = db.bb_list
    if query:
        q = query.lower()
        names = [n for n in names if q in n.lower()]
    out = []
    for n in sorted(names):
        try:
            bb = db.get_bb(n)
            out.append({"name": n, "n_connection_points": int(bb.n_connection_points)})
        except Exception:  # skip unreadable BBs rather than failing the whole list
            continue
    return out


def topology_detail(name: str) -> dict:
    """Return node/edge type structure for a net so the UI can assign BBs."""
    try:
        topo = _db().get_topo(name)
    except Exception as exc:
        raise ValueError(f"unknown topology '{name}': {exc}") from exc
    node_types = [int(t) for t in topo.unique_node_types]
    node_cn = [int(cn) for cn in topo.unique_cn]
    edge_types = [[int(a), int(b)] for a, b in topo.unique_edge_types]
    return {
        "name": name,
        "node_types": node_types,
        "node_cn": node_cn,
        "edge_types": edge_types,
    }


def _decode_edge_key(key) -> tuple[int, int]:
    """Edge-type keys arrive as 'i,j' strings (JSON) or (i, j) tuples."""
    if isinstance(key, str):
        a, b = key.split(",")
        return (int(a), int(b))
    return (int(key[0]), int(key[1]))


def build_reticular(
    topology: str,
    node_bbs: dict,
    edge_bbs: dict | None = None,
) -> Structure:
    """Build a framework and return it as a pymatgen Structure.

    node_bbs: {node_type(int): bb_id(str)}
    edge_bbs: {edge_type("i,j" or (i,j)): bb_id(str)}
    """
    import catgo.vendor.pormake as pm

    db = _db()
    try:
        topo = db.get_topo(topology)
    except Exception as exc:
        raise ValueError(f"unknown topology '{topology}': {exc}") from exc

    # Resolve node BBs and validate connection-point count vs vertex coordination.
    cn_by_type = {int(t): int(cn) for t, cn in zip(topo.unique_node_types, topo.unique_cn)}
    node_bb_objs = {}
    for t, bb_id in node_bbs.items():
        t = int(t)
        try:
            bb = db.get_bb(bb_id)
        except Exception as exc:
            raise ValueError(f"unknown building block '{bb_id}': {exc}") from exc
        if t in cn_by_type and bb.n_connection_points != cn_by_type[t]:
            raise ValueError(
                f"building block '{bb_id}' has {bb.n_connection_points} connection "
                f"points but node type {t} needs {cn_by_type[t]}"
            )
        node_bb_objs[t] = bb

    edge_bb_objs = {}
    for key, bb_id in (edge_bbs or {}).items():
        et = _decode_edge_key(key)
        try:
            edge_bb_objs[et] = db.get_bb(bb_id)
        except Exception as exc:
            raise ValueError(f"unknown building block '{bb_id}': {exc}") from exc

    builder = pm.Builder()
    try:
        framework = builder.build_by_type(
            topology=topo,
            node_bbs=node_bb_objs,
            edge_bbs=edge_bb_objs or None,
        )
    except KeyError as exc:
        raise ValueError(f"missing building block assignment: {exc}") from exc
    except Exception as exc:
        # locator alignment / scaler convergence failures bubble up here.
        raise ValueError(f"build failed: {exc}") from exc

    structure = AseAtomsAdaptor.get_structure(framework.atoms)
    return structure


def build_preset(preset: str) -> Structure:
    """Build a curated preset by name."""
    from catgo.models.reticular import PRESETS

    if preset not in PRESETS:
        raise ValueError(f"unknown preset '{preset}'; choices: {sorted(PRESETS)}")
    recipe = PRESETS[preset]
    return build_reticular(
        topology=recipe["topology"],
        node_bbs=recipe["node_bbs"],
        edge_bbs=recipe.get("edge_bbs") or {},
    )
```

- [ ] **Step 4: Run the tests**

Run: `cd server && python -m pytest tests/test_reticular.py -v`
Expected: all PASS. If `test_build_rejects_incompatible_bb` does not raise (PORMAKE may accept then fail later), adjust the validation in `build_reticular` to be the authoritative guard (it already pre-checks cn before building).

- [ ] **Step 5: Add a preset build test (uses build_preset; depends on Task 1.1 ids)**

Append to `server/tests/test_reticular.py`:

```python
@pytest.mark.parametrize("preset", ["mof-5", "hkust-1", "zif-8", "cof-5"])
def test_build_each_preset(preset):
    from catgo.utils.reticular_algorithm import build_preset

    struct = build_preset(preset)
    assert struct.num_sites > 0
    assert struct.lattice.volume > 0
```

Run: `cd server && python -m pytest tests/test_reticular.py -k preset -v`
Expected: PASS for all four once Task 1.1 ids are resolved. Any still-placeholder preset will fail on `get_bb` — resolve its id before marking this task done.

- [ ] **Step 6: Commit**

```bash
cd /home/james0001/project/catgo-LRG
git add server/catgo/utils/reticular_algorithm.py server/tests/test_reticular.py
git commit -m "feat(reticular): PORMAKE build wrapper + DB listing + tests"
```

---

## Phase 2 — Models + Router (TDD)

### Task 2.1: Request/response models

**Files:**
- Modify: `server/catgo/models/reticular.py`

- [ ] **Step 1: Append models below the PRESETS table**

```python
class ReticularBuildRequest(BaseModel):
    """Build request. mode='preset' uses `preset`; mode='advanced' uses the rest."""

    mode: Literal["preset", "advanced"] = "preset"
    preset: Optional[str] = Field(default=None, description="Preset id, e.g. 'mof-5'")
    topology: Optional[str] = Field(default=None, description="RCSR net name (advanced)")
    node_bbs: dict[int, str] = Field(
        default_factory=dict, description="{node_type: bb_id} (advanced)"
    )
    edge_bbs: dict[str, str] = Field(
        default_factory=dict, description="{'i,j': bb_id} edge-type keys (advanced)"
    )


class ReticularBuildResult(BaseModel):
    structure: PymatgenStructure
    n_atoms: int = Field(description="Total number of atoms")
    topology: str
    formula: str
    message: str = ""


class TopologyInfo(BaseModel):
    name: str


class BuildingBlockInfo(BaseModel):
    name: str
    n_connection_points: int


class TopologyDetail(BaseModel):
    name: str
    node_types: list[int]
    node_cn: list[int]
    edge_types: list[list[int]]
```

- [ ] **Step 2: Verify the module imports cleanly**

Run: `cd server && python -c "from catgo.models.reticular import ReticularBuildRequest, ReticularBuildResult, PRESETS; print(len(PRESETS))"`
Expected: `4`

- [ ] **Step 3: Commit**

```bash
cd /home/james0001/project/catgo-LRG
git add server/catgo/models/reticular.py
git commit -m "feat(reticular): request/response pydantic models"
```

### Task 2.2: Router

**Files:**
- Create: `server/catgo/routers/reticular.py`
- Test: `server/tests/test_reticular.py` (append router tests)

- [ ] **Step 1: Write failing router tests (call route fns in-process)**

Append to `server/tests/test_reticular.py`:

```python
def test_router_build_preset_returns_structure():
    from catgo.models.reticular import ReticularBuildRequest
    from catgo.routers.reticular import build_reticular_structure

    res = build_reticular_structure(
        ReticularBuildRequest(mode="preset", preset="hkust-1")
    )
    assert res.n_atoms > 0
    assert res.topology == "tbo"
    assert len(res.structure.sites) == res.n_atoms


def test_router_build_advanced_bad_topology_raises_400():
    from fastapi import HTTPException

    from catgo.models.reticular import ReticularBuildRequest
    from catgo.routers.reticular import build_reticular_structure

    with pytest.raises(HTTPException) as ei:
        build_reticular_structure(
            ReticularBuildRequest(mode="advanced", topology="not_a_net", node_bbs={0: "N10"})
        )
    assert ei.value.status_code == 400


def test_router_list_topologies():
    from catgo.routers.reticular import list_topologies_route

    res = list_topologies_route(q="pcu")
    assert any(t.name == "pcu" for t in res)
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd server && python -m pytest tests/test_reticular.py -k router -v`
Expected: FAIL — `No module named 'catgo.routers.reticular'`.

- [ ] **Step 3: Implement the router**

Create `server/catgo/routers/reticular.py`:

```python
"""Reticular (MOF/COF) builder API endpoints."""

import logging
import traceback

from fastapi import APIRouter, HTTPException

from catgo.models.reticular import (
    PRESETS,
    BuildingBlockInfo,
    ReticularBuildRequest,
    ReticularBuildResult,
    TopologyDetail,
    TopologyInfo,
)
from catgo.models.structure import Lattice, PymatgenStructure, Site, Species
from catgo.utils.reticular_algorithm import (
    build_preset,
    build_reticular,
    list_building_blocks,
    list_topologies,
    topology_detail,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/reticular", tags=["reticular"])


def _native_to_model(structure) -> PymatgenStructure:
    """Convert a pymatgen Structure to the shared PymatgenStructure model."""
    latt = Lattice(
        matrix=structure.lattice.matrix.tolist(),
        pbc=[True, True, True],
        a=float(structure.lattice.a),
        b=float(structure.lattice.b),
        c=float(structure.lattice.c),
        alpha=float(structure.lattice.alpha),
        beta=float(structure.lattice.beta),
        gamma=float(structure.lattice.gamma),
        volume=float(structure.lattice.volume),
    )
    sites = []
    for site in structure:
        element = str(site.specie)
        sites.append(
            Site(
                species=[Species(element=element, occu=1.0, oxidation_state=0)],
                abc=list(site.frac_coords),
                xyz=list(site.coords),
                label=element,
                properties={"reticular": True},
            )
        )
    return PymatgenStructure(lattice=latt, sites=sites)


@router.post("/build", response_model=ReticularBuildResult)
def build_reticular_structure(request: ReticularBuildRequest) -> ReticularBuildResult:
    """Build a MOF/COF from a preset or an explicit topology + BB assignment."""
    try:
        if request.mode == "preset":
            if not request.preset:
                raise ValueError("preset mode requires 'preset'")
            structure = build_preset(request.preset)
            topology = PRESETS[request.preset]["topology"]
        else:
            if not request.topology:
                raise ValueError("advanced mode requires 'topology'")
            structure = build_reticular(
                topology=request.topology,
                node_bbs=request.node_bbs,
                edge_bbs=request.edge_bbs,
            )
            topology = request.topology

        model = _native_to_model(structure)
        return ReticularBuildResult(
            structure=model,
            n_atoms=structure.num_sites,
            topology=topology,
            formula=structure.composition.reduced_formula,
            message=f"Built {topology} ({structure.num_sites} atoms)",
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error building reticular structure: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/topologies", response_model=list[TopologyInfo])
def list_topologies_route(q: str | None = None) -> list[TopologyInfo]:
    return [TopologyInfo(**t) for t in list_topologies(query=q)]


@router.get("/building-blocks", response_model=list[BuildingBlockInfo])
def list_building_blocks_route(q: str | None = None) -> list[BuildingBlockInfo]:
    return [BuildingBlockInfo(**b) for b in list_building_blocks(query=q)]


@router.get("/topology/{name}", response_model=TopologyDetail)
def topology_detail_route(name: str) -> TopologyDetail:
    try:
        return TopologyDetail(**topology_detail(name))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/presets")
def list_presets_route():
    return [{"id": k, "label": v["label"], "topology": v["topology"]} for k, v in PRESETS.items()]


@router.get("/health")
def reticular_health():
    return {"status": "healthy", "service": "reticular"}
```

- [ ] **Step 4: Run router tests**

Run: `cd server && python -m pytest tests/test_reticular.py -k router -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/james0001/project/catgo-LRG
git add server/catgo/routers/reticular.py server/tests/test_reticular.py
git commit -m "feat(reticular): FastAPI router (build/topologies/bbs/detail) + tests"
```

---

## Phase 3 — Registration

### Task 3.1: Register the router

**Files:**
- Modify: `server/catgo/routers/__init__.py:32`
- Modify: `server/main.py`

- [ ] **Step 1: Add to the lazy router registry**

In `server/catgo/routers/__init__.py`, in the `_ROUTERS` dict (near line 32-33 with `nanotube`/`heterostructure`), add:

```python
    "reticular_router": "reticular",
```

- [ ] **Step 2: Import in main.py (Tier A, eager — like nanotube)**

In `server/main.py`, in the `from catgo.routers import (...)` block (~line 62-93), add `reticular_router,` alphabetically near `nanotube_router`.

- [ ] **Step 3: Include the router**

In `server/main.py`, near the `app.include_router(nanotube_router, prefix="/api")` line (~389-390), add:

```python
app.include_router(reticular_router, prefix="/api")
```

- [ ] **Step 4: Verify app boots and route is registered**

Run: `cd server && python -c "from main import app; print([r.path for r in app.routes if 'reticular' in r.path])"`
Expected: includes `/api/reticular/build`, `/api/reticular/topologies`, `/api/reticular/building-blocks`, `/api/reticular/topology/{name}`, `/api/reticular/presets`, `/api/reticular/health`.

(If app import time regresses noticeably because the PORMAKE Database scans 14 MB at import, move to Tier B: remove the eager import/include and add `"reticular_router"` to `_DEFERRED_ROUTER_ATTRS` at `main.py:106-126` instead. The `_db()` lazy-init in the algorithm already defers the DB scan to first build, so Tier A should be fine — verify with the timing above.)

- [ ] **Step 5: Commit**

```bash
cd /home/james0001/project/catgo-LRG
git add server/catgo/routers/__init__.py server/main.py
git commit -m "feat(reticular): register router under /api/reticular"
```

---

## Phase 4 — MCP

### Task 4.1: Add MCP tool entry

**Files:**
- Modify: `server/catgo/mcp_tools/tools/nanotube_moire.py`
- Modify: `server/catgo/tool_schema/building.json`

- [ ] **Step 1: Append the live MCP entry to the `TOOLS` list**

In `server/catgo/mcp_tools/tools/nanotube_moire.py`, append to the `TOOLS` list (do NOT list `structure` in `required` — this builder creates from scratch, so we want neither auto-fetch of a current structure nor a required input; the result carries `structure` so auto-push still fires):

```python
    {
        "name": "catgo_reticular_build",
        "description": (
            "Build a MOF or COF crystal structure from reticular chemistry: an "
            "RCSR topology (net) plus building blocks. Use a curated preset "
            "(mof-5, hkust-1, zif-8, cof-5) for the common case, or advanced mode "
            "with an explicit topology + per-node/edge building-block assignment. "
            "Triggers: build a MOF, make HKUST-1, ZIF-8, MOF-5, reticular framework, "
            "metal-organic framework, covalent organic framework."
        ),
        "endpoint": "/reticular/build",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["preset", "advanced"],
                    "default": "preset",
                    "description": "preset uses a named recipe; advanced takes topology+BBs",
                },
                "preset": {
                    "type": "string",
                    "enum": ["mof-5", "hkust-1", "zif-8", "cof-5"],
                    "description": "Preset id (mode=preset)",
                },
                "topology": {"type": "string", "description": "RCSR net name (mode=advanced)"},
                "node_bbs": {
                    "type": "object",
                    "description": "{node_type: bb_id} (mode=advanced)",
                },
                "edge_bbs": {
                    "type": "object",
                    "description": "{'i,j': bb_id} edge-type keys (mode=advanced)",
                },
            },
            "required": [],
        },
    },
```

- [ ] **Step 2: Mirror the same entry into `building.json`**

Append the equivalent object (same `name`/`description`/`endpoint`/`method`/`inputSchema`) to the JSON array in `server/catgo/tool_schema/building.json`.

- [ ] **Step 3: Verify both parse and the tool is aggregated**

Run:
```bash
cd server && python -c "
import json; json.load(open('catgo/tool_schema/building.json')); print('building.json ok')
from catgo.mcp_tools.tools import TOOLS
print('reticular in TOOLS:', any(t['name']=='catgo_reticular_build' for t in TOOLS))
"
```
Expected: `building.json ok` and `reticular in TOOLS: True`.

- [ ] **Step 4: Commit**

```bash
cd /home/james0001/project/catgo-LRG
git add server/catgo/mcp_tools/tools/nanotube_moire.py server/catgo/tool_schema/building.json
git commit -m "feat(reticular): MCP tool entry catgo_reticular_build (auto-push)"
```

---

## Phase 5 — CLI (TDD)

CLI builds in-process via `call_route`. Unlike existing structure-mutating ops, `reticular` creates a structure from scratch and needs no input structure. The argparse layer auto-adds a positional `input` to every build op; the handler ignores it.

### Task 5.1: CLI handler + registration

**Files:**
- Modify: `server/catgo/cli/ops_build.py`
- Modify: `server/catgo/cli/ops.py`
- Test: `server/tests/cli/test_ops_build.py`

- [ ] **Step 1: Write the failing CLI test**

Append to `server/tests/cli/test_ops_build.py`:

```python
def test_reticular_preset_builds_without_input_structure():
    from catgo.cli.registry import Session
    from catgo.cli import ops_build

    session = Session()  # no active structure
    res = ops_build.reticular(session, {"mode": "preset", "preset": "hkust-1"})
    assert res.ok
    assert res.structure is not None
    assert res.structure.num_sites > 0


def test_reticular_advanced_build():
    from catgo.cli.registry import Session
    from catgo.cli import ops_build

    session = Session()
    res = ops_build.reticular(
        session,
        {"mode": "advanced", "topology": "tbo", "node": "0=N10,1=N409"},
    )
    assert res.ok
    assert res.structure.num_sites > 0
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd server && python -m pytest tests/cli/test_ops_build.py -k reticular -v`
Expected: FAIL — `module 'catgo.cli.ops_build' has no attribute 'reticular'`.

- [ ] **Step 3: Implement the handler**

In `server/catgo/cli/ops_build.py`, add imports at the top (alongside the existing `structure_ops` imports):

```python
from catgo.models.reticular import ReticularBuildRequest
from catgo.routers.reticular import build_reticular_structure
from pymatgen.core import Structure
```

Add the handler. It parses the optional `node`/`edge` dual-form strings (`"0=N10,1=N409"`) into the `node_bbs`/`edge_bbs` dicts the request expects:

```python
def _parse_assignment(spec: str | None) -> dict:
    """'0=N10,1=N409' -> {'0': 'N10', '1': 'N409'} (keys kept as str for edges)."""
    if not spec:
        return {}
    out = {}
    for part in spec.split(","):
        if "=" not in part:
            raise OpError(f"bad assignment '{part}', expected key=bb_id")
        k, v = part.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def reticular(session, params: dict) -> OpResult:
    mode = params.get("mode", "preset")
    if mode == "preset":
        req = ReticularBuildRequest(mode="preset", preset=params.get("preset"))
    else:
        node_raw = _parse_assignment(params.get("node"))
        req = ReticularBuildRequest(
            mode="advanced",
            topology=params.get("topology"),
            node_bbs={int(k): v for k, v in node_raw.items()},
            edge_bbs=_parse_assignment(params.get("edge")),
        )
    res = call_route(build_reticular_structure, ReticularBuildRequest, **req.model_dump())
    new = Structure.from_dict(res.structure.model_dump())
    return OpResult(ok=True, message=f"reticular {res.topology} -> {new.num_sites} sites", structure=new)
```

(`OpError` and `OpResult` are already imported in this module; confirm and add `from catgo.cli.registry import OpError` if missing.)

- [ ] **Step 4: Register the op**

In `server/catgo/cli/ops.py` `build_registry()`, add:

```python
reg.add(Operation(
    name="reticular", group="build", summary="MOF/COF from topology + building blocks",
    params=[
        Param("mode", str, default="preset", choices=["preset", "advanced"], help="preset|advanced"),
        Param("preset", str, default="", help="preset id: mof-5|hkust-1|zif-8|cof-5"),
        Param("topology", str, default="", help="RCSR net name (advanced)"),
        Param("node", str, default="", help="node BB assignment, e.g. 0=N10,1=N409"),
        Param("edge", str, default="", help="edge BB assignment, e.g. 0,0=E1"),
    ],
    handler=ops_build.reticular,
    needs_server=False,
    mutates=True,
))
```

(All `Param` defaults are non-`None` so none are required — the op can run with just `--preset`. The auto-added positional `input` is optional in practice; the handler ignores `session.structure`.)

- [ ] **Step 5: Run the CLI tests**

Run: `cd server && python -m pytest tests/cli/test_ops_build.py -k reticular -v`
Expected: PASS. If the `Session()` with no structure trips a guard elsewhere, confirm the handler never calls `require_structure` (it must not).

- [ ] **Step 6: Smoke-test the argparse wiring end-to-end**

Run: `cd server && python -m catgo.cli build reticular --preset hkust-1 -o /tmp/hkust1.cif && head -3 /tmp/hkust1.cif`
Expected: a CIF written to `/tmp/hkust1.cif` (invocation form may differ — match how other `build` ops are invoked in `tests/cli/test_argparse.py`).

- [ ] **Step 7: Commit**

```bash
cd /home/james0001/project/catgo-LRG
git add server/catgo/cli/ops_build.py server/catgo/cli/ops.py server/tests/cli/test_ops_build.py
git commit -m "feat(reticular): CLI 'build reticular' (preset + advanced) + tests"
```

---

## Phase 6 — Frontend

### Task 6.1: API client

**Files:**
- Create: `src/lib/api/reticular.ts`

- [ ] **Step 1: Implement the typed fetch client (modeled on nanotube.ts)**

```ts
import type { PymatgenStructure } from '$lib/structure'
import { SERVER_URL } from './config'

function format_error_detail(detail: unknown): string {
  if (typeof detail === `string`) return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        if (typeof d === `object` && d?.msg) {
          const loc = Array.isArray(d.loc) ? d.loc.join(`.`) : ``
          return loc ? `${d.msg} (${loc})` : d.msg
        }
        return JSON.stringify(d)
      })
      .join(`; `)
  }
  return JSON.stringify(detail)
}

export interface ReticularBuildResult {
  structure: PymatgenStructure
  n_atoms: number
  topology: string
  formula: string
  message: string
}

export interface TopologyInfo {
  name: string
}

export interface BuildingBlockInfo {
  name: string
  n_connection_points: number
}

export interface TopologyDetail {
  name: string
  node_types: number[]
  node_cn: number[]
  edge_types: number[][]
}

export interface PresetInfo {
  id: string
  label: string
  topology: string
}

async function get_json<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(err.detail) || `Server error: ${response.status}`)
  }
  return response.json()
}

export async function listPresets(server_url = SERVER_URL): Promise<PresetInfo[]> {
  return get_json(`${server_url}/api/reticular/presets`)
}

export async function listTopologies(q = ``, server_url = SERVER_URL): Promise<TopologyInfo[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : ``
  return get_json(`${server_url}/api/reticular/topologies${qs}`)
}

export async function listBuildingBlocks(q = ``, server_url = SERVER_URL): Promise<BuildingBlockInfo[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : ``
  return get_json(`${server_url}/api/reticular/building-blocks${qs}`)
}

export async function getTopology(name: string, server_url = SERVER_URL): Promise<TopologyDetail> {
  return get_json(`${server_url}/api/reticular/topology/${encodeURIComponent(name)}`)
}

export async function buildReticular(
  body: {
    mode: `preset` | `advanced`
    preset?: string
    topology?: string
    node_bbs?: Record<number, string>
    edge_bbs?: Record<string, string>
  },
  server_url = SERVER_URL,
): Promise<ReticularBuildResult> {
  const response = await fetch(`${server_url}/api/reticular/build`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(err.detail) || `Server error: ${response.status}`)
  }
  return response.json()
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /home/james0001/project/catgo-LRG && pnpm exec svelte-check --threshold error 2>&1 | grep -i reticular || echo "no reticular errors"`
Expected: `no reticular errors`.

- [ ] **Step 3: Commit**

```bash
cd /home/james0001/project/catgo-LRG
git add src/lib/api/reticular.ts
git commit -m "feat(reticular): frontend API client"
```

### Task 6.2: i18n keys

**Files:**
- Modify: `src/lib/i18n/en/structure.ts`
- Modify: `src/lib/i18n/zh/structure.ts`

- [ ] **Step 1: Add the short tab label in both locales**

In `src/lib/i18n/en/structure.ts`, in the `// Build Pane` block (~line 538, after `pathway:`), add:

```ts
  reticular: `Reticular`,
```

In `src/lib/i18n/zh/structure.ts`, same location, add:

```ts
  reticular: `网格框架 (MOF/COF)`,
```

- [ ] **Step 2: Add pane content keys in both locales**

In `src/lib/i18n/en/structure.ts` (near the `heterostructure_*` block ~line 465), add:

```ts
  reticular_builder: `Reticular Builder`,
  reticular_mode_preset: `Preset`,
  reticular_mode_advanced: `Advanced`,
  reticular_hint_preset: `Pick a curated MOF/COF recipe and build in one click.`,
  reticular_hint_advanced: `Choose an RCSR topology, then assign a building block to each node/edge type.`,
  reticular_preset: `Preset`,
  reticular_topology: `Topology (net)`,
  reticular_node_bb: `Node building block`,
  reticular_edge_bb: `Edge building block`,
  reticular_build: `Build framework`,
```

In `src/lib/i18n/zh/structure.ts`, same keys:

```ts
  reticular_builder: `网格框架构建器`,
  reticular_mode_preset: `预设`,
  reticular_mode_advanced: `高级`,
  reticular_hint_preset: `选择一个常见 MOF/COF 配方，一键构建。`,
  reticular_hint_advanced: `选择 RCSR 拓扑网，再为每个节点/边类型指派构建块。`,
  reticular_preset: `预设`,
  reticular_topology: `拓扑网`,
  reticular_node_bb: `节点构建块`,
  reticular_edge_bb: `边构建块`,
  reticular_build: `构建框架`,
```

- [ ] **Step 3: Verify both locale files still parse (typecheck)**

Run: `cd /home/james0001/project/catgo-LRG && pnpm exec svelte-check --threshold error 2>&1 | grep -i structure.ts || echo "ok"`
Expected: `ok` (no errors in the structure i18n files).

- [ ] **Step 4: Commit**

```bash
cd /home/james0001/project/catgo-LRG
git add src/lib/i18n/en/structure.ts src/lib/i18n/zh/structure.ts
git commit -m "feat(reticular): i18n labels + pane content keys (en/zh)"
```

### Task 6.3: ReticularPane component

**Files:**
- Create: `src/lib/structure/ReticularPane.svelte`

- [ ] **Step 1: Implement the pane (modeled on NanotubePane: prop block, status state, push pattern)**

```svelte
<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import type { AnyStructure, PymatgenStructure } from '$lib/structure'
  import Select from 'svelte-multiselect'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { DraggablePane } from '$lib'
  import { SERVER_URL } from '$lib/api/config'
  import {
    buildReticular,
    listPresets,
    listTopologies,
    listBuildingBlocks,
    getTopology,
    type PresetInfo,
    type TopologyDetail,
  } from '$lib/api/reticular'

  load_i18n_module('structure')

  let {
    structure = $bindable(),
    pane_open = $bindable(false),
    server_url = SERVER_URL,
    show_toggle = true,
    embedded = false,
    on_push_undo,
    on_structure_change,
    pane_props = {},
    toggle_props = {},
  }: {
    structure?: PymatgenStructure
    pane_open?: boolean
    server_url?: string
    show_toggle?: boolean
    embedded?: boolean
    on_push_undo?: () => void
    on_structure_change?: (structure: AnyStructure) => void
    pane_props?: ComponentProps<typeof DraggablePane>[`pane_props`]
    toggle_props?: ComponentProps<typeof DraggablePane>[`toggle_props`]
  } = $props()

  let mode = $state<`preset` | `advanced`>(`preset`)
  let build_status = $state<`idle` | `building` | `done` | `error`>(`idle`)
  let error_message = $state<string | null>(null)
  let result_message = $state<string | null>(null)

  let presets = $state<PresetInfo[]>([])
  let selected_preset = $state<string[]>([]) // svelte-multiselect value is an array

  // Advanced state
  let topo_options = $state<string[]>([])
  let selected_topology = $state<string[]>([])
  let topo_detail = $state<TopologyDetail | null>(null)
  let bb_options = $state<string[]>([])
  let node_assignment = $state<Record<number, string>>({})
  let edge_assignment = $state<Record<string, string>>({})

  $effect(() => {
    listPresets(server_url).then((p) => (presets = p)).catch(() => {})
  })

  async function refresh_topologies(q: string) {
    try {
      const list = await listTopologies(q, server_url)
      topo_options = list.map((x) => x.name)
    } catch (err) {
      error_message = err instanceof Error ? err.message : String(err)
    }
  }

  async function refresh_bbs(q: string) {
    try {
      const list = await listBuildingBlocks(q, server_url)
      bb_options = list.map((x) => x.name)
    } catch (err) {
      error_message = err instanceof Error ? err.message : String(err)
    }
  }

  async function load_topo_detail(name: string) {
    try {
      topo_detail = await getTopology(name, server_url)
      node_assignment = {}
      edge_assignment = {}
    } catch (err) {
      error_message = err instanceof Error ? err.message : String(err)
    }
  }

  async function do_build() {
    on_push_undo?.()
    error_message = null
    build_status = `building`
    try {
      const body =
        mode === `preset`
          ? { mode, preset: selected_preset[0] }
          : {
              mode,
              topology: selected_topology[0],
              node_bbs: node_assignment,
              edge_bbs: edge_assignment,
            }
      const result = await buildReticular(body, server_url)
      structure = result.structure
      on_structure_change?.(result.structure)
      build_status = `done`
      result_message = result.message
    } catch (err) {
      build_status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }
</script>

{#snippet pane_content()}
  <div class="reticular-pane-body">
    <div class="mode-tabs">
      <button class:active={mode === `preset`} onclick={() => (mode = `preset`)}>
        {t('structure.reticular_mode_preset')}
      </button>
      <button class:active={mode === `advanced`} onclick={() => (mode = `advanced`)}>
        {t('structure.reticular_mode_advanced')}
      </button>
    </div>

    {#if mode === `preset`}
      <p class="hint">{t('structure.reticular_hint_preset')}</p>
      <label>{t('structure.reticular_preset')}</label>
      <Select
        options={presets.map((p) => p.id)}
        maxSelect={1}
        bind:selected={selected_preset}
        placeholder="MOF-5, HKUST-1, ZIF-8, COF-5"
      />
    {:else}
      <p class="hint">{t('structure.reticular_hint_advanced')}</p>
      <label>{t('structure.reticular_topology')}</label>
      <Select
        options={topo_options}
        maxSelect={1}
        bind:selected={selected_topology}
        placeholder="pcu, tbo, sod, hcb…"
        on:filter={(e) => refresh_topologies(e.detail?.option ?? ``)}
        on:add={() => {
          if (selected_topology[0]) load_topo_detail(selected_topology[0])
        }}
      />
      {#if topo_detail}
        {#each topo_detail.node_types as nt, i}
          <label>{t('structure.reticular_node_bb')} #{nt} (cn={topo_detail.node_cn[i]})</label>
          <Select
            options={bb_options}
            maxSelect={1}
            placeholder="search building blocks…"
            on:filter={(e) => refresh_bbs(e.detail?.option ?? ``)}
            on:add={(e) => (node_assignment[nt] = e.detail?.option)}
          />
        {/each}
        {#each topo_detail.edge_types as et}
          <label>{t('structure.reticular_edge_bb')} ({et[0]},{et[1]})</label>
          <Select
            options={bb_options}
            maxSelect={1}
            placeholder="search building blocks (optional)…"
            on:filter={(e) => refresh_bbs(e.detail?.option ?? ``)}
            on:add={(e) => (edge_assignment[`${et[0]},${et[1]}`] = e.detail?.option)}
          />
        {/each}
      {/if}
    {/if}

    <button class="build-btn" onclick={do_build} disabled={build_status === `building`}>
      {build_status === `building` ? `…` : t('structure.reticular_build')}
    </button>

    {#if error_message}
      <div class="error">{error_message}</div>
    {/if}
    {#if result_message && build_status === `done`}
      <div class="success">{result_message}</div>
    {/if}
  </div>
{/snippet}

{#if !embedded}
  <DraggablePane
    bind:show={pane_open}
    open_icon="Cross"
    closed_icon="Layers"
    show_toggle={show_toggle && !embedded}
    pane_props={{ ...pane_props, class: `reticular-pane ${pane_props?.class ?? ``}` }}
    toggle_props={{
      title: pane_open ? `` : t('structure.reticular_builder'),
      ...toggle_props,
      class: `reticular-toggle ${toggle_props?.class ?? ``}`,
    }}
  >
    {@render pane_content()}
  </DraggablePane>
{:else}
  {@render pane_content()}
{/if}

<style>
  .reticular-pane-body { display: flex; flex-direction: column; gap: 0.5em; padding: 0.5em; }
  .mode-tabs { display: flex; gap: 0.25em; }
  .mode-tabs button.active { font-weight: bold; }
  .hint { font-size: 0.85em; opacity: 0.8; margin: 0; }
  .build-btn { margin-top: 0.5em; }
  .error { color: var(--error-color, crimson); font-size: 0.85em; }
  .success { color: var(--success-color, seagreen); font-size: 0.85em; }
</style>
```

(The `svelte-multiselect` event names — `on:filter`/`on:add` — and `bind:selected` vs `bind:value` must be confirmed against `src/lib/plot/ColorScaleSelect.svelte` and the installed `svelte-multiselect@11.2.4` API; adjust binding/event wiring to match that working example.)

- [ ] **Step 2: Typecheck the pane**

Run: `cd /home/james0001/project/catgo-LRG && pnpm exec svelte-check --threshold error 2>&1 | grep -i ReticularPane || echo "no ReticularPane errors"`
Expected: `no ReticularPane errors` (fix any reported type/binding issues against the ColorScaleSelect reference).

- [ ] **Step 3: Commit**

```bash
cd /home/james0001/project/catgo-LRG
git add src/lib/structure/ReticularPane.svelte
git commit -m "feat(reticular): ReticularPane (preset + advanced modes)"
```

### Task 6.4: Wire the tab into BuildPane + Structure.svelte

**Files:**
- Modify: `src/lib/structure/controllers/build-tools.svelte.ts:21`
- Modify: `src/lib/structure/BuildPane.svelte:9,11-23`
- Modify: `src/lib/structure/Structure.svelte`

- [ ] **Step 1: Add `'reticular'` to the `BuildTab` union in both files**

In `src/lib/structure/controllers/build-tools.svelte.ts:21` and `src/lib/structure/BuildPane.svelte:9`, append `| 'reticular'` to the `BuildTab` type union.

- [ ] **Step 2: Add the tab definition**

In `src/lib/structure/BuildPane.svelte`, in `tab_defs` (~line 11-23), add after the `pathway` entry:

```ts
  { id: 'reticular', label: () => t('structure.reticular') },
```

- [ ] **Step 3: Import + render branch in Structure.svelte**

In `src/lib/structure/Structure.svelte`, add `ReticularPane` to the structure-pane imports (near line 57-58 with `NanotubePane, HeterostructurePane`):

```ts
  import ReticularPane from '$lib/structure/ReticularPane.svelte'
```

Add the render branch in the `{:else if}` chain (after the `nanotube` branch ~line 3033):

```svelte
{:else if build.active_build_tab === 'reticular'}
  <ReticularPane
    embedded={true}
    bind:structure={structure as PymatgenStructure}
    pane_open={true}
    on_push_undo={push_to_undo}
    on_structure_change={(new_struct) => build.handle_structure_replace(new_struct)}
  />
```

- [ ] **Step 4: Typecheck the whole frontend**

Run: `cd /home/james0001/project/catgo-LRG && pnpm exec svelte-check --threshold error 2>&1 | tail -5`
Expected: no new errors referencing reticular / BuildPane / Structure.svelte.

- [ ] **Step 5: Commit**

```bash
cd /home/james0001/project/catgo-LRG
git add src/lib/structure/controllers/build-tools.svelte.ts src/lib/structure/BuildPane.svelte src/lib/structure/Structure.svelte
git commit -m "feat(reticular): add Reticular build tab + render branch"
```

---

## Phase 7 — Validation & polish

### Task 7.1: Round-trip cross-check against the Rust MOF detector (bonus)

The existing Rust `extensions/rust/src/mof/` (`detect_sbus`, SBU typing) deconstructs MOFs. Feeding a built preset into it independently validates the build is chemically sane.

**Files:**
- Test: `server/tests/test_reticular.py` (append, gated on the Rust extension being importable)

- [ ] **Step 1: Locate how the Rust MOF detector is invoked from Python**

Run: `grep -rn "detect_sbus\|def detect\|mof" server/catgo --include=*.py | grep -iv test | head`
Expected: the Python entry point (binding or subprocess) that runs `detect_sbus`. If there is no Python-reachable binding, SKIP this task and note it — the round-trip is a bonus, not a gate.

- [ ] **Step 2: Add a gated round-trip test**

```python
def test_hkust1_roundtrip_sbu_detection():
    pytest.importorskip("catgo")  # adjust to the actual MOF-detector import
    from catgo.utils.reticular_algorithm import build_preset
    struct = build_preset("hkust-1")
    # Call the MOF detector on `struct` and assert the detected SBU set is
    # non-empty / matches the Cu paddlewheel. Exact API per Step 1.
    assert struct.num_sites > 0  # placeholder until detector API confirmed
```

- [ ] **Step 3: Run + commit (only if a Python binding exists)**

Run: `cd server && python -m pytest tests/test_reticular.py -k roundtrip -v`

```bash
git add server/tests/test_reticular.py
git commit -m "test(reticular): round-trip SBU detection cross-check"
```

### Task 7.2: Full backend test sweep + manual smoke

- [ ] **Step 1: Run the full reticular + CLI test suite**

Run: `cd server && python -m pytest tests/test_reticular.py tests/test_reticular_scaler.py tests/cli/test_ops_build.py -v`
Expected: all PASS (round-trip may be skipped).

- [ ] **Step 2: Boot the server and hit the live endpoints**

```bash
cd server && (python -m uvicorn main:app --port 8000 &) && sleep 5
curl -s "http://localhost:8000/api/reticular/presets"
curl -s -X POST "http://localhost:8000/api/reticular/build" -H 'Content-Type: application/json' -d '{"mode":"preset","preset":"hkust-1"}' | python -c "import sys,json; d=json.load(sys.stdin); print('atoms', d['n_atoms'], 'topo', d['topology'], 'formula', d['formula'])"
```
Expected: presets list returns 4 entries; build returns a structure with `n_atoms > 0`, `topology == "tbo"`.

- [ ] **Step 3: Frontend manual check (desktop dev)**

Per memory `reference_catgo_worktree_dev_setup` (run `desktop:dev`, not `serve`): run the desktop dev server, open the structure viewer, switch to the **Reticular** build tab, pick a preset, build, and confirm the framework appears in the viewer. (Advanced mode: pick `tbo`, assign `N10`/`N409`, build.)

- [ ] **Step 4: Final lint/format pass**

Run: `cd /home/james0001/project/catgo-LRG && pnpm exec svelte-check --threshold error 2>&1 | tail -3`
Expected: no reticular-related errors.

---

## Self-Review Notes

- **Spec coverage:** vendored jax-free fork (Task 0.1-0.2 ✓), networkx dep (0.3 ✓), backend triad (1.1-2.2 ✓), 4 presets (1.1 ✓), advanced mode (1.2/2.2 ✓), MCP auto-push (4.1 ✓), CLI dual-form (5.1 ✓), frontend pane + tab + i18n + auto-push (6.1-6.4 ✓), round-trip cross-check (7.1 ✓ bonus), error handling 400/500 (2.2 ✓).
- **Open items carried from spec (resolve during impl, do not block on):** exact bundled-DB BB ids for MOF-5/ZIF-8/COF-5 (Task 1.1 Step 1); whether networkx is already transitive (0.3 Step 1); Tier A vs Tier B router registration depending on import timing (3.1 Step 4); `svelte-multiselect@11.2.4` exact event/bind API vs the ColorScaleSelect reference (6.3 Step 1); Python reachability of the Rust MOF detector (7.1 Step 1).
- **Naming consistency:** algorithm fns `build_reticular`/`build_preset`/`list_topologies`/`list_building_blocks`/`topology_detail`; router fns `build_reticular_structure`/`list_topologies_route`/`list_building_blocks_route`/`topology_detail_route`; result type `ReticularBuildResult` with fields `structure/n_atoms/topology/formula/message` — used consistently across backend, CLI, MCP, and frontend types.
```
