"""Pseudo-hydrogen passivation algorithm for slab surface dangling bonds.

Adapted from reference_code/pseudo_hydrogen.py for use as a server-side utility.
Accepts ASE Atoms objects directly (no file I/O).

Theory:
  In bulk, each A-B covalent bond has 2 electrons contributed by both atoms:
      e_A = V_A / N_A,  e_B = V_B / N_B,  e_A + e_B = 2
  where V = valence electrons, N = coordination number.

  When a slab is cut, surface atoms lose neighbors, creating dangling bonds.
  The pseudo-hydrogen nuclear charge should equal the electron contribution
  of the **missing** atom:
      Z_H = V_missing / N_missing
"""

import logging
import warnings
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np
from ase import Atoms
from ase.data import atomic_numbers, covalent_radii
from ase.neighborlist import NeighborList, natural_cutoffs

logger = logging.getLogger(__name__)

# ===========================================================================
#  Constants
# ===========================================================================

VALENCE_ELECTRONS: Dict[str, float] = {
    # Chemical BONDING valence electrons (NOT VASP POTCAR electron count!)
    # For the pseudo-H formula Z_H = V_missing / N_missing, each A-B bond
    # in bulk must satisfy: V_A/N_A + V_B/N_B = 2.
    # Use the valence_electrons parameter to override for non-standard cases.
    #
    # s block
    "H": 1, "Li": 1, "Na": 1, "K": 1, "Rb": 1, "Cs": 1,
    "Be": 2, "Mg": 2, "Ca": 2, "Sr": 2, "Ba": 2,
    # p block
    "B": 3, "Al": 3, "Ga": 3, "In": 3, "Tl": 3,
    "C": 4, "Si": 4, "Ge": 4, "Sn": 4, "Pb": 4,
    "N": 5, "P": 5, "As": 5, "Sb": 5, "Bi": 5,
    "O": 6, "S": 6, "Se": 6, "Te": 6,
    "F": 7, "Cl": 7, "Br": 7, "I": 7,
    # d block – common oxidation state (bonding electrons).
    # Early TMs: group number (all d+s electrons participate in bonding).
    # Late TMs: common oxidation state; compound-dependent, override if needed.
    "Sc": 3, "Ti": 4, "V": 5, "Cr": 6, "Mn": 7,
    "Fe": 3, "Co": 3, "Ni": 2, "Cu": 1, "Zn": 2,
    "Y": 3, "Zr": 4, "Nb": 5, "Mo": 6, "Tc": 7,
    "Ru": 4, "Rh": 3, "Pd": 2, "Ag": 1, "Cd": 2,
    "Hf": 4, "Ta": 5, "W": 6, "Re": 7,
    "Os": 4, "Ir": 4, "Pt": 4, "Au": 3,
}

VASP_PSEUDO_H_CHARGES = [
    0.25, 0.33, 0.42, 0.50, 0.58, 0.66, 0.75,
    1.00, 1.25, 1.33, 1.50, 1.66, 1.75, 2.00,
]

VASP_POTCAR_NAMES = {
    0.25: "H.25", 0.33: "H.33", 0.42: "H.42", 0.50: "H.50",
    0.58: "H.58", 0.66: "H.66", 0.75: "H.75", 1.00: "H",
    1.25: "H1.25", 1.33: "H1.33", 1.50: "H1.50", 1.66: "H1.66",
    1.75: "H1.75", 2.00: "H1.75",  # 2.00 approximated
}


# ===========================================================================
#  Data structures
# ===========================================================================

@dataclass
class PseudoHInfo:
    """Information about a single pseudo-hydrogen atom."""
    position: np.ndarray
    charge: float               # exact charge (V_missing / N_missing)
    vasp_charge: float          # nearest available VASP charge
    potcar_name: str            # POTCAR filename (e.g., "H.50")
    parent_index: int           # index in original slab
    parent_symbol: str          # element of parent atom
    missing_symbol: str         # element that was cut away
    bond_direction: np.ndarray  # normalized bond direction


@dataclass
class PassivationResult:
    """Complete passivation result."""
    slab: Atoms                            # slab with pseudo-H added
    pseudo_h_list: List[PseudoHInfo]       # all pseudo-H info
    bulk_coordination: Dict[str, int]      # bulk coordination numbers
    unique_potcars: List[str]              # required POTCAR names
    valence_used: Dict[str, float] = field(default_factory=dict)  # V values used
    bond_warnings: List[str] = field(default_factory=list)  # validation warnings

    def summary(self) -> str:
        lines = [
            f"Total pseudo-H added: {len(self.pseudo_h_list)}",
            f"Bulk coordination: {self.bulk_coordination}",
        ]
        by_parent: Dict[tuple, int] = {}
        for h in self.pseudo_h_list:
            key = (h.parent_symbol, h.missing_symbol, h.vasp_charge)
            by_parent[key] = by_parent.get(key, 0) + 1

        for (parent, missing, charge), count in sorted(by_parent.items()):
            potcar = VASP_POTCAR_NAMES.get(charge, f"H{charge:.2f}")
            lines.append(
                f"  {parent} surface (missing {missing}): "
                f"{count} x H(Z={charge:.2f}) [{potcar}]"
            )
        lines.append(f"POTCAR needed: {', '.join(self.unique_potcars)}")
        return "\n".join(lines)


# ===========================================================================
#  Core algorithm
# ===========================================================================

class SlabPassivator:
    """Add pseudo-hydrogen atoms to passivate slab surface dangling bonds.

    Parameters
    ----------
    bulk : Atoms
        Bulk structure (ASE Atoms object)
    slab : Atoms
        Slab structure (ASE Atoms object)
    valence_electrons : dict, optional
        Custom valence electron overrides
    cutoff_mult : float
        Neighbor search cutoff multiplier (relative to covalent radii sum)
    bulk_coordination : dict, optional
        Manual bulk coordination, e.g. {"Fe": 8}.
        Important for metals where auto-detection may fail.
    """

    def __init__(
        self,
        bulk: Atoms,
        slab: Atoms,
        valence_electrons: Optional[Dict[str, float]] = None,
        cutoff_mult: float = 1.15,
        bulk_coordination: Optional[Dict[str, int]] = None,
    ):
        self.bulk = bulk.copy()
        self.slab = slab.copy()
        self.cutoff_mult = cutoff_mult
        self._manual_coordination = bulk_coordination

        self.valence_electrons = dict(VALENCE_ELECTRONS)
        if valence_electrons:
            self.valence_electrons.update(valence_electrons)

        self._bulk_coord_info = self._analyze_bulk()

    # -------------------------------------------------------------------
    #  Bulk analysis
    # -------------------------------------------------------------------

    def _analyze_bulk(self) -> Dict[str, dict]:
        """Analyze bulk coordination environment for each element.

        Uses gap detection to identify the first neighbor shell boundary.
        """
        bulk = self.bulk
        cutoffs = natural_cutoffs(bulk, mult=1.5)
        nl = NeighborList(cutoffs, self_interaction=False, bothways=True, skin=0.0)
        nl.update(bulk)

        raw_info: Dict[str, list] = {}
        for i, atom in enumerate(bulk):
            sym = atom.symbol
            indices, offsets = nl.get_neighbors(i)
            neighbors = []
            for j, offset in zip(indices, offsets):
                vec = bulk.positions[j] + offset @ bulk.get_cell() - bulk.positions[i]
                dist = np.linalg.norm(vec)
                neighbors.append({
                    "index": j, "symbol": bulk[j].symbol,
                    "distance": dist, "vector": vec,
                })
            neighbors.sort(key=lambda x: x["distance"])
            raw_info.setdefault(sym, []).append({"atom_index": i, "neighbors": neighbors})

        result = {}
        for sym, atom_data_list in raw_info.items():
            if self._manual_coordination and sym in self._manual_coordination:
                target_cn = self._manual_coordination[sym]
                first_shell_cutoff = self._get_cutoff_for_cn(atom_data_list, target_cn)
            else:
                first_shell_cutoff = self._detect_first_shell(sym, atom_data_list)

            coordinations = []
            all_neighbor_types: Dict[str, int] = {}
            all_bond_lengths: Dict[str, list] = {}
            sample_directions: list = []

            for atom_data in atom_data_list:
                first_shell = [
                    n for n in atom_data["neighbors"]
                    if n["distance"] <= first_shell_cutoff
                ]
                coordinations.append(len(first_shell))
                for n in first_shell:
                    ns = n["symbol"]
                    all_neighbor_types[ns] = all_neighbor_types.get(ns, 0) + 1
                    all_bond_lengths.setdefault(ns, []).append(n["distance"])
                if len(sample_directions) == 0 and len(first_shell) > 0:
                    sample_directions = [
                        (n["symbol"], n["vector"]) for n in first_shell
                    ]

            avg_coord = int(round(np.mean(coordinations)))
            n_atoms = len(atom_data_list)

            neighbor_types_avg = {
                k: round(v / n_atoms) for k, v in all_neighbor_types.items()
            }
            avg_bls = {
                ns: np.mean(lengths) for ns, lengths in all_bond_lengths.items()
            }
            result[sym] = {
                "coordination": avg_coord,
                "neighbor_types": neighbor_types_avg,
                "avg_bond_lengths": avg_bls,
                "neighbor_directions_sample": sample_directions,
                "first_shell_cutoff": first_shell_cutoff,
            }
            logger.info(
                "Bulk %s: CN=%d, cutoff=%.3f A, neighbor_types=%s, avg_bl=%s",
                sym, avg_coord, first_shell_cutoff,
                neighbor_types_avg,
                {k: f"{v:.3f}" for k, v in avg_bls.items()},
            )

        return result

    def _detect_first_shell(
        self, symbol: str, atom_data_list: list, gap_ratio: float = 0.15
    ) -> float:
        """Auto-detect first neighbor shell cutoff via gap analysis."""
        all_distances = []
        for atom_data in atom_data_list:
            for n in atom_data["neighbors"]:
                all_distances.append(n["distance"])

        if len(all_distances) == 0:
            return 3.0

        all_distances = np.sort(all_distances)

        unique_dists = [all_distances[0]]
        for d in all_distances[1:]:
            if d - unique_dists[-1] > 0.01:
                unique_dists.append(d)
        unique_dists = np.array(unique_dists)

        if len(unique_dists) < 2:
            return unique_dists[0] * 1.1

        for i in range(len(unique_dists) - 1):
            gap = unique_dists[i + 1] - unique_dists[i]
            relative_gap = gap / unique_dists[i]
            if relative_gap > gap_ratio:
                return (unique_dists[i] + unique_dists[i + 1]) / 2.0

        warnings.warn(
            f"No clear gap found for {symbol}. "
            f"Distances: {unique_dists[:6]}... "
            f"Using 1.15 x min distance as cutoff. "
            f"Consider specifying bulk_coordination manually."
        )
        return unique_dists[0] * 1.15

    def _get_cutoff_for_cn(self, atom_data_list: list, target_cn: int) -> float:
        """Find cutoff distance for a target coordination number."""
        neighbors = atom_data_list[0]["neighbors"]
        if len(neighbors) <= target_cn:
            return neighbors[-1]["distance"] * 1.1
        d_in = neighbors[target_cn - 1]["distance"]
        d_out = neighbors[target_cn]["distance"]
        return (d_in + d_out) / 2.0

    # -------------------------------------------------------------------
    #  Slab neighbor list
    # -------------------------------------------------------------------

    def _build_slab_neighborlist(self) -> NeighborList:
        """Build slab neighbor list using bulk first-shell cutoff.

        Uses per-element cutoffs from bulk analysis so that different
        element pairs get appropriate distance thresholds.  This prevents
        the single max_cutoff from inflating coordination counts.
        """
        slab = self.slab
        per_atom_cutoffs = []
        max_cutoff = max(
            info.get("first_shell_cutoff", 3.0)
            for info in self._bulk_coord_info.values()
        )
        for atom in slab:
            sym = atom.symbol
            if sym in self._bulk_coord_info:
                per_atom_cutoffs.append(
                    self._bulk_coord_info[sym]["first_shell_cutoff"] / 2.0
                )
            else:
                per_atom_cutoffs.append(max_cutoff / 2.0)
        nl = NeighborList(per_atom_cutoffs, self_interaction=False, bothways=True, skin=0.0)
        nl.update(slab)
        return nl

    def _count_first_shell_neighbors(
        self, atom_idx: int, nl: NeighborList
    ) -> int:
        """Count first-shell neighbors of ``atom_idx`` using element-specific
        cutoff **and** element-type filtering from the bulk analysis.

        This avoids inflated coordination from:
        - same-element pairs (O-O in TiO2) due to broad slab NL cutoff
        - second-shell pairs (longer Ti-O) included by max_cutoff
        """
        slab = self.slab
        sym = slab[atom_idx].symbol
        bulk_info = self._bulk_coord_info.get(sym)
        if bulk_info is None:
            return 0

        expected_types = set(bulk_info["neighbor_types"].keys())
        cutoff = bulk_info["first_shell_cutoff"]
        indices, offsets = nl.get_neighbors(atom_idx)

        count = 0
        for j, offset in zip(indices, offsets):
            if slab[j].symbol not in expected_types:
                continue
            vec = (slab.positions[j]
                   + offset @ slab.get_cell()
                   - slab.positions[atom_idx])
            dist = np.linalg.norm(vec)
            if dist <= cutoff:
                count += 1
        return count

    # -------------------------------------------------------------------
    #  Surface atom identification
    # -------------------------------------------------------------------

    def _identify_surface_atoms(
        self,
        passivate_top: bool = False,
        passivate_bottom: bool = True,
        surface_depth: float = 1.5,
    ) -> List[Tuple[int, str]]:
        """Identify undercoordinated surface atoms.

        Returns list of (atom_index, "top" or "bottom").
        """
        slab = self.slab
        nl = self._build_slab_neighborlist()

        z_coords = slab.positions[:, 2]
        z_min, z_max = z_coords.min(), z_coords.max()

        surface_atoms = []
        for i, atom in enumerate(slab):
            sym = atom.symbol
            if sym not in self._bulk_coord_info:
                continue

            expected_cn = self._bulk_coord_info[sym]["coordination"]
            actual_cn = self._count_first_shell_neighbors(i, nl)

            if actual_cn >= expected_cn:
                continue

            z = slab.positions[i, 2]
            is_bottom = (z - z_min) < surface_depth
            is_top = (z_max - z) < surface_depth

            if is_bottom and passivate_bottom:
                surface_atoms.append((i, "bottom"))
            elif is_top and passivate_top:
                surface_atoms.append((i, "top"))

        return surface_atoms

    # -------------------------------------------------------------------
    #  Missing direction calculation
    # -------------------------------------------------------------------

    def _compute_missing_directions(
        self, atom_idx: int, side: str
    ) -> List[Tuple[np.ndarray, str]]:
        """Compute missing bond directions and the corresponding missing element.

        Returns list of (direction_vector, missing_element_symbol).
        """
        slab = self.slab
        sym = slab[atom_idx].symbol
        bulk_info = self._bulk_coord_info[sym]

        nl = self._build_slab_neighborlist()
        indices, offsets = nl.get_neighbors(atom_idx)

        current_vecs = []
        for j, offset in zip(indices, offsets):
            vec = (slab.positions[j]
                   + offset @ slab.get_cell()
                   - slab.positions[atom_idx])
            current_vecs.append(vec / np.linalg.norm(vec))

        ref_directions = bulk_info["neighbor_directions_sample"]

        if len(current_vecs) == 0:
            missing = []
            for ns, ref_vec in ref_directions:
                direction = ref_vec / np.linalg.norm(ref_vec)
                if side == "bottom":
                    direction[2] = -abs(direction[2])
                elif side == "top":
                    direction[2] = abs(direction[2])
                missing.append((direction, ns))
            return missing

        ref_unit_vecs = []
        for ns, ref_vec in ref_directions:
            ref_unit_vecs.append((ref_vec / np.linalg.norm(ref_vec), ns))

        return self._greedy_match_directions(
            current_vecs, ref_unit_vecs, atom_idx, side
        )

    def _greedy_match_directions(
        self,
        current_vecs: List[np.ndarray],
        ref_vecs: List[Tuple[np.ndarray, str]],
        atom_idx: int,
        side: str,
        cos_threshold: float = 0.5,
    ) -> List[Tuple[np.ndarray, str]]:
        """Greedy match current neighbor directions against reference.

        Returns unmatched (missing) directions with geometric inference.
        """
        slab = self.slab
        sym = slab[atom_idx].symbol
        bulk_info = self._bulk_coord_info[sym]
        expected_cn = bulk_info["coordination"]
        actual_cn = len(current_vecs)
        n_missing = expected_cn - actual_cn

        if n_missing <= 0:
            return []

        # Geometric inference from existing neighbors
        avg_dir = np.mean(current_vecs, axis=0)
        avg_dir_norm = np.linalg.norm(avg_dir)

        if avg_dir_norm > 0.1:
            avg_dir /= avg_dir_norm
            base_missing_dir = -avg_dir
        else:
            if side == "bottom":
                base_missing_dir = np.array([0.0, 0.0, -1.0])
            else:
                base_missing_dir = np.array([0.0, 0.0, 1.0])

        # Determine missing element types
        nl = self._build_slab_neighborlist()
        indices, offsets = nl.get_neighbors(atom_idx)

        current_neighbor_types: Dict[str, int] = {}
        for j in indices:
            ns = slab[j].symbol
            current_neighbor_types[ns] = current_neighbor_types.get(ns, 0) + 1

        expected_neighbor_types = dict(bulk_info["neighbor_types"])

        missing_elements = []
        for ns, expected_count in expected_neighbor_types.items():
            actual_count = current_neighbor_types.get(ns, 0)
            for _ in range(expected_count - actual_count):
                missing_elements.append(ns)

        while len(missing_elements) < n_missing:
            most_common = max(expected_neighbor_types, key=expected_neighbor_types.get)
            missing_elements.append(most_common)

        # Generate missing directions
        missing_results = []

        if n_missing == 1:
            missing_results.append((base_missing_dir, missing_elements[0]))
        elif n_missing == 2:
            perp = self._get_perpendicular(base_missing_dir)
            angle = np.radians(30)
            d1 = base_missing_dir * np.cos(angle) + perp * np.sin(angle)
            d2 = base_missing_dir * np.cos(angle) - perp * np.sin(angle)
            missing_results.append((d1 / np.linalg.norm(d1), missing_elements[0]))
            missing_results.append((d2 / np.linalg.norm(d2), missing_elements[1]))
        else:
            perp1 = self._get_perpendicular(base_missing_dir)
            perp2 = np.cross(base_missing_dir, perp1)
            perp2 /= np.linalg.norm(perp2)
            cone_angle = np.radians(30)

            for k in range(n_missing):
                phi = 2 * np.pi * k / n_missing
                direction = (
                    base_missing_dir * np.cos(cone_angle)
                    + perp1 * np.sin(cone_angle) * np.cos(phi)
                    + perp2 * np.sin(cone_angle) * np.sin(phi)
                )
                direction /= np.linalg.norm(direction)
                elem = missing_elements[k] if k < len(missing_elements) else missing_elements[-1]
                missing_results.append((direction, elem))

        return missing_results

    @staticmethod
    def _get_perpendicular(vec: np.ndarray) -> np.ndarray:
        """Get a unit vector perpendicular to the given vector."""
        if abs(vec[0]) < 0.9:
            perp = np.cross(vec, [1, 0, 0])
        else:
            perp = np.cross(vec, [0, 1, 0])
        return perp / np.linalg.norm(perp)

    # -------------------------------------------------------------------
    #  Pseudo-H charge calculation
    # -------------------------------------------------------------------

    def _validate_bond_electrons(self) -> List[str]:
        """Check V_A/N_A + V_B/N_B ≈ 2 for each A-B pair in bulk.

        Returns list of warning messages (empty if all valid).
        """
        warnings_list = []
        checked = set()
        for sym_a, info_a in self._bulk_coord_info.items():
            V_a = self.valence_electrons.get(sym_a)
            N_a = info_a["coordination"]
            if V_a is None or N_a == 0:
                continue
            for sym_b in info_a["neighbor_types"]:
                pair = tuple(sorted([sym_a, sym_b]))
                if pair in checked:
                    continue
                checked.add(pair)
                if sym_b not in self._bulk_coord_info:
                    continue
                V_b = self.valence_electrons.get(sym_b)
                N_b = self._bulk_coord_info[sym_b]["coordination"]
                if V_b is None or N_b == 0:
                    continue
                e_per_bond = V_a / N_a + V_b / N_b
                if abs(e_per_bond - 2.0) > 0.15:
                    warnings_list.append(
                        f"{sym_a}(V={V_a},N={N_a})-{sym_b}(V={V_b},N={N_b}): "
                        f"e/bond={e_per_bond:.2f} != 2.00. "
                        f"Check valence_electrons or bulk_coordination."
                    )
        return warnings_list

    def _compute_pseudo_h_charge(self, missing_symbol: str) -> Tuple[float, float, str]:
        """Compute pseudo-hydrogen charge: Z_H = V_missing / N_missing.

        Returns (exact_charge, vasp_charge, potcar_name).
        """
        if missing_symbol not in self.valence_electrons:
            warnings.warn(
                f"Valence electrons for {missing_symbol} not found. Using Z=1.0."
            )
            return 1.0, 1.0, "H"

        if missing_symbol not in self._bulk_coord_info:
            warnings.warn(
                f"Element {missing_symbol} not in bulk analysis. Using Z=1.0."
            )
            return 1.0, 1.0, "H"

        V = self.valence_electrons[missing_symbol]
        N = self._bulk_coord_info[missing_symbol]["coordination"]
        if N == 0:
            warnings.warn(
                f"Bulk coordination of {missing_symbol} is 0 — automatic "
                f"detection from the provided bulk structure failed. "
                f"Falling back to Z=1.0 for this pseudo-H, but the value "
                f"is not physically calibrated. Pass bulk_coordination="
                f"{{'{missing_symbol}': N, ...}} (e.g. IrO2: Ir=6, O=3) to fix."
            )
            return 1.0, 1.0, "H"
        exact_charge = V / N

        vasp_charge = min(VASP_PSEUDO_H_CHARGES, key=lambda x: abs(x - exact_charge))
        potcar = VASP_POTCAR_NAMES.get(vasp_charge, f"H{vasp_charge:.2f}")

        if abs(exact_charge - vasp_charge) > 0.05:
            warnings.warn(
                f"Exact charge {exact_charge:.3f} for missing {missing_symbol} "
                f"differs from nearest VASP charge {vasp_charge}."
            )

        return exact_charge, vasp_charge, potcar

    # -------------------------------------------------------------------
    #  Bond length
    # -------------------------------------------------------------------

    def _get_bond_length(
        self,
        parent_symbol: str,
        missing_symbol: str,
        scale: float = 1.0,
    ) -> float:
        """Compute pseudo-H bond length = (r_parent + r_H) * scale.

        Uses covalent radii sum as the natural parent-H bond length.
        The scale factor (default 1.0) allows fine-tuning.
        """
        r_parent = covalent_radii[atomic_numbers[parent_symbol]]
        r_H = covalent_radii[1]  # H covalent radius ≈ 0.31 Å
        return (r_parent + r_H) * scale

    # -------------------------------------------------------------------
    #  Main entry: passivate
    # -------------------------------------------------------------------

    def passivate(
        self,
        selected_indices: Optional[List[int]] = None,
        passivate_top: bool = False,
        passivate_bottom: bool = True,
        surface_depth: float = 1.5,
        bond_length_scale: float = 1.0,
    ) -> PassivationResult:
        """Execute pseudo-hydrogen passivation.

        Parameters
        ----------
        selected_indices : list of int, optional
            If provided, only passivate these atom indices (user selection).
            If None, auto-detect all undercoordinated surface atoms.
        passivate_top : bool
            Passivate top surface (only used when selected_indices is None)
        passivate_bottom : bool
            Passivate bottom surface (only used when selected_indices is None)
        surface_depth : float
            Surface depth threshold in Angstroms
        bond_length_scale : float
            Pseudo-H bond length = (r_parent + r_H) * scale
        """
        # 1. Log bulk analysis and validate
        zero_cn_syms = []
        for sym, info in self._bulk_coord_info.items():
            V = self.valence_electrons.get(sym, "?")
            N = info["coordination"]
            logger.info("Bulk %s: coordination=%d, valence=%s", sym, N, V)
            if N == 0:
                zero_cn_syms.append(sym)

        if zero_cn_syms:
            warnings.warn(
                f"Bulk coordination auto-detection failed for: {zero_cn_syms}. "
                f"The provided bulk structure likely has no clear first-shell "
                f"gap (e.g. distorted / non-representative reference). "
                f"Pass bulk_coordination={{sym: N, ...}} explicitly — for IrO2 "
                f"use {{'Ir': 6, 'O': 3}}."
            )

        bond_warnings = self._validate_bond_electrons()
        for w in bond_warnings:
            logger.warning("Bond validation: %s", w)

        # 2. Determine atoms to passivate
        if selected_indices is not None:
            # User-specified atoms: check each for undercoordination
            nl = self._build_slab_neighborlist()
            z_coords = self.slab.positions[:, 2]
            z_mid = (z_coords.min() + z_coords.max()) / 2.0

            atoms_to_passivate = []
            skipped = []
            for idx in selected_indices:
                if idx < 0 or idx >= len(self.slab):
                    continue
                sym = self.slab[idx].symbol
                if sym not in self._bulk_coord_info:
                    logger.info(
                        "  Atom %d (%s): element not in bulk analysis, skipping",
                        idx, sym,
                    )
                    continue
                expected_cn = self._bulk_coord_info[sym]["coordination"]
                actual_cn = self._count_first_shell_neighbors(idx, nl)
                logger.info(
                    "  Atom %d (%s) z=%.3f: expected_cn=%d, actual_cn=%d %s",
                    idx, sym, self.slab.positions[idx, 2],
                    expected_cn, actual_cn,
                    "SKIP" if actual_cn >= expected_cn else "UNDER",
                )
                if actual_cn >= expected_cn:
                    skipped.append(idx)
                    continue
                side = "bottom" if self.slab.positions[idx, 2] < z_mid else "top"
                atoms_to_passivate.append((idx, side))

            if skipped:
                logger.info(
                    "Skipped %d fully-coordinated atoms: %s",
                    len(skipped), skipped
                )
        else:
            atoms_to_passivate = self._identify_surface_atoms(
                passivate_top=passivate_top,
                passivate_bottom=passivate_bottom,
                surface_depth=surface_depth,
            )

        logger.info("Found %d atoms to passivate", len(atoms_to_passivate))

        # 3. Add pseudo-H for each undercoordinated atom
        pseudo_h_list: List[PseudoHInfo] = []
        new_slab = self.slab.copy()

        for atom_idx, side in atoms_to_passivate:
            sym = self.slab[atom_idx].symbol
            missing_directions = self._compute_missing_directions(atom_idx, side)

            for direction, missing_sym in missing_directions:
                exact_charge, vasp_charge, potcar = self._compute_pseudo_h_charge(missing_sym)
                bl = self._get_bond_length(sym, missing_sym, scale=bond_length_scale)
                h_pos = self.slab.positions[atom_idx] + bl * direction

                h_info = PseudoHInfo(
                    position=h_pos,
                    charge=exact_charge,
                    vasp_charge=vasp_charge,
                    potcar_name=potcar,
                    parent_index=atom_idx,
                    parent_symbol=sym,
                    missing_symbol=missing_sym,
                    bond_direction=direction,
                )
                pseudo_h_list.append(h_info)

                logger.info(
                    "Atom %d (%s) @ %s: missing %s, Z_H=%.3f -> VASP: %s, bond=%.3f A",
                    atom_idx, sym, side, missing_sym, exact_charge, potcar, bl,
                )

        # 4. Build passivated slab (group H by charge type for VASP)
        charge_groups: Dict[float, List[PseudoHInfo]] = {}
        for h in pseudo_h_list:
            charge_groups.setdefault(h.vasp_charge, []).append(h)

        all_positions = list(new_slab.positions)
        all_symbols = list(new_slab.get_chemical_symbols())
        all_tags = list(new_slab.get_tags()) if new_slab.get_tags() is not None else [0] * len(new_slab)

        h_type_index = 0
        for charge in sorted(charge_groups.keys()):
            h_type_index += 1
            tag = h_type_index + 100
            for h in charge_groups[charge]:
                all_positions.append(h.position)
                all_symbols.append("H")
                all_tags.append(tag)

        passivated = Atoms(
            symbols=all_symbols,
            positions=all_positions,
            cell=new_slab.get_cell(),
            pbc=new_slab.get_pbc(),
        )
        passivated.set_tags(all_tags)

        # 5. Build result
        bulk_coord = {sym: info["coordination"] for sym, info in self._bulk_coord_info.items()}
        unique_potcars = sorted(set(h.potcar_name for h in pseudo_h_list))
        valence_used = {
            sym: self.valence_electrons.get(sym, 0)
            for sym in self._bulk_coord_info
        }

        result = PassivationResult(
            slab=passivated,
            pseudo_h_list=pseudo_h_list,
            bulk_coordination=bulk_coord,
            unique_potcars=unique_potcars,
            valence_used=valence_used,
            bond_warnings=bond_warnings,
        )

        logger.info(result.summary())
        return result
