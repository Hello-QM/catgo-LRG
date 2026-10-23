"""Tests for the energetic span model and distortion-interaction analysis."""
import math

import pytest

KB_EV = 8.617333262e-5
PREFACTOR_298 = 1.380649e-23 * 298.15 / 6.62607015e-34


# ── Energetic span model ──

def test_single_step_cycle_matches_rate_law():
    from workflow.catalysis.energetic_span import compute_energetic_span
    steps = [
        {"label": "Cat", "energy": 0.0},
        {"label": "TS", "energy": 0.8, "is_ts": True},
        {"label": "Cat + P", "energy": -0.5},
    ]
    r = compute_energetic_span(steps)
    kt = KB_EV * 298.15
    expected = PREFACTOR_298 * math.exp(-0.8 / kt) * (1 - math.exp(-0.5 / kt))
    assert r["energetic_span"] == pytest.approx(0.8)
    assert r["reaction_energy"] == pytest.approx(-0.5)
    assert r["tdi"]["label"] == "Cat"
    assert r["tdts"]["label"] == "TS"
    assert r["tof"] == pytest.approx(expected, rel=1e-9)
    assert r["warnings"] == []


def test_tdts_before_tdi_adds_reaction_energy():
    from workflow.catalysis.energetic_span import compute_energetic_span
    steps = [
        {"label": "I0", "energy": 0.0},
        {"label": "T1", "energy": 0.5, "is_ts": True},
        {"label": "I1", "energy": -0.6},
        {"label": "T2", "energy": 0.0, "is_ts": True},
        {"label": "I0'", "energy": -0.3},
    ]
    r = compute_energetic_span(steps)
    # (T1, I1): T1 precedes I1 → 0.5 + 0.6 − 0.3 = 0.8 beats (T2, I1) = 0.6
    assert r["energetic_span"] == pytest.approx(0.8)
    assert r["tdts"]["label"] == "T1"
    assert r["tdi"]["label"] == "I1"
    assert r["tdts_before_tdi"] is True
    roles = {s["label"]: s["role"] for s in r["states"]}
    assert roles == {"I0": None, "T1": "TDTS", "I1": "TDI", "T2": None}


def test_degrees_of_tof_control_sum_to_one():
    from workflow.catalysis.energetic_span import compute_energetic_span
    steps = [
        {"label": "I0", "energy": 0.0},
        {"label": "T1", "energy": 0.7, "is_ts": True},
        {"label": "I1", "energy": -0.2},
        {"label": "T2", "energy": 0.65, "is_ts": True},
        {"label": "I2", "energy": -0.4},
        {"label": "T3", "energy": 0.3, "is_ts": True},
        {"label": "P", "energy": -1.0},
    ]
    r = compute_energetic_span(steps)
    ts = [s["degree_of_tof_control"] for s in r["states"] if s["is_ts"]]
    ints = [s["degree_of_tof_control"] for s in r["states"] if not s["is_ts"]]
    assert sum(ts) == pytest.approx(1.0)
    assert sum(ints) == pytest.approx(1.0)
    # The exact TOF never exceeds the δE estimate.
    assert r["tof"] <= r["tof_approx"]


def test_explicit_reaction_energy_equals_closing_state():
    from workflow.catalysis.energetic_span import compute_energetic_span
    cycle = [
        {"label": "A", "energy": -10.0},
        {"label": "TS1", "energy": -9.1, "is_ts": True},
        {"label": "B", "energy": -10.4},
        {"label": "TS2", "energy": -9.6, "is_ts": True},
    ]
    closed = compute_energetic_span(cycle + [{"label": "A'", "energy": -10.7}])
    explicit = compute_energetic_span(cycle, reaction_energy=-0.7)
    assert explicit["energetic_span"] == pytest.approx(closed["energetic_span"])
    assert explicit["tof"] == pytest.approx(closed["tof"])
    # Energies are reported relative to the first state.
    assert closed["states"][0]["energy"] == 0.0


def test_units_and_temperature():
    from workflow.catalysis.energetic_span import compute_energetic_span
    steps = [
        {"label": "I", "energy": 0.0},
        {"label": "TS", "energy": 20.0, "is_ts": True},
        {"label": "P", "energy": -10.0},
    ]
    r = compute_energetic_span(steps, unit="kcal/mol", temperature=350)
    rt = 1.987204259e-3 * 350
    prefactor = 1.380649e-23 * 350 / 6.62607015e-34
    assert r["tof_approx"] == pytest.approx(prefactor * math.exp(-20.0 / rt))
    assert r["unit"] == "kcal/mol"


def test_endergonic_cycle_warns():
    from workflow.catalysis.energetic_span import compute_energetic_span
    r = compute_energetic_span([
        {"label": "I", "energy": 0.0},
        {"label": "TS", "energy": 0.9, "is_ts": True},
        {"label": "P", "energy": 0.2},
    ])
    assert r["tof"] < 0
    assert r["warnings"]


def test_plot_marks_tdi_and_tdts():
    from workflow.catalysis.energetic_span import compute_energetic_span
    r = compute_energetic_span([
        {"label": "I", "energy": 0.0},
        {"label": "TS", "energy": 0.9, "is_ts": True},
        {"label": "P", "energy": -0.4},
    ])
    plot = r["plotly_data"]
    names = [t.get("name", "") for t in plot["traces"]]
    assert any(n.startswith("TDI") for n in names)
    assert any(n.startswith("TDTS") for n in names)
    assert any("δE" in a.get("text", "") for a in plot["annotations"])


@pytest.mark.parametrize("steps, kwargs", [
    ([{"label": "I", "energy": 0}, {"label": "P", "energy": -1}], {}),
    ([{"label": "T", "energy": 1, "is_ts": True}, {"label": "P", "energy": 0}], {}),
    ([{"label": "I", "energy": 0}, {"label": "T", "energy": 1, "is_ts": True}], {}),
    ([{"label": "I", "energy": 0}, {"label": "T", "energy": 1, "is_ts": True},
      {"label": "P", "energy": -1}], {"unit": "Hartree"}),
    ([{"label": "I", "energy": 0}, {"label": "T", "energy": 1, "is_ts": True},
      {"label": "P", "energy": -1}], {"temperature": 0}),
])
def test_energetic_span_rejects_bad_input(steps, kwargs):
    from workflow.catalysis.energetic_span import compute_energetic_span
    with pytest.raises(ValueError):
        compute_energetic_span(steps, **kwargs)


# ── Distortion–interaction ──

def _entry(label, e_complex, a_in, b_in, coordinate=None):
    entry = {
        "label": label,
        "complex_energy": e_complex,
        "fragments": [
            {"name": "A", "energy_in_complex": a_in},
            {"name": "B", "energy_in_complex": b_in},
        ],
    }
    if coordinate is not None:
        entry["coordinate"] = coordinate
    return entry


def test_distortion_interaction_decomposition():
    from workflow.catalysis.distortion_interaction import compute_distortion_interaction
    entry = _entry("TS", -200.02, -119.99, -79.995)
    entry["fragments"][0]["energy_relaxed"] = -120.0
    entry["fragments"][1]["energy_relaxed"] = -80.0
    r = compute_distortion_interaction([entry])
    row = r["entries"][0]
    ha = 627.5094740631
    assert r["unit"] == "kcal/mol"
    assert row["fragments"][0]["distortion"] == pytest.approx(0.01 * ha)
    assert row["fragments"][1]["distortion"] == pytest.approx(0.005 * ha)
    assert row["distortion"] == pytest.approx(0.015 * ha)
    assert row["interaction"] == pytest.approx(-0.035 * ha)
    assert row["total"] == pytest.approx(-0.02 * ha)
    assert row["total"] == pytest.approx(row["distortion"] + row["interaction"])
    assert "profile_plotly_data" not in r


def test_distortion_interaction_shared_references_and_profile():
    from workflow.catalysis.distortion_interaction import compute_distortion_interaction
    refs = {"A": -120.0, "B": -80.0}
    entries = [
        _entry("IRC 2", -199.99, -119.995, -79.998, coordinate=2.0),
        _entry("IRC 1", -200.00, -119.99, -79.99, coordinate=1.0),
    ]
    r = compute_distortion_interaction(
        entries, fragment_references=refs, input_unit="hartree", output_unit="eV"
    )
    assert r["unit"] == "eV"
    assert r["entries"][0]["total"] == pytest.approx(0.01 * 27.211386245988)
    profile = r["profile_plotly_data"]
    total = next(t for t in profile["traces"] if t["name"] == "ΔE")
    assert total["x"] == [1.0, 2.0]  # sorted by coordinate


def test_distortion_interaction_same_unit_passthrough():
    from workflow.catalysis.distortion_interaction import compute_distortion_interaction
    entry = _entry("C", -5.0, -2.0, -2.5)
    r = compute_distortion_interaction(
        [entry], fragment_references={"A": -2.4, "B": -2.6},
        input_unit="kcal/mol", output_unit="kcal/mol",
    )
    row = r["entries"][0]
    assert row["distortion"] == pytest.approx(0.4 + 0.1)
    assert row["interaction"] == pytest.approx(-0.5)


@pytest.mark.parametrize("entries, kwargs", [
    ([], {}),
    ([{"label": "x", "complex_energy": -1, "fragments": [{"name": "A", "energy_in_complex": -1,
                                                          "energy_relaxed": -1}]}], {}),
    ([_entry("missing refs", -1, -0.5, -0.4)], {}),
    ([_entry("bad unit", -1, -0.5, -0.4)], {"fragment_references": {"A": -0.5, "B": -0.5},
                                             "input_unit": "Ry"}),
])
def test_distortion_interaction_rejects_bad_input(entries, kwargs):
    from workflow.catalysis.distortion_interaction import compute_distortion_interaction
    with pytest.raises(ValueError):
        compute_distortion_interaction(entries, **kwargs)
