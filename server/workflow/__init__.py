"""Workflow package — shared utilities (node_sets, catalysis, engines, presets).

The workflow execution engine lives in catgo.workflow.engine.
This package retains shared infrastructure: node classification constants,
input generators (VASP/CP2K/ORCA/etc.), catalysis analysis, and presets.
"""


def _enable_spglib_exception_api() -> None:
    """Opt in to the non-deprecated spglib exception behavior."""
    try:
        from spglib import error as spglib_error

        spglib_error.OLD_ERROR_HANDLING = False
    except (AttributeError, ImportError):
        pass


_enable_spglib_exception_api()
