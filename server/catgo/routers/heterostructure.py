"""Heterostructure (coherent interface) API endpoints."""

import io
import json
import logging
import zipfile

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pymatgen.core import Lattice as PmgLattice
from pymatgen.core import Structure as PmgStructure

from catgo.models.heterostructure import (
    GridScanParams,
    GridScanRequest,
    GridScanResult,
    GridScanShiftEntry,
    HeterostructureBuildParams,
    HeterostructureBuildRequest,
    HeterostructureBuildResult,
    HeterostructureMatch,
    HeterostructureMode,
    HeterostructureSearchParams,
    HeterostructureSearchRequest,
    HeterostructureSearchResult,
    HeterostructureTermination,
    IntermatBuildParams,
    IntermatBuildRequest,
    IntermatBuildResult,
    LateralBuildParams,
    LateralBuildRequest,
    LateralBuildResult,
    LateralMatch,
    LateralSearchParams,
    LateralSearchRequest,
    LateralSearchResult,
    ManualBuildRequest,
    RegistryCandidatesRequest,
)
from catgo.models.structure import Lattice, PymatgenStructure, Site, Species
from catgo.utils.heterostructure_algorithm import (
    build_interface,
    build_interface_intermat,
    build_interface_manual,
    build_interface_slab,
    build_lateral_interface,
    build_registry_candidates,
    generate_grid_scan_structures,
    get_2d_symmetry_operations,
    get_irreducible_grid_points,
    search_lateral_matches,
    search_matches,
    search_matches_slab,
    _normalize_interface_orientation,
    _strip_vacuum,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/heterostructure", tags=["heterostructure"])


def _model_to_native(structure: PymatgenStructure) -> PmgStructure:
    """Convert our PymatgenStructure model to pymatgen's native Structure."""
    lattice = PmgLattice(structure.lattice.matrix)

    species_list = []
    coords_list = []
    inv_matrix = np.linalg.inv(np.array(structure.lattice.matrix))
    for site in structure.sites:
        species_dict = {}
        for sp in site.species:
            species_dict[sp.element] = species_dict.get(sp.element, 0) + sp.occu
        dominant = max(species_dict, key=species_dict.get)
        species_list.append(dominant)
        if site.abc is not None:
            coords_list.append(site.abc)
        else:
            frac = inv_matrix @ np.array(site.xyz)
            coords_list.append(frac.tolist())

    return PmgStructure(lattice, species_list, coords_list)


def _native_to_model(structure: PmgStructure) -> PymatgenStructure:
    """Convert pymatgen native Structure to our PymatgenStructure model."""
    import numpy as np

    matrix = structure.lattice.matrix.tolist()
    latt = Lattice(
        matrix=matrix,
        pbc=[True, True, True],
        a=float(structure.lattice.a),
        b=float(structure.lattice.b),
        c=float(structure.lattice.c),
        alpha=float(structure.lattice.alpha),
        beta=float(structure.lattice.beta),
        gamma=float(structure.lattice.gamma),
        volume=float(structure.lattice.volume),
    )

    sites = []
    for site in structure:
        element = str(site.specie)
        sites.append(
            Site(
                species=[Species(element=element, occu=1.0, oxidation_state=0)],
                abc=list(site.frac_coords),
                xyz=list(site.coords),
                label=element,
                properties={},
            )
        )

    return PymatgenStructure(lattice=latt, sites=sites)


@router.post("/search", response_model=HeterostructureSearchResult)
def search_heterostructure_matches(
    request: HeterostructureSearchRequest,
) -> HeterostructureSearchResult:
    """Phase 1: Find lattice-matched superlattices between substrate and film.

    Returns a list of ZSL matches (sorted by area) and available termination pairs.
    """
    try:
        params = request.params or HeterostructureSearchParams()

        substrate = _model_to_native(request.substrate)
        film = _model_to_native(request.film)

        if params.mode == HeterostructureMode.SLAB:
            result = search_matches_slab(
                substrate_slab=substrate,
                film_slab=film,
                max_area=params.max_area,
                max_area_ratio_tol=params.max_area_ratio_tol,
                max_length_tol=params.max_length_tol,
                max_angle_tol=params.max_angle_tol,
                max_results=params.max_results,
            )
        else:
            result = search_matches(
                substrate_structure=substrate,
                film_structure=film,
                substrate_miller=tuple(params.substrate_miller),
                film_miller=tuple(params.film_miller),
                max_area=params.max_area,
                max_area_ratio_tol=params.max_area_ratio_tol,
                max_length_tol=params.max_length_tol,
                max_angle_tol=params.max_angle_tol,
                max_results=params.max_results,
            )

        matches = [
            HeterostructureMatch(
                match_id=m.match_id,
                match_area=m.match_area,
                film_miller=list(params.film_miller),
                substrate_miller=list(params.substrate_miller),
                film_transformation=m.film_transformation,
                substrate_transformation=m.substrate_transformation,
                film_sl_vectors=m.film_sl_vectors,
                substrate_sl_vectors=m.substrate_sl_vectors,
                strain=m.strain,
                n_atoms_substrate=m.n_atoms_substrate,
                n_atoms_film=m.n_atoms_film,
            )
            for m in result.matches
        ]

        terminations = [
            HeterostructureTermination(
                film_termination=t.film_termination,
                substrate_termination=t.substrate_termination,
                label=f"{t.film_termination} / {t.substrate_termination}",
            )
            for t in result.terminations
        ]

        n_matches = len(matches)
        n_terms = len(terminations)
        msg = f"Found {n_matches} lattice matches, {n_terms} termination pairs"

        return HeterostructureSearchResult(
            matches=matches,
            terminations=terminations,
            n_matches=n_matches,
            n_terminations=n_terms,
            message=msg,
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error searching heterostructure matches: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/build", response_model=HeterostructureBuildResult)
def build_heterostructure(
    request: HeterostructureBuildRequest,
) -> HeterostructureBuildResult:
    """Phase 2: Build the heterostructure interface for a selected match and termination."""
    try:
        params = request.params or HeterostructureBuildParams()
        search_params = request.search_params or HeterostructureSearchParams()

        substrate = _model_to_native(request.substrate)
        film = _model_to_native(request.film)

        if search_params.mode == HeterostructureMode.SLAB:
            result = build_interface_slab(
                substrate_slab=substrate,
                film_slab=film,
                match_index=request.match.match_id,
                gap=params.gap,
                vacuum=params.vacuum,
                twist_angle=params.twist_angle,
                max_area=search_params.max_area,
                max_area_ratio_tol=search_params.max_area_ratio_tol,
                max_length_tol=search_params.max_length_tol,
                max_angle_tol=search_params.max_angle_tol,
            )
        else:
            result = build_interface(
                substrate_structure=substrate,
                film_structure=film,
                substrate_miller=tuple(search_params.substrate_miller),
                film_miller=tuple(search_params.film_miller),
                match_index=request.match.match_id,
                termination_index=request.termination_index,
                gap=params.gap,
                vacuum=params.vacuum,
                substrate_thickness=params.substrate_thickness,
                film_thickness=params.film_thickness,
                twist_angle=params.twist_angle,
                max_area=search_params.max_area,
                max_area_ratio_tol=search_params.max_area_ratio_tol,
                max_length_tol=search_params.max_length_tol,
                max_angle_tol=search_params.max_angle_tol,
            )

        structure_model = _native_to_model(result["structure"])

        return HeterostructureBuildResult(
            structure=structure_model,
            n_atoms=result["n_atoms"],
            n_atoms_substrate=result["n_atoms_substrate"],
            n_atoms_film=result["n_atoms_film"],
            match_area=result["match_area"],
            strain=result["strain"],
            message=(
                f"Built interface: {result['n_atoms']} atoms "
                f"({result['n_atoms_substrate']} substrate + {result['n_atoms_film']} film), "
                f"area={result['match_area']:.1f} Å², strain={result['strain']:.2f}%"
            ),
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error building heterostructure: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/batch-build")
def batch_build_registry_candidates(
    request: RegistryCandidatesRequest,
):
    """Generate N×N registry candidates and return as a zip archive.

    Each candidate is the same ZSL match with a different in-plane xy shift
    of the film layer.  The zip contains individual structure files plus a
    manifest.json summarising all candidates.
    """
    try:
        search_params = request.search_params or HeterostructureSearchParams()

        substrate = _model_to_native(request.substrate)
        film = _model_to_native(request.film)

        candidates = build_registry_candidates(
            substrate_slab=substrate,
            film_slab=film,
            match_index=request.match.match_id,
            n_shift=request.n_shift,
            gap=request.gap,
            vacuum=request.vacuum,
            fmt=request.fmt,
            max_area=search_params.max_area,
            max_area_ratio_tol=search_params.max_area_ratio_tol,
            max_length_tol=search_params.max_length_tol,
            max_angle_tol=search_params.max_angle_tol,
            step_angstrom=request.step_angstrom,
            target_z=request.target_z,
        )

        # Serialize structures and build zip
        fmt = request.fmt.lower()
        ext = {"cif": "cif", "poscar": "vasp", "xyz": "xyz", "extxyz": "extxyz"}.get(fmt, "cif")
        file_ext = {"cif": ".cif", "poscar": ".vasp", "xyz": ".xyz", "extxyz": ".extxyz"}.get(fmt, ".cif")

        buf = io.BytesIO()
        manifest = []
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for cand in candidates:
                struct = cand["structure"]
                label = cand["label"]
                filename = f"hetero_{label}{file_ext}"

                # Serialize structure to string
                content = struct.to(fmt=ext)

                zf.writestr(filename, content)
                manifest.append({
                    "filename": filename,
                    "shift_a": cand["shift_a"],
                    "shift_b": cand["shift_b"],
                    "n_atoms": cand["n_atoms"],
                    "match_area": cand["match_area"],
                    "strain": cand["strain"],
                })

            zf.writestr("manifest.json", json.dumps(manifest, indent=2))

        buf.seek(0)
        n = len(candidates)
        return StreamingResponse(
            buf,
            media_type="application/zip",
            headers={
                "Content-Disposition": f"attachment; filename=registry_candidates_{n}.zip",
                "X-Candidate-Count": str(n),
            },
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error generating registry candidates: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/build-intermat", response_model=IntermatBuildResult)
def build_heterostructure_intermat(
    request: IntermatBuildRequest,
) -> IntermatBuildResult:
    """Build a heterostructure using the intermat/JARVIS pipeline.

    One-step generation: no separate search phase needed.
    Uses more permissive ZSL tolerances and optional displacement scanning.
    """
    try:
        params = request.params or IntermatBuildParams()

        substrate = _model_to_native(request.substrate)
        film = _model_to_native(request.film)

        result = build_interface_intermat(
            substrate_structure=substrate,
            film_structure=film,
            substrate_miller=tuple(params.substrate_miller),
            film_miller=tuple(params.film_miller),
            substrate_thickness=params.substrate_thickness,
            film_thickness=params.film_thickness,
            separation=params.separation,
            vacuum=params.vacuum,
            max_area=params.max_area,
            ltol=params.ltol,
            atol=params.atol,
            max_area_ratio_tol=params.max_area_ratio_tol,
            apply_strain=params.apply_strain,
            disp_intvl=params.disp_intvl,
        )

        structure_model = _native_to_model(result["structure"])

        return IntermatBuildResult(
            structure=structure_model,
            n_atoms=result["n_atoms"],
            n_atoms_substrate=result["n_atoms_substrate"],
            n_atoms_film=result["n_atoms_film"],
            match_area=result["match_area"],
            strain=result["strain"],
            mismatch_u=result["mismatch_u"],
            mismatch_v=result["mismatch_v"],
            mismatch_angle=result["mismatch_angle"],
            area_substrate=result["area_substrate"],
            area_film=result["area_film"],
            message=(
                f"Intermat: {result['n_atoms']} atoms "
                f"({result['n_atoms_substrate']} sub + {result['n_atoms_film']} film), "
                f"mismatch u={result['mismatch_u']:.2f}% v={result['mismatch_v']:.2f}% "
                f"angle={result['mismatch_angle']:.2f}°"
            ),
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error building intermat heterostructure: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/build-manual", response_model=HeterostructureBuildResult)
def build_heterostructure_manual(
    request: ManualBuildRequest,
) -> HeterostructureBuildResult:
    """Build a slab heterostructure with user-specified 2×2 transforms (no ZSL search)."""
    try:
        substrate = _model_to_native(request.substrate)
        film = _model_to_native(request.film)

        result = build_interface_manual(
            substrate_slab=substrate,
            film_slab=film,
            substrate_transform=request.substrate_transform,
            film_transform=request.film_transform,
            gap=request.gap,
            vacuum=request.vacuum,
            twist_angle=request.twist_angle,
        )

        structure_model = _native_to_model(result["structure"])

        return HeterostructureBuildResult(
            structure=structure_model,
            n_atoms=result["n_atoms"],
            n_atoms_substrate=result["n_atoms_substrate"],
            n_atoms_film=result["n_atoms_film"],
            match_area=result["match_area"],
            strain=result["strain"],
            message=(
                f"Manual build: {result['n_atoms']} atoms "
                f"({result['n_atoms_substrate']} sub + {result['n_atoms_film']} film), "
                f"area={result['match_area']:.1f} Å², strain={result['strain']:.2f}%"
            ),
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error in manual heterostructure build: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/search-lateral", response_model=LateralSearchResult)
def search_lateral_matches_endpoint(
    request: LateralSearchRequest,
) -> LateralSearchResult:
    """Find 1D edge-matched supercell pairs for lateral heterojunction."""
    try:
        params = request.params or LateralSearchParams()

        slab_A = _model_to_native(request.slab_A)
        slab_B = _model_to_native(request.slab_B)

        result = search_lateral_matches(
            slab_A=slab_A,
            slab_B=slab_B,
            interface_axis=params.interface_axis,
            max_length=params.max_length,
            max_strain=params.max_strain,
            max_results=params.max_results,
        )

        matches = [
            LateralMatch(
                match_id=m.match_id,
                n1=m.n1,
                n2=m.n2,
                edge_length_A=m.edge_length_A,
                edge_length_B=m.edge_length_B,
                strain_percent=m.strain_percent,
                n_atoms_A=m.n_atoms_A,
                n_atoms_B=m.n_atoms_B,
            )
            for m in result
        ]

        return LateralSearchResult(
            matches=matches,
            n_matches=len(matches),
            message=f"Found {len(matches)} lateral edge matches",
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error searching lateral matches: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/build-lateral", response_model=LateralBuildResult)
def build_lateral_endpoint(
    request: LateralBuildRequest,
) -> LateralBuildResult:
    """Build a lateral heterojunction from two slabs joined side-by-side."""
    try:
        params = request.params or LateralBuildParams()
        search_params = request.search_params or LateralSearchParams()

        slab_A = _model_to_native(request.slab_A)
        slab_B = _model_to_native(request.slab_B)

        result = build_lateral_interface(
            slab_A=slab_A,
            slab_B=slab_B,
            match_index=request.match.match_id,
            interface_axis=search_params.interface_axis,
            width_A=params.width_A,
            width_B=params.width_B,
            buffer=params.buffer,
            vacuum=params.vacuum,
            max_length=search_params.max_length,
            max_strain=search_params.max_strain,
        )

        structure_model = _native_to_model(result["structure"])

        return LateralBuildResult(
            structure=structure_model,
            n_atoms=result["n_atoms"],
            n_atoms_A=result["n_atoms_A"],
            n_atoms_B=result["n_atoms_B"],
            interface_length=result["interface_length"],
            strain=result["strain"],
            message=(
                f"Lateral: {result['n_atoms']} atoms "
                f"({result['n_atoms_A']} A + {result['n_atoms_B']} B), "
                f"interface={result['interface_length']:.2f} Å, "
                f"strain={result['strain']:.2f}%"
            ),
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error building lateral heterostructure: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/grid-scan", response_model=GridScanResult)
def grid_scan_heterostructure(request: GridScanRequest) -> GridScanResult:
    """Scan lateral shifts across the irreducible wedge of the film slab.

    Analyzes the 2D symmetry of the film, generates a grid of shift points
    reduced by symmetry, and builds one heterostructure per irreducible point.
    """
    try:
        params = request.params or GridScanParams()

        # Fix orientation of heterostructures built before normalization
        # existed (c-down / left-handed cells) — atom order is preserved,
        # so n_atoms_substrate stays valid.
        hetero = _normalize_interface_orientation(
            _model_to_native(request.heterostructure)
        )
        film = _model_to_native(request.film)

        # Strip vacuum from film for correct symmetry analysis
        film_stripped = _strip_vacuum(film)

        # 1. Analyze 2D symmetry of the film slab
        sym_ops_2d = get_2d_symmetry_operations(film_stripped, symprec=params.symprec)

        # 2. Determine irreducible zone and generate grid within it
        irr_points, zone_extent = get_irreducible_grid_points(
            sym_ops_2d, params.n_grid_x, params.n_grid_y,
        )
        n_points = len(irr_points)

        # Compute step sizes in Angstrom
        lattice = hetero.lattice
        a_len = float(np.linalg.norm(lattice.matrix[0]))
        b_len = float(np.linalg.norm(lattice.matrix[1]))
        step_a = (zone_extent[0] * a_len) / max(params.n_grid_x, 1)
        step_b = (zone_extent[1] * b_len) / max(params.n_grid_y, 1)

        # 3. Shift film atoms in the already-built heterostructure
        scan_entries = generate_grid_scan_structures(
            heterostructure=hetero,
            n_atoms_substrate=request.n_atoms_substrate,
            irreducible_points=irr_points,
        )

        # 4. Convert to response
        entries: list[GridScanShiftEntry] = []
        structures: list[PymatgenStructure] = []
        labels: list[str] = []

        for entry in scan_entries:
            struct_model = _native_to_model(entry.structure)
            label = f"shift_({entry.shift_frac[0]:.3f},{entry.shift_frac[1]:.3f})"
            entries.append(GridScanShiftEntry(
                shift_frac=list(entry.shift_frac),
                shift_cart=list(entry.shift_cart),
                structure=struct_model,
                n_atoms=entry.n_atoms,
                label=label,
            ))
            structures.append(struct_model)
            labels.append(label)

        return GridScanResult(
            entries=entries,
            n_total_grid=n_points,
            n_irreducible=n_points,
            n_symmetry_ops=len(sym_ops_2d),
            reduction_ratio=round(1.0 / max(zone_extent[0] * zone_extent[1], 1e-6), 1),
            structures=structures,
            labels=labels,
            message=(
                f"{n_points} structures ({params.n_grid_x}×{params.n_grid_y} grid in "
                f"irreducible zone {zone_extent[0]:.1%}×{zone_extent[1]:.1%} of cell, "
                f"step ≈ {step_a:.2f}×{step_b:.2f} Å, {len(sym_ops_2d)} sym ops)"
            ),
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error in grid scan: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/health")
def heterostructure_health():
    """Health check for heterostructure endpoint."""
    return {"status": "healthy", "service": "heterostructure"}
