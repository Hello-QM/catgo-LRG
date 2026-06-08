# CatGo Workflow Engine — As-Built Architecture

> **Status:** as-built description of the code as of 2026-06-04. Replaces the
> earlier `2026-03-28-workflow-engine-refactor-design.md`, which described the
> *planned* refactor. The execution-side migration is essentially complete; this
> document records what the code actually does, including the compatibility seams
> that remain. Where the old spec said "we will…", this says "the code does…".

## TL;DR

There is **one execution engine: V2** — a backend-first, crash-safe, periodic
state-machine scanner. There is **no live V1 executor anymore.** What is still
called "V1" in the code is *not* a second engine; it is two leftover skins:

1. an **authoring/representation format** — the `graph_json` blob plus the
   `workflow_steps` table in `catgo_results.db`, used by the REST CRUD API and the
   Svelte editor; and
2. a **UI compatibility layer** that translates V2 execution truth back into the
   V1 wire shape the existing frontend expects.

The cost of this arrangement is two SQLite databases and several
translation/duplication seams. They are migration debt, not design intent.

---

## The two databases

| DB | Module | Role | Tables |
|----|--------|------|--------|
| `catgo_results.db` (default `server/catgo/data/`, switchable per project) | `catgo/utils/workflow_db.py`, `catgo/utils/ase_db.py` | **Authoring + results store** (the "V1" representation) | `workflows` (holds `graph_json`), `workflow_steps`, `projects`, plus ASE `systems`/structure/energy results |
| `~/.catgo/catgo.db` (`config.paths.db_path`) | `catgo/workflow/db.py` (`WorkflowDB`) | **V2 execution store** (the engine's source of truth) | `workflows`, `tasks`, `task_links`, `task_results`, `provenance`, `hpc_sessions` |

Both have a `workflows` table and both end up holding a copy of `graph_json`
(`convert_graph_json` writes the raw graph into the V2 row too). That duplication
is one of the seams below.

### Active-DB resolution (single source of truth)

`catgo_results.db` is **switchable at runtime** — `POST /api/workflow/db/{open,new,save-as}`
call `ase_db.set_active_db_path()`, which also repoints `workflow_db` at the same
file so ASE tables and workflow tables always live together.

The active path is now **resolved to an absolute path and persisted** to
`server/catgo/data/.active_db_path`, and **restored at startup** by
`restore_active_db_path()` (called from `server/main.py` lifespan). This closes a
bug where a freshly-started backend defaulted to the packaged
`server/catgo/data/catgo_results.db` while the frontend later re-opened the user's
project DB — orphaning any workflow created via the API before the switch.
Regression test: `server/tests/test_active_db_persistence.py`.

> Historical note: the Python default (`server/catgo/data/`, `__file__`-relative)
> and the path the desktop/Rust side opens (`server/data/`, CWD-relative) differ.
> Absolute resolution + persistence makes create/list/get agree regardless.

---

## Entry points → graph_json

All three authoring surfaces produce the **same `graph_json`** (`{nodes, edges}`,
each node `{id, type, x, y, params}`):

- **REST CRUD / GUI editor** — `POST /api/workflow/` (`create_workflow`), `PUT
  /api/workflow/{id}`. The Svelte `WorkflowEditor.svelte` renders nodes by
  top-level `x,y` and reads edges as `from/to/fromH/toH` (mapped from
  `source/target` on load).
- **AI agent (MCP)** — `catgo_workflow` tool (`mcp_tools/workflow_tools.py`),
  action-discriminated (`create/add_node/connect/set_params/batch/validate/run/…`),
  operating on the same backend graph.

`create_workflow` also runs `_sync_steps_from_graph()` to populate the V1
`workflow_steps` table from the graph (UI scaffold; see seams).

---

## Run path (the only executor: V2)

`POST /api/workflow/{id}/run` (`api_run_workflow`, `routers/workflow.py`) is
**V2-only**. There is no V1 execution branch — if the V2 engine DB is not
initialized it raises `"V2 workflow engine not initialized"`.

1. Load the workflow's `graph_json` from `catgo_results.db`.
2. `convert_graph_json(engine_db, name, graph, config=…)`
   (`workflow/graph_converter.py`): create a V2 workflow in `~/.catgo/catgo.db`,
   one `task` per node (**node id preserved as task id**), one `task_link` per
   edge, store params + `software`, and stash the raw `graph_json` on the V2
   workflow row. If the graph changed since a prior run, old tasks/links are
   deleted and recreated; otherwise the engine is reset and config refreshed.
3. The V2 engine scanner picks it up.

There is a parallel **native V2 API** (`/api/engine/workflows/{id}/{submit,pause,
resume,reset}`, `routers/workflow_engine.py`) that operates directly on V2 without
going through the V1 graph. Two API surfaces for the same engine is another seam.

### V2 state-machine engine

`catgo/workflow/engine/` — a **stateless periodic scanner** (`scanner.py`,
default `poll_interval=30s`, started in `main.py` lifespan via
`engine/lifecycle.py:start_engine`). Each `scan_cycle()` processes every active
workflow:

1. `advance_waiting_tasks` — `WAITING → READY` when all parents `COMPLETED`.
2. Execute `READY` **local** tasks in-process immediately.
3. `submit_ready_tasks` — `READY` **HPC** tasks: generate inputs → upload →
   `sbatch`/`qsub` (`engine/submitter.py`, with `batch_submitter.py` for fan-out).
4. `poll_active_tasks` — query `squeue`/`sacct`, advance `SUBMITTED/QUEUED/RUNNING
   → COMPLETED_REMOTE` (`engine/poller.py`).
5. `collect_completed_tasks` — download + parse outputs into `task_results`
   (`engine/collector.py`).

**Crash-safety:** state lives entirely in `~/.catgo/catgo.db`; HPC files are
ground truth, the DB is a cache. A restart resumes by re-scanning — no in-memory
run state to lose.

**TaskState** (`workflow/states.py`): `WAITING, READY, GENERATING, UPLOADING,
SUBMITTED, QUEUED, RUNNING, COMPLETED_REMOTE, COLLECTING, COMPLETED, FAILED,
PENDING_REVIEW, PAUSED`. Workflow-level state is a separate coarse enum
(`running/paused/completed/failed`).

---

## The V1 compatibility layer (what "V1" actually means now)

| Seam | Code | What it does |
|------|------|--------------|
| Graph → tasks | `graph_converter.convert_graph_json` | One-way translate the V1 authoring `graph_json` into V2 tasks/links at run time. |
| Status mapping | `engine/scanner.py:_V2_TO_V1_STATUS` | Map fine V2 `TaskState` → coarse V1 UI strings (`pending/submitting/running/completed/failed/…`). |
| Step status API | `routers/workflow.py:list_steps_v1`, `get_step_status_v1` | The `/steps` endpoints read **from the V2 DB** and reshape into the V1 step format the FE polls. |
| Live monitor | `engine/v1_monitor.py` | Translate V2 broadcast messages → the V1 WebSocket wire format consumed by `workflow-execution.svelte.ts`. |
| Input generators | `server/workflow/engines/vasp.py:generate_vasp_inputs` (imported by `engine/engine_builtins.py`) | The V1-era **input generators are reused** by the V2 engine. Only the V1 *executor* was retired, not its input code. |
| Steps table | `workflow_db._sync_steps_from_graph` + scattered `UPDATE workflow_steps` | `workflow_steps` is populated from the graph and touched by some reset paths; live status comes from V2. Largely derived/vestigial. |

Net: the frontend still "speaks V1," and the engine "speaks V2," and these
adapters keep them talking.

---

## Known seams / migration-remaining

Honest list of debt to retire on the way to V2-only:

1. **Two SQLite DBs** with overlapping `workflows` tables (`catgo_results.db` vs
   `~/.catgo/catgo.db`) and a duplicated `graph_json`. Source of "created but not
   listed" classes of bug.
2. **Two API surfaces** — `/api/workflow/*` (V1 CRUD that internally drives V2)
   and `/api/engine/*` (native V2).
3. **`workflow_steps` table** is partly vestigial (status truth is V2). Keeping it
   in sync is pure overhead.
4. **Two status vocabularies** (V2 `TaskState` ↔ V1 UI strings) requiring a
   mapping table and a broadcast translator.
5. **Path divergence** between the Python default DB dir and the desktop/Rust dir
   (mitigated by absolute-resolution + persistence, not yet unified).

## Convergence target (V2-only)

- Frontend reads/writes V2 entities (`tasks/task_links/task_results`) and the V2
  WebSocket format directly; delete `v1_monitor`, `list_steps_v1`,
  `_V2_TO_V1_STATUS`.
- Single workflow DB; keep `graph_json` only as an export/interchange artifact, or
  reconstruct it from V2 tasks on demand.
- One API surface (`/api/engine/*`); make `/api/workflow/*` thin shims or remove.
- Drop `workflow_steps`.

Each removal is independently shippable once the frontend stops depending on the
V1 shape.

---

## Key files

- Execution engine: `server/catgo/workflow/engine/` — `scanner.py`,
  `submitter.py`, `batch_submitter.py`, `poller.py`, `collector.py`,
  `advancer.py`, `lifecycle.py`, `v1_monitor.py`
- V2 DB + schema: `server/catgo/workflow/db.py`; states: `workflow/states.py`;
  config (`~/.catgo/catgo.db`): `workflow/config.py`
- Graph → V2: `server/catgo/workflow/graph_converter.py`
- V1 authoring/results store: `server/catgo/utils/workflow_db.py`,
  `server/catgo/utils/ase_db.py` (active-path persistence + restore)
- REST: `server/catgo/routers/workflow.py` (V1 CRUD + `/run` + `/db/*` + `/steps`),
  `server/catgo/routers/workflow_engine.py` (native V2)
- Startup wiring: `server/main.py` (lifespan: engine start + `restore_active_db_path`)
- Reused input generators: `server/workflow/engines/vasp.py`
- Regression test (active-DB fix): `server/tests/test_active_db_persistence.py`
