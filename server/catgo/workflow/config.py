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

    Strategy: try progressively joining remaining parts with '_' to match
    actual config keys (handles multi-word keys like poll_interval).
    """
    for key, value in os.environ.items():
        if not key.startswith(prefix + "_"):
            continue
        parts = key[len(prefix) + 1:].lower().split("_")
        _set_nested(config, parts, value)
    return config


def _set_nested(config: dict, parts: list[str], value: str) -> bool:
    """Try to set a value in a nested dict using underscore-separated parts.

    For parts ["engine", "poll", "interval"], tries:
      config["engine_poll_interval"], config["engine"]["poll_interval"],
      config["engine"]["poll"]["interval"]
    """
    # Try joining all parts as a single key at this level
    full_key = "_".join(parts)
    if full_key in config and not isinstance(config[full_key], dict):
        config[full_key] = _coerce(config[full_key], value)
        return True

    # Try splitting: first N parts as section key, rest as nested
    for i in range(1, len(parts)):
        section_key = "_".join(parts[:i])
        if section_key in config and isinstance(config[section_key], dict):
            if _set_nested(config[section_key], parts[i:], value):
                return True

    return False


def _coerce(old: Any, value: str) -> Any:
    """Coerce a string env var value to match the type of the existing value."""
    if isinstance(old, bool):
        return value.lower() in ("true", "1", "yes")
    if isinstance(old, int):
        return int(value)
    if isinstance(old, float):
        return float(value)
    return value


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
