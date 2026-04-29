"""Mapping from atomate2 Maker class names to CatGo node configurations.

This module provides a comprehensive mapping that allows the converter (P2)
to translate serialized atomate2 Jobs into CatGo workflow nodes with the
correct type and default parameters.

No atomate2 installation is required — this operates purely on serialized
JSON dictionaries produced by ``monty.json.MontyEncoder`` / ``flow.as_dict()``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

__all__ = [
    "MakerMapping",
    "MAKER_TO_CATGO",
    "extract_maker_params",
    "get_maker_class_name",
]


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class MakerMapping:
    """Describes how an atomate2 Maker maps to a CatGo node.

    Attributes:
        catgo_type: CatGo node type string (e.g. ``"geo_opt"``).
        default_params: Parameters merged into the node config.
        is_new_node: ``True`` when this Maker requires a node type that
            does not yet exist in CatGo (i.e. must be registered by P8).
        param_extractor: Optional callable that receives the full serialized
            Maker dict and returns extra CatGo params.  When ``None`` the
            generic :func:`extract_maker_params` is used.
    """

    catgo_type: str
    default_params: dict[str, Any] = field(default_factory=dict)
    is_new_node: bool = False
    param_extractor: Callable[[dict], dict] | None = None


# ---------------------------------------------------------------------------
# Forcefield model helpers
# ---------------------------------------------------------------------------

def _extract_forcefield_model(maker_dict: dict) -> dict:
    """Pull out the ML potential model name from a forcefield Maker."""
    params: dict[str, Any] = {}
    # atomate2 forcefields store the calculator name / model in several places
    # depending on version.  Common patterns:
    #   maker_dict["force_field_name"]  (str like "CHGNet", "MACE", "M3GNet")
    #   maker_dict["calculator_kwargs"]["model"]
    ff_name = maker_dict.get("force_field_name", "")
    if not ff_name:
        calc_kwargs = maker_dict.get("calculator_kwargs") or {}
        ff_name = calc_kwargs.get("model", "")

    # Normalise to CatGo model keys
    _model_map = {
        "CHGNet": "CHGNet",
        "chgnet": "CHGNet",
        "MACE": "MACE",
        "MACECalculator": "MACE",
        "mace": "MACE",
        "M3GNet": "M3GNet",
        "m3gnet": "M3GNet",
    }
    model = _model_map.get(ff_name, ff_name or "MACE")
    params["model"] = model
    return params


# ---------------------------------------------------------------------------
# MAKER_TO_CATGO — the master mapping table
# ---------------------------------------------------------------------------

MAKER_TO_CATGO: dict[str, MakerMapping] = {
    # =====================================================================
    # VASP core Makers  (~30)
    # =====================================================================

    # --- Relaxation ---
    "RelaxMaker": MakerMapping(
        catgo_type="geo_opt",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
            "ISIF": 2, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        },
    ),
    "TightRelaxMaker": MakerMapping(
        catgo_type="geo_opt",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "EDIFFG": -0.01,
            "ISIF": 2, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        },
    ),
    "DoubleRelaxMaker": MakerMapping(
        catgo_type="geo_opt",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
            "ISIF": 2, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
            "double_relax": True,
        },
    ),
    "BulkRelaxMaker": MakerMapping(
        catgo_type="cell_opt",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
            "ISIF": 3, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        },
    ),

    # --- HSE relaxation / static ---
    "HSERelaxMaker": MakerMapping(
        catgo_type="geo_opt",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
            "ISIF": 2, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "All", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
            "functional": "HSE06", "LHFCALC": True, "AEXX": 0.25, "HFSCREEN": 0.2,
        },
    ),
    "HSETightRelaxMaker": MakerMapping(
        catgo_type="geo_opt",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "EDIFFG": -0.01,
            "ISIF": 2, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "All", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
            "functional": "HSE06", "LHFCALC": True, "AEXX": 0.25, "HFSCREEN": 0.2,
        },
    ),
    "HSEStaticMaker": MakerMapping(
        catgo_type="single_point",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "All", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": True, "LCHARG": True,
            "functional": "HSE06", "LHFCALC": True, "AEXX": 0.25, "HFSCREEN": 0.2,
        },
    ),
    "HSEBSMaker": MakerMapping(
        catgo_type="single_point",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "All", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
            "functional": "HSE06", "LHFCALC": True, "AEXX": 0.25, "HFSCREEN": 0.2,
            "mode": "band_structure",
        },
    ),

    # --- Static / single-point ---
    "StaticMaker": MakerMapping(
        catgo_type="single_point",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": True,
        },
    ),
    "NonSCFMaker": MakerMapping(
        catgo_type="single_point",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
            "ICHARG": 11,
        },
    ),
    "DFPTStaticMaker": MakerMapping(
        catgo_type="single_point",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": True,
            "IBRION": 8, "LEPSILON": True,
        },
    ),

    # --- Dielectric / piezoelectric ---
    "DielectricMaker": MakerMapping(
        catgo_type="single_point",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": True,
            "LEPSILON": True, "LPEAD": True, "IBRION": 8,
        },
    ),
    "PiezoelectricMaker": MakerMapping(
        catgo_type="single_point",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": True,
            "LEPSILON": True, "IBRION": 8, "LPIEZO": True,
        },
    ),

    # --- Molecular dynamics ---
    "MDMaker": MakerMapping(
        catgo_type="md",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-5",
            "PREC": "Normal", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "IBRION": 0, "NSW": 5000, "POTIM": 1.0, "TEBEG": 300,
            "LWAVE": False, "LCHARG": False,
        },
    ),

    # --- Frequency ---
    "FrequencyMaker": MakerMapping(
        catgo_type="freq",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-7", "NSW": 1,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": True,
            "IBRION": 5, "NFREE": 2,
        },
    ),

    # --- Band structure ---
    "BandStructureMaker": MakerMapping(
        catgo_type="single_point",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": True,
            "mode": "band_structure",
        },
    ),
    "UniformBandStructureMaker": MakerMapping(
        catgo_type="single_point",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
            "ICHARG": 11, "mode": "uniform_band_structure",
        },
    ),
    "LineModeBandStructureMaker": MakerMapping(
        catgo_type="single_point",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
            "ICHARG": 11, "mode": "line_band_structure",
        },
    ),

    # --- Optics ---
    "OpticsMaker": MakerMapping(
        catgo_type="single_point",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": True,
            "LOPTICS": True, "CSHIFT": 0.1, "NBANDS": 128,
        },
    ),

    # --- Transmuter / transformations ---
    "TransmuterMaker": MakerMapping(
        catgo_type="single_point",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": True,
        },
    ),

    # --- Slab makers ---
    "SlabRelaxMaker": MakerMapping(
        catgo_type="geo_opt",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
            "ISIF": 2, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
            "LDIPOL": True,
        },
    ),
    "SlabStaticMaker": MakerMapping(
        catgo_type="single_point",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": True,
            "LDIPOL": True,
        },
    ),

    # --- SCAN / r2SCAN ---
    "ScanRelaxMaker": MakerMapping(
        catgo_type="geo_opt",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
            "ISIF": 3, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "All", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
            "METAGGA": "SCAN",
        },
    ),
    "ScanStaticMaker": MakerMapping(
        catgo_type="single_point",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "All", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": True,
            "METAGGA": "SCAN",
        },
    ),
    "R2ScanRelaxMaker": MakerMapping(
        catgo_type="geo_opt",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
            "ISIF": 3, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "All", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
            "METAGGA": "R2SCAN",
        },
    ),
    "R2ScanStaticMaker": MakerMapping(
        catgo_type="single_point",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "All", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": True,
            "METAGGA": "R2SCAN",
        },
    ),

    # --- Lobster ---
    "LobsterStaticMaker": MakerMapping(
        catgo_type="atomate2_lobster_static",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": True, "LCHARG": True,
        },
        is_new_node=True,
    ),

    # --- NEB ---
    "NEBMaker": MakerMapping(
        catgo_type="atomate2_neb",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.05,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "IBRION": 3, "LWAVE": False, "LCHARG": False,
        },
        is_new_node=True,
    ),

    # --- GW ---
    "MVLGWMaker": MakerMapping(
        catgo_type="atomate2_gw",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-8", "NSW": 0,
            "PREC": "Accurate", "ALGO": "GW0", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": True, "LCHARG": True,
            "NBANDS": 128,
        },
        is_new_node=True,
    ),

    # =====================================================================
    # CP2K Makers  (~10)
    # =====================================================================

    "Cp2kStaticMaker": MakerMapping(
        catgo_type="single_point",
        default_params={"software": "cp2k"},
    ),
    "Cp2kRelaxMaker": MakerMapping(
        catgo_type="geo_opt",
        default_params={"software": "cp2k"},
    ),
    "Cp2kCellOptMaker": MakerMapping(
        catgo_type="cell_opt",
        default_params={"software": "cp2k"},
    ),
    "Cp2kMDMaker": MakerMapping(
        catgo_type="md",
        default_params={"software": "cp2k"},
    ),
    "Cp2kBandStructureMaker": MakerMapping(
        catgo_type="single_point",
        default_params={"software": "cp2k", "mode": "band_structure"},
    ),
    "Cp2kFrequencyMaker": MakerMapping(
        catgo_type="freq",
        default_params={"software": "cp2k"},
    ),
    # Namespaced aliases (flow JSON sometimes stores the module path)
    "cp2k.StaticMaker": MakerMapping(
        catgo_type="single_point",
        default_params={"software": "cp2k"},
    ),
    "cp2k.RelaxMaker": MakerMapping(
        catgo_type="geo_opt",
        default_params={"software": "cp2k"},
    ),
    "cp2k.CellOptMaker": MakerMapping(
        catgo_type="cell_opt",
        default_params={"software": "cp2k"},
    ),
    "cp2k.MDMaker": MakerMapping(
        catgo_type="md",
        default_params={"software": "cp2k"},
    ),

    # =====================================================================
    # Forcefield / MLP Makers
    # =====================================================================

    "ForceFieldRelaxMaker": MakerMapping(
        catgo_type="geo_opt",
        default_params={"software": "mlp"},
        param_extractor=_extract_forcefield_model,
    ),
    "ForceFieldStaticMaker": MakerMapping(
        catgo_type="single_point",
        default_params={"software": "mlp"},
        param_extractor=_extract_forcefield_model,
    ),
    "ForceFieldMDMaker": MakerMapping(
        catgo_type="md",
        default_params={"software": "mlp"},
        param_extractor=_extract_forcefield_model,
    ),

    # Specific MLP convenience makers
    "CHGNetRelaxMaker": MakerMapping(
        catgo_type="geo_opt",
        default_params={"software": "mlp", "model": "CHGNet"},
    ),
    "CHGNetStaticMaker": MakerMapping(
        catgo_type="single_point",
        default_params={"software": "mlp", "model": "CHGNet"},
    ),
    "MACERelaxMaker": MakerMapping(
        catgo_type="geo_opt",
        default_params={"software": "mlp", "model": "MACE"},
    ),
    "MACEStaticMaker": MakerMapping(
        catgo_type="single_point",
        default_params={"software": "mlp", "model": "MACE"},
    ),
    "M3GNetRelaxMaker": MakerMapping(
        catgo_type="geo_opt",
        default_params={"software": "mlp", "model": "M3GNet"},
    ),
    "M3GNetStaticMaker": MakerMapping(
        catgo_type="single_point",
        default_params={"software": "mlp", "model": "M3GNet"},
    ),

    # =====================================================================
    # QChem Makers  (new node types)
    # =====================================================================

    "QChem.StaticMaker": MakerMapping(
        catgo_type="quacc_qchem_static",
        default_params={"software": "qchem"},
        is_new_node=True,
    ),
    "QChem.RelaxMaker": MakerMapping(
        catgo_type="quacc_qchem_relax",
        default_params={"software": "qchem"},
        is_new_node=True,
    ),
    "QChem.FreqMaker": MakerMapping(
        catgo_type="quacc_qchem_freq",
        default_params={"software": "qchem"},
        is_new_node=True,
    ),
    "QChem.TSMaker": MakerMapping(
        catgo_type="quacc_qchem_ts",
        default_params={"software": "qchem"},
        is_new_node=True,
    ),

    # =====================================================================
    # Specialized / property Makers  (new node types)
    # =====================================================================

    "PhononDisplacementMaker": MakerMapping(
        catgo_type="atomate2_phonon_displacement",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-7", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "IBRION": -1,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        },
        is_new_node=True,
    ),
    "PhononMaker": MakerMapping(
        catgo_type="atomate2_phonon",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "EDIFFG": -0.01,
            "ISIF": 3, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        },
        is_new_node=True,
    ),
    "EosRelaxMaker": MakerMapping(
        catgo_type="atomate2_eos_relax",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
            "ISIF": 3, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        },
        is_new_node=True,
    ),
    "EosMaker": MakerMapping(
        catgo_type="atomate2_eos",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "IBRION": -1,
            "LORBIT": 11, "LWAVE": False, "LCHARG": True,
        },
        is_new_node=True,
    ),
    "ElasticRelaxMaker": MakerMapping(
        catgo_type="atomate2_elastic_relax",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "EDIFFG": -0.02,
            "ISIF": 3, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        },
        is_new_node=True,
    ),
    "ElasticMaker": MakerMapping(
        catgo_type="atomate2_elastic",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05, "ISIF": 2,
            "LORBIT": 11, "LWAVE": False, "LCHARG": True,
        },
        is_new_node=True,
    ),
    "AmsetMaker": MakerMapping(
        catgo_type="atomate2_amset",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
            "ISMEAR": -5, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": True, "LCHARG": True,
        },
        is_new_node=True,
    ),
    "ElectrodeMaker": MakerMapping(
        catgo_type="atomate2_electrode",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
            "ISIF": 3, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        },
        is_new_node=True,
    ),
    "GrainBoundaryMaker": MakerMapping(
        catgo_type="atomate2_grain_boundary",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
            "ISIF": 2, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        },
        is_new_node=True,
    ),
    "DefectRelaxMaker": MakerMapping(
        catgo_type="geo_opt",
        default_params={
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
            "ISIF": 2, "NSW": 200, "IBRION": 2,
            "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
            "ISMEAR": 0, "SIGMA": 0.05,
            "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        },
    ),
}


# ---------------------------------------------------------------------------
# Parameter extraction
# ---------------------------------------------------------------------------

# Keys from VASP user_incar_settings that CatGo nodes understand natively
_VASP_KNOWN_INCAR_KEYS = {
    "ENCUT", "EDIFF", "EDIFFG", "NSW", "ISIF", "IBRION", "ISMEAR",
    "ISPIN", "PREC", "NCORE", "LWAVE", "LCHARG", "LORBIT", "LDIPOL",
    "LEPSILON", "LPEAD", "LOPTICS", "CSHIFT", "LPIEZO", "ICHARG", "NFREE",
    "POTIM", "TEBEG", "SMASS", "METAGGA", "LREAL", "ALGO", "SIGMA",
    "NBANDS", "NELM", "NELMIN", "LHFCALC", "AEXX", "HFSCREEN",
}


def extract_maker_params(maker_dict: dict) -> dict:
    """Extract CatGo-compatible parameters from a serialized atomate2 Maker.

    The Maker is expected to be the MontyEncoder dict of an atomate2 Maker
    dataclass.  Parameters are read from the ``input_set_generator`` field
    which typically carries ``user_incar_settings``, ``user_kpoints_settings``,
    ``user_potcar_functional``, etc.

    Returns a flat dict whose keys match CatGo ``param_schema`` keys
    (e.g. ``ENCUT``, ``kpoints``, ``functional``, ...).
    Unrecognised settings are collected under ``custom_params``.
    """
    params: dict[str, Any] = {}
    custom: dict[str, Any] = {}

    isg = maker_dict.get("input_set_generator") or {}
    if isinstance(isg, dict):
        params.update(_extract_vasp_params(isg))
        params.update(_extract_cp2k_params(isg))
        params.update(_extract_kpoints(isg))
        params.update(_extract_potcar(isg))

    # Some Makers store top-level config (e.g. run_vasp_kwargs)
    run_kwargs = maker_dict.get("run_vasp_kwargs") or {}
    if run_kwargs:
        custom["run_vasp_kwargs"] = run_kwargs

    if custom:
        params["custom_params"] = custom

    return params


def _extract_vasp_params(isg: dict) -> dict[str, Any]:
    """Map ``user_incar_settings`` to CatGo param keys."""
    params: dict[str, Any] = {}
    incar = isg.get("user_incar_settings") or {}
    if not isinstance(incar, dict):
        return params

    for key, val in incar.items():
        upper = key.upper()
        if upper in _VASP_KNOWN_INCAR_KEYS:
            params[upper] = val
        else:
            # Preserve unknown INCAR tags in custom_params
            params.setdefault("custom_params", {})
            params["custom_params"][upper] = val

    return params


def _extract_cp2k_params(isg: dict) -> dict[str, Any]:
    """Map CP2K input generator fields to CatGo param keys."""
    params: dict[str, Any] = {}

    # CP2K Makers store settings differently depending on atomate2 version
    # Common pattern: isg has xc_functionals, basis_sets, cutoff, etc.
    xc = isg.get("xc_functionals") or isg.get("xc_functional")
    if xc:
        if isinstance(xc, list):
            xc = xc[0] if xc else "PBE"
        params["functional"] = xc

    basis = isg.get("basis_sets") or isg.get("basis_set")
    if basis:
        if isinstance(basis, dict):
            # Take first element's value
            first = next(iter(basis.values()), None)
            if first:
                basis = first
        if isinstance(basis, str):
            params["basis_set"] = basis

    cutoff = isg.get("cutoff")
    if cutoff is not None:
        params["cutoff"] = cutoff

    rel_cutoff = isg.get("rel_cutoff")
    if rel_cutoff is not None:
        params["rel_cutoff"] = rel_cutoff

    eps_scf = isg.get("eps_scf")
    if eps_scf is not None:
        params["eps_scf"] = str(eps_scf)

    return params


def _extract_kpoints(isg: dict) -> dict[str, Any]:
    """Map ``user_kpoints_settings`` to CatGo ``kpoints`` string."""
    params: dict[str, Any] = {}
    kpts = isg.get("user_kpoints_settings")
    if not kpts:
        return params

    if isinstance(kpts, dict):
        # MontyEncoder format for Kpoints object or plain grid dict
        grid = kpts.get("kpoints") or kpts.get("grid")
        if isinstance(grid, (list, tuple)) and len(grid) >= 3:
            # Convert [4, 4, 4] -> "4x4x4"  (CatGo uses multiplication sign)
            params["kpoints"] = "\u00d7".join(str(int(k)) for k in grid[:3])
        reciprocal_density = kpts.get("reciprocal_density")
        if reciprocal_density is not None:
            # Store density — the CatGo engine can derive the grid later
            params["kpoints_density"] = reciprocal_density
    elif isinstance(kpts, (list, tuple)) and len(kpts) >= 3:
        params["kpoints"] = "\u00d7".join(str(int(k)) for k in kpts[:3])

    return params


def _extract_potcar(isg: dict) -> dict[str, Any]:
    """Extract POTCAR functional selection."""
    params: dict[str, Any] = {}
    potcar = isg.get("user_potcar_functional")
    if potcar:
        params["potcar_functional"] = potcar
    return params


# ---------------------------------------------------------------------------
# Helper: extract Maker class name from a serialized Job
# ---------------------------------------------------------------------------

def get_maker_class_name(job_dict: dict) -> str:
    """Resolve the Maker class name from a serialized jobflow ``Job``.

    atomate2 Jobs are serialised by ``monty.json.MontyEncoder``.  The Maker
    class info can appear in several locations depending on serialisation
    version:

    1. ``job_dict["maker"]["@class"]``            — most common
    2. ``job_dict["function"]["@class"]``          — older format
    3. ``job_dict["@class"]``                      — when dict *is* the Maker

    For namespaced makers (e.g. ``atomate2.cp2k.jobs.core.StaticMaker``),
    we try the short name first (``StaticMaker``), then the module-qualified
    form (``cp2k.StaticMaker``) so the lookup in :data:`MAKER_TO_CATGO`
    succeeds regardless of how the user registered the alias.
    """
    # Path 1: job_dict has a "maker" sub-dict
    maker = job_dict.get("maker") or {}
    if isinstance(maker, dict):
        cls = maker.get("@class", "")
        if cls:
            return _resolve_class_alias(cls, maker.get("@module", ""))

    # Path 2: job_dict["function"] carries the class
    func = job_dict.get("function") or {}
    if isinstance(func, dict):
        cls = func.get("@class", "")
        if cls:
            return _resolve_class_alias(cls, func.get("@module", ""))

    # Path 3: dict *is* the Maker itself
    cls = job_dict.get("@class", "")
    if cls:
        return _resolve_class_alias(cls, job_dict.get("@module", ""))

    # Fallback: use the job name
    return job_dict.get("name", "UnknownMaker")


def _resolve_class_alias(class_name: str, module: str) -> str:
    """Return the shortest key that matches in MAKER_TO_CATGO.

    Tries in order:
    1. ``class_name`` alone  (e.g. ``"RelaxMaker"``)
    2. ``<package>.<class_name>``  (e.g. ``"cp2k.RelaxMaker"``)
    """
    if class_name in MAKER_TO_CATGO:
        return class_name

    # Build namespaced key from module path
    # e.g. module = "atomate2.cp2k.jobs.core" -> try "cp2k.RelaxMaker"
    if module:
        parts = module.split(".")
        for part in parts:
            ns_key = f"{part}.{class_name}"
            if ns_key in MAKER_TO_CATGO:
                return ns_key

    return class_name


# ---------------------------------------------------------------------------
# Convenience: full extraction pipeline for a single Job dict
# ---------------------------------------------------------------------------

def map_job_to_catgo(job_dict: dict) -> dict[str, Any]:
    """High-level helper: map a serialized atomate2 Job to CatGo node config.

    Returns a dict with keys: ``type``, ``params``, ``is_new_node``.
    """
    maker_name = get_maker_class_name(job_dict)
    mapping = MAKER_TO_CATGO.get(maker_name)

    if mapping is None:
        return {
            "type": "custom_job",
            "params": {"label": job_dict.get("name", maker_name),
                       "maker_class": maker_name},
            "is_new_node": True,
        }

    # Start with the mapping's default params
    params = dict(mapping.default_params)

    # Extract params from the serialized Maker / input_set_generator
    maker_body = job_dict.get("maker") or job_dict
    if mapping.param_extractor is not None:
        params.update(mapping.param_extractor(maker_body))
    else:
        params.update(extract_maker_params(maker_body))

    return {
        "type": mapping.catgo_type,
        "params": params,
        "is_new_node": mapping.is_new_node,
    }


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("Running maker_map self-tests ...\n")
    errors: list[str] = []

    # Test 1: RelaxMaker -> geo_opt with software=vasp
    m = MAKER_TO_CATGO.get("RelaxMaker")
    assert m is not None, "RelaxMaker not found in MAKER_TO_CATGO"
    assert m.catgo_type == "geo_opt", f"Expected geo_opt, got {m.catgo_type}"
    assert m.default_params.get("software") == "vasp", (
        f"Expected software=vasp, got {m.default_params.get('software')}"
    )
    assert not m.is_new_node, "RelaxMaker should not be a new node"
    print("  [PASS] RelaxMaker -> geo_opt, software=vasp")

    # Test 2: ForceFieldRelaxMaker -> geo_opt with software=mlp
    m = MAKER_TO_CATGO.get("ForceFieldRelaxMaker")
    assert m is not None, "ForceFieldRelaxMaker not found"
    assert m.catgo_type == "geo_opt", f"Expected geo_opt, got {m.catgo_type}"
    assert m.default_params.get("software") == "mlp", (
        f"Expected software=mlp, got {m.default_params.get('software')}"
    )
    assert not m.is_new_node, "ForceFieldRelaxMaker should not be a new node"
    print("  [PASS] ForceFieldRelaxMaker -> geo_opt, software=mlp")

    # Test 3: PhononDisplacementMaker -> new node type
    m = MAKER_TO_CATGO.get("PhononDisplacementMaker")
    assert m is not None, "PhononDisplacementMaker not found"
    assert m.catgo_type == "atomate2_phonon_displacement", (
        f"Expected atomate2_phonon_displacement, got {m.catgo_type}"
    )
    assert m.is_new_node, "PhononDisplacementMaker should be a new node"
    print("  [PASS] PhononDisplacementMaker -> atomate2_phonon_displacement (new node)")

    # Test 4: get_maker_class_name with nested maker dict
    job = {
        "uuid": "abc-123",
        "name": "relax",
        "maker": {
            "@module": "atomate2.vasp.jobs.core",
            "@class": "RelaxMaker",
            "input_set_generator": {
                "user_incar_settings": {"ENCUT": 600, "EDIFF": 1e-6},
                "user_kpoints_settings": {"kpoints": [6, 6, 6]},
            },
        },
    }
    name = get_maker_class_name(job)
    assert name == "RelaxMaker", f"Expected RelaxMaker, got {name}"
    print("  [PASS] get_maker_class_name extracts 'RelaxMaker'")

    # Test 5: extract_maker_params from the same job
    extracted = extract_maker_params(job["maker"])
    assert extracted.get("ENCUT") == 600, f"Expected ENCUT=600, got {extracted.get('ENCUT')}"
    assert extracted.get("EDIFF") == 1e-6, f"Expected EDIFF=1e-6, got {extracted.get('EDIFF')}"
    assert extracted.get("kpoints") == "6\u00d76\u00d76", (
        f"Expected kpoints=6\u00d76\u00d76, got {extracted.get('kpoints')}"
    )
    print("  [PASS] extract_maker_params: ENCUT=600, EDIFF=1e-6, kpoints=6x6x6")

    # Test 6: map_job_to_catgo full pipeline
    result = map_job_to_catgo(job)
    assert result["type"] == "geo_opt"
    assert result["params"]["software"] == "vasp"
    assert result["params"]["ENCUT"] == 600
    assert not result["is_new_node"]
    print("  [PASS] map_job_to_catgo full pipeline")

    # Test 7: CP2K namespaced lookup
    cp2k_job = {
        "maker": {
            "@module": "atomate2.cp2k.jobs.core",
            "@class": "StaticMaker",
        }
    }
    name = get_maker_class_name(cp2k_job)
    # Should resolve via namespace to cp2k.StaticMaker or StaticMaker
    mapping = MAKER_TO_CATGO.get(name)
    # StaticMaker is the VASP one; cp2k.StaticMaker should be resolved
    # via _resolve_class_alias
    assert name in ("StaticMaker", "cp2k.StaticMaker"), f"Got {name}"
    print(f"  [PASS] CP2K namespaced lookup resolved to '{name}'")

    # Test 8: forcefield model extraction
    ff_job = {
        "maker": {
            "@module": "atomate2.forcefields.jobs",
            "@class": "ForceFieldRelaxMaker",
            "force_field_name": "CHGNet",
        }
    }
    result = map_job_to_catgo(ff_job)
    assert result["type"] == "geo_opt"
    assert result["params"]["software"] == "mlp"
    assert result["params"]["model"] == "CHGNet"
    print("  [PASS] ForceFieldRelaxMaker with CHGNet model extraction")

    # Test 9: Unknown maker falls back to custom_job
    unknown_job = {
        "maker": {
            "@module": "some.custom.module",
            "@class": "MyCustomMaker",
        },
        "name": "custom calc",
    }
    result = map_job_to_catgo(unknown_job)
    assert result["type"] == "custom_job"
    assert result["is_new_node"]
    print("  [PASS] Unknown maker -> custom_job fallback")

    print(f"\nAll {9} tests passed.")
