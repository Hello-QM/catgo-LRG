"""CatGo — Computational Chemistry Workflow Platform."""


def _enable_spglib_exception_api() -> None:
    """Opt in to spglib's forward-compatible exception behavior.

    spglib 2.7 keeps the legacy, warning-emitting behavior by default; 2.8
    flips this default and 3.0 removes it.  Opting in now keeps symmetry and
    slab operations warning-free while preserving successful results.
    """
    try:
        from spglib import error as spglib_error

        spglib_error.OLD_ERROR_HANDLING = False
    except (AttributeError, ImportError):
        pass


_enable_spglib_exception_api()
