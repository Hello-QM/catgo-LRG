"""Nanotube construction algorithm.

Generalizes the TMDC nanotube builder to work with any 2D material.
Given a 2D lattice (a1, a2) and basis atoms, constructs a nanotube
by specifying chiral indices (n, m) and tube length (NL unit cells).

Algorithm:
1. Compute chiral vector C = n*a1 + m*a2
2. Find translational vector T (minimum lattice vector perpendicular to C)
3. Generate a flat sheet large enough to cover the C x T rectangle
4. Rotate the sheet so C aligns with x-axis
5. Cut atoms inside the rectangle [0, |C|] x [0, NL*|T|]
6. Roll up: x -> theta = x/R, then x_3d = R*sin(theta), z_3d = R*cos(theta)

Reference: standard carbon nanotube construction theory, generalized for
arbitrary 2D lattices. Inspired by shm-phy/MOIRE-LATTICE_NANO-TUBE.
"""

import logging
import math
from dataclasses import dataclass

import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class NanotubeInfo:
    """Computed nanotube geometry information."""

    chiral_vector: np.ndarray  # 2D vector [x, y]
    chiral_angle_deg: float
    circumference: float  # Angstroms
    diameter: float  # Angstroms
    radius: float  # Angstroms
    trans_vector: np.ndarray  # 2D translational vector [x, y]
    trans_length: float  # |T| in Angstroms
    tube_length: float  # NL * |T| in Angstroms
    n_atoms: int
    t1: int  # translational vector indices
    t2: int


def find_translational_vector(
    a1: np.ndarray,
    a2: np.ndarray,
    n: int,
    m: int,
    max_search: int = 200,
) -> tuple[np.ndarray, int, int]:
    """Find the shortest lattice vector perpendicular to the chiral vector.

    For a general 2D lattice, search integer combinations (t1, t2) such that
    T = t1*a1 + t2*a2 is perpendicular to C = n*a1 + m*a2, with minimum |T|.

    For hexagonal lattice (|a1|=|a2|, angle=60deg), this gives the standard
    CNT translational vector formula.
    """
    C = n * a1 + m * a2

    # Special case: if C is zero, return a2 (or a1)
    if np.linalg.norm(C) < 1e-10:
        return a2.copy(), 0, 1

    best_T = None
    best_score = np.inf  # lower is better: combines perpendicularity error and length
    best_t1, best_t2 = 0, 1

    C_len = np.linalg.norm(C)

    # Metric tensor components
    g11 = np.dot(a1, a1)
    g12 = np.dot(a1, a2)
    g22 = np.dot(a2, a2)

    # C · T = 0 in lattice coordinates:
    # (n*g11 + m*g12)*t1 + (n*g12 + m*g22)*t2 = 0
    p = n * g11 + m * g12
    q = n * g12 + m * g22

    # Use a relative tolerance that accommodates user-input lattice constants
    # with limited decimal precision (e.g., 4 decimal places → ~1e-3 relative error)
    perp_tol = 1e-3 * (abs(p) + abs(q))

    for t1 in range(-max_search, max_search + 1):
        for t2 in range(-max_search, max_search + 1):
            if t1 == 0 and t2 == 0:
                continue
            # Check perpendicularity: p*t1 + q*t2 should be ~0
            dot_val = abs(p * t1 + q * t2)
            if dot_val > perp_tol:
                continue

            T = t1 * a1 + t2 * a2
            T_len = np.linalg.norm(T)

            # Score: prioritize short vectors, break ties by perpendicularity
            # Normalize dot_val by vector lengths for fair comparison
            perp_error = dot_val / (C_len * T_len) if T_len > 1e-10 else np.inf
            score = T_len + perp_error * 1000.0

            if score < best_score:
                best_score = score
                best_T = T.copy()
                best_t1, best_t2 = t1, t2

    if best_T is None:
        # Fallback: use the component of a1 perpendicular to C
        C_hat = C / np.linalg.norm(C)
        T_fallback = a1 - np.dot(a1, C_hat) * C_hat
        if np.linalg.norm(T_fallback) < 1e-10:
            T_fallback = a2 - np.dot(a2, C_hat) * C_hat
        return T_fallback, 1, 0

    # Ensure T points in positive y direction (after rotation, this is the tube axis)
    # Convention: cross(C, T) > 0
    cross = C[0] * best_T[1] - C[1] * best_T[0]
    if cross < 0:
        best_T = -best_T
        best_t1 = -best_t1
        best_t2 = -best_t2

    return best_T, best_t1, best_t2


def compute_nanotube_info(
    a1: np.ndarray,
    a2: np.ndarray,
    n: int,
    m: int,
    NL: int,
    n_basis: int,
) -> NanotubeInfo:
    """Compute nanotube geometry from lattice vectors and chiral indices."""
    C = n * a1 + m * a2
    circumference = np.linalg.norm(C)
    diameter = circumference / np.pi
    radius = diameter / 2.0

    # Chiral angle: angle between C and a1
    a1_len = np.linalg.norm(a1)
    if a1_len > 0 and circumference > 0:
        cos_alpha = np.dot(C, a1) / (circumference * a1_len)
        cos_alpha = np.clip(cos_alpha, -1.0, 1.0)
        chiral_angle = math.degrees(math.acos(cos_alpha))
    else:
        chiral_angle = 0.0

    T, t1, t2 = find_translational_vector(a1, a2, n, m)
    trans_length = np.linalg.norm(T)
    tube_length = NL * trans_length

    # Estimate atom count: area of C x T rectangle / unit cell area * n_basis * NL
    unit_cell_area = abs(a1[0] * a2[1] - a1[1] * a2[0])
    if unit_cell_area > 1e-10:
        rect_area = circumference * trans_length
        n_unit_cells = round(rect_area / unit_cell_area)
    else:
        n_unit_cells = 0
    n_atoms = n_unit_cells * NL * n_basis

    return NanotubeInfo(
        chiral_vector=C,
        chiral_angle_deg=chiral_angle,
        circumference=circumference,
        diameter=diameter,
        radius=radius,
        trans_vector=T,
        trans_length=trans_length,
        tube_length=tube_length,
        n_atoms=n_atoms,
        t1=t1,
        t2=t2,
    )


def _roll_single_wall(
    a1: np.ndarray,
    a2: np.ndarray,
    elements: list[str],
    basis_frac: list[list[float]],
    z_coords: list[float],
    n: int,
    m: int,
    NL: int,
) -> tuple[list[str], np.ndarray, float, NanotubeInfo]:
    """Roll a single nanotube wall, returning positions centered at the tube axis.

    Returns:
        cut_elements: element symbols
        positions_3d: (N, 3) positions centered at origin (tube axis = y)
        tube_length: length along tube axis in Angstroms
        info: NanotubeInfo
    """
    C = n * a1 + m * a2
    circumference = np.linalg.norm(C)
    radius = circumference / (2.0 * np.pi)

    T, t1, t2 = find_translational_vector(a1, a2, n, m)
    T_len = np.linalg.norm(T)

    info = compute_nanotube_info(a1, a2, n, m, NL, len(elements))

    if circumference < 1e-10:
        raise ValueError(f"Chiral vector has zero length for (n={n}, m={m})")
    if T_len < 1e-10:
        raise ValueError("Translational vector has zero length")

    # Estimate how many unit cells we need
    C_hat = C / circumference
    T_hat = T / T_len

    max_C_proj = max(abs(np.dot(a1, C_hat)), abs(np.dot(a2, C_hat)))
    max_T_proj = max(abs(np.dot(a1, T_hat)), abs(np.dot(a2, T_hat)))
    ni_C = int(np.ceil(circumference / max_C_proj)) + 2 if max_C_proj > 0 else 5
    ni_T = int(np.ceil(NL * T_len / max_T_proj)) + 2 if max_T_proj > 0 else 5
    ni_max = max(ni_C, ni_T, abs(n) + abs(m) + 2, NL * (abs(t1) + abs(t2)) + 2)

    # Generate sheet atoms
    sheet_elements = []
    sheet_xy = []
    sheet_z = []

    for i in range(-ni_max, ni_max + 1):
        for j in range(-ni_max, ni_max + 1):
            origin = i * a1 + j * a2
            for k, (elem, frac, zk) in enumerate(zip(elements, basis_frac, z_coords)):
                pos_2d = origin + frac[0] * a1 + frac[1] * a2
                sheet_elements.append(elem)
                sheet_xy.append(pos_2d)
                sheet_z.append(zk)

    sheet_xy = np.array(sheet_xy)
    sheet_z = np.array(sheet_z)

    # Rotate so C aligns with x-axis
    alpha = math.atan2(C[1], C[0])
    cos_a, sin_a = math.cos(-alpha), math.sin(-alpha)
    rot = np.array([[cos_a, -sin_a], [sin_a, cos_a]])
    rotated_xy = (rot @ sheet_xy.T).T
    T_rot = rot @ T

    # Cut rectangular region [0, |C|) x [0, NL*|T|)
    eps = 1e-4
    tube_length = NL * T_len
    T_rot_hat = T_rot / np.linalg.norm(T_rot)
    x_proj = rotated_xy[:, 0]
    y_proj = rotated_xy @ T_rot_hat

    mask = (
        (x_proj >= -eps)
        & (x_proj < circumference - eps)
        & (y_proj >= -eps)
        & (y_proj < tube_length - eps)
    )

    cut_elements = [sheet_elements[i] for i in range(len(sheet_elements)) if mask[i]]
    cut_x = x_proj[mask]
    cut_y = y_proj[mask]
    cut_z = sheet_z[mask]

    n_atoms = len(cut_elements)
    logger.info(
        "Nanotube (%d,%d) NL=%d: cut %d atoms, R=%.2f Å, L=%.2f Å",
        n, m, NL, n_atoms, radius, tube_length,
    )

    if n_atoms == 0:
        raise ValueError(
            f"No atoms found in the cut region for (n={n}, m={m}), NL={NL}. "
            f"C={circumference:.2f} Å, T={T_len:.2f} Å"
        )

    # Roll up: positions centered at tube axis (origin)
    theta = cut_x / radius
    r_eff = radius + cut_z
    positions_3d = np.zeros((n_atoms, 3))
    positions_3d[:, 0] = r_eff * np.sin(theta)
    positions_3d[:, 1] = cut_y
    positions_3d[:, 2] = r_eff * np.cos(theta)

    info.n_atoms = n_atoms
    return cut_elements, positions_3d, tube_length, info


def build_nanotube(
    a1: np.ndarray,
    a2: np.ndarray,
    elements: list[str],
    basis_frac: list[list[float]],
    z_coords: list[float],
    n: int,
    m: int,
    NL: int,
    vacuum: float = 15.0,
) -> tuple[list[str], np.ndarray, np.ndarray, NanotubeInfo]:
    """Build a single-wall nanotube from a 2D material."""
    cut_elements, positions_3d, tube_length, info = _roll_single_wall(
        a1, a2, elements, basis_frac, z_coords, n, m, NL,
    )

    # Add vacuum and build cell
    x_min, x_max = positions_3d[:, 0].min(), positions_3d[:, 0].max()
    z_min, z_max = positions_3d[:, 2].min(), positions_3d[:, 2].max()

    positions_3d[:, 0] -= x_min - vacuum
    positions_3d[:, 2] -= z_min - vacuum

    box_x = (x_max - x_min) + 2 * vacuum
    box_y = tube_length
    box_z = (z_max - z_min) + 2 * vacuum

    cell_3d = np.array([
        [box_x, 0.0, 0.0],
        [0.0, box_y, 0.0],
        [0.0, 0.0, box_z],
    ])

    return cut_elements, positions_3d, cell_3d, info


def find_chiral_indices_for_radius(
    a1: np.ndarray,
    a2: np.ndarray,
    target_radius: float,
    target_tube_length: float | None = None,
    max_index: int = 200,
) -> tuple[int, int, float]:
    """Find (n, m) chiral indices giving a tube radius closest to target_radius.

    If target_tube_length is given, also prefers indices whose translational
    vector T divides cleanly into the target length (avoids highly chiral
    tubes with enormous T).

    Returns (n, m, actual_radius).
    """
    target_circ = 2.0 * np.pi * target_radius
    g11 = np.dot(a1, a1)
    g12 = np.dot(a1, a2)
    g22 = np.dot(a2, a2)

    # Phase 1: rank all candidates by radius match
    candidates = []
    for ni in range(0, max_index + 1):
        for mi in range(0, ni + 1):
            if ni == 0 and mi == 0:
                continue
            c_sq = ni * ni * g11 + 2 * ni * mi * g12 + mi * mi * g22
            c_len = math.sqrt(c_sq)
            diff = abs(c_len - target_circ)
            candidates.append((diff, ni, mi, c_len))

    candidates.sort()

    if not candidates:
        return 1, 0, math.sqrt(g11) / (2.0 * np.pi)

    if target_tube_length is None:
        _, bn, bm, bc = candidates[0]
        return bn, bm, bc / (2.0 * np.pi)

    # Phase 2: among the top candidates, score by T compatibility
    best_score = np.inf
    best_n, best_m = candidates[0][1], candidates[0][2]
    threshold = max(candidates[0][0] * 5, target_circ * 0.05)

    for radius_diff, ni, mi, c_len in candidates[:80]:
        if radius_diff > threshold:
            break

        T, _, _ = find_translational_vector(a1, a2, ni, mi, max_search=50)
        T_len = np.linalg.norm(T)
        if T_len < 1e-10:
            continue

        NL_needed = max(1, round(target_tube_length / T_len))
        actual_length = NL_needed * T_len
        length_mismatch = abs(actual_length - target_tube_length) / target_tube_length

        rel_radius_diff = radius_diff / target_circ
        # Penalize tubes needing many repeats (tiny T → huge atom count)
        nl_penalty = max(0, NL_needed - 5) * 0.05
        score = rel_radius_diff + length_mismatch * 0.5 + nl_penalty

        if score < best_score:
            best_score = score
            best_n, best_m = ni, mi

    actual_radius = math.sqrt(
        best_n * best_n * g11 + 2 * best_n * best_m * g12 + best_m * best_m * g22
    ) / (2.0 * np.pi)
    return best_n, best_m, actual_radius


@dataclass
class MWNTWallInfo:
    """Info about one wall of a multi-wall nanotube."""
    n: int
    m: int
    radius: float
    n_atoms: int
    NL_used: int


@dataclass
class MWNTInfo:
    """Info about a multi-wall nanotube."""
    inner_info: NanotubeInfo
    walls: list[MWNTWallInfo]
    total_atoms: int
    tube_length: float  # common tube length (from inner wall)


def build_mwnt(
    a1: np.ndarray,
    a2: np.ndarray,
    elements: list[str],
    basis_frac: list[list[float]],
    z_coords: list[float],
    n: int,
    m: int,
    n_walls: int,
    interlayer_spacing: float,
    NL: int,
    vacuum: float = 15.0,
) -> tuple[list[str], np.ndarray, np.ndarray, MWNTInfo]:
    """Build a multi-wall nanotube.

    Args:
        n, m: Chiral indices for the innermost wall.
        n_walls: Total number of walls (1 = single-wall).
        interlayer_spacing: Spacing between walls in Angstroms (typically ~3.4).
        NL: Number of translational periods for the inner wall.
        vacuum: Vacuum padding in Angstroms.

    Returns:
        all_elements, positions_3d, cell_3d, mwnt_info
    """
    # Build inner wall
    inner_elems, inner_pos, inner_tube_length, inner_info = _roll_single_wall(
        a1, a2, elements, basis_frac, z_coords, n, m, NL,
    )

    all_elems = list(inner_elems)
    all_pos = [inner_pos]
    wall_infos = [MWNTWallInfo(
        n=n, m=m, radius=inner_info.radius,
        n_atoms=inner_info.n_atoms, NL_used=NL,
    )]

    # Build outer walls
    for w in range(1, n_walls):
        target_r = inner_info.radius + w * interlayer_spacing
        wn, wm, actual_r = find_chiral_indices_for_radius(
            a1, a2, target_r, target_tube_length=inner_tube_length,
        )

        # Match tube length: find NL for this wall
        T_w, _, _ = find_translational_vector(a1, a2, wn, wm)
        T_w_len = np.linalg.norm(T_w)
        if T_w_len < 1e-10:
            logger.warning("Wall %d: T has zero length for (%d,%d), skipping", w, wn, wm)
            continue
        NL_w = max(1, round(inner_tube_length / T_w_len))

        w_elems, w_pos, w_tube_length, w_info = _roll_single_wall(
            a1, a2, elements, basis_frac, z_coords, wn, wm, NL_w,
        )

        all_elems.extend(w_elems)
        all_pos.append(w_pos)
        wall_infos.append(MWNTWallInfo(
            n=wn, m=wm, radius=w_info.radius,
            n_atoms=w_info.n_atoms, NL_used=NL_w,
        ))

        logger.info(
            "MWNT wall %d: (%d,%d) R=%.2f Å (target %.2f), NL=%d, %d atoms",
            w, wn, wm, actual_r, target_r, NL_w, w_info.n_atoms,
        )

    # Combine all walls
    combined_pos = np.vstack(all_pos)
    total_atoms = len(all_elems)

    # Add vacuum and build cell
    x_min, x_max = combined_pos[:, 0].min(), combined_pos[:, 0].max()
    z_min, z_max = combined_pos[:, 2].min(), combined_pos[:, 2].max()

    combined_pos[:, 0] -= x_min - vacuum
    combined_pos[:, 2] -= z_min - vacuum

    box_x = (x_max - x_min) + 2 * vacuum
    box_y = inner_tube_length
    box_z = (z_max - z_min) + 2 * vacuum

    cell_3d = np.array([
        [box_x, 0.0, 0.0],
        [0.0, box_y, 0.0],
        [0.0, 0.0, box_z],
    ])

    mwnt_info = MWNTInfo(
        inner_info=inner_info,
        walls=wall_infos,
        total_atoms=total_atoms,
        tube_length=inner_tube_length,
    )

    return all_elems, combined_pos, cell_3d, mwnt_info


def extract_2d_layer(structure_dict: dict) -> tuple[np.ndarray, np.ndarray, list[str], list[list[float]], list[float]]:
    """Extract 2D lattice vectors, elements, and basis from a PymatgenStructure dict.

    Assumes the structure is a 2D slab (periodic in xy, vacuum along z).
    Returns a1, a2 as 2D vectors (xy components only).
    """
    lattice = structure_dict.get("lattice")
    if lattice is None:
        raise ValueError("Structure has no lattice (molecule). Need a periodic 2D material.")

    matrix = np.array(lattice["matrix"])
    a1_3d = matrix[0]
    a2_3d = matrix[1]

    # Take xy components
    a1 = a1_3d[:2].copy()
    a2 = a2_3d[:2].copy()

    sites = structure_dict["sites"]
    elements = []
    basis_frac = []
    z_coords = []

    # Find z_center to compute relative z offsets
    all_z = [s["xyz"][2] for s in sites]
    z_center = (min(all_z) + max(all_z)) / 2.0

    for site in sites:
        species = site["species"]
        elem = max(species, key=lambda sp: sp.get("occu", 1.0))["element"]
        elements.append(elem)
        abc = site["abc"]
        basis_frac.append([abc[0], abc[1]])
        z_coords.append(site["xyz"][2] - z_center)

    return a1, a2, elements, basis_frac, z_coords
