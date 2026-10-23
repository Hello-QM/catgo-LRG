"""
Energetic Span Model (ESM) for catalytic cycles.

Implements the Kozuch–Shaik energetic span model: from the (free) energies of
the intermediates and transition states of one turnover, find the
TOF-determining intermediate (TDI) and transition state (TDTS), the energetic
span δE, the turnover frequency and the degree of TOF control of every state.

    TOF = (k_B T / h) · (1 − e^{ΔG_r/RT}) / Σ_ij e^{(T_i − I_j + δG'_ij)/RT}
    δG'_ij = ΔG_r  if T_i comes before I_j in the cycle, else 0
    δE     = max_ij (T_i − I_j + δG'_ij),   TOF ≈ (k_B T / h) · e^{−δE/RT}

ΔG_r is the reaction energy of one turnover (negative = exergonic). The
denominator form above is the published expression multiplied through by
e^{ΔG_r/RT}, which makes the dominating term equal δE exactly.

References:
  S. Kozuch, S. Shaik, Acc. Chem. Res. 2011, 44, 101–110.
  S. Kozuch, S. Shaik, J. Phys. Chem. A 2008, 112, 6032–6041.
"""

from __future__ import annotations

import math
from typing import Any

# Gas constant / Boltzmann constant per supported energy unit.
_R: dict[str, float] = {
    "eV": 8.617333262e-5,        # eV/K
    "kcal/mol": 1.987204259e-3,  # kcal/(mol·K)
    "kJ/mol": 8.314462618e-3,    # kJ/(mol·K)
}
_KB_SI = 1.380649e-23   # J/K
_H_SI = 6.62607015e-34  # J·s


def _log_sum_exp(values: list[float]) -> float:
    m = max(values)
    return m + math.log(sum(math.exp(v - m) for v in values))


def compute_energetic_span(
    steps: list[dict],
    reaction_energy: float | None = None,
    temperature: float = 298.15,
    unit: str = "eV",
) -> dict[str, Any]:
    """Apply the energetic span model to one catalytic cycle.

    Parameters
    ----------
    steps:
        Ordered states of one turnover, ``{"label", "energy", "is_ts"}``.
        The first state must be an intermediate (catalyst + reactants).
        When ``reaction_energy`` is omitted the last state must be the
        regenerated catalyst + products; it sets ΔG_r = E_last − E_first and
        is not counted as a separate intermediate (it is the next cycle's
        first state).
    reaction_energy:
        ΔG_r of one turnover. When given, every entry of ``steps`` belongs to
        the cycle and the regenerated state is implied.
    temperature:
        Temperature in K.
    unit:
        Energy unit of the inputs and outputs: ``eV``, ``kcal/mol`` or
        ``kJ/mol``.
    """
    if unit not in _R:
        raise ValueError(f"unit must be one of {sorted(_R)}, got {unit!r}")
    if not temperature or temperature <= 0:
        raise ValueError("temperature must be > 0 K")
    if len(steps) < 2:
        raise ValueError("at least two states are required")
    if steps[0].get("is_ts", False):
        raise ValueError("the first state must be an intermediate, not a transition state")

    e0 = float(steps[0]["energy"])
    rel = [
        {
            "label": str(s.get("label", f"S{i}")),
            "energy": float(s["energy"]) - e0,
            "is_ts": bool(s.get("is_ts", False)),
        }
        for i, s in enumerate(steps)
    ]

    if reaction_energy is None:
        if rel[-1]["is_ts"]:
            raise ValueError(
                "the last state must be the regenerated catalyst (an intermediate) "
                "when reaction_energy is not given"
            )
        dGr = rel[-1]["energy"]
        cycle = rel[:-1]
        product_label = rel[-1]["label"]
    else:
        dGr = float(reaction_energy)
        cycle = rel
        product_label = None

    ts_idx = [k for k, s in enumerate(cycle) if s["is_ts"]]
    int_idx = [k for k, s in enumerate(cycle) if not s["is_ts"]]
    if not ts_idx:
        raise ValueError("the cycle needs at least one transition state")

    RT = _R[unit] * temperature
    prefactor = _KB_SI * temperature / _H_SI  # s^-1

    # Effective barrier for every (TS, intermediate) pair.
    pair: dict[tuple[int, int], float] = {}
    for i in ts_idx:
        for j in int_idx:
            pair[(i, j)] = cycle[i]["energy"] - cycle[j]["energy"] + (dGr if i < j else 0.0)

    (tdts, tdi), delta_e = max(pair.items(), key=lambda kv: kv[1])

    log_denom = _log_sum_exp([v / RT for v in pair.values()])
    # 1 − e^{ΔG_r/RT}: positive for exergonic cycles, ≤ 0 otherwise.
    driving = -math.expm1(dGr / RT)
    tof = prefactor * driving * math.exp(-log_denom)
    tof_approx = prefactor * math.exp(-delta_e / RT)

    x_ts = {
        i: math.exp(_log_sum_exp([pair[(i, j)] / RT for j in int_idx]) - log_denom)
        for i in ts_idx
    }
    x_int = {
        j: math.exp(_log_sum_exp([pair[(i, j)] / RT for i in ts_idx]) - log_denom)
        for j in int_idx
    }

    states = []
    for k, s in enumerate(cycle):
        role = "TDTS" if k == tdts else "TDI" if k == tdi else None
        states.append({
            "index": k,
            "label": s["label"],
            "energy": s["energy"],
            "is_ts": s["is_ts"],
            "degree_of_tof_control": x_ts[k] if s["is_ts"] else x_int[k],
            "role": role,
        })

    warnings: list[str] = []
    if dGr >= 0:
        warnings.append(
            "Reaction energy is not negative: the cycle has no driving force, so the "
            "forward TOF is zero or negative."
        )

    return {
        "unit": unit,
        "temperature": temperature,
        "reaction_energy": dGr,
        "energetic_span": delta_e,
        "tdi": {"index": tdi, "label": cycle[tdi]["label"], "energy": cycle[tdi]["energy"]},
        "tdts": {"index": tdts, "label": cycle[tdts]["label"], "energy": cycle[tdts]["energy"]},
        "tdts_before_tdi": tdts < tdi,
        "tof": tof,
        "tof_approx": tof_approx,
        "tof_unit": "s^-1",
        "states": states,
        "product_label": product_label,
        "warnings": warnings,
        "plotly_data": _span_diagram(cycle, dGr, product_label, tdi, tdts, delta_e, unit),
    }


def _span_diagram(
    cycle: list[dict],
    dGr: float,
    product_label: str | None,
    tdi: int,
    tdts: int,
    delta_e: float,
    unit: str,
) -> dict:
    """Energy profile of the cycle with the TDI and TDTS marked."""
    from workflow.catalysis.energy_diagram import generate_energy_diagram, step_x_ranges

    steps = [dict(s) for s in cycle]
    steps.append({"label": product_label or "Cat + P", "energy": dGr, "is_ts": False})
    config = {"y_label": f"Energy ({unit})", "energy_format": ".2f"}
    diagram = generate_energy_diagram(
        [{"name": "Cycle", "color": "#3b82f6", "steps": steps}], config
    )

    x_ranges = step_x_ranges(steps, config)
    marks = []
    for k, tag, color in ((tdi, "TDI", "#16a34a"), (tdts, "TDTS", "#dc2626")):
        xs, xe = x_ranges[k]
        x = (xs + xe) / 2.0
        y = steps[k]["energy"]
        marks.append({"x": x, "y": y, "tag": tag, "color": color})
        diagram["traces"].append({
            "type": "scatter",
            "x": [x],
            "y": [y],
            "mode": "markers",
            "marker": {"color": color, "size": 11, "symbol": "diamond"},
            "name": f"{tag}: {steps[k]['label']}",
        })
        diagram["annotations"].append({
            "x": x,
            "y": y,
            "text": f"<b>{tag}</b>",
            "showarrow": False,
            "yanchor": "top",
            "yshift": -6,
            "font": {"size": 12, "color": color},
        })

    # A dotted guide at the TDI level and a δE arrow up to the TDTS. When the
    # TDTS precedes the TDI the span is measured from the previous cycle's
    # TDI, which sits at I_TDI − ΔG_r.
    tdi_mark, tdts_mark = marks
    base_y = tdi_mark["y"] - (dGr if tdts < tdi else 0.0)
    diagram["traces"].append({
        "type": "scatter",
        "x": [tdi_mark["x"], tdts_mark["x"]],
        "y": [base_y, base_y],
        "mode": "lines",
        "line": {"color": "#94a3b8", "width": 1, "dash": "dot"},
        "showlegend": False,
        "hoverinfo": "skip",
    })
    diagram["annotations"].append({
        "x": tdts_mark["x"],
        "y": tdts_mark["y"],
        "ax": tdts_mark["x"],
        "ay": base_y,
        "xref": "x",
        "yref": "y",
        "axref": "x",
        "ayref": "y",
        "showarrow": True,
        "arrowhead": 2,
        "arrowside": "end+start",
        "arrowcolor": "#94a3b8",
        "text": "",
    })
    diagram["annotations"].append({
        "x": tdts_mark["x"],
        "y": (base_y + tdts_mark["y"]) / 2.0,
        "text": f"δE = {delta_e:.2f}",
        "showarrow": False,
        "xanchor": "left",
        "xshift": 6,
        "font": {"size": 12},
    })
    return diagram
