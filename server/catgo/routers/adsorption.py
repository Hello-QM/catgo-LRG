"""Adsorption site finding API endpoints using Alpha Shape (V7) algorithm."""

import logging

import numpy as np
from fastapi import APIRouter, HTTPException

from catgo.models.adsorption import (
    AdsorptionSite,
    AdsorptionSiteFinderParams,
    AdsorptionSiteRequest,
    AdsorptionSiteResult,
    AdsorptionSiteType,
)
from catgo.models.adsorbate import AdsorbatePlacementRequest, AdsorbatePlacementResult
from catgo.utils import ase_to_pymatgen, pymatgen_to_ase
from catgo.utils.adsorbate_placement import place_adsorbate

logger = logging.getLogger(__name__)

try:
    from catgo.utils.alpha_shape import (
        compute_sites,
        expand_coords_for_pbc,
        filter_sites_in_cell,
        filter_upper_surface,
        find_surface_atoms,
    )
    _ALPHA_SHAPE_AVAILABLE = True
except ImportError:
    _ALPHA_SHAPE_AVAILABLE = False
    logger.warning("alpha_shape module not available — /adsorption/sites endpoint disabled (use WASM frontend)")

router = APIRouter(prefix="/adsorption", tags=["adsorption"])


def compute_env_signature(elements: list[str]) -> str:
    """Compute environment signature from neighbor elements."""
    if not elements:
        return ""
    return "-".join(sorted(elements))


def find_neighbors(
    site_pos: np.ndarray,
    positions: np.ndarray,
    symbols: list[str],
    cutoff: float = 3.0,
    max_neighbors: int = 6,
    cell: np.ndarray | None = None,
    use_pbc: bool = False,
) -> tuple[list[int], list[str]]:
    """Find neighboring atoms for a site, with optional PBC via minimum image convention."""
    diffs = positions - site_pos

    if use_pbc and cell is not None:
        # Minimum image convention: convert to fractional, wrap to [-0.5, 0.5), convert back
        cell_inv = np.linalg.inv(cell.T)
        frac_diffs = diffs @ cell_inv.T
        frac_diffs -= np.round(frac_diffs)
        diffs = frac_diffs @ cell

    distances = np.linalg.norm(diffs, axis=1)
    sorted_indices = np.argsort(distances)

    neighbor_indices = []
    neighbor_elements = []

    for idx in sorted_indices:
        if distances[idx] < cutoff and len(neighbor_indices) < max_neighbors:
            neighbor_indices.append(int(idx))
            neighbor_elements.append(symbols[idx])

    return neighbor_indices, neighbor_elements


@router.post("/sites", response_model=AdsorptionSiteResult)
def find_adsorption_sites(request: AdsorptionSiteRequest) -> AdsorptionSiteResult:
    """Find adsorption sites using Alpha Shape (V7) algorithm.

    Algorithm:
    1. Convert structure to ASE Atoms
    2. Auto-detect PBC from structure if params.pbc is None
    3. Find surface atoms via Alpha Shape (3x3 expansion for PBC)
    4. Filter bottom layer if PBC and not keep_bottom
    5. Expand surface coords for PBC; compute sites via compute_sites()
    6. Filter sites to original cell
    7. Convert numpy arrays to AdsorptionSite objects with neighbor info
    """
    if not _ALPHA_SHAPE_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="Server-side alpha_shape module is disabled. Use WASM frontend (should happen automatically).",
        )
    try:
        params = request.params or AdsorptionSiteFinderParams()

        # Convert to ASE atoms
        atoms = pymatgen_to_ase(request.structure)
        positions = atoms.get_positions()
        symbols = atoms.get_chemical_symbols()
        cell = np.array(atoms.get_cell())
        pbc_flags = np.array(atoms.get_pbc())
        n_atoms = len(atoms)

        # Determine PBC mode
        use_pbc = params.pbc if params.pbc is not None else bool(any(pbc_flags))
        logger.info(
            "Finding adsorption sites: %d atoms, PBC=%s (auto=%s), alpha=%.1f",
            n_atoms,
            use_pbc,
            params.pbc is None,
            params.alpha,
        )

        # ========================================
        # STEP 1: Find surface atoms via Alpha Shape
        # ========================================
        coords = positions.copy()

        if use_pbc:
            # 3x3 periodic expansion for surface detection
            lattice = cell
            extended_coords = []
            for i in [-1, 0, 1]:
                for j in [-1, 0, 1]:
                    shift = i * lattice[0] + j * lattice[1]
                    extended_coords.append(coords + shift)

            all_coords = np.vstack(extended_coords)
            indices_raw = find_surface_atoms(all_coords, params.alpha)

            # Extract indices belonging to the center cell (index 4 in 3x3 grid)
            start_idx = 4 * n_atoms
            end_idx = 5 * n_atoms
            surface_indices = [idx - start_idx for idx in indices_raw if start_idx <= idx < end_idx]
        else:
            surface_indices = list(find_surface_atoms(coords, params.alpha))

        if len(surface_indices) == 0:
            return AdsorptionSiteResult(
                sites=[],
                n_top=0,
                n_bridge=0,
                n_hollow3=0,
                n_hollow4=0,
                message="No surface atoms found. Try adjusting the alpha parameter.",
            )

        surface_coords = coords[surface_indices]
        logger.info("Found %d surface atoms out of %d total", len(surface_indices), n_atoms)

        # ========================================
        # STEP 2: Filter bottom layer (PBC mode)
        # ========================================
        if use_pbc and not params.keep_bottom:
            surface_coords, kept_indices = filter_upper_surface(
                surface_coords, positions, bottom_fraction=params.bottom_fraction
            )
            # Update surface_indices to reflect removed bottom atoms
            surface_indices = [surface_indices[i] for i in kept_indices]
            logger.info("After bottom-layer removal: %d surface atoms", len(surface_indices))

        if len(surface_indices) == 0:
            return AdsorptionSiteResult(
                sites=[],
                n_top=0,
                n_bridge=0,
                n_hollow3=0,
                n_hollow4=0,
                message="No surface atoms after bottom-layer removal.",
            )

        # ========================================
        # STEP 3: Compute adsorption sites
        # ========================================
        if use_pbc:
            # Expand surface coordinates for PBC site computation
            expanded_surface_coords, _original_indices = expand_coords_for_pbc(
                surface_coords, cell, params.expansion_distance
            )
            # Also expand all atom coordinates (for normal computation and internal filtering)
            expanded_all_coords, _ = expand_coords_for_pbc(coords, cell, params.expansion_distance)

            logger.info(
                "PBC expansion: surface %d -> %d, all %d -> %d",
                len(surface_coords),
                len(expanded_surface_coords),
                len(coords),
                len(expanded_all_coords),
            )

            sites_dict = compute_sites(
                expanded_surface_coords,
                all_atom_coords=expanded_all_coords,
                site_height=params.height,
                distance_gap_ratio=params.gap_ratio,
                blocking_threshold=params.blocking,
                merge_threshold=params.merge,
                filter_internal=params.filter_internal,
                filter_radius=params.filter_radius,
                filter_threshold=params.filter_threshold,
            )

            # Filter to original cell (with normals)
            for site_type in ["top", "bridge", "hollow3", "hollow4"]:
                normals_key = f"{site_type}_normals"
                n_before = len(sites_dict[site_type])
                sites_dict[site_type], sites_dict[normals_key] = filter_sites_in_cell(
                    sites_dict[site_type], cell, normals=sites_dict[normals_key]
                )
                n_after = len(sites_dict[site_type])
                logger.debug("Cell filter %s: %d -> %d", site_type, n_before, n_after)
        else:
            # Non-PBC: compute directly
            sites_dict = compute_sites(
                surface_coords,
                all_atom_coords=coords,
                site_height=params.height,
                distance_gap_ratio=params.gap_ratio,
                blocking_threshold=params.blocking,
                merge_threshold=params.merge,
                filter_internal=params.filter_internal,
                filter_radius=params.filter_radius,
                filter_threshold=params.filter_threshold,
            )

        # ========================================
        # STEP 4: Convert to AdsorptionSite objects
        # ========================================
        sites: list[AdsorptionSite] = []
        site_id_counter = 0

        type_map = {
            "top": AdsorptionSiteType.TOP,
            "bridge": AdsorptionSiteType.BRIDGE,
            "hollow3": AdsorptionSiteType.HOLLOW3,
            "hollow4": AdsorptionSiteType.HOLLOW4,
        }

        for site_type_key, site_type_enum in type_map.items():
            site_positions = sites_dict[site_type_key]
            site_normals = sites_dict.get(f"{site_type_key}_normals", np.array([]))
            for i, pos in enumerate(site_positions):
                neighbor_indices, neighbor_elements = find_neighbors(
                    pos, positions, symbols, cutoff=3.0,
                    cell=cell, use_pbc=use_pbc,
                )

                # Use computed normal if available, else fallback
                if len(site_normals) > i:
                    normal = site_normals[i].tolist()
                else:
                    normal = [0.0, 0.0, 1.0]

                sites.append(
                    AdsorptionSite(
                        id=site_id_counter,
                        position=pos.tolist(),
                        site_type=site_type_enum,
                        normal=normal,
                        neighbor_indices=neighbor_indices,
                        neighbor_elements=neighbor_elements,
                        env_signature=compute_env_signature(neighbor_elements),
                        height=params.height,
                    )
                )
                site_id_counter += 1

        # Count by type
        n_top = len(sites_dict["top"])
        n_bridge = len(sites_dict["bridge"])
        n_hollow3 = len(sites_dict["hollow3"])
        n_hollow4 = len(sites_dict["hollow4"])
        n_total = n_top + n_bridge + n_hollow3 + n_hollow4

        logger.info(
            "Found %d sites: %d top, %d bridge, %d hollow3, %d hollow4",
            n_total,
            n_top,
            n_bridge,
            n_hollow3,
            n_hollow4,
        )

        return AdsorptionSiteResult(
            sites=sites,
            n_top=n_top,
            n_bridge=n_bridge,
            n_hollow3=n_hollow3,
            n_hollow4=n_hollow4,
            message=f"Found {n_total} sites (Alpha Shape V7)",
        )

    except Exception as e:
        import traceback

        logger.error("Error finding adsorption sites: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/place", response_model=AdsorbatePlacementResult)
def place_adsorbate_on_site(request: AdsorbatePlacementRequest) -> AdsorbatePlacementResult:
    """Place an adsorbate molecule at a surface adsorption site.

    Takes a slab structure, adsorbate molecule, binding atom index, and site
    position/normal. Returns the merged structure with the adsorbate placed.
    """
    try:
        from ase import Atoms

        # Convert slab and adsorbate to ASE
        slab_atoms = pymatgen_to_ase(request.slab)
        ads_atoms = pymatgen_to_ase(request.adsorbate)

        # Resolve binding atom indices (support both old single and new multi-dentate)
        if request.binding_atom_indices is not None:
            binding_indices = request.binding_atom_indices
        elif request.binding_atom_index is not None:
            binding_indices = [request.binding_atom_index]
        else:
            binding_indices = [0]

        # Resolve neighbor positions if provided
        neighbor_pos = None
        if request.neighbor_positions is not None and len(request.neighbor_positions) > 0:
            neighbor_pos = np.array(request.neighbor_positions, dtype=float)

        result = place_adsorbate(
            slab_positions=slab_atoms.get_positions(),
            slab_symbols=slab_atoms.get_chemical_symbols(),
            slab_cell=np.array(slab_atoms.get_cell()) if any(slab_atoms.get_pbc()) else None,
            slab_pbc=list(slab_atoms.get_pbc()),
            adsorbate_positions=ads_atoms.get_positions(),
            adsorbate_symbols=ads_atoms.get_chemical_symbols(),
            binding_atom_indices=binding_indices,
            site_position=np.array(request.site_position),
            site_normal=np.array(request.site_normal),
            height_offset=request.height_offset,
            auto_rotate=request.auto_rotate,
            neighbor_positions=neighbor_pos,
        )

        # Build merged ASE Atoms
        merged = Atoms(
            symbols=result["symbols"],
            positions=result["positions"],
            cell=result["cell"],
            pbc=result["pbc"] if result["pbc"] else False,
        )

        # Convert back to PymatgenStructure
        merged_structure = ase_to_pymatgen(merged)

        return AdsorbatePlacementResult(
            structure=merged_structure,
            slab_atom_count=result["slab_atom_count"],
            adsorbate_atom_count=result["adsorbate_atom_count"],
            adsorbate_indices=result["adsorbate_indices"],
            binding_atom_position=result["binding_atom_position"],
            message=f"Placed {result['adsorbate_atom_count']}-atom adsorbate at site",
        )

    except Exception as e:
        import traceback

        logger.error("Error placing adsorbate: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/place-dual")
async def place_dual_adsorbates_on_site(request: dict) -> dict:
    """Place two adsorbates on a slab at neighboring sites with controlled distance.

    Automatically selects the best pair of adsorption sites so that the binding
    atoms face each other at approximately target_distance (default 3.5 Å) —
    the correct pre-coupling geometry for C-N coupling slow-growth AIMD.
    """
    try:
        from ase import Atoms
        from catgo.utils.adsorbate_placement import place_dual_adsorbates

        slab_dict = request.get("slab") or request.get("structure")
        if not slab_dict:
            raise ValueError("Missing 'structure' (or 'slab') in request")
        slab = pymatgen_to_ase(slab_dict)
        ads1 = pymatgen_to_ase(request["adsorbate1"])
        ads2 = pymatgen_to_ase(request["adsorbate2"])

        ads1_binding = request.get("ads1_binding_indices", [0])
        ads2_binding = request.get("ads2_binding_indices", [0])
        target_dist = request.get("target_distance", 3.5)
        dist_tol = request.get("distance_tolerance", 1.5)

        # Get adsorption sites if not provided
        sites = request.get("sites")
        if not sites:
            # Auto-find sites
            site_result = await find_adsorption_sites(
                AdsorptionSiteRequest(structure=slab_dict)
            )
            sites = [
                {"position": s.position, "normal": s.normal, "site_type": s.site_type.value}
                for s in site_result.sites
            ]

        result = place_dual_adsorbates(
            slab_positions=slab.get_positions(),
            slab_symbols=slab.get_chemical_symbols(),
            slab_cell=np.array(slab.get_cell()) if any(slab.get_pbc()) else None,
            slab_pbc=list(slab.get_pbc()),
            ads1_positions=ads1.get_positions(),
            ads1_symbols=ads1.get_chemical_symbols(),
            ads1_binding_indices=ads1_binding,
            ads2_positions=ads2.get_positions(),
            ads2_symbols=ads2.get_chemical_symbols(),
            ads2_binding_indices=ads2_binding,
            sites=sites,
            target_distance=target_dist,
            distance_tolerance=dist_tol,
        )

        merged = Atoms(
            symbols=result["symbols"],
            positions=result["positions"],
            cell=result["cell"],
            pbc=result["pbc"] if result["pbc"] else False,
        )
        merged_structure = ase_to_pymatgen(merged)

        return {
            "structure": merged_structure,
            "ads1_indices": result["ads1_indices"],
            "ads2_indices": result["ads2_indices"],
            "all_adsorbate_indices": result["all_adsorbate_indices"],
            "site1": result["site1"],
            "site2": result["site2"],
            "site_distance": result["site_distance"],
            "binding_distance": result["binding_distance"],
            "message": (
                f"Placed two adsorbates: site distance {result['site_distance']:.2f} Å, "
                f"binding atom distance {result['binding_distance']:.2f} Å"
            ),
        }

    except Exception as e:
        import traceback
        logger.error("Error placing dual adsorbates: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/health")
def adsorption_health():
    """Health check for adsorption endpoint."""
    return {"status": "healthy", "service": "adsorption"}
