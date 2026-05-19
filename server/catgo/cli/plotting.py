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
    hlines: list = field(default_factory=list)
    title: str = ""


def _pyplot():
    """Lazy matplotlib.pyplot, or a clean OpError if the optional
    [analyze] extra is not installed (matplotlib is NOT a core dep)."""
    try:
        import matplotlib.pyplot as plt
    except ImportError as exc:
        raise OpError(
            "matplotlib not installed (needed for analyze plots) — "
            "pip install 'catgo-engine[analyze]'") from exc
    return plt


def _apply_style(latex: bool) -> None:
    plt = _pyplot()
    try:
        import scienceplots  # noqa: F401  (registers styles)
    except ImportError:
        plt.rcParams.update({"figure.dpi": 300, "font.size": 9})
        return
    plt.style.use(["science"] if latex else ["science", "no-latex"])


def _build_figure(spec: PlotSpec):
    plt = _pyplot()
    fig, ax = plt.subplots(figsize=(3.3, 2.5))
    for label, y, style in spec.series:
        ax.plot(spec.x, y, label=label, **(style or {}))
    for vx in spec.vlines:
        ax.axvline(vx, color="0.5", lw=0.6, ls="--")
    for vy in spec.hlines:
        ax.axhline(vy, color="0.5", lw=0.6, ls="--")
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
    plt = _pyplot()
    fig = _build_figure(spec)
    fig.savefig(str(out), dpi=300, bbox_inches="tight")
    plt.close(fig)
    return out


def _has_display() -> bool:
    import os
    import sys
    if sys.platform == "darwin":
        return True
    return bool(os.environ.get("DISPLAY")
                or os.environ.get("WAYLAND_DISPLAY"))


def _render_edit(spec: PlotSpec, out: Path, latex: bool) -> Path:
    if not _has_display():
        raise OpError(
            "no display available for --edit; drop --edit to write a "
            "static publication figure instead")
    try:
        import pylustrator
    except ImportError as exc:
        raise OpError(
            "pylustrator not installed (needed for --edit) — "
            "pip install 'catgo-engine[analyze]'") from exc
    # NOTE: pylustrator.start() monkeypatches plt.figure/plt.show
    # process-wide and is NOT reversible. Acceptable: --edit is a terminal
    # user action; a long-lived shell should run it last.
    pylustrator.start()
    plt = _pyplot()
    _build_figure(spec)   # GUI captures this figure; user edits it
    plt.show()            # blocks in the pylustrator editor
    # Per design §2: the user exports the final figure to `out` from the
    # GUI (pylustrator also writes reproducible code back). We deliberately
    # do NOT write a fresh un-edited baseline to `out` here — that would
    # silently discard the user's interactive edits.
    return out
