import pytest
from catgo.cli.registry import (
    Param, Operation, OpResult, OperationRegistry, coerce_param,
)


def _noop(session, params):
    return OpResult(ok=True, message="noop")


def test_add_and_get():
    reg = OperationRegistry()
    op = Operation(name="demo", group="build", summary="d",
                    params=[Param("n", int, default=4)], handler=_noop)
    reg.add(op)
    assert reg.get("demo") is op
    assert [o.name for o in reg.by_group("build")] == ["demo"]
    assert "demo" in reg.names()


def test_duplicate_name_rejected():
    reg = OperationRegistry()
    op = Operation(name="demo", group="build", summary="d",
                   params=[], handler=_noop)
    reg.add(op)
    with pytest.raises(ValueError):
        reg.add(op)


def test_param_defaults_and_required():
    p = Param("layers", int, default=4)
    assert p.required is False  # has default → optional
    q = Param("miller", tuple)
    assert q.required is True


def test_all_and_empty_group_and_missing_get():
    reg = OperationRegistry()
    a = Operation(name="a", group="build", summary="", params=[], handler=_noop)
    b = Operation(name="b", group="convert", summary="", params=[], handler=_noop)
    reg.add(a)
    reg.add(b)
    assert reg.all() == [a, b]                 # insertion order preserved
    assert reg.by_group("nope") == []          # empty group
    with pytest.raises(KeyError):
        reg.get("missing")


def test_coerce_param():
    assert coerce_param(Param("m", tuple), "1,1,0") == (1, 1, 0)
    assert coerce_param(Param("m", tuple), "-1,0,1") == (-1, 0, 1)
    assert coerce_param(Param("n", int), "4") == 4
    assert coerce_param(Param("v", float), "15") == 15.0
    with pytest.raises(ValueError):
        coerce_param(Param("m", tuple), "abc")
    with pytest.raises(ValueError):
        coerce_param(Param("n", int), "xx")
