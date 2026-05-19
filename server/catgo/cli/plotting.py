"""Publication plotting for analyze ops.

Static baseline uses SciencePlots rcParams. `--edit` lazily starts
pylustrator (GUI, writes edits back as reproducible matplotlib code).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from catgo.cli.adapter import OpError


@dataclass
class PlotSpec:
    kind: str                       # "dos" | "band" | "cohp"
    x: list
    series: list                    # list[(label, y, style_dict)]
    xlabel: str
    ylabel: str
    vlines: list = field(default_factory=list)
    title: str = ""


def _apply_style(latex: bool) -> None:
    import matplotlib.pyplot as plt
    try:
        import scienceplots  # noqa: F401  (registers styles)
        plt.style.use(["science"] if latex else ["science", "no-latex"])
    except Exception:  # noqa: BLE001 — scienceplots optional/registration
        plt.rcParams.update({"figure.dpi": 300, "font.size": 9})


def _build_figure(spec: PlotSpec):
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(3.3, 2.5))
    for label, y, style in spec.series:
        ax.plot(spec.x, y, label=label, **(style or {}))
    for vx in spec.vlines:
        ax.axvline(vx, color="0.5", lw=0.6, ls="--")
    ax.set_xlabel(spec.xlabel)
    ax.set_ylabel(spec.ylabel)
    if spec.title:
        ax.set_title(spec.title)
    if any(lbl for lbl, _, _ in spec.series):
        ax.legend(frameon=False, fontsize=7)
    fig.tight_layout()
    return fig


def render(spec: PlotSpec, out, edit: bool, latex: bool) -> Path:
    out = Path(out)
    _apply_style(latex)
    if edit:
        return _render_edit(spec, out, latex)
    import matplotlib.pyplot as plt
    fig = _build_figure(spec)
    fig.savefig(str(out), dpi=300, bbox_inches="tight")
    plt.close(fig)
    return out


def _render_edit(spec: PlotSpec, out: Path, latex: bool) -> Path:
    raise OpError("edit mode not yet available")  # implemented in Task 3
