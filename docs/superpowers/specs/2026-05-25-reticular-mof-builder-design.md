# Reticular (MOF/COF) Builder — P1 Core Design

Date: 2026-05-25
Branch: `feat/reticular-mof-builder`
Status: design approved, pre-implementation

## Goal

Add a reticular-chemistry builder to CatGO that constructs MOF/COF crystal
structures from a topology (RCSR net) plus building blocks (BBs), by wrapping
[PORMAKE](https://github.com/Sangwon91/PORMAKE) (MIT). Reticular chemistry =
"net + building blocks" separation: a topology defines vertex/edge connectivity,
building blocks (metal nodes, organic linkers) fill the vertices and edges.

This spec covers **P1 only**: the core vertical slice. P2 (custom BB upload →
functionalization/defects) and P3 (batch enumeration, topology preview) are
deferred to their own specs after P1 lands.

## Scope

**In P1:**
- Vendored, jax-free PORMAKE fork under `server/`
- Backend router + model + algorithm wrapper → pymatgen `Structure` JSON
- 4 curated presets (MOF-5, HKUST-1, ZIF-8, COF-5)
- Advanced mode: free topology + per-node/edge BB assignment over the full
  2404-net / 869-BB databases
- MCP tool entry (JSON, auto-dispatch + auto-push)
- CLI handler (`catgo build reticular ...`)
- Frontend `ReticularPane.svelte` + build-tools tab + i18n (en/zh)
- Auto-push result to the active viewer panel (matches other builders)

**Out of P1 (later phases):**
- Custom BB upload (P2)
- Functionalization / missing-linker defects (P2)
- Batch / combinatorial enumeration (P3)
- Topology graph visualization preview (P3)

## Architecture

Follows CatGO's existing builder triad (mirrors `nanotube` / `moire` /
`heterostructure`):

```
server/catgo/vendor/pormake/          # jax→scipy fork of PORMAKE + bundled RCSR DB
                                       #   (2404 topologies + 869 building blocks)
server/catgo/models/reticular.py      # pydantic request/response models + preset table
server/catgo/utils/reticular_algorithm.py  # thin wrapper: call vendor Builder → pymatgen Structure
server/catgo/routers/reticular.py     # FastAPI routes: build, list topologies, list BBs
```

Registration:
- `server/catgo/routers/__init__.py` + `main.py` deferred startup (existing pattern)
- `tool_schema/building.json` — MCP entry (no handler code; auto-dispatch)
- `cli/ops_build.py` handler + `cli/ops.py` `reg.add(...)`
- `src/lib/api/reticular.ts`, `ReticularPane.svelte`, `build-tools.svelte.ts` tab, i18n

### Vendored fork — jax elimination

PORMAKE uses jax in exactly one file (`scaler.py`, gradient optimization of cell
parameters). The fork's only functional change: replace jax gradient opt with
`scipy.optimize` (scipy already a CatGO dep, `scipy>=1.10.0`).

- `scaler.py` — jax → `scipy.optimize` (e.g. `minimize`, L-BFGS-B). Must match
  upstream convergence on known nets (validated against MOF-5 pcu lattice ~25.9 Å).
- `locator.py` — Kabsch (`scipy.spatial.transform.Rotation.align_vectors`) +
  Hungarian (`scipy.optimize.linear_sum_assignment`) + Euler grid search.
  Already scipy-based; kept as-is.
- `utils.py` — pymatgen format conversion only; kept as-is.
- Bundled RCSR/BB data files copied verbatim into the vendor dir.

Net result: **zero jax dependency** → no PyInstaller freeze risk for the desktop bundle.

### Dependencies

- No new PyPI pin for PORMAKE itself (vendored in-tree → sidesteps PORMAKE's
  `pymatgen<2024.0.0` upper-cap conflict with CatGO's `pymatgen>=2024.1.0`).
- `scipy`, `ase`, `pymatgen` already present.
- **Add `networkx`** to `server/pyproject.toml` (PORMAKE uses it for net graphs)
  if not already transitively present — verify and pin.

### Output contract

Same as other builders: pymatgen `Structure.as_dict()` JSON, **auto-pushed to the
active panel** on successful build.

## Data flow

### Preset mode (default)

```
Frontend picks "MOF-5"
  → POST /reticular/build {mode: "preset", preset: "mof-5"}
  → models/reticular.py preset table → {topology: "pcu", node_bbs: {...}, edge_bbs: {...}}
  → reticular_algorithm.build() → vendor pormake Builder → pymatgen Structure JSON
  → auto-push to viewer
```

Preset table (hardcoded in `models/reticular.py`; BB names mapped to the actual
PORMAKE bundled-DB ids, verified at build time):

| preset   | topology | node BB         | edge BB              |
|----------|----------|-----------------|----------------------|
| MOF-5    | pcu      | Zn4O            | BDC                  |
| HKUST-1  | tbo      | Cu paddlewheel  | BTC                  |
| ZIF-8    | sod      | Zn              | 2-methylimidazolate  |
| COF-5    | hcb      | tritopic boronate node | linker         |

(Exact BB ids resolved against the bundled DB while building the table; if a
named BB is absent from the DB, substitute the nearest bundled equivalent and
note it.)

### Advanced mode

```
GET /reticular/topologies?q=pcu       → search 2404 RCSR nets (name + vertex coordination)
GET /reticular/building-blocks?q=     → search 869 BBs (name + X-point count)
GET /reticular/topology/{name}        → vertex types / edge types + required coordination per type
POST /reticular/build {mode: "advanced", topology, node_bbs: {vertex_type: bb_id}, edge_bbs: {edge_type: bb_id}}
```

PORMAKE assigns BBs per **vertex type** and **edge type** of the chosen net. The
advanced UI first fetches topology detail (how many vertex types, coordination
number of each), then lets the user assign a compatible BB to each type. BB
X-point count must match vertex coordination → frontend filters incompatible BBs.

## Error handling

Structured errors (reuse CatGO's existing builder error-response format), surfaced
as clear frontend messages:
- BB X-point count ≠ vertex coordination → "building block incompatible with vertex type N"
- Locator alignment failure → "could not align building block to net"
- Scaler non-convergence → "cell optimization did not converge"
- Unknown topology / BB id → 404-style structured error

## Frontend

- `src/lib/api/reticular.ts` — typed fetch wrappers: `build`, `listTopologies`,
  `listBuildingBlocks`, `getTopology`.
- `ReticularPane.svelte` — modeled on `HeterostructurePane`:
  - Top: preset dropdown (4 items) → one-click build.
  - "Advanced" disclosure: topology search → per-vertex-type / per-edge-type BB
    assignment (searchable lists, filtered by X-point/coordination match) → build.
- `build-tools.svelte.ts` — add Reticular tab.
- i18n — en + zh strings.

## MCP & CLI

- **MCP**: JSON entry `reticular_build` in `tool_schema/building.json` with
  params `mode / preset / topology / node_bbs / edge_bbs`. Auto-dispatch +
  auto-push, no handler code.
- **CLI**: `cli/ops_build.py` handler, registered in `cli/ops.py`. Dual-form
  (vaspkit-style + import-mode), matching existing CLI builders:
  ```
  catgo build reticular --preset mof-5
  catgo build reticular --topology pcu --node Zn4O --edge BDC
  ```

## Testing

- **Backend pytest** (`server/tests/test_reticular*.py`):
  - Each of the 4 presets builds once → assert non-empty Structure, plausible
    atom count / composition, valid (non-degenerate, positive-volume) cell.
  - One advanced-mode build (explicit topology + BB assignment).
  - Incompatible BB → asserts structured error path.
- **Vendor swap validation**: scipy scaler converges; MOF-5 product cell matches
  known pcu lattice (~25.9 Å) within tolerance.
- **Round-trip cross-check (bonus)**: feed a built product into the existing Rust
  `extensions/rust/src/mof/` `detect_sbus` → detected SBU type should match the
  preset, as an independent validation that the build is chemically sane.

## YAGNI (explicitly excluded from P1)

Custom BB upload, batch/combinatorial enumeration, functionalization/defects,
topology visualization preview — all deferred. Advanced mode (full 2404-net
coverage) is the catch-all for anything the 4 presets don't cover, so P1 is not
blocked on later phases.

## Open items to resolve during implementation

- Confirm exact bundled-DB BB ids for each preset (esp. Cu paddlewheel, COF-5
  boronate node/linker).
- Confirm whether `networkx` is already a transitive dep or needs an explicit pin.
- Confirm the vendored fork's license notice placement (PORMAKE MIT — retain
  LICENSE in vendor dir; CatGO is AGPL-3.0, MIT is compatible).
