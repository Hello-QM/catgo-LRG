"""WorkflowEngine — stateless periodic scanner.

Each scan_cycle() reads DB, advances task states, and returns.
No in-memory state between cycles. Crash and restart safely.
"""

from __future__ import annotations
import asyncio
import logging
from typing import Any

import catgo.workflow.builtins  # noqa: F401 — register built-in task types

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState, WorkflowState
from catgo.workflow.engine.advancer import advance_waiting_tasks
from catgo.workflow.engine.broadcast import broadcast as _broadcast
from catgo.workflow.engine.control_flow import handle_while_task, handle_zone_task
from catgo.workflow.engine.error_handler import handle_errors
from catgo.workflow.provenance import record_provenance as _record_provenance

logger = logging.getLogger(__name__)


def _poscar_to_json(poscar_str: str) -> str:
    """Convert POSCAR/CONTCAR string to pymatgen JSON dict string.

    If the input is already valid JSON, returns it unchanged.
    This ensures downstream nodes always get JSON-format structures.
    """
    import json as _json
    # Already JSON?
    s = poscar_str.strip()
    if s.startswith("{"):
        return poscar_str
    # Parse POSCAR via pymatgen
    try:
        from pymatgen.io.vasp import Poscar
        structure = Poscar.from_str(poscar_str).structure
        return _json.dumps(structure.as_dict())
    except Exception as e:
        logger.warning("_poscar_to_json: failed to parse POSCAR (%s), storing raw", e)
        return poscar_str


class WorkflowEngine:
    """Stateless workflow engine. Call scan_cycle() periodically.

    Tracks in-flight async tasks per workflow so they can be cancelled on reset.
    """

    def __init__(self, db: WorkflowDB, config: dict[str, Any] | None = None):
        self.db = db
        self.config = config or {}
        self.poll_interval = self.config.get("engine", {}).get("poll_interval", 30)
        # Track in-flight async tasks per workflow for cancellation on reset
        self._inflight: dict[str, list[asyncio.Task]] = {}
        # Set by lifecycle.start_engine once the dedicated engine loop is up.
        # Used to schedule task cancellation across threads.
        self._loop: asyncio.AbstractEventLoop | None = None

    def cancel_inflight(self, workflow_id: str) -> int:
        """Cancel all in-flight async tasks for a workflow. Called on reset.

        Safe to call from any thread: tasks belong to the engine's dedicated
        loop, so cancellation is scheduled via call_soon_threadsafe when
        invoked from a different thread (e.g. a FastAPI request).

        Returns the number of cancelled tasks.
        """
        tasks = self._inflight.pop(workflow_id, [])
        cancelled = 0
        loop = self._loop
        for t in tasks:
            if t.done():
                continue
            if loop is not None and loop.is_running():
                loop.call_soon_threadsafe(t.cancel)
            else:
                t.cancel()
            cancelled += 1
        if cancelled:
            logger.info("Cancelled %d in-flight tasks for workflow %s", cancelled, workflow_id)
        return cancelled

    def _track_task(self, workflow_id: str, task: asyncio.Task) -> None:
        """Track an async task for later cancellation on reset."""
        if workflow_id not in self._inflight:
            self._inflight[workflow_id] = []
        # Clean up completed tasks
        self._inflight[workflow_id] = [t for t in self._inflight[workflow_id] if not t.done()]
        self._inflight[workflow_id].append(task)

    async def scan_cycle(self) -> None:
        """One pass of the state machine. Reads DB, advances states."""
        await self._ensure_hpc_connections()

        workflows = self.db.list_workflows()
        active = [w for w in workflows if w["status"] == "running"]

        for wf in active:
            wf_id = wf["id"]
            try:
                await self._process_workflow(wf_id)
            except Exception as e:
                logger.error("Error processing workflow %s: %s", wf_id, e, exc_info=True)

    async def _ensure_hpc_connections(self) -> None:
        """Restore HPC connections from DB if pool is empty.

        Only auto-reconnects sessions that don't require user input
        (ssh_config, key with key_file). Tracks consecutive failures
        per session and removes stale entries after 3 failures.
        """
        from catgo.utils.hpc_client import pool, LOCAL_SESSION_ID

        # Check if we already have any live remote connections
        has_remote = any(
            sid != LOCAL_SESSION_ID and conn.is_alive
            for sid, conn in pool.connections.items()
        )
        if has_remote:
            return  # Already connected, nothing to do

        # Try to restore from DB
        sessions = self.db.get_hpc_sessions()
        if not sessions:
            return

        # Track reconnect failures (stored on engine instance, reset on success)
        if not hasattr(self, "_reconnect_failures"):
            self._reconnect_failures: dict[str, int] = {}

        for s in sessions:
            sid = s["session_id"]
            auth = s["auth_method"]

            # Only auto-reconnect methods that don't need interactive input
            if auth == "ssh_config":
                try:
                    from catgo.models.hpc import HPCConnectionConfig, AuthMethod, SchedulerType
                    config = HPCConnectionConfig(
                        host=s["host"],
                        username=s["username"],
                        port=s.get("port", 22),
                        auth_method=AuthMethod.SSH_CONFIG,
                        ssh_alias=s.get("ssh_alias"),
                        scheduler=SchedulerType(s.get("scheduler", "slurm")),
                    )
                    await pool.connect_ssh_config(config, sid)
                    self._reconnect_failures.pop(sid, None)
                    logger.info(
                        "Auto-reconnected HPC session %s (%s@%s) via ssh_config",
                        sid[:8], s["username"], s["host"],
                    )
                    return  # One connection is enough
                except Exception as e:
                    fails = self._reconnect_failures.get(sid, 0) + 1
                    self._reconnect_failures[sid] = fails
                    if fails >= 3:
                        logger.warning(
                            "Removing stale HPC session %s after %d failures: %s",
                            sid[:8], fails, e,
                        )
                        self.db.delete_hpc_session(sid)
                        self._reconnect_failures.pop(sid, None)
                    else:
                        logger.debug(
                            "Auto-reconnect attempt %d/3 failed for %s: %s",
                            fails, sid[:8], e,
                        )

            elif auth == "key" and s.get("key_file"):
                try:
                    from catgo.models.hpc import HPCConnectionConfig, AuthMethod, SchedulerType
                    config = HPCConnectionConfig(
                        host=s["host"],
                        username=s["username"],
                        port=s.get("port", 22),
                        auth_method=AuthMethod.KEY,
                        key_file=s["key_file"],
                        scheduler=SchedulerType(s.get("scheduler", "slurm")),
                    )
                    await pool.connect(config, sid)
                    self._reconnect_failures.pop(sid, None)
                    logger.info(
                        "Auto-reconnected HPC session %s (%s@%s) via key",
                        sid[:8], s["username"], s["host"],
                    )
                    return  # One connection is enough
                except Exception as e:
                    fails = self._reconnect_failures.get(sid, 0) + 1
                    self._reconnect_failures[sid] = fails
                    if fails >= 3:
                        logger.warning(
                            "Removing stale HPC session %s after %d failures: %s",
                            sid[:8], fails, e,
                        )
                        self.db.delete_hpc_session(sid)
                        self._reconnect_failures.pop(sid, None)
                    else:
                        logger.debug(
                            "Auto-reconnect attempt %d/3 failed for %s: %s",
                            fails, sid[:8], e,
                        )

    async def _process_workflow(self, workflow_id: str) -> None:
        """Process one workflow: advance states, submit, poll, collect, handle errors."""
        # 1. WAITING -> READY
        advance_waiting_tasks(self.db, workflow_id)

        # 2. Execute READY local tasks immediately
        self._execute_ready_local_tasks(workflow_id)

        # 2b. Recover transient-error tasks (SSH back?)
        await self._recover_transient_errors(workflow_id)

        # 3. Submit READY HPC tasks
        from catgo.workflow.engine.submitter import submit_ready_tasks
        await submit_ready_tasks(self.db, workflow_id, self.config)

        # 4. Poll SUBMITTED/QUEUED/RUNNING tasks
        from catgo.workflow.engine.poller import poll_active_tasks
        await poll_active_tasks(self.db, workflow_id, self.config)

        # 5. Collect results from COMPLETED_REMOTE tasks
        from catgo.workflow.engine.collector import collect_completed_tasks
        await collect_completed_tasks(self.db, workflow_id, self.config)

        # 6. Handle REMOTE_ERROR -> retry or FAILED (skips transient errors)
        handle_errors(self.db, workflow_id, self.config)

        # 7. Update workflow-level status
        self._update_workflow_status(workflow_id)

    async def _recover_transient_errors(self, workflow_id: str) -> None:
        """Try to recover REMOTE_ERROR tasks whose error_type is 'transient'.

        When SSH reconnects, these tasks should resume rather than stay stuck:
        - If the task has an hpc_job_id, probe the job status first:
          * Job completed on HPC -> COMPLETED_REMOTE (results will be collected)
          * Job still running/queued -> restore to SUBMITTED/RUNNING
          * Job failed -> change error_type to "compute" so error_handler retries it
        - If no hpc_job_id (submit never finished), reset to READY for re-submission.
        """
        from catgo.workflow.engine.hpc_utils import get_hpc_connection
        from catgo.workflow.engine.poller import _check_job

        error_tasks = self.db.get_tasks_by_status(
            workflow_id, TaskState.REMOTE_ERROR.value,
        )
        # Also recover FAILED tasks that were caused by transient errors
        # (e.g., "No HPC connection" that exhausted retries before the fix)
        failed_tasks = self.db.get_tasks_by_status(
            workflow_id, TaskState.FAILED.value,
        )
        _TRANSIENT_PATTERNS = ["No HPC connection", "connection lost", "SSH", "connection unavailable"]
        for t in failed_tasks:
            msg = t.get("error_message", "") or ""
            if t.get("error_type") == "transient" or any(p.lower() in msg.lower() for p in _TRANSIENT_PATTERNS):
                error_tasks.append(t)

        transient = [t for t in error_tasks if
            t.get("error_type") == "transient" or
            t.get("status") == TaskState.FAILED.value  # FAILED from transient patterns
        ]
        if not transient:
            return

        for task in transient:
            task_id = task["id"]
            hpc = await get_hpc_connection(task, self.config)
            if not hpc:
                # Still disconnected — leave in REMOTE_ERROR, try next cycle
                continue

            job_id = task.get("hpc_job_id")
            if not job_id:
                # Submit never completed — go back to READY for re-submission
                self.db.update_task(task_id,
                    status=TaskState.READY.value,
                    error_message=None,
                    error_type=None,
                )
                logger.info(
                    "Task %s: transient recovery -> READY (no job_id, will re-submit)",
                    task_id,
                )
                continue

            # Task was submitted before disconnect — check what happened to the job
            try:
                job_status = await _check_job(hpc, job_id)
            except Exception as e:
                logger.warning("Task %s: transient recovery probe failed: %s", task_id, e)
                continue

            if job_status == "COMPLETED_REMOTE":
                self.db.update_task(task_id,
                    status=TaskState.COMPLETED_REMOTE.value,
                    error_message=None,
                    error_type=None,
                )
                logger.info(
                    "Task %s: transient recovery -> COMPLETED_REMOTE (job %s finished while disconnected)",
                    task_id, job_id,
                )
            elif job_status == "FAILED":
                # The HPC job itself failed — reclassify as compute error
                # so the error_handler can apply smart recovery / retries.
                self.db.update_task(task_id,
                    error_type="compute",
                    error_message="HPC job failed (detected after reconnect)",
                )
                logger.info(
                    "Task %s: transient -> compute error (job %s failed on HPC)",
                    task_id, job_id,
                )
            elif job_status in ("RUNNING", "QUEUED"):
                self.db.update_task(task_id,
                    status=TaskState.SUBMITTED.value if job_status == "QUEUED" else TaskState.RUNNING.value,
                    error_message=None,
                    error_type=None,
                )
                logger.info(
                    "Task %s: transient recovery -> %s (job %s still active)",
                    task_id, job_status, job_id,
                )
            else:
                # UNKNOWN — leave in REMOTE_ERROR, try again next cycle
                logger.debug(
                    "Task %s: transient recovery got UNKNOWN status for job %s, will retry",
                    task_id, job_id,
                )

    def _get_workflow_execution_mode(self, workflow_id: str) -> str:
        """Read execution_mode from per-workflow config_json."""
        try:
            wf = self.db.get_workflow(workflow_id)
            import json as _json
            cfg = _json.loads(wf.get("config_json", "{}") or "{}")
            return cfg.get("execution_mode", "hpc")
        except Exception:
            return "hpc"

    def _execute_ready_local_tasks(self, workflow_id: str) -> None:
        """Execute local tasks — the core of local workflow execution.

        LOCAL EXECUTION ARCHITECTURE
        ============================

        When execution_mode is 'local', calculations run on the user's machine
        (e.g., MACE subprocess) instead of being submitted to an HPC cluster.

        Task routing priority (checked in order):
          1. MLP nodes + local mode → _execute_mlp_local_task (MACE/CHGNet subprocess)
          2. Analysis nodes (always local) → _execute_analysis_local_task
          3. @task(local=True) builtins → defn.func() (structure_input, slab_gen, etc.)
          4. LOCAL_NODES/BUILD_NODES without @task → _execute_v1_local_task
          5. Everything else → skipped (submitter handles HPC submission)

        V1→V2 RESULT BRIDGE
        ====================

        The V1 executors (mlp.py, analysis.py, local.py) store results in an
        in-memory step_results dict and the V1 workflow_steps table. The V2
        engine stores results in the task_results table. Each bridge method:
          1. Builds a V1-style step_results dict from V2 task_results (_build_step_results)
          2. Calls the V1 executor
          3. Extracts results and stores them in V2 task_results (structure_json, energy, etc.)
          4. Stores contcar/stdout/work_dir in outputs_json for frontend display
          5. Persists work_dir on the V2 tasks table for file listing

        FAN-OUT (BATCH EXECUTION)
        =========================

        When a parent node (e.g., batch_slab_gen) produces multiple structures
        (_fan_out=True, structures=[list]), the MLP bridge detects this and
        dispatches to execute_mlp_local_batch() which runs all structures in
        parallel. Results are stored as a batch array in outputs_json.
        """
        from catgo.workflow.task_decorator import get_task_definition
        from catgo.workflow.engine.resolver import resolve_task_inputs
        from catgo.workflow.engine.resolver import _KEY_TO_COLUMN
        from workflow.node_sets import MLP_NODES, ANALYSIS_NODES, LOCAL_NODES, BUILD_NODES, _resolve_software, UNIFIED_CALC_NODES
        import json

        execution_mode = self._get_workflow_execution_mode(workflow_id)

        ready = self.db.get_tasks_by_status(workflow_id, TaskState.READY.value)
        for task in ready:
            task_id = task["id"]

            # --- Control-flow tasks: delegate to control_flow module ---
            if task["task_type"] == "__while__":
                handle_while_task(self.db, task, workflow_id)
                continue
            if task["task_type"] == "__zone__":
                handle_zone_task(self.db, task, workflow_id)
                continue

            task_type = task["task_type"]
            params = json.loads(task.get("params_json", "{}") or "{}")

            # Resolve unified calc types (geo_opt+mlp → mlp_relax)
            resolved_type = task_type
            if task_type in UNIFIED_CALC_NODES:
                resolved_type, _ = _resolve_software(task_type, params)

            # --- MLP local execution (when execution_mode == "local") ---
            if execution_mode == "local" and resolved_type in MLP_NODES:
                self._execute_mlp_local_task(workflow_id, task, resolved_type, params)
                continue

            # --- Analysis local execution (always local, no HPC needed) ---
            if resolved_type in ANALYSIS_NODES:
                self._execute_analysis_local_task(workflow_id, task, resolved_type, params)
                continue

            # --- @task(local=True) builtins run via their registered function ---
            defn = get_task_definition(task_type)
            if defn and defn.local:
                # Fall through to the existing defn.func() executor below
                pass
            elif resolved_type in LOCAL_NODES or resolved_type in BUILD_NODES:
                # V1 local nodes without @task registration (batch_slab_gen, etc.)
                self._execute_v1_local_task(workflow_id, task, resolved_type, params)
                continue
            else:
                continue  # Not a local task — submitter handles it

            self.db.update_task(task_id, status=TaskState.RUNNING.value)
            asyncio.get_event_loop().create_task(
                _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "RUNNING"})
            )

            try:
                inputs = resolve_task_inputs(self.db, task_id)
                params = json.loads(task.get("params_json", "{}") or "{}")
                all_inputs = {**inputs, **params}

                if defn.func:
                    result = defn.func(**all_inputs)
                else:
                    result = {}

                if isinstance(result, dict):
                    # Map result keys to DB column names, extras go to outputs_json
                    _VALID_COLUMNS = {
                        "energy", "structure_json", "real_freqs_json",
                        "imag_freqs_json", "positions_json", "masses_json",
                        "gibbs", "zpe", "ts_correction", "outputs_json",
                    }
                    db_result = {}
                    extras = {}
                    for k, v in result.items():
                        col = _KEY_TO_COLUMN.get(k, k)
                        if col in _VALID_COLUMNS:
                            db_result[col] = v
                        else:
                            extras[k] = v
                    if extras:
                        db_result["outputs_json"] = json.dumps(extras)
                    self.db.store_result(task_id, workflow_id, **db_result)
                    try:
                        _record_provenance(self.db, workflow_id, task_id, db_result, task)
                    except Exception as prov_err:
                        logger.warning("Provenance recording failed for task %s: %s", task_id, prov_err)

                self.db.update_task(task_id, status=TaskState.COMPLETED.value)
                asyncio.get_event_loop().create_task(
                    _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "COMPLETED"})
                )
                logger.info("Task %s (%s): local execution completed", task_id, task["task_type"])

            except Exception as e:
                self.db.update_task(task_id,
                    status=TaskState.FAILED.value,
                    error_message=str(e),
                )
                asyncio.get_event_loop().create_task(
                    _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "FAILED"})
                )
                logger.error("Task %s (%s): local execution failed: %s",
                             task_id, task["task_type"], e)

    def _build_step_results(self, task_id: str) -> dict[str, dict]:
        """Build V1-style step_results dict from parent task DB results."""
        import json as _json
        step_results: dict[str, dict] = {}
        parent_links = self.db.get_task_parents(task_id)
        for link in parent_links:
            pid = link["source_task_id"]
            result_row = self.db.get_result(pid)
            if not result_row:
                continue
            # Merge result columns + outputs_json into a flat dict
            r: dict = {}
            for k, v in result_row.items():
                if k in ("task_id", "workflow_id") or v is None:
                    continue
                if k == "outputs_json" and isinstance(v, str):
                    try:
                        r.update(_json.loads(v))
                    except Exception:
                        pass
                else:
                    r[k] = v
            # Also pull node_type from the parent task
            parent_task = self.db.get_task(pid)
            if parent_task:
                r["node_type"] = parent_task.get("task_type", "")
            step_results[pid] = r
        return step_results

    def _get_parent_ids_for_task(self, step_id: str, _edges: list) -> list[str]:
        """Get parent task IDs from the DB (ignores edges arg for V2 compat)."""
        links = self.db.get_task_parents(step_id)
        return [link["source_task_id"] for link in links]

    def _execute_mlp_local_task(
        self, workflow_id: str, task: dict, resolved_type: str, params: dict,
    ) -> None:
        """Launch MLP local execution as an async task (MACE/CHGNet/M3GNet)."""
        task_id = task["id"]
        self.db.update_task(task_id, status=TaskState.RUNNING.value)
        asyncio.get_event_loop().create_task(
            _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "RUNNING"})
        )

        async def _run() -> None:
            try:
                step_results = self._build_step_results(task_id)

                async def _bcast(wf_id: str, msg: dict) -> None:
                    await _broadcast(wf_id, msg)

                # Detect fan-out: parent has multiple structures (e.g. from batch_slab_gen)
                fan_out_structures = None
                fan_out_labels = None
                parent_links = self.db.get_task_parents(task_id)
                for link in parent_links:
                    pid = link["source_task_id"]
                    parent_data = step_results.get(pid, {})
                    structs = parent_data.get("structures")
                    if parent_data.get("_fan_out") and structs and len(structs) > 1:
                        fan_out_structures = structs
                        fan_out_labels = parent_data.get("labels")
                        break

                if fan_out_structures:
                    # Use parent labels if available, otherwise generate generic ones
                    labels = fan_out_labels or [f"slab_{i}" for i in range(len(fan_out_structures))]
                    from workflow.engines.mlp import execute_mlp_local_batch
                    await execute_mlp_local_batch(
                        workflow_id, task_id, resolved_type, params,
                        fan_out_structures,
                        labels,
                        step_results,
                        type("Config", (), {"local_work_dir": ""})(),
                        _bcast,
                    )
                else:
                    from workflow.engines.mlp import execute_mlp_local
                    await execute_mlp_local(
                        workflow_id, task_id, resolved_type, params,
                        [], step_results,
                        type("Config", (), {"local_work_dir": ""})(),
                        _bcast, self._get_parent_ids_for_task,
                    )

                # Bridge MLP results into V2 task_results table so
                # downstream tasks can find them via resolve_task_inputs().
                mlp_result = step_results.get(task_id, {})
                logger.info(
                    "Task %s: bridging MLP result to V2 DB (keys=%s)",
                    task_id, list(mlp_result.keys()) if mlp_result else "EMPTY",
                )
                import json as _json_bridge

                db_fields: dict[str, Any] = {}

                if mlp_result.get("_fan_out") and mlp_result.get("results"):
                    # --- Batch result: multiple structures processed ---
                    batch_results = mlp_result["results"]
                    # Store ALL results in outputs_json for frontend display
                    db_fields["outputs_json"] = _json_bridge.dumps(mlp_result, default=str)
                    # Use first completed structure as primary structure_json for downstream
                    for entry in batch_results:
                        if entry.get("status") == "completed":
                            r = entry.get("result", {})
                            if r.get("contcar"):
                                db_fields["structure_json"] = _poscar_to_json(r["contcar"])
                            if r.get("energy") is not None:
                                db_fields["energy"] = r["energy"]
                            break
                else:
                    # --- Single result ---
                    contcar = mlp_result.get("contcar")
                    if contcar:
                        db_fields["structure_json"] = _poscar_to_json(contcar)
                    if mlp_result.get("energy") is not None:
                        db_fields["energy"] = mlp_result["energy"]
                    freqs = mlp_result.get("frequencies")
                    if freqs is not None:
                        db_fields["real_freqs_json"] = _json_bridge.dumps(freqs) if not isinstance(freqs, str) else freqs
                    if mlp_result.get("zpe") is not None:
                        db_fields["zpe"] = mlp_result["zpe"]
                    # Everything else (contcar, stdout, work_dir) goes into outputs_json
                    _skip = {"energy", "frequencies", "zpe"}
                    extras = {k: v for k, v in mlp_result.items() if k not in _skip and v is not None}
                    if "stdout" in extras and isinstance(extras["stdout"], str):
                        extras["stdout"] = extras["stdout"][-5000:]
                    if extras:
                        db_fields["outputs_json"] = _json_bridge.dumps(extras, default=str)

                if db_fields:
                    self.db.store_result(task_id, workflow_id, **db_fields)
                # Persist work_dir on V2 tasks table for file listing endpoint
                work_dir = mlp_result.get("work_dir")
                if not work_dir:
                    # Batch runs store work_dir via V1 update_step_work_dir
                    task_row = self.db.get_task(task_id)
                    work_dir = task_row.get("work_dir") if task_row else None
                self.db.update_task(task_id,
                    status=TaskState.COMPLETED.value,
                    **({"work_dir": work_dir} if work_dir else {}))
                logger.info("Task %s (%s): MLP local execution completed", task_id, resolved_type)
            except Exception as e:
                self.db.update_task(task_id,
                    status=TaskState.FAILED.value,
                    error_message=str(e)[:500],
                )
                asyncio.get_event_loop().create_task(
                    _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "FAILED"})
                )
                logger.error("Task %s (%s): MLP local failed: %s", task_id, resolved_type, e)

        self._track_task(workflow_id, asyncio.get_event_loop().create_task(_run()))

    def _execute_analysis_local_task(
        self, workflow_id: str, task: dict, resolved_type: str, params: dict,
    ) -> None:
        """Execute analysis nodes locally (surface_energy, adsorption_energy, etc.)."""
        task_id = task["id"]
        self.db.update_task(task_id, status=TaskState.RUNNING.value)
        asyncio.get_event_loop().create_task(
            _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "RUNNING"})
        )

        async def _run() -> None:
            try:
                step_results = self._build_step_results(task_id)

                async def _bcast(wf_id: str, msg: dict) -> None:
                    await _broadcast(wf_id, msg)

                from workflow.engines.analysis import execute_analysis_node
                await execute_analysis_node(
                    workflow_id, task_id, resolved_type, params,
                    [], step_results,
                    type("Config", (), {"execution_mode": "local"})(),
                    _bcast, self._get_parent_ids_for_task,
                )

                # Bridge analysis results into V2 task_results table
                ana_result = step_results.get(task_id, {})
                db_fields: dict[str, Any] = {}
                for struct_key in ("contcar", "structure_json", "structure"):
                    val = ana_result.get(struct_key)
                    if val:
                        db_fields["structure_json"] = _poscar_to_json(val)
                        break
                if ana_result.get("energy") is not None:
                    db_fields["energy"] = ana_result["energy"]
                # Keep all other fields (including work_dir, stdout) for frontend
                _skip = {"energy"}
                extras = {k: v for k, v in ana_result.items() if k not in _skip and v is not None}
                if extras:
                    import json as _json_ana
                    db_fields["outputs_json"] = _json_ana.dumps(extras, default=str)
                if db_fields:
                    self.db.store_result(task_id, workflow_id, **db_fields)

                # Persist work_dir if analysis produced one
                ana_work_dir = ana_result.get("work_dir")
                self.db.update_task(task_id,
                    status=TaskState.COMPLETED.value,
                    **({"work_dir": ana_work_dir} if ana_work_dir else {}))
                asyncio.get_event_loop().create_task(
                    _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "COMPLETED"})
                )
                logger.info("Task %s (%s): analysis execution completed", task_id, resolved_type)
            except Exception as e:
                self.db.update_task(task_id,
                    status=TaskState.FAILED.value,
                    error_message=str(e)[:500],
                )
                asyncio.get_event_loop().create_task(
                    _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "FAILED"})
                )
                logger.error("Task %s (%s): analysis failed: %s", task_id, resolved_type, e)

        self._track_task(workflow_id, asyncio.get_event_loop().create_task(_run()))

    def _execute_v1_local_task(
        self, workflow_id: str, task: dict, resolved_type: str, params: dict,
    ) -> None:
        """Execute V1 local/build nodes via the V1 local executor engine."""
        task_id = task["id"]
        self.db.update_task(task_id, status=TaskState.RUNNING.value)
        asyncio.get_event_loop().create_task(
            _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "RUNNING"})
        )

        async def _run() -> None:
            try:
                step_results = self._build_step_results(task_id)
                import json as _json

                # Read edges from DB for the V1 executor
                edges = []
                parent_links = self.db.get_task_parents(task_id)
                for link in parent_links:
                    edges.append({
                        "source": link["source_task_id"],
                        "target": task_id,
                        "sourceKey": link.get("source_key", "structure"),
                        "targetKey": link.get("target_key", "structure"),
                    })

                async def _bcast(wf_id: str, msg: dict) -> None:
                    await _broadcast(wf_id, msg)

                from workflow.engines.local import execute_local_node
                await execute_local_node(
                    workflow_id, task_id, resolved_type, params,
                    edges, step_results,
                    type("Config", (), {"local_work_dir": ""})(),
                    _bcast, self._get_parent_ids_for_task,
                )

                # Bridge results into V2 task_results table
                v1_result = step_results.get(task_id, {})
                db_fields: dict[str, Any] = {}
                for struct_key in ("contcar", "structure_json", "structure"):
                    val = v1_result.get(struct_key)
                    if val:
                        db_fields["structure_json"] = _poscar_to_json(val)
                        break
                if v1_result.get("energy") is not None:
                    db_fields["energy"] = v1_result["energy"]
                # Keep all fields (structures, _fan_out, work_dir, etc.) for frontend + downstream
                _skip = {"energy"}
                extras = {k: v for k, v in v1_result.items() if k not in _skip and v is not None}
                if extras:
                    db_fields["outputs_json"] = _json.dumps(extras, default=str)
                if db_fields:
                    self.db.store_result(task_id, workflow_id, **db_fields)

                v1_work_dir = v1_result.get("work_dir")
                self.db.update_task(task_id,
                    status=TaskState.COMPLETED.value,
                    **({"work_dir": v1_work_dir} if v1_work_dir else {}))
                asyncio.get_event_loop().create_task(
                    _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "COMPLETED"})
                )
                logger.info("Task %s (%s): V1 local execution completed", task_id, resolved_type)
            except Exception as e:
                self.db.update_task(task_id,
                    status=TaskState.FAILED.value,
                    error_message=str(e)[:500],
                )
                asyncio.get_event_loop().create_task(
                    _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "FAILED"})
                )
                logger.error("Task %s (%s): V1 local failed: %s", task_id, resolved_type, e)

        self._track_task(workflow_id, asyncio.get_event_loop().create_task(_run()))

    def _update_workflow_status(self, workflow_id: str) -> None:
        """Derive workflow status from task states."""
        tasks = self.db.get_all_tasks(workflow_id)
        if not tasks:
            return

        current = self.db.get_workflow(workflow_id)

        # Never override an explicitly-set "draft" status — only the user
        # (via submit_workflow) should transition out of draft.
        if current["status"] == WorkflowState.DRAFT.value:
            return

        states = [TaskState(t["status"]) for t in tasks]
        new_status = WorkflowState.from_task_states(states)

        if current["status"] != new_status.value:
            self.db.update_workflow(workflow_id, status=new_status.value)
            asyncio.get_event_loop().create_task(
                _broadcast(workflow_id, {"type": "workflow_status", "status": new_status.value})
            )
            logger.info("Workflow %s: status → %s", workflow_id, new_status.value)

    async def run_forever(self) -> None:
        """Run the scanner in a loop."""
        logger.info("WorkflowEngine started (poll_interval=%ds)", self.poll_interval)
        while True:
            try:
                await self.scan_cycle()
            except Exception as e:
                logger.error("Scan cycle failed: %s", e, exc_info=True)
            await asyncio.sleep(self.poll_interval)
