# MOF Database Search (MOFX-DB) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users search the MOFX-DB MOF database by name + source-database and load a chosen MOF's structure into the CatGO viewer, as a third "Search" mode in `ReticularPane` (alongside Preset / Advanced).

**Architecture:** New FastAPI router `/api/mofdb` (`POST /search` + `GET /structure`) wrapping the optional `mofdb_client` package (lazy import). Search returns lightweight hits; selecting one fetches that MOF's CIF, parses it to a pymatgen `Structure` on the backend, and returns the shared `PymatgenStructure` model. The frontend `ReticularPane` Search tab loads the result via the exact two-line push the builder already uses (`structure = …; on_structure_change?.(…)`).

**Tech Stack:** Python (FastAPI, pydantic, pymatgen, `mofdb_client` [MIT, optional]), SvelteKit / Svelte 5.

**Spec:** `docs/superpowers/specs/2026-05-26-mof-search-design.md`

**Branch / worktree:** `feat/reticular-mof-builder` in worktree `.worktrees/reticular`. Confirm `git branch --show-current` = `feat/reticular-mof-builder` before each task; do NOT switch branches (a second Claude works the main checkout on another branch). RTK may serve stale pytest output — run `rtk proxy python -m pytest …`.

**Investigation facts (ground truth):**
- `mofdb_client.fetch(name=…, database=…, mofid=…, mofkey=…, vf_min/max, lcd_min/max, pld_min/max, sa_*_min/max, limit=…, telemetry=…)` → LAZY iterator of MOF objects. NEVER `list(fetch())` (DB is huge); always pass `limit` and iterate with a cap. No `elements` filter. No API key. Hits `mof.tech.northwestern.edu`. MIT.
- MOF object: `mof.cif` (CIF string), `mof.name` (str), `mof.id`, `mof.database` (str), `mof.elements` (iterable; `[str(e) for e in mof.elements]`). No single `.formula`.
- Valid `database` values: `CoREMOF 2014`, `CoREMOF 2019`, `CSD`, `hMOF`, `IZA`, `PCOD-syn`, `Tobacco`.
- Existing fetch routers (`materials_project.py`) use router `prefix=`, `POST /search`, `GET /structure/...`, two-tier errors (`ValueError→400`, `Exception→500`).
- Shared structure model `server/catgo/models/structure.py`: `Lattice`, `Site`, `Species`, `PymatgenStructure`. The `_native_to_model(pmg_structure)→PymatgenStructure` helper already exists in `server/catgo/routers/reticular.py` (mirror it).
- ReticularPane push: `structure = result.structure` + `on_structure_change?.(result.structure)`; `on_structure_change` routes to `build.handle_structure_replace` in Structure.svelte. Mode tabs: `let mode = $state<…>()` + `.mode-tabs` buttons + `{#if mode===…}{:else if}…{/if}`. MP key utils live in `$lib/api/materials-project` (not needed here — MOFX-DB has no key).

---

## File Structure

**Create:**
- `server/catgo/models/mofdb.py` — pydantic models
- `server/catgo/utils/mofdb_search.py` — `mofdb_client` wrapper (search + get-by-mofid + CIF→pymatgen)
- `server/catgo/routers/mofdb.py` — FastAPI routes
- `server/tests/test_mofdb.py` — mocked tests + gated live smoke
- `src/lib/api/mofdb.ts` — typed fetch client

**Modify:**
- `server/pyproject.toml` — add `[project.optional-dependencies] mofsearch = ["mofdb-client>=…"]`
- `server/catgo/routers/__init__.py` — register `mofdb_router`
- `server/main.py` — import + `include_router(mofdb_router, prefix="/api")`
- `src/lib/structure/ReticularPane.svelte` — add `'search'` mode tab + UI
- `src/lib/i18n/en/structure.ts`, `src/lib/i18n/zh/structure.ts` — Search-tab strings

---

## Task 0: Add the optional `mofsearch` dependency + install it

**Files:** Modify `server/pyproject.toml`

- [ ] **Step 1: Find the real package name + version on PyPI**

Run: `pip index versions mofdb-client 2>/dev/null || pip install mofdb-client 2>&1 | tail -5`
Expected: installs `mofdb-client`. Confirm the import name: `python -c "import mofdb_client; print(mofdb_client.__file__)"` (PyPI name `mofdb-client`, import `mofdb_client`).

- [ ] **Step 2: Add the optional extra in pyproject.toml**

In `server/pyproject.toml`, under `[project.optional-dependencies]` (where `full = [...]` lives), add:

```toml
mofsearch = [
    "mofdb-client>=0.10.0",
]
```
(Use the actual current version floor you saw in Step 1; if unsure, `>=0.1`.)

- [ ] **Step 3: Confirm install + introspect the real API (records facts for later tasks)**

```bash
python - <<'PY'
import mofdb_client as m, inspect
print("fetch sig:", inspect.signature(m.fetch))
it = m.fetch(database="CoREMOF 2019", limit=1)
mof = next(it)
print("attrs:", [a for a in dir(mof) if not a.startswith("_")])
print("name:", mof.name, "| id:", mof.id, "| database:", mof.database)
print("elements:", [str(e) for e in mof.elements])
print("cif head:", mof.cif[:80].replace(chr(10), " "))
# Determine the round-trip key: which of mofid/id/mofkey re-fetches THIS mof.
PY
```
Expected: prints a real MOF's attrs + a CIF header. **Record which identifier round-trips** — try `next(m.fetch(mofid=<mof.mofid or mof.id>, limit=1))` and confirm it returns the same MOF. Whichever works (`mofid` string or numeric `id` coerced) is the `ROUND_TRIP_KEY` used in Task 2. (If network is unavailable in this env, note it and proceed; tests are mocked, and the live round-trip is verified in Task 7's gated smoke.)

- [ ] **Step 4: Commit**

```bash
cd /home/james0001/project/catgo-LRG/.worktrees/reticular
git add server/pyproject.toml
git commit -m "deps(mofdb): add optional [mofsearch] extra (mofdb-client)"
```

---

## Task 1: Pydantic models

**Files:** Create `server/catgo/models/mofdb.py`

- [ ] **Step 1: Write the models**

```python
"""Pydantic models for MOF-database (MOFX-DB) search."""

from pydantic import BaseModel, Field

from .structure import PymatgenStructure


class MofSearchRequest(BaseModel):
    name: str | None = Field(default=None, description="Name prefix search")
    database: str | None = Field(
        default=None,
        description="Source DB: CoREMOF 2014|CoREMOF 2019|CSD|hMOF|IZA|PCOD-syn|Tobacco",
    )
    limit: int = Field(default=50, ge=1, le=200)


class MofHit(BaseModel):
    # Round-trip key is (name, database) — mofdb_client.fetch() has no `id` kwarg,
    # `mofid` is None in CoREMOF, and `name` alone is not unique (mirrored across
    # CoREMOF 2014/2019). `id` is the true unique int key (shown for reference/dedup
    # but cannot be queried back). Task-0 introspection confirmed this.
    id: int = 0
    name: str
    database: str = ""
    elements: list[str] = Field(default_factory=list)
    n_elements: int = 0


class MofSearchResult(BaseModel):
    hits: list[MofHit]
    count: int


class MofStructureResult(BaseModel):
    structure: PymatgenStructure
    name: str
    database: str
```

> **Task-0 corrections applied throughout this plan:** the round-trip identifier is
> **(`name`, `database`)**, NOT `mofid`. The structure endpoint takes `name` +
> `database` query params. `mofdb_client.fetch()` has a `limit` StopIteration/PEP-479
> bug (raises `RuntimeError: generator raised StopIteration` when matches < limit) —
> so the wrapper does NOT pass `limit` to `fetch()`; it iterates and breaks at the cap
> client-side. `cif` is present on list-response MOF objects (no separate detail call).

- [ ] **Step 2: Verify import**

Run: `cd server && python -c "from catgo.models.mofdb import MofSearchRequest, MofHit, MofSearchResult, MofStructureResult; print('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add server/catgo/models/mofdb.py
git commit -m "feat(mofdb): search request/result pydantic models"
```

---

## Task 2: `mofdb_client` wrapper (search + get-structure) with mocked tests

**Files:** Create `server/catgo/utils/mofdb_search.py`, `server/tests/test_mofdb.py`

- [ ] **Step 1: Write failing tests (mock `mofdb_client.fetch`)**

Create `server/tests/test_mofdb.py`:

```python
"""MOFX-DB search wrapper tests (mofdb_client is mocked — no live network)."""
import os
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from pymatgen.core import Structure


# A minimal fake MOF object matching the mofdb_client contract.
class _FakeMof:
    def __init__(self, id, name, database, elements, cif):
        self.id = id
        self.mofid = f"mofid-{id}"
        self.name = name
        self.database = database
        self.elements = elements
        self.cif = cif


_CIF = """data_test
_cell_length_a 10.0
_cell_length_b 10.0
_cell_length_c 10.0
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_symmetry_space_group_name_H-M 'P 1'
loop_
_atom_site_label
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Zn1 0.0 0.0 0.0
O1 0.5 0.5 0.5
"""


def _install_fake_mofdb_client(monkeypatch, mofs):
    fake = types.ModuleType("mofdb_client")

    def fetch(**kwargs):
        # honor mofid round-trip: if mofid given, yield only the matching fake
        mofid = kwargs.get("mofid")
        for mof in mofs:
            if mofid is not None and mof.mofid != mofid and str(mof.id) != str(mofid):
                continue
            yield mof

    fake.fetch = fetch
    monkeypatch.setitem(sys.modules, "mofdb_client", fake)
    return fake


def test_search_maps_mofs_to_hits(monkeypatch):
    mofs = [
        _FakeMof(1, "MOF-5", "CoREMOF 2019", ["Zn", "O", "C"], _CIF),
        _FakeMof(2, "HKUST-1", "CoREMOF 2019", ["Cu", "O", "C"], _CIF),
    ]
    _install_fake_mofdb_client(monkeypatch, mofs)
    from catgo.utils.mofdb_search import search_mofs

    res = search_mofs(name="MOF", database="CoREMOF 2019", limit=50)
    assert res["count"] == 2
    assert res["hits"][0]["name"] == "MOF-5"
    assert "Zn" in res["hits"][0]["elements"]
    assert res["hits"][0]["mofid"]  # non-empty round-trip key


def test_get_structure_parses_cif(monkeypatch):
    mofs = [_FakeMof(1, "MOF-5", "CoREMOF 2019", ["Zn", "O", "C"], _CIF)]
    _install_fake_mofdb_client(monkeypatch, mofs)
    from catgo.utils.mofdb_search import get_mof_structure

    struct, name = get_mof_structure("mofid-1")
    assert isinstance(struct, Structure)
    assert struct.num_sites == 2
    assert name == "MOF-5"


def test_get_structure_unknown_mofid_raises(monkeypatch):
    _install_fake_mofdb_client(monkeypatch, [])
    from catgo.utils.mofdb_search import get_mof_structure

    with pytest.raises(LookupError):
        get_mof_structure("nope")


def test_search_without_client_raises_runtimeerror(monkeypatch):
    # Simulate mofdb_client not installed.
    monkeypatch.setitem(sys.modules, "mofdb_client", None)
    from catgo.utils.mofdb_search import search_mofs

    with pytest.raises(RuntimeError, match="not installed"):
        search_mofs(name="x", database=None, limit=10)
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd server && rtk proxy python -m pytest tests/test_mofdb.py -q`
Expected: FAIL — `No module named 'catgo.utils.mofdb_search'`.

- [ ] **Step 3: Implement the wrapper**

Create `server/catgo/utils/mofdb_search.py`:

```python
"""Wrap the optional mofdb_client (MOFX-DB) for search + structure retrieval.

Pure functions; no FastAPI/pydantic imports. mofdb_client is an OPTIONAL dependency
imported lazily — a missing package raises RuntimeError("...not installed...") which
the router maps to a clear error. fetch() returns a LAZY iterator; never list() it —
always pass `limit` and iterate with a cap.
"""

from __future__ import annotations

import logging

from pymatgen.core import Structure

logger = logging.getLogger(__name__)


def _fetch():
    """Return mofdb_client.fetch, or raise RuntimeError if the package is absent."""
    import importlib

    try:
        mod = importlib.import_module("mofdb_client")
    except Exception as exc:  # ImportError, or None placeholder in tests
        raise RuntimeError(
            "MOFX-DB support not installed (pip install catgo-server[mofsearch])"
        ) from exc
    if mod is None or not hasattr(mod, "fetch"):
        raise RuntimeError(
            "MOFX-DB support not installed (pip install catgo-server[mofsearch])"
        )
    return mod.fetch


def _round_trip_id(mof) -> str:
    """The identifier the structure endpoint can pass back to fetch(mofid=…)."""
    return str(getattr(mof, "mofid", None) or mof.id)


def search_mofs(name: str | None, database: str | None, limit: int = 50) -> dict:
    """Search MOFX-DB; return {hits: [...], count}. Iterates the lazy fetch with a cap."""
    fetch = _fetch()
    kwargs: dict = {"limit": limit}
    if name:
        kwargs["name"] = name
    if database:
        kwargs["database"] = database

    hits = []
    for mof in fetch(**kwargs):
        elements = [str(e) for e in getattr(mof, "elements", [])]
        hits.append(
            {
                "mofid": _round_trip_id(mof),
                "name": str(getattr(mof, "name", "")),
                "database": str(getattr(mof, "database", "")),
                "elements": elements,
                "n_elements": len(elements),
            }
        )
        if len(hits) >= limit:
            break
    return {"hits": hits, "count": len(hits)}


def get_mof_structure(mofid: str) -> tuple[Structure, str]:
    """Re-fetch a single MOF by its round-trip id and parse its CIF to a pymatgen Structure."""
    fetch = _fetch()
    mof = next(iter(fetch(mofid=mofid, limit=1)), None)
    if mof is None:
        raise LookupError(f"MOF '{mofid}' not found")
    cif = getattr(mof, "cif", None)
    if not cif:
        raise ValueError(f"MOF '{mofid}' has no CIF")
    structure = Structure.from_str(cif, fmt="cif")
    return structure, str(getattr(mof, "name", mofid))
```

- [ ] **Step 4: Run tests**

Run: `cd server && rtk proxy python -m pytest tests/test_mofdb.py -q`
Expected: 4 passed. If `test_get_structure_unknown_mofid_raises` fails because `fetch(mofid=…)` in the fake still yields (the fake's filter), confirm the fake's filter logic excludes non-matching ids (it compares `mof.mofid`/`str(mof.id)` to the requested mofid).

- [ ] **Step 5: Commit**

```bash
git add server/catgo/utils/mofdb_search.py server/tests/test_mofdb.py
git commit -m "feat(mofdb): mofdb_client search + CIF->pymatgen wrapper + mocked tests"
```

---

## Task 3: Router + registration + tests

**Files:** Create `server/catgo/routers/mofdb.py`; modify `server/catgo/routers/__init__.py`, `server/main.py`; append tests to `server/tests/test_mofdb.py`

- [ ] **Step 1: Write failing router tests (append)**

Append to `server/tests/test_mofdb.py`:

```python
def test_router_search_returns_hits(monkeypatch):
    mofs = [_FakeMof(1, "MOF-5", "CoREMOF 2019", ["Zn", "O", "C"], _CIF)]
    _install_fake_mofdb_client(monkeypatch, mofs)
    from catgo.models.mofdb import MofSearchRequest
    from catgo.routers.mofdb import search_mofs_route

    res = search_mofs_route(MofSearchRequest(name="MOF", database="CoREMOF 2019"))
    assert res.count == 1
    assert res.hits[0].name == "MOF-5"


def test_router_structure_returns_pymatgen(monkeypatch):
    mofs = [_FakeMof(1, "MOF-5", "CoREMOF 2019", ["Zn", "O", "C"], _CIF)]
    _install_fake_mofdb_client(monkeypatch, mofs)
    from catgo.routers.mofdb import get_mof_structure_route

    res = get_mof_structure_route(mofid="mofid-1")
    assert len(res.structure.sites) == 2
    assert res.mofid == "mofid-1"


def test_router_structure_unknown_404(monkeypatch):
    from fastapi import HTTPException
    _install_fake_mofdb_client(monkeypatch, [])
    from catgo.routers.mofdb import get_mof_structure_route

    with pytest.raises(HTTPException) as ei:
        get_mof_structure_route(mofid="nope")
    assert ei.value.status_code == 404


def test_router_search_not_installed_returns_503(monkeypatch):
    from fastapi import HTTPException
    monkeypatch.setitem(sys.modules, "mofdb_client", None)
    from catgo.models.mofdb import MofSearchRequest
    from catgo.routers.mofdb import search_mofs_route

    with pytest.raises(HTTPException) as ei:
        search_mofs_route(MofSearchRequest(name="x"))
    assert ei.value.status_code == 503
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd server && rtk proxy python -m pytest tests/test_mofdb.py -k router -q`
Expected: FAIL — `No module named 'catgo.routers.mofdb'`.

- [ ] **Step 3: Implement the router**

Create `server/catgo/routers/mofdb.py`:

```python
"""MOF-database (MOFX-DB) search API endpoints."""

import logging
import traceback

from fastapi import APIRouter, HTTPException

from catgo.models.mofdb import (
    MofHit,
    MofSearchRequest,
    MofSearchResult,
    MofStructureResult,
)
from catgo.models.structure import Lattice, PymatgenStructure, Site, Species
from catgo.utils.mofdb_search import get_mof_structure, search_mofs

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/mofdb", tags=["mofdb"])


def _native_to_model(structure) -> PymatgenStructure:
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
                properties={"mofdb": True},
            )
        )
    return PymatgenStructure(lattice=latt, sites=sites)


@router.post("/search", response_model=MofSearchResult)
def search_mofs_route(request: MofSearchRequest) -> MofSearchResult:
    try:
        res = search_mofs(name=request.name, database=request.database, limit=request.limit)
        return MofSearchResult(hits=[MofHit(**h) for h in res["hits"]], count=res["count"])
    except RuntimeError as e:  # mofdb_client not installed
        raise HTTPException(status_code=503, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("MOFX-DB search failed: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"MOFX-DB search failed: {e}")


@router.get("/structure", response_model=MofStructureResult)
def get_mof_structure_route(mofid: str) -> MofStructureResult:
    try:
        structure, name = get_mof_structure(mofid)
        return MofStructureResult(
            structure=_native_to_model(structure), name=name, mofid=mofid
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("MOFX-DB structure fetch failed: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"MOFX-DB structure fetch failed: {e}")


@router.get("/health")
def mofdb_health():
    return {"status": "healthy", "service": "mofdb"}
```

(Note: `mofid` is a query param on `GET /mofdb/structure?mofid=…` — NOT a path param — because MOFid strings can contain characters that are awkward in a path.)

- [ ] **Step 4: Register the router**

In `server/catgo/routers/__init__.py`, add to the `_ROUTERS` dict near `reticular_router`:
```python
    "mofdb_router": "mofdb",
```
In `server/main.py`, add `mofdb_router,` to the `from catgo.routers import (...)` block (near `reticular_router`), and add near the other `include_router(..., prefix="/api")` lines:
```python
app.include_router(mofdb_router, prefix="/api")
```

- [ ] **Step 5: Run tests + confirm app boots with the route**

Run: `cd server && rtk proxy python -m pytest tests/test_mofdb.py -q`
Expected: all pass (8 total: 4 wrapper + 4 router).
Run: `cd server && python -c "from main import app; print([r.path for r in app.routes if 'mofdb' in r.path])"`
Expected: includes `/api/mofdb/search`, `/api/mofdb/structure`, `/api/mofdb/health`.

- [ ] **Step 6: Commit**

```bash
git add server/catgo/routers/mofdb.py server/catgo/routers/__init__.py server/main.py server/tests/test_mofdb.py
git commit -m "feat(mofdb): FastAPI router (search/structure) + registration + tests"
```

---

## Task 4: Frontend API client

**Files:** Create `src/lib/api/mofdb.ts`

- [ ] **Step 1: Implement (mirror `src/lib/api/reticular.ts` conventions — `SERVER_URL`, backtick strings, no semicolons)**

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

export interface MofHit {
  mofid: string
  name: string
  database: string
  elements: string[]
  n_elements: number
}

export interface MofSearchResult {
  hits: MofHit[]
  count: number
}

export interface MofStructureResult {
  structure: PymatgenStructure
  name: string
  mofid: string
}

export const MOFDB_DATABASES = [
  `CoREMOF 2019`,
  `CoREMOF 2014`,
  `CSD`,
  `hMOF`,
  `IZA`,
  `PCOD-syn`,
  `Tobacco`,
]

export async function searchMofs(
  body: { name?: string; database?: string; limit?: number },
  server_url = SERVER_URL,
): Promise<MofSearchResult> {
  const response = await fetch(`${server_url}/api/mofdb/search`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ limit: 50, ...body }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(err.detail) || `Server error: ${response.status}`)
  }
  return response.json()
}

export async function getMofStructure(
  mofid: string,
  server_url = SERVER_URL,
): Promise<MofStructureResult> {
  const url = `${server_url}/api/mofdb/structure?mofid=${encodeURIComponent(mofid)}`
  const response = await fetch(url)
  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(err.detail) || `Server error: ${response.status}`)
  }
  return response.json()
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /home/james0001/project/catgo-LRG/.worktrees/reticular && pnpm exec svelte-check --threshold error 2>&1 | grep -i "mofdb.ts" || echo "no mofdb.ts errors"`
Expected: `no mofdb.ts errors`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api/mofdb.ts
git commit -m "feat(mofdb): frontend API client"
```

---

## Task 5: i18n keys

**Files:** Modify `src/lib/i18n/en/structure.ts`, `src/lib/i18n/zh/structure.ts`

- [ ] **Step 1: Add Search-tab keys to BOTH locales (near the existing `reticular_*` block)**

en (`src/lib/i18n/en/structure.ts`):
```ts
  reticular_mode_search: `Search`,
  reticular_hint_search: `Search the MOFX-DB database and load an existing MOF structure.`,
  reticular_search_name: `Name`,
  reticular_search_database: `Database`,
  reticular_search_button: `Search`,
  reticular_search_load: `Load`,
  reticular_search_no_results: `No matches — broaden or change the query.`,
  reticular_search_count: `results`,
```
zh (`src/lib/i18n/zh/structure.ts`), same keys:
```ts
  reticular_mode_search: `搜索`,
  reticular_hint_search: `搜索 MOFX-DB 数据库，加载已有 MOF 结构。`,
  reticular_search_name: `名称`,
  reticular_search_database: `数据库`,
  reticular_search_button: `搜索`,
  reticular_search_load: `加载`,
  reticular_search_no_results: `无匹配 —— 放宽或更换查询。`,
  reticular_search_count: `条结果`,
```

- [ ] **Step 2: Verify parity + typecheck**

Run: `grep -c "reticular_mode_search\|reticular_search" src/lib/i18n/en/structure.ts src/lib/i18n/zh/structure.ts` (en and zh counts must match) and `pnpm exec svelte-check --threshold error 2>&1 | grep -i structure.ts || echo ok`.
Expected: equal counts; `ok`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/i18n/en/structure.ts src/lib/i18n/zh/structure.ts
git commit -m "feat(mofdb): i18n keys for the Search tab (en/zh)"
```

---

## Task 6: ReticularPane "Search" tab

**Files:** Modify `src/lib/structure/ReticularPane.svelte`

- [ ] **Step 1: Extend the mode union + state (script section)**

Change `let mode = $state<\`preset\` | \`advanced\`>(\`preset\`)` to include `` `search` ``:
```ts
  let mode = $state<`preset` | `advanced` | `search`>(`preset`)
```
Add search state + imports. Add to the api import (top of script): import from `$lib/api/mofdb`:
```ts
  import { searchMofs, getMofStructure, MOFDB_DATABASES, type MofHit } from '$lib/api/mofdb'
```
Add state (near the other `$state` declarations):
```ts
  // -- Search mode (MOFX-DB) --
  let search_name = $state(``)
  let search_database = $state(``) // empty = all databases
  let search_status = $state<`idle` | `searching` | `done` | `error`>(`idle`)
  let search_hits = $state<MofHit[]>([])
  let search_count = $state(0)

  async function do_search() {
    search_status = `searching`
    error_message = null
    try {
      const res = await searchMofs(
        { name: search_name || undefined, database: search_database || undefined, limit: 50 },
        server_url,
      )
      search_hits = res.hits
      search_count = res.count
      search_status = `done`
    } catch (err) {
      search_status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }

  async function load_hit(hit: MofHit) {
    on_push_undo?.()
    error_message = null
    try {
      const res = await getMofStructure(hit.mofid, server_url)
      structure = res.structure
      on_structure_change?.(res.structure)
      result_message = `Loaded ${res.name}`
    } catch (err) {
      error_message = err instanceof Error ? err.message : String(err)
    }
  }
```

- [ ] **Step 2: Add the third mode-tab button**

In the `.mode-tabs` block, after the advanced button:
```svelte
    <button type="button" class:active={mode === `search`} onclick={() => (mode = `search`)}>
      {t(`structure.reticular_mode_search`)}
    </button>
```

- [ ] **Step 3: Add the Search UI block**

The current mode conditional is `{#if mode === \`preset\`} … {:else} …(advanced)… {/if}`. Change the advanced `{:else}` to `{:else if mode === \`advanced\`}` and append a new search branch before `{/if}`:
```svelte
{:else if mode === `search`}
  <p class="hint">{t(`structure.reticular_hint_search`)}</p>
  <label class="field">
    <span>{t(`structure.reticular_search_name`)}</span>
    <input type="text" bind:value={search_name} placeholder="MOF-5, HKUST, ZIF…" />
  </label>
  <label class="field">
    <span>{t(`structure.reticular_search_database`)}</span>
    <select bind:value={search_database}>
      <option value="">—</option>
      {#each MOFDB_DATABASES as db (db)}
        <option value={db}>{db}</option>
      {/each}
    </select>
  </label>
  <button
    type="button"
    class="primary"
    onclick={do_search}
    disabled={search_status === `searching`}
  >
    {search_status === `searching` ? `…` : t(`structure.reticular_search_button`)}
  </button>

  {#if search_status === `done`}
    <p class="hint">{search_count} {t(`structure.reticular_search_count`)}</p>
    {#if search_hits.length === 0}
      <p class="hint">{t(`structure.reticular_search_no_results`)}</p>
    {/if}
    <ul class="mof-results">
      {#each search_hits as hit (hit.mofid)}
        <li class="mof-hit">
          <div class="mof-hit-info">
            <strong>{hit.name}</strong>
            <small>{hit.database} · {hit.elements.join(`, `)}</small>
          </div>
          <button type="button" onclick={() => load_hit(hit)}>
            {t(`structure.reticular_search_load`)}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
{/if}
```

- [ ] **Step 4: Hide the build button in search mode**

The build button / `can_build` block is only for preset/advanced. Wrap the existing build `<button>` (and its container) so it only renders when `mode !== \`search\``:
```svelte
{#if mode !== `search`}
  <!-- existing build button block -->
{/if}
```
(Search mode uses its own per-result Load buttons.)

- [ ] **Step 5: Add minimal styles (in the `<style>` block)**

```css
  .mof-results { list-style: none; margin: 0.5em 0 0; padding: 0; max-height: 16em; overflow-y: auto; }
  .mof-hit { display: flex; align-items: center; justify-content: space-between; gap: 0.5em; padding: 0.25em 0; border-bottom: 1px solid var(--border-color, #8884); }
  .mof-hit-info { display: flex; flex-direction: column; min-width: 0; }
  .mof-hit-info small { opacity: 0.7; }
```

- [ ] **Step 6: Typecheck + lint**

Run: `cd /home/james0001/project/catgo-LRG/.worktrees/reticular && pnpm exec svelte-check --threshold error 2>&1 | grep -i ReticularPane || echo "no ReticularPane errors"`
Run: `pnpm exec eslint src/lib/structure/ReticularPane.svelte 2>&1 | tail -20`
Expected: no ReticularPane errors; eslint errors fixed (warnings ok).

- [ ] **Step 7: Commit**

```bash
git add src/lib/structure/ReticularPane.svelte
git commit -m "feat(mofdb): ReticularPane Search tab (MOFX-DB search + load)"
```

---

## Task 7: Verify + live smoke + manual dev test

- [ ] **Step 1: Full backend test sweep**

Run: `cd server && rtk proxy python -m pytest tests/test_mofdb.py tests/test_reticular.py -q`
Expected: all pass.

- [ ] **Step 2: Gated live smoke (real MOFX-DB — verifies the mofid round-trip)**

Add to `server/tests/test_mofdb.py`:
```python
@pytest.mark.live
def test_live_mofx_roundtrip():
    """Real MOFX-DB call — confirms search→get_structure round-trips by mofid."""
    from catgo.utils.mofdb_search import search_mofs, get_mof_structure

    res = search_mofs(name=None, database="CoREMOF 2019", limit=3)
    assert res["count"] >= 1
    first = res["hits"][0]
    struct, name = get_mof_structure(first["mofid"])
    assert struct.num_sites > 0
```
Run (only when network available): `cd server && rtk proxy python -m pytest tests/test_mofdb.py -m live -q`
Expected: passes against the live API; if the `mofid` round-trip returns nothing, switch `_round_trip_id` to the identifier that DOES round-trip (per Task 0 Step 3 findings) and re-run. Commit any fix.

- [ ] **Step 3: Boot backend on the worktree port + curl**

```bash
cd server && CATGO_PATHS_DB_PATH=/tmp/mof_wt.db SERVER_PORT=8047 python -m uvicorn main:app --port 8047 &
sleep 10
curl -s "http://localhost:8047/api/mofdb/health"
curl -s -X POST "http://localhost:8047/api/mofdb/search" -H 'Content-Type: application/json' -d '{"database":"CoREMOF 2019","limit":3}' | python -c "import sys,json;d=json.load(sys.stdin);print('count',d['count'],'first',d['hits'][0]['name'] if d['hits'] else None)"
```
Expected: health ok; search returns a count + names (requires `mofdb-client` installed + network). If `mofdb-client` absent → 503 with the "not installed" message (expected, install it).

- [ ] **Step 4: Frontend manual check**

With the worktree dev servers running (`PORT=3147 SERVER_PORT=8047 pnpm desktop:dev`), open the viewer → Build → Reticular → **Search** tab → pick a database → Search → click **Load** on a result → confirm the MOF appears in the viewer.

- [ ] **Step 5: Final lint**

Run: `cd /home/james0001/project/catgo-LRG/.worktrees/reticular && pnpm exec svelte-check --threshold error 2>&1 | tail -3`
Expected: no mofdb/ReticularPane errors.

---

## Self-Review Notes

- **Spec coverage:** MOFX-DB search (Task 2/3 ✓), load-to-viewer via two-line push (Task 6 ✓), name+database+limit (Task 2/6 ✓), optional `[mofsearch]` dep + lazy import + "not installed" error (Task 0/2/3 ✓), CIF→pymatgen on backend (Task 2 ✓), errors 503/400/404/500 (Task 3 ✓), mocked tests + gated live smoke (Task 2/3/7 ✓), MP/QMOF excluded (not in plan ✓), i18n (Task 5 ✓).
- **Open detail (carried):** the exact `mofid` round-trip identifier — `_round_trip_id` uses `mof.mofid or mof.id`; verified by Task 0 Step 3 + the Task 7 live smoke; swap if needed.
- **Naming consistency:** wrapper `search_mofs`/`get_mof_structure`; router `search_mofs_route`/`get_mof_structure_route`; models `MofSearchRequest`/`MofHit`/`MofSearchResult`/`MofStructureResult`; frontend `searchMofs`/`getMofStructure`/`MofHit`/`MofSearchResult`/`MofStructureResult` — consistent across layers.
```
