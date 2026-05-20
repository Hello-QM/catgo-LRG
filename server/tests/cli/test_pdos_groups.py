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


def test_parse_atoms_reversed_range_raises():
    from catgo.cli.pdos_groups import _parse_atom_list
    from catgo.cli.adapter import OpError
    with pytest.raises(OpError):
        _parse_atom_list("3-1", nions=10)
