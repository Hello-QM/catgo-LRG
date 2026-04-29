"""DeclarativeEngineRuntime: loads YAML engine specs, renders Jinja2 templates,
resolves calc types, and exports frontend params.
"""
from __future__ import annotations

import importlib.util
import logging
from pathlib import Path
from typing import Any

from workflow.engine_defs.schema import EngineSpec, validate_engine_spec

logger = logging.getLogger(__name__)

ENGINE_DEFS_DIR = Path(__file__).parent / "engine_defs"
TEMPLATES_DIR = Path(__file__).parent / "templates"

_RUNTIME_REGISTRY: dict[str, "DeclarativeEngineRuntime"] = {}


# ---------------------------------------------------------------------------
# Runtime class
# ---------------------------------------------------------------------------

class DeclarativeEngineRuntime:
    """Runtime wrapper around a validated EngineSpec."""

    def __init__(self, raw: dict[str, Any]) -> None:
        self.spec: EngineSpec = validate_engine_spec(raw)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def resolve_calc_type(self, calc_type: str) -> str | None:
        """Look up calc_type in the spec's calc_type_mapping.

        Returns the mapped legacy node type, or None if not found.
        """
        return self.spec.calc_type_mapping.get(calc_type)

    def to_frontend_params(self) -> list[dict[str, Any]]:
        """Export params as frontend-compatible dicts.

        Any show_if condition that references 'calc_type' is rewritten into
        an AND-list that also gates on the engine's 'software' key, so the
        frontend's unified parameter panel can hide/show params correctly.
        """
        result: list[dict[str, Any]] = []
        for param in self.spec.params:
            d: dict[str, Any] = {
                "key": param.key,
                "label": param.label,
                "type": param.type,
            }
            if param.default is not None:
                d["default"] = param.default
            if param.options is not None:
                d["options"] = param.options
            if param.unit is not None:
                d["unit"] = param.unit
            if param.range is not None:
                d["range"] = param.range
            if param.help is not None:
                d["help"] = param.help
            if param.group is not None:
                d["group"] = param.group

            show_if = param.show_if
            software_cond = {
                "key": "software",
                "values": [self.spec.engine],
            }

            if show_if is not None:
                # Normalise to a list so we can always append conditions.
                if isinstance(show_if, list):
                    conditions: list[dict[str, Any]] = list(show_if)
                else:
                    conditions = [dict(show_if)]

                # Add a software-gate condition so the unified frontend knows
                # this param only applies when the matching engine is selected.
                already_gated = any(c.get("key") == "software" for c in conditions)
                if not already_gated:
                    conditions.append(software_cond)

                d["show_if"] = conditions
            else:
                # Params without show_if still need a software gate so the
                # unified frontend only shows them when this engine is selected.
                d["show_if"] = software_cond

            result.append(d)
        return result

    async def generate_inputs(
        self,
        hpc: Any,
        work_dir: str,
        node_type: str,
        params: dict[str, Any],
        structure_str: str | None,
        config: dict[str, Any],
        task: Any,
    ) -> None:
        """Render Jinja2 templates, handle structure conversion, upload to HPC.

        Flow:
        1. Run pre_generate hook (async). If the hook populates
           ``params['_generated_files']``, those files are included in the
           upload and skip template/source rendering for matching filenames.
        2. For remaining input_files entries (template or structure source),
           render/convert as before.
        3. Run legacy pre_input hook (sync) and merge any returned files.
        4. Upload all files to HPC.
        """
        from catgo.utils.job_parser import write_remote_files

        # Step 1: pre_generate hook (async, used by ORCA and similar engines)
        pre_generate_hook = self.spec.hooks.get("pre_generate")
        if pre_generate_hook:
            params, structure_str = await _call_hook_async(
                pre_generate_hook, params, structure_str
            )

        # Files provided by the hook take priority
        files: dict[str, str] = dict(params.pop("_generated_files", {}))

        # Step 2: Render templates / convert structures for files not already generated
        for filename, file_spec in self.spec.input_files.items():
            if filename in files:
                # Already produced by the pre_generate hook — skip
                continue
            if file_spec.source == "hook":
                # Explicitly delegated to hook; nothing to do here
                continue
            if file_spec.template:
                content = _render_template(
                    file_spec.template, params, structure_str, node_type
                )
                files[filename] = content
            elif file_spec.source == "structure" and structure_str is not None:
                fmt = (file_spec.format or "poscar").lower()
                files[filename] = _convert_structure(structure_str, fmt)

        # Step 3: Legacy pre_input hook (sync)
        pre_hook = self.spec.hooks.get("pre_input")
        if pre_hook:
            hook_result = _call_hook(pre_hook, params, structure_str)
            if isinstance(hook_result, dict):
                files.update(hook_result)

        remote_files = {f"{work_dir}/{k}": v for k, v in files.items()}
        await write_remote_files(hpc.conn, remote_files)

    def to_dict(self) -> dict[str, Any]:
        """Serialize spec for API responses."""
        spec = self.spec
        return {
            "engine": spec.engine,
            "label": spec.label,
            "description": spec.description,
            "supported_calc_types": spec.supported_calc_types,
            "params": self.to_frontend_params(),
            "run_commands": spec.run_commands,
            "output_files": spec.output_files,
            "environment": spec.environment,
            "safety": spec.safety,
            "calc_type_mapping": spec.calc_type_mapping,
        }


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------

def _render_template(
    template_path: str,
    params: dict[str, Any],
    structure_str: str | None,
    node_type: str,
) -> str:
    """Render a Jinja2 template from TEMPLATES_DIR."""
    try:
        from jinja2 import Environment, FileSystemLoader, StrictUndefined
    except ImportError as exc:
        raise RuntimeError("jinja2 is required for template rendering") from exc

    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES_DIR)),
        undefined=StrictUndefined,
        autoescape=False,
    )
    template = env.get_template(template_path)
    return template.render(
        params=params,
        structure_str=structure_str,
        node_type=node_type,
    )


def _convert_structure(structure_str: str, fmt: str) -> str:
    """Convert a structure string to the requested format.

    Supports: poscar (via ensure_poscar), and other formats via pymatgen.
    """
    if fmt == "poscar":
        from workflow.engines import ensure_poscar
        return ensure_poscar(structure_str)

    # Generic pymatgen conversion
    import json
    from pymatgen.core import Structure

    try:
        struct = Structure.from_str(structure_str, fmt="poscar")
    except Exception:
        struct = Structure.from_dict(json.loads(structure_str))

    return struct.to(fmt=fmt)


def _call_hook(hook_path: str, params: dict[str, Any], structure_str: str | None) -> Any:
    """Import a Python module by dotted path and call its ``run`` function.

    hook_path is expected to be a dotted module path optionally suffixed with
    ``:<function_name>``, e.g. ``workflow.hooks.my_hook:run``.
    """
    if ":" in hook_path:
        module_path, func_name = hook_path.rsplit(":", 1)
    else:
        module_path, func_name = hook_path, "run"

    mod = importlib.import_module(module_path)
    func = getattr(mod, func_name)
    return func(params, structure_str)


async def _call_hook_async(
    hook_path: str,
    params: dict[str, Any],
    structure_str: str | None,
) -> tuple[dict[str, Any], str | None]:
    """Import and await an async hook function.

    The hook must be an ``async def`` that accepts ``(params, structure_str)``
    and returns ``(params, structure_str)``.

    hook_path format: ``module.path:function_name``
    """
    import inspect

    if ":" in hook_path:
        module_path, func_name = hook_path.rsplit(":", 1)
    else:
        module_path, func_name = hook_path, "run"

    mod = importlib.import_module(module_path)
    func = getattr(mod, func_name)

    if inspect.iscoroutinefunction(func):
        return await func(params, structure_str)
    # Fallback: call synchronously and wrap result
    result = func(params, structure_str)
    if isinstance(result, tuple) and len(result) == 2:
        return result
    # Legacy hook returning just files dict — return params unchanged
    return params, structure_str


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

def load_engine_def(raw: dict[str, Any]) -> DeclarativeEngineRuntime:
    """Create a DeclarativeEngineRuntime and register it in _RUNTIME_REGISTRY."""
    runtime = DeclarativeEngineRuntime(raw)
    _RUNTIME_REGISTRY[runtime.spec.engine] = runtime
    return runtime


def load_yaml_engine(yaml_path: Path) -> DeclarativeEngineRuntime:
    """Load a YAML engine definition file and register it."""
    try:
        import yaml  # type: ignore[import]
    except ImportError as exc:
        raise RuntimeError("PyYAML is required to load YAML engine definitions") from exc

    with yaml_path.open() as fh:
        raw = yaml.safe_load(fh)
    return load_engine_def(raw)


def load_all_engine_defs() -> list[DeclarativeEngineRuntime]:
    """Scan engine_defs/ and engine_defs/custom/ for YAML specs, load all."""
    runtimes: list[DeclarativeEngineRuntime] = []
    search_dirs = [ENGINE_DEFS_DIR, ENGINE_DEFS_DIR / "custom"]

    for search_dir in search_dirs:
        if not search_dir.is_dir():
            continue
        for yaml_path in sorted(search_dir.glob("*.yaml")):
            try:
                runtimes.append(load_yaml_engine(yaml_path))
            except Exception as exc:
                logger.warning("Failed to load engine def %s: %s", yaml_path, exc)
        for yaml_path in sorted(search_dir.glob("*.yml")):
            try:
                runtimes.append(load_yaml_engine(yaml_path))
            except Exception as exc:
                logger.warning("Failed to load engine def %s: %s", yaml_path, exc)

    return runtimes


def get_runtime(engine_key: str) -> "DeclarativeEngineRuntime | None":
    """Look up a runtime by engine key."""
    return _RUNTIME_REGISTRY.get(engine_key)


def all_runtimes() -> list["DeclarativeEngineRuntime"]:
    """Return all registered runtimes."""
    return list(_RUNTIME_REGISTRY.values())


def build_unified_calc_map() -> dict[tuple[str, str], str]:
    """Build combined (calc_type, engine_key) → legacy_node_type map from all runtimes."""
    result: dict[tuple[str, str], str] = {}
    for runtime in _RUNTIME_REGISTRY.values():
        engine_key = runtime.spec.engine
        for calc_type, legacy_type in runtime.spec.calc_type_mapping.items():
            result[(calc_type, engine_key)] = legacy_type
    return result


def build_engine_node_sets() -> dict[str, set[str]]:
    """Build engine_key → {legacy_node_types} map from all runtimes."""
    result: dict[str, set[str]] = {}
    for runtime in _RUNTIME_REGISTRY.values():
        engine_key = runtime.spec.engine
        result[engine_key] = set(runtime.spec.calc_type_mapping.values())
    return result
