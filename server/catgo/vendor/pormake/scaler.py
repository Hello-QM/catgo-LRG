from collections import defaultdict
from itertools import product

import jax
import jax.numpy as jnp
import numpy as np
import scipy as sp
import scipy.optimize

from .log import logger
from .utils import bound_values


class Scaler:
    """
    Scale topology using given nodes and edges building blocks information.
    """

    def __init__(self, length_weight=1.0):
        """
        Inputs:
            topology: topology
            bbs: list of BuildingBlocks. The order of bb have to be same as
                topology.
            permutations
        """
        self.length_weight = length_weight

    def scale(self, topology, bbs, perms, return_result=False):
        """
        Scale topology using building block information.
        Both lengths and angles are optimized during the process.
        """
        logger.debug("Scaler.scale starts.")

        # Get pairs of bond indices and images (periodic boundary) and
        pairs = []
        images = []
        c = topology.atoms.cell
        invc = np.linalg.inv(c)
        for e in topology.edge_indices:
            # ni: neigbor with index i.
            ni, nj = topology.neighbor_list[e]

            i = ni.index
            j = nj.index

            # Save index pair.
            pairs.append([i, j])

            # Calculate image.
            # d = d_{ij}
            d = nj.distance_vector - ni.distance_vector

            ri = topology.atoms.positions[i]
            rj = topology.atoms.positions[j]
            s = (d - (rj - ri)) @ invc

            images.append(s)

        # Type casting to np.array.
        pairs = np.array(pairs)
        images = np.around(images)

        # Calculate target norms and vectors for angles.
        # ij_vectors: list of vectors node i to j with building block size.
        ij_vectors = []
        ji_vectors = []
        for e in topology.edge_indices:
            # ni: neigbor with index i.
            ni, nj = topology.neighbor_list[e]

            i = ni.index
            j = nj.index

            # Find connection point index.
            for ci, n in enumerate(topology.neighbor_list[i]):
                zero_sum = np.abs(n.distance_vector + ni.distance_vector)
                if (zero_sum < 1e-3).all():
                    # ci saved.
                    break

            for cj, n in enumerate(topology.neighbor_list[j]):
                zero_sum = np.abs(n.distance_vector + nj.distance_vector)
                if (zero_sum < 1e-3).all():
                    # cj saved.
                    break

            # Get node bb length to the connection point.
            # cp: connection point.
            bb = bbs[i]
            p = perms[i]
            len_i = bb.lengths[p][ci]
            vec_i = bb.connection_points[p][ci] - bb.centroid

            bb = bbs[j]
            p = perms[j]
            len_j = bb.lengths[p][cj]
            vec_j = bb.connection_points[p][cj] - bb.centroid

            edge_length = len_i + len_j
            if bbs[e] is not None:
                edge_length += 2 * bbs[e].lengths[0]

            # Rescaling.
            vec_i = vec_i / np.linalg.norm(vec_i) * edge_length
            vec_j = vec_j / np.linalg.norm(vec_j) * edge_length

            ij_vectors.append(vec_i)
            ji_vectors.append(vec_j)

        # Cast to numpy array.
        ij_vectors = np.array(ij_vectors)
        ji_vectors = np.array(ji_vectors)

        # Get angle triples.
        # Triples are used for tensor operations during optimization.

        # New data view of pairs and images for estimation of triples.
        data_view = defaultdict(list)
        for (i, j), image in zip(pairs, images):
            data_view[i].append((j, image))
            data_view[j].append((i, -image))

        # Triples for the calculatation of dots between r_{ij} and r_{ik}.
        ij = []
        ik = []

        ij_image = []
        ik_image = []

        # Weights for objective function.
        weights = []

        for i in topology.node_indices:
            neigbors = data_view[i]
            for (j, j_image), (k, k_image) in product(neigbors, repeat=2):
                ij.append([i, j])
                ik.append([i, k])

                ij_image.append(j_image)
                ik_image.append(k_image)

                if (j == k) and np.allclose(j_image, k_image):
                    # 2 for count collection for dot product of same edges.
                    weights.append(2 * self.length_weight)
                else:
                    weights.append(1.0)

        # Type cast.
        ij = np.array(ij)
        ik = np.array(ik)

        ij_image = np.array(ij_image)
        ik_image = np.array(ik_image)

        weights = np.array(weights)

        # Calculate target angles.
        # Similar method to above loops.
        vectors_view = defaultdict(list)
        for (i, j), v_ij, v_ji in zip(pairs, ij_vectors, ji_vectors):
            vectors_view[i].append(v_ij)
            vectors_view[j].append(v_ji)

        # Now, i represents node i (center). j and k are represent indices of
        # connection points from i.
        target_dots = []
        target_ij_vec = []
        target_ik_vec = []
        for i in topology.node_indices:
            # Get all connection point vectors of node i.
            vectors = vectors_view[i]
            # Product includes self dot product (vj == vk).
            for vj, vk in product(vectors, repeat=2):
                target_ij_vec.append(vj)
                target_ik_vec.append(vk)

        target_ij_vec = np.array(target_ij_vec)
        target_ik_vec = np.array(target_ik_vec)

        target_dots = np.sum(target_ij_vec * target_ik_vec, axis=-1)

        # Get max / min ratio of edge length.
        lengths = np.sqrt(target_dots[weights > 1.1])
        # for l in lengths:
        #    logger.info("Length: %.3f", l)
        max_len = np.max(lengths)
        min_len = np.min(lengths)
        ratio = max_len / min_len
        logger.debug("Max min ratio of edge length: %.3f", ratio)

        # Normalize target dots. This enhances the optimization convegences.
        max_dot = np.mean(np.abs(target_dots))
        target_dots /= max_dot

        # Helper functions for calculation of objective function.
        def calc_dots(s, c):
            """
            Inputs:
                s: scaled positions.
                c: cell matrix (row is a lattice vector).
            External variables:
                topology, pairs, image, ij, ik, ij_image, ik_image.
            """
            # diff becames n x n x 3 tensor with element of
            # diff[i, j, :] = si - sj.
            diff = s[jnp.newaxis, :, :] - s[:, jnp.newaxis, :]

            ij_vecs = (diff[ij[:, 0], ij[:, 1], :] + ij_image) @ c
            ik_vecs = (diff[ik[:, 0], ik[:, 1], :] + ik_image) @ c

            dots = jnp.sum(ij_vecs * ik_vecs, axis=-1)

            return dots

        def objective(s, c):
            dots = calc_dots(s, c)
            return jnp.mean(jnp.square(dots - target_dots) * weights)

        # Functions for scipy interface.
        def fun(x):
            n = topology.n_slots

            s = jnp.reshape(x[:-9], (n, 3))
            c = jnp.reshape(x[-9:], (3, 3))

            v = objective(s, c)

            return v

        jac = jax.jit(jax.grad(fun))

        def fun_numpy(x):
            return np.array(fun(x), dtype=np.float64)

        def jac_numpy(x):
            return np.array(jac(x), dtype=np.float64)

        # Prepare geometry optimization.
        # Make initial value.
        # cell[:] cast ase.Cell to numpy array.
        c = topology.atoms.cell[:]
        s = topology.atoms.get_scaled_positions()
        x0 = np.concatenate([s.reshape(-1), c.reshape(-1)])

        # Bounds.
        zeros = np.zeros(shape=s.size)
        ones = np.ones(shape=s.size)

        # Constaints for scaled positions.
        bounds = np.stack([zeros, ones], axis=1).tolist()
        # No constraints on cell matrix values.
        for i in range(9):
            bounds.append([None, None])

        logger.info("Topology optimization starts.")
        # Perform optimization.
        result = sp.optimize.minimize(
            x0=x0,
            fun=fun_numpy,
            jac=jac_numpy,
            method="L-BFGS-B",
            bounds=bounds,
            options={"maxiter": 1000, "disp": False},
        )

        n = topology.n_slots
        # Get output x.
        x = result.x
        c = x[-9:].reshape(3, 3)
        s = x[:-9].reshape(n, 3)

        logger.info("MESSAGE: %s", result.message)
        logger.info("SUCCESS: %s", result.success)
        logger.info("ITER: %s", result.nit)
        logger.info("OBJ: %.3f", result.fun)

        # Update neigbors list in topology.
        new_data = [[] for _ in range(topology.n_slots)]
        # Rescaling cell to original scale.
        c *= np.sqrt(max_dot)
        # Transform to Cartesian coordinates.
        r = s @ c
        invc = np.linalg.inv(c)
        inv_old_c = np.linalg.inv(topology.atoms.cell)
        for e in topology.edge_indices:
            ni, nj = topology.neighbor_list[e]

            i = ni.index
            j = nj.index

            ri = topology.atoms.positions[i]
            rj = topology.atoms.positions[j]

            d = nj.distance_vector - ni.distance_vector

            image = (d - (rj - ri)) @ inv_old_c

            # Calculate new edge center.
            ri = r[i]
            rj = r[j]

            d = rj - ri + np.dot(image, c)

            # Select center position wrapped by unit cell.
            rc = ri + 0.5 * d
            sc = np.dot(rc, invc)
            # Boundary wrap
            sc = bound_values(sc)
            if (sc < 0).any() or (sc > 1).any():
                rc = np.around(rj - 0.5 * d, decimals=3)
            r[e] = rc

            # Save in proper order.
            new_data[e] += [(i, -0.5 * d), (j, 0.5 * d)]

        # Should change this stupidly nested loop.
        # The new neigbor list is updated with same order of original neigbor
        # list. Then we can use the permutation information for new location
        # after topology scaling.
        for i in topology.node_indices:
            # Same order loop. Note that topology is the original.
            for n in topology.neighbor_list[i]:
                e = n.index
                d = n.distance_vector
                # Find cross reference.
                for j, en in enumerate(topology.neighbor_list[e]):
                    if np.linalg.norm(d + en.distance_vector) < 1e-4:
                        # j and en saved.
                        break

                _, v = new_data[e][j]
                new_data[i].append((e, -v))

        # Make scaled topology.
        s = np.dot(r, invc)
        s = bound_values(s)
        r = np.dot(s, c)

        scaled_topology = topology.copy()
        scaled_topology.atoms.set_positions(r)
        scaled_topology.atoms.set_cell(c)
        scaled_topology.neighbor_list.set_data(new_data)

        if return_result:
            return scaled_topology, result
        else:
            return scaled_topology
