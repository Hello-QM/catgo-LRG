# MOF Database Search — Design

Date: 2026-05-26
Branch: `feat/reticular-mof-builder` (worktree `.worktrees/reticular`)
Status: design approved, pre-implementation

## Goal

Let users SEARCH existing (real / hypothetical) MOF structures from open MOF
databases and load them directly into the CatGO viewer — complementing the
de-novo PORMAKE builder (presets + advanced) already shipped in ReticularPane.
Build = make new frameworks; Search = retrieve known ones.

Two sources, user-selectable:
- **MOFX-DB** (Northwestern, mof.tech.northwestern.edu) — dedicated MOF database,
  ~160k structures (CoRE MOF + hMOF + experimental), searchable by name / metal /
  elements / pore size, CIF download, via the `mofdb_client` Python package.
- **Materials Project MOF Explorer** — QMOF-derived MOF subset, reusing CatGO's
  existing Materials Project API integration (`mp_router` / MPRester + API key).

## Scope

**In:** source-selectable MOF search + load-into-viewer, wired as a third "Search"
mode in `ReticularPane` (alongside Preset / Advanced). Search by name / metal /
elements with a result limit. Load fetches CIF → pymatgen → viewer via the same
push path the builder uses.

**Out (YAGNI):** favorites, batch download, pore-size range sliders, infinite
scroll / pagination, advanced property-filter panels. MVP = name/metal/elements +
limit; narrow the query rather than paginate.

## Architecture

Mirrors the existing structure-fetch pattern (`routers/materials_project.py`
`/mp`, `routers/optimade.py` `/optimade`: `POST /search` + `GET /structure/{id}`;
frontend `api/*.ts` + search modals; CIF/structure loaded into viewer).

```
server/catgo/routers/mofdb.py    # POST /mofdb/search  + GET /mofdb/structure/{source}/{id}
                                 #   source ∈ {"mofx", "mp"}; dispatches per source
server/catgo/models/mofdb.py     # MofSearchRequest / MofSearchResult / MofHit pydantic models
src/lib/api/mofdb.ts             # typed fetch wrappers (searchMofs, getMofStructure)
src/lib/structure/ReticularPane.svelte  # add mode='search': source dropdown + query fields
                                        #   + results list + load-on-click
```

Registration: `routers/__init__.py` lazy entry + `main.py` include (Tier A, like
the other light fetch routers). i18n keys for the Search tab in en/zh.

### Source dispatch (backend)

- **mofx**: use `mofdb_client` (MOFX-DB REST). Optional dependency in a
  `[mofsearch]` extra. If the package is not importable, the `mofx` source returns
  a structured "MOFX-DB support not installed" error; the `mp` source still works.
- **mp**: reuse the existing Materials Project integration (MPRester + the existing
  `X-API-KEY` header / key mechanism). Apply a MOF filter.

**Risk (resolve during implementation):** whether MP exposes a clean MOF-specific
filter through the API CatGO already uses. If MP has no clean MOF endpoint, MOFX-DB
is the reliable primary source; the `mp` source degrades to a normal MP search
scoped by MOF-relevant keywords/elements, documented as such. MOFX-DB must work
regardless.

## Data flow

### Search
```
ReticularPane "Search" tab → pick source (MOFX-DB | MP) + query (name / metal / elements)
  → POST /mofdb/search {source, name?, metal?, elements?, limit=50}
  → backend dispatch:  mofx → mofdb_client.fetch(...)   |   mp → MPRester filtered query
  → MofSearchResult { total: int, hits: [MofHit{source, id, name, formula, metals, n_atoms, extra?}] }
  → frontend renders a scrollable result list (name + formula + metals); shows `total`
```

### Load into viewer (reuse the builder's push path)
```
user clicks a hit → GET /mofdb/structure/{source}/{id}
  → backend fetches the CIF for that id, parses with pymatgen, converts via the
    shared _native_to_model contract → returns { structure: PymatgenStructure, ... }
  → frontend: structure = result.structure ; on_structure_change?.(result.structure)
    (identical to how preset/advanced builds land in the viewer)
```
CIF → pymatgen happens on the BACKEND; the frontend never parses CIF. The viewer
load/push mechanism is shared with the builder (no new push path).

### Limit / paging
Default `limit = 50`. The result list shows the total match count at the top so the
user knows to narrow the query. No infinite scroll in MVP.

## Error handling

Reuse the existing two-tier router error style (`ValueError → 400`,
`Exception → 500`), surfaced in the Search tab's error area (same `.error` div the
builder uses):
- Network / API failure → structured error with a clear message.
- **MP needs an API key**: reuse CatGO's existing MP key mechanism (`X-API-KEY`
  header + existing validate-key). No key → prompt the user to configure it; this
  does NOT block the MOFX-DB source.
- MOFX-DB public API needs no key; timeout / rate-limit → friendly message.
- Empty results → "no matches, broaden/narrow the query".
- CIF parse failure → structured error.
- `mofdb_client` not installed → `mofx` source returns "MOFX-DB support not
  installed (pip install …[mofsearch])"; `mp` unaffected.

## Dependencies

- `mofdb_client` — optional `[mofsearch]` extra in `server/pyproject.toml`. Backend
  imports it lazily inside the `mofx` dispatch; ImportError → structured error.
- MP — reuse existing `mp-api` / MPRester; no new dependency.

## Testing

- **Backend pytest** (`server/tests/test_mofdb.py`): mock the HTTP / client layer
  (do NOT hit live APIs in unit tests). Assert: source dispatch routing, result
  mapping to `MofHit`, the `GET /structure` CIF→`PymatgenStructure` conversion,
  error paths (network error → 500, bad source → 400, MP-no-key → clear message,
  `mofdb_client` missing → structured error).
- **One gated live smoke** (`@pytest.mark.live`, skipped by default) that really
  queries MOFX-DB to verify the client contract hasn't drifted.
- **Frontend**: `pnpm exec svelte-check --threshold error` clean for the touched
  files; eslint clean.

## Open items to resolve during implementation

- Confirm `mofdb_client`'s actual `fetch(...)` filter parameters and the field names
  on returned MOFs (name, database, CIF accessor, metals/formula) — map them to
  `MofHit`.
- Confirm whether MP exposes a MOF-specific filter via the existing integration; if
  not, implement the documented degraded `mp` behavior (keyword/element-scoped MP
  search) and label it honestly in the UI.
- Confirm the exact CatGO viewer push path used by the existing fetch modals
  (OptimadeSearchModal) to keep the load behavior identical.
