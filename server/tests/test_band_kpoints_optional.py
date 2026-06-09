"""Regression tests for band uploads without an accompanying KPOINTS file."""

from types import SimpleNamespace

from catgo.routers.bands import _band_distance, _extract_branches, _extract_tick_info, _kpoint_count


def test_regular_band_structure_without_branches_gets_plot_fallbacks():
    """KPOINTS is optional, so non-line-mode band structures need safe axes."""
    bs = SimpleNamespace(kpoints=[object(), object(), object()])

    assert _kpoint_count(bs) == 3
    assert _band_distance(bs) == [0.0, 1.0, 2.0]
    assert [branch.model_dump() for branch in _extract_branches(bs)] == [
        {"start_index": 0, "end_index": 2, "name": ""}
    ]
    assert _extract_tick_info(bs) == (["1", "3"], [0.0, 2.0])
