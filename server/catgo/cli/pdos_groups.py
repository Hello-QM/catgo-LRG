"""Parse multi-group PDOS specs into the input shape expected by
`catgo_dos.pdos.compute_pdos_groups`.

Single-group syntax (between `;` separators in the full spec):

    <atoms>:<channels>[:<label>]

Atom field expansions:
    "0"          -> [0]
    "0,2,5"      -> [0, 2, 5]
    "0-3"        -> [0, 1, 2, 3]
    "0-3,5,7-8"  -> [0, 1, 2, 3, 5, 7, 8]
    "all"        -> [0..nions-1]

Duplicates removed (preserved order). Whitespace tolerant. Errors
surface as `OpError` so the CLI boundary handles them like every other
parse failure (single-line message, no Python traceback).
"""
from __future__ import annotations

from catgo.cli.adapter import OpError


def _parse_atom_list(text: str, nions: int) -> list[int]:
    """Expand an atom-field token into a 0-based atom index list.

    See module docstring for syntax. Caller must already know `nions`
    (the total atom count) to validate ranges; we never silently clamp.
    """
    s = text.strip()
    if not s:
        raise OpError("empty atom list")
    if s == "all":
        return list(range(nions))
    out: list[int] = []
    seen: set[int] = set()
    for tok_raw in s.split(","):
        tok = tok_raw.strip()
        if not tok:
            continue
        if "-" in tok and not tok.startswith("-"):
            # range like "3-7" — guard against negatives ("-1" starts with -)
            try:
                lo_s, hi_s = tok.split("-", 1)
                lo, hi = int(lo_s.strip()), int(hi_s.strip())
            except ValueError as exc:
                raise OpError(
                    f"bad atom range '{tok}': {exc}"
                ) from exc
            if lo > hi:
                raise OpError(
                    f"reversed atom range '{tok}' (low > high)"
                )
            if lo < 0 or hi >= nions:
                raise OpError(
                    f"atom range '{tok}' out of bounds [0, {nions - 1}]"
                )
            for i in range(lo, hi + 1):
                if i not in seen:
                    seen.add(i)
                    out.append(i)
        else:
            try:
                i = int(tok)
            except ValueError as exc:
                raise OpError(
                    f"bad atom index '{tok}': not an integer"
                ) from exc
            if i < 0 or i >= nions:
                raise OpError(
                    f"atom index {i} out of bounds [0, {nions - 1}]"
                )
            if i not in seen:
                seen.add(i)
                out.append(i)
    if not out:
        raise OpError("empty atom list")
    return out
