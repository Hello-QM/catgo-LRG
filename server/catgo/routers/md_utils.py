"""Shared utilities for MD trajectory analysis routers.

Provides a unified load_trajectory function that handles:
- Self-contained formats (PDB, GRO, etc.) loaded directly by mdtraj
- Binary formats (XTC, TRR, DCD) requiring separate topology
- XYZ/extxyz formats converted to PDB via ASE before loading with mdtraj
"""

import base64
import logging
import os
import tempfile
from typing import Optional

import mdtraj as md
from fastapi import HTTPException

logger = logging.getLogger(__name__)

# Formats mdtraj can load directly (contain topology info)
SELF_CONTAINED_FORMATS = {
    "pdb", "pdb.gz", "h5", "hdf5", "lh5",
    "nc", "netcdf", "ncdf",
    "lammpstrj",
    "hoomdxml",
    "gro", "gro.gz",
    "arc",
    "gsd",
    "mol2",
}

# Binary trajectory formats that need a separate topology file
TOPOLOGY_REQUIRED_FORMATS = {
    "xtc", "trr", "dcd", "dtr", "binpos",
}

# Formats that mdtraj cannot handle natively but ASE can read
ASE_CONVERTIBLE_FORMATS = {
    "xyz", "xyz.gz", "extxyz", "traj",
}

ALL_SUPPORTED_FORMATS = (
    SELF_CONTAINED_FORMATS | TOPOLOGY_REQUIRED_FORMATS | ASE_CONVERTIBLE_FORMATS
)


def _convert_xyz_to_pdb(xyz_path: str, fmt: str) -> str:
    """Convert an XYZ/extxyz file to PDB format via ASE.

    Args:
        xyz_path: Path to the XYZ file.
        fmt: Original format string for error messages.

    Returns:
        Path to the temporary PDB file. Caller must clean up.

    Raises:
        HTTPException: If ASE cannot read or convert the file.
    """
    try:
        from ase.io import read, write
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="ASE is required to load XYZ/extxyz files but is not installed.",
        )

    try:
        # Read all frames from the XYZ file
        ase_format = "extxyz" if fmt in ("extxyz", "traj") else None
        frames = read(xyz_path, index=":", format=ase_format)
        if not isinstance(frames, list):
            frames = [frames]
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"ASE failed to read '{fmt}' file: {exc}",
        )

    # Write all frames to a temporary PDB file
    pdb_fd, pdb_path = tempfile.mkstemp(suffix=".pdb")
    try:
        os.close(pdb_fd)
        write(pdb_path, frames, format="proteindatabank")
    except Exception as exc:
        os.unlink(pdb_path)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to convert '{fmt}' to PDB via ASE: {exc}",
        )

    logger.info("Converted %s to PDB: %d frames", fmt, len(frames))
    return pdb_path


def _guess_bonds_from_distances(traj: md.Trajectory, tolerance: float = 0.3) -> None:
    """Add bonds to topology by checking interatomic distances against covalent radii.

    Uses the first frame's coordinates and ASE's natural_cutoffs for covalent
    radii. A bond is added when distance < (r_i + r_j) * (1 + tolerance).

    Args:
        traj: Trajectory whose topology will be modified in-place.
        tolerance: Fractional tolerance above sum of covalent radii (default 0.3 = 30%).
    """
    try:
        from ase import Atoms
        from ase.neighborlist import NeighborList, natural_cutoffs
    except ImportError:
        logger.warning("ASE not available, cannot guess bonds from distances")
        return

    # Build ASE Atoms from first frame (mdtraj coords are in nm, ASE uses Angstroms)
    symbols = [atom.element.symbol for atom in traj.topology.atoms]
    positions = traj.xyz[0] * 10.0  # nm -> Angstroms
    atoms = Atoms(symbols=symbols, positions=positions)

    cutoffs = natural_cutoffs(atoms, mult=1.0 + tolerance)
    nl = NeighborList(cutoffs, self_interaction=False, bothways=False)
    nl.update(atoms)

    for i in range(len(atoms)):
        indices, _ = nl.get_neighbors(i)
        atom_i = list(traj.topology.atoms)[i]
        for j in indices:
            if j > i:
                atom_j = list(traj.topology.atoms)[j]
                traj.topology.add_bond(atom_i, atom_j)

    logger.info("Guessed %d bonds from covalent radii", traj.topology.n_bonds)


def resolve_periodic(traj: md.Trajectory, periodic: bool) -> bool:
    """Return False if the trajectory has no unit cell, regardless of user request.

    Many mdtraj functions (compute_rdf, compute_distances, compute_angles, etc.)
    will crash with a TypeError when periodic=True but unitcell_vectors is None.
    """
    if periodic and traj.unitcell_vectors is None:
        return False
    return periodic


def load_trajectory(
    content_b64: str,
    fmt: str,
    topology_b64: Optional[str] = None,
    topology_format: Optional[str] = None,
) -> md.Trajectory:
    """Decode a base64-encoded trajectory file and load it with mdtraj.

    Handles three cases:
    1. Self-contained formats (PDB, GRO, etc.) — loaded directly
    2. Binary formats (XTC, TRR, DCD) — require separate topology file
    3. XYZ/extxyz/traj — converted to PDB via ASE first

    Args:
        content_b64: Base64-encoded trajectory file content.
        fmt: File format extension (e.g., 'pdb', 'xyz', 'xtc', 'extxyz').
        topology_b64: Optional base64-encoded topology file for binary formats.
        topology_format: Format of the topology file (e.g., 'pdb', 'gro').

    Returns:
        An mdtraj.Trajectory object.

    Raises:
        HTTPException: If decoding, conversion, or loading fails.
    """
    # Normalize format
    fmt = fmt.lower().strip().lstrip(".")

    if fmt not in ALL_SUPPORTED_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported trajectory format: '{fmt}'. "
                f"Supported formats: {sorted(ALL_SUPPORTED_FORMATS)}"
            ),
        )

    # Decode base64 content
    try:
        traj_bytes = base64.b64decode(content_b64)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to decode base64 trajectory content: {exc}",
        )

    # Write trajectory to temp file
    traj_suffix = f".{fmt}"
    traj_fd, traj_path = tempfile.mkstemp(suffix=traj_suffix)
    top_path: Optional[str] = None
    pdb_path: Optional[str] = None

    try:
        with os.fdopen(traj_fd, "wb") as f:
            f.write(traj_bytes)

        # Case 1: XYZ/extxyz — convert via ASE to PDB, then load PDB
        if fmt in ASE_CONVERTIBLE_FORMATS:
            pdb_path = _convert_xyz_to_pdb(traj_path, fmt)
            traj = md.load(pdb_path)

        # Case 2: Binary format — require separate topology
        elif fmt in TOPOLOGY_REQUIRED_FORMATS:
            if not topology_b64 or not topology_format:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Format '{fmt}' is a binary trajectory format and requires "
                        f"a separate topology file. Provide topology_b64 and topology_format."
                    ),
                )
            try:
                top_bytes = base64.b64decode(topology_b64)
            except Exception as exc:
                raise HTTPException(
                    status_code=400,
                    detail=f"Failed to decode base64 topology content: {exc}",
                )

            top_suffix = f".{topology_format.lower().strip().lstrip('.')}"
            top_fd, top_path = tempfile.mkstemp(suffix=top_suffix)
            with os.fdopen(top_fd, "wb") as f:
                f.write(top_bytes)

            traj = md.load(traj_path, top=top_path)

        # Case 3: Self-contained format — load directly
        else:
            # If topology is provided optionally, use it
            if topology_b64 and topology_format:
                try:
                    top_bytes = base64.b64decode(topology_b64)
                except Exception as exc:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Failed to decode base64 topology content: {exc}",
                    )
                top_suffix = f".{topology_format.lower().strip().lstrip('.')}"
                top_fd, top_path = tempfile.mkstemp(suffix=top_suffix)
                with os.fdopen(top_fd, "wb") as f:
                    f.write(top_bytes)
                traj = md.load(traj_path, top=top_path)
            else:
                traj = md.load(traj_path)

        # Ensure topology has bonds (needed by baker_hubbard, wernet_nilsson, etc.)
        if traj.topology.n_bonds == 0:
            traj.topology.create_standard_bonds()
        # If standard bonds didn't help (non-biological system), guess from distances
        if traj.topology.n_bonds == 0:
            _guess_bonds_from_distances(traj)
        if traj.topology.n_bonds > 0:
            logger.info("Topology bonds: %d", traj.topology.n_bonds)

        logger.info(
            "Loaded trajectory: %d frames, %d atoms, format=%s",
            traj.n_frames, traj.n_atoms, fmt,
        )
        return traj

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to load trajectory (format='{fmt}'): {exc}",
        )
    finally:
        # Clean up all temp files
        if os.path.exists(traj_path):
            os.unlink(traj_path)
        if top_path and os.path.exists(top_path):
            os.unlink(top_path)
        if pdb_path and os.path.exists(pdb_path):
            os.unlink(pdb_path)
