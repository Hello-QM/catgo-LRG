"""Moiré superlattice construction endpoints.

Provides two-stage API:
1. POST /moire/search — Find commensurate twist angles for a given bilayer
2. POST /moire/build  — Build the bilayer supercell from a selected candidate
"""

import logging

from fastapi import APIRouter, HTTPException

from catgo.models.moire import (
    MoireAngleSearchParams,
    MoireAngleSearchRequest,
    MoireAngleSearchResult,
    MoireBuildParams,
    MoireBuildRequest,
    MoireBuildResult,
    MoireCandidate,
)
from catgo.utils import ase_to_pymatgen
from catgo.utils.moire_algorithm import (
    CandidateResult,
    build_moire_bilayer,
    deduplicate_candidates,
    deep_search_refine,
    extract_layer_data,
    find_commensurate_angles,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/moire", tags=["moire"])


@router.post("/search", response_model=MoireAngleSearchResult)
def search_commensurate_angles(
    request: MoireAngleSearchRequest,
) -> MoireAngleSearchResult:
    """Search for commensurate twist angles using the coincidence lattice method.

    Algorithm:
    1. Extract 2D lattice vectors and basis atoms from each layer
    2. Sweep through angle range, rotating layer B
    3. For each angle, find integer (m,n,p,q) pairs where superlattice vectors match
    4. Optionally compute strain for exact commensurability
    5. Deduplicate and sort candidates by atom count
    """
    try:
        params = request.params or MoireAngleSearchParams()

        # Extract layer data
        layer_a = extract_layer_data(request.layer_a)
        layer_b_input = request.layer_b if request.layer_b is not None else request.layer_a
        layer_b = extract_layer_data(layer_b_input)

        logger.info(
            f"Moiré angle search: A={layer_a.lattice_2d.tolist()}, "
            f"B={layer_b.lattice_2d.tolist()}, "
            f"angle=[{params.angle_min}, {params.angle_max}], "
            f"max_index={params.max_index}"
        )

        # Handle fixed angle mode
        if params.fix_angle:
            search_angle_min = params.fixed_angle_value
            search_angle_max = params.fixed_angle_value
            search_angle_step = 1.0  # single step
        else:
            search_angle_min = params.angle_min
            search_angle_max = params.angle_max
            search_angle_step = params.angle_step

        # Run coincidence lattice search (initial threshold)
        candidates = find_commensurate_angles(
            A=layer_a.lattice_2d,
            B=layer_b.lattice_2d,
            n_basis_a=layer_a.n_basis,
            n_basis_b=layer_b.n_basis,
            angle_min=search_angle_min,
            angle_max=search_angle_max,
            angle_step=search_angle_step,
            max_index=params.max_index,
            mismatch_threshold=params.mismatch_threshold,
            max_atoms=params.max_atoms,
            apply_strain=params.apply_strain,
            strain_layer=params.strain_layer.value,
        )

        # Optional deep search refinement (uses tighter final_mismatch_threshold)
        if params.deep_search and candidates:
            refined = deep_search_refine(
                A=layer_a.lattice_2d,
                B=layer_b.lattice_2d,
                n_basis_a=layer_a.n_basis,
                n_basis_b=layer_b.n_basis,
                candidates=candidates,
                search_range=params.deep_search_range,
                search_step=params.deep_search_step,
                max_index=params.max_index,
                mismatch_threshold=params.final_mismatch_threshold,
                max_atoms=params.max_atoms,
                apply_strain=params.apply_strain,
                strain_layer=params.strain_layer.value,
            )
            candidates.extend(refined)

        # Filter by max strain percentage
        if params.apply_strain and params.max_strain_percent > 0:
            candidates = [
                c for c in candidates
                if c.strain_percent is None or c.strain_percent <= params.max_strain_percent
            ]

        # Deduplicate and sort
        candidates = deduplicate_candidates(candidates)
        candidates.sort(key=lambda c: c.n_atoms)

        # Limit results
        candidates = candidates[: params.max_results]

        # Convert to response models
        result_candidates = [
            MoireCandidate(
                angle=c.angle,
                m=c.m, n=c.n, p=c.p, q=c.q,
                m2=c.m2, n2=c.n2, p2=c.p2, q2=c.q2,
                mismatch=c.mismatch,
                n_atoms=c.n_atoms,
                area_ratio=c.area_ratio,
                strain_percent=c.strain_percent,
                strain_tensor=c.strain_tensor,
            )
            for c in candidates
        ]

        logger.info(f"Found {len(result_candidates)} commensurate angle candidates")

        return MoireAngleSearchResult(
            candidates=result_candidates,
            n_candidates=len(result_candidates),
            angle_range=[params.angle_min, params.angle_max],
            message=f"Found {len(result_candidates)} commensurate angles in [{params.angle_min}°, {params.angle_max}°]",
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Moiré angle search failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Moiré angle search failed: {e}",
        )


@router.post("/build", response_model=MoireBuildResult)
def build_moire_structure(request: MoireBuildRequest) -> MoireBuildResult:
    """Build a Moiré bilayer supercell from a selected candidate.

    Algorithm:
    1. Extract layer data from inputs
    2. Construct superlattice vectors from candidate indices
    3. Rotate layer B by the twist angle
    4. Optionally apply strain for exact commensurability
    5. Tile both layers into the supercell
    6. Convert to PymatgenStructure for frontend visualization
    """
    try:
        params = request.params or MoireBuildParams()

        # Extract layer data
        layer_a = extract_layer_data(request.layer_a)
        layer_b_input = request.layer_b if request.layer_b is not None else request.layer_a
        layer_b = extract_layer_data(layer_b_input)

        candidate_internal = CandidateResult(
            angle=request.candidate.angle,
            m=request.candidate.m,
            n=request.candidate.n,
            p=request.candidate.p,
            q=request.candidate.q,
            m2=request.candidate.m2,
            n2=request.candidate.n2,
            p2=request.candidate.p2,
            q2=request.candidate.q2,
            mismatch=request.candidate.mismatch,
            n_atoms=request.candidate.n_atoms,
            area_ratio=request.candidate.area_ratio,
            strain_percent=request.candidate.strain_percent,
            strain_tensor=request.candidate.strain_tensor,
        )

        logger.info(
            f"Building Moiré bilayer: angle={request.candidate.angle}°, "
            f"n_atoms≈{request.candidate.n_atoms}, "
            f"translate_z={params.translate_z} Å"
        )

        # Determine strain settings from search candidate
        has_strain = request.candidate.strain_tensor is not None
        # Default to "both" for strain_layer during build
        strain_layer = "both"

        # Build the bilayer
        atoms = build_moire_bilayer(
            layer_a=layer_a,
            layer_b=layer_b,
            candidate=candidate_internal,
            translate_z=params.translate_z,
            vacuum=params.vacuum,
            z_a=params.z_a,
            apply_strain=has_strain,
            strain_layer=strain_layer,
        )

        # Count atoms per layer
        layer_labels = atoms.arrays.get("layer", [])
        n_atoms_a = sum(1 for l in layer_labels if l == "A")
        n_atoms_b = sum(1 for l in layer_labels if l == "B")

        # Convert to PymatgenStructure with layer property
        structure = ase_to_pymatgen(atoms, include_forces=False)

        # Add layer property to each site
        for i, site in enumerate(structure.sites):
            layer_label = str(layer_labels[i]) if i < len(layer_labels) else "A"
            if site.properties is None:
                site.properties = {}
            site.properties["layer"] = layer_label

        # Compute supercell area
        cell = atoms.get_cell()
        sc_area = float(abs(
            cell[0][0] * cell[1][1] - cell[0][1] * cell[1][0]
        ))

        logger.info(
            f"Built Moiré bilayer: {len(atoms)} atoms "
            f"(A={n_atoms_a}, B={n_atoms_b}), area={sc_area:.1f} Å²"
        )

        return MoireBuildResult(
            structure=structure,
            n_atoms=len(atoms),
            n_atoms_layer_a=n_atoms_a,
            n_atoms_layer_b=n_atoms_b,
            angle=request.candidate.angle,
            supercell_area=round(sc_area, 4),
            strain_applied=has_strain,
            message=f"Built Moiré bilayer with {len(atoms)} atoms at θ={request.candidate.angle}°",
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Moiré build failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Moiré bilayer construction failed: {e}",
        )


@router.get("/health")
def moire_health():
    """Health check for Moiré endpoints."""
    return {"status": "healthy", "service": "moire"}
