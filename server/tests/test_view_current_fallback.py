"""get_current_structure must not surface another panel's structure for an
explicit panel id (that caused CatBot to read a phantom/stale structure).

Fallback is only for the "default" sentinel (callers that don't know the real
frontend panel id).
"""

import sys
from pathlib import Path

import pytest

_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from fastapi import HTTPException  # noqa: E402

from catgo.routers import view_capture  # noqa: E402


def _reset():
    view_capture._panel_structures.clear()


def test_explicit_empty_panel_does_not_borrow_another():
    _reset()
    view_capture._panel_structures["structure-2"] = {"sites": [1, 2, 3]}
    # An explicit, empty panel must NOT return structure-2's data.
    with pytest.raises(HTTPException) as ei:
        view_capture.get_current_structure(panel_id="structure-1")
    assert ei.value.status_code == 404


def test_default_empty_panel_falls_back():
    _reset()
    view_capture._panel_structures["structure-1"] = {"sites": [1, 2, 3]}
    # The "default" sentinel may borrow the real viewer panel.
    assert view_capture.get_current_structure(panel_id="default") == {"sites": [1, 2, 3]}


def test_populated_panel_returns_own():
    _reset()
    view_capture._panel_structures["structure-1"] = {"sites": ["own"]}
    view_capture._panel_structures["structure-2"] = {"sites": ["other"]}
    assert view_capture.get_current_structure(panel_id="structure-1") == {"sites": ["own"]}
