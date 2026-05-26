"""Wrap the optional mofdb_client (MOFX-DB) for search + structure retrieval.

Pure functions; no FastAPI/pydantic imports. mofdb_client is OPTIONAL, imported
lazily — a missing package raises RuntimeError("...not installed...") which the
router maps to a clear 503. fetch() returns a LAZY generator; we never pass `limit`
to it (its limit path has a PEP-479 StopIteration bug) and never list() it — we
iterate and break at our own cap. Round-trip identity for a single MOF is
(name, database).
"""

from __future__ import annotations

import concurrent.futures
import logging

from pymatgen.core import Structure

logger = logging.getLogger(__name__)

# Wall-clock cap for any MOFX-DB network call. mofdb_client's requests.get has no
# timeout, so an unreachable/slow host would otherwise block a worker forever.
_MOFDB_TIMEOUT_S = 30.0


def _with_timeout(fn, *args, **kwargs):
    """Run a blocking mofdb_client call with a hard wall-clock timeout.

    Raises TimeoutError on expiry (router maps it to 504). The orphaned worker
    thread is daemonic and will exit when the process does.
    """
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        future = ex.submit(fn, *args, **kwargs)
        try:
            return future.result(timeout=_MOFDB_TIMEOUT_S)
        except concurrent.futures.TimeoutError as exc:
            raise TimeoutError(
                f"MOFX-DB did not respond within {_MOFDB_TIMEOUT_S:.0f}s"
            ) from exc


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
    pass limit to fetch(), whose limit path is buggy). Network call is time-bounded."""
    return _with_timeout(_search_mofs_impl, name, database, limit)


def _search_mofs_impl(name: str | None, database: str | None, limit: int) -> dict:
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
    Structure. (name, database) is the unique round-trip key. Network is time-bounded."""
    return _with_timeout(_get_mof_structure_impl, name, database)


def _get_mof_structure_impl(name: str, database: str | None) -> tuple[Structure, str]:
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
