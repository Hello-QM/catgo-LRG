# CatGo Graph Kernel Stabilization Summary

**Date**: 2026-03-12
**Crate**: `catgo-graph` v0.1.0
**Location**: `crates/catgo-graph/`

## Scope

The CatGo graph kernel provides a DAG-based workflow execution engine for computational catalysis pipelines. This document summarizes the stabilization pass performed on the kernel codebase (~11.5k LOC, 45 Rust files, 368 tests).

## Architectural Boundaries

```
catgo-graph/
├── core/         # Primitive types, state enums, error model, time utils
├── graph/        # Template, run data, validation, resolution, composition, rewriting
├── runtime/      # Engine API, executor loop, scheduler, lifecycle enforcement
├── storage/      # SQLite + file persistence (StateStore, ArtifactStore traits)
├── tools/        # Tool trait, registry, built-in tools (echo, VASP, stats, file_writer)
├── repair/       # RepairHandler trait, RepairRegistry
└── api/          # DTOs, TemplateRegistry, monitoring hierarchy
```

### Module Responsibilities

| Module | Responsibility | Stability |
|--------|---------------|-----------|
| `core::state` | NodeStatus (9 states), GraphRunStatus (8 states), AttemptStatus | **Stable** |
| `core::errors` | StructuredError, EngineError, ErrorCategory | **Stable** |
| `graph::template` | GraphTemplate, NodeTemplate, RetryPolicy, RepairPolicyRef | **Stable** |
| `graph::run` | GraphRun, NodeRun, NodeAttempt, ArtifactRef | **Stable** |
| `graph::validate` | DAG validation (cycles, deps, IDs, tool/subgraph exclusivity) | **Stable** |
| `graph::resolver` | Input expression resolution (`${inputs.*}`, `${nodes.*.outputs.*}`) | **Stable** |
| `runtime::lifecycle` | State machine enforcement with timestamp management | **Stable** |
| `runtime::scheduler` | Dependency-based scheduling, failure propagation, skip conditions | **Stable** |
| `runtime::executor` | Main execution loop (JoinSet concurrency, retry, repair, rewrite) | **Stable** |
| `runtime::engine` | Top-level GraphEngine API (instantiate, run, resume, cancel) | **Stable** |
| `storage::sqlite_store` | SQLite persistence with transaction safety | **Stable** |
| `storage::file_store` | File-based artifact storage | **Stable** |
| `tools::traits` | Tool trait (async execute) | **Stable** |
| `tools::registry` | Tool name → Arc\<dyn Tool\> lookup | **Stable** |
| `graph::composer` | Subgraph template expansion (recursive, depth-limited) | **Beta** |
| `graph::rewrite` | Dynamic rewrite rules (condition eval, subgraph injection) | **Beta** |
| `graph::subgraph_validate` | Pre-expansion validation of subgraph refs | **Beta** |
| `api::dto` | Monitoring/API DTOs | **Beta** |
| `api::graph_api` | TemplateRegistry, structured query API | **Beta** |
| `repair::traits` | RepairHandler trait and registry | **Beta** |
| `tools::vasp` | VASP tool (dry-run mode only) | **Experimental** |

## Bugs Fixed in This Stabilization Pass

### Critical

1. **SQLite transaction safety** (`storage/sqlite_store.rs`)
   - `save_graph_run()` and `delete_graph_run()` now wrapped in `BEGIN TRANSACTION`/`COMMIT` with rollback on error
   - Previously, a crash mid-save could leave the database with a graph_runs row but missing node_runs

### High

2. **Resume misses Ready nodes** (`runtime/engine.rs`)
   - `resume_graph()` and `resume_graph_with_rewrites()` now reset `Ready` nodes to `Pending` in addition to `Running` and `Repairing`
   - Extracted shared `reset_interrupted_nodes()` helper to eliminate code duplication

3. **Unbounded repair loop** (`graph/template.rs`, `runtime/executor.rs`)
   - Added `max_repair_attempts: u32` to `RepairPolicyRef` (default: 3)
   - Added `repair_count: u32` to `NodeRun` (serde-default: 0)
   - Executor now skips repair when `repair_count >= max_repair_attempts`

4. **Missing `finished_at` on repair failure** (`runtime/executor.rs`)
   - Repair failure path now uses `lifecycle::transition_node(nr, NodeStatus::Failed)` which correctly sets `finished_at`
   - Previously used direct assignment, leaving `finished_at` as `None`

### Medium

5. **State machine gap: `Failed → Repairing`** (`core/state.rs`, `runtime/lifecycle.rs`)
   - Added `Failed → Repairing` to the state machine (was being bypassed via direct assignment)
   - `lifecycle::transition_node` for `Repairing` target now clears `finished_at`
   - Repair entry path now goes through proper lifecycle enforcement

6. **Documented intentional state bypasses** (`runtime/executor.rs`)
   - `Running → Pending` (retry reset) and `Repairing → Pending` (repair success reset) are intentional bypasses, now documented with comments

## API/DTO Alignment

### New Fields Added

- `NodeRunSummary`: `tool_name`, `last_error_message`, `repair_count`
- `GraphTemplateInfo`: `has_rewrite_rules`, `rewrite_rule_count`
- `NodeStatusDetail`: `repair_count`

All new fields use `#[serde(default)]` for backward compatibility.

### New ExecutionEvent Variants

- `NodeRetryScheduled { node_id, attempt, backoff_seconds }`
- `NodeRepairStarted { node_id, repair_attempt, handler }`
- `NodeRepairCompleted { node_id, success }`

## Test Coverage

| Category | Count |
|----------|-------|
| Unit tests | 246 |
| Integration tests | 108 |
| Stabilization regression tests | 14 |
| **Total** | **368** |

Key coverage areas:
- State machine transitions (all 9 states, including new `Failed → Repairing`)
- Lifecycle timestamp management
- SQLite transaction roundtrip and deletion
- Resume with Ready nodes
- Repair count bounds and serde backward compat
- DTO new field serialization and backward compat
- ExecutionEvent new variant serialization

## Known Limitations

1. **No cycle validation after rewrite injection**: When a rewrite rule injects subgraph nodes at runtime, the expanded graph is not re-validated for cycles. Mitigation: rewrite rules use `max_applications` to bound injections.

2. **`_artifact_store` parameter unused in executor**: The `execute_run` function accepts an `ArtifactStore` but doesn't use it. Tools manage their own artifact storage via `ToolExecutionContext.work_dir`.

3. **VASP tool is dry-run only**: The `VaspTool` generates deterministic mock outputs. Real VASP integration requires an external process executor.

4. **No graph-level cancel API**: `cancel_graph()` is not yet implemented in `GraphEngine`. Individual node cancellation would require task abort support in the executor's JoinSet.

5. **Single-writer SQLite**: The `SqliteStateStore` uses a `Mutex<Connection>`, supporting single-writer concurrency. Multi-process access would require WAL mode or an external coordinator.

## Contributor Guidance

### Adding a New Tool
1. Implement `Tool` trait in `tools/`
2. Register in `ToolRegistry`
3. Reference by name in `NodeTemplate.tool`
4. Add unit tests in the tool module + integration test in `tests/`

### Adding a New Node State
1. Add variant to `NodeStatus` in `core/state.rs`
2. Update `is_terminal()` and `can_transition_to()` with valid transitions
3. Update `lifecycle::transition_node()` timestamp logic
4. Update `scheduler::determine_run_status()` if it affects graph-level status
5. Update DTO mappers in `api/graph_api.rs`

### Modifying the Executor
- All state transitions should go through `lifecycle::transition_node()` unless intentionally bypassing (document with comment)
- New events should be added to `ExecutionEvent` enum and emitted via `emit()`
- Test with both success and failure paths

### Persistence Compatibility
- New fields on `NodeRun`, `GraphRun`, or templates must use `#[serde(default)]` for backward compat with existing SQLite data
- The SQLite schema stores JSON blobs; no schema migration needed for new serde fields
