"""Populate the OperationRegistry — the one place ops are registered."""
from __future__ import annotations

from catgo.cli import ops_build, ops_convert
from catgo.cli.registry import Operation, OperationRegistry, Param


def build_registry() -> OperationRegistry:
    reg = OperationRegistry()
    reg.add(Operation(
        name="slab", group="build", summary="bulk -> surface slab",
        params=[
            Param("miller", tuple, help="Miller indices, e.g. 1,1,0"),
            Param("layers", int, default=4, help="number of atomic layers (unit planes)"),
            Param("vacuum", float, default=15.0, help="vacuum size (A)"),
        ],
        handler=ops_build.slab,
    ))
    reg.add(Operation(
        name="supercell", group="build", summary="integer supercell",
        params=[Param("scaling", tuple, help="na,nb,nc e.g. 2,2,1")],
        handler=ops_build.supercell,
    ))
    reg.add(Operation(
        name="convert", group="convert",
        summary="write active structure to another format",
        params=[Param("out", str, help="output path; ext sets format")],
        handler=ops_convert.convert, mutates=False,
    ))
    reg.add(Operation(
        name="inspect", group="convert",
        summary="print composition / symmetry / nearest-neighbor",
        params=[], handler=ops_convert.inspect, mutates=False,
    ))
    return reg
