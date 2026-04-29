"""Pluggable engine registry — add new software without modifying submitter/collector.

Two registries:
  @register_engine("vasp")     — input generation (INCAR/POSCAR/KPOINTS)
  @register_collector("vasp")  — result collection (read OUTCAR/CONTCAR)

Adding a new software = register two functions, nothing else to change.
"""

from __future__ import annotations
import logging
from typing import Any, Callable, Awaitable

logger = logging.getLogger(__name__)

EngineGenerator = Callable[..., Awaitable[None]]
ResultCollector = Callable[..., Awaitable[dict]]

_ENGINE_REGISTRY: dict[str, EngineGenerator] = {}
_COLLECTOR_REGISTRY: dict[str, ResultCollector] = {}


def register_engine(engine_key: str):
    """Decorator to register an input generator for a software engine."""
    def decorator(func: EngineGenerator) -> EngineGenerator:
        _ENGINE_REGISTRY[engine_key] = func
        return func
    return decorator


def register_collector(engine_key: str):
    """Decorator to register a result collector for a software engine."""
    def decorator(func: ResultCollector) -> ResultCollector:
        _COLLECTOR_REGISTRY[engine_key] = func
        return func
    return decorator


def get_engine_generator(engine_key: str) -> EngineGenerator | None:
    return _ENGINE_REGISTRY.get(engine_key)


def get_result_collector(engine_key: str) -> ResultCollector | None:
    return _COLLECTOR_REGISTRY.get(engine_key)


def list_engines() -> list[str]:
    return list(_ENGINE_REGISTRY.keys())


def list_collectors() -> list[str]:
    return list(_COLLECTOR_REGISTRY.keys())
