# MOF Database Search — Design

Date: 2026-05-26
Branch: `feat/reticular-mof-builder` (worktree `.worktrees/reticular`)
Status: design approved, pre-implementation

## Goal

Let users SEARCH existing (real / hypothetical) MOF structures from open MOF
databases and load them directly into the CatGO viewer — complementing the
de-novo PORMAKE builder (presets + advanced) already shipped in ReticularPane.
Build = make new frameworks; Search = retrieve known ones.

Source (this iteration — single source after investigation):
- **MOFX-DB** (Northwestern, mof.tech.northwestern.edu) — dedicated MOF database,
  ~160k+ structures (CoRE MOF 2014/2019, CSD, hMOF, IZA, PCOD-syn, Tobacco), via the
  MIT-licensed `mofdb_client` Python package. `fetch(...)` (lazy iterator) filters by
  `name` (prefix), `database`, pore/surface-area ranges, `mofid`/`mofkey`; each MOF
  exposes `.cif` (CIF string), `.name`, `.id`, `.database`, `.elements`. No API key.

**Materials Project / QMOF dropped from this iteration** (was a second source in the
original sketch): investigation showed CatGO's existing MP integration hits
`api.materialsproject.org/materials/summary/`, which has **no MOF filter and returns
no geometry** (MP structure geometry is actually fetched via the OPTIMADE provider
path). MP's MOF data (QMOF, ~20k) lives on a **separate MPContribs API**
(`contribs.materialsproject.org`) that the current httpx pattern cannot reach. A real
MP/QMOF source = a separate MPContribs integration → **backlog**, not this plan.

## Scope

**In:** MOFX-DB search + load-into-viewer, wired as a third "Search" mode in
`ReticularPane` (alongside Preset / Advanced). Search by `name` + `database` (the
filters `mofdb_client.fetch` natively supports) with a result `limit`. Load fetches
the chosen MOF's CIF → pymatgen (backend) → viewer via the same two-line push the
builder uses.

**Out (YAGNI):** Materials Project / QMOF (backlog, separate MPContribs effort),
element filter (mofdb_client `fetch()` has no element param — defer; would need raw
API or post-filter), favorites, batch download, pore-size range sliders, infinite
scroll / pagination. MVP = name + database + limit; narrow the query rather than page.

## Architecture

Mirrors the existing structure-fetch pattern (`routers/materials_project.py`
`/mp`, `routers/optimade.py` `/optimade`: `POST /search` + `GET /structure/{id}`;
frontend `api/*.ts` + search modals; CIF/structure loaded into viewer).

```
server/catgo/routers/mofdb.py    # POST /mofdb/search  + GET /mofdb/structure/{mofid}
server/catgo/models/mofdb.py     # MofSearchRequest / MofSearchResult / MofHit pydantic models
src/lib/api/mofdb.ts             # typed fetch wrappers (searchMofs, getMofStructure)
src/lib/structure/ReticularPane.svelte  # add mode='search': query fields + results list + load-on-click
```

Registration: `routers/__init__.py` lazy entry + `main.py` include (Tier A, like
the other light fetch routers). i18n keys for the Search tab in en/zh.

### Backend ↔ mofdb_client

`mofdb_client` is an OPTIONAL dependency (`[mofsearch]` extra). The router imports it
LAZILY inside each handler; if not importable, return a structured 503-style error
("MOFX-DB support not installed; pip install catgo-server[mofsearch]"). `fetch(...)`
returns a LAZY iterator — never `list(fetch())` (the DB is huge); always pass `limit`
and iterate with a cap. `fetch()` natively supports `name` (prefix) + `database` +
`limit`; element filtering is NOT supported by `fetch()` → out of MVP scope.

## Data flow

### Search
```
ReticularPane "Search" tab → query (name + database dropdown) + limit
  → POST /mofdb/search {name?, database?, limit=50}
  → backend: for mof in mofdb_client.fetch(name=…, database=…, limit=…): collect metadata
  → MofSearchResult { hits: [MofHit{ mofid, name, database, elements, n_elements }] }
       (NO cif in the list — keep it light; cif fetched on selection)
  → frontend renders a scrollable result list (name + database + element set)
```

### Load into viewer (reuse the builder's two-line push)
```
user clicks a hit → GET /mofdb/structure/{mofid}
  → backend: next(mofdb_client.fetch(mofid=<mofid>, limit=1)) → mof.cif (CIF string)
    → pymatgen Structure.from_str(cif, fmt="cif") → _native_to_model → PymatgenStructure
    → returns { structure: PymatgenStructure, name, mofid }
  → frontend: structure = result.structure ; on_structure_change?.(result.structure)
    (identical to how preset/advanced builds land in the viewer)
```
CIF → pymatgen happens on the BACKEND; the frontend never parses CIF. The viewer
push is the same two-line pattern ReticularPane's `do_build` uses (no new push path).

### Limit / paging
Default `limit = 50`, capped server-side. No infinite scroll in MVP — the result
list shows how many were returned; the user narrows `name`/`database` to refine.

## Error handling

Reuse the existing two-tier router error style (`ValueError → 400`,
`Exception → 500`), surfaced in the Search tab's error area (same `.error` div the
builder uses):
- Network / API failure (mof.tech.northwestern.edu unreachable / timeout) →
  structured 502/500 error with a clear message.
- MOFX-DB public API needs no key.
- Empty results → "no matches, broaden/narrow the query".
- CIF parse failure → structured error.
- `mofdb_client` not installed → structured "MOFX-DB support not installed
  (pip install catgo-server[mofsearch])" error; the rest of the app is unaffected.
- Unknown `mofid` on the structure endpoint → 404.

## Dependencies

- `mofdb_client` (MIT) — optional `[mofsearch]` extra in `server/pyproject.toml`.
  Backend imports it lazily inside each mofdb handler; ImportError → structured error.
- No new frontend dependency. No API key.

## Testing

- **Backend pytest** (`server/tests/test_mofdb.py`): MOCK `mofdb_client.fetch` (do
  NOT hit the live API in unit tests) — patch it to yield fake MOF objects with
  `.cif/.name/.id/.database/.elements`. Assert: search maps fake MOFs → `MofHit`
  list; `GET /structure/{mofid}` parses `.cif` → `PymatgenStructure`; error paths
  (fetch raises → 500; unknown mofid → 404; `mofdb_client` import patched absent →
  structured "not installed" error).
- **One gated live smoke** (`@pytest.mark.live`, skipped by default) that really
  queries MOFX-DB (small `limit`) to verify the client contract hasn't drifted.
- **Frontend**: `pnpm exec svelte-check --threshold error` clean for touched files;
  eslint clean.

## Open items to resolve during implementation

- (Resolved by investigation) `mofdb_client.fetch(name, database, mofid, mofkey,
  vf/lcd/pld/sa ranges, limit, …)` returns a lazy iterator of MOF objects;
  `mof.cif` (str), `mof.name`, `mof.id`, `mof.database`, `mof.elements`. MIT, no key.
  `fetch()` has NO element filter. Valid `database` values: CoREMOF 2014, CoREMOF
  2019, CSD, hMOF, IZA, PCOD-syn, Tobacco.
- (Resolved by investigation) ReticularPane push = `structure = <pymatgen>` +
  `on_structure_change?.(<pymatgen>)` (its `do_build` pattern); `on_structure_change`
  is wired in Structure.svelte to `build.handle_structure_replace`. Reuse verbatim.
- Confirm the exact `mofid` value to round-trip: the search `MofHit.mofid` must be a
  value `fetch(mofid=…)` accepts for single retrieval (use `mof.id`/mofid from the
  search result; verify the round-trip in the gated live smoke).
