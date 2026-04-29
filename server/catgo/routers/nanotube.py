"""Nanotube construction API endpoints."""

import logging
import traceback

import numpy as np
from fastapi import APIRouter, HTTPException

from catgo.models.nanotube import (
    NanotubeBuildRequest,
    NanotubeBuildResult,
    NanotubeInfoRequest,
    NanotubeInfoResult,
    WallInfo,
)
from catgo.models.structure import Lattice, PymatgenStructure, Site, Species
from catgo.utils.nanotube_algorithm import (
    build_mwnt,
    build_nanotube,
    compute_nanotube_info,
    extract_2d_layer,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/nanotube", tags=["nanotube"])


def _classify_chirality(n: int, m: int) -> str:
    if m == 0:
        return "zigzag"
    elif n == m:
        return "armchair"
    else:
        return "chiral"


def _extract_layer_data(layer) -> tuple[np.ndarray, np.ndarray, list[str], list[list[float]], list[float]]:
    """Extract 2D lattice vectors, elements, and basis from layer input."""
    if layer.structure is not None:
        return extract_2d_layer(layer.structure.model_dump())

    if layer.lattice_vectors is None or layer.elements is None or layer.basis_coords is None:
        raise ValueError(
            "Either structure or (lattice_vectors, elements, basis_coords) must be provided"
        )

    vecs = layer.lattice_vectors
    a1 = np.array(vecs[0], dtype=float)
    a2 = np.array(vecs[1], dtype=float)
    elements = layer.elements
    basis = [list(bc) for bc in layer.basis_coords]
    z_coords = layer.z_coords if layer.z_coords else [0.0] * len(elements)

    return a1, a2, elements, basis, z_coords


@router.post("/info", response_model=NanotubeInfoResult)
def get_nanotube_info(request: NanotubeInfoRequest) -> NanotubeInfoResult:
    """Compute nanotube geometry information without building the structure.

    Returns diameter, circumference, chiral angle, translational vector length,
    estimated atom count, and chirality type.
    """
    try:
        a1, a2, elements, basis, z_coords = _extract_layer_data(request.layer)
        p = request.params

        if p.n == 0 and p.m == 0:
            raise ValueError("Both chiral indices cannot be zero")

        info = compute_nanotube_info(a1, a2, p.n, p.m, p.NL, len(elements))
        chirality = _classify_chirality(p.n, p.m)

        return NanotubeInfoResult(
            chiral_angle_deg=info.chiral_angle_deg,
            circumference=info.circumference,
            diameter=info.diameter,
            radius=info.radius,
            trans_length=info.trans_length,
            tube_length=info.tube_length,
            n_atoms_estimate=info.n_atoms,
            t1=info.t1,
            t2=info.t2,
            chirality=chirality,
            message=f"({p.n},{p.m}) {chirality} nanotube: D={info.diameter:.2f} Å, "
            f"L={info.tube_length:.2f} Å, ~{info.n_atoms} atoms",
        )

    except Exception as e:
        logger.error("Error computing nanotube info: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/build", response_model=NanotubeBuildResult)
def build_nanotube_structure(request: NanotubeBuildRequest) -> NanotubeBuildResult:
    """Build a nanotube by rolling up a 2D material sheet.

    Given a 2D layer definition and chiral indices (n, m), constructs
    the nanotube with NL unit cells along the tube axis.

    Returns the structure in PymatgenStructure format.
    """
    try:
        a1, a2, elements, basis, z_coords = _extract_layer_data(request.layer)
        p = request.params

        if p.n == 0 and p.m == 0:
            raise ValueError("Both chiral indices cannot be zero")

        n_walls = getattr(p, "n_walls", 1) or 1
        interlayer = getattr(p, "interlayer_spacing", 3.4) or 3.4

        logger.info(
            "Building nanotube (%d,%d) NL=%d, walls=%d, spacing=%.1f Å, vacuum=%.1f Å",
            p.n, p.m, p.NL, n_walls, interlayer, p.vacuum,
        )

        if n_walls > 1:
            all_elements, positions_3d, cell_3d, mwnt_info = build_mwnt(
                a1, a2, elements, basis, z_coords,
                p.n, p.m, n_walls, interlayer, p.NL, p.vacuum,
            )
            inner = mwnt_info.inner_info
            walls_out = [
                WallInfo(n=w.n, m=w.m, radius=w.radius, n_atoms=w.n_atoms)
                for w in mwnt_info.walls
            ]
            tube_length = mwnt_info.tube_length
        else:
            all_elements, positions_3d, cell_3d, info = build_nanotube(
                a1, a2, elements, basis, z_coords,
                p.n, p.m, p.NL, p.vacuum,
            )
            inner = info
            walls_out = [WallInfo(n=p.n, m=p.m, radius=info.radius, n_atoms=info.n_atoms)]
            tube_length = info.tube_length

        chirality = _classify_chirality(p.n, p.m)
        n_atoms = len(all_elements)

        # Convert to PymatgenStructure
        cell_inv = np.linalg.inv(cell_3d)
        frac_coords = positions_3d @ cell_inv.T

        a_len, b_len, c_len = [np.linalg.norm(cell_3d[i]) for i in range(3)]
        lattice = Lattice(
            matrix=cell_3d.tolist(),
            a=float(a_len),
            b=float(b_len),
            c=float(c_len),
            alpha=90.0,
            beta=90.0,
            gamma=90.0,
            volume=float(abs(np.linalg.det(cell_3d))),
            pbc=[False, True, False],
        )

        sites = []
        for i in range(n_atoms):
            sites.append(
                Site(
                    species=[Species(element=all_elements[i], occu=1.0)],
                    abc=frac_coords[i].tolist(),
                    xyz=positions_3d[i].tolist(),
                    label=all_elements[i],
                    properties={"nanotube": True},
                )
            )

        result_structure = PymatgenStructure(lattice=lattice, sites=sites)

        # Build message
        if n_walls > 1:
            wall_strs = [f"({w.n},{w.m}) R={w.radius:.1f}Å" for w in walls_out]
            msg = (f"Built {n_walls}-wall nanotube: {n_atoms} atoms, "
                   f"L={tube_length:.2f} Å. Walls: {', '.join(wall_strs)}")
        else:
            msg = (f"Built ({p.n},{p.m}) {chirality} nanotube: {n_atoms} atoms, "
                   f"D={inner.diameter:.2f} Å, L={tube_length:.2f} Å")

        logger.info(msg)

        return NanotubeBuildResult(
            structure=result_structure,
            n_atoms=n_atoms,
            chiral_angle_deg=inner.chiral_angle_deg,
            circumference=inner.circumference,
            diameter=inner.diameter,
            tube_length=tube_length,
            chirality=chirality,
            n_walls=n_walls,
            walls=walls_out,
            message=msg,
        )

    except Exception as e:
        logger.error("Error building nanotube: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/health")
def nanotube_health():
    """Health check for nanotube endpoint."""
    return {"status": "healthy", "service": "nanotube"}
