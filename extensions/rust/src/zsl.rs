//! Zur–McGill lattice matching algorithm.
//!
//! Faithful Rust reimplementation of pymatgen's
//! `pymatgen.analysis.interfaces.zsl.ZSLGenerator`. Given the two in-plane
//! lattice vectors of a film and a substrate surface, it enumerates all
//! coincident super-lattices within area / length / angle tolerances.
//!
//! Reference: Zur & McGill, J. Appl. Phys. 55 (1984) 378, doi:10.1063/1.333084.
//!
//! The vectors are treated as 3D (the in-plane vectors generally have a
//! nonzero z=0 component) and all geometric quantities (cross product, angle,
//! area) use the full 3D vectors, exactly as pymatgen does.

use nalgebra::Vector3;

/// A 2D super-lattice basis: two 3D vectors.
pub type Vec2 = [Vector3<f64>; 2];

/// A single Zur–McGill match between a film and substrate super-lattice.
#[derive(Debug, Clone)]
pub struct ZslMatch {
    /// Reduced film super-lattice vectors (3D).
    pub film_sl_vectors: Vec2,
    /// Reduced substrate super-lattice vectors (3D).
    pub substrate_sl_vectors: Vec2,
    /// Integer 2x2 transformation applied to the film unit-cell vectors.
    pub film_transformation: [[i64; 2]; 2],
    /// Integer 2x2 transformation applied to the substrate unit-cell vectors.
    pub substrate_transformation: [[i64; 2]; 2],
}

impl ZslMatch {
    /// Area of the matched super-lattice (from the film super-lattice vectors).
    pub fn match_area(&self) -> f64 {
        vec_area(&self.film_sl_vectors[0], &self.film_sl_vectors[1])
    }
}

/// Generator parameters mirroring pymatgen's `ZSLGenerator.__init__`.
#[derive(Debug, Clone, Copy)]
pub struct ZslGenerator {
    /// Max tolerance on ratio of super-lattice areas to consider equal.
    pub max_area_ratio_tol: f64,
    /// Max super-lattice area to generate in the search (Å²).
    pub max_area: f64,
    /// Max relative length tolerance for matching vectors.
    pub max_length_tol: f64,
    /// Max relative angle tolerance for matching vector pairs.
    pub max_angle_tol: f64,
    /// Whether to allow matching with film/substrate roles swapped.
    pub bidirectional: bool,
}

impl Default for ZslGenerator {
    fn default() -> Self {
        Self {
            max_area_ratio_tol: 0.09,
            max_area: 400.0,
            max_length_tol: 0.03,
            max_angle_tol: 0.01,
            bidirectional: false,
        }
    }
}

/// Fast Euclidean norm of a 3D vector.
#[inline]
fn fast_norm(a: &Vector3<f64>) -> f64 {
    a.dot(a).sqrt()
}

/// Area of the lattice plane defined by two vectors (= |a × b|).
#[inline]
pub fn vec_area(a: &Vector3<f64>, b: &Vector3<f64>) -> f64 {
    fast_norm(&a.cross(b))
}

/// Angle (radians) between two vectors via atan2(|a×b|, a·b).
#[inline]
fn vec_angle(a: &Vector3<f64>, b: &Vector3<f64>) -> f64 {
    let cos_ang = a.dot(b);
    let sin_ang = fast_norm(&a.cross(b));
    sin_ang.atan2(cos_ang)
}

/// Relative strain between two vectors: |b| / |a| - 1.
#[inline]
fn rel_strain(v1: &Vector3<f64>, v2: &Vector3<f64>) -> f64 {
    fast_norm(v2) / fast_norm(v1) - 1.0
}

/// Relative angle between two vector pairs.
#[inline]
fn rel_angle(set1: &Vec2, set2: &Vec2) -> f64 {
    vec_angle(&set2[0], &set2[1]) / vec_angle(&set1[0], &set1[1]) - 1.0
}

/// Reduce two vectors to an independent, unique basis (Zur & McGill).
///
/// Recursive, mirroring pymatgen's `reduce_vectors`.
fn reduce_vectors(a: Vector3<f64>, b: Vector3<f64>) -> Vec2 {
    if a.dot(&b) < 0.0 {
        return reduce_vectors(a, -b);
    }
    let norm_b = fast_norm(&b);
    if fast_norm(&a) > norm_b {
        return reduce_vectors(b, a);
    }
    if norm_b > fast_norm(&(b + a)) {
        return reduce_vectors(a, b + a);
    }
    if norm_b > fast_norm(&(b - a)) {
        return reduce_vectors(a, b - a);
    }
    [a, b]
}

/// All factors of `n` in ascending order.
fn get_factors(n: i64) -> Vec<i64> {
    (1..=n).filter(|x| n % x == 0).collect()
}

/// Generate the integer 2x2 transformation matrices that convert a unit cell
/// into a super-lattice of integer `area_multiple` (Cassels).
///
/// Matches pymatgen `gen_sl_transform_matrices`: for each factor i of the
/// area and each j in [0, area/i), produce [[i, j], [0, area/i]].
fn gen_sl_transform_matrices(area_multiple: i64) -> Vec<[[i64; 2]; 2]> {
    let mut out = Vec::new();
    for i in get_factors(area_multiple) {
        let q = area_multiple / i;
        for j in 0..q {
            out.push([[i, j], [0, q]]);
        }
    }
    out
}

/// Apply an integer 2x2 transformation to a pair of 3D basis vectors.
///
/// row r of the transform combines basis vectors: out[r] = T[r][0]*v0 + T[r][1]*v1.
/// This matches numpy `np.dot(T, vectors)` where `vectors` is a 2x3 array.
fn apply_transform(t: &[[i64; 2]; 2], vecs: &Vec2) -> Vec2 {
    [
        vecs[0] * (t[0][0] as f64) + vecs[1] * (t[0][1] as f64),
        vecs[0] * (t[1][0] as f64) + vecs[1] * (t[1][1] as f64),
    ]
}

/// Determine if two vector pairs are the same within length / angle tolerances.
fn unidirectional_is_same(set1: &Vec2, set2: &Vec2, max_length_tol: f64, max_angle_tol: f64) -> bool {
    if rel_strain(&set1[0], &set2[0]).abs() > max_length_tol {
        return false;
    }
    if rel_strain(&set1[1], &set2[1]).abs() > max_length_tol {
        return false;
    }
    rel_angle(set1, set2).abs() <= max_angle_tol
}

fn is_same_vectors(
    set1: &Vec2,
    set2: &Vec2,
    bidirectional: bool,
    max_length_tol: f64,
    max_angle_tol: f64,
) -> bool {
    if bidirectional {
        unidirectional_is_same(set1, set2, max_length_tol, max_angle_tol)
            || unidirectional_is_same(set2, set1, max_length_tol, max_angle_tol)
    } else {
        unidirectional_is_same(set1, set2, max_length_tol, max_angle_tol)
    }
}

impl ZslGenerator {
    /// Generate the (film, substrate) transformation-set pairs whose area
    /// multiples are nearly equal, in ascending order of i*j (matches
    /// pymatgen `generate_sl_transformation_sets`).
    fn generate_sl_transformation_sets(
        &self,
        film_area: f64,
        substrate_area: f64,
    ) -> Vec<(Vec<[[i64; 2]; 2]>, Vec<[[i64; 2]; 2]>)> {
        let n_film = (self.max_area / film_area).ceil() as i64;
        let n_sub = (self.max_area / substrate_area).ceil() as i64;

        // Collect (i, j) index pairs into a set (dedup), then sort by i*j.
        let mut indices: std::collections::HashSet<(i64, i64)> = std::collections::HashSet::new();
        for ii in 1..n_film {
            for jj in 1..n_sub {
                if (film_area / substrate_area - (jj as f64) / (ii as f64)).abs()
                    < self.max_area_ratio_tol
                {
                    indices.insert((ii, jj));
                }
            }
        }
        for ii in 1..n_film {
            for jj in 1..n_sub {
                if (substrate_area / film_area - (ii as f64) / (jj as f64)).abs()
                    < self.max_area_ratio_tol
                {
                    indices.insert((ii, jj));
                }
            }
        }

        let mut sorted: Vec<(i64, i64)> = indices.into_iter().collect();
        // Sort by product i*j ascending. Python's `sorted` is stable but the
        // input is a set (unordered); ties on i*j may appear in any order.
        // We add (i, j) as a secondary key for deterministic output.
        sorted.sort_by_key(|&(i, j)| (i * j, i, j));

        sorted
            .into_iter()
            .map(|(ii, jj)| (gen_sl_transform_matrices(ii), gen_sl_transform_matrices(jj)))
            .collect()
    }

    /// Run the full ZSL algorithm, returning all matches in generation order
    /// (mirrors pymatgen's `ZSLGenerator.__call__` iterator order).
    pub fn generate(&self, film_vectors: &Vec2, substrate_vectors: &Vec2) -> Vec<ZslMatch> {
        let film_area = vec_area(&film_vectors[0], &film_vectors[1]);
        let substrate_area = vec_area(&substrate_vectors[0], &substrate_vectors[1]);

        let mut matches = Vec::new();

        let transformation_sets =
            self.generate_sl_transformation_sets(film_area, substrate_area);

        for (film_transforms, sub_transforms) in &transformation_sets {
            // Apply + reduce all film and substrate super-lattices.
            let films: Vec<Vec2> = film_transforms
                .iter()
                .map(|t| {
                    let v = apply_transform(t, film_vectors);
                    reduce_vectors(v[0], v[1])
                })
                .collect();
            let substrates: Vec<Vec2> = sub_transforms
                .iter()
                .map(|t| {
                    let v = apply_transform(t, substrate_vectors);
                    reduce_vectors(v[0], v[1])
                })
                .collect();

            // pymatgen zips product(film_transforms, sub_transforms) with
            // product(films, substrates) — i.e. the outer loop is film, inner
            // is substrate, aligned index-for-index.
            for (fi, f_trans) in film_transforms.iter().enumerate() {
                for (si, s_trans) in sub_transforms.iter().enumerate() {
                    let f = &films[fi];
                    let s = &substrates[si];
                    if is_same_vectors(
                        f,
                        s,
                        self.bidirectional,
                        self.max_length_tol,
                        self.max_angle_tol,
                    ) {
                        matches.push(ZslMatch {
                            film_sl_vectors: *f,
                            substrate_sl_vectors: *s,
                            film_transformation: *f_trans,
                            substrate_transformation: *s_trans,
                        });
                    }
                }
            }
        }

        matches
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f64, y: f64) -> Vector3<f64> {
        Vector3::new(x, y, 0.0)
    }

    #[test]
    fn factors_of_12() {
        assert_eq!(get_factors(12), vec![1, 2, 3, 4, 6, 12]);
    }

    #[test]
    fn sl_transform_count() {
        // For area multiple n, count = sum over factors i of (n/i) = sum of divisors.
        // n=4: factors 1,2,4 -> 4 + 2 + 1 = 7 matrices.
        assert_eq!(gen_sl_transform_matrices(4).len(), 7);
    }

    #[test]
    fn reduce_simple_square() {
        let r = reduce_vectors(v(3.0, 0.0), v(0.0, 3.0));
        // Already reduced (shortest, positive dot? dot=0 ok).
        assert!((fast_norm(&r[0]) - 3.0).abs() < 1e-9);
        assert!((fast_norm(&r[1]) - 3.0).abs() < 1e-9);
    }

    #[test]
    fn matches_mismatched_square() {
        // sub a=b=3.0, film a=b=3.15. With loose tol there should be n x n matches.
        let sub = [v(3.0, 0.0), v(0.0, 3.0)];
        let film = [v(3.15, 0.0), v(0.0, 3.15)];
        let zgen = ZslGenerator {
            max_area: 200.0,
            max_area_ratio_tol: 0.09,
            max_length_tol: 0.06,
            max_angle_tol: 0.02,
            bidirectional: false,
        };
        let matches = zgen.generate(&film, &sub);
        assert!(!matches.is_empty(), "expected at least one match");
        // There should be a 1x10 / 1x9 style match (area ~89.3).
        let has = matches.iter().any(|m| (m.match_area() - 89.3).abs() < 1.0);
        assert!(has, "expected an ~89.3 Å² match");
    }
}
