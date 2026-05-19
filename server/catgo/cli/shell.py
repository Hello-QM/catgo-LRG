"""Stateful interactive menu. Operation chosen by name; params prompted.

input_fn/output_fn are injectable for testing (default: builtins).
"""
from __future__ import annotations

from typing import Callable

from catgo.cli.adapter import OpError
from catgo.cli.ops import build_registry
from catgo.cli.session import Session, SessionError


class InteractiveShell:
    def __init__(self, session: Session | None = None,
                 input_fn: Callable[[str], str] = input,
                 output_fn: Callable[..., None] = print) -> None:
        self.session = session or Session()
        self.reg = build_registry()
        self._in = input_fn
        self._out = output_fn

    def _status(self) -> str:
        s = self.session.structure
        desc = (f"{s.composition.reduced_formula} {s.num_sites} atoms"
                if s is not None else "none")
        return f"[structure: {desc}]"

    def _banner(self) -> None:
        self._out(f"== CatGO CLI ==  {self._status()}")
        self._out(" 0) Load structure")
        for grp in ("build", "convert"):
            self._out(f" -- {grp} --")
            for op in self.reg.by_group(grp):
                self._out(f"    {op.name}: {op.summary}")
        self._out(" s) Save   u) Undo   p) Print   q) Quit")

    def _prompt_params(self, op) -> dict:
        params: dict = {}
        for prm in op.params:
            shown = f" [{prm.default}]" if prm.default is not None else ""
            raw = self._in(f"{prm.name}{shown}: ").strip()
            if not raw and prm.default is not None:
                params[prm.name] = prm.default
                continue
            if prm.type is tuple:
                params[prm.name] = tuple(
                    int(x) if x.lstrip("-").isdigit() else float(x)
                    for x in raw.split(","))
            else:
                params[prm.name] = prm.type(raw)
        return params

    def run(self) -> None:
        while True:
            self._banner()
            choice = self._in("> ").strip()
            if choice in ("q", "quit"):
                return
            try:
                if choice == "0":
                    self.session.load(self._in("path: ").strip())
                elif choice == "u":
                    self.session.undo()
                elif choice == "s":
                    self.session.save(self._in("out path: ").strip())
                elif choice == "p":
                    self._out(self._status())
                elif choice in self.reg.names():
                    op = self.reg.get(choice)
                    params = self._prompt_params(op)
                    if op.mutates:
                        self.session.push_history()
                    res = op.handler(self.session, params)
                    if res.structure is not None:
                        self.session.structure = res.structure
                    self._out(res.message)
                else:
                    self._out(f"unknown choice: {choice}")
            except (SessionError, OpError) as exc:
                self._out(f"error: {exc}")
