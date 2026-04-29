"""@task decorator and global task registry."""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable

_TASK_REGISTRY: dict[str, TaskDefinition] = {}


@dataclass
class TaskDefinition:
    """Metadata about a registered task type."""
    task_type: str
    software: str | None = None
    outputs: list[str] = field(default_factory=list)
    local: bool = False
    func: Callable | None = None
    default_params: dict[str, Any] = field(default_factory=dict)


def task(
    func: Callable | None = None,
    *,
    task_type: str | None = None,
    software: str | None = None,
    outputs: list[str] | None = None,
    local: bool = False,
):
    """Register a function as a workflow task type.

    Usage:
        @task(software="vasp", task_type="geo_opt", outputs=["structure", "energy"])
        def geo_opt(structure, ENCUT=520, **params):
            pass

        @task(task_type="gibbs_energy", local=True, outputs=["gibbs"])
        def gibbs_energy(energy, frequencies, temperature=298.15):
            return compute_gibbs(energy, frequencies, temperature)
    """
    def decorator(fn: Callable) -> Callable:
        name = task_type or fn.__name__
        if name in _TASK_REGISTRY:
            raise ValueError(
                f"Task type '{name}' already registered "
                f"(by {_TASK_REGISTRY[name].func.__name__ if _TASK_REGISTRY[name].func else 'unknown'})"
            )

        # Extract default params from function signature
        import inspect
        sig = inspect.signature(fn)
        defaults = {}
        for pname, param in sig.parameters.items():
            if param.default is not inspect.Parameter.empty and pname != "params":
                defaults[pname] = param.default

        defn = TaskDefinition(
            task_type=name,
            software=software,
            outputs=outputs or [],
            local=local,
            func=fn if local else None,
            default_params=defaults,
        )
        _TASK_REGISTRY[name] = defn

        # Attach metadata to the function for Workflow.add_task()
        fn._catgo_task_type = name
        fn._catgo_definition = defn
        return fn

    if func is not None:
        return decorator(func)
    return decorator


def get_task_registry() -> dict[str, TaskDefinition]:
    """Get the global task registry (read-only view)."""
    return _TASK_REGISTRY


def get_task_definition(task_type: str) -> TaskDefinition | None:
    """Look up a task definition by type name."""
    return _TASK_REGISTRY.get(task_type)
