"""Read molecular wavefunction files: geometry and molecular-orbital list.

Supports Gaussian formatted checkpoint (.fchk/.fch), Molden (.molden,
.molden.input — e.g. from ``orca_2mkl``), AIMPAC .wfn and AIMAll .wfx.

Only what the orbital browser needs is extracted: atoms, charge/multiplicity,
total energy and, per orbital, energy, occupation, spin and the 1-based index
Multiwfn uses for it (orbitals in file order; for split alpha/beta sets the
beta orbitals follow all alpha ones). Basis-set data is left to Multiwfn.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

BOHR_TO_ANGSTROM = 0.529177210903
HARTREE_TO_EV = 27.211386245988

_SYMBOLS = (
    "X H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni "
    "Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe "
    "Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg "
    "Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg "
    "Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og"
).split()
_Z_OF = {s.lower(): z for z, s in enumerate(_SYMBOLS)}

SUPPORTED_SUFFIXES = (".fchk", ".fch", ".molden", ".molden.input", ".wfn", ".wfx")


class WavefunctionParseError(ValueError):
    """The file is not a readable wavefunction file of the detected format."""


def detect_format(filename: str) -> str | None:
    name = filename.lower()
    if name.endswith((".fchk", ".fch")):
        return "fchk"
    if name.endswith((".molden", ".molden.input")):
        return "molden"
    if name.endswith(".wfn"):
        return "wfn"
    if name.endswith(".wfx"):
        return "wfx"
    return None


def parse_wavefunction(text: str, filename: str) -> dict[str, Any]:
    """Parse ``text`` according to the format implied by ``filename``."""
    fmt = detect_format(filename)
    parser = {"fchk": parse_fchk, "molden": parse_molden, "wfn": parse_wfn, "wfx": parse_wfx}.get(
        fmt or ""
    )
    if parser is None:
        raise WavefunctionParseError(
            f"Unsupported wavefunction file: {filename} (expected one of {', '.join(SUPPORTED_SUFFIXES)})"
        )
    try:
        result = parser(text)
    except WavefunctionParseError:
        raise
    except (ValueError, IndexError, KeyError) as exc:
        raise WavefunctionParseError(f"Could not parse {filename} as {fmt}: {exc}") from exc
    if not result["atoms"]:
        raise WavefunctionParseError(f"No atoms found in {filename}")
    result["format"] = fmt
    result["filename"] = Path(filename).name
    return result


# ── shared helpers ──────────────────────────────────────────────────────────

def _atom(z: int, xyz_bohr: list[float]) -> dict[str, Any]:
    return {
        "Z": z,
        "symbol": _SYMBOLS[z] if 0 < z < len(_SYMBOLS) else "X",
        "xyz": [c * BOHR_TO_ANGSTROM for c in xyz_bohr],
    }


def _float(token: str) -> float:
    return float(token.replace("D", "E").replace("d", "e"))


def _orbital(index: int, number: int, spin: str, energy: float | None, occ: float) -> dict:
    return {
        "index": index,       # 1-based index as Multiwfn numbers it
        "number": number,     # 1-based index within its spin set
        "spin": spin,         # "alpha", "beta" or "restricted"
        "energy": energy,     # Hartree; None when the file has none
        "energy_ev": None if energy is None else energy * HARTREE_TO_EV,
        "occupation": occ,
    }


def _frontier(orbitals: list[dict]) -> dict[str, Any]:
    """HOMO/LUMO per spin set, by occupation in file order."""
    out: dict[str, Any] = {}
    for spin in ("restricted", "alpha", "beta"):
        subset = [o for o in orbitals if o["spin"] == spin]
        if not subset:
            continue
        occupied = [o for o in subset if o["occupation"] > 1e-6]
        homo = max(occupied, key=lambda o: o["number"]) if occupied else None
        lumo = next((o for o in subset if homo is None or o["number"] == homo["number"] + 1), None)
        if lumo is not None and lumo["occupation"] > 1e-6:
            lumo = None
        gap = None
        if homo and lumo and homo["energy"] is not None and lumo["energy"] is not None:
            gap = lumo["energy"] - homo["energy"]
        out[spin] = {
            "homo": homo["index"] if homo else None,
            "lumo": lumo["index"] if lumo else None,
            "gap": gap,
            "gap_ev": None if gap is None else gap * HARTREE_TO_EV,
        }
    return out


def _finish(
    title: str,
    atoms: list[dict],
    orbitals: list[dict],
    charge: int | None = None,
    multiplicity: int | None = None,
    energy: float | None = None,
) -> dict[str, Any]:
    n_alpha = sum(1 for o in orbitals if o["spin"] == "alpha")
    n_beta = sum(1 for o in orbitals if o["spin"] == "beta")
    xyz_lines = [str(len(atoms)), title.strip()[:80]]
    xyz_lines += [f"{a['symbol']} {a['xyz'][0]:.8f} {a['xyz'][1]:.8f} {a['xyz'][2]:.8f}" for a in atoms]
    return {
        "title": title.strip(),
        "atoms": atoms,
        "xyz": "\n".join(xyz_lines) + "\n",
        "charge": charge,
        "multiplicity": multiplicity,
        "energy": energy,
        "unrestricted": n_beta > 0 and n_alpha > 0,
        "orbitals": orbitals,
        "frontier": _frontier(orbitals),
    }


# ── Gaussian formatted checkpoint ───────────────────────────────────────────

def _fchk_sections(text: str) -> tuple[list[str], dict[str, Any]]:
    """Split an fchk file into ``{label: scalar or list}``.

    Headers are fixed-column: label in columns 1–40, type (I/R/C/L) in
    column 44, then the value or ``N=`` and the array length.
    """
    lines = text.splitlines()
    sections: dict[str, Any] = {}
    i = 2
    while i < len(lines):
        line = lines[i]
        i += 1
        if len(line) < 45 or line[40:43].strip() or line[43] not in "IRCL":
            continue
        label, kind, rest = line[:40].strip(), line[43], line[44:].strip()
        if not rest.startswith("N="):
            if kind == "I":
                sections[label] = int(rest)
            elif kind == "R":
                sections[label] = _float(rest)
            else:
                sections[label] = rest
            continue
        count = int(rest[2:])
        if kind in "CL":
            # 5 strings of 12 chars (C) or 72 logicals (L) per line; skip them
            per_line = 5 if kind == "C" else 72
            i += -(-count // per_line)
            continue
        tokens: list[str] = []
        while len(tokens) < count and i < len(lines):
            tokens.extend(lines[i].split())
            i += 1
        sections[label] = (
            [int(t) for t in tokens[:count]] if kind == "I" else [_float(t) for t in tokens[:count]]
        )
    return lines, sections


def parse_fchk(text: str) -> dict[str, Any]:
    lines, s = _fchk_sections(text)
    if "Atomic numbers" not in s or "Current cartesian coordinates" not in s:
        raise WavefunctionParseError("missing 'Atomic numbers' or 'Current cartesian coordinates'")
    numbers = s["Atomic numbers"]
    coords = s["Current cartesian coordinates"]
    atoms = [_atom(z, coords[3 * k:3 * k + 3]) for k, z in enumerate(numbers)]

    n_a = int(s.get("Number of alpha electrons", 0))
    n_b = int(s.get("Number of beta electrons", 0))
    e_alpha = s.get("Alpha Orbital Energies") or []
    e_beta = s.get("Beta Orbital Energies")

    orbitals: list[dict] = []
    if e_beta is not None:
        for k, e in enumerate(e_alpha):
            orbitals.append(_orbital(k + 1, k + 1, "alpha", e, 1.0 if k < n_a else 0.0))
        for k, e in enumerate(e_beta):
            orbitals.append(_orbital(len(e_alpha) + k + 1, k + 1, "beta", e, 1.0 if k < n_b else 0.0))
    else:
        # Restricted (closed-shell or ROHF): doubly occupied below n_beta,
        # singly occupied up to n_alpha.
        for k, e in enumerate(e_alpha):
            occ = 2.0 if k < n_b else 1.0 if k < n_a else 0.0
            orbitals.append(_orbital(k + 1, k + 1, "restricted", e, occ))

    title = lines[0] if lines else ""
    return _finish(
        title,
        atoms,
        orbitals,
        charge=s.get("Charge"),
        multiplicity=s.get("Multiplicity"),
        energy=s.get("Total Energy", s.get("SCF Energy")),
    )


# ── Molden ──────────────────────────────────────────────────────────────────

def parse_molden(text: str) -> dict[str, Any]:
    lines = text.splitlines()
    section = None
    title_lines: list[str] = []
    atoms: list[dict] = []
    unit_scale = 1.0 / BOHR_TO_ANGSTROM  # Angstrom → Bohr, the default for [Atoms]
    raw_mos: list[dict] = []
    current: dict | None = None

    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if line.startswith("["):
            tag = line[1:line.index("]")].strip().lower() if "]" in line else line[1:].lower()
            section = tag
            if tag == "atoms":
                unit = line[line.index("]") + 1:].strip().lower()
                unit_scale = 1.0 if ("au" in unit or "bohr" in unit) else 1.0 / BOHR_TO_ANGSTROM
            continue
        if section == "title":
            title_lines.append(line)
        elif section == "atoms":
            parts = line.split()
            if len(parts) >= 6:
                z = int(parts[2])
                ghost = z <= 0
                if ghost:  # keep the element for display, not for the charge
                    z = _Z_OF.get(re.sub(r"[^A-Za-z]", "", parts[0]).lower(), 0)
                xyz = [float(p) * unit_scale for p in parts[3:6]]
                atoms.append(_atom(z, xyz))
                if ghost:
                    atoms[-1]["ghost"] = True
        elif section == "mo":
            if "=" in line:
                key, _, value = line.partition("=")
                key = key.strip().lower()
                if current is None or "coef_started" in current:
                    current = {}
                    raw_mos.append(current)
                current[key] = value.strip()
            elif current is not None:
                current["coef_started"] = True

    alpha = [m for m in raw_mos if m.get("spin", "alpha").lower() != "beta"]
    beta = [m for m in raw_mos if m.get("spin", "alpha").lower() == "beta"]
    unrestricted = bool(beta)
    orbitals: list[dict] = []
    for spin_name, group in (("alpha", alpha), ("beta", beta)):
        for k, m in enumerate(group):
            energy = _float(m["ene"]) if "ene" in m else None
            occ = _float(m.get("occup", "0"))
            spin = spin_name if unrestricted else "restricted"
            orbitals.append(_orbital(len(orbitals) + 1, k + 1, spin, energy, occ))

    n_electrons = sum(o["occupation"] for o in orbitals)
    charge = None
    if atoms and orbitals:
        charge = round(sum(a["Z"] for a in atoms if not a.get("ghost")) - n_electrons)
    return _finish(" ".join(title_lines), atoms, orbitals, charge=charge)


# ── AIMPAC .wfn ─────────────────────────────────────────────────────────────

# "  O    1    (CENTRE  1)  x y z  CHARGE =  8.0" — also "Li1   (CENTRE  1)";
# coordinates are F12.8 fields that can run together ("0.00000000-94.48630664").
_WFN_ATOM = re.compile(
    r"^\s*([A-Za-z]{1,2})[^(]*\(CENTRE\s*\d+\)(.*?)CHARGE\s*=\s*(\S+)", re.IGNORECASE
)
_NUMBER = re.compile(r"-?\d+\.\d*(?:[EeDd][-+]?\d+)?")
_WFN_MO = re.compile(
    r"^\s*MO\s+(\d+).*?OCC\s+NO\s*=\s*(\S+)\s+ORB\.\s+ENERGY\s*=\s*(\S+)", re.IGNORECASE
)
# "TOTAL ENERGY =" (Gaussian) or "THE SCF/HF/CI ENERGY =" (other writers)
_WFN_ENERGY = re.compile(r"(?:TOTAL|THE\s+\w+)\s+ENERGY\s*=\s*(\S+)", re.IGNORECASE)


def parse_wfn(text: str) -> dict[str, Any]:
    lines = text.splitlines()
    atoms: list[dict] = []
    orbitals: list[dict] = []
    energy = None
    for line in lines:
        m = _WFN_ATOM.match(line)
        if m:
            z = _Z_OF.get(m.group(1).lower())
            if z is None:
                z = round(_float(m.group(3)))
            atoms.append(_atom(z, _wfn_coords(m.group(2))))
            continue
        m = _WFN_MO.match(line)
        if m:
            n = len(orbitals) + 1
            orbitals.append(_orbital(n, n, "restricted", _float(m.group(3)), _float(m.group(2))))
            orbitals[-1]["_label"] = int(m.group(1))
            continue
        m = _WFN_ENERGY.search(line)
        if m:
            energy = _float(m.group(1))
    _split_wfn_spins(orbitals)
    n_electrons = sum(o["occupation"] for o in orbitals)
    charge = round(sum(a["Z"] for a in atoms) - n_electrons) if atoms else None
    return _finish(lines[0] if lines else "", atoms, orbitals, charge=charge, energy=energy)


def _wfn_coords(field: str) -> list[float]:
    """Three F12.8 coordinates after "(CENTRE n)" and one blank."""
    body = field[1:] if field.startswith(" ") else field
    try:
        coords = [_float(body[k:k + 12]) for k in (0, 12, 24)]
    except ValueError:
        coords = [_float(c) for c in _NUMBER.findall(field)[:3]]
    if len(coords) != 3:
        raise WavefunctionParseError(f"bad atom coordinates: {field.strip()!r}")
    return coords


def _split_wfn_spins(orbitals: list[dict]) -> None:
    """Label alpha/beta orbitals of an unrestricted .wfn in place.

    The format has no spin flag. Like Multiwfn, treat a file whose occupations
    are all 0 or 1 as unrestricted; the beta set starts where the MO label
    jumps or the orbital energy drops.
    """
    labels = [o.pop("_label") for o in orbitals]
    if len(orbitals) < 2 or any(o["occupation"] > 1.0 + 1e-6 for o in orbitals):
        return
    start = next(
        (
            k for k in range(1, len(orbitals))
            if labels[k] != labels[k - 1] + 1 or orbitals[k]["energy"] < orbitals[k - 1]["energy"] - 1e-6
        ),
        None,
    )
    if start is None:
        return
    for k, o in enumerate(orbitals):
        o["spin"] = "alpha" if k < start else "beta"
        o["number"] = k + 1 if k < start else k - start + 1


# ── AIMAll .wfx ─────────────────────────────────────────────────────────────

def _wfx_sections(text: str) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = {}
    current: str | None = None
    body: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("</") and line.endswith(">"):
            if current is not None and line[2:-1].strip() == current:
                sections.setdefault(current, body)
            current = None
            continue
        if line.startswith("<") and line.endswith(">") and current is None:
            current = line[1:-1].strip()
            body = []
            continue
        if current is not None:
            body.append(line)
    return sections


def parse_wfx(text: str) -> dict[str, Any]:
    s = _wfx_sections(text)

    def tokens(key: str) -> list[str]:
        return " ".join(s.get(key, [])).split()

    numbers = [int(t) for t in tokens("Atomic Numbers")]
    coords = [_float(t) for t in tokens("Nuclear Cartesian Coordinates")]
    atoms = [_atom(z, coords[3 * k:3 * k + 3]) for k, z in enumerate(numbers)]

    occs = [_float(t) for t in tokens("Molecular Orbital Occupation Numbers")]
    energies = [_float(t) for t in tokens("Molecular Orbital Energies")]
    spins = [line.strip().lower() for line in s.get("Molecular Orbital Spin Types", [])]
    unrestricted = any(sp == "beta" for sp in spins)

    orbitals: list[dict] = []
    counters = {"alpha": 0, "beta": 0, "restricted": 0}
    for k, occ in enumerate(occs):
        sp = spins[k] if k < len(spins) else "alpha and beta"
        spin = ("beta" if sp == "beta" else "alpha") if unrestricted else "restricted"
        counters[spin] += 1
        energy = energies[k] if k < len(energies) else None
        orbitals.append(_orbital(k + 1, counters[spin], spin, energy, occ))

    def scalar(key: str, cast):
        values = tokens(key)
        return cast(values[0]) if values else None

    title = " ".join(s.get("Title", []))
    return _finish(
        title,
        atoms,
        orbitals,
        charge=scalar("Net Charge", lambda v: round(_float(v))),
        multiplicity=scalar("Electronic Spin Multiplicity", int),
        energy=scalar("Energy = T + Vne + Vee + Vnn", _float),
    )
