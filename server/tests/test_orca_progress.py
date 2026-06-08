"""Tests for pure ORCA stdout-tail progress parsers (#224 Phase 1)."""

from catgo.workflow.engine.orca_progress import get_orca_stage, get_orca_irc_stage


def test_get_orca_stage_returns_latest_marker():
    tail = (
        "SCF ITERATIONS\n"
        "...converged...\n"
        "VIBRATIONAL FREQUENCIES\n"
        "Thermochemistry\n"
    )
    stage = get_orca_stage(tail)
    assert stage == {"stage": "thermochem", "message": "Calculating thermochemistry..."}


def test_get_orca_stage_starting_when_no_markers():
    assert get_orca_stage("nothing useful here") == {
        "stage": "starting",
        "message": "Starting calculation...",
    }


def test_get_orca_irc_stage_hessian_progress():
    tail = (
        "Energy+Gradient Calculation\n"
        "Calculating gradient on displaced geometry   3 (of   18)\n"
    )
    stage = get_orca_irc_stage(tail)
    assert stage == {
        "stage": "irc_hessian",
        "message": "Computing Hessian (3/18)...",
        "hessian_current": 3,
        "hessian_total": 18,
    }


def test_get_orca_irc_stage_forward_steps():
    tail = (
        "FORWARD IRC\n"
        "    0   -100.123456   0.000000   0.001000   0.002000\n"
        "    1   -100.234567   0.111111   0.001500   0.002500\n"
    )
    stage = get_orca_irc_stage(tail)
    assert stage == {
        "stage": "irc_forward",
        "message": "Forward IRC: 2 step(s)",
        "forward_steps": 2,
    }
