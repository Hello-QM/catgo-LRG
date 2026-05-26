import ase
import ase.neighborlist
import numpy as np

from .log import logger


class Neighbor:
    def __init__(self, index, distance_vector):
        self.index = index
        self.distance_vector = distance_vector

    def __repr__(self):
        return "index: {}, distance vector: {}".format(
            self.index, self.distance_vector
        )


class NeighborList:
    """
    Make the connectivity between nodes and edge centers for the topologies.
    """

    def __init__(self, atoms, method):
        # C for nodes and O for edges.
        if method == "distance":
            self.distance_based_build(atoms)
        elif method == "nearest":
            self.nearest_two_based_build(atoms)
        else:
            logger.error(f"Invalid method {method}.")
            raise Exception("Invalid arguments.")  # Hmm...

    def distance_based_build(self, atoms):
        eps = 1e-3
        cutoffs = {
            ("C", "C"): 0.0,
            ("O", "O"): 0.0,
            ("C", "O"): 0.5 + eps,
        }

        I, J, D = ase.neighborlist.neighbor_list("ijD", atoms, cutoff=cutoffs)

        self.max_index = np.max(I)
        self._neighbor_list = [[] for _ in range(self.max_index + 1)]

        for i, j, d in zip(I, J, D):
            self._neighbor_list[i].append(Neighbor(j, d))

    def nearest_two_based_build(self, atoms):
        # C for nodes and O for edges.
        cutoffs = {
            ("C", "C"): 0.0,
            ("O", "O"): 0.0,
            ("C", "O"): 0.7,
        }

        I, J, D = ase.neighborlist.neighbor_list("ijD", atoms, cutoff=cutoffs)

        self.max_index = np.max(I)
        self._neighbor_list = [[] for _ in range(self.max_index + 1)]

        for i, j, d in zip(I, J, D):
            self._neighbor_list[i].append(Neighbor(j, d))

        # Pick nearest 2 nodes.
        edge_indices = np.argwhere(atoms.symbols == "O").reshape(-1)
        for i in edge_indices:
            neighbor = self._neighbor_list[i]
            # Pick 2 shortest distances
            neighbor.sort(key=lambda x: np.linalg.norm(x.distance_vector))
            self._neighbor_list[i] = neighbor[:2]

        # Remove invalid neighbors of nodes.
        node_indices = np.argwhere(atoms.symbols == "C").reshape(-1)
        for i in node_indices:
            neighbor = []
            for ni in self._neighbor_list[i]:
                j = ni.index
                # Check cross reference.
                if i in [nj.index for nj in self._neighbor_list[j]]:
                    neighbor.append(ni)
            self._neighbor_list[i] = neighbor

    def __getitem__(self, i):
        return self._neighbor_list[i]

    def __iter__(self):
        return iter(self._neighbor_list)

    def set_data(self, data):
        new_list = []
        for neighbor in data:
            new_list.append([])
            for n in neighbor:
                new_list[-1].append(Neighbor(n[0], n[1]))

        self._neighbor_list = new_list

    def __repr__(self):
        output = ""
        for i, neighbor in enumerate(self):
            line = "{}: {}\n".format(i, len(neighbor))
            for n in neighbor:
                line += "{}\n".format(n)
            output += line
        return output
