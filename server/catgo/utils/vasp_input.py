"""VASP input file generation utilities."""

from typing import Optional

import numpy as np

from pymatgen.core import Structure
from pymatgen.io.vasp import Incar, Kpoints, Poscar

from catgo.models.structure import PymatgenStructure
from catgo.models.vasp import ConstantPotentialMethod, VASPCalculationType, VASPInputRequest, VASPOptimizerType


def generate_incar(
    request: VASPInputRequest, structure: Structure
) -> Incar:
    """Generate INCAR file based on calculation type, optimizer preset, and parameters.

    Uses templates matching standard VASP calculation setups.
    """
    from pymatgen.io.vasp import Incar

    incar_params = {}

    # Add system title if provided
    if request.system_title:
        incar_params["SYSTEM"] = request.system_title

    # Common defaults from templates
    common_defaults = {
        "ALGO": "Fast",
        "LREAL": "Auto",
        "NELM": 150,
        "NELMIN": 6,
        "ICHARG": 1,
        "ISYM": -1,
        "IVDW": 12,
        "LORBIT": 11,
    }

    # Set calculation-specific defaults based on templates
    if request.calculation_type == VASPCalculationType.OPT:
        # Optimization - default to standard optimizer (no VTST required)
        if request.optimizer == VASPOptimizerType.VTST_FIRE:
            # VTST FIRE optimizer (requires VTST library)
            incar_params.update({
                "ALGO": request.algo if request.algo else "Fast",
                "PREC": request.prec if request.prec else "Accurate",
                "ENCUT": request.encut,
                "GGA": request.gga,
                "EDIFF": request.ediff if request.ediff != 1e-5 else 1e-5,
                "ISMEAR": request.ismear if request.ismear is not None else 0,
                "SIGMA": request.sigma if request.sigma is not None else 0.05,
                "ISPIN": request.ispin if request.ispin is not None else 2,
                "IBRION": 3,
                "IOPT": 7,
                "POTIM": 0,
                "LVTST": True,
                "ISIF": request.isif if request.isif is not None else 2,
                "NSW": request.nsw if request.nsw is not None else 200,
                "EDIFFG": request.ediffg if request.ediffg is not None else -0.05,
                "LWAVE": False,
                "LCHARG": True,
                "NCORE": request.ncore if request.ncore is not None else 24,
            })
        elif request.optimizer == VASPOptimizerType.QUASI_NEWTON:
            # Quasi-Newton optimizer
            incar_params.update({
                "ALGO": request.algo if request.algo else "Fast",
                "PREC": request.prec if request.prec else "Accurate",
                "ENCUT": request.encut,
                "GGA": request.gga,
                "EDIFF": request.ediff if request.ediff != 1e-5 else 1e-5,
                "ISMEAR": request.ismear if request.ismear is not None else 0,
                "SIGMA": request.sigma if request.sigma is not None else 0.05,
                "ISPIN": request.ispin if request.ispin is not None else 2,
                "IBRION": 1,
                "ISIF": request.isif if request.isif is not None else 3,
                "NSW": request.nsw if request.nsw is not None else 100,
                "EDIFFG": request.ediffg if request.ediffg is not None else -0.05,
                **common_defaults,
            })
        else:  # STANDARD or None (default - no VTST required)
            # Standard conjugate gradient optimizer (default)
            incar_params.update({
                "ALGO": request.algo if request.algo else "Fast",
                "PREC": request.prec if request.prec else "Accurate",
                "ENCUT": request.encut,
                "GGA": request.gga,
                "EDIFF": request.ediff if request.ediff != 1e-5 else 1e-5,
                "ISMEAR": request.ismear if request.ismear is not None else 0,
                "SIGMA": request.sigma if request.sigma is not None else 0.05,
                "ISPIN": request.ispin if request.ispin is not None else 2,
                "IBRION": request.ibrion if request.ibrion is not None else 2,  # CG (standard)
                "ISIF": request.isif if request.isif is not None else 3,  # Relax ions + cell
                "NSW": request.nsw if request.nsw is not None else 100,
                "EDIFFG": request.ediffg if request.ediffg is not None else -0.05,
                "LWAVE": False,
                "LCHARG": True,
                "NCORE": request.ncore if request.ncore is not None else 24,
                **{k: v for k, v in common_defaults.items() if k not in ["NCORE"]},
            })
    elif request.calculation_type == VASPCalculationType.SCF:
        # Single-point energy (from INCAR.scf template)
        incar_params.update({
            "ALGO": request.algo if request.algo else "Fast",
            "PREC": request.prec if request.prec else "Accurate",
            "ENCUT": request.encut,
            "GGA": request.gga,
            "EDIFF": request.ediff if request.ediff != 1e-6 else 1e-6,
            "ISMEAR": request.ismear if request.ismear is not None else 0,
            "SIGMA": request.sigma if request.sigma is not None else 0.05,
            "ISPIN": request.ispin if request.ispin is not None else 2,
            "NSW": 0,
            "IBRION": -1,
            "LWAVE": request.lwave if request.lwave is not None else True,
            "LCHARG": request.lcharg if request.lcharg is not None else True,
            "NCORE": request.ncore if request.ncore is not None else 24,
            **{k: v for k, v in common_defaults.items() if k not in ["NCORE"]},
        })
    elif request.calculation_type == VASPCalculationType.FREQ:
        # Frequency calculation (from INCAR.freq template)
        incar_params.update({
            "ALGO": request.algo if request.algo else "Fast",
            "PREC": request.prec if request.prec else "Normal",  # Normal for freq
            "ENCUT": request.encut,
            "GGA": request.gga,
            "EDIFF": request.ediff if request.ediff != 1e-7 else 1e-7,
            "ISMEAR": request.ismear if request.ismear is not None else 0,
            "SIGMA": request.sigma if request.sigma is not None else 0.05,
            "ISPIN": request.ispin if request.ispin is not None else 2,
            "IBRION": 5,
            "NFREE": request.nfree if request.nfree is not None else 2,
            "POTIM": request.potim if request.potim is not None else 0.015,
            "NWRITE": 3,
            "NSW": 0,
            "LWAVE": False,
            "LCHARG": request.lcharg if request.lcharg is not None else True,
            "NPAR": request.npar if request.npar is not None else 1,  # Required for IBRION=5
            **{k: v for k, v in common_defaults.items() if k not in ["NCORE"]},
        })
    elif request.calculation_type == VASPCalculationType.DOS:
        # Density of states (from INCAR.dos template)
        incar_params.update({
            "ALGO": request.algo if request.algo else "Fast",
            "PREC": request.prec if request.prec else "Accurate",
            "ENCUT": request.encut,
            "GGA": request.gga,
            "EDIFF": request.ediff if request.ediff != 1e-6 else 1e-6,
            "ISMEAR": request.ismear if request.ismear is not None else -5,  # Tetrahedron
            "SIGMA": request.sigma if request.sigma is not None else 0.05,
            "ISPIN": request.ispin if request.ispin is not None else 2,
            "NSW": 0,
            "IBRION": -1,
            "NEDOS": request.nedos if request.nedos is not None else 3001,
            "LWAVE": False,
            "LCHARG": request.lcharg if request.lcharg is not None else True,
            "NCORE": request.ncore if request.ncore is not None else 24,
            **{k: v for k, v in common_defaults.items() if k not in ["NCORE"]},
        })
        if request.nbands is not None:
            incar_params["NBANDS"] = request.nbands
    elif request.calculation_type == VASPCalculationType.BADER:
        # Bader charge analysis (from INCAR.bader template)
        incar_params.update({
            "ALGO": request.algo if request.algo else "Fast",
            "PREC": request.prec if request.prec else "Accurate",
            "ENCUT": request.encut,
            "GGA": request.gga,
            "EDIFF": request.ediff if request.ediff != 1e-6 else 1e-6,
            "ISMEAR": request.ismear if request.ismear is not None else 0,
            "SIGMA": request.sigma if request.sigma is not None else 0.05,
            "ISPIN": request.ispin if request.ispin is not None else 2,
            "NSW": 0,
            "IBRION": -1,
            "LCHARG": True,
            "LAECHG": True,
            "LWAVE": False,
            "NCORE": request.ncore if request.ncore is not None else 24,
            **{k: v for k, v in common_defaults.items() if k not in ["NCORE"]},
        })
    elif request.calculation_type == VASPCalculationType.DDEC:
        # DDEC charge analysis (from INCAR.ddec template)
        incar_params.update({
            "ALGO": request.algo if request.algo else "Fast",
            "PREC": request.prec if request.prec else "Accurate",
            "ENCUT": request.encut,
            "GGA": request.gga,
            "EDIFF": request.ediff if request.ediff != 1e-6 else 1e-6,
            "ISMEAR": request.ismear if request.ismear is not None else 0,
            "SIGMA": request.sigma if request.sigma is not None else 0.05,
            "ISPIN": request.ispin if request.ispin is not None else 2,
            "NSW": 0,
            "IBRION": -1,
            "LCHARG": True,
            "LAECHG": True,
            "LWAVE": False,
            "NCORE": request.ncore if request.ncore is not None else 24,
            **{k: v for k, v in common_defaults.items() if k not in ["NCORE"]},
        })
    elif request.calculation_type == VASPCalculationType.ELF:
        # Electron localization function (from INCAR.elf template)
        incar_params.update({
            "ALGO": request.algo if request.algo else "Fast",
            "PREC": request.prec if request.prec else "Accurate",
            "ENCUT": request.encut,
            "GGA": request.gga,
            "EDIFF": request.ediff if request.ediff != 1e-6 else 1e-6,
            "ISMEAR": request.ismear if request.ismear is not None else 0,
            "SIGMA": request.sigma if request.sigma is not None else 0.05,
            "ISPIN": request.ispin if request.ispin is not None else 2,
            "NSW": 0,
            "IBRION": -1,
            "LELF": True,
            "LCHARG": request.lcharg if request.lcharg is not None else True,
            "LWAVE": False,
            "NPAR": request.npar if request.npar is not None else 1,  # Required for LELF
            **{k: v for k, v in common_defaults.items() if k not in ["NCORE"]},
        })
    elif request.calculation_type == VASPCalculationType.MD:
        # Standard molecular dynamics (NVT by default: SMASS=1, MDALGO=2)
        incar_params.update({
            "ENCUT": request.encut,
            "GGA": request.gga,
            "EDIFF": request.ediff if request.ediff != 1e-6 else 1e-5,
            "ISMEAR": request.ismear if request.ismear is not None else 0,
            "SIGMA": request.sigma if request.sigma is not None else 0.05,
            "ISPIN": request.ispin if request.ispin is not None else 2,
            "IBRION": 0,
            "NSW": request.nsw if request.nsw is not None else 10000,
            "POTIM": request.potim if request.potim is not None else 1,
            "SMASS": request.smass if request.smass is not None else 1,
            "MDALGO": request.mdalgo if request.mdalgo is not None else 2,
            "TEBEG": request.tebeg if request.tebeg is not None else 300,
            "TEEND": request.teend if request.teend is not None else 300,
            "NBLOCK": request.nblock if request.nblock is not None else 10,
            "ISYM": 0,
            "LREAL": "Auto",
            "LWAVE": False,
            "LCHARG": False,
            "LVTOT": False,
            "LVHAR": False,
            "LELF": False,
            "ISTART": 1,
            "ICHARG": 1,
            "NELMIN": request.nelmin if request.nelmin is not None else 5,
            "NELM": request.nelm if request.nelm is not None else 100,
            "NCORE": request.ncore if request.ncore is not None else 48,
        })

    elif request.calculation_type == VASPCalculationType.SLOW_GROWTH:
        # Slow-growth thermodynamic integration MD
        incar_params.update({
            "PREC": request.prec if request.prec else "Accurate",
            "ENCUT": request.encut,
            "GGA": request.gga,
            "EDIFF": request.ediff if request.ediff != 1e-6 else 1e-6,
            "ISMEAR": request.ismear if request.ismear is not None else 0,
            "SIGMA": request.sigma if request.sigma is not None else 0.05,
            "ISPIN": request.ispin if request.ispin is not None else 2,
            "IBRION": 0,  # MD mode required for slow-growth
            "NSW": request.nsw if request.nsw is not None else 10000,
            "POTIM": request.potim if request.potim is not None else 1,
            "SMASS": request.smass if request.smass is not None else 0,
            "MDALGO": request.mdalgo if request.mdalgo is not None else 2,
            "TEBEG": request.tebeg if request.tebeg is not None else 300,
            "TEEND": request.teend if request.teend is not None else 300,
            "NBLOCK": request.nblock if request.nblock is not None else 1,
            "LBLUEOUT": request.lblueout if request.lblueout is not None else True,
            "ISYM": 0,
            "LREAL": "Auto",
            "LWAVE": False,
            "LCHARG": False,
            "ISTART": request.icharg if request.icharg is not None else 1,
            "ICHARG": 1,
            "NELMIN": request.nelmin if request.nelmin is not None else 5,
            "NELM": request.nelm if request.nelm is not None else 300,
            "NCORE": request.ncore if request.ncore is not None else 12,
        })
        # INCREM: CV change rate(s) — can be single or multiple values
        if request.increm:
            # Parse space-separated values
            increm_vals = request.increm.strip().split()
            if len(increm_vals) == 1:
                incar_params["INCREM"] = float(increm_vals[0])
            else:
                incar_params["INCREM"] = " ".join(increm_vals)

    # ====== Constant-potential overlay (appended to any calc type) ======
    if request.constant_potential == ConstantPotentialMethod.TPOT:
        # VASPsol implicit solvation (required for TPOT)
        incar_params.update({
            "LSOL": True,
            "EB_k": request.tpot_eb_k if request.tpot_eb_k is not None else 78.4,
            "LAMBDA_D_K": request.tpot_lambda_d_k if request.tpot_lambda_d_k is not None else 3.04,
            "TAU": request.tpot_tau if request.tpot_tau is not None else 0,
        })
        incar_params["CORE_C"] = (
            request.tpot_core_c if request.tpot_core_c is not None
            else _calculate_core_c(structure)
        )
        # TPOT constant-potential control
        incar_params.update({
            "LTPOT": True,
            "TPOTMETHOD": 2,
            "TPOTVTARGET": request.tpot_vtarget if request.tpot_vtarget is not None else 4.6,
            "TPOTVDIFF": request.tpot_vdiff if request.tpot_vdiff is not None else 0.001,
            "TPOTVRATE": request.tpot_vrate if request.tpot_vrate is not None else -1.6,
            "TPOTVRATELIM": request.tpot_vratelim if request.tpot_vratelim is not None else 0.05,
            "TPOTELECTSTEP": request.tpot_electstep if request.tpot_electstep is not None else 0.05,
            "TPOTDYNVRATE": request.tpot_dynvrate if request.tpot_dynvrate is not None else True,
            "TPOTTRUEVACLEVEL": request.tpot_truevaclevel if request.tpot_truevaclevel is not None else True,
            "TPOTGCENERGY": request.tpot_gcenergy if request.tpot_gcenergy is not None else True,
            "TPOTGCIONIC": request.tpot_gcionic if request.tpot_gcionic is not None else True,
        })
    elif request.constant_potential == ConstantPotentialMethod.CPVASP:
        nescheme = request.cpvasp_nescheme if request.cpvasp_nescheme is not None else 5
        incar_params.update({
            # VASPsol++ implicit solvation
            "LSOL": request.cpvasp_lsol if request.cpvasp_lsol is not None else True,
            "ISOL": request.cpvasp_isol if request.cpvasp_isol is not None else 2,
            "C_MOLAR": request.cpvasp_c_molar if request.cpvasp_c_molar is not None else 1.0,
            "R_ION": request.cpvasp_r_ion if request.cpvasp_r_ion is not None else 4.0,
            # CP-VASP constant potential
            "LCEP": True,
            "NESCHEME": nescheme,
            "NEADJUST": request.cpvasp_neadjust if request.cpvasp_neadjust is not None else 1,
            "TARGETMU": request.cpvasp_targetmu if request.cpvasp_targetmu is not None else -4.44,
            "FERMICONVERGE": request.cpvasp_fermiconverge if request.cpvasp_fermiconverge is not None else 0.01,
        })
        if nescheme == 2:
            incar_params["CAP_MAX"] = request.cpvasp_cap_max if request.cpvasp_cap_max is not None else 2.0
        elif nescheme == 5:
            incar_params["T_eta"] = request.cpvasp_t_eta if request.cpvasp_t_eta is not None else 300
            incar_params["eta_length"] = request.cpvasp_eta_length if request.cpvasp_eta_length is not None else 1

    # Apply user-provided overrides (these override defaults)
    if request.algo is not None:
        incar_params["ALGO"] = request.algo
    if request.prec is not None:
        incar_params["PREC"] = request.prec
    if request.encut is not None:
        incar_params["ENCUT"] = request.encut
    if request.gga is not None:
        incar_params["GGA"] = request.gga
    if request.ediff is not None:
        incar_params["EDIFF"] = request.ediff
    if request.nelm is not None:
        incar_params["NELM"] = request.nelm
    if request.nelmin is not None:
        incar_params["NELMIN"] = request.nelmin
    if request.nelmdl is not None:
        incar_params["NELMDL"] = request.nelmdl
    if request.ismear is not None:
        incar_params["ISMEAR"] = request.ismear
    if request.sigma is not None:
        incar_params["SIGMA"] = request.sigma
    if request.ispin is not None:
        incar_params["ISPIN"] = request.ispin
    if request.magmom is not None:
        incar_params["MAGMOM"] = request.magmom
    if request.isif is not None:
        incar_params["ISIF"] = request.isif
    if request.ibrion is not None:
        incar_params["IBRION"] = request.ibrion
    if request.nsw is not None:
        incar_params["NSW"] = request.nsw
    if request.ediffg is not None:
        incar_params["EDIFFG"] = request.ediffg
    if request.potim is not None:
        incar_params["POTIM"] = request.potim
    if request.iopt is not None:
        incar_params["IOPT"] = request.iopt
    if request.lvtst is not None:
        incar_params["LVTST"] = request.lvtst
    if request.isym is not None:
        incar_params["ISYM"] = request.isym
    if request.ivdw is not None:
        incar_params["IVDW"] = request.ivdw
    if request.lreal is not None:
        incar_params["LREAL"] = request.lreal
    if request.lwave is not None:
        incar_params["LWAVE"] = request.lwave
    if request.lcharg is not None:
        incar_params["LCHARG"] = request.lcharg
    if request.lorbit is not None:
        incar_params["LORBIT"] = request.lorbit
    if request.lelf is not None:
        incar_params["LELF"] = request.lelf
    if request.laechg is not None:
        incar_params["LAECHG"] = request.laechg
    if request.ncore is not None:
        incar_params["NCORE"] = request.ncore
    if request.npar is not None:
        incar_params["NPAR"] = request.npar
    if request.icharg is not None:
        incar_params["ICHARG"] = request.icharg
    if request.idipol is not None:
        incar_params["IDIPOL"] = request.idipol
    if request.lmaxmix is not None:
        incar_params["LMAXMIX"] = request.lmaxmix
    if request.addgrid is not None:
        incar_params["ADDGRID"] = request.addgrid
    if request.amix is not None:
        incar_params["AMIX"] = request.amix
    if request.bmix is not None:
        incar_params["BMIX"] = request.bmix
    if request.amix_mag is not None:
        incar_params["AMIX_MAG"] = request.amix_mag
    if request.bmix_mag is not None:
        incar_params["BMIX_MAG"] = request.bmix_mag
    if request.nfree is not None:
        incar_params["NFREE"] = request.nfree
    if request.nedos is not None:
        incar_params["NEDOS"] = request.nedos
    if request.nbands is not None:
        incar_params["NBANDS"] = request.nbands
    if request.mdalgo is not None:
        incar_params["MDALGO"] = request.mdalgo
    if request.smass is not None:
        incar_params["SMASS"] = request.smass
    if request.tebeg is not None:
        incar_params["TEBEG"] = request.tebeg
    if request.teend is not None:
        incar_params["TEEND"] = request.teend
    if request.nblock is not None:
        incar_params["NBLOCK"] = request.nblock
    if request.lblueout is not None:
        incar_params["LBLUEOUT"] = request.lblueout
    # TPOT overrides
    if request.tpot_vtarget is not None:
        incar_params["TPOTVTARGET"] = request.tpot_vtarget
    if request.tpot_vdiff is not None:
        incar_params["TPOTVDIFF"] = request.tpot_vdiff
    if request.tpot_vrate is not None:
        incar_params["TPOTVRATE"] = request.tpot_vrate
    if request.tpot_vratelim is not None:
        incar_params["TPOTVRATELIM"] = request.tpot_vratelim
    if request.tpot_vratedamp is not None:
        incar_params["TPOTVRATEDAMP"] = request.tpot_vratedamp
    if request.tpot_vediff is not None:
        incar_params["TPOTVEDIFF"] = request.tpot_vediff
    if request.tpot_electstep is not None:
        incar_params["TPOTELECTSTEP"] = request.tpot_electstep
    if request.tpot_dynvrate is not None:
        incar_params["TPOTDYNVRATE"] = request.tpot_dynvrate
    if request.tpot_truevaclevel is not None:
        incar_params["TPOTTRUEVACLEVEL"] = request.tpot_truevaclevel
    if request.tpot_gcenergy is not None:
        incar_params["TPOTGCENERGY"] = request.tpot_gcenergy
    if request.tpot_gcionic is not None:
        incar_params["TPOTGCIONIC"] = request.tpot_gcionic

    # CP-VASP overrides
    if request.cpvasp_targetmu is not None:
        incar_params["TARGETMU"] = request.cpvasp_targetmu
    if request.cpvasp_nescheme is not None:
        incar_params["NESCHEME"] = request.cpvasp_nescheme
    if request.cpvasp_neadjust is not None:
        incar_params["NEADJUST"] = request.cpvasp_neadjust
    if request.cpvasp_fermiconverge is not None:
        incar_params["FERMICONVERGE"] = request.cpvasp_fermiconverge
    if request.cpvasp_cap_max is not None:
        incar_params["CAP_MAX"] = request.cpvasp_cap_max
    if request.cpvasp_t_eta is not None:
        incar_params["T_eta"] = request.cpvasp_t_eta
    if request.cpvasp_eta_length is not None:
        incar_params["eta_length"] = request.cpvasp_eta_length

    # NELECT (from constant-potential step 1)
    if request.nelect is not None:
        incar_params["NELECT"] = request.nelect

    # Custom INCAR parameters (override everything else)
    if request.custom_incar:
        incar_params.update(request.custom_incar)

    return Incar(incar_params)


# Parameter grouping for readable INCAR output
_INCAR_SECTIONS: list[tuple[str, set[str]]] = [
    ("General", {"SYSTEM", "PREC", "ENCUT", "GGA", "ALGO", "LREAL", "ISYM", "ADDGRID"}),
    ("Electronic convergence", {"EDIFF", "NELM", "NELMIN", "NELMDL", "ICHARG", "ISTART",
                                 "AMIX", "BMIX", "AMIX_MAG", "BMIX_MAG", "LMAXMIX"}),
    ("Smearing", {"ISMEAR", "SIGMA"}),
    ("Spin", {"ISPIN", "MAGMOM"}),
    ("Ionic relaxation / MD", {"IBRION", "NSW", "ISIF", "EDIFFG", "POTIM", "NFREE",
                                "MDALGO", "SMASS", "TEBEG", "TEEND", "NBLOCK",
                                "LBLUEOUT", "INCREM",
                                "IOPT", "LVTST"}),
    ("Output", {"LWAVE", "LCHARG", "LORBIT", "LELF", "LAECHG", "LVTOT", "LVHAR", "NWRITE",
                "NEDOS", "NBANDS"}),
    ("vdW correction", {"IVDW"}),
    ("Dipole correction", {"IDIPOL"}),
    ("NELECT", {"NELECT"}),
    ("Parallelization", {"NCORE", "NPAR"}),
    ("VASPsol Solvent Model", {"LSOL", "EB_k", "LAMBDA_D_K", "CORE_C", "TAU",
                                "ISOL", "C_MOLAR", "R_ION",
                                "LSOLHYBRID", "METHOD_SH", "SIGMA_SH", "ALPHA_SH"}),
    ("TPOT", {"LTPOT", "TPOTMETHOD", "TPOTVTARGET", "TPOTVDIFF", "TPOTELECTSTEP",
              "TPOTDYNVRATE", "TPOTVRATE", "TPOTVRATELIM", "TPOTVRATEDAMP", "TPOTVEDIFF",
              "TPOTTRUEVACLEVEL", "TPOTGCENERGY", "TPOTGCIONIC"}),
    ("CP-VASP", {"LCEP", "NESCHEME", "NEADJUST", "TARGETMU", "FERMICONVERGE",
                 "CAP_MAX", "T_eta", "eta_length"}),
]


def _format_incar_grouped(params: dict, request: VASPInputRequest) -> str:
    """Format INCAR params dict into grouped sections with comments."""
    remaining = dict(params)
    lines: list[str] = []

    for section_name, keys in _INCAR_SECTIONS:
        section_params = {}
        for k in list(keys):
            if k in remaining:
                section_params[k] = remaining.pop(k)
        if not section_params:
            continue
        lines.append(f"# {section_name}")
        for key, val in section_params.items():
            if isinstance(val, bool):
                lines.append(f"{key:20s} = {'  .TRUE.' if val else '  .FALSE.'}")
            else:
                lines.append(f"{key:20s} = {val}")
        lines.append("")

    # Any remaining params not in known sections
    if remaining:
        lines.append("# Other")
        for key, val in remaining.items():
            if isinstance(val, bool):
                lines.append(f"{key:20s} = {'  .TRUE.' if val else '  .FALSE.'}")
            else:
                lines.append(f"{key:20s} = {val}")
        lines.append("")

    return "\n".join(lines)


def generate_kpoints(
    request: VASPInputRequest, structure: Structure
) -> Kpoints:
    """Generate KPOINTS file."""
    # Slab detection: clamp k_c to 1 for structures with vacuum in c-direction
    lattice = structure.lattice
    is_slab = (
        (hasattr(structure, 'pbc') and not structure.pbc[2])
        or lattice.c > 15
        or (getattr(request, 'system_type', None) == 'slab')
    )

    if request.kpoints:
        # User-provided k-points
        if len(request.kpoints) == 1 and len(request.kpoints[0]) == 3:
            # Mesh mode — apply slab correction if needed
            mesh = list(request.kpoints[0])
            if is_slab and int(mesh[2]) > 1:
                mesh[2] = 1
            return Kpoints.monkhorst_automatic(
                kpts=(int(mesh[0]), int(mesh[1]), int(mesh[2]))
            )
        else:
            # K-point path (band structure)
            return Kpoints(
                comment="K-point path",
                style=Kpoints.supported_modes.Line_mode,
                num_kpts=len(request.kpoints),
                kpts=request.kpoints,
            )
    elif request.kspacing:
        # KSPACING (Å^-1, VASP semantics): N_i = max(1, ceil(|b_i| / kspacing)),
        # where b_i are the 2*pi reciprocal-lattice vectors. (Previously this
        # mis-used kspacing as a kppvol density, yielding 1x1x1 for small values.)
        recip = structure.lattice.reciprocal_lattice.abc
        mesh = [max(1, int(np.ceil(b / request.kspacing))) for b in recip]
        if is_slab and mesh[2] > 1:
            mesh[2] = 1
        return Kpoints.gamma_automatic(kpts=(mesh[0], mesh[1], mesh[2]))
    else:
        # Default: automatic k-points
        kpts = Kpoints.automatic_density_by_vol(structure, 1000)
        # Apply slab correction to auto-generated mesh too
        if is_slab and kpts.kpts and len(kpts.kpts) > 0:
            mesh = list(kpts.kpts[0])
            if len(mesh) == 3 and mesh[2] > 1:
                mesh[2] = 1
                return Kpoints.monkhorst_automatic(kpts=tuple(mesh))
        return kpts


def generate_vasp_inputs(request: VASPInputRequest) -> dict:
    """Generate all VASP input files for a given request."""
    # Convert structure to pymatgen Structure
    pymatgen_structure = _pymatgen_structure_to_structure(request.structure)

    # Determine selective dynamics (frozen atoms)
    if request.fixed_indices or request.fixed_z_below is not None:
        # Start from existing selective dynamics (e.g. pseudo-H frozen by passivation)
        # then apply additional freeze overrides from the request.
        existing_sd = pymatgen_structure.site_properties.get("selective_dynamics")
        if existing_sd:
            selective_dynamics = [list(sd) for sd in existing_sd]
        else:
            selective_dynamics = [[True, True, True] for _ in range(len(pymatgen_structure))]

        # Freeze atoms by index
        if request.fixed_indices:
            for idx in request.fixed_indices:
                if 0 <= idx < len(selective_dynamics):
                    selective_dynamics[idx] = [False, False, False]

        # Freeze atoms by z coordinate
        if request.fixed_z_below is not None:
            for idx, site in enumerate(pymatgen_structure):
                # Get cartesian z coordinate
                z_coord = site.coords[2]
                if z_coord < request.fixed_z_below:
                    selective_dynamics[idx] = [False, False, False]

        # Merge selective dynamics into existing site properties (preserving
        # pseudo_h_potcar etc.) — .copy(site_properties=) would replace all.
        existing_props = {
            k: list(v) for k, v in (pymatgen_structure.site_properties or {}).items()
            if v is not None
        }
        existing_props["selective_dynamics"] = selective_dynamics
        pymatgen_structure = pymatgen_structure.copy(site_properties=existing_props)

    # Generate POSCAR
    # Clean up site properties: pymatgen from_dict() can leave selective_dynamics
    # as None on some sites when the source dict has inconsistent properties.
    # Poscar(sort_structure=True) calls from_sites() which chokes on None values.
    site_props = pymatgen_structure.site_properties or {}
    if "selective_dynamics" in site_props:
        sd = site_props["selective_dynamics"]
        if any(v is None for v in sd):
            # Fill None entries with [True, True, True] (free to move)
            # instead of removing — preserves user-set fixed atoms
            patched = {**site_props, "selective_dynamics": [
                v if v is not None else [True, True, True] for v in sd
            ]}
            pymatgen_structure = pymatgen_structure.copy(site_properties=patched)

    # Check if structure has pseudo-H atoms (need special grouping by POTCAR type)
    has_pseudo_h = any(
        site.properties.get("pseudo_h_potcar")
        for site in pymatgen_structure
        if site.properties
    )
    if has_pseudo_h:
        poscar_str = _generate_poscar_with_pseudo_h(pymatgen_structure)
    else:
        # Standard path: pymatgen handles grouping and selective dynamics
        poscar = Poscar(pymatgen_structure, sort_structure=True)
        poscar_str = poscar.get_str() if hasattr(poscar, 'get_str') else poscar.get_string()

    # Generate INCAR
    incar = generate_incar(request, pymatgen_structure)
    incar_str = _format_incar_grouped(dict(incar), request)

    # Generate KPOINTS
    kpoints = generate_kpoints(request, pymatgen_structure)
    kpoints_str = str(kpoints)

    # POTCAR info — include pseudo-H POTCAR names (H.50, H1.50 etc.)
    potcar_elements: list[str] = []
    seen: set[str] = set()
    for site in pymatgen_structure:
        potcar_name = (
            site.properties.get("pseudo_h_potcar")
            if site.properties else None
        )
        label = potcar_name if potcar_name else str(site.specie)
        if label not in seen:
            seen.add(label)
            potcar_elements.append(label)
    potcar_info = {
        "elements": sorted(potcar_elements),
        "note": "POTCAR file must be generated separately using VASP POTCAR generation tools",
    }

    # Generate ICONST for slow-growth
    iconst_str = None
    if request.calculation_type == VASPCalculationType.SLOW_GROWTH and request.iconst_content:
        iconst_str = request.iconst_content.strip() + "\n"

    # Generate INCAR_NELECT for constant-potential (Step 1: SCF to determine NELECT)
    incar_nelect_str = None
    if request.constant_potential == ConstantPotentialMethod.TPOT:
        incar_nelect_str = _generate_tpot_nelect_incar(request, pymatgen_structure)
    elif request.constant_potential == ConstantPotentialMethod.CPVASP:
        incar_nelect_str = _generate_cpvasp_nelect_incar(request, pymatgen_structure)

    # Generate notes
    notes = _generate_notes(request, pymatgen_structure)

    result = {
        "incar": incar_str,
        "poscar": poscar_str,
        "kpoints": kpoints_str,
        "potcar_info": potcar_info,
        "calculation_type": request.calculation_type,
        "notes": notes,
    }
    if iconst_str:
        result["iconst"] = iconst_str
    if incar_nelect_str:
        result["incar_nelect"] = incar_nelect_str

    return result


# ZVAL for recommended POTCARs (PBE PAW, VASP wiki recommended set)
# CORE_C = sum(Z - ZVAL) for all atoms
_RECOMMENDED_ZVAL: dict[str, float] = {
    "H": 1, "He": 2,
    "Li": 3, "Be": 4, "B": 3, "C": 4, "N": 5, "O": 6, "F": 7, "Ne": 8,
    "Na": 7, "Mg": 8, "Al": 3, "Si": 4, "P": 5, "S": 6, "Cl": 7, "Ar": 8,
    "K": 9, "Ca": 10,
    "Sc": 11, "Ti": 12, "V": 13, "Cr": 12, "Mn": 13, "Fe": 14,
    "Co": 9, "Ni": 16, "Cu": 17, "Zn": 12,
    "Ga": 13, "Ge": 14, "As": 5, "Se": 6, "Br": 7, "Kr": 8,
    "Rb": 9, "Sr": 10,
    "Y": 11, "Zr": 12, "Nb": 13, "Mo": 14, "Tc": 13, "Ru": 14,
    "Rh": 15, "Pd": 16, "Ag": 17, "Cd": 12,
    "In": 13, "Sn": 14, "Sb": 5, "Te": 6, "I": 7, "Xe": 8,
    "Cs": 9, "Ba": 10,
    "La": 11, "Ce": 12, "Pr": 13, "Nd": 14,
    "Hf": 10, "Ta": 11, "W": 12, "Re": 13, "Os": 14,
    "Ir": 15, "Pt": 16, "Au": 17, "Hg": 12,
    "Tl": 13, "Pb": 14, "Bi": 15,
}


def _calculate_core_c(structure: Structure) -> int:
    """Calculate CORE_C = total core electrons = sum(Z - ZVAL) for all atoms.

    Uses recommended POTCAR ZVAL values. Falls back to Z/2 for unknown elements.
    """
    from pymatgen.core import Element as PmgElement

    core_c = 0
    for site in structure:
        el = str(max(site.species, key=lambda s: s.occu))
        # Clean element symbol (e.g. "C0+" -> "C")
        el_clean = "".join(c for c in el if c.isalpha())
        z = PmgElement(el_clean).Z
        zval = _RECOMMENDED_ZVAL.get(el_clean, z // 2)
        core_c += z - zval
    return core_c


def _format_incar_str(sections: list[tuple[str, dict]],
                      system_title: str | None = None) -> str:
    """Format INCAR as grouped sections with comments.

    Args:
        sections: list of (section_comment, params_dict) tuples
        system_title: optional SYSTEM tag
    """
    lines: list[str] = []
    if system_title:
        lines.append(f"SYSTEM = {system_title}")
        lines.append("")

    for comment, params in sections:
        if not params:
            continue
        lines.append(f"# {comment}")
        for key, val in params.items():
            if isinstance(val, bool):
                lines.append(f"{key:20s} = {'  .TRUE.' if val else '  .FALSE.'}")
            elif isinstance(val, float):
                lines.append(f"{key:20s} = {val}")
            else:
                lines.append(f"{key:20s} = {val}")
        lines.append("")

    return "\n".join(lines)


def _generate_tpot_nelect_incar(request: VASPInputRequest,
                                structure: Structure) -> str:
    """Generate INCAR for TPOT Step 1: static SCF to determine NELECT.

    Uses TPOTMETHOD=1 (electronic-step updates) with NSW=1 and high NELM
    so VASP converges to the target potential and reports the final NELECT.
    """
    core_c = request.tpot_core_c if request.tpot_core_c is not None else _calculate_core_c(structure)
    vtarget = request.tpot_vtarget if request.tpot_vtarget is not None else 4.6

    sections = [
        ("General", {
            "PREC": request.prec or "Accurate",
            "ENCUT": request.encut,
            "GGA": request.gga,
            "ALGO": request.algo or "Fast",
            "LREAL": "Auto",
            "ISYM": 0,
        }),
        ("Electronic convergence", {
            "EDIFF": request.ediff if request.ediff != 1e-6 else 1e-5,
            "NELM": 200,
            "NELMIN": request.nelmin if request.nelmin is not None else 6,
            "ISMEAR": request.ismear if request.ismear is not None else 0,
            "SIGMA": request.sigma if request.sigma is not None else 0.05,
        }),
        ("Spin", {
            "ISPIN": request.ispin if request.ispin is not None else 2,
            **({"MAGMOM": request.magmom} if request.magmom else {}),
        }),
        ("Static calculation (single point)", {
            "IBRION": -1,
            "NSW": 1,
        }),
        ("Output", {
            "LWAVE": True,
            "LCHARG": True,
            "LORBIT": 11,
        }),
        ("vdW correction", {
            "IVDW": request.ivdw if request.ivdw is not None else 12,
        }),
        ("Parallelization", {
            "NCORE": request.ncore if request.ncore is not None else 48,
        }),
        ("VASPsol Solvent Model", {
            "LSOL": True,
            "EB_k": request.tpot_eb_k if request.tpot_eb_k is not None else 78.4,
            "LAMBDA_D_K": request.tpot_lambda_d_k if request.tpot_lambda_d_k is not None else 3.04,
            "CORE_C": core_c,
            "TAU": request.tpot_tau if request.tpot_tau is not None else 0,
        }),
        ("TPOT - Method 1: determine NELECT", {
            "LTPOT": True,
            "TPOTMETHOD": 1,
            "TPOTVTARGET": vtarget,
            "TPOTVDIFF": request.tpot_vdiff if request.tpot_vdiff is not None else 0.01,
            "TPOTELECTSTEP": request.tpot_electstep if request.tpot_electstep is not None else 0.05,
            "TPOTDYNVRATE": request.tpot_dynvrate if request.tpot_dynvrate is not None else True,
            "TPOTVRATE": request.tpot_vrate if request.tpot_vrate is not None else -1.6,
            "TPOTVRATELIM": request.tpot_vratelim if request.tpot_vratelim is not None else 0.2,
            "TPOTVRATEDAMP": 2.0,
        }),
    ]

    title = f"{request.system_title} - NELECT determination" if request.system_title else "NELECT determination (TPOT step 1)"
    return _format_incar_str(sections, title)


def _generate_cpvasp_nelect_incar(request: VASPInputRequest,
                                  structure: Structure) -> str:
    """Generate INCAR for CP-VASP Step 1: static SCF to determine NELECT.

    Runs a static calculation with CP-VASP + VASPsol++ to converge to the target
    potential and determine the equilibrium NELECT. LWAVE=.TRUE. for wavefunction
    continuation in the MD step.
    """
    targetmu = request.cpvasp_targetmu if request.cpvasp_targetmu is not None else -4.6
    nescheme = request.cpvasp_nescheme if request.cpvasp_nescheme is not None else 5

    # Scheme-dependent params
    cp_scheme_params: dict = {}
    if nescheme == 2:
        cp_scheme_params["CAP_MAX"] = request.cpvasp_cap_max if request.cpvasp_cap_max is not None else 2.0
    elif nescheme == 5:
        cp_scheme_params["T_eta"] = request.cpvasp_t_eta if request.cpvasp_t_eta is not None else 300
        cp_scheme_params["eta_length"] = request.cpvasp_eta_length if request.cpvasp_eta_length is not None else 1

    sections = [
        ("General", {
            "PREC": request.prec or "Accurate",
            "ENCUT": request.encut,
            "GGA": request.gga,
            "ALGO": request.algo or "Normal",
            "LREAL": "Auto",
            "ISYM": 0,
        }),
        ("Electronic convergence", {
            "EDIFF": request.ediff if request.ediff != 1e-6 else 1e-6,
            "NELM": 200,
            "NELMIN": request.nelmin if request.nelmin is not None else 6,
            "ISMEAR": request.ismear if request.ismear is not None else 1,
            "SIGMA": request.sigma if request.sigma is not None else 0.2,
        }),
        ("Spin", {
            "ISPIN": request.ispin if request.ispin is not None else 1,
            **({"MAGMOM": request.magmom} if request.magmom else {}),
        }),
        ("Static calculation (single point)", {
            "IBRION": -1,
            "NSW": 0,
        }),
        ("Output", {
            "LWAVE": True,
            "LCHARG": True,
            "LORBIT": 11,
        }),
        ("vdW correction", {
            "IVDW": request.ivdw if request.ivdw is not None else 12,
        }),
        ("Parallelization", {
            "NCORE": request.ncore if request.ncore is not None else 48,
        }),
        ("VASPsol++ Solvent Model", {
            "LSOL": request.cpvasp_lsol if request.cpvasp_lsol is not None else True,
            "ISOL": request.cpvasp_isol if request.cpvasp_isol is not None else 2,
            "C_MOLAR": request.cpvasp_c_molar if request.cpvasp_c_molar is not None else 1.0,
            "R_ION": request.cpvasp_r_ion if request.cpvasp_r_ion is not None else 4.0,
        }),
        ("CP-VASP - determine NELECT", {
            "LCEP": True,
            "NESCHEME": nescheme,
            "NEADJUST": 1,
            "TARGETMU": targetmu,
            "FERMICONVERGE": request.cpvasp_fermiconverge if request.cpvasp_fermiconverge is not None else 0.01,
            **cp_scheme_params,
        }),
    ]

    title = f"{request.system_title} - NELECT determination" if request.system_title else "NELECT determination (CP-VASP step 1)"
    return _format_incar_str(sections, title)


def _generate_poscar_with_pseudo_h(structure: Structure) -> str:
    """Generate POSCAR string with pseudo-H atoms grouped by POTCAR type.

    Standard pymatgen Poscar merges all H atoms into one group, losing the
    distinction between H.50, H1.50, etc.  This function splits pseudo-H
    atoms into separate groups keyed by their ``pseudo_h_potcar`` site
    property and writes the POTCAR variant name in the element line.
    """
    lattice = structure.lattice

    # --- Group sites by element / pseudo-H POTCAR type ---
    # group_key -> list[site_index]
    from collections import OrderedDict
    groups: OrderedDict[str, list[int]] = OrderedDict()
    group_label: dict[str, str] = {}  # group_key -> display label

    # First pass: collect regular (non-pseudo-H) elements sorted by
    # electronegativity (standard VASP order), then pseudo-H groups.
    regular_indices: dict[str, list[int]] = {}
    pseudo_h_indices: dict[str, list[int]] = {}

    for i, site in enumerate(structure):
        potcar = (
            site.properties.get("pseudo_h_potcar")
            if site.properties else None
        )
        if potcar:
            pseudo_h_indices.setdefault(potcar, []).append(i)
        else:
            sym = str(site.specie)
            regular_indices.setdefault(sym, []).append(i)

    # Sort regular elements by electronegativity (pymatgen default)
    from pymatgen.core import Element
    for sym in sorted(regular_indices, key=lambda s: Element(s).X):
        groups[sym] = regular_indices[sym]
        group_label[sym] = sym

    # Pseudo-H groups sorted by charge value
    for potcar in sorted(pseudo_h_indices):
        key = f"H__{potcar}"
        groups[key] = pseudo_h_indices[potcar]
        group_label[key] = potcar  # e.g. "H.50", "H1.50"

    # --- Build POSCAR lines ---
    lines: list[str] = []

    # Comment line
    formula_parts = []
    for key in groups:
        label = group_label[key]
        count = len(groups[key])
        formula_parts.append(f"{label}{count}")
    lines.append(" ".join(formula_parts))

    # Scale factor
    lines.append("1.0")

    # Lattice vectors
    for row in lattice.matrix:
        lines.append(f"  {row[0]:20.14f}  {row[1]:20.14f}  {row[2]:20.14f}")

    # Element symbols and counts
    lines.append("  ".join(group_label[k] for k in groups))
    lines.append("  ".join(str(len(groups[k])) for k in groups))

    # Selective dynamics?
    has_sd = any(
        site.properties and "selective_dynamics" in site.properties
        for site in structure
    )
    if has_sd:
        lines.append("Selective dynamics")

    # Coordinate mode
    lines.append("Direct")

    # Coordinates in group order
    for key in groups:
        for idx in groups[key]:
            site = structure[idx]
            fc = site.frac_coords
            line = f"  {fc[0]:20.14f}  {fc[1]:20.14f}  {fc[2]:20.14f}"
            if has_sd:
                sd = (
                    site.properties.get("selective_dynamics", [True, True, True])
                    if site.properties else [True, True, True]
                )
                line += f"  {'T' if sd[0] else 'F'}  {'T' if sd[1] else 'F'}  {'T' if sd[2] else 'F'}"
            lines.append(line)

    # POTCAR order annotation
    potcar_order = [group_label[k] for k in groups]
    lines.append("")
    lines.append(f"# POTCAR order: {' '.join(potcar_order)}")

    return "\n".join(lines) + "\n"


def _pymatgen_structure_to_structure(
    pymatgen_structure: PymatgenStructure,
) -> Structure:
    """Convert PymatgenStructure to pymatgen Structure object.

    For sites with partial occupancies (disordered), the dominant species
    (highest occupancy) is selected since VASP requires ordered structures.
    Preserves site properties (pseudo_h_potcar, selective_dynamics, etc.).
    """
    from pymatgen.core import Lattice

    # Build lattice
    lattice_matrix = pymatgen_structure.lattice.matrix
    lattice = Lattice(lattice_matrix)

    # Build species and coordinates lists
    species_list = []
    coords_list = []
    # Collect site properties to preserve pseudo_h_potcar etc.
    all_site_properties: dict[str, list] = {}
    inv_lattice = np.linalg.inv(np.array(lattice_matrix))
    for site in pymatgen_structure.sites:
        species_dict = {}
        for sp in site.species:
            element = sp.element
            occu = sp.occu
            if element in species_dict:
                species_dict[element] += occu
            else:
                species_dict[element] = occu

        # For VASP compatibility, use dominant species with occupancy 1.0
        # if the site has partial occupancies
        total_occu = sum(species_dict.values())
        if total_occu < 0.99 or len(species_dict) > 1:
            # Disordered site - pick the dominant species
            dominant_element = max(species_dict, key=species_dict.get)
            species_list.append(dominant_element)
        else:
            # Ordered site - use as-is
            species_list.append(list(species_dict.keys())[0])

        if site.abc is not None:
            coords_list.append(site.abc)
        else:
            frac = inv_lattice @ np.array(site.xyz)
            coords_list.append(frac.tolist())

        # Collect site properties
        if site.properties:
            for key, value in site.properties.items():
                all_site_properties.setdefault(key, []).append(value)
            # Pad missing keys with None
            for key in all_site_properties:
                if key not in site.properties:
                    all_site_properties[key].append(None)
        else:
            for key in all_site_properties:
                all_site_properties[key].append(None)

    # Filter out property lists that are all None
    site_properties = {
        k: v for k, v in all_site_properties.items()
        if any(x is not None for x in v)
    } or None

    return Structure(
        lattice, species_list, coords_list,
        charge=pymatgen_structure.charge,
        site_properties=site_properties,
    )


def _generate_notes(request: VASPInputRequest, structure: Structure) -> str:
    """Generate helpful notes for the calculation."""
    notes_lines = [
        f"VASP input files for {request.calculation_type.value.upper()} calculation",
        "",
        f"Structure: {len(structure)} atoms",
        f"Elements: {', '.join(sorted(set(str(s.specie) for s in structure)))}",
        "",
    ]

    if request.calculation_type == VASPCalculationType.OPT:
        notes_lines.append("Note: This is a structure optimization calculation.")
        notes_lines.append("Make sure to check convergence and final structure.")
    elif request.calculation_type == VASPCalculationType.FREQ:
        notes_lines.append(
            "Note: Frequency calculation requires an optimized structure."
        )
        notes_lines.append("Run OPT calculation first, then use optimized structure for FREQ.")
    elif request.calculation_type == VASPCalculationType.BADER:
        notes_lines.append("Note: Bader analysis requires CHGCAR file.")
        notes_lines.append("Run calculation, then use Bader code to analyze CHGCAR.")
    elif request.calculation_type == VASPCalculationType.DDEC:
        notes_lines.append("Note: DDEC analysis requires CHGCAR and AECCAR files.")
        notes_lines.append("Run calculation, then use DDEC code to analyze charge density.")
    elif request.calculation_type == VASPCalculationType.ELF:
        notes_lines.append("Note: ELF calculation will generate ELFCAR file.")
        notes_lines.append("Visualize ELFCAR using VESTA or similar tools.")
    elif request.calculation_type == VASPCalculationType.SLOW_GROWTH:
        notes_lines.append("Note: Slow-growth thermodynamic integration MD.")
        notes_lines.append("Place ICONST file in the same directory as INCAR/POSCAR.")
        notes_lines.append("Free energy gradient is written to REPORT file (LBLUEOUT=.TRUE.).")
        notes_lines.append("INCREM controls the CV change rate per step.")
        notes_lines.append("Use a well-equilibrated structure as starting point.")

    # Constant-potential notes (appended to any calc type)
    if request.constant_potential == ConstantPotentialMethod.TPOT:
        notes_lines.append("")
        notes_lines.append("=== Constant-Potential: TPOT ===")
        notes_lines.append("Two-step workflow:")
        notes_lines.append("  Step 1: Run with INCAR_NELECT to determine NELECT at target potential.")
        notes_lines.append("          Uses TPOTMETHOD=1 (electronic-step updates), NSW=1, NELM=200.")
        notes_lines.append("          After convergence, read NELECT from OUTCAR.")
        notes_lines.append("  Step 2: Run with the main INCAR (TPOTMETHOD=2).")
        notes_lines.append("          Set NELECT in INCAR to the value from Step 1.")
        notes_lines.append("Requires: VASP compiled with TPOT patch (github.com/comet-group/tpot).")
    elif request.constant_potential == ConstantPotentialMethod.CPVASP:
        notes_lines.append("")
        notes_lines.append("=== Constant-Potential: CP-VASP ===")
        notes_lines.append("Two-step workflow:")
        notes_lines.append("  Step 1: Run with INCAR_NELECT (static SCF) to converge to target potential.")
        notes_lines.append("          Read final NELECT from OUTCAR after convergence.")
        notes_lines.append("  Step 2: Run with the main INCAR.")
        notes_lines.append("          CP-VASP dynamically adjusts NELECT during the calculation.")
        notes_lines.append("Requires: VASP + CP-VASP patch (github.com/yuanyue-liu-group/CP-VASP)")
        notes_lines.append("          + VASPsol++ for implicit solvation.")

    notes_lines.append("")
    notes_lines.append("POTCAR: Generate using VASP POTCAR generation tools.")
    notes_lines.append("Place POTCAR file in the same directory as other input files.")

    return "\n".join(notes_lines)
