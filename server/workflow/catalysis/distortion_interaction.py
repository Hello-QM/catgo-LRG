"""
Distortion–interaction (activation strain) energy decomposition.

For a complex or transition state AB built from fragments A, B, …:

    ΔE_dist,X = E(X at its geometry in AB) − E(X relaxed)
    ΔE_int    = E(AB) − Σ_X E(X at its geometry in AB)
    ΔE        = E(AB) − Σ_X E(X relaxed) = Σ_X ΔE_dist,X + ΔE_int

Several entries (e.g. competing transition states, or points along an IRC
with a ``coordinate``) can be decomposed in one call and compared.

References:
  D. H. Ess, K. N. Houk, J. Am. Chem. Soc. 2007, 129, 10646–10647.
  F. M. Bickelhaupt, K. N. Houk, Angew. Chem. Int. Ed. 2017, 56, 10070–10086.
"""

from __future__ import annotations

from typing import Any

# One Hartree in each supported unit.
_PER_HARTREE: dict[str, float] = {
    "hartree": 1.0,
    "eV": 27.211386245988,
    "kcal/mol": 627.5094740631,
    "kJ/mol": 2625.4996394799,
}

_COLORS = ["#3b82f6", "#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"]
_INT_COLOR = "#16a34a"
_TOTAL_COLOR = "#dc2626"


def _converter(input_unit: str, output_unit: str):
    for u in (input_unit, output_unit):
        if u not in _PER_HARTREE:
            raise ValueError(f"unit must be one of {sorted(_PER_HARTREE)}, got {u!r}")
    factor = _PER_HARTREE[output_unit] / _PER_HARTREE[input_unit]
    return lambda e: e * factor


def compute_distortion_interaction(
    entries: list[dict],
    fragment_references: dict[str, float] | None = None,
    input_unit: str = "hartree",
    output_unit: str = "kcal/mol",
) -> dict[str, Any]:
    """Decompose interaction energies of one or more complexes.

    Parameters
    ----------
    entries:
        ``[{"label", "complex_energy", "coordinate"?, "fragments": [
        {"name", "energy_in_complex", "energy_relaxed"?}, ...]}]``.
        Each entry needs at least two fragments.
    fragment_references:
        ``{fragment name: relaxed energy}``, used for any fragment that has no
        ``energy_relaxed`` of its own (typical when every entry shares the
        same isolated reactants).
    input_unit / output_unit:
        ``hartree``, ``eV``, ``kcal/mol`` or ``kJ/mol``.
    """
    if not entries:
        raise ValueError("at least one entry is required")
    conv = _converter(input_unit, output_unit)
    refs = dict(fragment_references or {})

    results = []
    fragment_names: list[str] = []
    for n, entry in enumerate(entries):
        label = str(entry.get("label") or f"Entry {n + 1}")
        frags = entry.get("fragments") or []
        if len(frags) < 2:
            raise ValueError(f"{label}: at least two fragments are required")
        if entry.get("complex_energy") is None:
            raise ValueError(f"{label}: complex_energy is required")
        e_complex = float(entry["complex_energy"])

        frag_rows = []
        sum_in_complex = 0.0
        sum_relaxed = 0.0
        for k, frag in enumerate(frags):
            name = str(frag.get("name") or f"Fragment {k + 1}")
            if frag.get("energy_in_complex") is None:
                raise ValueError(f"{label}/{name}: energy_in_complex is required")
            e_in = float(frag["energy_in_complex"])
            e_relaxed = frag.get("energy_relaxed")
            if e_relaxed is None:
                e_relaxed = refs.get(name)
            if e_relaxed is None:
                raise ValueError(
                    f"{label}/{name}: energy_relaxed is required (or give it in "
                    "fragment_references)"
                )
            e_relaxed = float(e_relaxed)
            sum_in_complex += e_in
            sum_relaxed += e_relaxed
            frag_rows.append({"name": name, "distortion": conv(e_in - e_relaxed)})
            if name not in fragment_names:
                fragment_names.append(name)

        distortion = sum(f["distortion"] for f in frag_rows)
        interaction = conv(e_complex - sum_in_complex)
        row = {
            "label": label,
            "fragments": frag_rows,
            "distortion": distortion,
            "interaction": interaction,
            "total": conv(e_complex - sum_relaxed),
        }
        if entry.get("coordinate") is not None:
            row["coordinate"] = float(entry["coordinate"])
        results.append(row)

    out: dict[str, Any] = {
        "unit": output_unit,
        "entries": results,
        "plotly_data": _bar_chart(results, fragment_names, output_unit),
    }
    if len(results) >= 2 and all("coordinate" in r for r in results):
        out["profile_plotly_data"] = _profile_chart(results, fragment_names, output_unit)
    return out


def _fragment_value(row: dict, name: str) -> float | None:
    return next((f["distortion"] for f in row["fragments"] if f["name"] == name), None)


def _layout(unit: str, x_title: str | None = None) -> dict:
    layout: dict[str, Any] = {
        "height": 400,
        "paper_bgcolor": "rgba(0,0,0,0)",
        "plot_bgcolor": "rgba(0,0,0,0)",
        "yaxis": {
            "title": {"text": f"Energy ({unit})"},
            "showgrid": True,
            "gridcolor": "rgba(200,200,200,0.6)",
            "zeroline": True,
        },
        "legend": {"orientation": "h", "y": -0.2},
        "margin": {"l": 60, "r": 20, "t": 30, "b": 80},
    }
    if x_title:
        layout["xaxis"] = {"title": {"text": x_title}}
    return layout


def _bar_chart(results: list[dict], fragment_names: list[str], unit: str) -> dict:
    labels = [r["label"] for r in results]
    traces = [
        {
            "type": "bar",
            "name": f"ΔE_dist({name})",
            "x": labels,
            "y": [_fragment_value(r, name) for r in results],
            "marker": {"color": _COLORS[k % len(_COLORS)]},
        }
        for k, name in enumerate(fragment_names)
    ]
    traces.append({
        "type": "bar", "name": "ΔE_int", "x": labels,
        "y": [r["interaction"] for r in results], "marker": {"color": _INT_COLOR},
    })
    traces.append({
        "type": "bar", "name": "ΔE", "x": labels,
        "y": [r["total"] for r in results], "marker": {"color": _TOTAL_COLOR},
    })
    layout = _layout(unit)
    layout["barmode"] = "group"
    return {"traces": traces, "layout": layout, "annotations": []}


def _profile_chart(results: list[dict], fragment_names: list[str], unit: str) -> dict:
    ordered = sorted(results, key=lambda r: r["coordinate"])
    xs = [r["coordinate"] for r in ordered]
    traces = [
        {
            "type": "scatter", "mode": "lines+markers", "name": f"ΔE_dist({name})",
            "x": xs, "y": [_fragment_value(r, name) for r in ordered],
            "line": {"color": _COLORS[k % len(_COLORS)], "dash": "dash"},
        }
        for k, name in enumerate(fragment_names)
    ]
    traces.append({
        "type": "scatter", "mode": "lines+markers", "name": "ΔE_dist (total)",
        "x": xs, "y": [r["distortion"] for r in ordered],
        "line": {"color": "#64748b"},
    })
    traces.append({
        "type": "scatter", "mode": "lines+markers", "name": "ΔE_int",
        "x": xs, "y": [r["interaction"] for r in ordered],
        "line": {"color": _INT_COLOR},
    })
    traces.append({
        "type": "scatter", "mode": "lines+markers", "name": "ΔE",
        "x": xs, "y": [r["total"] for r in ordered],
        "line": {"color": _TOTAL_COLOR, "width": 3},
    })
    return {
        "traces": traces,
        "layout": _layout(unit, "Reaction coordinate"),
        "annotations": [],
    }
