# Workflow V1→V2 Convergence — Analysis & Phased Plan (issue #224)

> **Status:** analysis only (2026-06-05). No code changed. Companion to the
> as-built spec `2026-06-04-workflow-engine-as-built.md`. This verifies the
> as-built seam list against the actual code + live DBs, corrects three
> understatements, and proposes a risk-rated, dependency-ordered convergence plan.
> Sources: two read-only code+DB audits (backend V1 surface; frontend V1/V2 usage).

## TL;DR

Converging to V2-only is **feasible but it is a 5-phase, multi-week migration, not
one PR.** There is already one executor (the V2 state-machine engine). "V1" is
three leftover skins: (1) the `catgo_results.db` authoring/results store
(`workflow_steps` + duplicated `graph_json`), (2) the `/api/workflow/*` REST
surface, (3) compat seams (`v1_compat`, `v1_monitor`, `_V2_TO_V1_STATUS`,
`_sync_steps_from_graph`). The **frontend's main path (the GUI editor) still speaks
V1**, which gates the biggest removals.

Safe to start now (additive / dead-code): **Phase 0, 1, 2.**
Blocked on the frontend migration: **Phase 3 → 4.** Do last (live-data migration):
**Phase 5.**

---

## Corrections to the as-built spec (verified against code)

The as-built spec is mostly accurate but **understates coupling in three places**:

1. **`workflow_steps` is not "largely inert."** Status *truth* is V2 (confirmed —
   no reader treats `workflow_steps.status` as authoritative; the would-be
   authoritative reader `get_ready_steps` is dead). BUT the V2 scanner **writes
   `workflow_steps` every scan cycle** (`engine/scanner.py:1032-1070` mirror loop),
   and the reused local executors (`server/workflow/engines/{local,mlp,analysis,
   lammps}.py`) also call `workflow_db.update_step`. So it is **live write-coupled
   to the engine**, not a creation-time scaffold. Dropping it means editing the
   engine write path, not just deleting a table.

2. **`v1_monitor.py` cannot be deleted wholesale.** Besides the FE-facing
   `build_initial_state`/`translate_broadcast_message`, it hosts `get_orca_stage`/
   `get_orca_irc_stage` (`v1_monitor.py:22,43`) which are imported by the **V2
   engine poller** (`engine/poller.py:15,304`). Relocate these first.

3. **Two FE endpoints are already broken on V2 today.** `GET /{wf}/vasp_frequencies/{step}`
   and `POST /{wf}/gibbs/{step}` read `workflow_steps.result_json` directly, but the
   scanner mirror writes **no `result_json`** to `workflow_steps`. So for
   V2-executed workflows these return empty. (Frequencies has a V2 sibling at
   `/api/engine/tasks/{id}/frequencies`; gibbs has none.) These need V2-native
   replacements regardless of #224.

Minor: the spec's two-DB table omits `branches`, `batch_subtasks`,
`workflow_folders`, `workflow_templates`, and the full ASE schema in
`catgo_results.db`.

---

## The two databases — verified live

| DB | Module | Tables | Live rows |
|----|--------|--------|-----------|
| `catgo_results.db` (active = `server/data/`, switchable) | `utils/workflow_db.py`, `utils/ase_db.py`, `utils/batch_db.py` | `workflows`, `workflow_steps`, `workflow_edges`, `projects`, `branches`(dead), `batch_subtasks`, `workflow_folders`(orphan), `workflow_templates`, full ASE schema | workflows 42, steps 209, edges 439, projects 2, branches 0 |
| `~/.catgo/catgo.db` (`config.paths.db_path`) | `workflow/db.py` | `workflows`, `tasks`, `task_links`, `task_results`, `provenance`, `hpc_sessions` | workflows 123 |

**The `workflows` tables are NOT a clean disjoint namespace:** V1 = 42 (all
uuid-dashed). V2 = 123: 95 16-hex (V2-native), 26 uuid-dashed (V1-created then run
— `convert_graph_json` preserves the uuid), +2 stray (`wfApi`/`wfApiLegacy`, test
pollution). **6 uuids exist in BOTH DBs**, with `graph_json` duplicated. Migration
must dedupe on shared uuids, not assume separate id spaces.

---

## Hard couplings that make single-DB collapse non-trivial

1. **ASE results share `catgo_results.db`.** `ase_db.set_active_db_path` repoints
   `workflow_db` to the same file. The V2 collector writes `task_results` (not ASE
   `systems`); `ase_db.store_result` is only hit by manual `POST /results/save-structure`.
   The dashboard's "Part A" reads ASE `systems` keyed by `step_id`. → Collapsing to
   `~/.catgo/catgo.db` means moving the entire ASE schema in, or breaking the
   "one file" invariant. **Biggest single-DB blocker.**
2. **Projects live only in V1** (`projects` table; V2 has only a `workflows.project_id`
   column, no projects table/CRUD/nesting).
3. **`batch_subtasks`** (`utils/batch_db.py`) shares `catgo_results.db` via
   `get_active_wf_db_path` — must be repointed on collapse.
4. **Path divergence:** `server/data/catgo_results.db` (active) vs
   `server/catgo/data/catgo_results.db` (packaged, even has empty V2 tables).

---

## Dead code — free deletes (verified 0 references incl. tests)

Backend: `branches` table + `create_branch`/`update_branch_status`/`get_branches`/
`get_branch`; `get_ready_steps`; `get_step_dependencies`;
`get_incomplete_running_workflows`; `list_edges` import (`workflow.py:60`);
`state_map.v1_to_v2_status`; orphan `workflow_folders` table; the `reset_step_and_descendants`/
`reset_all_steps` V1 fallbacks are dead-in-practice (engine_db always set).
Frontend: `WorkflowListV2.svelte` (no mount anywhere).

---

## V2-native gaps (must be BUILT before V1 routes can drop)

The `/api/engine/*` surface is **execution/monitoring only** — no authoring. The FE
can only do these via V1 today:

- **Authoring:** create workflow / save graph (`POST /workflow/`, `PUT /{id}`),
  delete (`DELETE /{id}` — V2 has none), get editable `graph_json` back,
  templates (`/templates`, `/from-template`).
- **Projects:** full CRUD (V1 router only).
- **DB switch:** `/workflow/db/{current,new,open,save-as,browse}` — the entire
  switchable-active-DB model is V1-only; V2 uses fixed `~/.catgo/catgo.db`.
- **Status/ops:** `run-status`, `recheck-jobs`, `update_step` analog.
- **Data/analysis:** `gibbs`, `forces` (per-ionic-step), `step-results`,
  `mlp-progress` (V2 task-mode is a stub), `orca_progress`/`uvvis`/`irc_trajectory`,
  `results-enriched` dashboard aggregation (read `task_results`+provenance).
- **Batch:** `batch-summary`/`results`/`histogram`/`retry` (no V2 equivalent).
- **Monitor:** V2 `/v2/workflows/{id}/monitor` has no `initial_state` snapshot
  frame (DAG viewer seeds via a separate `get_v2_dag` REST call); the editor's
  `on_initial_state` drives recheck/stale logic.

Already V2-native (exist on `/api/engine/tasks/*`): result, retry, cancel,
confirm/reject, provenance, files, convergence, file-content (r/w), frequencies;
native monitor WS.

---

## Frontend V1/V2 component map (verified)

| Component | Mode | Mounted | Note |
|-----------|------|---------|------|
| WorkflowEditor | **V1-step** | `desktop/WorkflowView` editor view | GUI editor; status from `node_statuses` (graph node id, coarse strings) via V1 WS. **Primary V1 consumer.** |
| NodeStatusPanel | dual | editor(step)/StatusPopout(step)/EngineTaskEditor(task) | switches on `mode`; in step mode auto-fetches V2 task at `{wf}:{node}` for confirm. |
| task-adapter | dual | NodeStatusPanel | `step`→V1, `task`→V2; `normalize_status` collapses 15 V2 states→coarse. |
| WorkflowDAGViewer / EngineTaskEditor | **V2-only** | `v2_dag` view | live, but reachable only for **engine-created** workflows; GUI workflows always route to V1 editor. |
| StatusPopout, BatchStatusSection/Panel, ProjectDashboard(dual), StepFileTree | V1 | various | batch endpoints V1-only. |
| WorkflowListV2 | V2 | **none (dead)** | delete. |

Live-status path today: `workflow-execution.svelte.ts` → `connect_workflow_monitor`
(WS `/workflow/{id}/monitor`) → `node_statuses[node_id]=coarse`. Result polling is
**already V2** (`/engine/tasks/{wf}:{task}/result`). #227 already added the
`{wf}:{node}` namespacing + `V2Task.node_id` the editor needs to go V2-native.

---

## Phased convergence plan (risk-rated, dependency-ordered)

| Phase | Scope | Depends on | Risk | Shippable now? |
|-------|-------|-----------|------|----------------|
| **0. Dead-code cleanup** | delete the "free deletes" above (backend + `WorkflowListV2`) | — | low | ✅ |
| **1. Decouple engine internals** | move `get_orca_stage`/`get_orca_irc_stage` out of `v1_monitor` into `poller.py`/`engine/orca_progress.py` | — | low | ✅ |
| **2. Build V2-native FE endpoints** | gibbs/forces/irc/uvvis/mlp-progress + results-enriched aggregation (read `task_results`) + graph create/save/delete + templates + projects CRUD + DB-switch + monitor `initial_state` frame | — (additive) | med | ✅ |
| **3. Drop V1 FE shape** | FE → `/api/engine/*` + native V2 monitor; remove V1 `/monitor`, `list_steps_v1`, `/steps`/`run-status` | **FE migration** | med→high | ❌ FE first |
| **4. Drop `workflow_steps`** | remove scanner mirror, `_sync_steps_from_graph`, `_V2_TO_V1_STATUS`; executors stop writing steps | 2 + 3 | med-high | ❌ |
| **5. Single-DB collapse** | migrate `projects` + ASE `systems` into V2 DB; dedupe 6 shared uuids; unify paths; repoint `batch_db`; retire `catgo_results.db` + `/workflow/db/*` | all | high | ❌ last |

### Frontend migration sub-sequence (inside Phase 3)
1. delete `WorkflowListV2` (trivial).
2. unify `STATUS_COLORS`/types to carry the full TaskState set; keep
   `normalize_status` as the only collapse point (low).
3. editor live-status: swap `connect_workflow_monitor` → `connect_v2_monitor`,
   rekey `node_statuses` by `task.node_id` (**high** — core seam; needs the V2
   `initial_state` frame from Phase 2 + a recheck-jobs analog).
4. editor renders status from V2 `tasks`/`links` instead of `node_statuses`
   (high — large file, many sites; #227 mapping helps).
5. replace remaining step-mode V1 data calls with task-adapter task-mode
   (blocked on the Phase-2 per-task endpoints).

---

## UI surfaces — what "converge" does and does NOT mean

There are two visualization surfaces today, and it is important to separate the
two axes of "two interfaces":

- **Axis 1 — data/engine duality (V1 vs V2).** This is the real debt; the phases
  above remove it. End state: one engine, one data model (V2 tasks), one API,
  one DB.
- **Axis 2 — UI surface count.** Two views exist: **WorkflowEditor** (authoring
  canvas — drag nodes, connect edges, set params; design-time) and
  **WorkflowDAGViewer + EngineTaskEditor** (execution monitoring + per-task
  inspect/edit of input files & structure; run-time "the engine's eyes").

**Why two views exist today:** the editor is V1 and cannot show V2 execution
truth, so a separate V2-native viewer was built. The split is also **source-based
routing** — GUI-created workflows open in the editor, MCP/CLI/engine-created ones
open in the DAG viewer. That routing split is the actual user-facing confusion.

**What convergence must do (necessary):**
1. Remove the **source-based routing split** — any V2 workflow opens in the same
   place regardless of origin (one entry point).
2. Make **WorkflowEditor V2-native** (read tasks/links, live status from the V2
   monitor, per-node input-file/structure editing). This is required anyway to
   drop V1.

**Why UI 2 is NOT redundant scaffolding (important correction).** The two views
have fundamentally different rendering models:

- **UI 1 (WorkflowEditor) is catalog-bound** — it renders/edits nodes from
  `NODE_DEFINITIONS`; it needs a `param_schema` per type to draw the node and its
  param form. It can only meaningfully show node types it knows (built-in +
  plugin/dynamic).
- **UI 2 (WorkflowDAGViewer + EngineTaskEditor) is data-driven** — it renders
  whatever `get_v2_dag` returns (raw tasks/links) and edits via the generic
  `get/put file-content` + params/structure. It can therefore **visualize and
  inspect ANY computation the engine actually ran** — headless/MCP/CLI-created
  workflows, batch fan-outs, map children, and task types the editor's palette
  does not have.

**This was the original reason UI 2 was built: so that *any* computation can be
seen, not just the curated GUI catalog.** A catalog-bound editor cannot do that.
So making the editor V2-native does **NOT** automatically subsume UI 2 — folding
naively would lose the "see any computation" capability.

**DECISION (chosen): Option A — keep UI 2 as the generic engine-state viewer.**
Convergence unifies **engine + data model + API + entry point**, and keeps two
complementary, both-V2-native views:
- WorkflowEditor — catalog-bound **authoring** (palette, param schemas, plugin +
  dynamic-engine nodes; see node model below).
- WorkflowDAGViewer/EngineTaskEditor — data-driven **generic observer/inspector**
  of any engine task graph.
Do **NOT** delete UI 2. The only UI-level change required is removing the
**source-based routing split** (any V2 workflow openable from either view) and
pointing both views at the unified V2 data.

(Option B — make the editor itself data-driven by rendering unknown task types
with a *generic node* + generic file/structure editor, so it could subsume UI 2 —
is a larger future enhancement, and is the same capability that would enable an
in-UI custom-node builder. Not chosen for the convergence; recorded as an option.)

### Two create paths = two authoring experiences (keep both; converge the data only)

There are two workflow-creation paths today, and they correspond to the two views:

| MCP tool | impl | writes | view | character |
|----------|------|--------|------|-----------|
| `catgo_workflow` (the agent default) | `mcp_tools/workflow_tools.py` (httpx → `/api/workflow/*`) | V1 `graph_json` in `catgo_results.db` | UI 1 editor | **rich / high-control** — full catalog, param schemas, plugin + dynamic-engine nodes |
| `catgo_workflow_engine` | `workflow/mcp_tools.py` (`_get_db` → `~/.catgo/catgo.db`) | V2 tasks directly | UI 2 DAG viewer | **flexible / minimal** — generic add_task/connect, can express arbitrary tasks the catalog lacks |

**Decision: keep BOTH authoring experiences — do not collapse to one create path.**
UI 1 is the high-control editor (more 可操作空间); UI 2 is the flexible "anything"
builder/observer. They are complementary product surfaces, not duplication.

What convergence removes is the **dual DATA store** (the V1 `catgo_results.db`
graph_json), NOT the dual UX: after convergence **both create paths write the same
V2 store** (the rich editor + `catgo_workflow` become V2-native; the engine path
already is), and a workflow created either way is openable in either view. So the
end state is **one V2 data model + engine, two authoring experiences (rich UI 1 /
flexible UI 2), one observer (UI 2's data-driven view)**.

**Agent behavior:** when the user asks the AI to "build a workflow," it should
**ask which path** — rich editor (`catgo_workflow`, UI 1, full control) vs flexible
engine (`catgo_workflow_engine`, UI 2, arbitrary tasks) — rather than silently
defaulting to the V1 editor path. (Today `catgo_workflow` silently goes V1→UI 1.)

## Node extensibility model (must be preserved on the editor)

The OLD editor's node catalog is three layers (`src/lib/workflow/node-definitions.ts`,
`node-defs/`):

1. **Built-in nodes** — code-defined in `node-defs/` (`calculation.ts`,
   `common.ts`, `analysis/`, `logic/`, `specialized/`, `utility/`): geo_opt,
   slab_gen, adsorbate, freq, etc. Fixed set; not editable in the UI (no in-UI
   "create node type" builder).
2. **Dynamic engine specs** — `load_dynamic_engines()` fetches declarative
   `EngineSpec`s from `GET /api/workflow/engine-defs` and ADDS software options +
   params onto *existing* calc nodes (e.g. register a new DFT engine as a
   `software` option with `show_if`-gated params). Extends existing nodes, not new
   types.
3. **Plugin/tool nodes** — `load_plugin_nodes()` fetches full `NodeDefinition`s
   from `GET /api/plugins/workflow-nodes` and `GET /api/tools/workflow-nodes` and
   **registers them as new node types** in the palette (if the `type` isn't
   already present). This is how "custom nodes" are added: author a plugin/tool
   (backend, declarative JSON), not hand-draw a node in the GUI.

So **"can the old UI define custom nodes?"** — not by drawing them in the canvas,
but yes via the backend plugin/tool + dynamic-engine extension paths.

**Convergence implication:** all authoring (palette, `param_schema`/`show_if`,
drag-to-add, plugin + dynamic-engine loading) lives ONLY in `WorkflowEditor`.
`WorkflowDAGViewer`/`EngineTaskEditor` have no node-authoring. Therefore the
unified surface must be the **editor made V2-native** — preserving the three-layer
node model — and these endpoints (`/workflow/engine-defs`, `/plugins/workflow-nodes`,
`/tools/workflow-nodes`) must remain (or get V2-namespaced equivalents) so custom
nodes keep working. Folding must not drop them.

---

## Recommendation

- **Start safe:** Phase 0 as a small PR (verified dead code); Phase 1 + 2 as
  additive PRs (add nothing-breaks V2 endpoints). These reduce what later phases
  must move and fix the already-broken V2 frequencies/gibbs.
- **Do NOT bundle 3/4/5 into one PR** — they are a frontend rewrite + a live-data
  migration with ASE coupling. Each is its own focused effort with full regression.
- **Re-shape #224 into a tracking issue** with one sub-issue per phase, so progress
  is independently shippable (which the as-built spec already asserts as the goal).

## Key files
Backend: `utils/workflow_db.py`, `utils/ase_db.py`, `utils/batch_db.py`,
`routers/workflow.py`, `routers/workflow_engine.py`, `routers/workflow_engine_tasks.py`,
`workflow/db.py`, `workflow/graph_converter.py`, `workflow/v1_compat.py`,
`workflow/state_map.py`, `workflow/states.py`, `workflow/engine/scanner.py`,
`workflow/engine/v1_monitor.py`, `workflow/engine/poller.py`,
`server/workflow/engines/{local,mlp,analysis,lammps}.py`, `main.py`.
Frontend: `lib/api/workflow.ts`, `lib/api/workflow-v2.ts`, `lib/api/task-adapter.ts`,
`lib/workflow/workflow-execution.svelte.ts`, `lib/workflow/WorkflowEditor.svelte`,
`lib/workflow/workflow-types.ts`, `lib/workflow/graph-model.ts`.
