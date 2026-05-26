from pathlib import Path

import ase
import ase.io
import ase.neighborlist
import numpy as np

try:
    from ase.utils import natural_cutoffs
except Exception as e:
    e
    from ase.neighborlist import natural_cutoffs

import pymatgen.core as mg

from .log import logger

# Metal species.
METAL_LIKE = [
    "Li",
    "Be",
    "B",
    "Na",
    "Mg",
    "Al",
    "Si",
    "K",
    "Ca",
    "Sc",
    "Ti",
    "V",
    "Cr",
    "Mn",
    "Fe",
    "Co",
    "Ni",
    "Cu",
    "Zn",
    "Ga",
    "Ge",
    "As",
    "Rb",
    "Sr",
    "Y",
    "Zr",
    "Nb",
    "Mo",
    "Tc",
    "Ru",
    "Rh",
    "Pd",
    "Ag",
    "Cd",
    "In",
    "Sn",
    "Sb",
    "Te",
    "Cs",
    "Ba",
    "La",
    "Ce",
    "Pr",
    "Nd",
    "Pm",
    "Sm",
    "Eu",
    "Gd",
    "Tb",
    "Dy",
    "Ho",
    "Er",
    "Tm",
    "Yb",
    "Lu",
    "Hf",
    "Ta",
    "W",
    "Re",
    "Os",
    "Ir",
    "Pt",
    "Au",
    "Hg",
    "Tl",
    "Pb",
    "Bi",
    "Po",
    "Fr",
    "Ra",
    "Ac",
    "Th",
    "Pa",
    "U",
    "Np",
    "Pu",
    "Am",
    "Cm",
    "Bk",
    "Cf",
    "Es",
    "Fm",
    "Md",
    "No",
    "Lr",
]


def bound_values(x, eps=1e-4):
    """
    Add description.
    """
    x = np.where(np.abs(x - 0) < eps, np.full_like(x, 0 + eps), x)
    x = np.where(np.abs(x - 1) < eps, np.full_like(x, 1 - eps), x)

    return x


def covalent_neighbor_list(
    atoms, scale=1.2, neglected_species=[], neglected_indices=[]
):
    cutoffs = natural_cutoffs(atoms)
    cutoffs = [scale * c for c in cutoffs]
    # Remove radii to neglect them.
    species_indices = [
        i for i, a in enumerate(atoms) if a.symbol in neglected_species
    ]

    for i in neglected_indices + species_indices:
        cutoffs[i] = 0.0

    return ase.neighborlist.neighbor_list("ijD", atoms, cutoff=cutoffs)


def read_cgd(filename, node_symbol="C", edge_center_symbol="O"):
    """
    Read cgd format and return topology as ase.Atoms object.
    """
    with open(filename, "r") as f:
        # Neglect "CRYSTAL" and "END"
        lines = f.readlines()[1:-1]
    lines = [line for line in lines if not line.startswith("#")]

    # Get topology name.
    name = lines[0].split()[1]
    # Get spacegroup.
    spacegroup = lines[1].split()[1]

    # Get cell paremeters and expand cell lengths by 10.
    cellpar = np.array(lines[2].split()[1:], dtype=np.float32)

    # Parse node information.
    node_positions = []
    coordination_numbers = []
    for line in lines[3:]:
        tokens = line.split()

        if tokens[0] != "NODE":
            continue

        coordination_number = int(tokens[2])
        pos = [float(r) for r in tokens[3:]]
        node_positions.append(pos)
        coordination_numbers.append(coordination_number)

    node_positions = np.array(node_positions)
    # coordination_numbers = np.array(coordination_numbers)

    # Parse edge information.
    edge_center_positions = []
    for line in lines[3:]:
        tokens = line.split()

        if tokens[0] != "EDGE":
            continue

        pos_i = np.array([float(r) for r in tokens[1:4]])
        pos_j = np.array([float(r) for r in tokens[4:]])

        edge_center_pos = 0.5 * (pos_i + pos_j)
        edge_center_positions.append(edge_center_pos)

    # New feature. Read EDGE_CENTER.
    for line in lines[3:]:
        tokens = line.split()

        if tokens[0] != "EDGE_CENTER":
            continue

        edge_center_pos = np.array([float(r) for r in tokens[1:]])
        edge_center_positions.append(edge_center_pos)

    edge_center_positions = np.array(edge_center_positions)

    # Carbon for nodes, oxygen for edges.
    n_nodes = node_positions.shape[0]
    n_edges = edge_center_positions.shape[0]
    species = np.concatenate(
        [
            np.full(shape=n_nodes, fill_value=node_symbol),
            np.full(shape=n_edges, fill_value=edge_center_symbol),
        ]
    )

    coords = np.concatenate([node_positions, edge_center_positions], axis=0)

    # Pymatget can handle : indicator in spacegroup.
    # Mark symmetrically equivalent sites.
    node_types = [i for i, _ in enumerate(node_positions)]
    edge_types = [-(i + 1) for i, _ in enumerate(edge_center_positions)]
    site_properties = {
        "type": node_types + edge_types,
        "cn": coordination_numbers + [2 for _ in edge_center_positions],
    }

    # I don't know why pymatgen can't parse this spacegroup.
    if spacegroup == "Cmca":
        spacegroup = "Cmce"

    structure = mg.Structure.from_spacegroup(
        sg=spacegroup,
        lattice=mg.Lattice.from_parameters(*cellpar),
        species=species,
        coords=coords,
        site_properties=site_properties,
    )

    # Add information.
    info = {
        "spacegroup": spacegroup,
        "name": name,
        "cn": structure.site_properties["cn"],
    }

    # Cast mg.Structure to ase.Atoms
    atoms = ase.Atoms(
        symbols=[s.name for s in structure.species],
        positions=structure.cart_coords,
        cell=structure.lattice.matrix,
        tags=structure.site_properties["type"],
        pbc=True,
        info=info,
    )

    # Remove overlap
    I, J, D = ase.neighborlist.neighbor_list("ijd", atoms, cutoff=0.1)
    # Remove higher index.
    J = J[J > I]
    if len(J) > 0:
        # Save original size of atoms.
        n = len(atoms)
        removed_indices = set(J)

        del atoms[list(removed_indices)]

        cn = atoms.info["cn"]
        # Remove old cn info.
        cn = [cn[i] for i in range(n) if i not in removed_indices]

        atoms.info["cn"] = cn

        logger.debug("Overlapped positions are removed: index %s", set(J))

    return atoms


def read_budiling_block_xyz(bb_file):
    name = Path(bb_file).stem

    with open(bb_file, "r") as f:
        lines = f.readlines()

    n_atoms = int(lines[0])

    symbols = []
    positions = []
    charges = []
    connection_point_indices = []
    for i, line in enumerate(lines[2 : n_atoms + 2]):
        tokens = line.split()
        symbol = tokens[0]
        position = [float(v) for v in tokens[1:4]]
        if len(tokens) == 5:
            charge = float(tokens[4])
        else:
            charge = 0.0

        symbols.append(symbol)
        positions.append(position)
        charges.append(charge)
        if symbol == "X":
            connection_point_indices.append(i)

    bonds = None
    bond_types = None
    if len(lines) > n_atoms + 2:
        logger.debug("There are bonds in building block xyz. Reading...")
        bonds = []
        bond_types = []

        for line in lines[n_atoms + 2 :]:
            tokens = line.split()
            if len(tokens) < 3:
                logger.debug("%s: len(line.split()) < 3 %s", bb_file, line)
                continue

            i = int(tokens[0])
            j = int(tokens[1])
            t = tokens[2]
            bonds.append((i, j))
            bond_types.append(t)
        bonds = np.array(bonds)

    info = {}
    info["cpi"] = connection_point_indices
    info["name"] = name
    info["bonds"] = bonds
    info["bond_types"] = bond_types

    atoms = ase.Atoms(symbols=symbols, positions=positions, charges=charges, info=info)

    return atoms


def write_molecule_cif(filename, atoms, bond_pairs, bond_types):
    """
    Write cif for the molecule structures.

    Args:
        filename: file name.
        atoms: ase.Atoms object.
        bond_pairs: list of bond paris. contains (i, j).
        bond_types: list of bond types. contains one of "S", "D", "T", "A".

    Returns:
        None
    """

    path = Path(filename).resolve()
    if path.suffix != ".cif":
        path = path.with_suffix(".cif")

    stem = path.stem.replace(" ", "_")
    with path.open("w") as f:
        f.write("data_{}\n".format(stem))

        f.write("_symmetry_space_group_name_H-M    P1\n")
        f.write("_symmetry_Int_Tables_number       1\n")
        f.write("_symmetry_cell_setting            triclinic\n")

        f.write("loop_\n")
        f.write("_symmetry_equiv_pos_as_xyz\n")
        f.write("'x, y, z'\n")

        # Calculate cell parameters.
        positions = atoms.get_positions()
        com = atoms.get_center_of_mass()

        distances = np.linalg.norm(positions - com, axis=1)
        max_distances = np.max(distances)

        box_length = 2 * max_distances + 4

        f.write("_cell_length_a     {:.3f}\n".format(box_length))
        f.write("_cell_length_b     {:.3f}\n".format(box_length))
        f.write("_cell_length_c     {:.3f}\n".format(box_length))
        f.write("_cell_angle_alpha  90.0\n")
        f.write("_cell_angle_beta   90.0\n")
        f.write("_cell_angle_gamma  90.0\n")

        f.write("loop_\n")
        f.write("_atom_site_label\n")
        f.write("_atom_site_type_symbol\n")
        f.write("_atom_site_fract_x\n")
        f.write("_atom_site_fract_y\n")
        f.write("_atom_site_fract_z\n")
        f.write("_atom_type_partial_charge\n")

        # Get fractional coordinates
        # fractional coordinate of C.O.M is (0.5, 0.5, 0.5).
        symbols = atoms.get_chemical_symbols()
        charges = atoms.get_initial_charges()
        fracts = (positions - com) / box_length + 0.5

        # Write label and pos information.
        for i, (sym, fract, charge) in enumerate(zip(symbols, fracts, charges)):
            label = "{}{}".format(sym, i)
            f.write(
                "{} {} {:.5f} {:.5f} {:.5f} {:.5f}\n".format(label, sym, *fract, charge)
            )

        # Write bonds information.
        f.write("loop_\n")
        f.write("_geom_bond_atom_site_label_1\n")
        f.write("_geom_bond_atom_site_label_2\n")
        f.write("_geom_bond_distance\n")
        f.write("_geom_bond_site_symmetry_2\n")
        f.write("_ccdc_geom_bond_type\n")

        for (i, j), t in zip(bond_pairs, bond_types):
            label_i = "{}{}".format(symbols[i], i)
            label_j = "{}{}".format(symbols[j], j)

            distance = np.linalg.norm(positions[i] - positions[j])

            f.write("{} {} {:.3f} . {}\n".format(label_i, label_j, distance, t))
