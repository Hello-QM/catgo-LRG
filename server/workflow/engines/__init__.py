"""Engine-specific input generation modules.

These modules provide generate_*_inputs() functions used by the V2 engine's
engine_builtins.py via @register_engine decorators. They are NOT part of the
old V1 orchestration — they are shared computational chemistry input generators.
"""

import json
import logging

_logger = logging.getLogger(__name__)


def ensure_poscar(structure_str: str) -> str:
    """Convert a structure string to POSCAR format.

    Accepts either raw POSCAR text or pymatgen dict JSON.
    Returns POSCAR-formatted text.
    """
    from pymatgen.core import Structure
    from pymatgen.io.vasp import Poscar
    try:
        struct = Structure.from_str(structure_str, fmt="poscar")
    except Exception:
        struct = Structure.from_dict(json.loads(structure_str))
    # Sanitize partial selective_dynamics (some sites None → crash in Poscar)
    sd = struct.site_properties.get("selective_dynamics")
    if sd is not None:
        n = len(struct)
        if len(sd) != n or any(v is None for v in sd):
            sd_full = [list(sd[i]) if i < len(sd) and sd[i] is not None else [True, True, True] for i in range(n)]
            struct.remove_site_property("selective_dynamics")
            struct.add_site_property("selective_dynamics", sd_full)
    return str(Poscar(struct))
