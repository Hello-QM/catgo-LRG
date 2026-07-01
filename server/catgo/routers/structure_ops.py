"""Fine-grained atom manipulation operations for structure editing.

Provides endpoints for adding, deleting, replacing, and moving atoms,
creating supercells, and merging structures. All operations use pymatgen
internally and handle both periodic (Structure) and non-periodic (Molecule)
cases.
"""

from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pymatgen.core import Element
from pydantic import BaseModel, Field

router = APIRouter(prefix="/structure-ops", tags=["structure-ops"])


# ---------------------------------------------------------------------------
# Request / Response Models
# ---------------------------------------------------------------------------


class StructureResult(BaseModel):
    """Standard response containing a modified structure."""

    structure: dict  # pymatgen Structure.as_dict() or Molecule.as_dict()
    num_sites: int
    is_periodic: bool


class AddAtomRequest(BaseModel):
    """Add a single atom at a Cartesian position."""

    structure: dict
    element: str = Field(..., min_length=1, max_length=3, description="Element symbol")
    position: list[float] = Field(
        ..., min_length=3, max_length=3, description="Cartesian [x, y, z] in Angstroms"
    )


class AtomSpec(BaseModel):
    """Specification for a single atom to add."""

    element: str = Field(..., min_length=1, max_length=3)
    xyz: list[float] = Field(..., min_length=3, max_length=3)


class AddAtomsRequest(BaseModel):
    """Batch-add multiple atoms."""

    structure: dict
    atoms: list[AtomSpec] = Field(..., min_length=1)


class DeleteAtomsRequest(BaseModel):
    """Delete atoms by their site indices."""

    structure: dict
    indices: list[int] = Field(..., min_length=1)


class ReplaceAtomRequest(BaseModel):
    """Replace the element at a given site index."""

    structure: dict
    index: int = Field(..., ge=0)
    new_element: str = Field(..., min_length=1, max_length=3)


class MoveAtomRequest(BaseModel):
    """Move a single atom to a new Cartesian position."""

    structure: dict
    index: int = Field(..., ge=0)
    new_position: list[float] = Field(..., min_length=3, max_length=3)


class MoveAtomsRequest(BaseModel):
    """Translate multiple atoms by a displacement vector."""

    structure: dict
    indices: list[int] = Field(..., min_length=1)
    displacement: list[float] = Field(
        ..., min_length=3, max_length=3, description="[dx, dy, dz] in Angstroms"
    )


class SupercellRequest(BaseModel):
    """Create a supercell via integer scaling or a 3x3 matrix."""

    structure: dict
    scaling: Optional[list[int]] = Field(
        default=None, min_length=3, max_length=3,
        description="[na, nb, nc] integer scaling factors",
    )
    scaling_matrix: Optional[list[list[int]]] = Field(
        default=None, description="3x3 integer scaling matrix"
    )


class GenerateSlabRequest(BaseModel):
    """Generate a surface slab from a bulk structure using Miller indices."""

    structure: dict
    miller_index: list[int] = Field(
        ..., min_length=3, max_length=3,
        description="Miller indices [h, k, l], e.g. [1, 1, 0]",
    )
    min_slab_size: float = Field(
        10.0, description="Minimum slab thickness in Angstroms",
    )
    min_vacuum_size: float = Field(
        15.0, description="Minimum vacuum spacing in Angstroms",
    )
    center_slab: bool = Field(
        True, description="Whether to center the slab in the cell",
    )
    in_unit_planes: bool = Field(
        False,
        description="If True, interpret min_slab_size as number of unit planes "
        "rather than Angstroms",
    )
    max_normal_search: Optional[int] = Field(
        None,
        description="Max integer to search for the normal vector. "
        "Higher values find more accurate normals but are slower.",
    )
    orthogonalize_c: bool = Field(
        True,
        description="If True (default), orthogonalize the c-vector of the slab "
        "so it is perpendicular to the ab surface plane (vacuum cleanly along c "
        "— what surface DFT expects). Set False to keep pymatgen's oriented cell.",
    )


class SlabResult(BaseModel):
    """Response containing generated slab(s)."""

    slabs: list[dict]  # list of pymatgen Structure.as_dict()
    num_slabs: int
    miller_index: list[int]


class MergeRequest(BaseModel):
    """Merge an incoming structure into a base structure."""

    base: dict
    incoming: dict
    position: list[float] = Field(
        ..., min_length=3, max_length=3,
        description="Cartesian [x, y, z] where the incoming center is placed",
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _is_periodic(structure_dict: dict) -> bool:
    """Determine whether a structure dict represents a periodic structure."""
    cls_name = structure_dict.get("@class", "")
    if "Molecule" in cls_name:
        return False
    lattice = structure_dict.get("lattice")
    if lattice and lattice.get("matrix"):
        return True
    return False


def _load_structure(structure_dict: dict):
    """Deserialise a pymatgen dict into a Structure or Molecule.

    Accepts both full pymatgen format (with @module/@class) and simplified
    frontend format (lattice.matrix + sites with xyz/abc).
    """
    from pymatgen.core import Lattice, Molecule, Structure

    if _is_periodic(structure_dict):
        # Try full pymatgen format first
        if "@module" in structure_dict and "@class" in structure_dict:
            return Structure.from_dict(structure_dict), True
        # Simplified frontend format
        lattice = Lattice(structure_dict["lattice"]["matrix"])
        species = []
        coords = []
        coords_are_cartesian = False
        for site in structure_dict["sites"]:
            sp = site["species"][0]["element"]
            species.append(sp)
            if "abc" in site and site["abc"] is not None:
                coords.append(site["abc"])
            else:
                coords.append(site["xyz"])
                coords_are_cartesian = True
        return Structure(lattice, species, coords,
                         coords_are_cartesian=coords_are_cartesian), True
    else:
        return Molecule.from_dict(structure_dict), False


def _make_result(struct, is_periodic: bool) -> StructureResult:
    """Wrap a pymatgen Structure/Molecule into the standard response."""
    return StructureResult(
        structure=struct.as_dict(),
        num_sites=len(struct),
        is_periodic=is_periodic,
    )


def _cartesian_to_fractional(lattice, cart_coords: list[float]) -> np.ndarray:
    """Convert Cartesian coordinates to fractional using a pymatgen Lattice."""
    return lattice.get_fractional_coords(cart_coords)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/add-atom", response_model=StructureResult)
def add_atom(req: AddAtomRequest) -> StructureResult:
    """Add a single atom to a structure at the given Cartesian position."""
    try:
        Element(req.element)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid element symbol: '{req.element}'")
    try:
        struct, periodic = _load_structure(req.structure)

        if periodic:
            frac = _cartesian_to_fractional(struct.lattice, req.position)
            struct.append(req.element, frac, coords_are_cartesian=False)
        else:
            struct.append(req.element, req.position)

        return _make_result(struct, periodic)

    except KeyError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid element symbol: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/add-atoms", response_model=StructureResult)
def add_atoms(req: AddAtomsRequest) -> StructureResult:
    """Batch-add multiple atoms to a structure."""
    for atom in req.atoms:
        try:
            Element(atom.element)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid element symbol: '{atom.element}'")
    try:
        struct, periodic = _load_structure(req.structure)

        for atom in req.atoms:
            if periodic:
                frac = _cartesian_to_fractional(struct.lattice, atom.xyz)
                struct.append(atom.element, frac, coords_are_cartesian=False)
            else:
                struct.append(atom.element, atom.xyz)

        return _make_result(struct, periodic)

    except KeyError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid element symbol: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/delete-atoms", response_model=StructureResult)
def delete_atoms(req: DeleteAtomsRequest) -> StructureResult:
    """Delete atoms from a structure by their site indices."""
    try:
        struct, periodic = _load_structure(req.structure)
        n_sites = len(struct)

        for idx in req.indices:
            if idx < 0 or idx >= n_sites:
                raise HTTPException(
                    status_code=400,
                    detail=f"Index {idx} out of range (structure has {n_sites} sites)",
                )

        unique_indices = sorted(set(req.indices), reverse=True)
        struct.remove_sites(unique_indices)

        return _make_result(struct, periodic)

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/replace-atom", response_model=StructureResult)
def replace_atom(req: ReplaceAtomRequest) -> StructureResult:
    """Replace the element at a specific site index."""
    try:
        struct, periodic = _load_structure(req.structure)

        if req.index >= len(struct):
            raise HTTPException(
                status_code=400,
                detail=f"Index {req.index} out of range (structure has {len(struct)} sites)",
            )

        struct[req.index] = req.new_element

        return _make_result(struct, periodic)

    except HTTPException:
        raise
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid element symbol: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/move-atom", response_model=StructureResult)
def move_atom(req: MoveAtomRequest) -> StructureResult:
    """Move a single atom to a new Cartesian position."""
    try:
        struct, periodic = _load_structure(req.structure)

        if req.index >= len(struct):
            raise HTTPException(
                status_code=400,
                detail=f"Index {req.index} out of range (structure has {len(struct)} sites)",
            )

        if periodic:
            frac = _cartesian_to_fractional(struct.lattice, req.new_position)
            struct.translate_sites(
                [req.index], frac - struct[req.index].frac_coords
            )
        else:
            current = struct[req.index].coords
            displacement = np.array(req.new_position) - current
            struct.translate_sites([req.index], displacement)

        return _make_result(struct, periodic)

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/move-atoms", response_model=StructureResult)
def move_atoms(req: MoveAtomsRequest) -> StructureResult:
    """Translate multiple atoms by a common displacement vector."""
    try:
        struct, periodic = _load_structure(req.structure)
        n_sites = len(struct)

        for idx in req.indices:
            if idx < 0 or idx >= n_sites:
                raise HTTPException(
                    status_code=400,
                    detail=f"Index {idx} out of range (structure has {n_sites} sites)",
                )

        displacement = np.array(req.displacement)

        if periodic:
            frac_disp = struct.lattice.get_fractional_coords(displacement)
            struct.translate_sites(req.indices, frac_disp)
        else:
            struct.translate_sites(req.indices, displacement)

        return _make_result(struct, periodic)

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/supercell", response_model=StructureResult)
def create_supercell(req: SupercellRequest) -> StructureResult:
    """Create a supercell from a periodic structure."""
    try:
        struct, periodic = _load_structure(req.structure)

        if not periodic:
            raise HTTPException(
                status_code=400,
                detail="Supercell operations require a periodic structure with a lattice",
            )

        if req.scaling is not None and req.scaling_matrix is not None:
            raise HTTPException(
                status_code=400,
                detail="Provide either 'scaling' or 'scaling_matrix', not both",
            )
        if req.scaling is None and req.scaling_matrix is None:
            raise HTTPException(
                status_code=400,
                detail="Either 'scaling' or 'scaling_matrix' must be provided",
            )

        if req.scaling_matrix is not None:
            matrix = req.scaling_matrix
            if len(matrix) != 3 or any(len(row) != 3 for row in matrix):
                raise HTTPException(
                    status_code=400,
                    detail="scaling_matrix must be a 3x3 integer matrix",
                )
            struct.make_supercell(matrix)
        else:
            struct.make_supercell(req.scaling)

        return _make_result(struct, periodic)

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/merge", response_model=StructureResult)
def merge_structures(req: MergeRequest) -> StructureResult:
    """Merge an incoming structure into a base structure.

    The incoming structure's geometric centre is translated to the given
    position and its atoms are appended to the base.
    """
    try:
        base, base_periodic = _load_structure(req.base)
        incoming, _ = _load_structure(req.incoming)

        incoming_coords = np.array([site.coords for site in incoming])
        incoming_center = incoming_coords.mean(axis=0)
        offset = np.array(req.position) - incoming_center

        if base_periodic:
            for site in incoming:
                new_cart = site.coords + offset
                frac = _cartesian_to_fractional(base.lattice, new_cart)
                base.append(str(site.specie), frac, coords_are_cartesian=False)
        else:
            for site in incoming:
                new_cart = site.coords + offset
                base.append(str(site.specie), new_cart)

        return _make_result(base, base_periodic)

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


class AddWaterRequest(BaseModel):
    """Add N water molecules to a structure with proper 3D distribution."""

    structure: dict
    count: int = Field(..., ge=1, le=500, description="Number of water molecules to add")
    spacing: float = Field(2.8, ge=1.5, le=10.0, description="Minimum O-O distance in Angstroms")
    auto_lattice: bool = Field(True, description="Auto-create lattice if non-periodic")


@router.post("/add-water", response_model=StructureResult)
def add_water_molecules(req: AddWaterRequest) -> StructureResult:
    """Add exactly N water molecules to a structure with 3D distribution.

    Places molecules on a 3D grid within the cell volume, ensuring minimum
    spacing between all molecules (existing + new). Auto-creates a cubic
    lattice if the structure is non-periodic and auto_lattice is True.

    Water geometry: TIP3P (O-H = 0.9572 Å, H-O-H = 104.52°).
    """
    import math
    import random

    try:
        structure_dict = req.structure
        sites = structure_dict.get("sites", [])
        lattice = structure_dict.get("lattice")

        # Auto-create lattice if non-periodic
        if not lattice and req.auto_lattice:
            # Compute bounding box of existing atoms
            if sites:
                xs = [s["xyz"][0] for s in sites if "xyz" in s]
                ys = [s["xyz"][1] for s in sites if "xyz" in s]
                zs = [s["xyz"][2] for s in sites if "xyz" in s]
                span = max(
                    (max(xs) - min(xs)) if xs else 0,
                    (max(ys) - min(ys)) if ys else 0,
                    (max(zs) - min(zs)) if zs else 0,
                )
            else:
                span = 0
            # Box size: molecule span + room for N waters at ~2.8 Å spacing + padding
            box_size = max(8.0, span + math.ceil(req.count ** (1/3)) * req.spacing + 4.0)
            box_size = round(box_size, 1)

            # Center existing atoms in the new box
            if sites and xs:
                center_x, center_y, center_z = (
                    (min(xs) + max(xs)) / 2,
                    (min(ys) + max(ys)) / 2,
                    (min(zs) + max(zs)) / 2,
                )
                shift = [box_size / 2 - center_x, box_size / 2 - center_y, box_size / 2 - center_z]
                for site in sites:
                    if "xyz" in site:
                        site["xyz"] = [
                            site["xyz"][0] + shift[0],
                            site["xyz"][1] + shift[1],
                            site["xyz"][2] + shift[2],
                        ]

            lattice = {
                "matrix": [[box_size, 0, 0], [0, box_size, 0], [0, 0, box_size]],
                "a": box_size, "b": box_size, "c": box_size,
                "alpha": 90.0, "beta": 90.0, "gamma": 90.0,
            }
            structure_dict["lattice"] = lattice
            # Update abc coords for existing sites
            for site in sites:
                if "xyz" in site:
                    site["abc"] = [
                        site["xyz"][0] / box_size,
                        site["xyz"][1] / box_size,
                        site["xyz"][2] / box_size,
                    ]

        if not lattice:
            raise HTTPException(
                status_code=400,
                detail="Structure has no lattice and auto_lattice is disabled. "
                "Add a lattice first or set auto_lattice=true.",
            )

        # TIP3P water geometry (O at center)
        # O-H = 0.9572 Å, H-O-H = 104.52°
        h_dist = 0.9572
        half_angle = math.radians(104.52 / 2)
        h1_offset = np.array([h_dist * math.sin(half_angle), h_dist * math.cos(half_angle), 0.0])
        h2_offset = np.array([-h_dist * math.sin(half_angle), h_dist * math.cos(half_angle), 0.0])

        # Try to place water, expanding cell if needed (up to 3 attempts)
        new_water_sites = []
        for _attempt in range(3):
            matrix = lattice.get("matrix", [[10, 0, 0], [0, 10, 0], [0, 0, 10]])
            a_vec = np.array(matrix[0])
            b_vec = np.array(matrix[1])
            c_vec = np.array(matrix[2])

            # Collect ONLY oxygen positions for distance checking (not H atoms)
            # This prevents H atoms from blocking placement of nearby molecules
            existing_o_positions = []
            for site in sites:
                if "xyz" in site:
                    el = site.get("species", [{}])[0].get("element", "")
                    if el != "H":  # Only check distances to heavy atoms (O, etc.)
                        existing_o_positions.append(np.array(site["xyz"]))

            # Generate candidate positions on a 3D grid with jitter
            # Total count = existing + new, size grid accordingly
            total_target = len(existing_o_positions) + req.count
            n_per_axis = max(2, math.ceil((total_target * 3) ** (1/3)))
            pad = 0.10
            candidates = []
            for ix in range(n_per_axis):
                for iy in range(n_per_axis):
                    for iz in range(n_per_axis):
                        fa = pad + (1 - 2 * pad) * (ix + random.uniform(-0.3, 0.3)) / n_per_axis
                        fb = pad + (1 - 2 * pad) * (iy + random.uniform(-0.3, 0.3)) / n_per_axis
                        fc = pad + (1 - 2 * pad) * (iz + random.uniform(-0.3, 0.3)) / n_per_axis
                        fa = max(pad, min(1 - pad, fa))
                        fb = max(pad, min(1 - pad, fb))
                        fc = max(pad, min(1 - pad, fc))
                        pos = fa * a_vec + fb * b_vec + fc * c_vec
                        candidates.append(pos)

            random.shuffle(candidates)
            placed_o_positions = list(existing_o_positions)
            new_water_sites = []
            min_dist_sq = req.spacing ** 2

            for candidate in candidates:
                if len(new_water_sites) >= req.count * 3:
                    break
                # Only check O-O distances — H atoms are always placed at fixed offset
                too_close = False
                for existing in placed_o_positions:
                    if np.sum((candidate - existing) ** 2) < min_dist_sq:
                        too_close = True
                        break
                if too_close:
                    continue

                angle = random.uniform(0, 2 * math.pi)
                cos_a, sin_a = math.cos(angle), math.sin(angle)
                rot = np.array([[cos_a, -sin_a, 0], [sin_a, cos_a, 0], [0, 0, 1]])

                o_pos = candidate
                h1_pos = candidate + rot @ h1_offset
                h2_pos = candidate + rot @ h2_offset

                inv_matrix = np.linalg.inv(np.array(matrix, dtype=float))
                o_frac = o_pos @ inv_matrix
                h1_frac = h1_pos @ inv_matrix
                h2_frac = h2_pos @ inv_matrix

                new_water_sites.extend([
                    {"species": [{"element": "O", "occu": 1}],
                     "xyz": o_pos.tolist(), "abc": o_frac.tolist()},
                    {"species": [{"element": "H", "occu": 1}],
                     "xyz": h1_pos.tolist(), "abc": h1_frac.tolist()},
                    {"species": [{"element": "H", "occu": 1}],
                     "xyz": h2_pos.tolist(), "abc": h2_frac.tolist()},
                ])
                placed_o_positions.append(o_pos)

            n_placed = len(new_water_sites) // 3
            if n_placed >= req.count:
                break  # Success — placed all requested molecules

            # Not enough room — expand the cell by 30% and retry
            scale = 1.3
            new_matrix = [
                [matrix[0][0] * scale, matrix[0][1] * scale, matrix[0][2] * scale],
                [matrix[1][0] * scale, matrix[1][1] * scale, matrix[1][2] * scale],
                [matrix[2][0] * scale, matrix[2][1] * scale, matrix[2][2] * scale],
            ]
            lattice["matrix"] = new_matrix
            lattice["a"] = float(np.linalg.norm(new_matrix[0]))
            lattice["b"] = float(np.linalg.norm(new_matrix[1]))
            lattice["c"] = float(np.linalg.norm(new_matrix[2]))
            # Rescale existing site positions to stay in same fractional coords
            for site in sites:
                if "abc" in site and "xyz" in site:
                    abc = site["abc"]
                    site["xyz"] = [
                        abc[0] * new_matrix[0][0] + abc[1] * new_matrix[1][0] + abc[2] * new_matrix[2][0],
                        abc[0] * new_matrix[0][1] + abc[1] * new_matrix[1][1] + abc[2] * new_matrix[2][1],
                        abc[0] * new_matrix[0][2] + abc[1] * new_matrix[1][2] + abc[2] * new_matrix[2][2],
                    ]
            structure_dict["lattice"] = lattice
            new_water_sites = []  # Reset and retry

        n_placed = len(new_water_sites) // 3
        if n_placed == 0:
            raise HTTPException(
                status_code=400,
                detail=f"Could not place any water molecules with {req.spacing} Å spacing "
                "even after expanding the cell. Try fewer molecules.",
            )

        # Append new water sites to structure
        structure_dict["sites"] = sites + new_water_sites
        structure_dict["lattice"] = lattice

        return StructureResult(
            structure=structure_dict,
            num_sites=len(structure_dict["sites"]),
            is_periodic=True,
        )

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


class SetLatticeRequest(BaseModel):
    """Set or create a lattice for a structure/molecule."""

    structure: dict
    a: float = Field(..., gt=0, description="Lattice parameter a in Angstroms")
    b: float = Field(..., gt=0, description="Lattice parameter b in Angstroms")
    c: float = Field(..., gt=0, description="Lattice parameter c in Angstroms")
    alpha: float = Field(90.0, ge=10, le=170, description="Angle alpha in degrees")
    beta: float = Field(90.0, ge=10, le=170, description="Angle beta in degrees")
    gamma: float = Field(90.0, ge=10, le=170, description="Angle gamma in degrees")
    center: bool = Field(True, description="Center the molecule/atoms in the new cell")


class ConventionalCellRequest(BaseModel):
    structure: dict


@router.post("/conventional-cell")
def conventional_cell(req: ConventionalCellRequest):
    """Convert a structure to its conventional standard cell using spglib."""
    try:
        from pymatgen.symmetry.analyzer import SpacegroupAnalyzer
        struct, _ = _load_structure(req.structure)
        sga = SpacegroupAnalyzer(struct)
        conv = sga.get_conventional_standard_structure()
        return {"structure": conv.as_dict()}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/symmetry")
def analyze_symmetry(req: ConventionalCellRequest):
    """Space-group / symmetry summary via spglib (SpacegroupAnalyzer).

    Standalone symmetry endpoint (the `catgo_analyze action='symmetry'` MCP tool
    targets this). Needs a periodic structure — a molecule (no lattice) raises
    400 with a clear message.
    """
    try:
        from pymatgen.symmetry.analyzer import SpacegroupAnalyzer
        struct, _ = _load_structure(req.structure)
        if not getattr(struct, "lattice", None):
            raise HTTPException(
                status_code=400,
                detail="Symmetry analysis needs a periodic structure (this is a molecule with no lattice).",
            )
        sga = SpacegroupAnalyzer(struct, symprec=0.01)
        return {
            "space_group_symbol": sga.get_space_group_symbol(),
            "space_group_number": sga.get_space_group_number(),
            "crystal_system": sga.get_crystal_system(),
            "point_group": sga.get_point_group_symbol(),
            "hall": sga.get_hall(),
            "n_symmetry_operations": len(sga.get_symmetry_operations()),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class RdfRequest(BaseModel):
    structure: dict
    r_max: float = Field(8.0, gt=0, le=30, description="Max radius (Å)")
    n_bins: int = Field(100, ge=10, le=1000, description="Number of histogram bins")


@router.post("/rdf")
def structure_rdf(req: RdfRequest):
    """Radial distribution function g(r) for ONE periodic structure (static pair
    correlation — the single-structure counterpart of the trajectory RDF)."""
    try:
        import numpy as np
        struct, _ = _load_structure(req.structure)
        if not getattr(struct, "lattice", None):
            raise HTTPException(status_code=400, detail="RDF needs a periodic structure (this is a molecule with no lattice).")
        rmax = float(req.r_max)
        nb = int(req.n_bins)
        counts = np.zeros(nb)
        for site_neighbors in struct.get_all_neighbors(rmax):
            for nbr in site_neighbors:
                d = float(getattr(nbr, "nn_distance", 0.0))
                if 0.0 < d <= rmax:
                    b = int(d / rmax * nb)
                    if b < nb:
                        counts[b] += 1.0
        n = len(struct)
        rho = n / float(struct.volume)
        edges = np.linspace(0.0, rmax, nb + 1)
        r = 0.5 * (edges[:-1] + edges[1:])
        shell = 4.0 * np.pi * r ** 2 * (rmax / nb)
        g = np.divide(counts, n * rho * shell, out=np.zeros_like(counts), where=shell > 0)
        return {"r": r.round(4).tolist(), "g_r": g.round(4).tolist(),
                "r_max": rmax, "n_bins": nb, "number_density": round(rho, 5)}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class CoordinationRequest(BaseModel):
    structure: dict
    cutoff: float | None = Field(None, gt=0, le=10,
                                 description="Distance cutoff (Å). Omit → cutoff-free CrystalNN.")


@router.post("/coordination")
def structure_coordination(req: CoordinationRequest):
    """Per-site and per-element coordination numbers for ONE structure. A `cutoff`
    counts neighbours within that distance; otherwise cutoff-free CrystalNN."""
    try:
        from collections import defaultdict
        struct, _ = _load_structure(req.structure)
        if req.cutoff:
            cns = [len(n) for n in struct.get_all_neighbors(float(req.cutoff))]
            method = f"cutoff={req.cutoff}Å"
        else:
            from pymatgen.analysis.local_env import CrystalNN
            cnn = CrystalNN()
            cns = [cnn.get_cn(struct, i) for i in range(len(struct))]
            method = "CrystalNN"
        per_el: dict[str, list] = defaultdict(list)
        for i, site in enumerate(struct):
            try:
                el = site.specie.symbol
            except Exception:
                el = str(getattr(site, "species", "?"))
            per_el[el].append(cns[i])
        avg = {el: round(sum(v) / len(v), 3) for el, v in per_el.items()}
        return {"coordination_numbers": cns, "average_by_element": avg, "method": method}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/set-lattice", response_model=StructureResult)
def set_lattice(req: SetLatticeRequest) -> StructureResult:
    """Set or replace the lattice of a structure.

    For molecules without periodic boundaries, this wraps them in a periodic cell.
    For existing periodic structures, this replaces the lattice parameters
    and rescales fractional coordinates.
    """
    try:
        from pymatgen.core import Lattice, Structure

        lattice = Lattice.from_parameters(req.a, req.b, req.c, req.alpha, req.beta, req.gamma)

        if _is_periodic(req.structure):
            struct, _ = _load_structure(req.structure)
            # Replace lattice, keeping fractional coordinates
            new_struct = Structure(
                lattice,
                struct.species,
                struct.frac_coords,
                coords_are_cartesian=False,
            )
            return _make_result(new_struct, True)
        else:
            mol, _ = _load_structure(req.structure)
            # Get Cartesian coords, center in new cell
            cart = mol.cart_coords
            if len(cart) > 0 and req.center:
                center = cart.mean(axis=0)
                cell_center = lattice.get_cartesian_coords([0.5, 0.5, 0.5])
                shift = cell_center - center
                cart = cart + shift

            species = [str(s) for s in mol.species]
            new_struct = Structure(lattice, species, cart, coords_are_cartesian=True)
            return _make_result(new_struct, True)

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/generate-slab", response_model=SlabResult)
def generate_slab(req: GenerateSlabRequest) -> SlabResult:
    """Generate surface slab(s) from a bulk structure using Miller indices.

    Uses pymatgen's SlabGenerator which produces minimal primitive surface cells.
    Note: The frontend WASM slab cutter uses ferrox Rust which may produce larger
    in-plane cells for some Miller indices (e.g. (111)) since primitive reduction
    is not yet implemented in ferrox.
    """
    try:
        from pymatgen.core.surface import SlabGenerator

        struct, periodic = _load_structure(req.structure)

        if not periodic:
            raise HTTPException(
                status_code=400,
                detail="Slab generation requires a periodic structure with a lattice",
            )

        miller = tuple(req.miller_index)
        if all(m == 0 for m in miller):
            raise HTTPException(
                status_code=400,
                detail="Miller indices cannot all be zero",
            )

        # Convert to conventional standard cell so Miller indices match
        # the standard crystallographic convention (not primitive basis)
        from pymatgen.symmetry.analyzer import SpacegroupAnalyzer
        try:
            sga = SpacegroupAnalyzer(struct)
            conv_struct = sga.get_conventional_standard_structure()
        except Exception:
            conv_struct = struct  # fallback to original if analysis fails

        gen = SlabGenerator(
            conv_struct,
            miller_index=miller,
            min_slab_size=req.min_slab_size,
            min_vacuum_size=req.min_vacuum_size,
            center_slab=req.center_slab,
            in_unit_planes=req.in_unit_planes,
            max_normal_search=req.max_normal_search,
        )

        slabs = gen.get_slabs()

        if req.orthogonalize_c:
            slabs = [s.get_orthogonal_c_slab() for s in slabs]

        if not slabs:
            raise HTTPException(
                status_code=400,
                detail=f"No slabs could be generated for Miller index {list(miller)}. "
                "Try different parameters or a larger min_slab_size.",
            )

        # Mark slabs as non-periodic in c-direction (vacuum gap)
        slab_dicts = []
        for s in slabs:
            d = s.as_dict()
            if "lattice" in d:
                d["lattice"]["pbc"] = [True, True, False]
            slab_dicts.append(d)

        return SlabResult(
            slabs=slab_dicts,
            num_slabs=len(slabs),
            miller_index=list(miller),
        )

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


class ToConventionalRequest(BaseModel):
    """Convert a structure to its conventional standard cell."""

    structure: dict


@router.post("/to-conventional", response_model=StructureResult)
def to_conventional(req: ToConventionalRequest) -> StructureResult:
    """Convert a primitive cell to the conventional standard cell.

    Uses pymatgen SpacegroupAnalyzer to find the conventional cell.
    If the structure is already conventional or analysis fails, returns
    the original structure unchanged.
    """
    try:
        struct, is_periodic = _load_structure(req.structure)
        if not is_periodic:
            return _make_result(struct, False)

        from pymatgen.symmetry.analyzer import SpacegroupAnalyzer
        try:
            sga = SpacegroupAnalyzer(struct)
            conv = sga.get_conventional_standard_structure()
        except Exception:
            conv = struct

        return _make_result(conv, True)

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# SMILES → 3D coordinates (for MOF cap replacement)
# ---------------------------------------------------------------------------


class SmilesToXyzRequest(BaseModel):
    smiles: str


@router.post("/smiles-to-xyz")
def smiles_to_xyz(data: SmilesToXyzRequest):
    """Convert a SMILES string to 3D coordinates using RDKit or Open Babel."""
    if not data.smiles.strip():
        raise HTTPException(400, "Missing SMILES string")

    # Try RDKit first
    try:
        from rdkit import Chem
        from rdkit.Chem import AllChem

        mol = Chem.MolFromSmiles(data.smiles)
        if mol is None:
            raise ValueError(f"Invalid SMILES: {data.smiles}")
        mol = Chem.AddHs(mol)
        result = AllChem.EmbedMolecule(mol, AllChem.ETKDGv3())
        if result != 0:
            AllChem.EmbedMolecule(mol, AllChem.ETKDG())
        AllChem.MMFFOptimizeMolecule(mol)

        elements = [atom.GetSymbol() for atom in mol.GetAtoms()]
        conf = mol.GetConformer()
        coords = [
            [conf.GetAtomPosition(i).x, conf.GetAtomPosition(i).y, conf.GetAtomPosition(i).z]
            for i in range(mol.GetNumAtoms())
        ]
        return {"elements": elements, "cart_coords": coords, "bonding_atom_idx": 0}

    except ImportError:
        pass

    # Fallback to Open Babel CLI
    try:
        import subprocess
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".smi", mode="w", delete=False) as f:
            f.write(data.smiles)
            smi_path = f.name
        xyz_path = smi_path.replace(".smi", ".xyz")
        subprocess.run(
            ["obabel", smi_path, "-O", xyz_path, "--gen3d", "-h"],
            check=True, capture_output=True,
        )
        with open(xyz_path) as f:
            lines = f.readlines()
        n_atoms = int(lines[0].strip())
        elements = []
        coords = []
        for line in lines[2 : 2 + n_atoms]:
            parts = line.split()
            elements.append(parts[0])
            coords.append([float(parts[1]), float(parts[2]), float(parts[3])])
        return {"elements": elements, "cart_coords": coords, "bonding_atom_idx": 0}

    except Exception as exc:
        raise HTTPException(500, f"Neither RDKit nor Open Babel available: {exc}")
