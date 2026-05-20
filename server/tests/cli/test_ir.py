"""Tests for catgo.cli.ir — BEC parser + IR spectrum computation."""
from __future__ import annotations

import math
import textwrap

import pytest


# ============================================================================
# E2 — Born effective charges parser
# ============================================================================


_BEC_BLOCK = textwrap.dedent("""\
   BORN EFFECTIVE CHARGES (in e, cummulative output)
   ----------------------------------------------------------------
   ion    1
       1     2.000000  0.100000  0.000000
       2     0.100000  2.000000  0.000000
       3     0.000000  0.000000  1.500000
   ion    2
       1    -2.000000  0.000000  0.000000
       2     0.000000 -2.000000  0.000000
       3     0.000000  0.000000 -1.500000
""")


def test_parse_born_charges_minimal():
    from catgo.cli.ir import parse_born_charges
    born = parse_born_charges(_BEC_BLOCK, n_atoms=2)
    assert born is not None
    assert len(born) == 2
    assert len(born[0]) == 3 and len(born[0][0]) == 3
    assert born[0][0] == [2.0, 0.1, 0.0]
    assert born[1][2] == [0.0, 0.0, -1.5]


def test_parse_born_charges_missing_returns_none():
    from catgo.cli.ir import parse_born_charges
    assert parse_born_charges("nothing relevant here", n_atoms=2) is None


def test_parse_born_charges_truncated_returns_none():
    """Block present but rows are missing -> None (don't silently zero)."""
    from catgo.cli.ir import parse_born_charges
    bad = textwrap.dedent("""\
       BORN EFFECTIVE CHARGES (in e, cummulative output)
       ion    1
           1     2.000000  0.000000  0.000000
           2     0.000000  2.000000  0.000000
    """)  # only 2 rows
    assert parse_born_charges(bad, n_atoms=1) is None


def test_parse_born_charges_two_atoms_but_only_one_block():
    """Asked for 2 atoms, OUTCAR has only 1 -> None."""
    from catgo.cli.ir import parse_born_charges
    half = textwrap.dedent("""\
       BORN EFFECTIVE CHARGES (in e, cummulative output)
       ion    1
           1     2.0  0.0  0.0
           2     0.0  2.0  0.0
           3     0.0  0.0  1.0
    """)
    assert parse_born_charges(half, n_atoms=2) is None
