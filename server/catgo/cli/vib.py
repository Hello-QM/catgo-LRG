"""Local OUTCAR vibrational parser + TS imaginary-mode animation.

A faithful local port of the frequency/eigenvector regexes used by
catgo.utils.vasp_freq_parser (which is SSH/AWK-only). Pure Python, reads a
local OUTCAR. pymatgen Vasprun has no normal-mode API in this build.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from catgo.cli.adapter import OpError

_F_RE = re.compile(
    r"^\s*(\d+)\s+f\s+=\s+([\d.]+)\s+THz\s+([\d.]+)\s+2PiTHz\s+"
    r"([\d.]+)\s+cm-1\s+([\d.]+)\s+meV")
_FI_RE = re.compile(
    r"^\s*(\d+)\s+f/i\s*=\s+([\d.]+)\s+THz\s+([\d.]+)\s+2PiTHz\s+"
    r"([\d.]+)\s+cm-1\s+([\d.]+)\s+meV")
_VEC_RE = re.compile(
    r"^\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+"
    r"([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*$")


@dataclass
class FreqData:
    real_freqs_cm: list = field(default_factory=list)
    imag_freqs_cm: list = field(default_factory=list)
    eigenvectors: list = field(default_factory=list)  # [mode][atom][dx,dy,dz]
    positions: list = field(default_factory=list)      # [atom][x,y,z]
    masses_amu: list = field(default_factory=list)
    total_atoms: int = 0
    num_imaginary: int = 0


def parse_outcar_freqs(path) -> FreqData:
    p = Path(path)
    if not p.exists():
        raise OpError(f"OUTCAR not found: {p}")
    text = p.read_text(errors="ignore")
    lines = text.splitlines()

    m = re.search(r"ions per type\s*=\s*([\d ]+)", text)
    if not m:
        raise OpError("could not parse 'ions per type' from OUTCAR")
    total = sum(int(x) for x in m.group(1).split())

    pm = re.search(r"POMASS\s*=\s*([\d. ]+)", text)
    masses = [float(x) for x in pm.group(1).split()] if pm else []
    # expand per-type masses to per-atom using ions-per-type counts
    counts = [int(x) for x in m.group(1).split()]
    masses_per_atom: list = []
    for c, mass in zip(counts, masses):
        masses_per_atom += [mass] * c

    pos: list = []
    for i, ln in enumerate(lines):
        if "position of ions in cartesian coordinates" in ln:
            for j in range(i + 1, i + 1 + total):
                parts = lines[j].split()
                if len(parts) >= 3:
                    pos.append([float(parts[0]), float(parts[1]),
                                float(parts[2])])
            break

    data = FreqData(total_atoms=total, masses_amu=masses_per_atom,
                    positions=pos)
    i = 0
    while i < len(lines):
        ln = lines[i]
        mr, mi = _F_RE.match(ln), _FI_RE.match(ln)
        if mr or mi:
            cm = float((mr or mi).group(4))
            vecs: list = []
            j = i + 2  # skip the "X Y Z dx dy dz" header line
            while j < len(lines):
                vm = _VEC_RE.match(lines[j])
                if not vm:
                    break
                vecs.append([float(vm.group(4)), float(vm.group(5)),
                             float(vm.group(6))])
                j += 1
            if vecs:  # only blocks that actually carry eigenvectors
                if mr:
                    data.real_freqs_cm.append(cm)
                else:
                    data.imag_freqs_cm.append(cm)
                data.eigenvectors.append(vecs)
            i = j
            continue
        i += 1
    data.num_imaginary = len(data.imag_freqs_cm)
    return data
