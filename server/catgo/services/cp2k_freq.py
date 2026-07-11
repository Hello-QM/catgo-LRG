"""CP2K vibrational-analysis output parsers.

Pure functions, no FastAPI imports. Both parsers return the same dict shape
as routers.freq_analysis._parse_outcar_content so the frontend
(FreqAnalysisPane) works unchanged:

- eigenvectors / intensities_km_mol are ordered IMAGINARY MODES FIRST, then
  real modes — FreqAnalysisPane indexes eigenvectors as
  `imag_len + position_in_real_freqs`.
- imaginary frequencies are stored with positive frequency_cm in imag_freqs.
"""

from __future__ import annotations

BOHR_TO_ANG = 0.52917721067


def _masses_for(elements: list[str]) -> list[float]:
    from pymatgen.core import Element  # heavy import kept function-local

    return [float(Element(sym).atomic_mass) for sym in elements]


def parse_molden_vibrations(text: str) -> dict:
    """Parse a CP2K Molden vibrations file (*-VIBRATIONS-*.mol)."""
    freqs: list[float] = []
    elements: list[str] = []
    positions: list[list[float]] = []
    eigenvectors: list[list[list[float]]] = []
    intensities: list[float | None] = []

    section = None
    current_mode: list[list[float]] | None = None
    for raw in text.splitlines():
        s = raw.strip()
        if not s:
            continue
        if s.startswith("["):
            low = s.lower()
            if low.startswith("[freq"):
                section = "freq"
            elif low.startswith("[fr-coord"):
                section = "coord"
            elif low.startswith("[fr-norm-coord"):
                section = "norm"
            elif low.startswith("[int"):
                section = "int"
            else:
                section = None
            current_mode = None
            continue

        if section == "freq":
            try:
                freqs.append(float(s))
            except ValueError:
                pass
        elif section == "coord":
            parts = s.split()
            if len(parts) >= 4:
                try:
                    xyz = [float(p) * BOHR_TO_ANG for p in parts[1:4]]
                except ValueError:
                    continue
                elements.append(parts[0])
                positions.append(xyz)
        elif section == "norm":
            if s.lower().startswith("vibration"):
                current_mode = []
                eigenvectors.append(current_mode)
            elif current_mode is not None:
                parts = s.split()
                if len(parts) >= 3:
                    try:
                        current_mode.append([float(parts[0]), float(parts[1]), float(parts[2])])
                    except ValueError:
                        pass
        elif section == "int":
            try:
                intensities.append(float(s))
            except ValueError:
                intensities.append(None)

    if not freqs:
        return {"success": False, "message": "No [FREQ] section found in Molden file"}

    # Sanity: eigenvector atom counts must match positions; otherwise drop
    # animation data and keep the frequency table.
    if eigenvectors and any(len(m) != len(positions) for m in eigenvectors):
        eigenvectors = []
    if len(eigenvectors) != len(freqs):
        eigenvectors = []
    if len(intensities) != len(freqs):
        intensities = []

    # Stable partition: imaginary (negative) modes first, carrying the
    # per-mode eigenvector and intensity along. Original 1-based mode index
    # is preserved for display.
    order = sorted(range(len(freqs)), key=lambda i: freqs[i] >= 0)
    imag_freqs = []
    real_freqs = []
    ordered_eig: list[list[list[float]]] = []
    ordered_int: list[float | None] = []
    for i in order:
        entry = {"index": i + 1, "frequency_cm": abs(freqs[i])}
        (real_freqs if freqs[i] >= 0 else imag_freqs).append(entry)
        if eigenvectors:
            ordered_eig.append(eigenvectors[i])
        if intensities:
            ordered_int.append(intensities[i])

    masses = _masses_for(elements) if elements else []
    seen: dict[str, int] = {}
    atom_types = [seen.setdefault(el, len(seen)) for el in elements]

    return {
        "success": True,
        "real_freqs": real_freqs,
        "imag_freqs": imag_freqs,
        "eigenvectors": ordered_eig,
        "positions": positions,
        "elements": elements,
        "masses": masses,
        "atom_types": atom_types,
        "total_atoms": len(positions),
        "num_imaginary": len(imag_freqs),
        "free_indices": None,
        "intensities_km_mol": ordered_int or None,
        "source_format": "cp2k-molden",
    }
