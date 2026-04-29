"""
Plotly JSON generator for energy diagrams.

Converts reaction pathway data into Plotly-compatible traces, layout, and
annotations.  The visual algorithm mirrors the matplotlib implementation in
``energy_diagram/energydiagram/core.py`` but produces pure JSON dicts
(no matplotlib dependency).

Geometry rules (from the reference code):
  - Horizontal line segments for intermediates
  - Two-piece cubic spline curves for transition states
  - Dashed diagonal lines connecting consecutive non-TS steps
  - Energy labels above each state with anti-overlap adjustment
"""

from __future__ import annotations

from typing import Any

import numpy as np
from scipy.interpolate import CubicSpline

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

_DEFAULT_CONFIG: dict[str, Any] = {
    "base_spacing": 1.0,
    "hline_ratio": 0.3,
    "ts_spacing_ratio": 0.4,
    "vline_ratio": 0.3,
    "line_width": 3,
    "energy_format": ".2f",
    "height": 450,
    "y_label": "Free Energy (eV)",
    "x_label": "Reaction Coordinate",
}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _ts_curve(
    x_start: float,
    x_end: float,
    y_start: float,
    y_mid: float,
    y_end: float,
    n_points: int = 100,
) -> tuple[np.ndarray, np.ndarray]:
    """Return (xs, ys) for a transition-state cubic-spline arch.

    Two piecewise CubicSpline segments joined at the midpoint, each with
    ``bc_type=((1, 0), (1, 0))`` so the curve has zero slope at both
    endpoints and at the peak.
    """
    x_mid = (x_start + x_end) / 2.0
    half = n_points // 2

    sp1 = CubicSpline([x_start, x_mid], [y_start, y_mid],
                       bc_type=((1, 0), (1, 0)))
    sp2 = CubicSpline([x_mid, x_end], [y_mid, y_end],
                       bc_type=((1, 0), (1, 0)))

    x1 = np.linspace(x_start, x_mid, half)
    x2 = np.linspace(x_mid, x_end, n_points - half)

    return np.concatenate([x1, x2]), np.concatenate([sp1(x1), sp2(x2)])


def _resolve_config(config: dict | None) -> dict[str, Any]:
    merged = dict(_DEFAULT_CONFIG)
    if config:
        merged.update(config)
    return merged


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def generate_energy_diagram(
    pathways: list[dict],
    config: dict | None = None,
) -> dict:
    """Generate a Plotly-compatible energy diagram.

    Parameters
    ----------
    pathways:
        List of pathway dicts.  Each contains ``name`` (str), ``color`` (str),
        and ``steps`` – a list of ``{"label": str, "energy": float}`` dicts.
        Transition-state steps must additionally carry ``"is_ts": True``.
    config:
        Optional overrides for the default config keys (see module-level
        ``_DEFAULT_CONFIG``).

    Returns
    -------
    dict with keys ``traces``, ``layout``, ``annotations``.
    """

    cfg = _resolve_config(config)

    base_spacing: float = cfg["base_spacing"]
    hline_ratio: float = cfg["hline_ratio"]
    ts_spacing_ratio: float = cfg["ts_spacing_ratio"]
    vline_ratio: float = cfg["vline_ratio"]
    line_width: float = cfg["line_width"]
    energy_fmt: str = cfg["energy_format"]
    height: int = cfg["height"]

    hline_len = base_spacing * hline_ratio
    ts_space = base_spacing * ts_spacing_ratio
    vline_len = base_spacing * vline_ratio

    traces: list[dict] = []
    annotations: list[dict] = []

    # Collect tick info from the first pathway for x-axis labels.
    global_tick_positions: list[float] = []
    global_tick_labels: list[str] = []

    for p_idx, pathway in enumerate(pathways):
        steps = pathway["steps"]
        color = pathway.get("color", "#000000")
        name = pathway.get("name", f"Path {p_idx + 1}")

        # --- bookkeeping for x positions ---
        n_hline = 0
        n_ts = 0
        n_vline = 0

        # Pre-compute x-ranges for every step so we can look ahead / behind.
        x_ranges: list[tuple[float, float]] = []  # (x_start, x_end) per step
        for i, step in enumerate(steps):
            is_ts = step.get("is_ts", False)
            x_start = n_hline * hline_len + n_vline * vline_len + n_ts * ts_space
            if is_ts:
                x_end = x_start + ts_space
                n_ts += 1
            else:
                x_end = x_start + hline_len
                n_hline += 1
                # Decide whether a vline follows this step.
                if i + 1 < len(steps) and not steps[i + 1].get("is_ts", False):
                    n_vline += 1
            x_ranges.append((x_start, x_end))

        # --- 1. Horizontal segments (one trace, null-gap separated) ---
        hline_xs: list[float | None] = []
        hline_ys: list[float | None] = []

        for i, step in enumerate(steps):
            if step.get("is_ts", False):
                continue
            xs, xe = x_ranges[i]
            energy = step["energy"]
            if hline_xs:
                hline_xs.append(None)
                hline_ys.append(None)
            hline_xs.extend([xs, xe])
            hline_ys.extend([energy, energy])

        traces.append({
            "type": "scatter",
            "x": hline_xs,
            "y": hline_ys,
            "mode": "lines",
            "line": {"color": color, "width": line_width},
            "name": name,
            "legendgroup": name,
        })

        # --- 2. Dashed diagonal connectors (one trace, null-gap separated) ---
        conn_xs: list[float | None] = []
        conn_ys: list[float | None] = []

        for i, step in enumerate(steps):
            if step.get("is_ts", False):
                continue
            # Check if the *next* non-TS step is directly adjacent (no TS in between).
            if i + 1 < len(steps) and not steps[i + 1].get("is_ts", False):
                _, xe_curr = x_ranges[i]
                xs_next, _ = x_ranges[i + 1]
                if conn_xs:
                    conn_xs.append(None)
                    conn_ys.append(None)
                conn_xs.extend([xe_curr, xs_next])
                conn_ys.extend([step["energy"], steps[i + 1]["energy"]])

        if conn_xs:
            traces.append({
                "type": "scatter",
                "x": conn_xs,
                "y": conn_ys,
                "mode": "lines",
                "line": {"color": color, "width": line_width, "dash": "dash"},
                "name": name,
                "legendgroup": name,
                "showlegend": False,
            })

        # --- 3. Transition-state spline curves (one trace per TS) ---
        for i, step in enumerate(steps):
            if not step.get("is_ts", False):
                continue
            xs, xe = x_ranges[i]
            y_before = steps[i - 1]["energy"]
            y_mid = step["energy"]
            y_after = steps[i + 1]["energy"]
            curve_x, curve_y = _ts_curve(xs, xe, y_before, y_mid, y_after)
            traces.append({
                "type": "scatter",
                "x": curve_x.tolist(),
                "y": curve_y.tolist(),
                "mode": "lines",
                "line": {"color": color, "width": line_width, "dash": "dash"},
                "name": name,
                "legendgroup": name,
                "showlegend": False,
            })

        # --- 4. Annotations (energy labels) for non-TS steps ---
        for i, step in enumerate(steps):
            if step.get("is_ts", False):
                continue
            xs, xe = x_ranges[i]
            mid_x = (xs + xe) / 2.0
            annotations.append({
                "x": mid_x,
                "y": step["energy"],
                "text": f"{step['energy']:{energy_fmt}}",
                "showarrow": False,
                "yanchor": "bottom",
                "font": {"size": 12},
                # metadata used for anti-overlap; stripped before return
                "_pathway": p_idx,
            })

        # --- 5. Tick labels from the first pathway ---
        if p_idx == 0:
            for i, step in enumerate(steps):
                if step.get("is_ts", False):
                    continue
                xs, xe = x_ranges[i]
                global_tick_positions.append((xs + xe) / 2.0)
                global_tick_labels.append(step["label"])

    # --- Anti-overlap for annotations at the same x ---
    MIN_SPACING = 0.08  # eV

    # Group annotations by x position (float tolerance via rounding).
    from collections import defaultdict
    groups: dict[float, list[dict]] = defaultdict(list)
    for ann in annotations:
        key = round(ann["x"], 6)
        groups[key].append(ann)

    for _x, group in groups.items():
        group.sort(key=lambda a: a["y"])
        for k in range(1, len(group)):
            prev_y = group[k - 1]["y"]
            curr_y = group[k]["y"]
            if curr_y - prev_y < MIN_SPACING:
                group[k]["y"] = prev_y + MIN_SPACING

    # Strip internal metadata from annotations.
    for ann in annotations:
        ann.pop("_pathway", None)

    # --- Layout ---
    layout: dict[str, Any] = {
        "height": height,
        "paper_bgcolor": "rgba(0,0,0,0)",
        "plot_bgcolor": "rgba(0,0,0,0)",
        "xaxis": {
            "tickvals": global_tick_positions,
            "ticktext": global_tick_labels,
            "tickangle": 0,
            "showline": False,
            "title": {"text": cfg["x_label"]},
        },
        "yaxis": {
            "showgrid": True,
            "gridcolor": "rgba(200,200,200,0.6)",
            "gridwidth": 1,
            "title": {"text": cfg["y_label"]},
        },
        "legend": {
            "x": 1,
            "y": 1,
            "xanchor": "right",
            "yanchor": "top",
        },
        "margin": {"l": 60, "r": 20, "t": 30, "b": 60},
    }

    return {
        "traces": traces,
        "layout": layout,
        "annotations": annotations,
    }
