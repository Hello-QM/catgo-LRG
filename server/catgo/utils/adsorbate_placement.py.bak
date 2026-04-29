"""Adsorbate placement algorithm.

Places an adsorbate molecule at a surface adsorption site by:
1. Rotating adsorbate to align binding direction (COM → binding centroid) with -normal
2. Flattening binding atoms so they lie at the same height above the surface
3. For multi-dentate: rotating around normal to best match site neighbor topology
4. Translating binding centroid to site_position + height_offset * normal
5. Collision resolution: shifting up if any adsorbate atom overlaps with slab

Supports single-dentate (one binding atom) and multi-dentate (multiple binding atoms).
"""

import numpy as np


def compute_rotation_matrix(v_from: np.ndarray, v_to: np.ndarray) -> np.ndarray:
    """Compute rotation matrix that rotates v_from to v_to using Rodrigues' formula."""
    v_from = v_from / np.linalg.norm(v_from)
    v_to = v_to / np.linalg.norm(v_to)

    cross = np.cross(v_from, v_to)
    dot = np.dot(v_from, v_to)

    if dot > 1.0 - 1e-8:
        return np.eye(3)

    if dot < -1.0 + 1e-8:
        if abs(v_from[0]) < 0.9:
            perp = np.cross(v_from, np.array([1, 0, 0]))
        else:
            perp = np.cross(v_from, np.array([0, 1, 0]))
        perp = perp / np.linalg.norm(perp)
        return 2.0 * np.outer(perp, perp) - np.eye(3)

    sin_angle = np.linalg.norm(cross)
    K = np.array([
        [0, -cross[2], cross[1]],
        [cross[2], 0, -cross[0]],
        [-cross[1], cross[0], 0],
    ])
    return np.eye(3) + K + K @ K * ((1 - dot) / (sin_angle ** 2))


def _rotation_around_axis(axis: np.ndarray, angle: float) -> np.ndarray:
    """Rotation matrix for angle (radians) around a given axis."""
    axis = axis / np.linalg.norm(axis)
    K = np.array([
        [0, -axis[2], axis[1]],
        [axis[2], 0, -axis[0]],
        [-axis[1], axis[0], 0],
    ])
    return np.eye(3) + np.sin(angle) * K + (1 - np.cos(angle)) * (K @ K)


def _flatten_binding_atoms(
    ads_pos: np.ndarray,
    binding_atom_indices: list[int],
    site_normal: np.ndarray,
) -> np.ndarray:
    """Rotate adsorbate so binding atoms lie in a plane perpendicular to the normal.

    For bidentate (2 binding atoms): rotates so the vector between them
    has zero component along the normal (both at same height).

    For polydentate (3+ binding atoms): uses SVD to find the binding atoms'
    best-fit plane, then aligns that plane's normal with the surface normal.
    """
    binding_pos = ads_pos[binding_atom_indices]
    centroid = binding_pos.mean(axis=0)

    if len(binding_atom_indices) == 2:
        # Bidentate: make the vector between atoms perpendicular to normal
        v = binding_pos[1] - binding_pos[0]
        v_len = np.linalg.norm(v)
        if v_len < 1e-8:
            return ads_pos

        # Component of v along normal
        v_normal_comp = np.dot(v, site_normal) * site_normal
        v_in_plane = v - v_normal_comp
        v_in_plane_len = np.linalg.norm(v_in_plane)

        if v_in_plane_len < 1e-8 or np.linalg.norm(v_normal_comp) < 1e-8:
            return ads_pos  # Already in plane or fully along normal

        # Rotation axis: perpendicular to both v and normal
        rot_axis = np.cross(v, site_normal)
        rot_axis_len = np.linalg.norm(rot_axis)
        if rot_axis_len < 1e-8:
            return ads_pos

        rot_axis = rot_axis / rot_axis_len

        # Angle to rotate: angle between v and its in-plane projection
        cos_angle = np.clip(np.dot(v / v_len, v_in_plane / v_in_plane_len), -1, 1)
        angle = np.arccos(cos_angle)

        # Determine sign: we want to reduce the normal component
        if np.dot(v_normal_comp, site_normal) > 0:
            angle = -angle

        # Test both +angle and -angle, pick the one that reduces normal component
        R_pos = _rotation_around_axis(rot_axis, angle)
        R_neg = _rotation_around_axis(rot_axis, -angle)

        v_rotated_pos = R_pos @ v
        v_rotated_neg = R_neg @ v

        if abs(np.dot(v_rotated_pos, site_normal)) < abs(np.dot(v_rotated_neg, site_normal)):
            R = R_pos
        else:
            R = R_neg

        # Rotate around adsorbate COM (not binding centroid) to preserve overall structure
        com = ads_pos.mean(axis=0)
        return (R @ (ads_pos - com).T).T + com

    elif len(binding_atom_indices) >= 3:
        # Polydentate: fit plane via SVD, align plane normal with surface normal
        rel = binding_pos - centroid
        _, _, Vt = np.linalg.svd(rel)
        plane_normal = Vt[-1]  # Smallest singular vector = plane normal

        # Ensure plane_normal points same direction as surface normal
        if np.dot(plane_normal, site_normal) < 0:
            plane_normal = -plane_normal

        # Rotate plane_normal to align with site_normal
        R = compute_rotation_matrix(plane_normal, site_normal)
        com = ads_pos.mean(axis=0)
        return (R @ (ads_pos - com).T).T + com

    return ads_pos


def _optimal_normal_rotation(
    binding_pos: np.ndarray,
    binding_centroid: np.ndarray,
    neighbor_positions: np.ndarray,
    site_position: np.ndarray,
    site_normal: np.ndarray,
) -> np.ndarray:
    """Find the optimal rotation around site_normal that best aligns binding atoms to neighbors.

    Projects everything onto the surface plane, then scans rotation angles to
    minimize the sum of minimum distances from each binding atom to nearest neighbor.
    """
    if len(binding_pos) < 2 or len(neighbor_positions) < 2:
        return np.eye(3)

    # Project onto surface plane
    def project(pts, origin):
        rel = pts - origin
        return rel - np.outer(rel @ site_normal, site_normal)

    binding_proj = project(binding_pos, binding_centroid)
    neighbor_proj = project(neighbor_positions, site_position)

    # Coarse scan: 5° increments
    best_angle = 0.0
    best_cost = np.inf
    n_steps = 72

    for i in range(n_steps):
        angle = 2.0 * np.pi * i / n_steps
        R = _rotation_around_axis(site_normal, angle)
        rotated = (R @ binding_proj.T).T

        cost = 0.0
        for bp in rotated:
            dists = np.linalg.norm(neighbor_proj - bp, axis=1)
            cost += dists.min()

        if cost < best_cost:
            best_cost = cost
            best_angle = angle

    # Fine scan: 1° around best
    coarse = best_angle
    for i in range(36):
        angle = coarse + (i - 18) * (np.pi / 180.0)
        R = _rotation_around_axis(site_normal, angle)
        rotated = (R @ binding_proj.T).T

        cost = 0.0
        for bp in rotated:
            dists = np.linalg.norm(neighbor_proj - bp, axis=1)
            cost += dists.min()

        if cost < best_cost:
            best_cost = cost
            best_angle = angle

    if abs(best_angle) < 1e-6:
        return np.eye(3)

    return _rotation_around_axis(site_normal, best_angle)


def _resolve_collisions(
    ads_pos: np.ndarray,
    slab_positions: np.ndarray,
    site_normal: np.ndarray,
    min_clearance: float = 1.5,
) -> np.ndarray:
    """Shift adsorbate up along normal if any atom is too close to the slab.

    Args:
        ads_pos: Adsorbate atom positions (M x 3).
        slab_positions: Slab atom positions (N x 3).
        site_normal: Surface normal (unit vector).
        min_clearance: Minimum allowed distance (Å) between any adsorbate-slab pair.

    Returns:
        Adjusted adsorbate positions.
    """
    # Find the minimum distance from any adsorbate atom to any slab atom
    from scipy.spatial.distance import cdist
    dist_matrix = cdist(ads_pos, slab_positions)
    min_dist = dist_matrix.min()

    if min_dist >= min_clearance:
        return ads_pos

    # Need to shift up. Binary search for the right shift amount.
    shift = 0.0
    step = 0.1
    while shift < 10.0:
        shift += step
        shifted = ads_pos + shift * site_normal
        new_dists = cdist(shifted, slab_positions)
        if new_dists.min() >= min_clearance:
            return shifted

    # Fallback: apply max shift
    return ads_pos + shift * site_normal


def place_adsorbate(
    slab_positions: np.ndarray,
    slab_symbols: list[str],
    slab_cell: np.ndarray | None,
    slab_pbc: list[bool] | None,
    adsorbate_positions: np.ndarray,
    adsorbate_symbols: list[str],
    binding_atom_indices: list[int],
    site_position: np.ndarray,
    site_normal: np.ndarray,
    height_offset: float = 0.0,
    auto_rotate: bool = True,
    neighbor_positions: np.ndarray | None = None,
) -> dict:
    """Place an adsorbate at a surface site (single- or multi-dentate).

    Args:
        slab_positions: Slab atom positions (N x 3).
        slab_symbols: Slab element symbols.
        slab_cell: Slab cell matrix (3x3) or None.
        slab_pbc: Slab PBC flags or None.
        adsorbate_positions: Adsorbate atom positions (M x 3).
        adsorbate_symbols: Adsorbate element symbols.
        binding_atom_indices: Indices of binding atoms (1=mono-, >1=multi-dentate).
        site_position: Adsorption site position (3,).
        site_normal: Surface normal at site (3,), unit vector pointing outward.
        height_offset: Additional height above site along normal (Å).
        auto_rotate: If True, rotate adsorbate to align with surface.
        neighbor_positions: Surface neighbor atom positions (for topological alignment).

    Returns:
        Dict with keys: positions, symbols, cell, pbc, adsorbate_indices,
        binding_atom_position, slab_atom_count, adsorbate_atom_count.
    """
    site_position = np.asarray(site_position, dtype=float)
    site_normal = np.asarray(site_normal, dtype=float)

    n_len = np.linalg.norm(site_normal)
    if n_len < 1e-9:
        site_normal = np.array([0, 0, 1.0])
    else:
        site_normal = site_normal / n_len

    ads_pos = np.array(adsorbate_positions, dtype=float)
    n_ads = len(ads_pos)

    for idx in binding_atom_indices:
        if idx < 0 or idx >= n_ads:
            raise ValueError(f"binding_atom_index {idx} out of range for {n_ads} atoms")

    is_multidentate = len(binding_atom_indices) >= 2

    if auto_rotate and n_ads > 1:
        # Step 1: Align COM→binding_centroid with -normal
        binding_centroid = ads_pos[binding_atom_indices].mean(axis=0)
        com = ads_pos.mean(axis=0)
        binding_dir = binding_centroid - com
        bd_len = np.linalg.norm(binding_dir)

        if bd_len > 1e-6:
            binding_dir = binding_dir / bd_len
            R1 = compute_rotation_matrix(binding_dir, -site_normal)
            ads_pos = (R1 @ (ads_pos - com).T).T + com

        # Step 2: Flatten binding atoms to same height (multi-dentate only)
        if is_multidentate:
            ads_pos = _flatten_binding_atoms(ads_pos, binding_atom_indices, site_normal)

        # Step 3: Topological rotation around normal (multi-dentate with neighbors)
        if (
            is_multidentate
            and neighbor_positions is not None
            and len(neighbor_positions) >= 2
        ):
            binding_centroid = ads_pos[binding_atom_indices].mean(axis=0)
            binding_pos = ads_pos[binding_atom_indices]
            nbr_pos = np.asarray(neighbor_positions, dtype=float)

            R3 = _optimal_normal_rotation(
                binding_pos, binding_centroid,
                nbr_pos, site_position, site_normal,
            )
            ads_pos = (R3 @ (ads_pos - binding_centroid).T).T + binding_centroid

    # Step 4: Translate binding centroid to site + offset
    binding_centroid = ads_pos[binding_atom_indices].mean(axis=0)
    target_pos = site_position + height_offset * site_normal
    ads_pos = ads_pos + (target_pos - binding_centroid)

    # Step 5: Collision resolution
    ads_pos = _resolve_collisions(ads_pos, slab_positions, site_normal)

    # Merge
    n_slab = len(slab_positions)
    merged_positions = np.vstack([slab_positions, ads_pos])
    merged_symbols = list(slab_symbols) + list(adsorbate_symbols)
    adsorbate_indices = list(range(n_slab, n_slab + n_ads))

    final_binding_centroid = ads_pos[binding_atom_indices].mean(axis=0)

    return {
        "positions": merged_positions,
        "symbols": merged_symbols,
        "cell": slab_cell,
        "pbc": slab_pbc,
        "adsorbate_indices": adsorbate_indices,
        "binding_atom_position": final_binding_centroid.tolist(),
        "slab_atom_count": n_slab,
        "adsorbate_atom_count": n_ads,
    }


def place_dual_adsorbates(
    slab_positions: np.ndarray,
    slab_symbols: list[str],
    slab_cell: np.ndarray | None,
    slab_pbc: list[bool] | None,
    ads1_positions: np.ndarray,
    ads1_symbols: list[str],
    ads1_binding_indices: list[int],
    ads2_positions: np.ndarray,
    ads2_symbols: list[str],
    ads2_binding_indices: list[int],
    sites: list[dict],
    target_distance: float = 3.5,
    distance_tolerance: float = 1.5,
    auto_rotate: bool = True,
) -> dict:
    """Place two adsorbates on a slab at neighboring sites with controlled distance.

    Selects the best pair of adsorption sites such that the binding atoms of the
    two adsorbates are separated by approximately `target_distance` (Å). After
    placement, rotates the second adsorbate around the surface normal so that its
    binding atom points toward the first adsorbate's binding atom — the correct
    pre-coupling geometry for C-N coupling studies.

    Args:
        slab_positions: Slab atom positions (N x 3).
        slab_symbols: Slab element symbols.
        slab_cell: Slab cell matrix (3x3) or None.
        slab_pbc: Slab PBC flags or None.
        ads1_positions: First adsorbate positions (M1 x 3).
        ads1_symbols: First adsorbate element symbols.
        ads1_binding_indices: Binding atom indices for first adsorbate.
        ads2_positions: Second adsorbate positions (M2 x 3).
        ads2_symbols: Second adsorbate element symbols.
        ads2_binding_indices: Binding atom indices for second adsorbate.
        sites: List of adsorption site dicts with 'position', 'normal', 'site_type'.
        target_distance: Desired binding-atom distance between adsorbates (Å).
        distance_tolerance: Acceptable deviation from target_distance (Å).
        auto_rotate: Rotate adsorbates to align with surface.

    Returns:
        Dict with merged structure and placement metadata.
    """
    if len(sites) < 2:
        raise ValueError("Need at least 2 adsorption sites for dual placement")

    # ---- Step 1: Find best site pair ----
    site_positions = np.array([s["position"] for s in sites])
    n_sites = len(site_positions)

    best_pair = None
    best_score = float("inf")

    for i in range(n_sites):
        for j in range(i + 1, n_sites):
            dist = np.linalg.norm(site_positions[i] - site_positions[j])
            score = abs(dist - target_distance)
            if score < best_score and score <= distance_tolerance:
                best_score = score
                best_pair = (i, j)

    if best_pair is None:
        # Fallback: pick the pair closest to target_distance even if outside tolerance
        for i in range(n_sites):
            for j in range(i + 1, n_sites):
                dist = np.linalg.norm(site_positions[i] - site_positions[j])
                score = abs(dist - target_distance)
                if score < best_score:
                    best_score = score
                    best_pair = (i, j)

    si, sj = best_pair
    site1 = sites[si]
    site2 = sites[sj]

    pos1 = np.array(site1["position"])
    pos2 = np.array(site2["position"])
    normal1 = np.array(site1.get("normal", [0, 0, 1]))
    normal2 = np.array(site2.get("normal", [0, 0, 1]))
    site_dist = np.linalg.norm(pos2 - pos1)

    # ---- Step 2: Place first adsorbate ----
    result1 = place_adsorbate(
        slab_positions, slab_symbols, slab_cell, slab_pbc,
        ads1_positions, ads1_symbols, ads1_binding_indices,
        pos1, normal1, height_offset=0.0, auto_rotate=auto_rotate,
    )

    # ---- Step 3: Place second adsorbate on merged slab+ads1 ----
    merged_pos_1 = result1["positions"]
    merged_sym_1 = result1["symbols"]

    result2 = place_adsorbate(
        merged_pos_1, merged_sym_1, slab_cell, slab_pbc,
        ads2_positions, ads2_symbols, ads2_binding_indices,
        pos2, normal2, height_offset=0.0, auto_rotate=auto_rotate,
    )

    final_positions = result2["positions"]
    final_symbols = result2["symbols"]

    # ---- Step 4: Orient binding atoms to face each other ----
    n_slab = len(slab_positions)
    n_ads1 = len(ads1_positions)
    n_ads2 = len(ads2_positions)

    ads1_final_indices = list(range(n_slab, n_slab + n_ads1))
    ads2_final_indices = list(range(n_slab + n_ads1, n_slab + n_ads1 + n_ads2))

    # Binding atom positions in the final merged structure
    bind1_pos = final_positions[ads1_final_indices[ads1_binding_indices[0]]]
    bind2_pos = final_positions[ads2_final_indices[ads2_binding_indices[0]]]

    # Rotate ads2 around surface normal so its binding atom faces ads1's binding atom
    ads2_positions_final = final_positions[ads2_final_indices]
    ads2_centroid = ads2_positions_final.mean(axis=0)

    # Vector from ads2 centroid to ads1 binding atom (projected onto surface plane)
    towards_ads1 = bind1_pos - ads2_centroid
    towards_ads1_proj = towards_ads1 - np.dot(towards_ads1, normal2) * normal2
    towards_ads1_proj_len = np.linalg.norm(towards_ads1_proj)

    if towards_ads1_proj_len > 1e-6:
        # Vector from ads2 centroid to ads2 binding atom (projected onto surface plane)
        bind2_from_center = bind2_pos - ads2_centroid
        bind2_proj = bind2_from_center - np.dot(bind2_from_center, normal2) * normal2
        bind2_proj_len = np.linalg.norm(bind2_proj)

        if bind2_proj_len > 1e-6:
            # Angle between current binding direction and desired direction
            cos_angle = np.clip(
                np.dot(bind2_proj / bind2_proj_len, towards_ads1_proj / towards_ads1_proj_len),
                -1, 1,
            )
            angle = np.arccos(cos_angle)

            # Determine sign via cross product
            cross = np.cross(bind2_proj, towards_ads1_proj)
            if np.dot(cross, normal2) < 0:
                angle = -angle

            # Apply rotation to ads2
            R = _rotation_around_axis(normal2, angle)
            ads2_rotated = (R @ (ads2_positions_final - ads2_centroid).T).T + ads2_centroid

            # Check for collision with slab+ads1
            from scipy.spatial.distance import cdist
            slab_and_ads1 = final_positions[:n_slab + n_ads1]
            min_dist = cdist(ads2_rotated, slab_and_ads1).min()

            if min_dist >= 1.5:
                final_positions[ads2_final_indices] = ads2_rotated
            # else: keep original orientation to avoid collision

    # ---- Step 5: Compute final binding distance ----
    final_bind1 = final_positions[ads1_final_indices[ads1_binding_indices[0]]]
    final_bind2 = final_positions[ads2_final_indices[ads2_binding_indices[0]]]
    binding_distance = float(np.linalg.norm(final_bind2 - final_bind1))

    return {
        "positions": final_positions,
        "symbols": final_symbols,
        "cell": slab_cell,
        "pbc": slab_pbc,
        "ads1_indices": ads1_final_indices,
        "ads2_indices": ads2_final_indices,
        "all_adsorbate_indices": ads1_final_indices + ads2_final_indices,
        "site1": {"position": pos1.tolist(), "type": site1.get("site_type", "unknown")},
        "site2": {"position": pos2.tolist(), "type": site2.get("site_type", "unknown")},
        "site_distance": float(site_dist),
        "binding_distance": binding_distance,
        "slab_atom_count": n_slab,
        "ads1_atom_count": n_ads1,
        "ads2_atom_count": n_ads2,
    }
