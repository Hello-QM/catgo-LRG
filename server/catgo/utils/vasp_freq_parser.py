"""VASP frequency parser — extract frequencies + eigenvectors from OUTCAR via SSH.

Uses AWK scripts to parse remotely, avoiding large file downloads (OUTCAR can be 100MB+).
"""

from __future__ import annotations

import re
import shlex
from typing import Any


async def parse_vasp_frequencies(conn: Any, work_dir: str) -> dict:
    """Parse VASP OUTCAR for vibrational frequencies and eigenvectors via SSH.

    Extracts:
    - Real and imaginary frequencies (cm⁻¹, THz, meV)
    - Eigenvectors (displacement vectors per mode per atom)
    - Atomic positions, masses, and element info
    - Selective dynamics free atom indices

    Args:
        conn: SSH connection with async run() method.
        work_dir: Remote directory containing OUTCAR.

    Returns:
        dict with keys: real_freqs, imag_freqs, eigenvectors, positions,
        masses, ions_per_type, total_atoms, num_imaginary, atom_types,
        free_indices, success, message
    """
    safe_dir = shlex.quote(work_dir)

    # --- 1. Extract POMASS and ions per type ---
    meta_result = await conn.run(
        f"awk '"
        f'/POMASS/ && /ZVAL/ {{ match($0, /POMASS *= *([0-9.]+)/, a); if(a[1]) print "MASS", a[1] }} '
        f'/ions per type/ {{ $1=$2=$3=$4=""; print "IONS", $0 }}'
        f"' {safe_dir}/OUTCAR 2>/dev/null",
        check=False,
    )
    if meta_result.exit_status != 0 or not (meta_result.stdout or "").strip():
        return {"success": False, "message": "OUTCAR not found or empty"}

    masses_per_type: list[float] = []
    ions_per_type: list[int] = []
    for line in (meta_result.stdout or "").strip().splitlines():
        if line.startswith("MASS"):
            try:
                masses_per_type.append(float(line.split()[1]))
            except (IndexError, ValueError):
                pass
        elif line.startswith("IONS"):
            ions_per_type = [int(x) for x in line.split()[1:] if x.strip()]

    if not ions_per_type:
        return {"success": False, "message": "Could not parse ions per type from OUTCAR"}

    total_atoms = sum(ions_per_type)

    # Build per-atom masses and atom type indices
    masses: list[float] = []
    atom_types: list[int] = []
    for idx, (mass, count) in enumerate(zip(masses_per_type, ions_per_type)):
        masses.extend([mass] * count)
        atom_types.extend([idx] * count)

    # --- 2. Extract frequencies (f = / f/i =) with THz and meV ---
    freq_result = await conn.run(
        f"grep -E '^\\s*[0-9]+\\s+f(/i)?\\s*=' {safe_dir}/OUTCAR 2>/dev/null",
        check=False,
    )
    if freq_result.exit_status != 0 or not (freq_result.stdout or "").strip():
        return {"success": False, "message": "No frequency data found in OUTCAR"}

    raw_real: list[dict] = []
    raw_imag: list[dict] = []
    freq_pattern_real = re.compile(
        r"^\s*(\d+)\s+f\s+=\s+([\d.]+)\s+THz\s+([\d.]+)\s+2PiTHz\s+([\d.]+)\s+cm-1\s+([\d.]+)\s+meV"
    )
    freq_pattern_imag = re.compile(
        r"^\s*(\d+)\s+f/i\s*=\s+([\d.]+)\s+THz\s+([\d.]+)\s+2PiTHz\s+([\d.]+)\s+cm-1\s+([\d.]+)\s+meV"
    )
    for line in (freq_result.stdout or "").splitlines():
        m = freq_pattern_real.match(line)
        if m:
            raw_real.append({
                "index": int(m.group(1)),
                "frequency_cm": float(m.group(4)),
                "thz": float(m.group(2)),
                "mev": float(m.group(5)),
            })
            continue
        m = freq_pattern_imag.match(line)
        if m:
            raw_imag.append({
                "index": int(m.group(1)),
                "frequency_cm": float(m.group(4)),
                "thz": float(m.group(2)),
                "mev": float(m.group(5)),
            })

    # Deduplicate — OUTCAR prints frequencies twice (once before, once after eigenvectors)
    for fl in [raw_real, raw_imag]:
        n = len(fl)
        if n > 0 and n % 2 == 0:
            half = n // 2
            first_half_cm = [e["frequency_cm"] for e in fl[:half]]
            second_half_cm = [e["frequency_cm"] for e in fl[half:]]
            if first_half_cm == second_half_cm:
                del fl[half:]

    # --- 3. Extract eigenvectors ---
    # Each mode has a block like:
    #   N f = ... (or f/i = ...)
    #     X         Y         Z           dx          dy          dz
    #   x1 y1 z1  dx1 dy1 dz1
    #   ...
    # We extract the second occurrence of each mode's eigenvector block (after dedup)
    # Use AWK to extract all eigenvector blocks efficiently
    eigvec_awk = (
        f"awk '"
        f"BEGIN {{ mode=0; in_block=0; atom=0 }}"
        f" /^\\s*[0-9]+\\s+f(\\/i)?\\s*=/ {{ mode++; in_block=0; next }}"
        f" /X\\s+Y\\s+Z\\s+dx\\s+dy\\s+dz/ {{ in_block=1; atom=0; print \"MODE\", mode; next }}"
        f" in_block && NF>=6 && $1+0==$1 {{ print $4, $5, $6; atom++; if(atom>={total_atoms}) in_block=0 }}"
        f"' {safe_dir}/OUTCAR 2>/dev/null"
    )
    eigvec_result = await conn.run(eigvec_awk, check=False)

    eigenvectors: list[list[list[float]]] = []  # [mode][atom][3]
    if eigvec_result.exit_status == 0 and (eigvec_result.stdout or "").strip():
        current_mode_vecs: list[list[float]] = []
        for line in (eigvec_result.stdout or "").splitlines():
            if line.startswith("MODE"):
                if current_mode_vecs:
                    eigenvectors.append(current_mode_vecs)
                current_mode_vecs = []
            else:
                parts = line.split()
                if len(parts) >= 3:
                    try:
                        current_mode_vecs.append([float(parts[0]), float(parts[1]), float(parts[2])])
                    except ValueError:
                        pass
        if current_mode_vecs:
            eigenvectors.append(current_mode_vecs)

    # Deduplicate eigenvectors (same logic — OUTCAR has them twice)
    n_eig = len(eigenvectors)
    total_modes = len(raw_real) + len(raw_imag)
    if n_eig > 0 and n_eig == total_modes * 2:
        eigenvectors = eigenvectors[total_modes:]
    elif n_eig > total_modes:
        # Take last total_modes blocks
        eigenvectors = eigenvectors[-total_modes:]

    # --- 4. Extract last set of Cartesian positions ---
    pos_awk = (
        f"awk '"
        f"/POSITION\\s+TOTAL-FORCE/ {{ delete pos; n=0; getline; "
        f"  for(i=0; i<{total_atoms}; i++) {{ getline; pos[i]=$1\" \"$2\" \"$3; n++ }} }} "
        f"END {{ for(i=0; i<n; i++) print pos[i] }}"
        f"' {safe_dir}/OUTCAR 2>/dev/null"
    )
    pos_result = await conn.run(pos_awk, check=False)

    positions: list[list[float]] = []
    if pos_result.exit_status == 0 and (pos_result.stdout or "").strip():
        for line in (pos_result.stdout or "").strip().splitlines():
            parts = line.split()
            if len(parts) >= 3:
                try:
                    positions.append([float(parts[0]), float(parts[1]), float(parts[2])])
                except ValueError:
                    pass

    # --- 5. Extract selective dynamics free indices from CONTCAR/POSCAR ---
    free_indices = await _parse_selective_dynamics(conn, safe_dir, total_atoms)

    return {
        "success": True,
        "real_freqs": raw_real,
        "imag_freqs": raw_imag,
        "eigenvectors": eigenvectors,
        "positions": positions,
        "masses": masses,
        "ions_per_type": ions_per_type,
        "atom_types": atom_types,
        "total_atoms": total_atoms,
        "num_imaginary": len(raw_imag),
        "free_indices": free_indices,
    }


async def _parse_selective_dynamics(
    conn: Any, safe_dir: str, total_atoms: int
) -> list[int] | None:
    """Parse selective dynamics from remote CONTCAR/POSCAR to find free atom indices."""
    for filename in ["CONTCAR", "POSCAR"]:
        result = await conn.run(
            f"head -n {total_atoms + 10} {safe_dir}/{filename} 2>/dev/null",
            check=False,
        )
        if result.exit_status == 0 and (result.stdout or "").strip():
            lines = (result.stdout or "").splitlines()
            break
    else:
        return None

    if len(lines) < 8:
        return None

    # Determine format: line 5 is element symbols (VASP5+) or atom counts (VASP4)
    try:
        int(lines[5].split()[0])
        sd_check = 6
    except (ValueError, IndexError):
        sd_check = 7

    if sd_check >= len(lines):
        return None
    if not lines[sd_check].strip().lower().startswith("s"):
        return None

    # Coordinate lines start after "Selective dynamics" + "Direct/Cartesian"
    coord_start = sd_check + 2
    free: list[int] = []
    for j in range(total_atoms):
        line_idx = coord_start + j
        if line_idx >= len(lines):
            break
        parts = lines[line_idx].split()
        if len(parts) >= 6 and any(p.upper() == "T" for p in parts[3:6]):
            free.append(j)

    return free if free else None
