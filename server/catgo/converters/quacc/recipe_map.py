"""Mapping from quacc recipe function paths to CatGo workflow node configurations.

quacc organises its calculators as ``quacc.recipes.<code>.<category>.<func>``.
This module provides a deterministic mapping from those dotted paths to CatGo
node types together with sensible default parameters.

Usage
-----
>>> from converters.quacc.recipe_map import RECIPE_TO_CATGO, extract_recipe_params
>>> mapping = RECIPE_TO_CATGO["quacc.recipes.vasp.core.relax_job"]
>>> mapping.catgo_type   # "geo_opt"
>>> params = extract_recipe_params("quacc.recipes.vasp.core.relax_job", {"ENCUT": 600})
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

__all__ = [
    "RecipeMapping",
    "RECIPE_TO_CATGO",
    "extract_recipe_params",
    "get_recipe_path",
]


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RecipeMapping:
    """Maps a single quacc recipe to a CatGo node configuration.

    Attributes
    ----------
    catgo_type:
        CatGo workflow node type (e.g. ``"geo_opt"``, ``"single_point"``).
        For existing unified nodes the type is one of the values in
        ``UNIFIED_CALC_NODES`` from ``workflow.node_sets``.  New node types
        that CatGo does not yet have are marked with ``is_new_node=True``.
    default_params:
        Parameter dict that should be merged into the CatGo node.  Typically
        contains at least ``software``.
    is_new_node:
        ``True`` when the target CatGo node type does not exist yet and would
        need to be registered before use.
    description:
        Human-readable one-liner shown in import previews.
    """

    catgo_type: str
    default_params: dict[str, Any] = field(default_factory=dict)
    is_new_node: bool = False
    description: str = ""


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def get_recipe_path(func_name: str, module: str) -> str:
    """Build a fully-qualified quacc recipe path.

    Parameters
    ----------
    func_name:
        The recipe function name, e.g. ``"relax_job"``.
    module:
        The parent module path, e.g. ``"quacc.recipes.vasp.core"``.

    Returns
    -------
    str
        ``"quacc.recipes.vasp.core.relax_job"``
    """
    return f"{module}.{func_name}"


# ---------------------------------------------------------------------------
# Comprehensive recipe -> CatGo mapping
# ---------------------------------------------------------------------------

_VASP = "vasp"
_ORCA = "orca"
_GAUSSIAN = "gaussian"
_XTB = "xtb"
_MLP = "mlp"

RECIPE_TO_CATGO: dict[str, RecipeMapping] = {

    # ====================================================================
    # VASP recipes
    # ====================================================================

    # -- core --
    "quacc.recipes.vasp.core.static_job": RecipeMapping(
        catgo_type="single_point",
        default_params={
            "software": _VASP, "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": True,
        },
        description="VASP single-point energy calculation",
    ),
    "quacc.recipes.vasp.core.relax_job": RecipeMapping(
        catgo_type="geo_opt",
        default_params={
            "software": _VASP, "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
            "ISIF": 2, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        },
        description="VASP geometry optimisation (ions only)",
    ),
    "quacc.recipes.vasp.core.double_relax_job": RecipeMapping(
        catgo_type="geo_opt",
        default_params={
            "software": _VASP, "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
            "ISIF": 2, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
            "double_relax": True,
        },
        description="VASP double relaxation (atomate2 pattern)",
    ),
    "quacc.recipes.vasp.core.ase_relax_job": RecipeMapping(
        catgo_type="geo_opt",
        default_params={
            "software": _VASP, "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
            "ISIF": 2, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        },
        description="VASP geometry optimisation via ASE optimizer",
    ),
    "quacc.recipes.vasp.core.non_scf_job": RecipeMapping(
        catgo_type="single_point",
        default_params={
            "software": _VASP, "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
            "ICHARG": 11,
        },
        description="VASP non-SCF calculation (DOS / band structure)",
    ),

    # -- slabs --
    "quacc.recipes.vasp.slabs.slab_static_job": RecipeMapping(
        catgo_type="single_point",
        default_params={
            "software": _VASP, "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": True,
            "LDIPOL": True,
        },
        description="VASP slab single-point (dipole-corrected)",
    ),
    "quacc.recipes.vasp.slabs.slab_relax_job": RecipeMapping(
        catgo_type="geo_opt",
        default_params={
            "software": _VASP, "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
            "ISIF": 2, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
            "LDIPOL": True,
        },
        description="VASP slab relaxation (dipole-corrected)",
    ),
    "quacc.recipes.vasp.slabs.bulk_to_slabs_flow": RecipeMapping(
        catgo_type="slab_gen",
        default_params={},
        description="VASP bulk-to-slabs workflow (generate + relax)",
    ),

    # -- MP-compatible --
    "quacc.recipes.vasp.mp.mp_relax_job": RecipeMapping(
        catgo_type="geo_opt",
        default_params={
            "software": _VASP, "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
            "ISIF": 3, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        },
        description="VASP Materials Project-compatible relaxation",
    ),
    "quacc.recipes.vasp.mp.mp_relax_flow": RecipeMapping(
        catgo_type="geo_opt",
        default_params={
            "software": _VASP, "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
            "ISIF": 3, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
            "double_relax": True,
        },
        description="VASP MP double relaxation flow",
    ),

    # -- phonons / elastic --
    "quacc.recipes.vasp.phonons.phonon_flow": RecipeMapping(
        catgo_type="freq",
        default_params={
            "software": _VASP, "ENCUT": 520, "EDIFF": "1e-7", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "IBRION": -1,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        },
        description="VASP phonon calculation (finite displacement)",
    ),

    # -- MD --
    "quacc.recipes.vasp.md.md_job": RecipeMapping(
        catgo_type="md",
        default_params={
            "software": _VASP, "ENCUT": 520, "EDIFF": "1e-5",
            "PREC": "Normal", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "IBRION": 0, "NSW": 5000, "POTIM": 1.0, "TEBEG": 300,
            "LWAVE": False, "LCHARG": False,
        },
        description="VASP ab initio molecular dynamics",
    ),

    # ====================================================================
    # ORCA recipes
    # ====================================================================

    "quacc.recipes.orca.core.static_job": RecipeMapping(
        catgo_type="single_point",
        default_params={
            "software": _ORCA, "system_type": "molecular",
            "method": "B3LYP", "basis": "def2-SVP",
            "charge": 0, "multiplicity": 1,
        },
        description="ORCA single-point energy calculation",
    ),
    "quacc.recipes.orca.core.relax_job": RecipeMapping(
        catgo_type="geo_opt",
        default_params={
            "software": _ORCA, "system_type": "molecular",
            "method": "B3LYP", "basis": "def2-SVP",
            "charge": 0, "multiplicity": 1,
        },
        description="ORCA geometry optimisation",
    ),
    "quacc.recipes.orca.core.freq_job": RecipeMapping(
        catgo_type="freq",
        default_params={
            "software": _ORCA, "system_type": "molecular",
            "method": "B3LYP", "basis": "def2-SVP",
            "charge": 0, "multiplicity": 1,
        },
        description="ORCA frequency / vibrational analysis",
    ),
    "quacc.recipes.orca.core.ase_relax_job": RecipeMapping(
        catgo_type="geo_opt",
        default_params={
            "software": _ORCA, "system_type": "molecular",
            "method": "B3LYP", "basis": "def2-SVP",
            "charge": 0, "multiplicity": 1,
        },
        description="ORCA geometry optimisation via ASE optimizer",
    ),

    # ====================================================================
    # Gaussian recipes
    # ====================================================================

    "quacc.recipes.gaussian.core.static_job": RecipeMapping(
        catgo_type="single_point",
        default_params={
            "software": _GAUSSIAN, "system_type": "molecular",
            "method": "B3LYP", "basis": "6-31G(d)",
            "charge": 0, "multiplicity": 1,
        },
        description="Gaussian single-point energy calculation",
    ),
    "quacc.recipes.gaussian.core.relax_job": RecipeMapping(
        catgo_type="geo_opt",
        default_params={
            "software": _GAUSSIAN, "system_type": "molecular",
            "method": "B3LYP", "basis": "6-31G(d)",
            "charge": 0, "multiplicity": 1,
        },
        description="Gaussian geometry optimisation",
    ),
    "quacc.recipes.gaussian.core.freq_job": RecipeMapping(
        catgo_type="freq",
        default_params={
            "software": _GAUSSIAN, "system_type": "molecular",
            "method": "B3LYP", "basis": "6-31G(d)",
            "charge": 0, "multiplicity": 1,
        },
        description="Gaussian frequency analysis",
    ),

    # ====================================================================
    # xTB / TBLite recipes
    # ====================================================================

    "quacc.recipes.tblite.core.static_job": RecipeMapping(
        catgo_type="single_point",
        default_params={
            "software": _XTB, "method": "GFN2-xTB",
            "accuracy": 1.0, "electronic_temperature": 300,
        },
        description="TBLite (xTB) single-point calculation",
    ),
    "quacc.recipes.tblite.core.relax_job": RecipeMapping(
        catgo_type="geo_opt",
        default_params={
            "software": _XTB, "method": "GFN2-xTB",
            "fmax": 0.01, "max_steps": 500,
            "accuracy": 1.0, "electronic_temperature": 300,
        },
        description="TBLite (xTB) geometry optimisation",
    ),
    "quacc.recipes.tblite.core.freq_job": RecipeMapping(
        catgo_type="freq",
        default_params={
            "software": _XTB, "method": "GFN2-xTB",
            "accuracy": 1.0, "electronic_temperature": 300,
        },
        description="TBLite (xTB) frequency analysis",
    ),

    # Legacy xtb module path
    "quacc.recipes.xtb.core.static_job": RecipeMapping(
        catgo_type="single_point",
        default_params={
            "software": _XTB, "method": "GFN2-xTB",
            "accuracy": 1.0, "electronic_temperature": 300,
        },
        description="xTB single-point calculation",
    ),
    "quacc.recipes.xtb.core.relax_job": RecipeMapping(
        catgo_type="geo_opt",
        default_params={
            "software": _XTB, "method": "GFN2-xTB",
            "fmax": 0.01, "max_steps": 500,
            "accuracy": 1.0, "electronic_temperature": 300,
        },
        description="xTB geometry optimisation",
    ),

    # ====================================================================
    # MLP / ML potential recipes (MACE, CHGNet, M3GNet, etc.)
    # ====================================================================

    "quacc.recipes.mlp.core.static_job": RecipeMapping(
        catgo_type="single_point",
        default_params={"software": _MLP, "model": "MACE"},
        description="ML potential single-point calculation",
    ),
    "quacc.recipes.mlp.core.relax_job": RecipeMapping(
        catgo_type="geo_opt",
        default_params={"software": _MLP, "model": "MACE", "fmax": 0.01},
        description="ML potential geometry optimisation",
    ),
    "quacc.recipes.mlp.core.freq_job": RecipeMapping(
        catgo_type="freq",
        default_params={"software": _MLP, "model": "MACE"},
        description="ML potential frequency analysis",
    ),
    "quacc.recipes.mlp.md.md_job": RecipeMapping(
        catgo_type="md",
        default_params={"software": _MLP, "model": "MACE"},
        description="ML potential molecular dynamics",
    ),

    # NewtonNet
    "quacc.recipes.newtonnet.core.static_job": RecipeMapping(
        catgo_type="single_point",
        default_params={"software": _MLP, "model": "NewtonNet"},
        description="NewtonNet single-point calculation",
    ),
    "quacc.recipes.newtonnet.core.relax_job": RecipeMapping(
        catgo_type="geo_opt",
        default_params={"software": _MLP, "model": "NewtonNet"},
        description="NewtonNet geometry optimisation",
    ),
    "quacc.recipes.newtonnet.ts.ts_job": RecipeMapping(
        catgo_type="ts_search",
        default_params={"software": "sella"},
        description="NewtonNet transition state search",
    ),
    "quacc.recipes.newtonnet.ts.irc_job": RecipeMapping(
        catgo_type="irc",
        default_params={"software": _ORCA},
        description="NewtonNet IRC calculation",
    ),

    # ====================================================================
    # Quantum ESPRESSO recipes  (new CatGo node types)
    # ====================================================================

    "quacc.recipes.espresso.core.static_job": RecipeMapping(
        catgo_type="qe_scf",
        default_params={
            "software": "qe", "ecutwfc": 60, "ecutrho": 480,
        },
        is_new_node=True,
        description="Quantum ESPRESSO SCF calculation",
    ),
    "quacc.recipes.espresso.core.relax_job": RecipeMapping(
        catgo_type="qe_relax",
        default_params={
            "software": "qe", "ecutwfc": 60, "ecutrho": 480,
            "fmax": 0.01,
        },
        is_new_node=True,
        description="Quantum ESPRESSO geometry relaxation",
    ),
    "quacc.recipes.espresso.core.ase_relax_job": RecipeMapping(
        catgo_type="qe_relax",
        default_params={
            "software": "qe", "ecutwfc": 60, "ecutrho": 480,
            "fmax": 0.01,
        },
        is_new_node=True,
        description="Quantum ESPRESSO relaxation via ASE optimizer",
    ),
    "quacc.recipes.espresso.core.non_scf_job": RecipeMapping(
        catgo_type="qe_scf",
        default_params={
            "software": "qe", "ecutwfc": 60, "ecutrho": 480,
            "calculation": "nscf",
        },
        is_new_node=True,
        description="Quantum ESPRESSO non-SCF calculation",
    ),
    "quacc.recipes.espresso.dos.dos_job": RecipeMapping(
        catgo_type="qe_dos",
        default_params={
            "software": "qe", "ecutwfc": 60, "ecutrho": 480,
        },
        is_new_node=True,
        description="Quantum ESPRESSO density of states",
    ),
    "quacc.recipes.espresso.dos.projwfc_job": RecipeMapping(
        catgo_type="qe_dos",
        default_params={
            "software": "qe", "ecutwfc": 60, "ecutrho": 480,
            "projected": True,
        },
        is_new_node=True,
        description="Quantum ESPRESSO projected DOS",
    ),
    "quacc.recipes.espresso.bands.bands_job": RecipeMapping(
        catgo_type="qe_bands",
        default_params={
            "software": "qe", "ecutwfc": 60, "ecutrho": 480,
            "kpoints_density": 40,
        },
        is_new_node=True,
        description="Quantum ESPRESSO band structure",
    ),
    "quacc.recipes.espresso.phonons.phonon_job": RecipeMapping(
        catgo_type="qe_phonon",
        default_params={
            "software": "qe", "ecutwfc": 60, "ecutrho": 480,
        },
        is_new_node=True,
        description="Quantum ESPRESSO phonon calculation (DFPT)",
    ),

    # ====================================================================
    # Q-Chem recipes  (new CatGo node types)
    # ====================================================================

    "quacc.recipes.qchem.core.static_job": RecipeMapping(
        catgo_type="qchem_sp",
        default_params={
            "software": "qchem", "system_type": "molecular",
            "method": "B3LYP", "basis": "6-31G*",
            "charge": 0, "multiplicity": 1,
        },
        is_new_node=True,
        description="Q-Chem single-point energy calculation",
    ),
    "quacc.recipes.qchem.core.relax_job": RecipeMapping(
        catgo_type="qchem_opt",
        default_params={
            "software": "qchem", "system_type": "molecular",
            "method": "B3LYP", "basis": "6-31G*",
            "charge": 0, "multiplicity": 1,
        },
        is_new_node=True,
        description="Q-Chem geometry optimisation",
    ),
    "quacc.recipes.qchem.core.freq_job": RecipeMapping(
        catgo_type="qchem_freq",
        default_params={
            "software": "qchem", "system_type": "molecular",
            "method": "B3LYP", "basis": "6-31G*",
            "charge": 0, "multiplicity": 1,
        },
        is_new_node=True,
        description="Q-Chem frequency analysis",
    ),
    "quacc.recipes.qchem.ts.ts_job": RecipeMapping(
        catgo_type="qchem_ts",
        default_params={
            "software": "qchem", "system_type": "molecular",
            "method": "B3LYP", "basis": "6-31G*",
            "charge": 0, "multiplicity": 1,
        },
        is_new_node=True,
        description="Q-Chem transition state search",
    ),

    # ====================================================================
    # Psi4 recipes  (new CatGo node types)
    # ====================================================================

    "quacc.recipes.psi4.core.static_job": RecipeMapping(
        catgo_type="psi4_sp",
        default_params={"software": "psi4", "system_type": "molecular"},
        is_new_node=True,
        description="Psi4 single-point energy calculation",
    ),
    "quacc.recipes.psi4.core.relax_job": RecipeMapping(
        catgo_type="psi4_opt",
        default_params={"software": "psi4", "system_type": "molecular"},
        is_new_node=True,
        description="Psi4 geometry optimisation",
    ),

    # ====================================================================
    # DFTB+ recipes  (new CatGo node types)
    # ====================================================================

    "quacc.recipes.dftbplus.core.static_job": RecipeMapping(
        catgo_type="dftbplus_sp",
        default_params={"software": "dftbplus"},
        is_new_node=True,
        description="DFTB+ single-point calculation",
    ),
    "quacc.recipes.dftbplus.core.relax_job": RecipeMapping(
        catgo_type="dftbplus_opt",
        default_params={"software": "dftbplus"},
        is_new_node=True,
        description="DFTB+ geometry optimisation",
    ),

    # ====================================================================
    # GULP recipes  (new CatGo node types)
    # ====================================================================

    "quacc.recipes.gulp.core.static_job": RecipeMapping(
        catgo_type="gulp_sp",
        default_params={"software": "gulp"},
        is_new_node=True,
        description="GULP single-point calculation",
    ),
    "quacc.recipes.gulp.core.relax_job": RecipeMapping(
        catgo_type="gulp_opt",
        default_params={"software": "gulp"},
        is_new_node=True,
        description="GULP geometry optimisation",
    ),

    # ====================================================================
    # ONETEP recipes  (new CatGo node types)
    # ====================================================================

    "quacc.recipes.onetep.core.static_job": RecipeMapping(
        catgo_type="onetep_sp",
        default_params={"software": "onetep"},
        is_new_node=True,
        description="ONETEP single-point calculation",
    ),
    "quacc.recipes.onetep.core.relax_job": RecipeMapping(
        catgo_type="onetep_opt",
        default_params={"software": "onetep"},
        is_new_node=True,
        description="ONETEP geometry optimisation",
    ),

    # ====================================================================
    # LJ (Lennard-Jones) — primarily for testing
    # ====================================================================

    "quacc.recipes.lj.core.static_job": RecipeMapping(
        catgo_type="single_point",
        default_params={"software": _MLP, "model": "LJ"},
        description="Lennard-Jones single-point (testing)",
    ),
    "quacc.recipes.lj.core.relax_job": RecipeMapping(
        catgo_type="geo_opt",
        default_params={"software": _MLP, "model": "LJ"},
        description="Lennard-Jones relaxation (testing)",
    ),

    # ====================================================================
    # EMT (Effective Medium Theory) — primarily for testing
    # ====================================================================

    "quacc.recipes.emt.core.static_job": RecipeMapping(
        catgo_type="single_point",
        default_params={"software": _MLP, "model": "EMT"},
        description="EMT single-point (testing)",
    ),
    "quacc.recipes.emt.core.relax_job": RecipeMapping(
        catgo_type="geo_opt",
        default_params={"software": _MLP, "model": "EMT"},
        description="EMT relaxation (testing)",
    ),
}


# ---------------------------------------------------------------------------
# Parameter extraction
# ---------------------------------------------------------------------------

def _extract_vasp_params(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Map quacc VASP recipe kwargs to CatGo VASP parameters."""
    params: dict[str, Any] = {}

    # Direct INCAR-style kwargs that quacc passes through
    _incar_keys = {
        "encut": "ENCUT",
        "ediff": "EDIFF",
        "ediffg": "EDIFFG",
        "isif": "ISIF",
        "nsw": "NSW",
        "ismear": "ISMEAR",
        "ispin": "ISPIN",
        "ibrion": "IBRION",
        "prec": "PREC",
        "lorbit": "LORBIT",
        "ncore": "NCORE",
        "lwave": "LWAVE",
        "lcharg": "LCHARG",
        "ldipol": "LDIPOL",
    }
    for qk, ck in _incar_keys.items():
        if qk in kwargs:
            params[ck] = kwargs[qk]
        elif qk.upper() in kwargs:
            params[ck] = kwargs[qk.upper()]

    # quacc often wraps INCAR overrides inside a dict
    if "incar_settings" in kwargs:
        for qk, ck in _incar_keys.items():
            if qk.upper() in kwargs["incar_settings"]:
                params[ck] = kwargs["incar_settings"][qk.upper()]

    # K-points
    kpts = kwargs.get("kpts") or kwargs.get("kpoints")
    if kpts and isinstance(kpts, (list, tuple)) and len(kpts) == 3:
        params["kpoints"] = f"{kpts[0]}\u00d7{kpts[1]}\u00d7{kpts[2]}"

    # relax_cell flag -> ISIF
    if kwargs.get("relax_cell"):
        params["ISIF"] = 3

    return params


def _extract_ase_opt_params(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Extract ASE-style optimiser settings used by many quacc recipes."""
    params: dict[str, Any] = {}
    opt = kwargs.get("opt_params") or {}

    if "fmax" in opt:
        params["fmax"] = opt["fmax"]
    elif "fmax" in kwargs:
        params["fmax"] = kwargs["fmax"]

    if "max_steps" in opt:
        params["max_steps"] = opt["max_steps"]
    elif "max_steps" in kwargs:
        params["max_steps"] = kwargs["max_steps"]

    if "optimizer" in opt:
        params["optimizer"] = opt["optimizer"]

    return params


def _extract_orca_params(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Map quacc ORCA recipe kwargs to CatGo ORCA parameters."""
    params: dict[str, Any] = {}

    if "charge" in kwargs:
        params["charge"] = kwargs["charge"]
    if "mult" in kwargs or "multiplicity" in kwargs:
        params["multiplicity"] = kwargs.get("mult") or kwargs.get("multiplicity")
    if "method" in kwargs:
        params["method"] = kwargs["method"]
    if "basis" in kwargs:
        params["basis"] = kwargs["basis"]

    # quacc uses orcasimpleinput for method/basis
    orca_input = kwargs.get("orcasimpleinput") or kwargs.get("input_swaps") or {}
    if isinstance(orca_input, str):
        # e.g. "B3LYP def2-SVP"
        parts = orca_input.split()
        if parts:
            params.setdefault("method", parts[0])
        if len(parts) > 1:
            params.setdefault("basis", parts[1])

    params.update(_extract_ase_opt_params(kwargs))
    return params


def _extract_gaussian_params(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Map quacc Gaussian recipe kwargs to CatGo Gaussian parameters."""
    params: dict[str, Any] = {}

    if "charge" in kwargs:
        params["charge"] = kwargs["charge"]
    if "mult" in kwargs or "multiplicity" in kwargs:
        params["multiplicity"] = kwargs.get("mult") or kwargs.get("multiplicity")
    if "method" in kwargs:
        params["method"] = kwargs["method"]
    if "basis" in kwargs:
        params["basis"] = kwargs["basis"]

    # route_keyword patterns
    route = kwargs.get("route_keyword") or kwargs.get("xc") or ""
    if isinstance(route, str) and route:
        parts = route.strip().split()
        if parts:
            params.setdefault("method", parts[0])

    return params


def _extract_xtb_params(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Map quacc xTB / TBLite recipe kwargs to CatGo xTB parameters."""
    params: dict[str, Any] = {}

    method = kwargs.get("method")
    if method:
        params["method"] = method

    params.update(_extract_ase_opt_params(kwargs))
    return params


def _extract_mlp_params(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Map quacc MLP recipe kwargs to CatGo MLP parameters."""
    params: dict[str, Any] = {}

    method = kwargs.get("method")
    if method:
        # quacc uses "mace_mp" -> CatGo "MACE", "chgnet" -> "CHGNet", etc.
        _model_map = {
            "mace_mp": "MACE",
            "mace-mp": "MACE",
            "mace": "MACE",
            "chgnet": "CHGNet",
            "m3gnet": "M3GNet",
        }
        params["model"] = _model_map.get(method.lower(), method)

    params.update(_extract_ase_opt_params(kwargs))
    return params


def _extract_qe_params(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Map quacc Quantum ESPRESSO recipe kwargs to parameters."""
    params: dict[str, Any] = {}

    # input_data dict is the main configuration for QE
    input_data = kwargs.get("input_data") or {}
    system = input_data.get("system") or input_data.get("SYSTEM") or {}
    if "ecutwfc" in system:
        params["ecutwfc"] = system["ecutwfc"]
    if "ecutrho" in system:
        params["ecutrho"] = system["ecutrho"]

    kpts = kwargs.get("kpts")
    if kpts and isinstance(kpts, (list, tuple)) and len(kpts) == 3:
        params["kpoints"] = f"{kpts[0]}\u00d7{kpts[1]}\u00d7{kpts[2]}"

    # Pseudopotentials
    pseudopotentials = kwargs.get("pseudopotentials")
    if pseudopotentials:
        params["pseudopotentials"] = pseudopotentials

    params.update(_extract_ase_opt_params(kwargs))
    return params


def _extract_qchem_params(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Map quacc Q-Chem recipe kwargs to parameters."""
    params: dict[str, Any] = {}

    if "charge" in kwargs:
        params["charge"] = kwargs["charge"]
    if "mult" in kwargs or "multiplicity" in kwargs:
        params["multiplicity"] = kwargs.get("mult") or kwargs.get("multiplicity")
    if "method" in kwargs:
        params["method"] = kwargs["method"]
    if "basis" in kwargs:
        params["basis"] = kwargs["basis"]

    # Q-Chem rem section
    rem = kwargs.get("rem") or {}
    if "method" in rem:
        params.setdefault("method", rem["method"])
    if "basis" in rem:
        params.setdefault("basis", rem["basis"])

    return params


# Dispatcher: recipe module prefix -> param extractor
_EXTRACTORS: dict[str, Any] = {
    "quacc.recipes.vasp": _extract_vasp_params,
    "quacc.recipes.orca": _extract_orca_params,
    "quacc.recipes.gaussian": _extract_gaussian_params,
    "quacc.recipes.tblite": _extract_xtb_params,
    "quacc.recipes.xtb": _extract_xtb_params,
    "quacc.recipes.mlp": _extract_mlp_params,
    "quacc.recipes.newtonnet": _extract_mlp_params,
    "quacc.recipes.espresso": _extract_qe_params,
    "quacc.recipes.qchem": _extract_qchem_params,
    "quacc.recipes.psi4": _extract_qchem_params,  # similar interface
    "quacc.recipes.emt": _extract_ase_opt_params,
    "quacc.recipes.lj": _extract_ase_opt_params,
    "quacc.recipes.dftbplus": _extract_xtb_params,
    "quacc.recipes.gulp": _extract_ase_opt_params,
    "quacc.recipes.onetep": _extract_ase_opt_params,
}


def extract_recipe_params(recipe_path: str, kwargs: dict[str, Any]) -> dict[str, Any]:
    """Map quacc recipe keyword arguments to CatGo node parameters.

    Parameters
    ----------
    recipe_path:
        Fully-qualified recipe path, e.g.
        ``"quacc.recipes.vasp.core.relax_job"``.
    kwargs:
        The ``**kwargs`` dict passed to the quacc recipe function.

    Returns
    -------
    dict
        Merged parameter dict suitable for a CatGo workflow node.
        Starts from the mapping's ``default_params`` and overlays any
        extracted values from *kwargs*.
    """
    mapping = RECIPE_TO_CATGO.get(recipe_path)
    if mapping is None:
        return {}

    # Start from defaults
    params = dict(mapping.default_params)

    # Find the right extractor by matching the longest prefix
    extractor = None
    for prefix in sorted(_EXTRACTORS, key=len, reverse=True):
        if recipe_path.startswith(prefix):
            extractor = _EXTRACTORS[prefix]
            break

    if extractor is not None:
        extracted = extractor(kwargs)
        params.update(extracted)

    return params


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    errors: list[str] = []

    # 1) VASP relax_job -> geo_opt with software=vasp
    m = RECIPE_TO_CATGO["quacc.recipes.vasp.core.relax_job"]
    assert m.catgo_type == "geo_opt", f"Expected geo_opt, got {m.catgo_type}"
    assert m.default_params.get("software") == "vasp", (
        f"Expected software=vasp, got {m.default_params.get('software')}"
    )
    assert not m.is_new_node, "VASP relax should map to existing node"

    # 2) ORCA static_job -> single_point with software=orca
    m = RECIPE_TO_CATGO["quacc.recipes.orca.core.static_job"]
    assert m.catgo_type == "single_point", f"Expected single_point, got {m.catgo_type}"
    assert m.default_params.get("software") == "orca", (
        f"Expected software=orca, got {m.default_params.get('software')}"
    )
    assert not m.is_new_node, "ORCA static should map to existing node"

    # 3) Q-Chem static_job -> new node type (qchem_sp)
    m = RECIPE_TO_CATGO["quacc.recipes.qchem.core.static_job"]
    assert m.catgo_type == "qchem_sp", f"Expected qchem_sp, got {m.catgo_type}"
    assert m.is_new_node, "Q-Chem should be a new node type"

    # 4) Parameter extraction: VASP with ENCUT override
    p = extract_recipe_params("quacc.recipes.vasp.core.relax_job", {"ENCUT": 600})
    assert p.get("ENCUT") == 600, f"Expected ENCUT=600, got {p.get('ENCUT')}"
    assert p.get("software") == "vasp", f"Expected software=vasp in extracted params"

    # 5) Parameter extraction: ORCA with method/basis
    p = extract_recipe_params("quacc.recipes.orca.core.static_job", {
        "charge": -1,
        "mult": 2,
    })
    assert p.get("charge") == -1, f"Expected charge=-1, got {p.get('charge')}"
    assert p.get("multiplicity") == 2, f"Expected multiplicity=2, got {p.get('multiplicity')}"

    # 6) relax_cell flag -> ISIF 3
    p = extract_recipe_params("quacc.recipes.vasp.core.relax_job", {"relax_cell": True})
    assert p.get("ISIF") == 3, f"Expected ISIF=3 with relax_cell, got {p.get('ISIF')}"

    # 7) opt_params extraction
    p = extract_recipe_params("quacc.recipes.tblite.core.relax_job", {
        "opt_params": {"fmax": 0.005, "max_steps": 300},
    })
    assert p.get("fmax") == 0.005, f"Expected fmax=0.005, got {p.get('fmax')}"
    assert p.get("max_steps") == 300, f"Expected max_steps=300, got {p.get('max_steps')}"

    # 8) QE params
    m = RECIPE_TO_CATGO["quacc.recipes.espresso.core.static_job"]
    assert m.is_new_node, "QE should be a new node type"
    assert m.catgo_type == "qe_scf"

    # 9) get_recipe_path helper
    path = get_recipe_path("relax_job", "quacc.recipes.vasp.core")
    assert path == "quacc.recipes.vasp.core.relax_job"

    # 10) Unknown recipe returns empty dict
    p = extract_recipe_params("quacc.recipes.nonexistent.foo", {"x": 1})
    assert p == {}, f"Expected empty dict for unknown recipe, got {p}"

    # Count coverage
    new_nodes = [m for m in RECIPE_TO_CATGO.values() if m.is_new_node]
    existing_nodes = [m for m in RECIPE_TO_CATGO.values() if not m.is_new_node]

    print(f"All tests passed.")
    print(f"Total mappings: {len(RECIPE_TO_CATGO)}")
    print(f"  Existing CatGo nodes: {len(existing_nodes)}")
    print(f"  New node types needed: {len(new_nodes)}")
    print(f"  New node type names: {sorted(set(m.catgo_type for m in new_nodes))}")
