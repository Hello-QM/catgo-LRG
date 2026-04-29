"""Core algorithms for Moiré superlattice construction.

Implements the coincidence lattice method for finding commensurate twist angles
and building bilayer superstructures. Based on the approach described in:
  - Twister package (S. Carr et al.)
  - Coincidence lattice theory for twisted 2D materials
"""

import logging
from dataclasses import dataclass

import numpy as np
from ase import Atoms

logger = logging.getLogger(__name__)


@dataclass
class LayerData:
    """Extracted layer data for Moiré construction."""

    lattice_2d: np.ndarray  # (2, 2) 2D lattice vectors
    elements: list[str]
    basis_frac: np.ndarray  # (n_basis, 2) fractional coordinates
    n_basis: int


@dataclass
class CandidateResult:
    """Internal representation of a commensurate angle candidate."""

    angle: float
    m: int
    n: int
    p: int
    q: int
    m2: int
    n2: int
    p2: int
    q2: int
    mismatch: float
    n_atoms: int
    area_ratio: float
    strain_percent: float | None = None
    strain_tensor: list[list[float]] | None = None


def rotation_matrix_2d(theta_deg: float) -> np.ndarray:
    """Return a 2x2 rotation matrix for angle theta in degrees."""
    theta = np.radians(theta_deg)
    c, s = np.cos(theta), np.sin(theta)
    return np.array([[c, -s], [s, c]])


def extract_layer_data(layer_input) -> LayerData:
    """Extract 2D lattice vectors, elements, and basis from a MoireLayerInput.

    Supports both PymatgenStructure input and raw lattice vector specification.
    """
    if layer_input.structure is not None:
        return _extract_from_structure(layer_input.structure)
    elif layer_input.lattice_vectors is not None:
        return _extract_from_raw(layer_input)
    else:
        raise ValueError(
            "MoireLayerInput must provide either 'structure' or 'lattice_vectors' + 'elements' + 'basis_coords'"
        )


def _extract_from_structure(structure) -> LayerData:
    """Extract layer data from a PymatgenStructure."""
    if structure.lattice is None:
        raise ValueError("Structure must have a lattice for Moiré construction")

    matrix = np.array(structure.lattice.matrix)
    # Take the 2D projection (first two lattice vectors, xy components)
    lattice_2d = matrix[:2, :2]

    elements = []
    basis_frac = []
    inv_matrix = np.linalg.inv(matrix)
    for site in structure.sites:
        main_species = max(site.species, key=lambda s: s.occu)
        elements.append(main_species.element)
        # Use fractional coordinates (a, b) — compute from xyz if abc not available
        if site.abc is not None:
            basis_frac.append(site.abc[:2])
        else:
            frac = inv_matrix @ np.array(site.xyz)
            basis_frac.append(frac[:2].tolist())

    return LayerData(
        lattice_2d=lattice_2d,
        elements=elements,
        basis_frac=np.array(basis_frac),
        n_basis=len(elements),
    )


def _extract_from_raw(layer_input) -> LayerData:
    """Extract layer data from raw lattice vectors and basis specification.

    celldm scaling follows Twister convention:
    - celldm = [celldm1, celldm2, celldm3] (lattice constants in Å)
    - Each component of the vector is scaled by the corresponding celldm:
      real_vector = [vx * celldm1, vy * celldm2]
    - For hexagonal: celldm1 = celldm2 = a, so both x/y scale uniformly
    - For rectangular: celldm1 = a, celldm2 = b, different scaling per axis
    """
    if layer_input.elements is None or layer_input.basis_coords is None:
        raise ValueError("Must provide 'elements' and 'basis_coords' with 'lattice_vectors'")

    lattice_2d = np.array(layer_input.lattice_vectors, dtype=float)
    if layer_input.celldm is not None:
        cdm = layer_input.celldm
        if len(cdm) == 1:
            # Single value: scale everything uniformly
            lattice_2d *= cdm[0]
        elif len(cdm) >= 2:
            # Component-wise scaling: x by celldm[0], y by celldm[1]
            scale = np.array([cdm[0], cdm[1]])
            lattice_2d = lattice_2d * scale  # broadcast (2,2) * (2,)

    basis_frac = np.array(layer_input.basis_coords, dtype=float)

    return LayerData(
        lattice_2d=lattice_2d,
        elements=list(layer_input.elements),
        basis_frac=basis_frac,
        n_basis=len(layer_input.elements),
    )


def find_commensurate_angles(
    A: np.ndarray,
    B: np.ndarray,
    n_basis_a: int,
    n_basis_b: int,
    angle_min: float = 0.0,
    angle_max: float = 60.0,
    angle_step: float = 0.01,
    max_index: int = 12,
    mismatch_threshold: float = 0.01,
    max_atoms: int = 2000,
    apply_strain: bool = True,
    strain_layer: str = "both",
) -> list[CandidateResult]:
    """Find commensurate twist angles using the coincidence lattice method.

    For each angle θ:
    1. Rotate layer B: B_rot = R(θ) @ B
    2. For all (m, n) combinations, compute S_A = m*A[0] + n*A[1]
    3. Solve B_rot.T @ (p, q) = S_A to find nearest integer (p, q)
    4. Check if |S_A - S_B| < threshold
    5. Find a second linearly independent pair (S1, S2)

    Args:
        A: (2, 2) lattice vectors for layer A (rows are vectors)
        B: (2, 2) lattice vectors for layer B
        n_basis_a: number of basis atoms in layer A unit cell
        n_basis_b: number of basis atoms in layer B unit cell
        angle_min: minimum search angle (degrees)
        angle_max: maximum search angle (degrees)
        angle_step: angle step size (degrees)
        max_index: maximum superlattice index
        mismatch_threshold: maximum allowed mismatch (Å)
        max_atoms: maximum atoms filter
        apply_strain: whether to compute strain
        strain_layer: which layer to strain

    Returns:
        List of CandidateResult sorted by number of atoms.
    """
    candidates = []
    area_A = abs(np.cross(A[0], A[1]))
    angles = np.arange(angle_min, angle_max + angle_step / 2, angle_step)

    for theta in angles:
        if abs(theta) < 1e-10:
            continue  # Skip zero angle

        R = rotation_matrix_2d(theta)
        B_rot = (R @ B.T).T  # Rotate B vectors

        found = _search_coincidence_at_angle(
            A, B_rot, theta, max_index, mismatch_threshold,
            area_A, n_basis_a, n_basis_b, max_atoms,
            apply_strain, strain_layer,
        )
        candidates.extend(found)

    return candidates


def _search_coincidence_at_angle(
    A: np.ndarray,
    B_rot: np.ndarray,
    theta: float,
    max_index: int,
    mismatch_threshold: float,
    area_A: float,
    n_basis_a: int,
    n_basis_b: int,
    max_atoms: int,
    apply_strain: bool,
    strain_layer: str,
) -> list[CandidateResult]:
    """Search for coincidence lattice vectors at a given angle."""
    results = []
    B_rot_T = B_rot.T  # (2, 2) for solving

    # Collect all valid (m, n, p, q) pairs
    valid_pairs = []

    for m in range(-max_index, max_index + 1):
        for n in range(-max_index, max_index + 1):
            if m == 0 and n == 0:
                continue

            # Superlattice vector for layer A
            S_A = m * A[0] + n * A[1]

            # Find closest integer coefficients in rotated B basis
            try:
                pq_float = np.linalg.solve(B_rot_T, S_A)
            except np.linalg.LinAlgError:
                continue

            p = int(round(pq_float[0]))
            q = int(round(pq_float[1]))

            if p == 0 and q == 0:
                continue

            # Superlattice vector for layer B
            S_B = p * B_rot[0] + q * B_rot[1]

            # Check mismatch
            mismatch = np.linalg.norm(S_A - S_B)
            if mismatch < mismatch_threshold:
                valid_pairs.append((m, n, p, q, S_A, S_B, mismatch))

    # For each valid first vector, find a linearly independent second vector
    for i, (m1, n1, p1, q1, S1_A, S1_B, mis1) in enumerate(valid_pairs):
        for j, (m2, n2, p2, q2, S2_A, S2_B, mis2) in enumerate(valid_pairs):
            if j <= i:
                continue

            # Check linear independence
            cross = S1_A[0] * S2_A[1] - S1_A[1] * S2_A[0]
            if abs(cross) < 1e-8:
                continue

            # Supercell area
            sc_area = abs(cross)
            area_ratio = sc_area / area_A

            # Estimate number of atoms
            # Layer A: area_ratio * n_basis_a, Layer B: similar
            n_atoms_a = int(round(area_ratio * n_basis_a))
            # For layer B, compute its own area ratio
            area_B = abs(np.cross(B_rot[0], B_rot[1]))
            cross_B = S1_B[0] * S2_B[1] - S1_B[1] * S2_B[0]
            area_ratio_B = abs(cross_B) / area_B if area_B > 1e-10 else area_ratio
            n_atoms_b = int(round(area_ratio_B * n_basis_b))
            n_atoms = n_atoms_a + n_atoms_b

            if n_atoms > max_atoms:
                continue

            total_mismatch = mis1 + mis2

            # Compute strain if requested
            strain_pct = None
            strain_tensor = None
            if apply_strain:
                strain_pct, strain_tensor = compute_strain(
                    S1_A, S2_A, S1_B, S2_B, strain_layer
                )

            results.append(CandidateResult(
                angle=round(theta, 6),
                m=m1, n=n1, p=p1, q=q1,
                m2=m2, n2=n2, p2=p2, q2=q2,
                mismatch=round(total_mismatch, 8),
                n_atoms=n_atoms,
                area_ratio=round(area_ratio, 4),
                strain_percent=round(strain_pct, 6) if strain_pct is not None else None,
                strain_tensor=strain_tensor,
            ))

            # Only keep the smallest supercell for this first vector
            break

    return results


def compute_strain(
    S1_A: np.ndarray,
    S2_A: np.ndarray,
    S1_B: np.ndarray,
    S2_B: np.ndarray,
    strain_layer: str = "both",
) -> tuple[float, list[list[float]]]:
    """Compute strain tensor to make two layers exactly commensurate.

    The strain is applied to match S_B vectors to S_A vectors (or vice versa).

    Args:
        S1_A, S2_A: Superlattice vectors from layer A
        S1_B, S2_B: Superlattice vectors from layer B
        strain_layer: "top" (strain B), "bottom" (strain A), "both" (split)

    Returns:
        (strain_percent, strain_tensor_2x2)
    """
    # Build matrices: columns are the superlattice vectors
    M_A = np.column_stack([S1_A, S2_A])
    M_B = np.column_stack([S1_B, S2_B])

    if strain_layer == "top":
        # Strain B to match A: F @ M_B = M_A => F = M_A @ M_B^{-1}
        try:
            F = M_A @ np.linalg.inv(M_B)
        except np.linalg.LinAlgError:
            return 0.0, [[0.0, 0.0], [0.0, 0.0]]
        epsilon = F - np.eye(2)
    elif strain_layer == "bottom":
        # Strain A to match B: F @ M_A = M_B => F = M_B @ M_A^{-1}
        try:
            F = M_B @ np.linalg.inv(M_A)
        except np.linalg.LinAlgError:
            return 0.0, [[0.0, 0.0], [0.0, 0.0]]
        epsilon = F - np.eye(2)
    else:
        # Split strain equally between layers
        try:
            F = M_A @ np.linalg.inv(M_B)
        except np.linalg.LinAlgError:
            return 0.0, [[0.0, 0.0], [0.0, 0.0]]
        # Half-strain on each layer
        epsilon = (F - np.eye(2)) / 2

    # Strain magnitude as percentage (Frobenius norm)
    strain_pct = float(np.linalg.norm(epsilon) * 100)
    strain_tensor = epsilon.tolist()

    return strain_pct, strain_tensor


def deep_search_refine(
    A: np.ndarray,
    B: np.ndarray,
    n_basis_a: int,
    n_basis_b: int,
    candidates: list[CandidateResult],
    search_range: float = 0.5,
    search_step: float = 0.001,
    max_index: int = 12,
    mismatch_threshold: float = 0.01,
    max_atoms: int = 2000,
    apply_strain: bool = True,
    strain_layer: str = "both",
) -> list[CandidateResult]:
    """Refine around found candidates with finer angle resolution.

    For each candidate, search ±search_range degrees with search_step resolution.
    """
    refined = []
    searched_ranges = set()

    for cand in candidates:
        # Discretize range to avoid redundant searches
        range_key = round(cand.angle / search_range)
        if range_key in searched_ranges:
            continue
        searched_ranges.add(range_key)

        theta_min = max(0.001, cand.angle - search_range)
        theta_max = cand.angle + search_range

        area_A = abs(np.cross(A[0], A[1]))
        angles = np.arange(theta_min, theta_max + search_step / 2, search_step)

        for theta in angles:
            R = rotation_matrix_2d(theta)
            B_rot = (R @ B.T).T

            found = _search_coincidence_at_angle(
                A, B_rot, theta, max_index, mismatch_threshold,
                area_A, n_basis_a, n_basis_b, max_atoms,
                apply_strain, strain_layer,
            )
            refined.extend(found)

    return refined


def deduplicate_candidates(
    candidates: list[CandidateResult],
    angle_tol: float = 0.005,
) -> list[CandidateResult]:
    """Remove duplicate candidates that have similar angles and same atom count.

    Keeps the candidate with the smallest mismatch for each (angle, n_atoms) group.
    """
    if not candidates:
        return []

    # Sort by angle then by mismatch
    sorted_cands = sorted(candidates, key=lambda c: (c.angle, c.mismatch))

    unique = []
    for cand in sorted_cands:
        is_dup = False
        for existing in unique:
            if (
                abs(cand.angle - existing.angle) < angle_tol
                and cand.n_atoms == existing.n_atoms
            ):
                is_dup = True
                # Keep the one with smaller mismatch (already sorted)
                break
        if not is_dup:
            unique.append(cand)

    return unique


def build_moire_bilayer(
    layer_a: LayerData,
    layer_b: LayerData,
    candidate: CandidateResult,
    translate_z: float = 3.35,
    vacuum: float = 15.0,
    z_a: float = 0.0,
    apply_strain: bool = True,
    strain_layer: str = "both",
) -> Atoms:
    """Build the Moiré bilayer supercell from a candidate configuration.

    Algorithm:
    1. Construct the 2D superlattice vectors from (m, n) indices and layer A basis
    2. Rotate layer B by the twist angle
    3. Optionally apply strain for exact commensurability
    4. Tile both layers to fill the supercell
    5. Stack with interlayer distance and vacuum

    Args:
        layer_a: Layer A data
        layer_b: Layer B data
        candidate: Selected commensurate angle candidate
        translate_z: Interlayer distance (Å)
        vacuum: Vacuum thickness (Å)
        z_a: z-coordinate of layer A (Å)

    Returns:
        ASE Atoms object with the bilayer structure
    """
    A = layer_a.lattice_2d
    B = layer_b.lattice_2d

    # Superlattice vectors from layer A indices
    S1 = candidate.m * A[0] + candidate.n * A[1]
    S2 = candidate.m2 * A[0] + candidate.n2 * A[1]

    # Rotate B
    R = rotation_matrix_2d(candidate.angle)
    B_rot = (R @ B.T).T

    # Compute strained lattice vectors if strain is applied
    if apply_strain and candidate.strain_tensor is not None:
        epsilon = np.array(candidate.strain_tensor)
        if strain_layer == "top":
            # Strain B_rot
            F = np.eye(2) + epsilon
            B_strained = (F @ B_rot.T).T
            A_strained = A.copy()
        elif strain_layer == "bottom":
            F = np.eye(2) + epsilon
            A_strained = (F @ A.T).T
            B_strained = B_rot.copy()
        else:
            # Split: +epsilon/2 on A, -epsilon/2 on B (they meet in the middle)
            F_a = np.eye(2) + epsilon  # epsilon is already halved in compute_strain for "both"
            F_b = np.eye(2) - epsilon
            A_strained = (F_a @ A.T).T
            B_strained = (F_b @ B_rot.T).T

        # Recompute superlattice vectors using strained A
        S1 = candidate.m * A_strained[0] + candidate.n * A_strained[1]
        S2 = candidate.m2 * A_strained[0] + candidate.n2 * A_strained[1]
    else:
        A_strained = A.copy()
        B_strained = B_rot.copy()

    # Supercell area
    sc_area = abs(S1[0] * S2[1] - S1[1] * S2[0])

    # Total height: layer A at z_a, layer B at z_a + translate_z, plus vacuum
    z_b = z_a + translate_z
    total_z = z_b + vacuum

    # Build 3D cell
    cell_3d = np.array([
        [S1[0], S1[1], 0.0],
        [S2[0], S2[1], 0.0],
        [0.0, 0.0, total_z],
    ])

    # Compute B's own superlattice vectors for consistent boundary tiling
    S1_B = candidate.p * B_strained[0] + candidate.q * B_strained[1]
    S2_B = candidate.p2 * B_strained[0] + candidate.q2 * B_strained[1]

    # Generate atoms for each layer
    pos_a, sym_a, lab_a = [], [], []
    pos_b, sym_b, lab_b = [], [], []

    # Tile A using A's superlattice vectors (exact match)
    _tile_layer(
        A_strained, layer_a, S1, S2, z_a,
        pos_a, sym_a, lab_a, "A",
    )

    # Tile B using B's own superlattice vectors for boundary check
    # (avoids periodic image duplicates from split strain mismatch)
    _tile_layer(
        B_strained, layer_b, S1_B, S2_B, z_b,
        pos_b, sym_b, lab_b, "B",
    )

    all_positions = pos_a + pos_b
    all_symbols = sym_a + sym_b
    all_layers = lab_a + lab_b

    # Create ASE Atoms
    atoms = Atoms(
        symbols=all_symbols,
        positions=all_positions,
        cell=cell_3d,
        pbc=[True, True, False],
    )

    # Store layer info in arrays
    atoms.arrays["layer"] = np.array(all_layers)

    return atoms


def _point_in_supercell(frac_sc: np.ndarray, tol: float = 1e-4) -> bool:
    """Check if a fractional coordinate is inside the supercell [0, 1)."""
    return bool(-tol <= frac_sc[0] < 1 - tol and -tol <= frac_sc[1] < 1 - tol)


def _tile_layer(
    A_unit: np.ndarray,
    layer: LayerData,
    S1: np.ndarray,
    S2: np.ndarray,
    z: float,
    positions: list,
    symbols: list,
    layers: list,
    layer_label: str,
):
    """Tile a layer's unit cell to fill the supercell defined by S1, S2."""
    S_mat = np.array([S1, S2])

    try:
        A_inv = np.linalg.inv(A_unit.T)
    except np.linalg.LinAlgError:
        return

    # Transform supercell vectors to unit cell coordinates
    s1_frac = A_inv @ S1
    s2_frac = A_inv @ S2

    # Determine search range for (i, j) indices
    corners = np.array([
        [0, 0],
        s1_frac,
        s2_frac,
        s1_frac + s2_frac,
    ])
    i_min = int(np.floor(corners[:, 0].min())) - 1
    i_max = int(np.ceil(corners[:, 0].max())) + 1
    j_min = int(np.floor(corners[:, 1].min())) - 1
    j_max = int(np.ceil(corners[:, 1].max())) + 1

    try:
        S_inv = np.linalg.inv(S_mat.T)
    except np.linalg.LinAlgError:
        return

    for i in range(i_min, i_max + 1):
        for j in range(j_min, j_max + 1):
            for k, (elem, frac) in enumerate(zip(layer.elements, layer.basis_frac)):
                cart_2d = (i + frac[0]) * A_unit[0] + (j + frac[1]) * A_unit[1]
                frac_sc = S_inv @ cart_2d
                if _point_in_supercell(frac_sc):
                    positions.append([cart_2d[0], cart_2d[1], z])
                    symbols.append(elem)
                    layers.append(layer_label)


