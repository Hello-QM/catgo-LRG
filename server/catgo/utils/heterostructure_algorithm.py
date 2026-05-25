"""Heterostructure (coherent interface) builder.

Supports three modes:

**Bulk mode**: Takes two bulk crystal structures + Miller indices.
  Uses CoherentInterfaceBuilder to generate slabs and find lattice matches.

**Slab mode**: Takes two pre-existing slabs (e.g. already cut surfaces).
  Strips vacuum, runs ZSLGenerator directly on the 2D in-plane lattice vectors,
  then builds supercells and stacks them.

**Intermat mode**: Uses the intermat/JARVIS pipeline with more permissive
  tolerances and optional displacement scanning.
"""

import logging
from dataclasses import dataclass, field

import numpy as np
from pymatgen.analysis.interfaces.coherent_interfaces import CoherentInterfaceBuilder
from pymatgen.analysis.interfaces.zsl import ZSLGenerator
from pymatgen.core import Lattice as PmgLattice
from pymatgen.core import Structure

logger = logging.getLogger(__name__)


@dataclass
class MatchCandidate:
    """Internal representation of a ZSL lattice match."""

    match_id: int
    match_area: float
    film_transformation: list[list[int]]
    substrate_transformation: list[list[int]]
    film_sl_vectors: list[list[float]]
    substrate_sl_vectors: list[list[float]]
    strain: float  # Von Mises strain (%)
    n_atoms_substrate: int = 0
    n_atoms_film: int = 0


@dataclass
class TerminationPair:
    """A pair of film and substrate surface terminations."""

    film_termination: str
    substrate_termination: str


@dataclass
class SearchResult:
    """Result of the lattice-match search phase."""

    matches: list[MatchCandidate] = field(default_factory=list)
    terminations: list[TerminationPair] = field(default_factory=list)


def _compute_strain_percent(
    film_sl_vectors: list, substrate_sl_vectors: list
) -> float:
    """Compute the Von Mises strain between film and substrate superlattice vectors.

    Returns strain as a percentage.
    """
    f = np.array(film_sl_vectors, dtype=float)
    s = np.array(substrate_sl_vectors, dtype=float)

    # Compute transformation: F @ T = S  =>  T = F^-1 @ S (using 2D in-plane)
    # Use the 2D components (x, y) of the 3D vectors
    f_2d = f[:, :2]
    s_2d = s[:, :2]

    try:
        T = np.linalg.solve(f_2d, s_2d)
    except np.linalg.LinAlgError:
        return 0.0

    # Strain tensor: epsilon = (T + T^T) / 2 - I
    epsilon = (T + T.T) / 2.0 - np.eye(2)

    # Von Mises strain (2D): sqrt(e11^2 + e22^2 - e11*e22 + 3*e12^2)
    e11, e12, e22 = epsilon[0, 0], epsilon[0, 1], epsilon[1, 1]
    von_mises = np.sqrt(e11**2 + e22**2 - e11 * e22 + 3 * e12**2)

    return float(von_mises * 100.0)


def _strip_vacuum(structure: Structure, tol: float = 0.5) -> Structure:
    """Remove vacuum from a slab by compressing the c-axis.

    Finds the atom extent along c in Cartesian space and rebuilds the cell
    with c shrunk to just fit the atoms (plus tol Å padding on each side).
    """
    cart_coords = structure.cart_coords
    c_hat = structure.lattice.matrix[2]
    c_len = np.linalg.norm(c_hat)
    c_unit = c_hat / c_len

    # Project all atom positions onto the c-axis direction
    projections = cart_coords @ c_unit
    z_min = float(projections.min())
    z_max = float(projections.max())
    slab_thickness = z_max - z_min

    if slab_thickness < 0.1:
        # 2D monolayer — keep a minimal c
        slab_thickness = 0.1

    new_c_len = slab_thickness + 2 * tol

    # Shift atoms so the bottom is at tol above origin along c
    shift = -z_min + tol
    new_cart = cart_coords + shift * c_unit

    # Build new lattice with shortened c
    a_vec = structure.lattice.matrix[0]
    b_vec = structure.lattice.matrix[1]
    new_c_vec = c_unit * new_c_len
    new_lattice = PmgLattice([a_vec, b_vec, new_c_vec])

    return Structure(
        new_lattice,
        structure.species,
        new_cart,
        coords_are_cartesian=True,
    )


def _make_supercell_2d(
    structure: Structure, transformation: np.ndarray
) -> Structure:
    """Apply a 2x2 in-plane transformation to create a supercell.

    The transformation is a 2x2 integer matrix that maps the original a,b
    vectors to the new superlattice vectors. The c-axis is preserved.
    """
    # Build 3x3 transformation with c unchanged
    T = np.eye(3, dtype=int)
    T[:2, :2] = np.array(transformation, dtype=int)

    return structure * T


def _align_sl_vectors(
    sub_sl: list[list[float]],
    film_sl: list[list[float]],
    original_sub_a: np.ndarray,
) -> tuple[list[list[float]], list[list[float]]]:
    """Reorder sl_vector pairs so sub_sl[0] aligns with the original substrate a-vector.

    ZSL's reduced-basis algorithm may return sl_vectors with a/b swapped
    relative to the input substrate lattice convention.  This causes the output
    CIF/POSCAR to have a and b axes reversed compared to the input structures.
    We fix by comparing cosine similarity of each sl_vector with original a,
    and swapping if sl_vectors[1] is more aligned with original a.
    """
    s0 = np.array(sub_sl[0][:2], dtype=float)
    s1 = np.array(sub_sl[1][:2], dtype=float)
    ref = np.array(original_sub_a[:2], dtype=float)
    ref_norm = np.linalg.norm(ref)
    if ref_norm < 1e-10:
        return sub_sl, film_sl
    cos0 = abs(float(np.dot(s0, ref))) / (np.linalg.norm(s0) * ref_norm + 1e-10)
    cos1 = abs(float(np.dot(s1, ref))) / (np.linalg.norm(s1) * ref_norm + 1e-10)
    if cos1 > cos0:
        logger.debug("Swapping sl_vectors: sub_sl[1] aligns better with original a (cos1=%.3f > cos0=%.3f)", cos1, cos0)
        return [sub_sl[1], sub_sl[0]], [film_sl[1], film_sl[0]]
    return sub_sl, film_sl


def _compute_deformation_2d(
    film_sl_vectors: list[list[float]],
    substrate_sl_vectors: list[list[float]],
) -> np.ndarray:
    """Compute the 2D Cartesian deformation gradient from film to substrate.

    Returns D (2×2) such that D @ film_sl_vec_i ≈ sub_sl_vec_i for i=0,1.
    Apply as: xy_new = (D @ xy_old.T).T to strain film atoms onto substrate.
    """
    f = np.array(film_sl_vectors, dtype=float)[:, :2]  # 2×2
    s = np.array(substrate_sl_vectors, dtype=float)[:, :2]  # 2×2
    # D @ F^T = S^T  =>  D = S^T @ inv(F^T) = S^T @ inv(F)^T
    return s.T @ np.linalg.inv(f.T)


def _wrap_inplane_fracs(structure: Structure) -> Structure:
    """Wrap a/b fractional coords into [0,1), leave c untouched.

    The pymatgen CoherentInterfaceBuilder and the intermat/JARVIS pipeline
    both return interface structures whose in-plane (a,b) fractional
    coordinates can fall outside [0,1) — atoms then render outside the
    lattice box in the viewer even though their Cartesian positions are
    physically correct. `_stack_slabs` already does `frac_coords % 1.0`;
    these two paths don't. Wrap a/b here to match.

    c is deliberately NOT wrapped: a slab/heterostructure sits inside a
    tall c-cell with vacuum, and `% 1.0` on c could split a contiguous
    slab across the cell boundary (an atom at z-frac 0.99 and another at
    0.01 would look detached). All builder outputs observed keep c well
    inside [0,1), so leaving it alone is safe and avoids that hazard.

    Returns a plain Structure (site_properties dropped — callers compute
    film/substrate counts BEFORE calling this, and _native_to_model does
    not read site_properties).
    """
    fracs = structure.frac_coords.copy()
    fracs[:, 0] = fracs[:, 0] % 1.0
    fracs[:, 1] = fracs[:, 1] % 1.0
    return Structure(structure.lattice, structure.species, fracs)


def _stack_slabs(
    substrate: Structure,
    film: Structure,
    gap: float = 2.0,
    vacuum: float = 20.0,
    twist_angle: float = 0.0,
    film_sl_vectors: list[list[float]] | None = None,
    substrate_sl_vectors: list[list[float]] | None = None,
    xy_shift: tuple[float, float] = (0.0, 0.0),
    target_z: float = 0.0,
) -> Structure:
    """Stack film on top of substrate with specified gap and vacuum.

    Both slabs should already be supercells with matching a,b vectors.
    The film's a,b are strained to match the substrate's exactly.
    Optionally rotates the film in-plane by twist_angle (degrees).

    If film_sl_vectors / substrate_sl_vectors are provided (from ZSL), the
    strain is applied as a 2D Cartesian deformation gradient computed from
    the matched superlattice vectors.  This avoids the large shear that
    occurs when the raw supercell bases have very different angles.

    xy_shift is a fractional (fa, fb) shift of the film along the interface
    a and b vectors.  Applied after strain, before vertical stacking.
    """
    sub_cart = substrate.cart_coords.copy()
    sub_species = list(substrate.species)

    if film_sl_vectors is not None and substrate_sl_vectors is not None:
        # Cartesian deformation: D maps film_sl → sub_sl in the xy plane.
        # Film atom z-coordinates are preserved (only in-plane strain).
        D = _compute_deformation_2d(film_sl_vectors, substrate_sl_vectors)
        film_cart = film.cart_coords.copy()
        film_cart[:, :2] = (D @ film_cart[:, :2].T).T
    else:
        # Legacy: fractional-coordinate mapping (fine when both lattices
        # have similar angles, e.g. manual mode).
        film_frac = film.frac_coords.copy()
        strained_lattice = PmgLattice([
            substrate.lattice.matrix[0],
            substrate.lattice.matrix[1],
            film.lattice.matrix[2],
        ])
        film_cart = strained_lattice.get_cartesian_coords(film_frac)

    # Apply twist angle (rotation around c-axis) if nonzero
    if abs(twist_angle) > 1e-10:
        theta = np.radians(twist_angle)
        cos_t, sin_t = np.cos(theta), np.sin(theta)
        # Rotate in-plane (x, y) around the centroid of film atoms
        centroid_xy = film_cart[:, :2].mean(axis=0)
        rel = film_cart[:, :2] - centroid_xy
        rotated = np.column_stack([
            rel[:, 0] * cos_t - rel[:, 1] * sin_t,
            rel[:, 0] * sin_t + rel[:, 1] * cos_t,
        ])
        film_cart = np.column_stack([rotated + centroid_xy, film_cart[:, 2]])

    film_species = list(film.species)

    # Apply in-plane fractional shift along interface a,b vectors
    fa, fb = xy_shift
    if abs(fa) > 1e-10 or abs(fb) > 1e-10:
        if substrate_sl_vectors is not None:
            a_vec = np.array(substrate_sl_vectors[0], dtype=float)
            b_vec = np.array(substrate_sl_vectors[1], dtype=float)
        else:
            a_vec = substrate.lattice.matrix[0]
            b_vec = substrate.lattice.matrix[1]
        shift_xy = fa * a_vec + fb * b_vec
        film_cart += shift_xy

    # Project onto substrate's c direction
    sub_c_hat = substrate.lattice.matrix[2]
    sub_c_len = np.linalg.norm(sub_c_hat)
    sub_c_unit = sub_c_hat / sub_c_len

    sub_proj = sub_cart @ sub_c_unit
    sub_top = float(sub_proj.max())

    film_c_hat = film.lattice.matrix[2]
    film_c_len = np.linalg.norm(film_c_hat)
    film_c_unit = film_c_hat / film_c_len

    film_proj = film_cart @ film_c_unit
    film_bottom = float(film_proj.min())

    # Shift film: bottom of film goes to sub_top + gap, along substrate's c
    shift = (sub_top + gap - film_bottom) * sub_c_unit
    film_cart_shifted = film_cart + shift

    # Compute new c length: top of film + vacuum (or fixed target_z)
    film_proj_shifted = film_cart_shifted @ sub_c_unit
    total_top = float(film_proj_shifted.max())
    new_c_len = target_z if target_z > 0.0 else total_top + vacuum

    # Use sl_vectors as the interface lattice when available — they give the
    # correct cell shape (e.g. gamma≈90°) that ZSL matched.  The raw
    # supercell vectors can have a very different gamma.
    if substrate_sl_vectors is not None:
        a_vec = np.array(substrate_sl_vectors[0], dtype=float)
        b_vec = np.array(substrate_sl_vectors[1], dtype=float)
    else:
        a_vec = substrate.lattice.matrix[0]
        b_vec = substrate.lattice.matrix[1]
    new_c_vec = sub_c_unit * new_c_len
    new_lattice = PmgLattice([a_vec, b_vec, new_c_vec])

    # Merge atoms and wrap to [0,1).
    all_cart = np.vstack([sub_cart, film_cart_shifted])
    all_species = sub_species + film_species

    interface = Structure(
        new_lattice, all_species, all_cart, coords_are_cartesian=True
    )
    frac_wrapped = interface.frac_coords % 1.0
    return Structure(new_lattice, all_species, frac_wrapped)


def search_matches_slab(
    substrate_slab: Structure,
    film_slab: Structure,
    max_area: float = 400.0,
    max_area_ratio_tol: float = 0.09,
    max_length_tol: float = 0.03,
    max_angle_tol: float = 0.01,
    max_results: int = 50,
) -> SearchResult:
    """Slab mode: match two pre-existing slabs by their in-plane lattice vectors.

    Strips vacuum from both slabs, then runs ZSLGenerator on the a,b vectors.
    No Miller indices or termination selection needed.
    """
    sub_stripped = _strip_vacuum(substrate_slab)
    film_stripped = _strip_vacuum(film_slab)

    # Extract 2D lattice vectors (a and b, as 3D vectors)
    sub_vecs = [sub_stripped.lattice.matrix[0].tolist(), sub_stripped.lattice.matrix[1].tolist()]
    film_vecs = [film_stripped.lattice.matrix[0].tolist(), film_stripped.lattice.matrix[1].tolist()]

    logger.info(
        "Slab mode: substrate=%s (%d atoms), film=%s (%d atoms), max_area=%.0f",
        sub_stripped.formula,
        len(sub_stripped),
        film_stripped.formula,
        len(film_stripped),
        max_area,
    )

    zslgen = ZSLGenerator(
        max_area_ratio_tol=max_area_ratio_tol,
        max_area=max_area,
        max_length_tol=max_length_tol,
        max_angle_tol=max_angle_tol,
    )

    n_sub_base = len(sub_stripped)
    n_film_base = len(film_stripped)

    matches: list[MatchCandidate] = []
    for idx, zsl_match in enumerate(zslgen(film_vecs, sub_vecs)):
        if idx >= max_results:
            break

        film_sl = [list(map(float, v)) for v in zsl_match.film_sl_vectors]
        sub_sl = [list(map(float, v)) for v in zsl_match.substrate_sl_vectors]
        film_t = [list(map(int, row)) for row in zsl_match.film_transformation]
        sub_t = [list(map(int, row)) for row in zsl_match.substrate_transformation]

        # Normalize a/b ordering to match original substrate convention
        sub_sl, film_sl = _align_sl_vectors(sub_sl, film_sl, sub_stripped.lattice.matrix[0])

        strain = _compute_strain_percent(film_sl, sub_sl)

        sub_det = abs(int(round(np.linalg.det(np.array(sub_t)))))
        film_det = abs(int(round(np.linalg.det(np.array(film_t)))))

        matches.append(
            MatchCandidate(
                match_id=idx,
                match_area=float(zsl_match.match_area),
                film_transformation=film_t,
                substrate_transformation=sub_t,
                film_sl_vectors=film_sl,
                substrate_sl_vectors=sub_sl,
                strain=round(strain, 4),
                n_atoms_substrate=n_sub_base * max(sub_det, 1),
                n_atoms_film=n_film_base * max(film_det, 1),
            )
        )

    matches.sort(key=lambda m: (m.match_area, m.strain))

    logger.info("Slab mode: found %d matches", len(matches))

    return SearchResult(matches=matches, terminations=[])


def build_interface_slab(
    substrate_slab: Structure,
    film_slab: Structure,
    match_index: int = 0,
    gap: float = 2.0,
    vacuum: float = 20.0,
    twist_angle: float = 0.0,
    max_area: float = 400.0,
    max_area_ratio_tol: float = 0.09,
    max_length_tol: float = 0.03,
    max_angle_tol: float = 0.01,
) -> dict:
    """Slab mode: build the heterostructure by applying supercell transformations and stacking."""
    sub_stripped = _strip_vacuum(substrate_slab)
    film_stripped = _strip_vacuum(film_slab)

    sub_vecs = [sub_stripped.lattice.matrix[0].tolist(), sub_stripped.lattice.matrix[1].tolist()]
    film_vecs = [film_stripped.lattice.matrix[0].tolist(), film_stripped.lattice.matrix[1].tolist()]

    zslgen = ZSLGenerator(
        max_area_ratio_tol=max_area_ratio_tol,
        max_area=max_area,
        max_length_tol=max_length_tol,
        max_angle_tol=max_angle_tol,
    )

    zsl_matches = list(zslgen(film_vecs, sub_vecs))

    if match_index >= len(zsl_matches):
        raise ValueError(
            f"Match index {match_index} out of range (have {len(zsl_matches)} matches)."
        )

    selected = zsl_matches[match_index]

    logger.info(
        "Slab build: match_idx=%d, area=%.1f, gap=%.1f, vacuum=%.1f",
        match_index,
        selected.match_area,
        gap,
        vacuum,
    )

    # Build supercells
    sub_super = _make_supercell_2d(sub_stripped, selected.substrate_transformation)
    film_super = _make_supercell_2d(film_stripped, selected.film_transformation)

    # Pass ZSL sl_vectors so _stack_slabs applies a Cartesian deformation
    # gradient instead of going through fractional coordinates.  The raw
    # supercell basis (T @ vecs) can differ drastically in angle from the
    # partner lattice; the sl_vectors are what ZSL actually matched.
    film_sl = [list(map(float, v)) for v in selected.film_sl_vectors]
    sub_sl = [list(map(float, v)) for v in selected.substrate_sl_vectors]

    n_sub = len(sub_super)
    n_film = len(film_super)

    # Stack
    interface = _stack_slabs(
        sub_super, film_super, gap=gap, vacuum=vacuum, twist_angle=twist_angle,
        film_sl_vectors=film_sl, substrate_sl_vectors=sub_sl,
    )

    match_area = float(
        np.linalg.norm(np.cross(interface.lattice.matrix[0], interface.lattice.matrix[1]))
    )

    strain = _compute_strain_percent(
        [list(map(float, v)) for v in selected.film_sl_vectors],
        [list(map(float, v)) for v in selected.substrate_sl_vectors],
    )

    return {
        "structure": interface,
        "n_atoms": len(interface),
        "n_atoms_substrate": n_sub,
        "n_atoms_film": n_film,
        "match_area": round(match_area, 2),
        "strain": round(strain, 4),
    }


def _get_surface_sites_cart(
    structure: Structure, tol: float = 0.5
) -> list[tuple[float, float, str]]:
    """Extract unique surface atom xy positions (top-most layer) in Cartesian.

    Returns list of (x, y, species_label) for the top z-layer,
    deduplicated by Cartesian proximity (< 0.2 Å).
    """
    c_hat = structure.lattice.matrix[2]
    c_unit = c_hat / np.linalg.norm(c_hat)
    projections = structure.cart_coords @ c_unit
    z_max = float(projections.max())

    # Collect atoms in the top layer (within tol of z_max)
    surface: list[tuple[float, float, str]] = []
    for i, site in enumerate(structure):
        if abs(projections[i] - z_max) < tol:
            x, y = site.coords[0], site.coords[1]
            surface.append((x, y, str(site.specie)))

    # Deduplicate by Cartesian proximity (< 0.2 Å)
    unique: list[tuple[float, float, str]] = []
    for x, y, sp in surface:
        is_dup = False
        for ux, uy, _ in unique:
            if abs(x - ux) < 0.2 and abs(y - uy) < 0.2:
                is_dup = True
                break
        if not is_dup:
            unique.append((x, y, sp))

    return unique


def build_registry_candidates(
    substrate_slab: Structure,
    film_slab: Structure,
    match_index: int = 0,
    n_shift: int = 0,
    gap: float = 2.0,
    vacuum: float = 20.0,
    fmt: str = "cif",
    max_area: float = 400.0,
    max_area_ratio_tol: float = 0.09,
    max_length_tol: float = 0.03,
    max_angle_tol: float = 0.01,
    step_angstrom: float = 0.0,
    target_z: float = 0.0,
) -> list[dict]:
    """Generate registry candidates for a selected ZSL match.

    Priority order for grid mode:
      - step_angstrom > 0  →  regular grid with that XY step size in Å along
                               each superlattice vector; last partial step discarded.
      - n_shift > 0        →  n_shift × n_shift uniform fractional grid.
      - n_shift == 0       →  surface-atom-based shifts (physically motivated).

    Returns list of dicts with keys:
      - structure, shift_a, shift_b, label, n_atoms, match_area, strain
    """
    sub_stripped = _strip_vacuum(substrate_slab)
    film_stripped = _strip_vacuum(film_slab)

    sub_vecs = [sub_stripped.lattice.matrix[0].tolist(), sub_stripped.lattice.matrix[1].tolist()]
    film_vecs = [film_stripped.lattice.matrix[0].tolist(), film_stripped.lattice.matrix[1].tolist()]

    zslgen = ZSLGenerator(
        max_area_ratio_tol=max_area_ratio_tol,
        max_area=max_area,
        max_length_tol=max_length_tol,
        max_angle_tol=max_angle_tol,
    )

    zsl_matches = list(zslgen(film_vecs, sub_vecs))
    if match_index >= len(zsl_matches):
        raise ValueError(
            f"Match index {match_index} out of range (have {len(zsl_matches)} matches)."
        )

    selected = zsl_matches[match_index]

    sub_super = _make_supercell_2d(sub_stripped, selected.substrate_transformation)
    film_super = _make_supercell_2d(film_stripped, selected.film_transformation)

    film_sl = [list(map(float, v)) for v in selected.film_sl_vectors]
    sub_sl = [list(map(float, v)) for v in selected.substrate_sl_vectors]

    # Normalize a/b ordering to match original substrate convention
    sub_sl, film_sl = _align_sl_vectors(sub_sl, film_sl, sub_stripped.lattice.matrix[0])

    strain = _compute_strain_percent(film_sl, sub_sl)

    # Determine shift grid.
    # All shifts are fractional (fa, fb) in the interface a,b basis
    # (substrate sl_vectors when available, else raw substrate vectors).
    if step_angstrom > 0.0:
        # Step-size grid: step every `step_angstrom` Å along each sl_vector.
        a_len = float(np.linalg.norm(np.array(sub_sl[0], dtype=float)))
        b_len = float(np.linalg.norm(np.array(sub_sl[1], dtype=float)))
        n_a = max(1, int(a_len / step_angstrom))
        n_b = max(1, int(b_len / step_angstrom))
        shifts = [
            (
                i * step_angstrom / a_len,
                j * step_angstrom / b_len,
                f"s{i * step_angstrom:.2f}_{j * step_angstrom:.2f}",
            )
            for i in range(n_a)
            for j in range(n_b)
        ]
        logger.info(
            "Step-size registry: step=%.3f Å → %d×%d=%d candidates "
            "(a=%.2f Å, b=%.2f Å)",
            step_angstrom, n_a, n_b, n_a * n_b, a_len, b_len,
        )
    elif n_shift > 0:
        # Uniform grid
        shifts = [
            (i / n_shift, j / n_shift, f"s{i / n_shift:.2f}_{j / n_shift:.2f}")
            for i in range(n_shift)
            for j in range(n_shift)
        ]
    else:
        # Surface-atom-based shifts: align film ref atom over each
        # substrate surface site.  All in Cartesian, then convert to
        # fractional in the interface lattice (sl_vectors).
        D = _compute_deformation_2d(film_sl, sub_sl)
        film_ref_cart = film_super.cart_coords[0][:2].copy()
        film_ref_cart[:] = D @ film_ref_cart  # deform film ref to sub basis

        surface_sites = _get_surface_sites_cart(sub_super)

        # Interface lattice vectors (2D) for Cartesian → fractional
        a_sl = np.array(sub_sl[0][:2], dtype=float)
        b_sl = np.array(sub_sl[1][:2], dtype=float)
        M_inv = np.linalg.inv(np.array([a_sl, b_sl]).T)  # 2×2

        raw_shifts = []
        for sx, sy, sp in surface_sites:
            delta_cart = np.array([sx, sy]) - film_ref_cart
            fa, fb = M_inv @ delta_cart
            # Normalize to [0, 1)
            fa = float(fa % 1.0)
            fb = float(fb % 1.0)
            raw_shifts.append((fa, fb, sp))

        # Deduplicate shifts that map to the same position after wrapping.
        # Include (0, 0) as the first entry (no-shift baseline).
        shifts: list[tuple[float, float, str]] = [(0.0, 0.0, "baseline")]
        for fa, fb, sp in raw_shifts:
            is_dup = False
            for ea, eb, _ in shifts:
                da = min(abs(fa - ea), 1 - abs(fa - ea))
                db = min(abs(fb - eb), 1 - abs(fb - eb))
                if da < 0.02 and db < 0.02:
                    is_dup = True
                    break
            if not is_dup:
                label = f"{sp}_{fa:.3f}_{fb:.3f}"
                shifts.append((fa, fb, label))

        logger.info(
            "Surface-based registry: %d unique shifts (from %d surface sites)",
            len(shifts), len(raw_shifts),
        )

    candidates: list[dict] = []
    for fa, fb, label in shifts:
        interface = _stack_slabs(
            sub_super, film_super, gap=gap, vacuum=vacuum,
            film_sl_vectors=film_sl, substrate_sl_vectors=sub_sl,
            xy_shift=(fa, fb), target_z=target_z,
        )

        match_area = float(
            np.linalg.norm(np.cross(
                interface.lattice.matrix[0], interface.lattice.matrix[1]
            ))
        )

        candidates.append({
            "structure": interface,
            "shift_a": round(fa, 4),
            "shift_b": round(fb, 4),
            "label": label,
            "n_atoms": len(interface),
            "match_area": round(match_area, 2),
            "strain": round(strain, 4),
        })

    logger.info(
        "Generated %d registry candidates", len(candidates)
    )

    return candidates


def build_interface_manual(
    substrate_slab: Structure,
    film_slab: Structure,
    substrate_transform: list[list[int]],
    film_transform: list[list[int]],
    gap: float = 2.0,
    vacuum: float = 20.0,
    twist_angle: float = 0.0,
) -> dict:
    """Manual slab mode: apply user-specified 2×2 transforms and stack directly.

    No ZSL search — the user provides exact integer transformation matrices
    for both substrate and film supercells.
    """
    sub_stripped = _strip_vacuum(substrate_slab)
    film_stripped = _strip_vacuum(film_slab)

    sub_super = _make_supercell_2d(sub_stripped, np.array(substrate_transform))
    film_super = _make_supercell_2d(film_stripped, np.array(film_transform))

    n_sub = len(sub_super)
    n_film = len(film_super)

    logger.info(
        "Manual slab build: sub_T=%s film_T=%s gap=%.1f vacuum=%.1f twist=%.1f",
        substrate_transform,
        film_transform,
        gap,
        vacuum,
        twist_angle,
    )

    interface = _stack_slabs(sub_super, film_super, gap=gap, vacuum=vacuum, twist_angle=twist_angle)

    match_area = float(
        np.linalg.norm(np.cross(interface.lattice.matrix[0], interface.lattice.matrix[1]))
    )

    # Compute strain from the superlattice vectors
    sub_sl = [sub_super.lattice.matrix[0].tolist(), sub_super.lattice.matrix[1].tolist()]
    film_sl = [film_super.lattice.matrix[0].tolist(), film_super.lattice.matrix[1].tolist()]
    strain = _compute_strain_percent(film_sl, sub_sl)

    return {
        "structure": interface,
        "n_atoms": len(interface),
        "n_atoms_substrate": n_sub,
        "n_atoms_film": n_film,
        "match_area": round(match_area, 2),
        "strain": round(strain, 4),
    }


def search_matches(
    substrate_structure: Structure,
    film_structure: Structure,
    substrate_miller: tuple[int, int, int] = (0, 0, 1),
    film_miller: tuple[int, int, int] = (0, 0, 1),
    max_area: float = 400.0,
    max_area_ratio_tol: float = 0.09,
    max_length_tol: float = 0.03,
    max_angle_tol: float = 0.01,
    max_results: int = 50,
) -> SearchResult:
    """Phase 1: Find lattice-matched superlattices and enumerate terminations.

    Args:
        substrate_structure: Bulk substrate crystal structure.
        film_structure: Bulk film crystal structure.
        substrate_miller: Miller index for substrate surface.
        film_miller: Miller index for film surface.
        max_area: Maximum superlattice area (Å²).
        max_area_ratio_tol: Area ratio tolerance.
        max_length_tol: Length tolerance for vector matching.
        max_angle_tol: Angle tolerance for vector matching.
        max_results: Maximum matches to return.

    Returns:
        SearchResult with matches and termination pairs.
    """
    zslgen = ZSLGenerator(
        max_area_ratio_tol=max_area_ratio_tol,
        max_area=max_area,
        max_length_tol=max_length_tol,
        max_angle_tol=max_angle_tol,
    )

    logger.info(
        "Building CoherentInterfaceBuilder: substrate=%s film=%s "
        "sub_miller=%s film_miller=%s max_area=%.0f",
        substrate_structure.formula,
        film_structure.formula,
        substrate_miller,
        film_miller,
        max_area,
    )

    cib = CoherentInterfaceBuilder(
        substrate_structure=substrate_structure,
        film_structure=film_structure,
        substrate_miller=substrate_miller,
        film_miller=film_miller,
        zslgen=zslgen,
    )

    # Collect matches
    n_sub_base = len(substrate_structure)
    n_film_base = len(film_structure)

    matches: list[MatchCandidate] = []
    for idx, zsl_match in enumerate(cib.zsl_matches):
        if idx >= max_results:
            break

        film_sl = [list(map(float, v)) for v in zsl_match.film_sl_vectors]
        sub_sl = [list(map(float, v)) for v in zsl_match.substrate_sl_vectors]
        film_t = [list(map(int, row)) for row in zsl_match.film_transformation]
        sub_t = [list(map(int, row)) for row in zsl_match.substrate_transformation]

        strain = _compute_strain_percent(film_sl, sub_sl)

        # Approximate atom counts (bulk primitive cell × supercell factor)
        sub_det = abs(int(round(np.linalg.det(np.array(sub_t)))))
        film_det = abs(int(round(np.linalg.det(np.array(film_t)))))

        matches.append(
            MatchCandidate(
                match_id=idx,
                match_area=float(zsl_match.match_area),
                film_transformation=film_t,
                substrate_transformation=sub_t,
                film_sl_vectors=film_sl,
                substrate_sl_vectors=sub_sl,
                strain=round(strain, 4),
                n_atoms_substrate=n_sub_base * max(sub_det, 1),
                n_atoms_film=n_film_base * max(film_det, 1),
            )
        )

    # Sort by area (smaller = simpler)
    matches.sort(key=lambda m: (m.match_area, m.strain))

    # Collect termination pairs
    terminations: list[TerminationPair] = []
    for film_term, sub_term in cib.terminations:
        terminations.append(
            TerminationPair(
                film_termination=str(film_term),
                substrate_termination=str(sub_term),
            )
        )

    logger.info(
        "Found %d matches, %d termination pairs", len(matches), len(terminations)
    )

    return SearchResult(matches=matches, terminations=terminations)


def build_interface(
    substrate_structure: Structure,
    film_structure: Structure,
    substrate_miller: tuple[int, int, int] = (0, 0, 1),
    film_miller: tuple[int, int, int] = (0, 0, 1),
    match_index: int = 0,
    termination_index: int = 0,
    gap: float = 2.0,
    vacuum: float = 20.0,
    substrate_thickness: int = 3,
    film_thickness: int = 3,
    twist_angle: float = 0.0,
    max_area: float = 400.0,
    max_area_ratio_tol: float = 0.09,
    max_length_tol: float = 0.03,
    max_angle_tol: float = 0.01,
) -> dict:
    """Phase 2: Build a heterostructure interface for a selected match.

    Args:
        substrate_structure: Bulk substrate crystal structure.
        film_structure: Bulk film crystal structure.
        substrate_miller: Miller index for substrate surface.
        film_miller: Miller index for film surface.
        match_index: Index of the selected ZSL match.
        termination_index: Index of the selected termination pair.
        gap: Gap between film and substrate (Å).
        vacuum: Vacuum above film (Å).
        substrate_thickness: Substrate thickness in layers.
        film_thickness: Film thickness in layers.
        max_area, max_area_ratio_tol, max_length_tol, max_angle_tol: ZSL params.

    Returns:
        Dict with keys: structure (pymatgen Structure), n_atoms, n_atoms_substrate,
        n_atoms_film, match_area, strain.
    """
    zslgen = ZSLGenerator(
        max_area_ratio_tol=max_area_ratio_tol,
        max_area=max_area,
        max_length_tol=max_length_tol,
        max_angle_tol=max_angle_tol,
    )

    cib = CoherentInterfaceBuilder(
        substrate_structure=substrate_structure,
        film_structure=film_structure,
        substrate_miller=substrate_miller,
        film_miller=film_miller,
        zslgen=zslgen,
    )

    if len(cib.terminations) == 0:
        raise ValueError("No terminations found for the given structures and Miller indices.")

    if termination_index >= len(cib.terminations):
        raise ValueError(
            f"Termination index {termination_index} out of range "
            f"(have {len(cib.terminations)} terminations)."
        )

    termination = cib.terminations[termination_index]

    logger.info(
        "Building interface: match_idx=%d, termination=%s, "
        "gap=%.1f, vacuum=%.1f, sub_thick=%d, film_thick=%d",
        match_index,
        termination,
        gap,
        vacuum,
        substrate_thickness,
        film_thickness,
    )

    # get_interfaces yields one Interface per ZSL match
    interfaces = list(
        cib.get_interfaces(
            termination=termination,
            gap=gap,
            vacuum_over_film=vacuum,
            film_thickness=film_thickness,
            substrate_thickness=substrate_thickness,
            in_layers=True,
        )
    )

    if match_index >= len(interfaces):
        raise ValueError(
            f"Match index {match_index} out of range (have {len(interfaces)} interfaces)."
        )

    interface = interfaces[match_index]

    # Apply twist angle to film atoms if nonzero
    if abs(twist_angle) > 1e-10:
        theta = np.radians(twist_angle)
        cos_t, sin_t = np.cos(theta), np.sin(theta)

        # Identify film atom indices
        film_indices = []
        for i, site in enumerate(interface):
            if hasattr(site, "properties") and site.properties.get("interface_label") == "film":
                film_indices.append(i)

        if film_indices:
            cart = interface.cart_coords.copy()
            film_xy = cart[film_indices, :2]
            centroid = film_xy.mean(axis=0)
            rel = film_xy - centroid
            rotated = np.column_stack([
                rel[:, 0] * cos_t - rel[:, 1] * sin_t,
                rel[:, 0] * sin_t + rel[:, 1] * cos_t,
            ])
            cart[film_indices, :2] = rotated + centroid

            interface = Structure(
                interface.lattice,
                interface.species,
                cart,
                coords_are_cartesian=True,
                site_properties=interface.site_properties,
            )

    # Count film vs substrate atoms from site properties
    n_atoms = len(interface)
    n_film = 0
    n_substrate = 0
    for site in interface:
        if hasattr(site, "properties") and "interface_label" in site.properties:
            if site.properties["interface_label"] == "film":
                n_film += 1
            else:
                n_substrate += 1
        else:
            n_substrate += 1

    if n_film == 0 and n_substrate == n_atoms:
        # Fallback: pymatgen may label differently
        n_substrate = n_atoms // 2
        n_film = n_atoms - n_substrate

    match_area = float(interface.lattice.a * interface.lattice.b * np.sin(
        np.radians(interface.lattice.gamma)
    ))

    # Compute strain from the selected ZSL match
    zsl_matches = list(cib.zsl_matches)
    strain = 0.0
    if match_index < len(zsl_matches):
        m = zsl_matches[match_index]
        strain = _compute_strain_percent(
            [list(map(float, v)) for v in m.film_sl_vectors],
            [list(map(float, v)) for v in m.substrate_sl_vectors],
        )

    return {
        "structure": _wrap_inplane_fracs(interface),
        "n_atoms": n_atoms,
        "n_atoms_substrate": n_substrate,
        "n_atoms_film": n_film,
        "match_area": round(match_area, 2),
        "strain": round(strain, 4),
    }


# ---------------------------------------------------------------------------
# Intermat mode
# ---------------------------------------------------------------------------

def _pmg_to_jarvis(structure: Structure):
    """Convert a pymatgen Structure to a JARVIS Atoms object."""
    from jarvis.core.atoms import Atoms as JarvisAtoms

    return JarvisAtoms(
        lattice_mat=structure.lattice.matrix.tolist(),
        elements=[str(sp) for sp in structure.species],
        coords=structure.frac_coords.tolist(),
        cartesian=False,
    )


def _jarvis_dict_to_pmg(atoms_dict: dict) -> Structure:
    """Convert a serialized JARVIS Atoms dict to a pymatgen Structure."""
    return Structure(
        PmgLattice(atoms_dict["lattice_mat"]),
        atoms_dict["elements"],
        atoms_dict["coords"],
        coords_are_cartesian=atoms_dict.get("cartesian", False),
    )


def build_interface_intermat(
    substrate_structure: Structure,
    film_structure: Structure,
    substrate_miller: tuple[int, int, int] = (0, 0, 1),
    film_miller: tuple[int, int, int] = (0, 0, 1),
    substrate_thickness: float = 16.0,
    film_thickness: float = 16.0,
    separation: float = 2.5,
    vacuum: float = 8.0,
    max_area: float = 300.0,
    ltol: float = 0.08,
    atol: float = 1.0,
    max_area_ratio_tol: float = 1.0,
    apply_strain: bool = False,
    disp_intvl: float = 0.0,
) -> dict:
    """Build a heterostructure using the intermat/JARVIS pipeline.

    Uses InterfaceCombi with JARVIS ZSL (more permissive defaults than pymatgen).
    Optionally scans in-plane displacements to find optimal registry.

    Args:
        substrate_structure: Bulk substrate (pymatgen Structure).
        film_structure: Bulk film (pymatgen Structure).
        substrate_miller / film_miller: Surface orientations.
        substrate_thickness / film_thickness: Slab thickness in Å.
        separation: Gap between slabs (Å).
        vacuum: Vacuum padding (Å).
        max_area: Max supercell area for ZSL (Å²).
        ltol: Length tolerance for ZSL matching.
        atol: Angle tolerance for ZSL matching (degrees).
        max_area_ratio_tol: Area ratio tolerance.
        apply_strain: Whether to strain the film to match the substrate lattice.
        disp_intvl: Displacement scan interval (0 = no scan, e.g. 0.25 = 5×5 grid).

    Returns:
        Dict with structure, atom counts, mismatch info, and match details.
    """
    from intermat.generate import InterfaceCombi

    sub_jarvis = _pmg_to_jarvis(substrate_structure)
    film_jarvis = _pmg_to_jarvis(film_structure)

    logger.info(
        "Intermat build: sub=%s film=%s sub_miller=%s film_miller=%s "
        "max_area=%.0f ltol=%.3f atol=%.1f disp_intvl=%.2f",
        substrate_structure.formula,
        film_structure.formula,
        substrate_miller,
        film_miller,
        max_area,
        ltol,
        atol,
        disp_intvl,
    )

    combo = InterfaceCombi(
        film_mats=[film_jarvis],
        subs_mats=[sub_jarvis],
        film_indices=[list(film_miller)],
        subs_indices=[list(substrate_miller)],
        film_thicknesses=[film_thickness],
        subs_thicknesses=[substrate_thickness],
        seperations=[separation],
        vacuum_interface=vacuum,
        max_area=max_area,
        max_area_ratio_tol=max_area_ratio_tol,
        ltol=ltol,
        atol=atol,
        apply_strain=apply_strain,
        lowest_mismatch=True,
        from_conventional_structure_film=True,
        from_conventional_structure_subs=True,
        disp_intvl=disp_intvl,
        dataset=[None],
    )

    results = combo.generate()

    if not results:
        raise ValueError("Intermat found no matching interfaces.")

    res = results[0]

    # Convert interface to pymatgen
    iface_dict = res.get("generated_interface") or res.get("interface")
    if iface_dict is None:
        raise ValueError("Intermat returned no interface structure.")

    interface = _jarvis_dict_to_pmg(iface_dict)

    # Count film vs substrate from props
    props = iface_dict.get("props", [])
    n_film = sum(1 for p in props if p == "top")
    n_substrate = sum(1 for p in props if p == "bottom")
    if n_film == 0 and n_substrate == 0:
        n_substrate = len(interface) // 2
        n_film = len(interface) - n_substrate

    # Mismatch info
    mismatch_u = float(res.get("mismatch_u", 0.0))
    mismatch_v = float(res.get("mismatch_v", 0.0))
    mismatch_angle = float(res.get("mismatch_angle", 0.0))
    area_sub = float(res.get("area1", 0.0))
    area_film = float(res.get("area2", 0.0))

    # Von Mises-like scalar strain from the u,v mismatch
    eu, ev = mismatch_u, mismatch_v
    strain_pct = float(np.sqrt(eu**2 + ev**2 - eu * ev) * 100.0)

    match_area = float(
        np.linalg.norm(np.cross(interface.lattice.matrix[0], interface.lattice.matrix[1]))
    )

    logger.info(
        "Intermat result: %d atoms, mismatch_u=%.4f mismatch_v=%.4f mismatch_angle=%.2f°",
        len(interface),
        mismatch_u,
        mismatch_v,
        mismatch_angle,
    )

    return {
        "structure": _wrap_inplane_fracs(interface),
        "n_atoms": len(interface),
        "n_atoms_substrate": n_substrate,
        "n_atoms_film": n_film,
        "match_area": round(match_area, 2),
        "strain": round(strain_pct, 4),
        "mismatch_u": round(mismatch_u * 100, 4),
        "mismatch_v": round(mismatch_v * 100, 4),
        "mismatch_angle": round(mismatch_angle, 4),
        "area_substrate": round(area_sub, 2),
        "area_film": round(area_film, 2),
    }


# ---------------------------------------------------------------------------
# Lateral (in-plane) heterojunction
# ---------------------------------------------------------------------------


@dataclass
class LateralMatchCandidate:
    """A 1D edge-match candidate for lateral heterojunction."""

    match_id: int
    n1: int  # supercell multiplier for slab A along interface edge
    n2: int  # supercell multiplier for slab B along interface edge
    edge_length_A: float  # |n1 * edge_A| (Å)
    edge_length_B: float  # |n2 * edge_B| (Å)
    strain_percent: float  # 1D mismatch percentage
    n_atoms_A: int
    n_atoms_B: int


def search_lateral_matches(
    slab_A: Structure,
    slab_B: Structure,
    interface_axis: int = 0,
    max_length: float = 100.0,
    max_strain: float = 5.0,
    max_results: int = 50,
) -> list[LateralMatchCandidate]:
    """Find 1D edge-matched supercell pairs for lateral heterojunction.

    Args:
        slab_A: First slab (2D material).
        slab_B: Second slab (2D material).
        interface_axis: 0 = match along a-vector, 1 = match along b-vector.
        max_length: Maximum matched edge length (Å).
        max_strain: Maximum 1D strain tolerance (%).
        max_results: Maximum number of matches to return.

    Returns:
        List of LateralMatchCandidate sorted by (total atoms, strain).
    """
    stripped_A = _strip_vacuum(slab_A)
    stripped_B = _strip_vacuum(slab_B)

    len_A = float(np.linalg.norm(stripped_A.lattice.matrix[interface_axis]))
    len_B = float(np.linalg.norm(stripped_B.lattice.matrix[interface_axis]))

    n_atoms_A_base = len(stripped_A)
    n_atoms_B_base = len(stripped_B)

    # Perpendicular axis for atom count calculation
    perp_axis = 1 - interface_axis

    n_max_A = max(1, int(max_length / len_A))
    n_max_B = max(1, int(max_length / len_B))

    logger.info(
        "Lateral search: A=%s (%.3f Å), B=%s (%.3f Å), axis=%d, max_n=(%d,%d)",
        stripped_A.formula, len_A, stripped_B.formula, len_B,
        interface_axis, n_max_A, n_max_B,
    )

    matches: list[LateralMatchCandidate] = []
    match_id = 0

    for n1 in range(1, n_max_A + 1):
        L_A = n1 * len_A
        if L_A > max_length:
            break
        for n2 in range(1, n_max_B + 1):
            L_B = n2 * len_B
            if L_B > max_length:
                break

            avg = (L_A + L_B) / 2.0
            strain = abs(L_A - L_B) / avg * 100.0

            if strain > max_strain:
                continue

            matches.append(
                LateralMatchCandidate(
                    match_id=match_id,
                    n1=n1,
                    n2=n2,
                    edge_length_A=round(L_A, 4),
                    edge_length_B=round(L_B, 4),
                    strain_percent=round(strain, 4),
                    n_atoms_A=n_atoms_A_base * n1,
                    n_atoms_B=n_atoms_B_base * n2,
                )
            )
            match_id += 1

    # Sort by total atoms first, then strain
    matches.sort(key=lambda m: (m.n_atoms_A + m.n_atoms_B, m.strain_percent))

    logger.info("Lateral search: found %d matches (before limit)", len(matches))

    return matches[:max_results]


def _join_lateral(
    slab_A: Structure,
    slab_B: Structure,
    n1: int,
    n2: int,
    interface_axis: int = 0,
    width_A: int = 1,
    width_B: int = 1,
    buffer: float = 0.0,
    vacuum: float = 20.0,
) -> Structure:
    """Join two slabs side-by-side to form a lateral heterojunction.

    Args:
        slab_A: First slab.
        slab_B: Second slab.
        n1: Supercell multiplier for slab_A along interface axis.
        n2: Supercell multiplier for slab_B along interface axis.
        interface_axis: 0 = a, 1 = b.
        width_A: Repetitions of slab_A along perpendicular axis.
        width_B: Repetitions of slab_B along perpendicular axis.
        buffer: Gap at the lateral interface (Å).
        vacuum: Vacuum above/below the 2D plane (Å).

    Returns:
        Combined Structure with lateral heterojunction.
    """
    stripped_A = _strip_vacuum(slab_A)
    stripped_B = _strip_vacuum(slab_B)

    perp_axis = 1 - interface_axis

    # Build supercell transformation matrices
    # For slab_A: n1 along interface, width_A along perpendicular
    T_A = np.eye(3, dtype=int)
    T_A[interface_axis, interface_axis] = n1
    T_A[perp_axis, perp_axis] = width_A
    sc_A = stripped_A * T_A

    T_B = np.eye(3, dtype=int)
    T_B[interface_axis, interface_axis] = n2
    T_B[perp_axis, perp_axis] = width_B
    sc_B = stripped_B * T_B

    # Strain slab_B's interface edge to match slab_A
    mat_A = sc_A.lattice.matrix.copy()
    mat_B = sc_B.lattice.matrix.copy()

    # Target interface edge length from slab_A
    target_edge = mat_A[interface_axis].copy()

    # Compute strain ratio for B's interface axis
    len_target = np.linalg.norm(target_edge)
    len_B_edge = np.linalg.norm(mat_B[interface_axis])
    strain_ratio = len_target / len_B_edge if len_B_edge > 1e-10 else 1.0

    # Apply strain to B: scale its interface axis vector
    strained_B_mat = mat_B.copy()
    strained_B_mat[interface_axis] = target_edge

    # Convert B's atoms to Cartesian using strained lattice
    strained_B_lattice = PmgLattice(strained_B_mat)
    B_cart = strained_B_lattice.get_cartesian_coords(sc_B.frac_coords)

    # Get A's Cartesian coordinates
    A_cart = sc_A.cart_coords.copy()

    # Compute perpendicular extent of slab_A
    perp_vec_A = mat_A[perp_axis]
    perp_len_A = np.linalg.norm(perp_vec_A)
    perp_unit = perp_vec_A / perp_len_A if perp_len_A > 1e-10 else np.array([0, 1, 0])

    # Shift B atoms: place them after A along the perpendicular direction
    shift_B = perp_vec_A + buffer * perp_unit
    B_cart_shifted = B_cart + shift_B

    # Combined perpendicular vector
    perp_vec_B = strained_B_mat[perp_axis]
    perp_len_B = np.linalg.norm(perp_vec_B)
    combined_perp = perp_vec_A + buffer * perp_unit + perp_vec_B

    # c-axis: take max thickness + vacuum
    c_A = np.linalg.norm(mat_A[2])
    c_B = np.linalg.norm(strained_B_mat[2])
    c_hat_A = mat_A[2] / c_A if c_A > 1e-10 else np.array([0, 0, 1])
    new_c_len = max(c_A, c_B) + vacuum
    new_c_vec = c_hat_A * new_c_len

    # Build new lattice
    new_mat = np.zeros((3, 3))
    new_mat[interface_axis] = target_edge
    new_mat[perp_axis] = combined_perp
    new_mat[2] = new_c_vec
    new_lattice = PmgLattice(new_mat)

    # Combine all atoms
    all_cart = np.vstack([A_cart, B_cart_shifted])
    all_species = list(sc_A.species) + list(sc_B.species)

    return Structure(
        new_lattice,
        all_species,
        all_cart,
        coords_are_cartesian=True,
    )


def build_lateral_interface(
    slab_A: Structure,
    slab_B: Structure,
    match_index: int = 0,
    interface_axis: int = 0,
    width_A: int = 1,
    width_B: int = 1,
    buffer: float = 0.0,
    vacuum: float = 20.0,
    max_length: float = 100.0,
    max_strain: float = 5.0,
) -> dict:
    """Build a lateral heterojunction from two slabs.

    Searches for matching edge lengths, selects the match at match_index,
    and joins the slabs side-by-side.

    Returns:
        Dict with structure, atom counts, interface_length, and strain.
    """
    matches = search_lateral_matches(
        slab_A, slab_B,
        interface_axis=interface_axis,
        max_length=max_length,
        max_strain=max_strain,
        max_results=max(match_index + 1, 50),
    )

    if not matches:
        raise ValueError("No lateral matches found with given tolerances.")

    if match_index >= len(matches):
        raise ValueError(
            f"match_index={match_index} out of range (found {len(matches)} matches)"
        )

    match = matches[match_index]

    interface = _join_lateral(
        slab_A, slab_B,
        n1=match.n1,
        n2=match.n2,
        interface_axis=interface_axis,
        width_A=width_A,
        width_B=width_B,
        buffer=buffer,
        vacuum=vacuum,
    )

    # Interface length = matched edge length (average of A and B)
    interface_length = (match.edge_length_A + match.edge_length_B) / 2.0

    logger.info(
        "Lateral build: %d atoms (%d A + %d B), interface=%.2f Å, strain=%.2f%%",
        len(interface), match.n_atoms_A * width_A, match.n_atoms_B * width_B,
        interface_length, match.strain_percent,
    )

    return {
        "structure": interface,
        "n_atoms": len(interface),
        "n_atoms_A": match.n_atoms_A * width_A,
        "n_atoms_B": match.n_atoms_B * width_B,
        "interface_length": round(interface_length, 4),
        "strain": match.strain_percent,
    }


# =====================================================================
# Grid Scan mode — symmetry-reduced lateral shift exhaustive search
# =====================================================================


@dataclass
class GridScanEntry:
    """A single grid scan structure with its shift metadata."""

    shift_frac: tuple[float, float]
    shift_cart: tuple[float, float, float]
    structure: Structure
    n_atoms: int
    n_atoms_substrate: int
    n_atoms_film: int


def get_2d_symmetry_operations(
    slab: Structure,
    symprec: float = 0.1,
) -> list[tuple[np.ndarray, np.ndarray]]:
    """Extract 2D in-plane symmetry operations from a slab structure.

    Uses pymatgen SpacegroupAnalyzer to find all symmetry operations in
    fractional coordinates, then filters to those that act only in the
    a-b plane (no z mixing in rotation, no z translation).

    Returns:
        List of (rot_2x2, trans_2d) tuples in fractional coordinates.
    """
    from pymatgen.symmetry.analyzer import SpacegroupAnalyzer

    try:
        analyzer = SpacegroupAnalyzer(slab, symprec=symprec)
        sym_ops = analyzer.get_symmetry_operations()
    except Exception as e:
        logger.warning("Symmetry analysis failed (%s), using identity only", e)
        return [(np.eye(2), np.zeros(2))]

    ops_2d: list[tuple[np.ndarray, np.ndarray]] = []
    tol = 1e-4

    for op in sym_ops:
        rot = op.rotation_matrix
        trans = op.translation_vector

        # Check pure in-plane: rot[2,0], rot[2,1], rot[0,2], rot[1,2] ≈ 0
        # and rot[2,2] ≈ ±1, and trans[2] ≈ 0
        if (
            abs(rot[2, 0]) < tol
            and abs(rot[2, 1]) < tol
            and abs(rot[0, 2]) < tol
            and abs(rot[1, 2]) < tol
            and abs(abs(rot[2, 2]) - 1.0) < tol
            and abs(trans[2]) < tol
        ):
            rot_2d = rot[:2, :2].copy()
            trans_2d = trans[:2].copy()
            ops_2d.append((rot_2d, trans_2d))

    if not ops_2d:
        # Always at least identity
        ops_2d = [(np.eye(2), np.zeros(2))]

    logger.info(
        "2D symmetry analysis: %d in-plane ops from %d total (symprec=%.3f)",
        len(ops_2d), len(sym_ops), symprec,
    )
    return ops_2d


def get_irreducible_zone_extent(
    sym_ops_2d: list[tuple[np.ndarray, np.ndarray]],
) -> tuple[float, float]:
    """Determine the bounding box of the irreducible wedge in fractional coords.

    Uses a fine internal grid to find all irreducible (canonical) points,
    then returns the extent of the wedge as (fx_max, fy_max).

    Returns:
        (fx_max, fy_max) — the fractional extent of the irreducible zone.
    """
    # Use a fine internal grid to resolve the wedge boundary
    N = 120
    seen: set[tuple[int, int]] = set()

    for i in range(N):
        for j in range(N):
            fx, fy = i / N, j / N
            pt = np.array([fx, fy])
            canonical = (i, j)

            for rot, trans in sym_ops_2d:
                transformed = rot @ pt + trans
                ix = round((transformed[0] % 1.0) * N) % N
                iy = round((transformed[1] % 1.0) * N) % N
                if (ix, iy) < canonical:
                    canonical = (ix, iy)

            seen.add(canonical)

    if not seen:
        return (1.0, 1.0)

    fx_max = max(c[0] for c in seen) / N
    fy_max = max(c[1] for c in seen) / N

    # Add half a fine-grid step to include the boundary
    fx_max = min(fx_max + 0.5 / N, 1.0)
    fy_max = min(fy_max + 0.5 / N, 1.0)

    logger.info(
        "Irreducible zone extent: [0, %.3f] x [0, %.3f] (%.1f%% of unit cell, %d sym ops)",
        fx_max, fy_max, fx_max * fy_max * 100, len(sym_ops_2d),
    )
    return (fx_max, fy_max)


def get_irreducible_grid_points(
    sym_ops_2d: list[tuple[np.ndarray, np.ndarray]],
    n_grid_x: int = 6,
    n_grid_y: int = 6,
) -> tuple[list[tuple[float, float]], tuple[float, float]]:
    """Generate a uniform N×N grid within the irreducible zone.

    First determines the irreducible wedge extent via symmetry analysis,
    then places n_grid_x × n_grid_y points uniformly within that zone.
    Output count = n_grid_x × n_grid_y (no reduction — symmetry determines
    the search REGION, user controls the density).

    Returns:
        (points, zone_extent) where points is a list of (fx, fy) and
        zone_extent is (fx_max, fy_max).
    """
    fx_max, fy_max = get_irreducible_zone_extent(sym_ops_2d)

    points: list[tuple[float, float]] = []
    for i in range(n_grid_x):
        for j in range(n_grid_y):
            fx = (i / n_grid_x) * fx_max
            fy = (j / n_grid_y) * fy_max
            points.append((fx, fy))

    logger.info(
        "Grid scan: %d x %d = %d points in zone [0, %.3f] x [0, %.3f]",
        n_grid_x, n_grid_y, len(points), fx_max, fy_max,
    )
    return points, (fx_max, fy_max)


def generate_grid_scan_structures(
    heterostructure: Structure,
    n_atoms_substrate: int,
    irreducible_points: list[tuple[float, float]],
) -> list[GridScanEntry]:
    """Generate shifted variants of an already-built heterostructure.

    Takes the built heterostructure and shifts only the film atoms
    (indices >= n_atoms_substrate) in-plane for each irreducible point.
    No re-stacking — the lattice, gap, and vacuum are preserved as-is.

    Args:
        heterostructure: The already-built heterostructure (substrate + film).
        n_atoms_substrate: Number of substrate atoms (first N atoms).
        irreducible_points: List of (fx, fy) fractional shifts.

    Returns:
        List of GridScanEntry with shifted structures.
    """
    entries: list[GridScanEntry] = []
    n_total = len(heterostructure)
    n_film = n_total - n_atoms_substrate
    lattice = heterostructure.lattice
    a_vec = lattice.matrix[0]
    b_vec = lattice.matrix[1]

    for fx, fy in irreducible_points:
        try:
            # Compute Cartesian shift along substrate a,b vectors
            shift_cart = fx * a_vec + fy * b_vec

            # Copy all Cartesian coords; shift only film atoms in-plane
            cart = heterostructure.cart_coords.copy()
            cart[n_atoms_substrate:, 0] += shift_cart[0]
            cart[n_atoms_substrate:, 1] += shift_cart[1]
            # z component unchanged — preserve gap/vacuum exactly

            shifted = Structure(
                lattice,
                heterostructure.species,
                cart,
                coords_are_cartesian=True,
            )

            entries.append(GridScanEntry(
                shift_frac=(fx, fy),
                shift_cart=(float(shift_cart[0]), float(shift_cart[1]), float(shift_cart[2])),
                structure=shifted,
                n_atoms=n_total,
                n_atoms_substrate=n_atoms_substrate,
                n_atoms_film=n_film,
            ))
        except Exception as e:
            logger.warning("Grid scan shift (%.3f, %.3f) failed: %s", fx, fy, e)

    logger.info("Grid scan: built %d / %d structures", len(entries), len(irreducible_points))
    return entries
