//! Periodic graph with offset-aware adjacency lists.
//!
//! Each edge carries a periodic image offset [i32; 3] indicating which
//! unit cell the destination atom is in relative to the source.

use crate::bonding::Bond;

/// A neighbor in the periodic graph: vertex index + periodic offset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PeriodicNeighbor {
    /// Vertex (atom) index.
    pub v: usize,
    /// Periodic offset (cell image) of this neighbor.
    pub ofs: [i32; 3],
}

/// Adjacency-list graph where edges carry periodic offsets.
///
/// Built from `Bond` list. For each bond (a, b, image), creates two
/// directed edges: a→(b, image) and b→(a, -image).
#[derive(Debug, Clone)]
pub struct PeriodicGraph {
    pub n_vertices: usize,
    adjacency: Vec<Vec<PeriodicNeighbor>>,
}

impl PeriodicGraph {
    /// Build from a list of bonds with periodic image offsets.
    pub fn from_bonds(n_vertices: usize, bonds: &[Bond]) -> Self {
        let mut adjacency = vec![Vec::new(); n_vertices];
        for bond in bonds {
            let a = bond.site_idx_1;
            let b = bond.site_idx_2;
            let img = bond.image;
            if a < n_vertices && b < n_vertices {
                adjacency[a].push(PeriodicNeighbor {
                    v: b,
                    ofs: img,
                });
                adjacency[b].push(PeriodicNeighbor {
                    v: a,
                    ofs: [-img[0], -img[1], -img[2]],
                });
            }
        }
        Self { n_vertices, adjacency }
    }

    /// Get all neighbors of vertex `v`.
    pub fn neighbors(&self, v: usize) -> &[PeriodicNeighbor] {
        &self.adjacency[v]
    }

    /// Get the degree (number of neighbors) of vertex `v`.
    pub fn degree(&self, v: usize) -> usize {
        self.adjacency[v].len()
    }

    /// Add a directed edge from `src` to `dst` with offset.
    /// Also adds the reverse edge from `dst` to `src` with negated offset.
    pub fn add_edge(&mut self, src: usize, dst: usize, ofs: [i32; 3]) {
        self.adjacency[src].push(PeriodicNeighbor { v: dst, ofs });
        self.adjacency[dst].push(PeriodicNeighbor {
            v: src,
            ofs: [-ofs[0], -ofs[1], -ofs[2]],
        });
    }

    /// Remove all edges between `src` and `dst` (both directions).
    pub fn remove_edges_between(&mut self, src: usize, dst: usize) {
        self.adjacency[src].retain(|n| n.v != dst);
        self.adjacency[dst].retain(|n| n.v != src);
    }
}
