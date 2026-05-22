//! PCA auto-orient — faithful port of xyzrender `src/xyzrender/utils.py:61-128`
//! (`pca_orient`, read VERBATIM from a `--depth 1` clone of
//! github.com/aligfellow/xyzrender).
//!
//! Semantics replicated branch-by-branch:
//!  - centroid = arithmetic mean (NOT mass-weighted) of the *fit* atoms;
//!    all positions are centered around that centroid (← `utils.py:77-80`).
//!  - degenerate (`len(c_fit) < 2` OR all coincident `atol=1e-12`) →
//!    return centered positions with identity rotation (`utils.py:83-84`).
//!  - diatomic (`len(c_fit) == 2`) → bond placed along +x via deterministic
//!    orthonormal completion: `ref = eye(3)[argmin(|ax|)]`,
//!    `z = norm(ax×ref)`, `y = z×ax`, `rot = [ax, y, z]`,
//!    `oriented = c @ rot.T` (`utils.py:87-96`).
//!  - else: covariance principal axes. Upstream does
//!    `_,_,vt = np.linalg.svd(c_weighted)`. The right-singular vectors of
//!    `X` are exactly the eigenvectors of `Xᵀ X`, so we form the symmetric
//!    3×3 `C = Xᵀ X`, eigen-decompose it (Jacobi rotation sweep — no-std /
//!    WASM friendly, no external crate), and order the eigenvectors by
//!    DESCENDING eigenvalue into the rows of `vt` (PC1→x, PC2→y, PC3→z
//!    = depth). Det-fix exactly as upstream: `if det(vt) < 0 { vt[-1] *= -1 }`
//!    then `oriented = c @ vt.T` (`utils.py:98-112`).
//!  - `priority_pairs` (TS bonds): duplicate those centered fit rows and
//!    scale by `priority_weight = 5.0`, `vstack` before the covariance, then
//!    a post-SVD in-plane z-rotation aligning the mean TS-bond direction to
//!    +x: `theta = -atan2(avg_dir.y, avg_dir.x)`, `rz`, `rot = rz@rot`,
//!    `oriented = oriented @ rz.T` (`utils.py:98-124`).
//!
//! HANDEDNESS / PARITY CAVEAT (documented per spec §"PCA auto-orient"):
//! SVD of `X` and eigendecomposition of `Xᵀ X` recover the SAME principal
//! axes, and the spec explicitly accepts the det-fixed eigenbasis — a
//! bit-identical LAPACK SVD sign is NOT required. xyzrender itself performs
//! NO sign canonicalization beyond the det-fix, so its output sign is
//! arbitrary; consequently two mirror-symmetric inputs may differ in
//! handedness from upstream. This is acceptable and intentional (the spec
//! says "replicate, do not improve").

/// `fit_mask`: when `Some`, only those positions compute the PCA axes; the
/// rotation is still applied to ALL positions (prevents NCI centroid dummy
/// nodes from biasing the orientation — `utils.py:73-77`). `mask[i] == true`
/// keeps row `i` in the fit set.

/// TS priority up-weight (xyzrender utils.py priority_weight=5.0)
const PRIORITY_WEIGHT: f64 = 5.0;

// cyclic Jacobi (Golub & Van Loan §8.4); bounded sweep cap guarantees termination
const JACOBI_MAX_SWEEPS: usize = 50;
const JACOBI_OFFDIAG_EPS: f64 = 1e-300;
const JACOBI_PAIR_EPS: f64 = 1e-30;
const JACOBI_CONVERGED: f64 = 1e-18;

/// Faithful `pca_orient`. Returns centered + rotated positions.
///
/// `priority` indices address the *fit subset* (post-`fit_mask`), 0-based;
/// out-of-range pairs are silently skipped (degrades to plain PCA if none valid).
pub fn pca_orient(pos: &[[f64; 3]], priority: Option<&[(usize, usize)]>) -> Vec<[f64; 3]> {
    pca_orient_full(pos, priority, None).0
}

/// As [`pca_orient`] but also returns the cumulative 3×3 rotation matrix
/// (`rot`, row-major) for the corner axis gizmo. Row `k` of `rot` is the
/// world-space axis that maps to local axis `k` (matches upstream `rot`).
///
/// `priority` indices address the *fit subset* (post-`fit_mask`), 0-based;
/// out-of-range pairs are silently skipped (degrades to plain PCA if none valid).
pub fn pca_orient_with_matrix(
    pos: &[[f64; 3]],
    priority: Option<&[(usize, usize)]>,
) -> (Vec<[f64; 3]>, [[f64; 3]; 3]) {
    pca_orient_full(pos, priority, None)
}

/// Full form exposing `fit_mask` (NCI `*` exclusion — `utils.py:77`).
///
/// `priority` indices address the *fit subset* (post-`fit_mask`), 0-based;
/// out-of-range pairs are silently skipped (degrades to plain PCA if none valid).
pub fn pca_orient_with_mask(
    pos: &[[f64; 3]],
    priority: Option<&[(usize, usize)]>,
    fit_mask: Option<&[bool]>,
) -> (Vec<[f64; 3]>, [[f64; 3]; 3]) {
    pca_orient_full(pos, priority, fit_mask)
}

/// Centroid PCA centers around: arithmetic mean of the *fit* atoms
/// (`fit_mask == Some` selects the subset; `None` = all). Matches
/// `utils.py:77-78`. Exposed so the cell box can take the SAME centering the
/// atoms get (else atoms drift off the lattice corners).
pub fn fit_centroid(pos: &[[f64; 3]], fit_mask: Option<&[bool]>) -> [f64; 3] {
    let n = pos.len();
    let fit_idx: Vec<usize> = match fit_mask {
        Some(m) => (0..n).filter(|&i| m.get(i).copied().unwrap_or(false)).collect(),
        None => (0..n).collect(),
    };
    let mut centroid = [0.0_f64; 3];
    for &i in &fit_idx {
        for k in 0..3 {
            centroid[k] += pos[i][k];
        }
    }
    let fc = fit_idx.len().max(1) as f64;
    for k in 0..3 {
        centroid[k] /= fc;
    }
    centroid
}

fn pca_orient_full(
    pos: &[[f64; 3]],
    priority: Option<&[(usize, usize)]>,
    fit_mask: Option<&[bool]>,
) -> (Vec<[f64; 3]>, [[f64; 3]; 3]) {
    let n = pos.len();
    if n == 0 {
        return (Vec::new(), IDENTITY);
    }

    // fit = pos[fit_mask] if fit_mask is not None else pos      (utils.py:77)
    let fit_idx: Vec<usize> = match fit_mask {
        Some(m) => (0..n).filter(|&i| m.get(i).copied().unwrap_or(false)).collect(),
        None => (0..n).collect(),
    };

    // centroid = fit.mean(axis=0)                               (utils.py:78)
    let centroid = fit_centroid(pos, fit_mask);

    // c = pos - centroid (all);  c_fit = fit - centroid         (utils.py:79-80)
    let c: Vec<[f64; 3]> = pos
        .iter()
        .map(|p| [p[0] - centroid[0], p[1] - centroid[1], p[2] - centroid[2]])
        .collect();
    let c_fit: Vec<[f64; 3]> = fit_idx.iter().map(|&i| c[i]).collect();

    // Degenerate: single atom or all coincident                 (utils.py:83-84)
    let all_coincident = c_fit
        .iter()
        .all(|r| r[0].abs() <= 1e-12 && r[1].abs() <= 1e-12 && r[2].abs() <= 1e-12);
    if c_fit.len() < 2 || all_coincident {
        return (c, IDENTITY);
    }

    // Diatomic: align bond along x                               (utils.py:87-96)
    if c_fit.len() == 2 {
        let mut ax = sub(c_fit[1], c_fit[0]);
        let na = norm(ax);
        ax = [ax[0] / na, ax[1] / na, ax[2] / na];
        // ref = np.eye(3)[np.argmin(np.abs(ax))]
        let argmin = {
            let a = [ax[0].abs(), ax[1].abs(), ax[2].abs()];
            if a[0] <= a[1] && a[0] <= a[2] {
                0
            } else if a[1] <= a[2] {
                1
            } else {
                2
            }
        };
        let mut reff = [0.0; 3];
        reff[argmin] = 1.0;
        let mut z = cross(ax, reff);
        let nz = norm(z);
        z = [z[0] / nz, z[1] / nz, z[2] / nz];
        let y = cross(z, ax);
        let rot = [ax, y, z]; // rot = np.vstack([ax, y, z])
        return (apply_rot_t(&c, &rot), rot);
    }

    // Build c_weighted: duplicate priority rows ×PRIORITY_WEIGHT (utils.py:98-106)
    let mut weighted: Vec<[f64; 3]> = c_fit.clone();
    if let Some(pp) = priority {
        if !pp.is_empty() {
            // priority indices address the fit subset (c_fit), 0-based.
            // Out-of-range pairs are skipped (no panic); if every pair is
            // skipped, `weighted` stays == c_fit → plain PCA (defensive
            // style mirrors fit_mask's `unwrap_or(false)`).
            for &(i, j) in pp {
                if i < c_fit.len() && j < c_fit.len() {
                    weighted.push(scale(c_fit[i], PRIORITY_WEIGHT));
                    weighted.push(scale(c_fit[j], PRIORITY_WEIGHT));
                } else {
                    continue;
                }
            }
        }
    }

    // _,_,vt = svd(c_weighted); right-singular vectors == eigvecs of XᵀX.
    // Symmetric covariance C = Xᵀ X.
    let mut cov = [[0.0_f64; 3]; 3];
    for r in &weighted {
        for a in 0..3 {
            for b in 0..3 {
                cov[a][b] += r[a] * r[b];
            }
        }
    }
    let (evals, evecs) = jacobi_eig_3x3(&cov);

    // Order eigenvectors by DESCENDING eigenvalue into rows of vt.
    let mut order = [0usize, 1, 2];
    // NaN-safe: huge coords can overflow covariance → NaN eigenvalue.
    // total_cmp == partial_cmp ordering for all finite values (identical
    // descending order); only defines a position for NaN instead of panicking.
    order.sort_by(|&a, &b| evals[b].total_cmp(&evals[a]));
    // vt row k = eigenvector for the k-th largest eigenvalue.
    let mut vt = [[0.0_f64; 3]; 3];
    for k in 0..3 {
        let col = order[k];
        vt[k] = [evecs[0][col], evecs[1][col], evecs[2][col]];
    }

    // Ensure proper rotation (det=+1)                            (utils.py:108-110)
    if det3(&vt) < 0.0 {
        vt[2] = [-vt[2][0], -vt[2][1], -vt[2][2]];
    }

    let mut rot = vt; // cumulative rotation matrix             (utils.py:111)
    let mut oriented = apply_rot_t(&c, &rot); // oriented = c @ rot.T (utils.py:112)

    // TS bonds: rotate around z to align mean TS dir along +x    (utils.py:115-124)
    if let Some(pp) = priority {
        if !pp.is_empty() {
            // Same fit-subset contract: out-of-range pairs skipped (no
            // panic). If no valid pair remains, `valid` == 0 → mag stays 0
            // → z-rotation skipped → plain-PCA result (graceful degrade).
            let mut avg = [0.0_f64; 2];
            let mut valid = 0usize;
            for &(i, j) in pp {
                if i < oriented.len() && j < oriented.len() {
                    avg[0] += oriented[j][0] - oriented[i][0];
                    avg[1] += oriented[j][1] - oriented[i][1];
                    valid += 1;
                } else {
                    continue;
                }
            }
            let m = valid.max(1) as f64;
            avg[0] /= m;
            avg[1] /= m;
            let mag = if valid == 0 {
                0.0
            } else {
                (avg[0] * avg[0] + avg[1] * avg[1]).sqrt()
            };
            if mag > 1e-6 {
                let theta = -avg[1].atan2(avg[0]);
                let (ct, st) = (theta.cos(), theta.sin());
                let rz = [[ct, -st, 0.0], [st, ct, 0.0], [0.0, 0.0, 1.0]];
                rot = matmul(&rz, &rot); // rot = rz @ rot
                oriented = apply_rot_t(&oriented, &rz); // oriented = oriented @ rz.T
            }
        }
    }

    (oriented, rot)
}

const IDENTITY: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

#[inline]
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
fn scale(a: [f64; 3], s: f64) -> [f64; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}
#[inline]
fn norm(a: [f64; 3]) -> f64 {
    (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
}
#[inline]
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
#[inline]
fn det3(m: &[[f64; 3]; 3]) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

/// `out = c @ rot.T`  (row i of c, dotted with each row of rot).
fn apply_rot_t(c: &[[f64; 3]], rot: &[[f64; 3]; 3]) -> Vec<[f64; 3]> {
    c.iter()
        .map(|p| {
            [
                p[0] * rot[0][0] + p[1] * rot[0][1] + p[2] * rot[0][2],
                p[0] * rot[1][0] + p[1] * rot[1][1] + p[2] * rot[1][2],
                p[0] * rot[2][0] + p[1] * rot[2][1] + p[2] * rot[2][2],
            ]
        })
        .collect()
}

fn matmul(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut o = [[0.0_f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    o
}

/// Classic cyclic Jacobi eigensolver for a real symmetric 3×3 matrix.
/// Returns `(eigenvalues, eigenvectors)` where eigenvector for eigenvalue
/// `eigenvalues[k]` is column `k` of the returned matrix (orthonormal).
/// Converges quadratically; for 3×3 a handful of sweeps reaches machine
/// precision. No external crate (no-std / WASM friendly).
fn jacobi_eig_3x3(input: &[[f64; 3]; 3]) -> ([f64; 3], [[f64; 3]; 3]) {
    let mut a = *input;
    let mut v = IDENTITY;
    for _sweep in 0..JACOBI_MAX_SWEEPS {
        // Largest off-diagonal magnitude.
        let off = a[0][1].abs() + a[0][2].abs() + a[1][2].abs();
        if off < JACOBI_OFFDIAG_EPS {
            break;
        }
        for &(p, q) in &[(0usize, 1usize), (0, 2), (1, 2)] {
            let apq = a[p][q];
            if apq.abs() < JACOBI_PAIR_EPS {
                continue;
            }
            let app = a[p][p];
            let aqq = a[q][q];
            // Jacobi rotation angle (Golub & Van Loan 8.4).
            let phi = 0.5 * (2.0 * apq).atan2(aqq - app);
            let (s, c) = (phi.sin(), phi.cos());
            // Apply J^T A J.
            for k in 0..3 {
                let akp = a[k][p];
                let akq = a[k][q];
                a[k][p] = c * akp - s * akq;
                a[k][q] = s * akp + c * akq;
            }
            for k in 0..3 {
                let apk = a[p][k];
                let aqk = a[q][k];
                a[p][k] = c * apk - s * aqk;
                a[q][k] = s * apk + c * aqk;
            }
            // Accumulate eigenvectors: V = V J.
            for k in 0..3 {
                let vkp = v[k][p];
                let vkq = v[k][q];
                v[k][p] = c * vkp - s * vkq;
                v[k][q] = s * vkp + c * vkq;
            }
        }
        if a[0][1].abs() + a[0][2].abs() + a[1][2].abs() < JACOBI_CONVERGED {
            break;
        }
    }
    ([a[0][0], a[1][1], a[2][2]], v)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Plan RT5 block (verbatim) ------------------------------------
    #[test]
    fn diatomic_along_x() {
        let p = vec![[0., 0., 0.], [0., 0., 2.]];
        let o = pca_orient(&p, None);
        // bond becomes the x axis
        assert!((o[1][0].abs() - 2.0).abs() < 1e-9 || (o[1][0]).abs() > 1e-6);
        assert!(o[1][1].abs() < 1e-9 && o[1][2].abs() < 1e-9);
    }
    #[test]
    fn single_atom_identity() {
        assert_eq!(pca_orient(&vec![[3., 1., 2.]], None)[0], [0., 0., 0.]); // centered
    }
    #[test]
    fn planar_variance_order() {
        // points spread most in X, then Y, ~0 in Z → orientation keeps that order
        let p = vec![[-3., 0., 0.], [3., 0., 0.], [0., -1., 0.], [0., 1., 0.]];
        let o = pca_orient(&p, None);
        let var = |k: usize| {
            let m: f64 = o.iter().map(|q| q[k]).sum::<f64>() / o.len() as f64;
            o.iter().map(|q| (q[k] - m).powi(2)).sum::<f64>()
        };
        assert!(var(0) >= var(1) && var(1) >= var(2));
    }

    // ---- Additional RT5 coverage --------------------------------------

    /// 3-atom L-shape — descending principal-variance order.
    /// Ground truth (xyzrender, run in /tmp/xyzr_atoms):
    ///   python3 -c "import numpy as np,sys;sys.path.insert(0,'src');\
    ///   from xyzrender.utils import pca_orient;\
    ///   p=np.array([[0.,0.,0.],[4.,0.,0.],[0.,2.,0.]]);o=pca_orient(p,None);\
    ///   print([np.var(o[:,k])*3 for k in range(3)])"
    ///   → [11.474068367285323, 1.8592649660480145, 0.0]
    #[test]
    fn lshape_pca_variance_order() {
        let p = vec![[0., 0., 0.], [4., 0., 0.], [0., 2., 0.]];
        let o = pca_orient(&p, None);
        let var = |k: usize| {
            let m: f64 = o.iter().map(|q| q[k]).sum::<f64>() / o.len() as f64;
            o.iter().map(|q| (q[k] - m).powi(2)).sum::<f64>()
        };
        assert!(var(0) >= var(1) && var(1) >= var(2));
        // values match xyzrender to 1e-9 (sum form == var*n)
        assert!((var(0) - 11.474068367285323).abs() < 1e-9);
        assert!((var(1) - 1.8592649660480145).abs() < 1e-9);
        assert!(var(2).abs() < 1e-9);
    }

    /// All-coincident atoms → centered identity (positions all → origin).
    #[test]
    fn coincident_atoms_identity() {
        let p = vec![[5., 5., 5.], [5., 5., 5.], [5., 5., 5.]];
        let (o, rot) = pca_orient_with_matrix(&p, None);
        for r in &o {
            assert!(r[0].abs() < 1e-12 && r[1].abs() < 1e-12 && r[2].abs() < 1e-12);
        }
        assert_eq!(rot, IDENTITY);
    }

    /// Priority pair (TS bond) ends ~horizontal: its mean direction has
    /// y-component ≈ 0 after orient. Cross-checked against xyzrender:
    ///   python3 -c "import numpy as np,sys;sys.path.insert(0,'src');\
    ///   from xyzrender.utils import pca_orient;\
    ///   q=np.array([[0.,0.,0.],[1.,3.,0.],[-2.,1.,.5],[2.,-1.,-.5],[.5,2.,.2]]);\
    ///   o=pca_orient(q,[(0,1)]);d=o[1,:2]-o[0,:2];print(d)"
    ///   → [3.16224202 0.] (y-component vanishes)
    #[test]
    fn priority_pair_horizontal() {
        let q = vec![
            [0., 0., 0.],
            [1., 3., 0.],
            [-2., 1., 0.5],
            [2., -1., -0.5],
            [0.5, 2., 0.2],
        ];
        let o = pca_orient(&q, Some(&[(0, 1)]));
        let dy = o[1][1] - o[0][1];
        assert!(dy.abs() < 1e-9, "TS pair not horizontal: dy={dy}");
    }

    // ---- Eigensolver numeric validation -------------------------------

    /// Validate the Jacobi 3×3 solver against a hand-computed spectrum.
    /// diag(2,3,6) is already diagonal: eigenvalues exactly {2,3,6},
    /// eigenvectors the standard basis.
    #[test]
    fn eigensolver_diagonal_exact() {
        let m = [[2.0, 0.0, 0.0], [0.0, 3.0, 0.0], [0.0, 0.0, 6.0]];
        let (ev, _) = jacobi_eig_3x3(&m);
        let mut s = ev;
        s.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert!((s[0] - 2.0).abs() < 1e-9);
        assert!((s[1] - 3.0).abs() < 1e-9);
        assert!((s[2] - 6.0).abs() < 1e-9);
    }

    /// Known symmetric matrix [[2,1,0],[1,2,0],[0,0,3]]:
    /// eigenvalues = {1, 3, 3} (char. poly (3-λ)((2-λ)²-1)).
    /// Eigenvector for λ=1 is (1,-1,0)/√2. Validate within 1e-9.
    #[test]
    fn eigensolver_known_symmetric() {
        let m = [[2.0, 1.0, 0.0], [1.0, 2.0, 0.0], [0.0, 0.0, 3.0]];
        let (ev, vec) = jacobi_eig_3x3(&m);
        let mut s = ev;
        s.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert!((s[0] - 1.0).abs() < 1e-9, "min eig {} != 1", s[0]);
        assert!((s[1] - 3.0).abs() < 1e-9);
        assert!((s[2] - 3.0).abs() < 1e-9);
        // Find the column whose eigenvalue ≈ 1, check it's ±(1,-1,0)/√2.
        let k = (0..3).find(|&i| (ev[i] - 1.0).abs() < 1e-9).unwrap();
        let col = [vec[0][k], vec[1][k], vec[2][k]];
        let inv = 1.0 / 2.0_f64.sqrt();
        let ok_pos =
            (col[0] - inv).abs() < 1e-9 && (col[1] + inv).abs() < 1e-9 && col[2].abs() < 1e-9;
        let ok_neg =
            (col[0] + inv).abs() < 1e-9 && (col[1] - inv).abs() < 1e-9 && col[2].abs() < 1e-9;
        assert!(ok_pos || ok_neg, "eigenvector mismatch: {col:?}");
        // Orthonormality of the eigenbasis.
        for a in 0..3 {
            for b in 0..3 {
                let dot: f64 = (0..3).map(|r| vec[r][a] * vec[r][b]).sum();
                let want = if a == b { 1.0 } else { 0.0 };
                assert!((dot - want).abs() < 1e-9);
            }
        }
    }

    /// Det-fix is present: the produced rotation matrix is proper (det=+1).
    #[test]
    fn rotation_is_proper() {
        let p = vec![[0., 0., 0.], [4., 0., 0.], [0., 2., 0.], [1., 1., 3.]];
        let (_, rot) = pca_orient_with_matrix(&p, None);
        assert!((det3(&rot) - 1.0).abs() < 1e-9, "det={}", det3(&rot));
    }

    /// fit_mask: a far-flung dummy atom excluded from the fit does not
    /// move the centroid / axes (rotation still applied to all rows).
    #[test]
    fn fit_mask_excludes_dummy() {
        let p = vec![[-3., 0., 0.], [3., 0., 0.], [0., -1., 0.], [0., 1., 0.]];
        let (o_all, _) = pca_orient_with_matrix(&p, None);
        let mut pm = p.clone();
        pm.push([1000., 1000., 1000.]); // NCI-style dummy
        let mask = vec![true, true, true, true, false];
        let (o_masked, _) = pca_orient_with_mask(&pm, None, Some(&mask));
        for i in 0..4 {
            for k in 0..3 {
                assert!((o_all[i][k] - o_masked[i][k]).abs() < 1e-9);
            }
        }
    }

    // ---- RT5 defensive bounds-check coverage --------------------------

    #[test]
    fn priority_out_of_range_skips_not_panic() {
        let p = vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]];
        let o = pca_orient(&p, Some(&[(0usize, 99usize)])); // 99 invalid → skipped → plain PCA
        assert!(o.iter().all(|q| q.iter().all(|v| v.is_finite())));
    }
    #[test]
    fn tiny_variance_is_finite_no_nan() {
        let s = 1e-30;
        let p = vec![[0., 0., 0.], [s, 0., 0.], [0., s, 0.], [s, s, 0.]];
        let o = pca_orient(&p, None);
        assert!(o.iter().all(|q| q.iter().all(|v| v.is_finite())));
    }
    #[test]
    fn short_mask_no_panic_finite() {
        let p = vec![[0., 0., 0.], [2., 0., 0.], [0., 2., 0.]];
        // real signature: (pos, priority, fit_mask); mask shorter than pos
        let o = pca_orient_with_mask(&p, None, Some(&[true, false]));
        assert!(o.0.iter().all(|q| q.iter().all(|v| v.is_finite())));
    }
    /// Zero matrix → degenerate but finite spectrum; eigenvectors identity.
    #[test]
    fn eigensolver_zero_matrix_finite_identity() {
        let (ev, vec) = jacobi_eig_3x3(&[[0.0; 3]; 3]);
        assert!(ev.iter().all(|v| v.is_finite() && v.abs() < 1e-12));
        assert_eq!(vec, IDENTITY);
    }

    #[test]
    fn huge_coords_no_panic() {
        // covariance overflow → NaN eigenvalue must not panic the sort
        let p = vec![
            [1e160, 0.0, 0.0],
            [0.0, 1e160, 0.0],
            [-1e160, 0.0, 1e160],
            [0.0, -1e160, 0.0],
        ];
        let o = pca_orient(&p, None);
        assert_eq!(o.len(), 4); // returns (possibly non-finite) result, does NOT panic
    }
}
