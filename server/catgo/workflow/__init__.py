"""CatGo Workflow API.

Usage:
    from catgo.workflow import Workflow, task
    from catgo.workflow.builtins import geo_opt, freq, gibbs_energy

    wf = Workflow("My Workflow")
    opt = wf.add_task(geo_opt, structure=slab.output.structure, ENCUT=520)
    frq = wf.add_task(freq, structure=opt.output.structure)
    wf.submit()
"""

from catgo.workflow.task_decorator import task, get_task_registry, get_task_definition
from catgo.workflow.workflow import Workflow, TaskHandle
from catgo.workflow.reference import OutputReference
from catgo.workflow.states import TaskState, WorkflowState
from catgo.workflow.config import load_config, get_default, resolve_param
from catgo.workflow.db import WorkflowDB

# Import builtins to trigger @task registration of all builtin task types
import catgo.workflow.builtins as _builtins  # noqa: F401

__all__ = [
    "task",
    "Workflow",
    "TaskHandle",
    "OutputReference",
    "TaskState",
    "WorkflowState",
    "WorkflowDB",
    "load_config",
    "get_default",
    "resolve_param",
    "get_task_registry",
    "get_task_definition",
]
