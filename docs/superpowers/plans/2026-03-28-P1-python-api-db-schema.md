# P1: Python API + DB Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `catgo.workflow` Python package — the foundation for the entire workflow engine refactor. Provides `@task` decorator, `Workflow` class, `OutputReference`, config system, and new DB schema.

**Architecture:** A pure Python package (`server/catgo/workflow/`) with no frontend dependencies. `@task` registers task types in a global registry. `Workflow` builds a DAG and writes it to SQLite via the new schema (workflows, tasks, task_links, task_results tables). Config is loaded from `~/.catgo/config.yaml` with layered overrides.

**Tech Stack:** Python 3.11+, SQLite, PyYAML, pytest

**Spec:** `docs/superpowers/specs/2026-03-28-workflow-engine-refactor-design.md` (Phase 1)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `server/catgo/__init__.py` | Create | Package root |
| `server/catgo/workflow/__init__.py` | Create | Public API exports (`task`, `Workflow`, `OutputReference`) |
| `server/catgo/workflow/task_decorator.py` | Create | `@task` decorator + global task registry |
| `server/catgo/workflow/reference.py` | Create | `OutputReference` class |
| `server/catgo/workflow/workflow.py` | Create | `Workflow` class (DAG construction + submit) |
| `server/catgo/workflow/db.py` | Create | DB schema, migrations, CRUD operations |
| `server/catgo/workflow/config.py` | Create | Layered config loading (YAML + env vars + defaults) |
| `server/catgo/workflow/states.py` | Create | Task/Workflow state enums and transitions |
| `server/catgo/workflow/builtins.py` | Create | Built-in task type registrations (geo_opt, freq, etc.) |
| `server/tests/test_workflow_api.py` | Create | Tests for the full Python API |

---

### Task 1: Config System

The config system must exist first since everything else references it for defaults.

**Files:**
- Create: `server/catgo/__init__.py`
- Create: `server/catgo/workflow/__init__.py`
- Create: `server/catgo/workflow/config.py`
- Test: `server/tests/test_workflow_api.py`

- [ ] **Step 1: Create package structure**

```bash
mkdir -p server/catgo/workflow
touch server/catgo/__init__.py
```

```python
# server/catgo/__init__.py
"""CatGo — Computational Chemistry Workflow Platform."""
```

```python
# server/catgo/workflow/__init__.py
"""CatGo Workflow API."""
```

- [ ] **Step 2: Write config tests**

```python
# server/tests/test_workflow_api.py
import os
import tempfile
import pytest
from catgo.workflow.config import load_config, get_default, resolve_param, DEFAULT_CONFIG


class TestConfig:
    def test_default_config_has_engine_section(self):
        config = load_config(config_path=None)
        assert "engine" in config
        assert "poll_interval" in config["engine"]
        assert isinstance(config["engine"]["poll_interval"], (int, float))

    def test_default_config_has_software_defaults(self):
        config = load_config(config_path=None)
        assert "defaults" in config
        assert "vasp" in config["defaults"]
        assert config["defaults"]["vasp"]["ENCUT"] == 520

    def test_yaml_override(self, tmp_path):
        yaml_file = tmp_path / "config.yaml"
        yaml_file.write_text("engine:\n  poll_interval: 10\n")
        config = load_config(config_path=str(yaml_file))
        assert config["engine"]["poll_interval"] == 10
        # Non-overridden values still have defaults
        assert config["defaults"]["vasp"]["ENCUT"] == 520

    def test_env_var_override(self, monkeypatch):
        monkeypatch.setenv("CATGO_ENGINE_POLL_INTERVAL", "5")
        config = load_config(config_path=None)
        assert config["engine"]["poll_interval"] == 5

    def test_get_default(self):
        config = load_config(config_path=None)
        assert get_default(config, "vasp", "ENCUT") == 520
        assert get_default(config, "vasp_freq", "IBRION") == 5
        assert get_default(config, "gibbs", "temperature") == 298.15

    def test_resolve_param_task_wins(self):
        config = load_config(config_path=None)
        # Task-level param overrides everything
        val = resolve_param("ENCUT", task_params={"ENCUT": 800},
                           workflow_config={}, global_config=config, software="vasp")
        assert val == 800

    def test_resolve_param_workflow_wins_over_global(self):
        config = load_config(config_path=None)
        wf_config = {"defaults": {"vasp": {"ENCUT": 600}}}
        val = resolve_param("ENCUT", task_params={},
                           workflow_config=wf_config, global_config=config, software="vasp")
        assert val == 600

    def test_resolve_param_falls_to_global(self):
        config = load_config(config_path=None)
        val = resolve_param("ENCUT", task_params={},
                           workflow_config={}, global_config=config, software="vasp")
        assert val == 520
```

- [ ] **Step 3: Implement config module**

```python
# server/catgo/workflow/config.py
"""Layered configuration system.

Resolution order (highest priority wins):
  Task params → Workflow config → User config (~/.catgo/config.yaml) → System defaults

Environment variable override: CATGO_ENGINE_POLL_INTERVAL=10
"""

from __future__ import annotations
import copy
import os
from pathlib import Path
from typing import Any

DEFAULT_CONFIG: dict[str, Any] = {
    "engine": {
        "poll_interval": 30,
        "submit_batch_size": 5,
        "max_concurrent_jobs": 20,
        "result_collect_timeout": 300,
    },
    "hpc": {
        "ssh_timeout": 30,
        "ssh_retry_max": 3,
        "ssh_retry_backoff": 10,
        "poll_retry_max": 5,
        "poll_retry_backoff": 60,
        "poll_retry_factor": 2,
    },
    "retry": {
        "max_retries": 3,
        "backoff_base": 60,
        "backoff_factor": 2,
        "max_backoff": 3600,
    },
    "defaults": {
        "vasp": {
            "ENCUT": 520, "EDIFF": 1e-5, "PREC": "Accurate", "ALGO": "Fast",
            "ISMEAR": 0, "SIGMA": 0.05, "LREAL": "Auto", "NELM": 200,
            "ISPIN": 1, "LORBIT": 11, "LWAVE": False, "LCHARG": False, "NCORE": 4,
        },
        "vasp_geo_opt": {
            "ISIF": 2, "NSW": 200, "EDIFFG": -0.02, "IBRION": 2,
        },
        "vasp_freq": {
            "IBRION": 5, "NFREE": 2, "POTIM": 0.015, "LREAL": ".FALSE.", "EDIFF": 1e-6,
        },
        "vasp_single_point": {
            "NSW": 0, "IBRION": -1, "NEDOS": 3001,
        },
        "cp2k": {
            "cutoff": 600, "rel_cutoff": 60, "xc_functional": "PBE", "scf_max_iter": 200,
        },
        "orca": {
            "method": "B3LYP", "basis": "def2-SVP", "charge": 0, "multiplicity": 1,
        },
        "gibbs": {
            "temperature": 298.15, "freq_cutoff": 50, "pressure_atm": 1.0, "phase": "adsorbed",
        },
    },
    "paths": {
        "work_dir_template": "{base_dir}/{workflow_id}/{task_id}",
        "base_dir": "",
        "db_path": "~/.catgo/catgo.db",
        "log_dir": "~/.catgo/logs/",
        "config_dir": "~/.catgo/",
    },
    "logging": {
        "level": "INFO",
        "max_log_size": 10485760,
        "log_rotation": 5,
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    """Merge override into base recursively. Override wins on conflicts."""
    result = copy.deepcopy(base)
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _apply_env_vars(config: dict, prefix: str = "CATGO") -> dict:
    """Override config values from environment variables.

    CATGO_ENGINE_POLL_INTERVAL=10 → config["engine"]["poll_interval"] = 10
    """
    for key, value in os.environ.items():
        if not key.startswith(prefix + "_"):
            continue
        parts = key[len(prefix) + 1:].lower().split("_")
        target = config
        for part in parts[:-1]:
            if part not in target or not isinstance(target[part], dict):
                break
            target = target[part]
        else:
            final_key = parts[-1]
            if final_key in target:
                old = target[final_key]
                if isinstance(old, bool):
                    target[final_key] = value.lower() in ("true", "1", "yes")
                elif isinstance(old, int):
                    target[final_key] = int(value)
                elif isinstance(old, float):
                    target[final_key] = float(value)
                else:
                    target[final_key] = value
    return config


def load_config(config_path: str | None = "auto") -> dict[str, Any]:
    """Load config with layered resolution: defaults → YAML → env vars."""
    config = copy.deepcopy(DEFAULT_CONFIG)

    # Load YAML if exists
    if config_path == "auto":
        config_path = str(Path.home() / ".catgo" / "config.yaml")

    if config_path and Path(config_path).is_file():
        try:
            import yaml
            with open(config_path) as f:
                user_config = yaml.safe_load(f) or {}
            config = _deep_merge(config, user_config)
        except ImportError:
            pass  # yaml not installed, skip
        except Exception:
            pass  # bad yaml, skip

    # Apply environment variable overrides
    config = _apply_env_vars(config)
    return config


def get_default(config: dict, software: str, param: str) -> Any:
    """Get a default parameter value for a software type."""
    defaults = config.get("defaults", {})
    # Check software-specific defaults first
    if software in defaults and param in defaults[software]:
        return defaults[software][param]
    # Check base software defaults (e.g., vasp_freq falls back to vasp)
    base = software.split("_")[0]
    if base in defaults and param in defaults[base]:
        return defaults[base][param]
    return None


def resolve_param(
    param: str,
    task_params: dict,
    workflow_config: dict,
    global_config: dict,
    software: str,
) -> Any:
    """Resolve a parameter with 4-layer priority:
    Task params > Workflow config > User config > System defaults.
    """
    # 1. Task-level
    if param in task_params:
        return task_params[param]
    # 2. Workflow-level
    wf_defaults = workflow_config.get("defaults", {})
    if software in wf_defaults and param in wf_defaults[software]:
        return wf_defaults[software][param]
    base = software.split("_")[0]
    if base in wf_defaults and param in wf_defaults[base]:
        return wf_defaults[base][param]
    # 3+4. Global config (already merged with system defaults)
    return get_default(global_config, software, param)
```

- [ ] **Step 4: Run tests**

```bash
cd server && python -m pytest tests/test_workflow_api.py::TestConfig -v
```

- [ ] **Step 5: Commit**

```bash
git add server/catgo/ server/tests/test_workflow_api.py
git commit -m "feat(P1): config system with layered resolution"
```

---

### Task 2: Task States

**Files:**
- Create: `server/catgo/workflow/states.py`

- [ ] **Step 1: Write states tests**

Add to `server/tests/test_workflow_api.py`:

```python
from catgo.workflow.states import TaskState, WorkflowState


class TestStates:
    def test_task_states_exist(self):
        assert TaskState.WAITING.value == "WAITING"
        assert TaskState.READY.value == "READY"
        assert TaskState.COMPLETED.value == "COMPLETED"
        assert TaskState.FAILED.value == "FAILED"

    def test_is_active(self):
        assert TaskState.RUNNING.is_active
        assert TaskState.SUBMITTED.is_active
        assert not TaskState.COMPLETED.is_active
        assert not TaskState.FAILED.is_active
        assert not TaskState.WAITING.is_active

    def test_is_terminal(self):
        assert TaskState.COMPLETED.is_terminal
        assert TaskState.FAILED.is_terminal
        assert TaskState.CANCELLED.is_terminal
        assert not TaskState.RUNNING.is_terminal
        assert not TaskState.WAITING.is_terminal

    def test_is_retryable(self):
        assert TaskState.REMOTE_ERROR.is_retryable
        assert not TaskState.FAILED.is_retryable
        assert not TaskState.COMPLETED.is_retryable

    def test_workflow_states(self):
        assert WorkflowState.DRAFT.value == "draft"
        assert WorkflowState.RUNNING.value == "running"
        assert WorkflowState.COMPLETED.value == "completed"
```

- [ ] **Step 2: Implement states**

```python
# server/catgo/workflow/states.py
"""Task and Workflow state enums with classification helpers."""

from __future__ import annotations
from enum import Enum


class TaskState(str, Enum):
    """14-state machine for task lifecycle."""

    WAITING = "WAITING"             # Parents not yet completed
    READY = "READY"                 # All parents done, can be picked up
    GENERATING = "GENERATING"       # Creating input files
    UPLOADING = "UPLOADING"         # Transferring files to HPC
    SUBMITTED = "SUBMITTED"         # sbatch done, got job_id
    QUEUED = "QUEUED"               # SLURM PENDING
    RUNNING = "RUNNING"             # SLURM RUNNING
    COMPLETED_REMOTE = "COMPLETED_REMOTE"  # HPC done, results on remote
    COLLECTING = "COLLECTING"       # Reading output files
    COMPLETED = "COMPLETED"         # Results in DB
    FAILED = "FAILED"               # Permanent failure
    REMOTE_ERROR = "REMOTE_ERROR"   # Transient error, retryable
    PAUSED = "PAUSED"               # User paused
    CANCELLED = "CANCELLED"         # User cancelled

    @property
    def is_active(self) -> bool:
        return self in _ACTIVE_STATES

    @property
    def is_terminal(self) -> bool:
        return self in _TERMINAL_STATES

    @property
    def is_retryable(self) -> bool:
        return self == TaskState.REMOTE_ERROR

    @property
    def is_hpc_submitted(self) -> bool:
        return self in _HPC_SUBMITTED_STATES


_ACTIVE_STATES = {
    TaskState.GENERATING, TaskState.UPLOADING,
    TaskState.SUBMITTED, TaskState.QUEUED, TaskState.RUNNING,
    TaskState.COMPLETED_REMOTE, TaskState.COLLECTING,
}

_TERMINAL_STATES = {
    TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED,
}

_HPC_SUBMITTED_STATES = {
    TaskState.SUBMITTED, TaskState.QUEUED, TaskState.RUNNING,
    TaskState.COMPLETED_REMOTE,
}


class WorkflowState(str, Enum):
    """Workflow-level states derived from task states."""

    DRAFT = "draft"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"

    @classmethod
    def from_task_states(cls, states: list[TaskState]) -> WorkflowState:
        """Derive workflow status from its tasks' states."""
        if not states:
            return cls.DRAFT
        state_set = set(states)
        if all(s == TaskState.COMPLETED for s in states):
            return cls.COMPLETED
        if any(s == TaskState.FAILED for s in states):
            return cls.FAILED
        if all(s in (TaskState.WAITING, TaskState.READY) for s in states):
            return cls.DRAFT
        if any(s == TaskState.PAUSED for s in states):
            return cls.PAUSED
        if state_set & _ACTIVE_STATES:
            return cls.RUNNING
        return cls.RUNNING
```

- [ ] **Step 3: Run tests**

```bash
cd server && python -m pytest tests/test_workflow_api.py::TestStates -v
```

- [ ] **Step 4: Commit**

```bash
git add server/catgo/workflow/states.py server/tests/test_workflow_api.py
git commit -m "feat(P1): task and workflow state enums"
```

---

### Task 3: OutputReference

**Files:**
- Create: `server/catgo/workflow/reference.py`

- [ ] **Step 1: Write reference tests**

Add to `server/tests/test_workflow_api.py`:

```python
from catgo.workflow.reference import OutputReference


class TestOutputReference:
    def test_create_bare(self):
        ref = OutputReference("task-123")
        assert ref.task_id == "task-123"
        assert ref.key is None

    def test_attribute_access(self):
        ref = OutputReference("task-123")
        sub = ref.structure
        assert isinstance(sub, OutputReference)
        assert sub.task_id == "task-123"
        assert sub.key == "structure"

    def test_chained_access(self):
        ref = OutputReference("task-123")
        sub = ref.output_data
        assert sub.key == "output_data"

    def test_is_reference(self):
        ref = OutputReference("task-123")
        assert OutputReference.is_reference(ref)
        assert OutputReference.is_reference(ref.structure)
        assert not OutputReference.is_reference("hello")
        assert not OutputReference.is_reference(42)

    def test_repr(self):
        ref = OutputReference("task-123").structure
        assert "task-123" in repr(ref)
        assert "structure" in repr(ref)
```

- [ ] **Step 2: Implement OutputReference**

```python
# server/catgo/workflow/reference.py
"""OutputReference — lazy pointer to a task's future output."""

from __future__ import annotations


class OutputReference:
    """A lazy reference to a not-yet-computed task output.

    Usage:
        ref = OutputReference("task-123")
        ref.structure   → OutputReference("task-123", key="structure")
        ref.energy      → OutputReference("task-123", key="energy")

    When passed as an argument to Workflow.add_task(), the workflow
    detects it and creates a task_link in the DB.
    """

    __slots__ = ("task_id", "key")

    def __init__(self, task_id: str, key: str | None = None):
        object.__setattr__(self, "task_id", task_id)
        object.__setattr__(self, "key", key)

    def __getattr__(self, name: str) -> OutputReference:
        if name.startswith("_"):
            raise AttributeError(name)
        return OutputReference(self.task_id, name)

    def __repr__(self) -> str:
        if self.key:
            return f"OutputReference({self.task_id!r}, key={self.key!r})"
        return f"OutputReference({self.task_id!r})"

    @staticmethod
    def is_reference(obj: object) -> bool:
        return isinstance(obj, OutputReference)
```

- [ ] **Step 3: Run tests**

```bash
cd server && python -m pytest tests/test_workflow_api.py::TestOutputReference -v
```

- [ ] **Step 4: Commit**

```bash
git add server/catgo/workflow/reference.py server/tests/test_workflow_api.py
git commit -m "feat(P1): OutputReference for lazy data dependencies"
```

---

### Task 4: Task Decorator + Registry

**Files:**
- Create: `server/catgo/workflow/task_decorator.py`

- [ ] **Step 1: Write decorator tests**

Add to `server/tests/test_workflow_api.py`:

```python
from catgo.workflow.task_decorator import task, get_task_registry, TaskDefinition


class TestTaskDecorator:
    def test_register_task(self):
        @task(software="vasp", task_type="test_geo_opt", outputs=["structure", "energy"])
        def my_geo_opt(structure, ENCUT=520, **params):
            pass

        registry = get_task_registry()
        assert "test_geo_opt" in registry
        defn = registry["test_geo_opt"]
        assert defn.software == "vasp"
        assert defn.outputs == ["structure", "energy"]

    def test_register_local_task(self):
        @task(task_type="test_local", local=True, outputs=["result"])
        def my_local(x, y):
            return x + y

        registry = get_task_registry()
        defn = registry["test_local"]
        assert defn.local is True
        assert defn.func is not None

    def test_task_type_inferred_from_function_name(self):
        @task(software="vasp", outputs=["structure"])
        def my_custom_task(structure, **params):
            pass

        registry = get_task_registry()
        assert "my_custom_task" in registry

    def test_duplicate_registration_raises(self):
        @task(task_type="dup_test", outputs=["x"])
        def dup1():
            pass

        with pytest.raises(ValueError, match="already registered"):
            @task(task_type="dup_test", outputs=["y"])
            def dup2():
                pass
```

- [ ] **Step 2: Implement task decorator**

```python
# server/catgo/workflow/task_decorator.py
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
```

- [ ] **Step 3: Run tests**

```bash
cd server && python -m pytest tests/test_workflow_api.py::TestTaskDecorator -v
```

- [ ] **Step 4: Commit**

```bash
git add server/catgo/workflow/task_decorator.py server/tests/test_workflow_api.py
git commit -m "feat(P1): @task decorator and global registry"
```

---

### Task 5: DB Schema + CRUD

**Files:**
- Create: `server/catgo/workflow/db.py`

- [ ] **Step 1: Write DB tests**

Add to `server/tests/test_workflow_api.py`:

```python
from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState, WorkflowState


class TestDB:
    @pytest.fixture
    def db(self, tmp_path):
        db_path = str(tmp_path / "test.db")
        return WorkflowDB(db_path)

    def test_create_workflow(self, db):
        wf_id = db.create_workflow("test workflow")
        wf = db.get_workflow(wf_id)
        assert wf["name"] == "test workflow"
        assert wf["status"] == "draft"

    def test_create_task(self, db):
        wf_id = db.create_workflow("test")
        task_id = db.create_task(
            workflow_id=wf_id,
            task_type="geo_opt",
            name="relax *OH",
            params={"ENCUT": 520, "EDIFF": 1e-5},
            software="vasp",
        )
        task = db.get_task(task_id)
        assert task["task_type"] == "geo_opt"
        assert task["status"] == TaskState.WAITING.value
        assert task["software"] == "vasp"

    def test_create_link(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.create_link(wf_id, t1, t2, "structure", "structure")
        links = db.get_task_parents(t2)
        assert len(links) == 1
        assert links[0]["source_task_id"] == t1
        assert links[0]["source_key"] == "structure"

    def test_update_task_status(self, db):
        wf_id = db.create_workflow("test")
        task_id = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(task_id, status=TaskState.READY.value)
        task = db.get_task(task_id)
        assert task["status"] == TaskState.READY.value

    def test_store_and_get_result(self, db):
        wf_id = db.create_workflow("test")
        task_id = db.create_task(wf_id, "geo_opt", params={})
        db.store_result(task_id, wf_id, energy=-42.5, structure_json='{"sites":[]}')
        result = db.get_result(task_id)
        assert result["energy"] == -42.5

    def test_get_tasks_by_status(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.update_task(t1, status=TaskState.READY.value)
        ready = db.get_tasks_by_status(wf_id, TaskState.READY.value)
        assert len(ready) == 1
        assert ready[0]["id"] == t1

    def test_get_workflow_dag(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.create_link(wf_id, t1, t2, "structure", "structure")
        dag = db.get_dag(wf_id)
        assert len(dag["tasks"]) == 2
        assert len(dag["links"]) == 1
```

- [ ] **Step 2: Implement DB module**

```python
# server/catgo/workflow/db.py
"""SQLite database for workflow state persistence."""

from __future__ import annotations
import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _generate_id() -> str:
    return uuid.uuid4().hex[:16]


class WorkflowDB:
    """Thread-safe SQLite wrapper for CatGo workflow data."""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._lock = threading.Lock()
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init_db(self):
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            conn = self._get_conn()
            conn.executescript(_SCHEMA_SQL)
            conn.commit()
            conn.close()

    # ─── Workflows ───

    def create_workflow(self, name: str, config: dict | None = None) -> str:
        wf_id = _generate_id()
        with self._lock:
            conn = self._get_conn()
            conn.execute(
                "INSERT INTO workflows (id, name, status, created_at, updated_at, config_json) VALUES (?, ?, 'draft', ?, ?, ?)",
                (wf_id, name, _now(), _now(), json.dumps(config or {})),
            )
            conn.commit()
            conn.close()
        return wf_id

    def get_workflow(self, wf_id: str) -> dict:
        conn = self._get_conn()
        row = conn.execute("SELECT * FROM workflows WHERE id = ?", (wf_id,)).fetchone()
        conn.close()
        if not row:
            raise KeyError(f"Workflow {wf_id} not found")
        return dict(row)

    def update_workflow(self, wf_id: str, **fields) -> None:
        fields["updated_at"] = _now()
        sets = ", ".join(f"{k} = ?" for k in fields)
        vals = list(fields.values()) + [wf_id]
        with self._lock:
            conn = self._get_conn()
            conn.execute(f"UPDATE workflows SET {sets} WHERE id = ?", vals)
            conn.commit()
            conn.close()

    def list_workflows(self) -> list[dict]:
        conn = self._get_conn()
        rows = conn.execute("SELECT * FROM workflows ORDER BY created_at DESC").fetchall()
        conn.close()
        return [dict(r) for r in rows]

    # ─── Tasks ───

    def create_task(
        self, workflow_id: str, task_type: str, *,
        name: str | None = None, params: dict | None = None,
        software: str | None = None, system_name: str | None = None,
    ) -> str:
        task_id = _generate_id()
        with self._lock:
            conn = self._get_conn()
            conn.execute(
                """INSERT INTO tasks
                   (id, workflow_id, task_type, name, status, params_json, software, system_name, created_at)
                   VALUES (?, ?, ?, ?, 'WAITING', ?, ?, ?, ?)""",
                (task_id, workflow_id, task_type, name, json.dumps(params or {}),
                 software, system_name, _now()),
            )
            conn.commit()
            conn.close()
        return task_id

    def get_task(self, task_id: str) -> dict:
        conn = self._get_conn()
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        conn.close()
        if not row:
            raise KeyError(f"Task {task_id} not found")
        return dict(row)

    def update_task(self, task_id: str, **fields) -> None:
        sets = ", ".join(f"{k} = ?" for k in fields)
        vals = list(fields.values()) + [task_id]
        with self._lock:
            conn = self._get_conn()
            conn.execute(f"UPDATE tasks SET {sets} WHERE id = ?", vals)
            conn.commit()
            conn.close()

    def get_tasks_by_status(self, workflow_id: str, status: str) -> list[dict]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM tasks WHERE workflow_id = ? AND status = ?",
            (workflow_id, status),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def get_all_tasks(self, workflow_id: str) -> list[dict]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM tasks WHERE workflow_id = ? ORDER BY created_at",
            (workflow_id,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    # ─── Links ───

    def create_link(
        self, workflow_id: str,
        source_task_id: str, target_task_id: str,
        source_key: str, target_key: str,
    ) -> None:
        with self._lock:
            conn = self._get_conn()
            conn.execute(
                """INSERT INTO task_links
                   (workflow_id, source_task_id, target_task_id, source_key, target_key)
                   VALUES (?, ?, ?, ?, ?)""",
                (workflow_id, source_task_id, target_task_id, source_key, target_key),
            )
            conn.commit()
            conn.close()

    def get_task_parents(self, task_id: str) -> list[dict]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM task_links WHERE target_task_id = ?", (task_id,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def get_task_children(self, task_id: str) -> list[dict]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM task_links WHERE source_task_id = ?", (task_id,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    # ─── Results ───

    def store_result(self, task_id: str, workflow_id: str, **fields) -> None:
        cols = ["task_id", "workflow_id"] + list(fields.keys())
        placeholders = ", ".join(["?"] * len(cols))
        col_names = ", ".join(cols)
        vals = [task_id, workflow_id] + list(fields.values())
        with self._lock:
            conn = self._get_conn()
            conn.execute(
                f"INSERT OR REPLACE INTO task_results ({col_names}) VALUES ({placeholders})",
                vals,
            )
            conn.commit()
            conn.close()

    def get_result(self, task_id: str) -> dict | None:
        conn = self._get_conn()
        row = conn.execute(
            "SELECT * FROM task_results WHERE task_id = ?", (task_id,),
        ).fetchone()
        conn.close()
        return dict(row) if row else None

    # ─── DAG ───

    def get_dag(self, workflow_id: str) -> dict:
        return {
            "tasks": self.get_all_tasks(workflow_id),
            "links": self._get_all_links(workflow_id),
        }

    def _get_all_links(self, workflow_id: str) -> list[dict]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM task_links WHERE workflow_id = ?", (workflow_id,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'draft',
    created_at TEXT,
    updated_at TEXT,
    config_json TEXT DEFAULT '{}',
    graph_json TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    name TEXT,
    status TEXT DEFAULT 'WAITING',
    params_json TEXT DEFAULT '{}',
    hpc_session_id TEXT,
    hpc_job_id TEXT,
    work_dir TEXT,
    created_at TEXT,
    submitted_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    last_polled_at TEXT,
    error_message TEXT,
    error_type TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    result_json TEXT DEFAULT '{}',
    software TEXT,
    system_name TEXT,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL,
    source_task_id TEXT NOT NULL,
    target_task_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    target_key TEXT NOT NULL,
    FOREIGN KEY (source_task_id) REFERENCES tasks(id),
    FOREIGN KEY (target_task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS task_results (
    task_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    energy REAL,
    structure_json TEXT,
    real_freqs_json TEXT,
    imag_freqs_json TEXT,
    positions_json TEXT,
    masses_json TEXT,
    gibbs REAL,
    zpe REAL,
    ts_correction REAL,
    outputs_json TEXT DEFAULT '{}',
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_task_links_source ON task_links(source_task_id);
CREATE INDEX IF NOT EXISTS idx_task_links_target ON task_links(target_task_id);
"""
```

- [ ] **Step 3: Run tests**

```bash
cd server && python -m pytest tests/test_workflow_api.py::TestDB -v
```

- [ ] **Step 4: Commit**

```bash
git add server/catgo/workflow/db.py server/tests/test_workflow_api.py
git commit -m "feat(P1): SQLite DB schema and CRUD operations"
```

---

### Task 6: Workflow Class

The main user-facing class that ties everything together.

**Files:**
- Create: `server/catgo/workflow/workflow.py`

- [ ] **Step 1: Write Workflow tests**

Add to `server/tests/test_workflow_api.py`:

```python
from catgo.workflow.workflow import Workflow
from catgo.workflow.task_decorator import task
from catgo.workflow.reference import OutputReference
from catgo.workflow.db import WorkflowDB


# Register test task types for this test module
@task(software="vasp", task_type="t_geo_opt", outputs=["structure", "energy"])
def _t_geo_opt(structure, ENCUT=520, **params):
    pass

@task(software="vasp", task_type="t_freq", outputs=["frequencies", "zpe"])
def _t_freq(structure, IBRION=5, **params):
    pass

@task(task_type="t_gibbs", local=True, outputs=["gibbs"])
def _t_gibbs(energy, frequencies, temperature=298.15):
    pass


class TestWorkflow:
    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    def test_create_workflow(self, db):
        wf = Workflow("test", db=db)
        assert wf.name == "test"
        assert wf.workflow_id is not None

    def test_add_task_by_type_string(self, db):
        wf = Workflow("test", db=db)
        handle = wf.add_task("structure_input", structure='{"sites":[]}')
        assert handle.task_id is not None
        assert isinstance(handle.output, OutputReference)

    def test_add_task_by_decorated_function(self, db):
        wf = Workflow("test", db=db)
        handle = wf.add_task(_t_geo_opt, structure="test", ENCUT=600)
        assert handle.task_id is not None
        task = db.get_task(handle.task_id)
        assert task["task_type"] == "t_geo_opt"

    def test_output_reference_creates_link(self, db):
        wf = Workflow("test", db=db)
        opt = wf.add_task(_t_geo_opt, structure="test")
        frq = wf.add_task(_t_freq, structure=opt.output.structure)
        # Check link was created in DB
        parents = db.get_task_parents(frq.task_id)
        assert len(parents) == 1
        assert parents[0]["source_task_id"] == opt.task_id
        assert parents[0]["source_key"] == "structure"
        assert parents[0]["target_key"] == "structure"

    def test_multiple_references(self, db):
        wf = Workflow("test", db=db)
        opt = wf.add_task(_t_geo_opt, structure="test")
        frq = wf.add_task(_t_freq, structure=opt.output.structure)
        gib = wf.add_task(_t_gibbs,
            energy=opt.output.energy,
            frequencies=frq.output.frequencies,
        )
        parents = db.get_task_parents(gib.task_id)
        assert len(parents) == 2
        source_keys = {p["source_key"] for p in parents}
        assert source_keys == {"energy", "frequencies"}

    def test_submit_sets_status(self, db):
        wf = Workflow("test", db=db)
        wf.add_task("structure_input", structure="test")
        wf.submit()
        wf_data = db.get_workflow(wf.workflow_id)
        assert wf_data["status"] == "running"

    def test_dag_structure(self, db):
        wf = Workflow("test", db=db)
        opt = wf.add_task(_t_geo_opt, structure="test", system_name="*OH")
        frq = wf.add_task(_t_freq, structure=opt.output.structure)
        dag = wf.get_dag()
        assert len(dag["tasks"]) == 2
        assert len(dag["links"]) == 1
```

- [ ] **Step 2: Implement Workflow class**

```python
# server/catgo/workflow/workflow.py
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
        references = {}  # target_key → OutputReference
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

    def submit(self) -> str:
        """Mark workflow as ready for execution. Engine picks it up."""
        self.db.update_workflow(self.workflow_id, status="running")
        return self.workflow_id

    def get_dag(self) -> dict:
        """Get the DAG structure (tasks + links)."""
        return self.db.get_dag(self.workflow_id)

    def get_status(self) -> dict:
        """Get workflow status and all task statuses."""
        wf = self.db.get_workflow(self.workflow_id)
        tasks = self.db.get_all_tasks(self.workflow_id)
        return {"workflow": wf, "tasks": tasks}
```

- [ ] **Step 3: Run tests**

```bash
cd server && python -m pytest tests/test_workflow_api.py::TestWorkflow -v
```

- [ ] **Step 4: Commit**

```bash
git add server/catgo/workflow/workflow.py server/tests/test_workflow_api.py
git commit -m "feat(P1): Workflow class with DAG construction and submit"
```

---

### Task 7: Public API Exports + Built-in Task Types

**Files:**
- Modify: `server/catgo/workflow/__init__.py`
- Create: `server/catgo/workflow/builtins.py`

- [ ] **Step 1: Write integration test**

Add to `server/tests/test_workflow_api.py`:

```python
class TestIntegration:
    """Full end-to-end: create workflow with built-in tasks, submit, verify DB."""

    def test_oer_workflow(self, tmp_path):
        from catgo.workflow import task, Workflow
        from catgo.workflow.db import WorkflowDB
        from catgo.workflow.builtins import geo_opt, freq, gibbs_energy

        db = WorkflowDB(str(tmp_path / "test.db"))
        wf = Workflow("RuO2 OER", db=db)

        # Build OER workflow
        slab = wf.add_task("structure_input", structure='{"sites":[]}')
        for ads in ["OH", "O"]:
            opt = wf.add_task(geo_opt,
                structure=slab.output.structure,
                system_name=f"*{ads}",
                ENCUT=520,
            )
            frq = wf.add_task(freq,
                structure=opt.output.structure,
                system_name=f"*{ads}",
            )
            gib = wf.add_task(gibbs_energy,
                energy=opt.output.energy,
                frequencies=frq.output.frequencies,
                system_name=f"*{ads}",
            )

        wf.submit()

        # Verify
        dag = wf.get_dag()
        assert len(dag["tasks"]) == 7  # 1 slab + 2*(opt+freq+gibbs)
        assert len(dag["links"]) == 6  # 2*(slab→opt.structure, opt→freq.structure) + 2*(opt→gibbs.energy) - wait
        # Actually: slab→opt1, slab→opt2, opt1→frq1, opt2→frq2, opt1→gib1(energy), frq1→gib1(freq), opt2→gib2, frq2→gib2
        assert len(dag["links"]) == 8

        status = wf.get_status()
        assert status["workflow"]["status"] == "running"
        assert all(t["status"] == "WAITING" for t in status["tasks"])
```

- [ ] **Step 2: Create builtins module**

```python
# server/catgo/workflow/builtins.py
"""Built-in task type definitions for CatGo.

Import this module to register all standard task types:
    from catgo.workflow.builtins import geo_opt, freq, gibbs_energy
"""

from catgo.workflow.task_decorator import task


# ─── Input ───

@task(task_type="structure_input", local=True, outputs=["structure"])
def structure_input(structure, **params):
    """Pass-through: provides a structure to the workflow."""
    return {"structure": structure}


@task(task_type="structure_list_input", local=True, outputs=["structures"])
def structure_list_input(structures, **params):
    return {"structures": structures}


# ─── Build ───

@task(task_type="slab_gen", local=True, outputs=["structure"])
def slab_gen(structure, miller=(1, 1, 0), layers=4, vacuum=15.0, **params):
    pass  # Implemented by engine using pymatgen/WASM


@task(task_type="adsorbate_place", local=True, outputs=["structure"])
def adsorbate_place(structure, species="OH", site="all", height=2.0, **params):
    pass


# ─── Calculation (HPC) ───

@task(software="vasp", task_type="geo_opt", outputs=["structure", "energy"])
def geo_opt(structure, ENCUT=520, EDIFF=1e-5, NSW=200, ISIF=2, IBRION=2,
            EDIFFG=-0.02, system_name="", **params):
    pass


@task(software="vasp", task_type="single_point", outputs=["structure", "energy"])
def single_point(structure, ENCUT=520, EDIFF=1e-5, NSW=0, IBRION=-1,
                 system_name="", **params):
    pass


@task(software="vasp", task_type="freq", outputs=["frequencies", "zpe"])
def freq(structure, ENCUT=520, EDIFF=1e-6, IBRION=5, NFREE=2, POTIM=0.015,
         freeze_mode="none", system_name="", **params):
    pass


@task(software="vasp", task_type="cell_opt", outputs=["structure", "energy"])
def cell_opt(structure, ENCUT=520, EDIFF=1e-5, NSW=200, ISIF=3,
             system_name="", **params):
    pass


@task(software="vasp", task_type="md", outputs=["trajectory", "energy"])
def md(structure, ENCUT=520, NSW=1000, IBRION=0, POTIM=1.0,
       TEBEG=300, system_name="", **params):
    pass


# ─── Analysis (Local) ───

@task(task_type="gibbs_energy", local=True, outputs=["gibbs", "zpe"])
def gibbs_energy(energy, frequencies, phase="adsorbed", temperature=298.15,
                 freq_cutoff=50, pressure_atm=1.0, system_name="", **params):
    """Compute Gibbs free energy: G = E_DFT + ZPE - TS."""
    pass  # Implemented in engine using gibbs_calculator


@task(task_type="free_energy_diagram", local=True, outputs=["plotly_data"])
def free_energy_diagram(gibbs_values=None, step_order=None, **params):
    pass


@task(task_type="dos_analysis", local=True, outputs=["dos_data"])
def dos_analysis(data, d_band=True, **params):
    pass


@task(task_type="charge_analysis", local=True, outputs=["charges"])
def charge_analysis(data, method="bader", **params):
    pass
```

- [ ] **Step 3: Update public API exports**

```python
# server/catgo/workflow/__init__.py
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
```

- [ ] **Step 4: Run all tests**

```bash
cd server && python -m pytest tests/test_workflow_api.py -v
```

- [ ] **Step 5: Commit**

```bash
git add server/catgo/ server/tests/test_workflow_api.py
git commit -m "feat(P1): built-in task types and public API exports"
```
