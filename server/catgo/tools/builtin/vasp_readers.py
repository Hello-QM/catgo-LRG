# server/tools/builtin/vasp_readers.py
"""Built-in VASP/COHP file readers migrated to Tool format.

Each reader has a TOOL dict plus execute_<name>, detect_files_<name>,
and priority_score_<name> functions.  The original class-based readers
in server/plugins/builtin_readers.py remain untouched for the legacy
plugin system.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Shared helper
# ---------------------------------------------------------------------------

def _vaspdata_to_dict(data) -> dict:
    """Convert VaspData to the universal reader dict format."""
    return {
        "eigenvalues": data.eigenvalues.tolist(),
        "kweights": data.kweights.tolist(),
        "efermi": float(data.efermi),
        "projectors": data.projectors.tolist(),
        "positions": data.positions.tolist(),
        "positions_frac": data.positions_frac.tolist(),
        "lattice": data.lattice.tolist(),
        "elements": [str(e) for e in data.elements],
        "ion_types": data.ion_types,
        "ion_counts": data.ion_counts,
    }


def _dos_ext_path() -> Path:
    """Return the path to the dos-analysis extension."""
    return Path(__file__).resolve().parent.parent.parent.parent / "extensions" / "dos-analysis"


def _cohp_ext_path() -> Path:
    """Return the path to the cohp-analysis extension."""
    return Path(__file__).resolve().parent.parent.parent.parent / "extensions" / "cohp-analysis"


# ═══════════════════════════════════════════════════════════════════════════
# 1. vaspout_h5 — VASP vaspout.h5 reader
# ═══════════════════════════════════════════════════════════════════════════

_TOOL_VASPOUT_H5 = {
    "name": "vaspout_h5",
    "display_name": "VASP vaspout.h5 Reader",
    "description": "Read vaspout.h5 HDF5 file for DOS analysis (VASP >= 6.4)",
    "category": "reader",
    "output_type": "electronic_dos",
    "supported_formats": [".h5", ".hdf5"],
    "multi_file": False,
}


async def execute_vaspout_h5(file_paths: list[str], options: Optional[dict] = None, **kwargs) -> dict:
    import sys
    ext = str(_dos_ext_path())
    if ext not in sys.path:
        sys.path.insert(0, ext)
    from catgo_dos.io import read_vaspout_h5

    h5_path = None
    for p in file_paths:
        if p.lower().endswith((".h5", ".hdf5")):
            h5_path = p
            break
    if not h5_path:
        raise ValueError("No .h5/.hdf5 file found in uploads")

    data = read_vaspout_h5(h5_path)
    return _vaspdata_to_dict(data)


def detect_files_vaspout_h5(filenames: list[str]) -> bool:
    return any(fn.lower().endswith((".h5", ".hdf5")) for fn in filenames)


def priority_score_vaspout_h5(filenames: list[str]) -> int:
    # Prefer h5 over PROCAR when both present
    return 10 if any(fn.lower().endswith((".h5", ".hdf5")) for fn in filenames) else 0


# ═══════════════════════════════════════════════════════════════════════════
# 2. vasp_procar — VASP PROCAR reader
# ═══════════════════════════════════════════════════════════════════════════

_TOOL_VASP_PROCAR = {
    "name": "vasp_procar",
    "display_name": "VASP PROCAR Reader",
    "description": "Read PROCAR (+ OUTCAR for E_f, POSCAR for structure) for DOS analysis",
    "category": "reader",
    "output_type": "electronic_dos",
    "supported_formats": ["PROCAR"],
    "multi_file": True,
}


async def execute_vasp_procar(file_paths: list[str], options: Optional[dict] = None, **kwargs) -> dict:
    import sys
    ext = str(_dos_ext_path())
    if ext not in sys.path:
        sys.path.insert(0, ext)
    from catgo_dos.io import read_procar, extract_efermi_outcar

    opts = options or {}
    procar_text = outcar_text = poscar_text = None

    for p in file_paths:
        name = Path(p).name.upper()
        content = Path(p).read_text(errors="replace")
        if "PROCAR" in name:
            procar_text = content
        elif "OUTCAR" in name:
            outcar_text = content
        elif name in ("POSCAR", "CONTCAR"):
            poscar_text = content

    if not procar_text:
        raise ValueError("PROCAR file not found")

    efermi = opts.get("efermi", 0.0)
    if outcar_text and efermi == 0.0:
        try:
            efermi = extract_efermi_outcar(outcar_text)
        except ValueError:
            pass

    data = read_procar(procar_text, efermi=efermi, poscar_text=poscar_text)
    return _vaspdata_to_dict(data)


def detect_files_vasp_procar(filenames: list[str]) -> bool:
    return any("PROCAR" in fn.upper() for fn in filenames)


def priority_score_vasp_procar(filenames: list[str]) -> int:
    # Lower priority than vaspout.h5
    return 5 if any("PROCAR" in fn.upper() for fn in filenames) else 0


# ═══════════════════════════════════════════════════════════════════════════
# 3. vasprun_bands — VASP band structure reader
# ═══════════════════════════════════════════════════════════════════════════

_TOOL_VASPRUN_BANDS = {
    "name": "vasprun_bands",
    "display_name": "VASP Band Structure Reader",
    "description": "Read vasprun.xml for band structure analysis",
    "category": "reader",
    "output_type": "electronic_bands",
    "supported_formats": [".xml"],
    "multi_file": False,
}


async def execute_vasprun_bands(file_paths: list[str], options: Optional[dict] = None, **kwargs) -> dict:
    from pymatgen.io.vasp import Vasprun

    xml_path = kpoints_path = None
    for p in file_paths:
        name = Path(p).name.upper()
        if name.endswith(".XML") or "VASPRUN" in name:
            xml_path = p
        elif "KPOINTS" in name:
            kpoints_path = p

    if not xml_path:
        raise ValueError("vasprun.xml not found")

    vr = Vasprun(
        xml_path,
        parse_projected_eigen=True,
        parse_potcar_file=False,
        exception_on_bad_xml=False,
    )
    bs = vr.get_band_structure(kpoints_filename=kpoints_path, line_mode=True)

    # Return pymatgen objects for the existing bands pipeline
    return {"_vasprun": vr, "_bandstructure": bs}


def detect_files_vasprun_bands(filenames: list[str]) -> bool:
    return any(
        fn.lower().endswith(".xml") or "VASPRUN" in fn.upper()
        for fn in filenames
    )


def priority_score_vasprun_bands(filenames: list[str]) -> int:
    return 5 if detect_files_vasprun_bands(filenames) else 0


# ═══════════════════════════════════════════════════════════════════════════
# 4. lobster_cohp — LOBSTER COHPCAR reader
# ═══════════════════════════════════════════════════════════════════════════

_TOOL_LOBSTER_COHP = {
    "name": "lobster_cohp",
    "display_name": "LOBSTER COHP Reader",
    "description": "Read COHPCAR.lobster for COHP analysis",
    "category": "reader",
    "output_type": "cohp",
    "supported_formats": [".lobster", "COHPCAR"],
    "multi_file": False,
}


async def execute_lobster_cohp(file_paths: list[str], options: Optional[dict] = None, **kwargs) -> dict:
    import sys
    ext = str(_cohp_ext_path())
    if ext not in sys.path:
        sys.path.insert(0, ext)
    from catgo_cohp.io import parse_cohpcar

    cohp_path = None
    for p in file_paths:
        if "COHPCAR" in Path(p).name.upper() or p.endswith(".lobster"):
            cohp_path = p
            break

    if not cohp_path:
        raise ValueError("COHPCAR.lobster file not found")

    data = parse_cohpcar(cohp_path)
    return {"_cohp_data": data}


def detect_files_lobster_cohp(filenames: list[str]) -> bool:
    return any("COHPCAR" in fn.upper() or fn.endswith(".lobster") for fn in filenames)


def priority_score_lobster_cohp(filenames: list[str]) -> int:
    return 5 if detect_files_lobster_cohp(filenames) else 0


# ═══════════════════════════════════════════════════════════════════════════
# Module-level TOOLS list (consumed by discover_builtin_tools)
# ═══════════════════════════════════════════════════════════════════════════

TOOLS = [
    _TOOL_VASPOUT_H5,
    _TOOL_VASP_PROCAR,
    _TOOL_VASPRUN_BANDS,
    _TOOL_LOBSTER_COHP,
]
