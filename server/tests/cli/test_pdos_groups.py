"""Tests for catgo.cli.pdos_groups — atom + group spec parsing."""
from __future__ import annotations

import pytest


# ============================================================================
# F1 — atom-list parser
# ============================================================================


def test_parse_atoms_single():
    from catgo.cli.pdos_groups import _parse_atom_list
    assert _parse_atom_list("0", nions=4) == [0]


def test_parse_atoms_comma_list():
    from catgo.cli.pdos_groups import _parse_atom_list
    assert _parse_atom_list("0,2,5", nions=10) == [0, 2, 5]


def test_parse_atoms_range():
    from catgo.cli.pdos_groups import _parse_atom_list
    assert _parse_atom_list("0-3", nions=10) == [0, 1, 2, 3]


def test_parse_atoms_mixed_range_and_commas():
    from catgo.cli.pdos_groups import _parse_atom_list
    assert _parse_atom_list("0-3,5,7-8", nions=10) == [0, 1, 2, 3, 5, 7, 8]


def test_parse_atoms_all_keyword():
    from catgo.cli.pdos_groups import _parse_atom_list
    assert _parse_atom_list("all", nions=4) == [0, 1, 2, 3]


def test_parse_atoms_dedup_preserves_order():
    from catgo.cli.pdos_groups import _parse_atom_list
    assert _parse_atom_list("0,0,1,1,3,1", nions=10) == [0, 1, 3]


def test_parse_atoms_whitespace_tolerant():
    from catgo.cli.pdos_groups import _parse_atom_list
    assert _parse_atom_list("  0 , 1-2 ", nions=10) == [0, 1, 2]


def test_parse_atoms_empty_raises():
    from catgo.cli.pdos_groups import _parse_atom_list
    from catgo.cli.adapter import OpError
    with pytest.raises(OpError):
        _parse_atom_list("", nions=4)


def test_parse_atoms_non_integer_raises():
    from catgo.cli.pdos_groups import _parse_atom_list
    from catgo.cli.adapter import OpError
    with pytest.raises(OpError):
        _parse_atom_list("x", nions=4)


def test_parse_atoms_negative_raises():
    from catgo.cli.pdos_groups import _parse_atom_list
    from catgo.cli.adapter import OpError
    with pytest.raises(OpError):
        _parse_atom_list("-1", nions=4)


def test_parse_atoms_out_of_range_raises():
    from catgo.cli.pdos_groups import _parse_atom_list
    from catgo.cli.adapter import OpError
    with pytest.raises(OpError):
        _parse_atom_list("99", nions=4)


# ============================================================================
# F2 — group-spec parser
# ============================================================================


def test_parse_groups_default_label():
    from catgo.cli.pdos_groups import parse_groups_spec
    groups = parse_groups_spec("0-3:d", nions=10)
    assert groups == [{"atoms": [0, 1, 2, 3], "channels": "d",
                       "label": "d@0-3"}]


def test_parse_groups_explicit_label():
    from catgo.cli.pdos_groups import parse_groups_spec
    groups = parse_groups_spec("0-3:d:Pt-surface", nions=10)
    assert groups[0]["label"] == "Pt-surface"


def test_parse_groups_two_groups_semicolon():
    from catgo.cli.pdos_groups import parse_groups_spec
    groups = parse_groups_spec("0-3:d; 4,5:p", nions=10)
    assert len(groups) == 2
    assert groups[0]["atoms"] == [0, 1, 2, 3]
    assert groups[1]["atoms"] == [4, 5]
    assert groups[0]["channels"] == "d"
    assert groups[1]["channels"] == "p"
    # Default labels keep the textual atoms field (cleaner in plot legends)
    assert groups[0]["label"] == "d@0-3"
    assert groups[1]["label"] == "p@4,5"


def test_parse_groups_trailing_semicolon():
    from catgo.cli.pdos_groups import parse_groups_spec
    groups = parse_groups_spec("0:d; ; ", nions=4)
    assert len(groups) == 1


def test_parse_groups_strips_whitespace():
    from catgo.cli.pdos_groups import parse_groups_spec
    groups = parse_groups_spec("  0-3 : d : Pt ", nions=10)
    assert groups[0]["channels"] == "d"
    assert groups[0]["label"] == "Pt"


def test_parse_groups_all_keyword_per_group():
    from catgo.cli.pdos_groups import parse_groups_spec
    groups = parse_groups_spec("all:s; all:p", nions=3)
    assert groups[0]["atoms"] == [0, 1, 2]
    assert groups[1]["atoms"] == [0, 1, 2]


def test_parse_groups_missing_colon_raises():
    from catgo.cli.pdos_groups import parse_groups_spec
    from catgo.cli.adapter import OpError
    with pytest.raises(OpError) as ei:
        parse_groups_spec("0-3", nions=4)
    assert "atoms:channels" in str(ei.value)


def test_parse_groups_too_many_colons_raises():
    from catgo.cli.pdos_groups import parse_groups_spec
    from catgo.cli.adapter import OpError
    with pytest.raises(OpError):
        parse_groups_spec("0-3:d:label:extra", nions=4)


def test_parse_groups_empty_atoms_raises():
    from catgo.cli.pdos_groups import parse_groups_spec
    from catgo.cli.adapter import OpError
    with pytest.raises(OpError):
        parse_groups_spec(":d", nions=4)


def test_parse_groups_empty_channels_raises():
    from catgo.cli.pdos_groups import parse_groups_spec
    from catgo.cli.adapter import OpError
    with pytest.raises(OpError):
        parse_groups_spec("0-3:", nions=10)


def test_parse_groups_completely_empty_raises():
    from catgo.cli.pdos_groups import parse_groups_spec
    from catgo.cli.adapter import OpError
    with pytest.raises(OpError):
        parse_groups_spec("  ", nions=4)


def test_parse_atoms_reversed_range_raises():
    from catgo.cli.pdos_groups import _parse_atom_list
    from catgo.cli.adapter import OpError
    with pytest.raises(OpError):
        _parse_atom_list("3-1", nions=10)
