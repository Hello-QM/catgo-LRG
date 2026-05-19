import matplotlib
matplotlib.use("Agg")  # headless, no GUI

from pathlib import Path
from catgo.cli.plotting import PlotSpec, render


def _spec():
    return PlotSpec(
        kind="dos", x=[0.0, 1.0, 2.0],
        series=[("s", [1.0, 2.0, 1.0], {})],
        xlabel="E - E_f (eV)", ylabel="DOS", vlines=[0.0], title="t")


def test_render_writes_png(tmp_path):
    out = tmp_path / "p.png"
    r = render(_spec(), out, edit=False, latex=False)
    assert r == out and out.exists() and out.stat().st_size > 0


def test_render_writes_pdf(tmp_path):
    out = tmp_path / "p.pdf"
    render(_spec(), out, edit=False, latex=False)
    assert out.exists() and out.stat().st_size > 0


def test_missing_matplotlib_raises_operror(tmp_path, monkeypatch):
    import sys, pytest
    from catgo.cli.adapter import OpError
    # simulate matplotlib absent (optional [analyze] extra not installed)
    monkeypatch.setitem(sys.modules, "matplotlib.pyplot", None)
    with pytest.raises(OpError) as ei:
        render(_spec(), tmp_path / "p.png", edit=False, latex=False)
    assert "catgo-engine[analyze]" in str(ei.value)


import os, sys, types
import pytest
from catgo.cli.adapter import OpError


def test_edit_no_display_degrades(monkeypatch, tmp_path):
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    monkeypatch.setattr(sys, "platform", "linux")
    with pytest.raises(OpError) as ei:
        render(_spec(), tmp_path / "p.pdf", edit=True, latex=False)
    assert "--edit" in str(ei.value)


def test_edit_calls_pylustrator_start(monkeypatch, tmp_path):
    monkeypatch.setenv("DISPLAY", ":0")
    calls = {}
    fake = types.ModuleType("pylustrator")
    fake.start = lambda: calls.setdefault("start", True)
    monkeypatch.setitem(sys.modules, "pylustrator", fake)
    import matplotlib.pyplot as plt
    monkeypatch.setattr(plt, "show", lambda *a, **k: calls.setdefault("show", True))
    out = render(_spec(), tmp_path / "p.pdf", edit=True, latex=False)
    assert calls.get("start") and calls.get("show")
    assert out == tmp_path / "p.pdf"


def test_edit_pylustrator_missing_raises_operror(monkeypatch, tmp_path):
    monkeypatch.setenv("DISPLAY", ":0")
    monkeypatch.setitem(sys.modules, "pylustrator", None)  # import -> ImportError
    with pytest.raises(OpError) as ei:
        render(_spec(), tmp_path / "p.pdf", edit=True, latex=False)
    assert "catgo-engine[analyze]" in str(ei.value)
