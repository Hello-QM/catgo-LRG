"""Stateful interactive menu. Operation chosen by name; params prompted.

input_fn/output_fn are injectable for testing (default: builtins).
"""
from __future__ import annotations

from typing import Callable

from catgo.cli.adapter import OpError
from catgo.cli.ops import build_registry
from catgo.cli.registry import coerce_param
from catgo.cli.session import Session, SessionError


class InteractiveShell:
    def __init__(self, session: Session | None = None,
                 input_fn: Callable[[str], str] = input,
                 output_fn: Callable[..., None] = print,
                 no_autostart: bool = False) -> None:
        self.session = session or Session()
        self.reg = build_registry()
        self._in = input_fn
        self._out = output_fn
        self._no_autostart = no_autostart
        # ServerLink.discover() is total: its internal _ping swallows
        # every exception and returns False on failure, so discover()
        # itself returns None rather than raising. Mirror _run_op's
        # call site — no try/except needed.
        from catgo.cli.server_link import ServerLink
        self.session.link = ServerLink.discover()

    def _status(self) -> str:
        s = self.session.structure
        desc = (f"{s.composition.reduced_formula} {s.num_sites} atoms"
                if s is not None else "none")
        return f"[structure: {desc}]"

    def _banner(self) -> None:
        self._out(f"== CatGO CLI ==  {self._status()}")
        self._out(" 0) Load structure")
        # Enumerate groups dynamically from the registry (preserves insertion
        # order so new groups appear after existing ones).
        seen: list = []
        for op in self.reg.all():
            if op.group not in seen:
                seen.append(op.group)
        for grp in seen:
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
            # Shared coercion with the argparse path (dual-form
            # equivalence). Translate bad input into OpError so run()'s
            # error boundary catches it and the loop survives a typo.
            try:
                params[prm.name] = coerce_param(prm, raw)
            except ValueError:
                kind = ("comma-separated numbers" if prm.type is tuple
                        else prm.type.__name__)
                raise OpError(f"{prm.name} expects {kind}, got '{raw}'")
        return params

    def run(self) -> None:
        while True:
            self._banner()
            try:
                choice = self._in("> ").strip()
            except EOFError:        # Ctrl-D at the menu -> graceful exit
                return
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
                    if op.needs_server and self.session.link is None:
                        if self._no_autostart:
                            raise OpError(
                                "--no-autostart: server unreachable; "
                                "start `catgo serve` first")
                        from catgo.cli._autostart import (
                            spawn_daemon_and_wait,
                        )
                        self.session.link = spawn_daemon_and_wait()
                    # Analyze ops read a DFT output file directly (not the
                    # active session structure); argparse takes that as
                    # the positional `input`. From the menu we must prompt
                    # explicitly so the handler has params["input"].
                    pre_params: dict = {}
                    if op.group == "analyze":
                        ip = self._in("input path: ").strip()
                        if not ip:
                            raise OpError(
                                f"{op.name} requires an input file path")
                        pre_params["input"] = ip
                    params = {**pre_params, **self._prompt_params(op)}
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
