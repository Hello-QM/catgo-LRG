"""Local OUTCAR vibrational parser + TS imaginary-mode animation.

A faithful local port of the frequency/eigenvector regexes used by
catgo.utils.vasp_freq_parser (which is SSH/AWK-only). Pure Python, reads a
local OUTCAR. pymatgen Vasprun has no normal-mode API in this build.
"""
from __future__ import annotations

import math
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
    # eigenvectors indexed in OUTCAR line order; real modes come first
    # in standard VASP output but downstream MUST use imag_mode_indices
    # rather than assume the boundary is len(real_freqs_cm).
    eigenvectors: list = field(default_factory=list)  # [mode][atom][dx,dy,dz]
    imag_mode_indices: list = field(default_factory=list)  # idx into eigenvectors
    positions: list = field(default_factory=list)      # [atom][x,y,z]
    lattice: list = field(default_factory=list)        # 3x3 direct Å
    masses_amu: list = field(default_factory=list)
    atom_types: list = field(default_factory=list)     # [atom] -> type idx
    total_atoms: int = 0
    num_imaginary: int = 0

    def eigenvectors_for_real(self) -> list:
        """Return the eigenvectors of the REAL modes only, in OUTCAR
        order. Used by the IR spectrum (which excludes imaginary modes).

        Sourced from `imag_mode_indices` rather than slicing by
        `len(real_freqs_cm)` — the same boundary-bug guard P2 already
        documented (real and imag are NOT guaranteed contiguous in the
        eigenvector list).
        """
        imag = set(self.imag_mode_indices)
        return [v for k, v in enumerate(self.eigenvectors) if k not in imag]


def parse_outcar_freqs(path) -> FreqData:
    p = Path(path)
    if not p.exists():
        raise OpError(f"OUTCAR not found: {p}")
    text = p.read_text(errors="ignore")  # OUTCARs are ASCII; read whole
    lines = text.splitlines()

    m = re.search(r"ions per type\s*=\s*([\d ]+)", text)
    if not m:
        raise OpError("could not parse 'ions per type' from OUTCAR")
    counts = [int(x) for x in m.group(1).split()]
    total = sum(counts)

    # Per-POTCAR lines look like "POMASS =  16.00; ZVAL = 6.00" (one
    # value). The per-type SUMMARY line is "POMASS = m1 m2 ..." (only
    # floats, no ';'/ZVAL, one value per element type) — that is the one
    # we want; grabbing the first POMASS match would bind a single-type
    # POTCAR header on real multi-element OUTCARs.
    masses: list = []
    for ln in lines:
        s = ln.strip()
        if not s.startswith("POMASS") or ";" in s or "ZVAL" in s:
            continue
        mm = re.match(r"POMASS\s*=\s*([\d.\s]+)$", s)
        if mm:
            cand = [float(x) for x in mm.group(1).split()]
            if len(cand) == len(counts):
                masses = cand
                break

    masses_per_atom: list = []
    atom_types: list = []
    for ti, c in enumerate(counts):
        mass = masses[ti] if ti < len(masses) else 0.0
        masses_per_atom += [mass] * c
        atom_types += [ti] * c

    pos: list = []
    for i, ln in enumerate(lines):
        if "position of ions in cartesian coordinates" in ln:
            for j in range(i + 1, i + 1 + total):
                parts = lines[j].split()
                if len(parts) >= 3:
                    pos.append([float(parts[0]), float(parts[1]),
                                float(parts[2])])
            break

    # Direct lattice vectors: VASP prints
    #   "direct lattice vectors                 reciprocal lattice vectors"
    # then 3 rows "ax ay az   bx by bz"; we take the first 3 floats per row.
    # Needed so the written extxyz carries Lattice=... and CatGO can
    # render cross-cell bonds for slab TS visualization.
    lat: list = []
    for i, ln in enumerate(lines):
        if "direct lattice vectors" in ln:
            tmp: list = []
            for j in range(i + 1, i + 4):
                parts = lines[j].split()
                if len(parts) >= 3:
                    tmp.append([float(parts[0]), float(parts[1]),
                                float(parts[2])])
            if len(tmp) == 3:
                lat = tmp
                break

    data = FreqData(total_atoms=total, masses_amu=masses_per_atom,
                    atom_types=atom_types, positions=pos, lattice=lat)
    i = 0
    while i < len(lines):
        ln = lines[i]
        mr, mi = _F_RE.match(ln), _FI_RE.match(ln)
        if mr or mi:
            cm = float((mr or mi).group(4))
            # OUTCAR prints the freq table twice; the pre-eigenvector
            # listing has no vec rows after each line, so blocks with no
            # eigenvectors are skipped below (robust dedup substitute).
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
                eig_idx = len(data.eigenvectors)
                if mr:
                    data.real_freqs_cm.append(cm)
                else:
                    data.imag_freqs_cm.append(cm)
                    data.imag_mode_indices.append(eig_idx)
                data.eigenvectors.append(vecs)
            i = j
            continue
        i += 1
    data.num_imaginary = len(data.imag_freqs_cm)
    return data


def write_mode_animation(data: FreqData, mode_index: int, out,
                          frames: int, amplitude: float,
                          symbols: list) -> int:
    """Write an extxyz oscillation trajectory R(t)=R0+A*sin(2*pi*t)*e
    for one normal mode, with Lattice= and Properties= keys so CatGO
    renders PBC cross-cell bonds. Returns the number of frames written.

    t = k/frames over [0,1) — no-duplicate-endpoint loop convention
    (matches CatGO's loop_playback default).
    """
    if not (0 <= mode_index < len(data.eigenvectors)):
        raise OpError(
            f"mode_index {mode_index} out of range "
            f"(0..{len(data.eigenvectors) - 1})")
    if len(symbols) != data.total_atoms:
        raise OpError(
            f"symbols length {len(symbols)} != atoms {data.total_atoms}")
    vec = data.eigenvectors[mode_index]
    out_path = Path(out)
    if data.lattice and len(data.lattice) == 3:
        l = data.lattice
        lat_str = ('Lattice="'
                   + " ".join(f"{v:.6f}" for row in l for v in row)
                   + '" ')
    else:
        lat_str = ""
    header_keys = f'{lat_str}Properties=species:S:1:pos:R:3'
    with out_path.open("w") as fh:
        for k in range(frames):
            t = k / frames
            s = amplitude * math.sin(2.0 * math.pi * t)
            fh.write(f"{data.total_atoms}\n")
            fh.write(f'{header_keys} frame={k} mode={mode_index}\n')
            for a in range(data.total_atoms):
                x = data.positions[a][0] + s * vec[a][0]
                y = data.positions[a][1] + s * vec[a][1]
                z = data.positions[a][2] + s * vec[a][2]
                fh.write(f"{symbols[a]} {x:.6f} {y:.6f} {z:.6f}\n")
    return frames
