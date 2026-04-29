"""Workflow — the main user-facing API for building DAGs."""

from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Callable

from catgo.workflow.db import WorkflowDB
from catgo.workflow.reference import OutputReference
from catgo.workflow.config import load_config


@dataclass
class TaskHandle:
    """Returned by Workflow.add_task(). Provides .output for chaining."""

    task_id: str
    task_type: str

    @property
    def output(self) -> OutputReference:
        return OutputReference(self.task_id)


class WhileLoop:
    """Iterative loop -- repeats children until condition met or max_iterations reached.

    Created via ``wf.while_loop("name", max_iterations=10)``.
    Children added through ``loop.add_task(...)`` get their
    ``parent_task_id`` set to the loop's control task.
    """

    def __init__(
        self,
        workflow: "Workflow",
        name: str,
        max_iterations: int = 10,
        condition_key: str = "converged",
        condition_value: bool = True,
    ):
        self.workflow = workflow
        self.name = name
        self.max_iterations = max_iterations
        self.condition_key = condition_key
        self.condition_value = condition_value
        self._child_ids: list[str] = []

        self.loop_task_id = workflow.db.create_task(
            workflow.workflow_id,
            "__while__",
            name=name,
            params={
                "max_iterations": max_iterations,
                "condition_key": condition_key,
                "condition_value": condition_value,
            },
        )

    def add_task(self, task_type_or_func, **kwargs) -> "TaskHandle":
        """Add a task inside this loop.

        Delegates to ``Workflow.add_task`` and then sets the child's
        ``parent_task_id`` to the loop control task.
        """
        handle = self.workflow.add_task(task_type_or_func, **kwargs)
        self.workflow.db.update_task(handle.task_id, parent_task_id=self.loop_task_id)
        self._child_ids.append(handle.task_id)
        return handle

    def feedback(self, from_output, *, to_task, key: str):
        """Feed output from one child back as input for the next iteration.

        Creates a task_link with link_type='feedback'.
        """
        from_task_id = from_output.task_id if hasattr(from_output, "task_id") else str(from_output)
        to_task_id = to_task.task_id if hasattr(to_task, "task_id") else str(to_task)
        from_key = from_output.key if hasattr(from_output, "key") else "structure"
        self.workflow.db.create_link(
            self.workflow.workflow_id,
            from_task_id,
            to_task_id,
            from_key,
            key,
        )

    @property
    def output(self):
        """Forward to the last child's output."""
        if self._child_ids:
            return OutputReference(self._child_ids[-1])
        return OutputReference(self.loop_task_id)


class Zone:
    """A named group of tasks within a workflow.

    Created via ``wf.zone("name")``.  Children added through
    ``zone.add_task(...)`` automatically get their ``parent_task_id``
    set to the zone's control task.  The zone itself is tracked as a
    ``__zone__`` task and completes when all children complete.
    """

    def __init__(self, workflow: "Workflow", name: str):
        self.workflow = workflow
        self.name = name
        self.zone_task_id = workflow.db.create_task(
            workflow.workflow_id,
            "__zone__",
            name=name,
        )
        self._child_ids: list[str] = []

    def add_task(self, task_type_or_func, **kwargs) -> "TaskHandle":
        """Add a task inside this zone.

        Delegates to ``Workflow.add_task`` and then sets the child's
        ``parent_task_id`` to the zone control task.
        """
        handle = self.workflow.add_task(task_type_or_func, **kwargs)
        self.workflow.db.update_task(handle.task_id, parent_task_id=self.zone_task_id)
        self._child_ids.append(handle.task_id)
        return handle

    @property
    def output(self):
        """Forward to the last child's output."""
        if self._child_ids:
            return OutputReference(self._child_ids[-1])
        return OutputReference(self.zone_task_id)


class Workflow:
    """Build a workflow DAG and submit it for execution.

    Usage:
        wf = Workflow("RuO2 OER")
        opt = wf.add_task(geo_opt, structure=slab.output.structure, ENCUT=520)
        frq = wf.add_task(freq, structure=opt.output.structure)
        wf.submit()
    """

    def __init__(
        self,
        name: str,
        db: WorkflowDB | None = None,
        config: dict | None = None,
    ):
        self.name = name
        self.config = config or {}

        if db is None:
            global_config = load_config()
            db_path = global_config["paths"]["db_path"]
            from pathlib import Path
            db_path = str(Path(db_path).expanduser())
            db = WorkflowDB(db_path)

        self.db = db
        self.workflow_id = db.create_workflow(name, config=self.config)

    def add_task(
        self,
        task_or_type: Callable | str,
        *,
        name: str | None = None,
        system_name: str | None = None,
        **kwargs: Any,
    ) -> TaskHandle:
        """Add a task to the workflow.

        Args:
            task_or_type: A @task-decorated function or a task type string.
            name: Display name for this task.
            system_name: Label for free energy diagrams.
            **kwargs: Task parameters. OutputReference values create links.

        Returns:
            TaskHandle with .output for chaining to downstream tasks.
        """
        # Resolve task type
        if callable(task_or_type) and hasattr(task_or_type, "_catgo_task_type"):
            task_type = task_or_type._catgo_task_type
            defn = task_or_type._catgo_definition
            software = defn.software
        elif isinstance(task_or_type, str):
            task_type = task_or_type
            from catgo.workflow.task_decorator import get_task_definition
            defn = get_task_definition(task_type)
            software = defn.software if defn else None
        else:
            raise TypeError(f"Expected @task-decorated function or type string, got {type(task_or_type)}")

        # Separate OutputReferences from plain params
        params = {}
        references = {}  # target_key -> OutputReference
        for key, value in kwargs.items():
            if OutputReference.is_reference(value):
                references[key] = value
            else:
                params[key] = value

        # Create task in DB
        task_id = self.db.create_task(
            workflow_id=self.workflow_id,
            task_type=task_type,
            name=name,
            params=params,
            software=software,
            system_name=system_name,
        )

        # Create links for OutputReferences
        for target_key, ref in references.items():
            source_key = ref.key or target_key  # default: same key name
            self.db.create_link(
                workflow_id=self.workflow_id,
                source_task_id=ref.task_id,
                target_task_id=task_id,
                source_key=source_key,
                target_key=target_key,
            )

        return TaskHandle(task_id=task_id, task_type=task_type)

    def map_task(
        self,
        task_type_or_func: Callable | str,
        *,
        over: dict,
        **common_kwargs: Any,
    ) -> "MapHandle":
        """Fan-out: create N parallel instances of a task.

        Args:
            task_type_or_func: task type string or @task-decorated function
            over: dict mapping a param name to a list of values
                  e.g. over={"structure": [s1, s2, s3]}
            **common_kwargs: params shared across all instances

        Returns MapHandle with .gather(key) method
        """
        if len(over) != 1:
            raise ValueError("map_task 'over' must have exactly one key")
        map_param, values = next(iter(over.items()))

        # Resolve display name
        if callable(task_type_or_func) and hasattr(task_type_or_func, "_catgo_task_type"):
            display_name = task_type_or_func._catgo_task_type
        elif isinstance(task_type_or_func, str):
            display_name = task_type_or_func
        else:
            display_name = str(task_type_or_func)

        # Create a map controller task
        map_task_id = self.db.create_task(
            self.workflow_id,
            "__map__",
            name=f"map({display_name}, n={len(values)})",
            params={"map_param": map_param, "count": len(values)},
        )

        # Create child tasks
        child_ids = []
        for i, val in enumerate(values):
            kwargs = {**common_kwargs, map_param: val}
            handle = self.add_task(task_type_or_func, **kwargs)
            # Set parent and map_key on the child
            self.db.update_task(handle.task_id, parent_task_id=map_task_id, map_key=str(i))
            child_ids.append(handle.task_id)

        # Mark map controller as MAPPED (it's not a real computation)
        self.db.update_task(map_task_id, status="MAPPED")

        return MapHandle(map_task_id, child_ids, self.db)

    def while_loop(
        self,
        name: str,
        max_iterations: int = 10,
        condition_key: str = "converged",
        condition_value: bool = True,
    ) -> WhileLoop:
        """Create an iterative loop that repeats until condition met.

        Args:
            name: Display name for the loop.
            max_iterations: Maximum number of iterations before forced completion.
            condition_key: Output key to check for convergence (default: "converged").
            condition_value: Value that signals convergence (default: True).

        Returns:
            :class:`WhileLoop` whose ``add_task`` mirrors ``Workflow.add_task``.
        """
        return WhileLoop(
            self, name,
            max_iterations=max_iterations,
            condition_key=condition_key,
            condition_value=condition_value,
        )

    def zone(self, name: str) -> Zone:
        """Create a named task group (Zone).

        Returns a :class:`Zone` whose ``add_task`` method mirrors
        ``Workflow.add_task`` but marks every child with a shared
        ``parent_task_id``.
        """
        return Zone(self, name)

    def submit(self, auto_submit: bool = True) -> str:
        """Mark workflow as ready for execution. Engine picks it up.

        Args:
            auto_submit: If True, HPC tasks skip the PENDING_REVIEW gate
                and go straight to READY. Default True (set to False to
                require user confirmation before HPC submission).
        """
        import json as _json
        # Merge auto_submit into workflow config_json
        try:
            wf = self.db.get_workflow(self.workflow_id)
            existing = _json.loads(wf.get("config_json") or "{}")
        except Exception:
            existing = {}
        existing["auto_submit"] = auto_submit
        self.db.update_workflow(
            self.workflow_id,
            status="running",
            config_json=_json.dumps(existing),
        )
        return self.workflow_id

    def get_dag(self) -> dict:
        """Get the DAG structure (tasks + links)."""
        return self.db.get_dag(self.workflow_id)

    def get_status(self) -> dict:
        """Get workflow status and all task statuses."""
        wf = self.db.get_workflow(self.workflow_id)
        tasks = self.db.get_all_tasks(self.workflow_id)
        return {"workflow": wf, "tasks": tasks}


class MapHandle:
    """Handle for a map operation. Use .gather(key) to collect results."""

    def __init__(self, map_task_id: str, child_ids: list[str], db: WorkflowDB):
        self.map_task_id = map_task_id
        self.child_ids = child_ids
        self.db = db

    def gather(self, output_key: str) -> list:
        """Collect output_key from all children (in order)."""
        results = []
        for cid in self.child_ids:
            result = self.db.get_result(cid)
            results.append(result.get(output_key) if result else None)
        return results
