# Handoff + E2E test plan: #224 V1→V2 convergence (Phase 0–3) and remaining work

> Written 2026-06-05 before a session clear. Self-contained for a fresh session.
> Companion: `2026-06-05-workflow-v2-convergence-analysis.md` (the seam map + phased
> plan + decisions). This file = what's done, how to E2E-test Phase 0–3, what remains.
> **This doc is uncommitted on disk** — commit it (on a clean branch off main) when you pick up.

## 0. Current state (branches / PRs)

**Merged to `main` this session:**
- #245 build-docs; #231 (route-shadow/.specie/slab-freeze sweep → closed #220);
  #239 (#227 task-id namespacing + #228 run-config job_params); #249 (#223 FCC(111)
  + #221 orphan wasm + #248 rutile stoichiometry); #250 (#222 freeze propagation);
  #251 (#225 real dry-run).
- **#224 Phase 0** → #262 MERGED (verified-dead V1 code removed).
- **#224 Phase 1 + Phase 2 batch 1** → #268 MERGED (commit `ec721d93`): ORCA helpers
  moved to `engine/orca_progress.py`; new V2 endpoints results-enriched / gibbs /
  forces / mlp-progress; new `services/workflow_results.py`.

- **#224 Phase 2b + Phase 3-prep** → **PR #270 OPEN** (branch `fix/workflow-v2-phase2-3`,
  rebased onto main, review APPROVE): V2 endpoints orca-progress / irc-trajectory /
  step-results; V2 monitor `initial_state` frame; FE status-vocab unification. 40 new
  + 28 regression tests pass. Awaiting CI + review/merge.

**Open PRs to review/merge on resume:** #270 (above). Plus the analysis doc on branch
`docs/workflow-v2-convergence-analysis` — pushed, **no PR** (open one or merge it).
**This handoff doc itself is still untracked on disk — commit it.**

## 1. How to run / build / test

- **Backend:** `cd /home/james0001/project/catgo-LRG && /home/james0001/miniforge3/envs/catgo/bin/python server/main.py` (binds :8000). Or `pnpm desktop:serve` (FE+BE+agent). Do NOT have two backends on :8000.
- **Python tests:** from `server/`, `/home/james0001/miniforge3/envs/catgo/bin/python -m pytest <files> -p no:cacheprovider -q`. The FULL suite hangs (>7 min) on integration/HPC files — run targeted files.
- **Rebuild ferrox** (after Rust edits): `maturin develop --release -m extensions/rust/Cargo.toml` (python ext) and `pnpm build:wasm` (WASM). Both `_ferrox.abi3.so` and `pkg/ferrox_bg.wasm` are gitignored.
- **FE checks:** `rtk proxy pnpm exec svelte-check --threshold error`; `rtk proxy pnpm exec vitest run <file>` (RTK serves stale vitest output — always use `rtk proxy`).

## 2. E2E tests — #224 Phase 0–3

### Phase 0 — dead code removed (merged #262)
- Backend boots: `curl -s localhost:8000/api/health` → `{"status":"healthy",...}`; startup log shows `Deferred routers included (19 of 19)`.
- Gone (grep should be 0 in `server/catgo`): `get_ready_steps`, `get_step_dependencies`, `get_incomplete_running_workflows`, `create_branch`, `branches` table, `list_edges`; FE `WorkflowListV2.svelte` deleted.

### Phase 1 — ORCA helpers decoupled (merged #268)
- From `server/`: `python -c "from catgo.workflow.engine import poller, orca_progress, v1_monitor; print('ok')"`.
- `poller.py` imports `get_orca_stage`/`get_orca_irc_stage` from `orca_progress` (not `v1_monitor`); `v1_monitor` keeps only `build_initial_state`/`translate_broadcast_message`.
- `pytest tests/test_orca_progress.py` → pass.

### Phase 2 — additive V2 endpoints (merged #268 batch1 + in-flight 2b)
Set up a V2 workflow with a completed task (e.g. via `catgo_workflow_engine` MCP, or convert a graph + run; or use the test fixtures). Then:
- `GET /api/engine/workflows/{wf}/results-enriched` → enriched results from `task_results`.
- `POST /api/engine/tasks/{wf}:{node}/gibbs` (task id is namespaced `{workflow_id}:{node_id}`) → Gibbs value (needs a task whose result has frequencies).
- `GET /api/engine/tasks/{id}/forces` → per-ionic-step forces (or clean 404 if no work_dir).
- `GET /api/engine/tasks/{id}/mlp-progress` → real MLP progress (FE task-adapter now calls this).
- (Phase 2b, after that workflow merges) `GET /api/engine/tasks/{id}/orca-progress`, `.../irc-trajectory`, `.../step-results`.
- pytest: `tests/test_v2_results_endpoints.py test_v2_task_analysis.py test_v2_task_forces.py test_v2_task_mlp_progress.py` (+ the 2b test files) → all pass.
- **Additive check:** the V1 endpoints (`/api/workflow/{wf}/results-enriched`, `/gibbs/{step}`, …) and `routers/workflow.py` are UNCHANGED — both surfaces work.

### Phase 3 prep (in-flight)
- V2 monitor WS first frame = `initial_state` carrying tasks/links: connect to `ws://localhost:8000/v2/workflows/{wf}/monitor` and assert the first message `type==="initial_state"`.
- FE `STATUS_COLORS` (workflow-types.ts) renders the full V2 TaskState set; `svelte-check` clean. `normalize_status` is still the only V2→coarse collapse point.

### Phase 3 CORE — NOT built yet (the high-risk piece)
Make the **editor** V2-native: swap `connect_workflow_monitor` → `connect_v2_monitor` in `workflow-execution.svelte.ts`, rekey `node_statuses` by `task.node_id`, render status from V2 tasks, and remove the source-based routing split (any V2 workflow openable in either view). **Must be browser-verified** (use the agent-browser skill): build a workflow in the editor, run it, watch node status update live from V2; confirm both GUI-created and engine-created workflows open in the editor. Do NOT ship this without a live run — automated tests can't cover the Svelte live-status path.

## 3. Also testable (other merged session work)
- **Slab (ferrox)** — after `maturin develop` + `pnpm build:wasm`: RuO2/TiO2/IrO2 (110)/(100)/(101) slabs give O/M = 2.0; FCC(111) p(3×3)×5 = 45 atoms / 9-per-layer / c⊥; FE WASM == backend (node harness). `cargo test -p ferrox --lib` → ~990 pass.
- **Freeze (#222)** — slab_gen with frozen_layers → the Adsorbate node preview shows fixed atoms (browser); POSCAR export has `F F F` on bottom layers.
- **Dry-run (#225)** — Simulate validates + per-node input-gen; missing upstream structure → **skipped** (not failed); cycle/bad-params → honest error. `tests/test_workflow_dry_run.py`.
- **Task-id namespacing (#227)** — two same-template workflows (e.g. RPBE + RPBE-D3) coexist without clobbering. `tests/test_task_id_namespacing.py`.
- **Engine/hpc routes (#231)** — `/api/engine/workflows`, `/api/hpc/health` return 200 (not 404) with `build-desktop/` present.

## 4. Remaining #224 phases (per analysis doc) — to complete

- **Phase 2 (rest):** authoring on V2 — graph create/save/delete, templates, projects CRUD, DB open/new/save-as. Ties to: (a) **keep BOTH authoring experiences** (rich UI1 `catgo_workflow` / flexible UI2 `catgo_workflow_engine`) — agent should ASK the user which when building; (b) single-DB (Phase 5).
- **Phase 3 core:** the editor V2-native rewrite above (browser-verified).
- **Phase 4:** drop `workflow_steps`/`workflow_edges` — remove the scanner mirror (`scanner.py:~1032`), `_sync_steps_from_graph`, `_V2_TO_V1_STATUS`; stop the reused executors writing steps. Needs Phase 2 dashboards/gibbs done + FE off the V1 shape.
- **Phase 5:** single DB — migrate `projects` + (decide) ASE `systems` into `~/.catgo/catgo.db`; dedupe the **6 workflow uuids that exist in BOTH** DBs; unify the `server/data/` vs `server/catgo/data/` path split; repoint `batch_db`. Highest risk (live results + ASE coupling).

### Decisions already made (don't relitigate)
- **Keep UI 2** (Option A): UI 2 (WorkflowDAGViewer/EngineTaskEditor) is the *data-driven* "see ANY computation" view; the editor is *catalog-bound*. Converge engine/data/API/entry-point; keep two complementary views; only delete the truly-dead `WorkflowListV2` (done).
- **Keep both create paths** as two authoring UXs (rich/flexible); converge the DATA (both write V2), not the UX. Agent asks the user which path when asked to build a workflow.
- Custom node types are added via backend plugin/tool defs (`/api/plugins|tools/workflow-nodes`) + dynamic engine specs (`/api/workflow/engine-defs`); an in-UI node builder is a future "generic node" enhancement (Option B), not part of the convergence.

## 5. Gotchas
- **Two MCP create tools:** `catgo_workflow` (`mcp_tools/workflow_tools.py`, httpx → V1 `/api/workflow/*` → UI 1) vs `catgo_workflow_engine` (`workflow/mcp_tools.py` → V2 → UI 2).
- Subagents in this repo have repeatedly found their target work **"already staged"** (possible concurrent writer — a separate `catgo-lrg` instance runs under `/home/shidi/`). **Always `git show --stat` a subagent's commit to confirm no stray files.**
- Pre-existing test failures (NOT regressions): `tests/test_workflow_engine.py` (`BUILD_NODES`⊂`LOCAL_NODES` in `node_sets.py`); `tests/test_claude_code_mcp.py` (~10 stale).
- Follow-up: V2 `gibbs` gas branch omits `free_indices` (selective-dynamics) → minor parity gap vs V1 (needs `free_indices` surfaced in `task_results`).
- Expanse manual ORR jobs `50437735` (RPBE) / `50437744` (RPBE-D3) under `~/…/catgo/manual_Pt111_ORR_*` (alias `expanse-tunnel`, user gliu3, sdp126).
