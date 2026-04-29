"""Built-in readers wrapped as ReaderPlugin for the unified reader system.

These are NOT external plugins in the plugins/ directory. They are registered
programmatically during PluginManager.initialize() to allow the unified
/api/plugins/readers/upload endpoint to route to existing reading code.
"""

import logging
from pathlib import Path
from typing import Optional

from .base import ReaderPlugin

logger = logging.getLogger(__name__)


def _vaspdata_to_dict(data) -> dict:
    """Convert VaspData to the universal reader dict format."""
    import numpy as np

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


class VaspoutH5Reader(ReaderPlugin):
    """Read VASP vaspout.h5 for DOS analysis."""

    name = "builtin-vaspout-h5"
    reader_id = "vaspout_h5"
    display_name = "VASP vaspout.h5"
    description = "Read vaspout.h5 HDF5 file for DOS analysis (VASP >= 6.4)"
    version = "1.0.0"
    author = "CatGo (builtin)"
    supported_formats = [".h5", ".hdf5"]
    output_type = "electronic_dos"

    async def read(self, file_paths, options=None):
        import sys

        _ext = Path(__file__).resolve().parent.parent.parent / "extensions" / "dos-analysis"
        if str(_ext) not in sys.path:
            sys.path.insert(0, str(_ext))
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


class ProcarReader(ReaderPlugin):
    """Read VASP PROCAR + OUTCAR + POSCAR for DOS analysis."""

    name = "builtin-procar"
    reader_id = "vasp_procar"
    display_name = "VASP PROCAR"
    description = "Read PROCAR (+ OUTCAR for E_f, POSCAR for structure) for DOS analysis"
    version = "1.0.0"
    author = "CatGo (builtin)"
    supported_formats = ["PROCAR"]
    output_type = "electronic_dos"
    multi_file = True
    required_files = ["PROCAR"]
    optional_files = ["OUTCAR", "POSCAR", "CONTCAR"]

    def detect_files(self, filenames):
        return any("PROCAR" in fn.upper() for fn in filenames)

    async def read(self, file_paths, options=None):
        import sys

        _ext = Path(__file__).resolve().parent.parent.parent / "extensions" / "dos-analysis"
        if str(_ext) not in sys.path:
            sys.path.insert(0, str(_ext))
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


class VasprunBandReader(ReaderPlugin):
    """Read vasprun.xml for band structure analysis."""

    name = "builtin-vasprun-bands"
    reader_id = "vasprun_bands"
    display_name = "VASP Band Structure"
    description = "Read vasprun.xml for band structure analysis"
    version = "1.0.0"
    author = "CatGo (builtin)"
    supported_formats = [".xml"]
    output_type = "electronic_bands"

    async def read(self, file_paths, options=None):
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


class CohpcarReader(ReaderPlugin):
    """Read COHPCAR.lobster for COHP analysis."""

    name = "builtin-cohpcar"
    reader_id = "lobster_cohp"
    display_name = "LOBSTER COHP"
    description = "Read COHPCAR.lobster for COHP analysis"
    version = "1.0.0"
    author = "CatGo (builtin)"
    supported_formats = [".lobster", "COHPCAR"]
    output_type = "cohp"

    def detect_files(self, filenames):
        return any("COHPCAR" in fn.upper() or fn.endswith(".lobster") for fn in filenames)

    async def read(self, file_paths, options=None):
        import sys

        _ext = Path(__file__).resolve().parent.parent.parent / "extensions" / "cohp-analysis"
        if str(_ext) not in sys.path:
            sys.path.insert(0, str(_ext))
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


# All builtin readers to register
BUILTIN_READERS = [
    VaspoutH5Reader,
    ProcarReader,
    VasprunBandReader,
    CohpcarReader,
]
