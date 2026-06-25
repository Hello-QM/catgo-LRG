"""
Build operations router for structure manipulation workflow nodes.
Handles: defect generation, supercell, strain/deformation, doping, intercalation.
"""

import re
from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pymatgen.core import Structure as PMGStructure
from pydantic import BaseModel

router = APIRouter(prefix="/build", tags=["build"])


def _parse_structure(d: dict) -> "PMGStructure":
    """Parse a structure dict, accepting both full pymatgen format and simplified frontend format."""
    if "@module" in d and "@class" in d:
        return PMGStructure.from_dict(d)
    # Simplified format: build pymatgen Structure from lattice matrix + sites
    from pymatgen.core import Lattice

    lattice = Lattice(d["lattice"]["matrix"])
    species = []
    coords = []
    for site in d["sites"]:
        sp = site["species"][0]["element"]
        species.append(sp)
        if "abc" in site and site["abc"] is not None:
            coords.append(site["abc"])
        else:
            coords.append(site["xyz"])
    coord_type = "fractional" if d["sites"][0].get("abc") else "cartesian"
    if coord_type == "cartesian":
        return PMGStructure(lattice, species, coords, coords_are_cartesian=True)
    return PMGStructure(lattice, species, coords)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class StructureInput(BaseModel):
    """Input structure as pymatgen dict."""

    structure: dict  # pymatgen Structure.as_dict()


class DefectRequest(StructureInput):
    defect_type: str = "vacancy"  # vacancy, substitution, interstitial
    site_index: int = 0
    substitute_element: str = ""
    supercell: str = "2×2×2"


class SupercellRequest(StructureInput):
    scaling: str = "2×2×2"


class StrainRequest(StructureInput):
    strain_type: str = "uniaxial"  # uniaxial, biaxial, hydrostatic, shear
    axis: str = "c"
    magnitude: float = 0.02
    n_steps: int = 1


class DopingRequest(StructureInput):
    dopant: str = "N"
    host_element: str = "C"
    concentration: int = 1
    enumerate: bool = False
    target_indices: Optional[list[int]] = None  # Specific site indices to dope (overrides host_element + concentration)


class IntercalationRequest(StructureInput):
    species: str = "Li"
    position: str = "auto"  # auto, tetrahedral, octahedral, custom
    n_intercalants: int = 1


class SubstitutionGroupModel(BaseModel):
    """A group of sites that all get the same replacement element."""

    target_indices: list[int]
    replacement_elements: list[str]


class SubstitutionRequest(StructureInput):
    """Combinatorial substitution / doping request with multiple groups."""

    groups: list[SubstitutionGroupModel]
    max_structures: int = 500  # Safety cap


class RandomDopantModel(BaseModel):
    """A dopant element and how many sites it should occupy."""

    element: str
    count: int = 0


class RandomSubstitutionRequest(StructureInput):
    """Random concentration-based substitution.

    Picks a pool of candidate sites (by host element or explicit indices),
    then randomly assigns the requested number of each dopant to distinct
    sites. Generates up to ``n_samples`` independent random arrangements.
    """

    host_element: Optional[str] = None
    target_indices: Optional[list[int]] = None
    dopants: list[RandomDopantModel]
    n_samples: int = 10
    deduplicate: bool = True
    seed: Optional[int] = None
    max_structures: int = 500  # Safety cap


class BuildResult(BaseModel):
    structures: list[dict]  # List of pymatgen Structure.as_dict()
    labels: list[str]  # Description labels for each structure
    count: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def parse_scaling(s: str) -> list[int]:
    """Parse '2×2×2' or '2x2x2' into [2, 2, 2]."""
    parts = re.split(r"[×xX,]", s.strip())
    try:
        return [int(p.strip()) for p in parts]
    except ValueError:
        return [2, 2, 2]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/defect", response_model=BuildResult)
def create_defect(req: DefectRequest):
    """Generate point defects (vacancy, substitution, interstitial)."""
    structure = _parse_structure(req.structure)

    # Parse supercell
    scaling = parse_scaling(req.supercell)
    if any(s > 1 for s in scaling):
        structure.make_supercell(scaling)

    results = []
    labels = []

    if req.site_index != -1 and req.site_index >= len(structure):
        raise HTTPException(
            400,
            f"site_index {req.site_index} out of range for structure with {len(structure)} sites",
        )

    if req.defect_type == "vacancy":
        if req.site_index == -1:
            # All symmetry-unique sites
            from pymatgen.symmetry.analyzer import SpacegroupAnalyzer

            sga = SpacegroupAnalyzer(structure)
            sym_struct = sga.get_symmetrized_structure()
            for i, equiv_sites in enumerate(sym_struct.equivalent_indices):
                idx = equiv_sites[0]
                s = structure.copy()
                removed_species = str(s[idx].specie)
                s.remove_sites([idx])
                results.append(s.as_dict())
                labels.append(
                    f"Vacancy: {removed_species} site {idx} (equiv group {i})"
                )
        else:
            s = structure.copy()
            removed_species = str(s[req.site_index].specie)
            s.remove_sites([req.site_index])
            results.append(s.as_dict())
            labels.append(f"Vacancy: {removed_species} site {req.site_index}")

    elif req.defect_type == "substitution":
        if not req.substitute_element:
            raise HTTPException(
                400, "substitute_element required for substitution defect"
            )
        s = structure.copy()
        orig_species = str(s[req.site_index].specie)
        s.replace(req.site_index, req.substitute_element)
        results.append(s.as_dict())
        labels.append(
            f"Substitution: {orig_species}\u2192{req.substitute_element} at site {req.site_index}"
        )

    elif req.defect_type == "interstitial":
        # Simple interstitial at midpoint between two nearest neighbors.
        # For more sophisticated interstitials, users should use the
        # structure editor.
        s = structure.copy()
        if 0 <= req.site_index < len(s):
            # Place at site_index position with a small offset
            site = s[req.site_index]
            # Find midpoint between this site and its nearest neighbor
            frac_coords = site.frac_coords + np.array([0.5, 0.5, 0.5]) / np.array(
                scaling
            )
            frac_coords = frac_coords % 1.0
            element = req.substitute_element or str(site.specie)
            s.append(element, frac_coords)
            results.append(s.as_dict())
            labels.append(f"Interstitial: {element} near site {req.site_index}")
        else:
            raise HTTPException(400, f"Invalid site_index {req.site_index}")
    else:
        raise HTTPException(400, f"Unknown defect type: {req.defect_type}")

    return BuildResult(structures=results, labels=labels, count=len(results))


@router.post("/supercell", response_model=BuildResult)
def create_supercell(req: SupercellRequest):
    """Create supercell."""
    structure = _parse_structure(req.structure)
    scaling = parse_scaling(req.scaling)
    structure.make_supercell(scaling)
    multiply_char = '\u00d7'
    return BuildResult(
        structures=[structure.as_dict()],
        labels=["Supercell " + "\u00d7".join(map(str, scaling))],
        count=1,
    )


@router.post("/strain", response_model=BuildResult)
def apply_strain(req: StrainRequest):
    """Apply strain/deformation."""
    from pymatgen.analysis.elasticity.strain import Deformation
    structure = _parse_structure(req.structure)
    results = []
    labels = []

    if req.n_steps <= 1:
        magnitudes = [req.magnitude]
    else:
        magnitudes = np.linspace(
            -abs(req.magnitude), abs(req.magnitude), req.n_steps
        ).tolist()

    for mag in magnitudes:
        s = structure.copy()
        if req.strain_type == "uniaxial":
            axis_map = {"a": 0, "b": 1, "c": 2}
            idx = axis_map.get(req.axis, 2)
            deform_matrix = np.eye(3)
            deform_matrix[idx, idx] = 1 + mag
        elif req.strain_type == "biaxial":
            deform_matrix = np.eye(3)
            deform_matrix[0, 0] = 1 + mag
            deform_matrix[1, 1] = 1 + mag
        elif req.strain_type == "hydrostatic":
            deform_matrix = np.eye(3) * (1 + mag)
        elif req.strain_type == "shear":
            deform_matrix = np.eye(3)
            deform_matrix[0, 1] = mag
        else:
            raise HTTPException(400, f"Unknown strain type: {req.strain_type}")

        deformation = Deformation(deform_matrix)
        s = deformation.apply_to_structure(s)
        results.append(s.as_dict())
        pct = mag * 100
        labels.append(f"{req.strain_type} {req.axis} {pct:+.1f}%")

    return BuildResult(structures=results, labels=labels, count=len(results))


@router.post("/doping", response_model=BuildResult)
def create_doping(req: DopingRequest):
    """Substitutional doping."""
    structure = _parse_structure(req.structure)
    results = []
    labels = []

    if req.target_indices:
        # Specific site indices provided — dope exactly those sites
        invalid = [i for i in req.target_indices if i < 0 or i >= len(structure)]
        if invalid:
            raise HTTPException(400, f"Invalid site indices: {invalid} (structure has {len(structure)} atoms)")

        if req.enumerate and len(req.target_indices) > 1:
            # Enumerate: generate one structure per target site
            from itertools import combinations
            combos = list(combinations(req.target_indices, min(req.concentration, len(req.target_indices))))
            if len(combos) > 500:
                combos = combos[:500]
            for combo in combos:
                s = structure.copy()
                for idx in sorted(combo, reverse=True):
                    s.replace(idx, req.dopant)
                results.append(s.as_dict())
                labels.append(f"Doped: site {list(combo)} \u2192 {req.dopant}")
        else:
            # Single config: dope all specified sites
            s = structure.copy()
            for idx in sorted(req.target_indices, reverse=True):
                s.replace(idx, req.dopant)
            results.append(s.as_dict())
            site_els = [str(structure[i].specie) for i in req.target_indices]
            labels.append(f"Doped: {','.join(site_els)} \u2192 {req.dopant} at sites {req.target_indices}")
    else:
        # Auto-detect by host element
        host_indices = [
            i for i, site in enumerate(structure)
            if str(site.specie) == req.host_element
            or (hasattr(site.specie, 'element') and str(site.specie.element) == req.host_element)
            or (hasattr(site.specie, 'symbol') and site.specie.symbol == req.host_element)
        ]
        if not host_indices:
            raise HTTPException(400, f"No {req.host_element} atoms found in structure")

        if req.enumerate and req.concentration <= len(host_indices):
            from itertools import combinations
            combos = list(combinations(host_indices, req.concentration))
            if len(combos) > 500:
                combos = combos[:500]
            for combo in combos:
                s = structure.copy()
                for idx in sorted(combo, reverse=True):
                    s.replace(idx, req.dopant)
                results.append(s.as_dict())
                labels.append(
                    f"Doped: {req.host_element}\u2192{req.dopant} at sites {list(combo)}"
                )
        else:
            s = structure.copy()
            for idx in host_indices[: req.concentration]:
                s.replace(idx, req.dopant)
            results.append(s.as_dict())
            labels.append(
                f"Doped: {req.concentration}\u00d7 {req.host_element}\u2192{req.dopant}"
            )

    return BuildResult(structures=results, labels=labels, count=len(results))


@router.post("/intercalation", response_model=BuildResult)
def create_intercalation(req: IntercalationRequest):
    """Insert intercalant species."""
    structure = _parse_structure(req.structure)

    if req.position == "auto":
        # Find the largest gap in z fractional coordinates
        z_coords = sorted([site.frac_coords[2] for site in structure])
        # Find the biggest gap
        gaps = []
        for i in range(len(z_coords)):
            next_z = z_coords[(i + 1) % len(z_coords)]
            gap = (next_z - z_coords[i]) % 1.0
            mid = (z_coords[i] + gap / 2) % 1.0
            gaps.append((gap, mid))
        gaps.sort(reverse=True)

        # Insert at the center of the largest gap
        if gaps:
            _, z_mid = gaps[0]
            # Distribute intercalants in the xy plane
            for j in range(req.n_intercalants):
                fx = (j % 3 + 0.5) / 3
                fy = (j // 3 + 0.5) / max(1, (req.n_intercalants + 2) // 3)
                structure.append(req.species, [fx % 1, fy % 1, z_mid])
    elif req.position == "tetrahedral":
        # Approximate tetrahedral sites
        for j in range(req.n_intercalants):
            structure.append(req.species, [0.25 + j * 0.5 % 1, 0.25, 0.25])
    elif req.position == "octahedral":
        # Approximate octahedral sites
        for j in range(req.n_intercalants):
            structure.append(req.species, [0.5, 0.5 + j * 0.5 % 1, 0.5])

    return BuildResult(
        structures=[structure.as_dict()],
        labels=[f"Intercalated: {req.n_intercalants}\u00d7 {req.species}"],
        count=1,
    )


@router.post("/substitution", response_model=BuildResult)
def combinatorial_substitution(req: SubstitutionRequest):
    """Generate combinatorial substitutions across multiple groups.

    Each group defines target sites that all receive the same replacement element.
    The combinatorial product is across groups:
    total = |group1_replacements| * |group2_replacements| * ...
    """
    from itertools import product

    structure = _parse_structure(req.structure)

    if not req.groups:
        raise HTTPException(400, "groups must not be empty")

    for gi, group in enumerate(req.groups):
        if not group.target_indices:
            raise HTTPException(400, f"Group {gi+1}: target_indices must not be empty")
        if not group.replacement_elements:
            raise HTTPException(400, f"Group {gi+1}: replacement_elements must not be empty")
        for idx in group.target_indices:
            if idx < 0 or idx >= len(structure):
                raise HTTPException(
                    400,
                    f"Group {gi+1}: invalid site index {idx} "
                    f"(structure has {len(structure)} sites)",
                )

    # Combinatorial product across groups
    replacement_lists = [g.replacement_elements for g in req.groups]

    results: list[dict] = []
    labels: list[str] = []

    for i, combo in enumerate(product(*replacement_lists)):
        if i >= req.max_structures:
            break
        s = structure.copy()
        label_parts = []
        for group, element in zip(req.groups, combo):
            for site_idx in group.target_indices:
                orig = str(s[site_idx].specie)
                s.replace(site_idx, element)
            label_parts.append(f"{element}({len(group.target_indices)} sites)")
        results.append(s.as_dict())
        labels.append(f"[{i+1}] " + " + ".join(label_parts))

    return BuildResult(structures=results, labels=labels, count=len(results))


@router.post("/random-substitution", response_model=BuildResult)
def random_substitution(req: RandomSubstitutionRequest):
    """Randomly substitute a fixed count of each dopant into a host pool.

    Example: replace 8 of 25 Mo atoms with 5 Nb + 3 Ta at random positions,
    generating up to ``n_samples`` distinct random arrangements.
    """
    import random as _random

    structure = _parse_structure(req.structure)

    # Resolve the candidate site pool: explicit indices win over host element.
    if req.target_indices:
        invalid = [i for i in req.target_indices if i < 0 or i >= len(structure)]
        if invalid:
            raise HTTPException(
                400,
                f"Invalid site indices: {invalid} "
                f"(structure has {len(structure)} atoms)",
            )
        pool = list(dict.fromkeys(req.target_indices))  # de-dup, keep order
    elif req.host_element:
        pool = [
            i
            for i, site in enumerate(structure)
            if str(site.specie) == req.host_element
            or (hasattr(site.specie, "element") and str(site.specie.element) == req.host_element)
            or (hasattr(site.specie, "symbol") and site.specie.symbol == req.host_element)
        ]
        if not pool:
            raise HTTPException(400, f"No {req.host_element} atoms found in structure")
    else:
        raise HTTPException(400, "Either host_element or target_indices must be provided")

    # Validate dopant counts.
    dopants = [(d.element, int(d.count)) for d in req.dopants if int(d.count) > 0]
    if not dopants:
        raise HTTPException(400, "At least one dopant with count > 0 is required")
    total_replace = sum(c for _, c in dopants)
    if total_replace > len(pool):
        raise HTTPException(
            400,
            f"Requested {total_replace} substitutions but the pool only has "
            f"{len(pool)} sites",
        )

    n_samples = max(1, min(req.n_samples, req.max_structures))
    rng = _random.Random(req.seed)

    results: list[dict] = []
    labels: list[str] = []
    seen: set[tuple] = set()
    dopant_summary = " + ".join(f"{el}×{c}" for el, c in dopants)

    # Draw enough attempts to reach n_samples unique arrangements; cap attempts
    # so a tiny pool (few possible arrangements) can't spin forever.
    max_attempts = n_samples * 50 if req.deduplicate else n_samples
    attempts = 0
    while len(results) < n_samples and attempts < max_attempts:
        attempts += 1
        chosen = rng.sample(pool, total_replace)
        assignment: list[tuple[int, str]] = []
        cursor = 0
        for el, c in dopants:
            for site_idx in chosen[cursor : cursor + c]:
                assignment.append((site_idx, el))
            cursor += c

        if req.deduplicate:
            key = tuple(sorted(assignment))
            if key in seen:
                continue
            seen.add(key)

        s = structure.copy()
        for site_idx, el in assignment:
            s.replace(site_idx, el)
        results.append(s.as_dict())
        labels.append(f"[{len(results)}] random: {dopant_summary}")

    if not results:
        raise HTTPException(400, "Failed to generate any substitution samples")

    return BuildResult(structures=results, labels=labels, count=len(results))
