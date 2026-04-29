"""
Batch trajectory editing router.

Applies atom-level operations across all frames of a trajectory on the backend,
avoiding browser freezes for large (100s-1000s of frames) trajectories.
"""

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/trajectory-edit", tags=["trajectory-edit"])


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class TrajectoryEditRequest(BaseModel):
    """Batch edit request for multi-frame trajectories."""

    frames: list[dict]  # list of pymatgen Structure.as_dict()
    operation: str  # "replace_atom" | "add_atom" | "delete_atoms" | "move_atoms"
    params: dict  # operation-specific parameters
    skip_frame: int | None = None  # frame index to skip (already edited client-side)


class TrajectoryEditResult(BaseModel):
    frames: list[dict]
    modified: int
    skipped: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _structures_compatible(a_sites: list, b_sites: list) -> bool:
    """Check if two structures have the same atom count and element sequence."""
    if len(a_sites) != len(b_sites):
        return False
    for sa, sb in zip(a_sites, b_sites):
        sp_a = sa.get("species", [])
        sp_b = sb.get("species", [])
        if len(sp_a) != len(sp_b):
            return False
        for ea, eb in zip(sp_a, sp_b):
            if ea.get("element") != eb.get("element"):
                return False
    return True


def _apply_displacements(struct_dict: dict, displacements: dict[str, list[float]]) -> dict:
    """Apply per-atom displacement vectors (in Angstroms) to a structure dict.

    displacements: { "0": [dx, dy, dz], "5": [dx, dy, dz], ... }
    """
    from pymatgen.core import Structure

    structure = Structure.from_dict(struct_dict)
    for idx_str, disp in displacements.items():
        idx = int(idx_str)
        if 0 <= idx < len(structure):
            old_coords = structure[idx].coords
            new_coords = old_coords + np.array(disp)
            structure.translate_sites([idx], new_coords - old_coords, frac_coords=False)
    return structure.as_dict()


def _replace_atom(struct_dict: dict, site_index: int, new_element: str) -> dict:
    """Replace the element at site_index."""
    from pymatgen.core import Structure

    structure = Structure.from_dict(struct_dict)
    if 0 <= site_index < len(structure):
        structure.replace(site_index, new_element)
    return structure.as_dict()


def _add_atom(struct_dict: dict, element: str, xyz_position: list[float]) -> dict:
    """Add an atom at the given Cartesian position."""
    from pymatgen.core import Structure

    structure = Structure.from_dict(struct_dict)
    # Convert Cartesian to fractional
    frac = structure.lattice.get_fractional_coords(xyz_position)
    structure.append(element, frac)
    return structure.as_dict()


def _delete_atoms(struct_dict: dict, site_indices: list[int]) -> dict:
    """Delete atoms at the given indices."""
    from pymatgen.core import Structure

    structure = Structure.from_dict(struct_dict)
    # Remove in reverse order to keep indices valid
    for idx in sorted(site_indices, reverse=True):
        if 0 <= idx < len(structure):
            structure.remove_sites([idx])
    return structure.as_dict()


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.post("/batch", response_model=TrajectoryEditResult)
def batch_edit(req: TrajectoryEditRequest):
    """Apply an atom manipulation operation to all frames in a trajectory."""
    if not req.frames:
        raise HTTPException(400, "frames list must not be empty")

    operation = req.operation
    params = req.params
    skip_frame = req.skip_frame

    # Use the first non-skipped frame as reference for compatibility checks
    ref_idx = 0 if skip_frame != 0 else (1 if len(req.frames) > 1 else 0)
    ref_sites = req.frames[ref_idx].get("sites", [])

    modified = 0
    skipped = 0
    result_frames: list[dict] = []

    for i, frame_dict in enumerate(req.frames):
        if i == skip_frame:
            result_frames.append(frame_dict)
            skipped += 1
            continue

        # Check compatibility
        frame_sites = frame_dict.get("sites", [])
        if not _structures_compatible(ref_sites, frame_sites):
            result_frames.append(frame_dict)
            skipped += 1
            continue

        try:
            if operation == "move_atoms":
                displacements = params.get("displacements", {})
                new_frame = _apply_displacements(frame_dict, displacements)
            elif operation == "replace_atom":
                site_index = params["site_index"]
                new_element = params["new_element"]
                new_frame = _replace_atom(frame_dict, site_index, new_element)
            elif operation == "add_atom":
                element = params["element"]
                xyz_position = params["xyz_position"]
                new_frame = _add_atom(frame_dict, element, xyz_position)
            elif operation == "delete_atoms":
                site_indices = params["site_indices"]
                new_frame = _delete_atoms(frame_dict, site_indices)
            else:
                raise HTTPException(400, f"Unknown operation: {operation}")

            result_frames.append(new_frame)
            modified += 1
        except Exception as exc:
            # If a single frame fails, keep it unchanged
            result_frames.append(frame_dict)
            skipped += 1

    return TrajectoryEditResult(
        frames=result_frames,
        modified=modified,
        skipped=skipped,
    )
