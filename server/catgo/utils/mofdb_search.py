"""Wrap the optional mofdb_client (MOFX-DB) for search + structure retrieval.

Pure functions; no FastAPI/pydantic imports. mofdb_client is OPTIONAL, imported
lazily — a missing package raises RuntimeError("...not installed...") which the
router maps to a clear 503. fetch() returns a LAZY generator; we never pass `limit`
to it (its limit path has a PEP-479 StopIteration bug) and never list() it — we
iterate and break at our own cap. Round-trip identity for a single MOF is
(name, database).
"""

from __future__ import annotations

import logging

from pymatgen.core import Structure

logger = logging.getLogger(__name__)


def _fetch():
    """Return mofdb_client.fetch, or raise RuntimeError if the package is absent."""
    import importlib

    try:
        mod = importlib.import_module("mofdb_client")
    except Exception as exc:
        raise RuntimeError(
            "MOFX-DB support not installed (pip install catgo-server[mofsearch])"
        ) from exc
    if mod is None or not hasattr(mod, "fetch"):
        raise RuntimeError(
            "MOFX-DB support not installed (pip install catgo-server[mofsearch])"
        )
    return mod.fetch


def search_mofs(name: str | None, database: str | None, limit: int = 50) -> dict:
    """Search MOFX-DB; return {hits, count}. Caps at `limit` client-side (does NOT
    pass limit to fetch(), whose limit path is buggy)."""
    fetch = _fetch()
    kwargs: dict = {}
    if name:
        kwargs["name"] = name
    if database:
        kwargs["database"] = database

    hits = []
    for mof in fetch(**kwargs):
        elements = [str(e) for e in getattr(mof, "elements", []) or []]
        hits.append(
            {
                "id": int(getattr(mof, "id", 0) or 0),
                "name": str(getattr(mof, "name", "")),
                "database": str(getattr(mof, "database", "")),
                "elements": elements,
                "n_elements": len(elements),
            }
        )
        if len(hits) >= limit:
            break
    return {"hits": hits, "count": len(hits)}


def get_mof_structure(name: str, database: str | None = None) -> tuple[Structure, str]:
    """Re-fetch a single MOF by (name, database) and parse its CIF to a pymatgen
    Structure. (name, database) is the unique round-trip key."""
    fetch = _fetch()
    kwargs: dict = {"name": name}
    if database:
        kwargs["database"] = database

    chosen = None
    for mof in fetch(**kwargs):
        # name is a prefix match in the real API; require an exact name match,
        # and an exact database match when database is given.
        if str(getattr(mof, "name", "")) != name:
            continue
        if database and str(getattr(mof, "database", "")) != database:
            continue
        chosen = mof
        break
    if chosen is None:
        raise LookupError(f"MOF '{name}' ({database or 'any db'}) not found")

    cif = getattr(chosen, "cif", None)
    if not cif:
        raise ValueError(f"MOF '{name}' has no CIF")
    return Structure.from_str(cif, fmt="cif"), str(getattr(chosen, "name", name))
