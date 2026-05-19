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
