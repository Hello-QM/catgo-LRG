"""Pre-submission scientific-config sanity checks for campaign VASP calcs.

Stdlib-only (no pymatgen), pure functions + a thin dir reader, matching the rest
of campaign_lib. Wired into submit_calc as a gate: errors block submission unless
``force=True`` (human-in-the-loop override after review); warnings are surfaced
but never block.

The checks codify the scientific-config errors a real campaign caught
*reactively* (see a campaign's LESSONS.md) so they are now caught *proactively*:
  - closed-shell H2/H2O dissociating under ISPIN=2  -> "gas ISPIN"
  - a freq (IBRION=5) run whose ISPIN != its geo_opt -> "freq ISPIN match"
plus the textbook physics gates:
  - ENCUT >= 1.3 x ENMAX (ENMAX read from POTCAR)   -> "ENCUT"
  - k-mesh density (Gamma-only on a metal slab)      -> "k-mesh"
  - ISMEAR/SIGMA appropriate for metal vs molecule   -> "ISMEAR/SIGMA"
  - magnetic 3d metal without ISPIN=2                 -> "magnetic ISPIN"

Each check is a Check(name, ok, severity, detail); `severity` is what it would be
if it failed ("error" blocks, "warn" advises). The thresholds (1.3x ENMAX, the
magnetic-element list, the SIGMA ceiling) are the codified empirical defaults.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


class SanityError(Exception):
    """Raised by enforce() when an error-severity check fails without force."""


@dataclass
class Check:
    name: str
    ok: bool
    severity: str  # "error" | "warn"
    detail: str = ""


# --- empirical defaults / element classes -------------------------------------

# 3d metals that are routinely spin-polarized in catalysis DFT.
MAGNETIC_METALS = {"Fe", "Co", "Ni", "Mn", "Cr", "V"}

# Non-metallic elements; a cell whose elements are ALL in here is treated as a
# molecule/insulator (ISMEAR=0), otherwise as a metal (MP smearing).
NONMETALS = {
    "H", "He", "B", "C", "N", "O", "F", "Ne", "Si", "P", "S", "Cl", "Ar",
    "Ge", "As", "Se", "Br", "Kr", "Sb", "Te", "I", "Xe",
}

ENCUT_ENMAX_FACTOR = 1.3
METAL_SIGMA_MAX = 0.2

# ENMAX (eV) of the recommended PBE POTCAR per element. Empirical defaults so the
# ENCUT check still works when the POTCAR is generated on the cluster and not
# kept locally (the common campaign case). Values are the standard pseudopotential
# set; approximate is fine — this drives a non-blocking warning, not the physics.
DEFAULT_ENMAX = {
    "H": 250.0, "B": 318.6, "C": 400.0, "N": 400.0, "O": 400.0, "F": 400.0,
    "Na": 260.0, "Mg": 200.0, "Al": 240.0, "Si": 245.0, "P": 255.0, "S": 280.0,
    "Cl": 262.0, "K": 259.0, "Ca": 267.0, "Sc": 222.0, "Ti": 222.0, "V": 264.0,
    "Cr": 266.0, "Mn": 270.0, "Fe": 268.0, "Co": 268.0, "Ni": 270.0, "Cu": 295.0,
    "Zn": 277.0, "Ga": 283.0, "Ge": 174.0, "As": 209.0, "Se": 212.0, "Br": 216.0,
    "Mo": 225.0, "Ru": 213.0, "Rh": 229.0, "Pd": 251.0, "Ag": 250.0, "Sn": 241.0,
    "Sb": 172.0, "Te": 175.0, "I": 176.0, "W": 223.0, "Os": 228.0, "Ir": 211.0,
    "Pt": 230.3, "Au": 230.0, "Zr": 230.0, "Nb": 209.0, "Y": 203.0,
}


def default_enmax(elements: list[str]) -> float | None:
    """Largest recommended-POTCAR ENMAX over *elements*, or None if none known."""
    vals = [DEFAULT_ENMAX[el] for el in elements if el in DEFAULT_ENMAX]
    return max(vals) if vals else None


# --- parsers ------------------------------------------------------------------

def parse_incar(text: str) -> dict[str, str]:
    """INCAR text -> {UPPERCASE_KEY: value}. Strips # and ! comments, splits
    multiple ``KEY = val`` per line on ';', ignores section/blank lines."""
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].split("!", 1)[0]
        for seg in line.split(";"):
            if "=" not in seg:
                continue
            key, val = seg.split("=", 1)
            key = key.strip().upper()
            val = val.strip()
            if key and val:
                out[key] = val
    return out


def potcar_max_enmax(text: str) -> float | None:
    """Largest ENMAX (eV) across all blocks of a (multi-element) POTCAR."""
    vals = [float(m) for m in re.findall(r"ENMAX\s*=\s*([0-9.]+)", text)]
    return max(vals) if vals else None


def potcar_elements(text: str) -> list[str]:
    """Element symbols in POTCAR order, read from each block's header line."""
    out: list[str] = []
    for line in text.splitlines():
        m = re.match(r"\s*[\w.]*PAW[\w.]*\s+([A-Z][a-z]?)\b", line)
        if m:
            out.append(m.group(1))
    return out


def kpoints_is_gamma_only(text: str) -> bool:
    """True iff KPOINTS is an automatic 1x1x1 (Gamma-only) mesh."""
    nz = [l.strip() for l in text.splitlines() if l.strip()]
    if len(nz) >= 4 and nz[1] == "0":
        try:
            mesh = [int(x) for x in nz[3].split()[:3]]
        except ValueError:
            return False
        return len(mesh) == 3 and all(m == 1 for m in mesh)
    return False


def poscar_elements(text: str) -> list[str]:
    """Element symbols from POSCAR line 6 (VASP 5+ symbol line)."""
    lines = text.splitlines()
    if len(lines) < 6:
        return []
    toks = lines[5].split()
    if toks and all(re.match(r"^[A-Z][a-z]?$", t) for t in toks):
        return toks
    return []


# --- checks -------------------------------------------------------------------

def _is_metal(elements: list[str]) -> bool:
    return bool(elements) and any(el not in NONMETALS for el in elements)


def detect_is_gas(calc_dir) -> bool:
    """Heuristic: an all-nonmetal cell is treated as a molecule/gas (Gamma-only
    k-mesh appropriate). Metal present, or unknown -> False (strict slab default)."""
    p = Path(calc_dir)
    elements: list[str] = []
    if (p / "POSCAR").is_file():
        elements = poscar_elements((p / "POSCAR").read_text())
    elif (p / "POTCAR").is_file():
        elements = potcar_elements((p / "POTCAR").read_text())
    return bool(elements) and all(el in NONMETALS for el in elements)


def check_config(incar: dict[str, str], max_enmax: float | None, *,
                 gamma_only: bool, elements: list[str], is_gas: bool) -> list[Check]:
    """Run the scientific-config checks; returns one Check per dimension."""
    checks: list[Check] = []

    # 1. ENCUT vs POTCAR ENMAX
    if "ENCUT" not in incar:
        checks.append(Check("ENCUT", False, "error", "ENCUT not set in INCAR"))
    else:
        encut = float(incar["ENCUT"])
        if max_enmax is None:
            checks.append(Check("ENCUT", True, "warn",
                                "POTCAR ENMAX unavailable; could not verify ENCUT"))
        elif encut < max_enmax:
            checks.append(Check("ENCUT", False, "error",
                                f"ENCUT {encut:g} < ENMAX {max_enmax:g} eV (basis incomplete)"))
        elif encut < ENCUT_ENMAX_FACTOR * max_enmax:
            rec = int(ENCUT_ENMAX_FACTOR * max_enmax)
            checks.append(Check("ENCUT", False, "warn",
                                f"ENCUT {encut:g} < 1.3xENMAX; recommend >= {rec} eV"))
        else:
            checks.append(Check("ENCUT", True, "warn",
                                f"ENCUT {encut:g} >= 1.3xENMAX ({max_enmax:g})"))

    # 2. k-mesh density
    if is_gas:
        checks.append(Check("k-mesh", True, "warn", "gas/molecule: Gamma-only appropriate"))
    elif gamma_only:
        checks.append(Check("k-mesh", False, "warn",
                            "Gamma-only k-mesh on a metal/slab; under-converged, densify"))
    else:
        checks.append(Check("k-mesh", True, "warn", "explicit k-mesh"))

    # 3. ISMEAR / SIGMA
    ismear = incar.get("ISMEAR")
    ismear_i = int(ismear) if (ismear is not None and re.fullmatch(r"-?\d+", ismear)) else None
    sigma = float(incar["SIGMA"]) if "SIGMA" in incar else None
    if _is_metal(elements):
        if ismear_i == -5:
            checks.append(Check("ISMEAR/SIGMA", False, "warn",
                                "ISMEAR=-5 (tetrahedron) ill-suited for metal relaxation/odd k-mesh; "
                                "use ISMEAR=1 (Methfessel-Paxton) with small SIGMA"))
        elif ismear_i is not None and ismear_i >= 0 and sigma is not None and sigma > METAL_SIGMA_MAX:
            checks.append(Check("ISMEAR/SIGMA", False, "warn",
                                f"SIGMA {sigma:g} large for a metal; recommend <= {METAL_SIGMA_MAX:g}"))
        else:
            checks.append(Check("ISMEAR/SIGMA", True, "warn", "smearing appropriate for a metal"))
    else:
        if ismear_i in (1, 2) or ismear_i is None:
            checks.append(Check("ISMEAR/SIGMA", False, "warn",
                                "Methfessel-Paxton smearing on a non-metal/molecule; use ISMEAR=0"))
        else:
            checks.append(Check("ISMEAR/SIGMA", True, "warn", "smearing appropriate for a non-metal"))

    # 4. magnetic ISPIN
    mag = [el for el in elements if el in MAGNETIC_METALS]
    if mag and incar.get("ISPIN") != "2":
        checks.append(Check("magnetic ISPIN", False, "warn",
                            f"magnetic element(s) {','.join(mag)} present; ISPIN=2 recommended"))
    else:
        checks.append(Check("magnetic ISPIN", True, "warn", "ISPIN setting consistent with elements"))

    # 5. closed-shell gas ISPIN (the H2-dissociation lesson)
    if is_gas and incar.get("ISPIN") == "2":
        checks.append(Check("gas ISPIN", False, "warn",
                            "closed-shell gas with ISPIN=2 risks symmetry breaking "
                            "(e.g. H2 dissociation); use ISPIN=1 unless open-shell (O2, radicals)"))
    else:
        checks.append(Check("gas ISPIN", True, "warn", "gas ISPIN setting fine"))

    return checks


def check_freq_ispin_match(freq_incar: dict[str, str], source_incar: dict[str, str]) -> Check:
    """A freq (IBRION=5/6) run must use the same ISPIN as its source geo_opt,
    or the molecule sits off its relaxed minimum and modes come out imaginary."""
    f = freq_incar.get("ISPIN", "1")
    s = source_incar.get("ISPIN", "1")
    if f == s:
        return Check("freq ISPIN match", True, "warn", f"ISPIN={f} matches geo_opt")
    return Check("freq ISPIN match", False, "warn",
                 f"freq ISPIN={f} != geo_opt ISPIN={s}; rebuild freq to match")


# --- gate / dir reader --------------------------------------------------------

def validate_calc_dir(calc_dir, *, is_gas: bool = False,
                      source_incar: dict[str, str] | None = None) -> list[Check]:
    """Read a calc folder's VASP inputs and return the sanity checks. Returns []
    if there is no INCAR (not a VASP calc to validate)."""
    p = Path(calc_dir)
    incar_f = p / "INCAR"
    if not incar_f.is_file():
        return []
    incar = parse_incar(incar_f.read_text())

    potcar_txt = (p / "POTCAR").read_text() if (p / "POTCAR").is_file() else ""

    if (p / "POSCAR").is_file():
        elements = poscar_elements((p / "POSCAR").read_text())
    elif potcar_txt:
        elements = potcar_elements(potcar_txt)
    else:
        elements = []

    # Authoritative ENMAX from a local POTCAR if present; else fall back to the
    # recommended-POTCAR defaults (campaigns build POTCAR on the cluster).
    max_enmax = potcar_max_enmax(potcar_txt) if potcar_txt else None
    if max_enmax is None:
        max_enmax = default_enmax(elements)

    gamma_only = (kpoints_is_gamma_only((p / "KPOINTS").read_text())
                  if (p / "KPOINTS").is_file() else False)

    checks = check_config(incar, max_enmax, gamma_only=gamma_only,
                          elements=elements, is_gas=is_gas)
    if source_incar is not None and incar.get("IBRION") in ("5", "6"):
        checks.append(check_freq_ispin_match(incar, source_incar))
    return checks


def summarize(checks: list[Check]) -> tuple[bool, list[str]]:
    """(*ok*, lines) for surfacing. *ok* is False iff an error-severity check
    failed. Only failing checks are reported."""
    lines: list[str] = []
    ok = True
    for c in checks:
        if c.ok:
            continue
        tag = "ERROR" if c.severity == "error" else "warn"
        lines.append(f"  [{tag}] {c.name}: {c.detail}")
        if c.severity == "error":
            ok = False
    return ok, lines


def enforce(checks: list[Check], *, force: bool = False) -> None:
    """Raise SanityError if any error-severity check failed, unless force."""
    if force:
        return
    bad = [c for c in checks if c.severity == "error" and not c.ok]
    if bad:
        msg = "; ".join(f"{c.name}: {c.detail}" for c in bad)
        raise SanityError(
            f"scientific-config check failed -> {msg}. "
            "Fix the inputs, or pass force=True (--force) to submit anyway after review."
        )
