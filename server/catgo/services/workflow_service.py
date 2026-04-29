"""Reusable business logic extracted from the workflow router.

Contains:
- Site metadata extraction/restoration for ASE DB round-trips
- Parameter type coercion (string → int/float/bool)
- Structure serialization helpers (dict → ASE, ASE → format string)
- Local path validation
"""

import json
import logging
from io import BytesIO, StringIO
from pathlib import Path

from fastapi import HTTPException

logger = logging.getLogger(__name__)


# ====== Site metadata preservation for DB round-trip ======
# ASE Atoms can't carry custom per-atom properties (pseudo_h_potcar,
# pseudo_h_charge, selective_dynamics).  We stash them in the ASE DB
# `data` dict and restore on load.


def extract_site_metadata(structure) -> dict:
    """Extract site properties & labels that ASE Atoms can't preserve."""
    site_properties = {}
    site_labels = {}
    for i, site in enumerate(structure.sites):
        if site.properties:
            props = {k: v for k, v in site.properties.items() if v is not None}
            if props:
                site_properties[str(i)] = props
        # Preserve labels that differ from plain element symbol (e.g. "H.66")
        if site.label:
            elem = site.species[0].element if site.species else ""
            if site.label != elem:
                site_labels[str(i)] = site.label
    result = {}
    if site_properties:
        result["site_properties"] = site_properties
    if site_labels:
        result["site_labels"] = site_labels
    return result


def restore_site_metadata(structure, data: dict):
    """Restore site properties & labels from ASE DB data dict."""
    site_properties = data.get("site_properties", {})
    site_labels = data.get("site_labels", {})
    for i, site in enumerate(structure.sites):
        key = str(i)
        if key in site_properties:
            existing = site.properties or {}
            existing.update(site_properties[key])
            site.properties = existing
        if key in site_labels:
            site.label = site_labels[key]


# ====== Parameter type coercion ======


def coerce_node_params(graph_json: str) -> str:
    """Coerce node parameter types: numeric strings -> numbers, bool strings -> bools.

    AI tools often send params like {"ENCUT": "520", "fmax": "0.01"} where
    downstream code expects int/float. This auto-fixes common type mismatches.
    """
    try:
        graph = json.loads(graph_json)
    except (json.JSONDecodeError, TypeError):
        return graph_json

    changed = False
    for node in graph.get("nodes", []):
        params = node.get("params", {})
        for key, val in list(params.items()):
            if isinstance(val, str):
                # Try bool first
                if val.lower() in ("true", "false"):
                    params[key] = val.lower() == "true"
                    changed = True
                    continue
                # Try int
                try:
                    params[key] = int(val)
                    changed = True
                    continue
                except ValueError:
                    pass
                # Try float (e.g. "1e-5", "0.01")
                try:
                    params[key] = float(val)
                    changed = True
                    continue
                except ValueError:
                    pass

    return json.dumps(graph) if changed else graph_json


# ====== Structure Serialization (ASE-based) ======
# [2026-03-02] Replaced pymatgen-based serialization with ASE.
# Reason: pymatgen preserves oxidation_state from frontend dict -> 'C0+' in XYZ output.
#         ASE uses converter.py which already has _clean_element_symbol('C0+' -> 'C'),
#         and natively handles CIF/POSCAR/XYZ/ExtXYZ with proper molecule support.


def dict_to_ase(structure_dict: dict):
    """Convert a frontend structure dict -> ASE Atoms.

    Uses utils/converter.py which:
    - _clean_element_symbol strips oxidation states ('C0+' -> 'C', 'Fe3+' -> 'Fe')
    - Handles molecules (no lattice -> pbc=False) and periodic crystals
    - Preserves Cartesian + fractional coordinates
    """
    from catgo.models.structure import PymatgenStructure
    from catgo.utils.converter import pymatgen_to_ase

    struct = PymatgenStructure(**structure_dict)
    n_sites = len(struct.sites)
    has_lattice = struct.lattice is not None
    logger.info(f"[serialize] dict->ASE: {n_sites} sites, lattice={'yes' if has_lattice else 'no'}")

    atoms = pymatgen_to_ase(struct)
    logger.info(f"[serialize] ASE Atoms: {atoms.get_chemical_formula()}, pbc={list(atoms.pbc)}")

    # Convert selective_dynamics -> ASE FixAtoms constraint (used by POSCAR writer)
    if struct.sites and any(
        s.properties and "selective_dynamics" in s.properties for s in struct.sites
    ):
        from ase.constraints import FixAtoms
        fixed = [
            i for i, s in enumerate(struct.sites)
            if s.properties and s.properties.get("selective_dynamics")
            and not all(s.properties["selective_dynamics"])
        ]
        if fixed:
            atoms.set_constraint(FixAtoms(indices=fixed))
            logger.info(f"[serialize] selective_dynamics: {len(fixed)} frozen atoms -> FixAtoms")

    return atoms


def ase_serialize(atoms, fmt: str) -> tuple[str, str]:
    """Serialize ASE Atoms -> string. Returns (content, actual_format).

    Format mapping: cif->cif, poscar->vasp, xyz->xyz, extxyz->extxyz, mol2->mol2, pdb->pdb
    Molecule fallback: if pbc=False and fmt is cif/extxyz -> auto xyz; poscar -> error.
    Note: ASE CIF writer requires BytesIO, all others use StringIO.
    """
    import ase.io

    is_periodic = any(atoms.pbc)

    # Auto-fallback for non-periodic molecules
    if not is_periodic:
        if fmt == "poscar":
            raise ValueError("POSCAR format requires a periodic structure with lattice")
        if fmt in ("cif", "extxyz"):
            logger.info(f"[serialize] molecule fallback: {fmt} -> xyz (no lattice)")
            fmt = "xyz"

    ase_fmt = {
        "cif": "cif",
        "poscar": "vasp",
        "xyz": "xyz",
        "extxyz": "extxyz",
        "mol2": "mol2",
        "pdb": "proteindatabank"
    }.get(fmt, "cif")

    # ASE CIF writer outputs bytes; all other formats output str
    if ase_fmt == "cif":
        buf = BytesIO()
        ase.io.write(buf, atoms, format=ase_fmt)
        content = buf.getvalue().decode("utf-8")
    else:
        buf = StringIO()
        ase.io.write(buf, atoms, format=ase_fmt)
        content = buf.getvalue()

    logger.info(
        f"[serialize] ASE write: fmt={ase_fmt}, "
        f"{len(atoms)} atoms, {len(content)} chars output"
    )
    return content, fmt


# ====== Path validation ======


def validate_local_path(path_str: str) -> Path:
    """Resolve and validate a local path for safety."""
    import os
    p = Path(os.path.expanduser(path_str)).resolve()
    parts = [x for x in str(p).split("/") if x]
    if len(parts) < 2:
        raise HTTPException(status_code=400, detail=f"Path too shallow (safety check): {p}")
    return p
