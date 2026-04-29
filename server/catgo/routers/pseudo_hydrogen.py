"""Pseudo-hydrogen passivation API endpoint."""

import logging
import traceback

from fastapi import APIRouter, HTTPException

from catgo.models.pseudo_hydrogen import (
    PseudoHInfoResponse,
    PseudoHydrogenParams,
    PseudoHydrogenRequest,
    PseudoHydrogenResult,
)
from catgo.utils import ase_to_pymatgen, pymatgen_to_ase
from catgo.utils.pseudo_hydrogen import SlabPassivator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pseudo-hydrogen", tags=["pseudo-hydrogen"])


@router.post("/passivate", response_model=PseudoHydrogenResult)
def passivate_slab(request: PseudoHydrogenRequest) -> PseudoHydrogenResult:
    """Add pseudo-hydrogen atoms to passivate slab surface dangling bonds.

    Requires both a slab structure and a bulk reference structure.
    Optionally accepts selected atom indices to passivate only specific atoms.
    """
    try:
        params = request.params or PseudoHydrogenParams()

        # Convert to ASE
        slab_atoms = pymatgen_to_ase(request.slab)
        bulk_atoms = pymatgen_to_ase(request.bulk)
        n_slab_atoms = len(slab_atoms)

        logger.info(
            "Passivation request: slab=%d atoms, bulk=%d atoms, selected=%s",
            n_slab_atoms, len(bulk_atoms),
            params.selected_indices if params.selected_indices else "auto",
        )

        # Run passivation
        passivator = SlabPassivator(
            bulk=bulk_atoms,
            slab=slab_atoms,
            valence_electrons=params.valence_electrons,
            cutoff_mult=params.cutoff_mult,
            bulk_coordination=params.bulk_coordination,
        )

        result = passivator.passivate(
            selected_indices=params.selected_indices,
            passivate_top=params.passivate_top,
            passivate_bottom=params.passivate_bottom,
            surface_depth=params.surface_depth,
            bond_length_scale=params.bond_length_scale,
        )

        if len(result.pseudo_h_list) == 0:
            return PseudoHydrogenResult(
                structure=request.slab,
                n_pseudo_h=0,
                bulk_coordination=result.bulk_coordination,
                valence_used=result.valence_used,
                pseudo_h_list=[],
                unique_potcars=[],
                bond_warnings=result.bond_warnings,
                message="No undercoordinated atoms found. No pseudo-H added.",
            )

        # Convert back to PymatgenStructure
        result_structure = ase_to_pymatgen(result.slab)

        # Build a mapping from pseudo-H site index to PseudoHInfo.
        # Pseudo-H atoms are appended after original slab atoms, grouped by
        # charge type (sorted by vasp_charge), matching the order in
        # SlabPassivator.passivate().
        import numpy as np
        charge_groups: dict[float, list] = {}
        for h in result.pseudo_h_list:
            charge_groups.setdefault(h.vasp_charge, []).append(h)

        pseudo_h_site_map: dict[int, "PseudoHInfo"] = {}  # noqa: F821
        idx = n_slab_atoms
        for charge in sorted(charge_groups.keys()):
            for h in charge_groups[charge]:
                pseudo_h_site_map[idx] = h
                idx += 1

        # Preserve original site properties (selective_dynamics etc.)
        # and annotate pseudo-H sites with charge info for POSCAR export.
        original_sites = request.slab.sites
        for i, site in enumerate(result_structure.sites):
            if i < n_slab_atoms:
                site.properties = original_sites[i].properties
            else:
                h_info = pseudo_h_site_map.get(i)
                potcar = h_info.potcar_name if h_info else "H"
                vasp_charge = h_info.vasp_charge if h_info else 1.0
                site.properties = {
                    "selective_dynamics": [False, False, False],
                    "pseudo_h_potcar": potcar,
                    "pseudo_h_charge": vasp_charge,
                }
                # Set label to POTCAR name so export can distinguish types
                site.label = potcar

        # Build response pseudo-H info list
        pseudo_h_response = [
            PseudoHInfoResponse(
                position=h.position.tolist(),
                charge=round(h.charge, 4),
                vasp_charge=h.vasp_charge,
                potcar_name=h.potcar_name,
                parent_index=h.parent_index,
                parent_symbol=h.parent_symbol,
                missing_symbol=h.missing_symbol,
            )
            for h in result.pseudo_h_list
        ]

        # Build summary message
        by_type: dict[tuple, int] = {}
        for h in result.pseudo_h_list:
            key = (h.parent_symbol, h.missing_symbol, h.vasp_charge)
            by_type[key] = by_type.get(key, 0) + 1

        parts = []
        for (parent, missing, charge), count in sorted(by_type.items()):
            parts.append(f"{parent}(missing {missing}): {count}x H(Z={charge:.2f})")
        breakdown = "; ".join(parts)
        message = f"Added {len(result.pseudo_h_list)} pseudo-H atoms. {breakdown}"

        return PseudoHydrogenResult(
            structure=result_structure,
            n_pseudo_h=len(result.pseudo_h_list),
            bulk_coordination=result.bulk_coordination,
            valence_used=result.valence_used,
            pseudo_h_list=pseudo_h_response,
            unique_potcars=result.unique_potcars,
            bond_warnings=result.bond_warnings,
            message=message,
        )

    except Exception as e:
        logger.error("Passivation error: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/health")
def pseudo_hydrogen_health():
    """Health check for pseudo-hydrogen endpoint."""
    return {"status": "healthy", "service": "pseudo-hydrogen"}
