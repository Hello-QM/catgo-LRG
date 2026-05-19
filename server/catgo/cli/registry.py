"""Single source of truth: operations consumed by both argparse and the menu."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from pymatgen.core import Structure


@dataclass
class Param:
    name: str
    type: type
    default: Any = None
    help: str = ""
    choices: Optional[list] = None

    @property
    def required(self) -> bool:
        # P1: a param with no default is required. Known P2 limitation —
        # an optional param whose natural default is None cannot be
        # expressed; introduce an explicit `required` field then.
        return self.default is None


@dataclass
class OpResult:
    ok: bool
    message: str
    structure: Optional[Structure] = None
    artifact: Optional[Path] = None


@dataclass
class Operation:
    name: str
    group: str
    summary: str
    params: list[Param]
    handler: Callable[[Any, dict], OpResult]
    needs_server: bool = False
    mutates: bool = True


class OperationRegistry:
    def __init__(self) -> None:
        self._ops: dict[str, Operation] = {}

    def add(self, op: Operation) -> None:
        if op.name in self._ops:
            raise ValueError(f"duplicate operation: {op.name}")
        self._ops[op.name] = op

    def get(self, name: str) -> Operation:
        return self._ops[name]

    def names(self) -> list[str]:
        return list(self._ops)

    def all(self) -> list[Operation]:
        return list(self._ops.values())

    def by_group(self, group: str) -> list[Operation]:
        return [o for o in self._ops.values() if o.group == group]
