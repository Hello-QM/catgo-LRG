import pytest
from catgo.cli.registry import Param, Operation, OpResult, OperationRegistry


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
