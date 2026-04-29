"""MD trajectory clustering and dimensionality reduction analysis endpoints.

Provides RMSD-based clustering, collective variable (CV) clustering, and
dimensionality reduction (PCA, t-SNE, UMAP) for visual analysis of AIMD
trajectories. Designed for identifying rare events, structural transitions,
and conformational basins in molecular dynamics simulations.

All distance outputs are in Angstroms. Embedding coordinates are returned
as nested lists of [x, y] (or [x, y, z]) pairs aligned with frame_indices
for scatter plot rendering on the frontend.
"""

from typing import Literal, Optional, Union

import mdtraj as md
import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sklearn.cluster import DBSCAN, AgglomerativeClustering, KMeans
from sklearn.decomposition import PCA
from sklearn.manifold import TSNE
from sklearn.preprocessing import StandardScaler

from .md_utils import load_trajectory

router = APIRouter(prefix="/md/clustering", tags=["md-clustering"])

# mdtraj works in nanometers; users and frontend work in Angstroms
NM_TO_ANGSTROM = 10.0


# ============================================================================
# Helper Functions
# ============================================================================


def compute_pairwise_rmsd(
    traj: md.Trajectory,
    atom_indices: Optional[np.ndarray] = None,
) -> np.ndarray:
    """Compute the full pairwise RMSD distance matrix between all frames.

    Uses mdtraj.rmsd with optimal rigid-body superposition (Kabsch algorithm).
    The resulting matrix is symmetric with zeros on the diagonal.

    Args:
        traj: mdtraj Trajectory (possibly already subsampled by stride).
        atom_indices: Optional subset of atom indices for the RMSD calculation.

    Returns:
        NxN numpy array of pairwise RMSD values in nanometers.
    """
    n_frames = traj.n_frames
    distances = np.empty((n_frames, n_frames), dtype=np.float64)
    for i in range(n_frames):
        distances[i] = md.rmsd(traj, traj, frame=i, atom_indices=atom_indices)
    return distances


def find_representative_frames(
    labels: np.ndarray,
    distance_matrix: np.ndarray,
) -> dict[str, int]:
    """Find the representative frame for each cluster.

    The representative is the frame with the minimum average RMSD to all
    other frames in the same cluster (the medoid).

    Args:
        labels: Cluster assignment for each frame (-1 = noise for DBSCAN).
        distance_matrix: NxN pairwise RMSD distance matrix.

    Returns:
        Dictionary mapping cluster label (as string) to representative frame index.
    """
    unique_labels = set(labels)
    representatives: dict[str, int] = {}

    for label in sorted(unique_labels):
        if label == -1:
            # Noise points in DBSCAN -- no representative
            continue
        cluster_mask = labels == label
        cluster_indices = np.where(cluster_mask)[0]

        if len(cluster_indices) == 1:
            representatives[str(label)] = int(cluster_indices[0])
            continue

        # Extract the sub-distance-matrix for this cluster
        sub_matrix = distance_matrix[np.ix_(cluster_indices, cluster_indices)]
        # Medoid: frame with smallest average distance to others in cluster
        avg_distances = sub_matrix.mean(axis=1)
        medoid_local = np.argmin(avg_distances)
        representatives[str(label)] = int(cluster_indices[medoid_local])

    return representatives


def apply_clustering(
    method: str,
    distance_matrix: np.ndarray,
    feature_matrix: Optional[np.ndarray] = None,
    eps: float = 1.0,
    min_samples: int = 5,
    n_clusters: int = 5,
    linkage: str = "average",
) -> np.ndarray:
    """Apply a clustering algorithm and return labels.

    Args:
        method: One of "dbscan", "hierarchical", "kmeans".
        distance_matrix: NxN pairwise distance matrix (used by DBSCAN and
            hierarchical clustering with precomputed metric).
        feature_matrix: NxM feature matrix (used by KMeans). If None and
            method is "kmeans", the distance_matrix is used as features.
        eps: DBSCAN epsilon parameter (in the same units as distance_matrix).
        min_samples: DBSCAN minimum samples per cluster.
        n_clusters: Number of clusters for hierarchical and KMeans.
        linkage: Linkage criterion for hierarchical clustering.
            "ward" requires euclidean metric (not precomputed), so "average"
            or "complete" are recommended with a precomputed RMSD matrix.

    Returns:
        1-D numpy array of integer cluster labels.

    Raises:
        HTTPException: If the method is unsupported or clustering fails.
    """
    try:
        if method == "dbscan":
            model = DBSCAN(eps=eps, min_samples=min_samples, metric="precomputed")
            labels = model.fit_predict(distance_matrix)
        elif method == "hierarchical":
            if linkage == "ward":
                # Ward linkage does not support precomputed distance matrices.
                # Fall back to using the distance matrix rows as feature vectors.
                model = AgglomerativeClustering(
                    n_clusters=n_clusters,
                    linkage="ward",
                    metric="euclidean",
                )
                labels = model.fit_predict(distance_matrix)
            else:
                model = AgglomerativeClustering(
                    n_clusters=n_clusters,
                    linkage=linkage,
                    metric="precomputed",
                )
                labels = model.fit_predict(distance_matrix)
        elif method == "kmeans":
            # KMeans operates in feature space, not on a distance matrix.
            # If a dedicated feature matrix is provided, use it; otherwise
            # treat the distance matrix rows as feature vectors (an MDS-like
            # approach that often works well in practice).
            data = feature_matrix if feature_matrix is not None else distance_matrix
            model = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
            labels = model.fit_predict(data)
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported clustering method: '{method}'. "
                f"Choose from 'dbscan', 'hierarchical', 'kmeans'.",
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Clustering ({method}) failed: {exc}",
        )

    return np.asarray(labels, dtype=int)


def compute_cluster_sizes(labels: np.ndarray) -> dict[str, int]:
    """Compute the number of frames in each cluster.

    Args:
        labels: 1-D array of cluster labels.

    Returns:
        Dictionary mapping cluster label (as string) to frame count.
        Noise points (label -1) are included under key "-1".
    """
    unique, counts = np.unique(labels, return_counts=True)
    return {str(int(label)): int(count) for label, count in zip(unique, counts)}


def validate_atom_indices(
    atom_indices: Optional[list[int]], n_atoms: int
) -> Optional[np.ndarray]:
    """Validate and convert optional atom indices to a numpy array.

    Args:
        atom_indices: List of atom indices from the request, or None.
        n_atoms: Total number of atoms in the trajectory.

    Returns:
        Numpy int32 array of atom indices, or None if input was None.

    Raises:
        HTTPException: If indices are empty or out of range.
    """
    if atom_indices is None:
        return None
    arr = np.array(atom_indices, dtype=np.int32)
    if len(arr) == 0:
        raise HTTPException(
            status_code=400,
            detail="atom_indices is empty. Provide at least one atom index "
            "or omit the field to use all atoms.",
        )
    if arr.min() < 0 or arr.max() >= n_atoms:
        raise HTTPException(
            status_code=400,
            detail=f"atom_indices contains out-of-range values. "
            f"Valid range is 0 to {n_atoms - 1}. "
            f"Got min={int(arr.min())}, max={int(arr.max())}.",
        )
    return arr


# ============================================================================
# Request / Response Models
# ============================================================================


# --- Endpoint 1: RMSD distance matrix ---


class RMSDMatrixRequest(BaseModel):
    """Request for pairwise RMSD distance matrix computation."""

    trajectory_b64: str = Field(
        description="Base64-encoded trajectory file content"
    )
    format: str = Field(
        description="Trajectory file format extension (e.g., 'pdb', 'xyz', 'lammpstrj')"
    )
    atom_indices: Optional[list[int]] = Field(
        default=None,
        description=(
            "Atom indices to include in the RMSD calculation (0-indexed). "
            "If None, all atoms are used."
        ),
    )
    stride: Optional[int] = Field(
        default=None,
        description=(
            "Stride for subsampling frames. E.g., stride=10 uses every 10th frame. "
            "Useful for large trajectories where the full NxN matrix is too expensive."
        ),
        ge=1,
    )


class RMSDMatrixResponse(BaseModel):
    """Response containing the pairwise RMSD distance matrix."""

    distance_matrix: list[list[float]] = Field(
        description="NxN pairwise RMSD distance matrix in Angstroms"
    )
    frame_indices: list[int] = Field(
        description="Original frame indices corresponding to each row/column"
    )
    n_frames: int = Field(
        description="Number of frames in the (possibly subsampled) trajectory"
    )


# --- Endpoint 2: RMSD-based clustering ---


class RMSDClusterRequest(BaseModel):
    """Request for RMSD-based clustering of trajectory frames."""

    trajectory_b64: str = Field(
        description="Base64-encoded trajectory file content"
    )
    format: str = Field(
        description="Trajectory file format extension"
    )
    method: Literal["dbscan", "hierarchical", "kmeans"] = Field(
        description="Clustering algorithm to apply"
    )
    atom_indices: Optional[list[int]] = Field(
        default=None,
        description="Atom indices for RMSD calculation (0-indexed). None uses all atoms.",
    )
    stride: Optional[int] = Field(
        default=None,
        description="Stride for subsampling frames",
        ge=1,
    )
    # DBSCAN parameters
    eps: float = Field(
        default=1.0,
        description="DBSCAN: maximum distance (Angstroms) between samples in a cluster",
        gt=0,
    )
    min_samples: int = Field(
        default=5,
        description="DBSCAN: minimum number of samples in a neighborhood to form a core point",
        ge=1,
    )
    # Hierarchical / KMeans parameters
    n_clusters: int = Field(
        default=5,
        description="Number of clusters for hierarchical and KMeans methods",
        ge=2,
    )
    linkage: Literal["average", "complete", "ward"] = Field(
        default="average",
        description=(
            "Hierarchical clustering linkage criterion. 'ward' requires "
            "euclidean metric (distance matrix rows used as features). "
            "'average' and 'complete' use precomputed RMSD distance matrix."
        ),
    )


class RMSDClusterResponse(BaseModel):
    """Response containing RMSD-based clustering results and 2D PCA embedding."""

    labels: list[int] = Field(
        description="Cluster assignment for each frame (-1 = noise for DBSCAN)"
    )
    n_clusters_found: int = Field(
        description="Number of clusters found (excluding noise)"
    )
    cluster_sizes: dict[str, int] = Field(
        description="Number of frames in each cluster (keys are cluster labels)"
    )
    pca_2d: list[list[float]] = Field(
        description="Nx2 PCA embedding of the RMSD distance matrix for scatter plot"
    )
    pca_explained_variance: list[float] = Field(
        description="Explained variance ratio for the first 2 PCA components"
    )
    frame_indices: list[int] = Field(
        description="Original frame indices aligned with labels and pca_2d"
    )
    representative_frames: dict[str, int] = Field(
        description=(
            "Representative frame index for each cluster (medoid). "
            "Keys are cluster label strings."
        )
    )


# --- Endpoint 3: CV-based clustering ---


class CVParams(BaseModel):
    """Parameters for collective variable extraction."""

    atom_pairs: Optional[list[list[int]]] = Field(
        default=None,
        description="For 'distances' CV: list of atom index pairs [[i, j], ...]",
    )
    atom_triplets: Optional[list[list[int]]] = Field(
        default=None,
        description="For 'angles' CV: list of atom index triplets [[i, j, k], ...]",
    )
    atom_quartets: Optional[list[list[int]]] = Field(
        default=None,
        description="For 'dihedrals' CV: list of atom index quartets [[i, j, k, l], ...]",
    )
    scheme: Optional[Literal["closest-heavy", "ca"]] = Field(
        default="closest-heavy",
        description="For 'contacts' CV: contact scheme",
    )
    cutoff: Optional[float] = Field(
        default=4.5,
        description="For 'contacts' CV: distance cutoff in Angstroms",
        gt=0,
    )


class CVClusterRequest(BaseModel):
    """Request for collective variable based clustering."""

    trajectory_b64: str = Field(
        description="Base64-encoded trajectory file content"
    )
    format: str = Field(
        description="Trajectory file format extension"
    )
    cv_type: Literal["distances", "angles", "dihedrals", "contacts", "mixed"] = Field(
        description="Type of collective variable to extract"
    )
    cv_params: CVParams = Field(
        default_factory=CVParams,
        description="Parameters for CV extraction (depends on cv_type)",
    )
    clustering_method: Literal["dbscan", "kmeans", "hierarchical"] = Field(
        default="kmeans",
        description="Clustering algorithm to apply in CV feature space",
    )
    # Clustering parameters
    eps: float = Field(
        default=0.5,
        description="DBSCAN: epsilon in standardized feature space",
        gt=0,
    )
    min_samples: int = Field(
        default=5,
        description="DBSCAN: minimum samples per cluster",
        ge=1,
    )
    n_clusters: int = Field(
        default=5,
        description="Number of clusters for KMeans / hierarchical",
        ge=2,
    )
    linkage: Literal["ward", "average", "complete"] = Field(
        default="ward",
        description="Hierarchical clustering linkage criterion",
    )
    stride: Optional[int] = Field(
        default=None,
        description="Stride for subsampling frames",
        ge=1,
    )


class CVClusterResponse(BaseModel):
    """Response containing CV-based clustering results."""

    labels: list[int] = Field(
        description="Cluster assignment per frame"
    )
    n_clusters_found: int = Field(
        description="Number of clusters found (excluding noise)"
    )
    cluster_sizes: dict[str, int] = Field(
        description="Number of frames in each cluster"
    )
    pca_2d: list[list[float]] = Field(
        description="Nx2 PCA embedding of the CV feature space for scatter plot"
    )
    cv_names: list[str] = Field(
        description="Human-readable labels for each CV dimension"
    )
    cv_values: list[list[float]] = Field(
        description="NxM CV feature matrix (N frames, M collective variables)"
    )
    pca_explained_variance: list[float] = Field(
        description="Explained variance ratio for the first 2 PCA components"
    )
    frame_indices: list[int] = Field(
        description="Original frame indices aligned with labels and embeddings"
    )


# --- Endpoint 4: Dimensionality reduction ---


class DimReduceClusteringParams(BaseModel):
    """Optional clustering parameters to apply after dimensionality reduction."""

    method: Literal["dbscan", "kmeans", "hierarchical"] = Field(
        description="Clustering method"
    )
    eps: float = Field(default=0.5, gt=0)
    min_samples: int = Field(default=5, ge=1)
    n_clusters: int = Field(default=5, ge=2)
    linkage: Literal["ward", "average", "complete"] = Field(default="ward")


class DimReduceRequest(BaseModel):
    """Request for dimensionality reduction of trajectory data."""

    trajectory_b64: str = Field(
        description="Base64-encoded trajectory file content"
    )
    format: str = Field(
        description="Trajectory file format extension"
    )
    method: Literal["pca", "tsne", "umap"] = Field(
        description="Dimensionality reduction method"
    )
    n_components: int = Field(
        default=2,
        description="Number of output dimensions (2 or 3)",
        ge=2,
        le=3,
    )
    feature_type: Literal["coordinates", "rmsd_matrix", "custom_cv"] = Field(
        default="rmsd_matrix",
        description=(
            "Feature source: 'coordinates' (flattened xyz), 'rmsd_matrix' "
            "(pairwise RMSD as features), 'custom_cv' (user-defined CVs)"
        ),
    )
    atom_indices: Optional[list[int]] = Field(
        default=None,
        description="Atom indices for coordinate/RMSD features (0-indexed)",
    )
    stride: Optional[int] = Field(
        default=None,
        description="Stride for subsampling frames",
        ge=1,
    )
    # Custom CV parameters (used when feature_type="custom_cv")
    cv_type: Optional[Literal["distances", "angles", "dihedrals", "contacts", "mixed"]] = Field(
        default=None,
        description="CV type (required if feature_type='custom_cv')",
    )
    cv_params: Optional[CVParams] = Field(
        default=None,
        description="CV parameters (required if feature_type='custom_cv')",
    )
    # t-SNE parameters
    perplexity: float = Field(
        default=30.0,
        description="t-SNE: perplexity (related to number of nearest neighbors)",
        gt=0,
    )
    learning_rate: Union[float, Literal["auto"]] = Field(
        default=200.0,
        description="t-SNE: learning rate",
    )
    n_iter: int = Field(
        default=1000,
        description="t-SNE: maximum number of iterations for optimization",
        ge=250,
    )
    # UMAP parameters
    n_neighbors: int = Field(
        default=15,
        description="UMAP: number of nearest neighbors for manifold approximation",
        ge=2,
    )
    min_dist: float = Field(
        default=0.1,
        description="UMAP: minimum distance between embedded points",
        ge=0.0,
    )
    # Optional clustering on the embedding
    clustering: Optional[DimReduceClusteringParams] = Field(
        default=None,
        description=(
            "Optional: run clustering on the embedding. "
            "If None, no clustering is performed."
        ),
    )


class DimReduceResponse(BaseModel):
    """Response containing dimensionality reduction results."""

    embedding: list[list[float]] = Field(
        description="Nx2 or Nx3 embedding coordinates for scatter plot"
    )
    labels: Optional[list[int]] = Field(
        default=None,
        description="Cluster labels (if clustering was requested), else null"
    )
    method: str = Field(
        description="Dimensionality reduction method used"
    )
    explained_variance: Optional[list[float]] = Field(
        default=None,
        description="Explained variance ratio per component (PCA only, else null)"
    )
    frame_indices: list[int] = Field(
        description="Original frame indices aligned with the embedding"
    )


# ============================================================================
# CV Extraction Helpers
# ============================================================================


def extract_collective_variables(
    traj: md.Trajectory,
    cv_type: str,
    cv_params: CVParams,
) -> tuple[np.ndarray, list[str]]:
    """Extract collective variables from a trajectory using mdtraj.

    Args:
        traj: mdtraj Trajectory.
        cv_type: Type of CV ("distances", "angles", "dihedrals", "contacts", "mixed").
        cv_params: Parameters specifying which atoms/pairs to use.

    Returns:
        Tuple of (feature_matrix, cv_names) where feature_matrix has shape
        (n_frames, n_features) and cv_names is a list of human-readable labels.

    Raises:
        HTTPException: If required parameters are missing or computation fails.
    """
    features_list: list[np.ndarray] = []
    names_list: list[str] = []

    if cv_type in ("distances", "mixed"):
        if cv_params.atom_pairs is None:
            if cv_type == "distances":
                raise HTTPException(
                    status_code=400,
                    detail="cv_type='distances' requires cv_params.atom_pairs",
                )
        if cv_params.atom_pairs is not None:
            pairs = np.array(cv_params.atom_pairs, dtype=np.int32)
            if pairs.ndim != 2 or pairs.shape[1] != 2:
                raise HTTPException(
                    status_code=400,
                    detail="atom_pairs must be a list of [i, j] pairs",
                )
            try:
                # md.compute_distances returns (n_frames, n_pairs) in nanometers
                dist_nm = md.compute_distances(traj, pairs)
                dist_ang = dist_nm * NM_TO_ANGSTROM
                features_list.append(dist_ang)
                for pair in pairs:
                    names_list.append(f"dist({pair[0]}-{pair[1]})")
            except Exception as exc:
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to compute distances: {exc}",
                )

    if cv_type in ("angles", "mixed"):
        if cv_params.atom_triplets is None:
            if cv_type == "angles":
                raise HTTPException(
                    status_code=400,
                    detail="cv_type='angles' requires cv_params.atom_triplets",
                )
        if cv_params.atom_triplets is not None:
            triplets = np.array(cv_params.atom_triplets, dtype=np.int32)
            if triplets.ndim != 2 or triplets.shape[1] != 3:
                raise HTTPException(
                    status_code=400,
                    detail="atom_triplets must be a list of [i, j, k] triplets",
                )
            try:
                # md.compute_angles returns (n_frames, n_angles) in radians
                angles_rad = md.compute_angles(traj, triplets)
                features_list.append(angles_rad)
                for triplet in triplets:
                    names_list.append(f"angle({triplet[0]}-{triplet[1]}-{triplet[2]})")
            except Exception as exc:
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to compute angles: {exc}",
                )

    if cv_type in ("dihedrals", "mixed"):
        if cv_params.atom_quartets is None:
            if cv_type == "dihedrals":
                raise HTTPException(
                    status_code=400,
                    detail="cv_type='dihedrals' requires cv_params.atom_quartets",
                )
        if cv_params.atom_quartets is not None:
            quartets = np.array(cv_params.atom_quartets, dtype=np.int32)
            if quartets.ndim != 2 or quartets.shape[1] != 4:
                raise HTTPException(
                    status_code=400,
                    detail="atom_quartets must be a list of [i, j, k, l] quartets",
                )
            try:
                # md.compute_dihedrals returns (n_frames, n_dihedrals) in radians
                dihedrals_rad = md.compute_dihedrals(traj, quartets)
                features_list.append(dihedrals_rad)
                for quartet in quartets:
                    names_list.append(
                        f"dihedral({quartet[0]}-{quartet[1]}-{quartet[2]}-{quartet[3]})"
                    )
            except Exception as exc:
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to compute dihedrals: {exc}",
                )

    if cv_type in ("contacts", "mixed"):
        scheme = cv_params.scheme or "closest-heavy"
        cutoff_ang = cv_params.cutoff or 4.5
        cutoff_nm = cutoff_ang / NM_TO_ANGSTROM
        try:
            # md.compute_contacts returns (distances, residue_pairs)
            # distances shape: (n_frames, n_residue_pairs) in nanometers
            contact_distances, contact_pairs = md.compute_contacts(
                traj, scheme=scheme, contacts="all"
            )
            # Convert to binary contacts based on cutoff
            contact_binary = (contact_distances < cutoff_nm).astype(np.float64)
            features_list.append(contact_binary)
            for pair in contact_pairs:
                names_list.append(f"contact(res{pair[0]}-res{pair[1]})")
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to compute contacts: {exc}",
            )

    if not features_list:
        raise HTTPException(
            status_code=400,
            detail=f"No valid collective variables extracted for cv_type='{cv_type}'. "
            f"Check that the required cv_params fields are provided.",
        )

    # Concatenate all features along the feature axis
    feature_matrix = np.hstack(features_list)
    return feature_matrix, names_list


# ============================================================================
# API Endpoints
# ============================================================================


@router.post("/rmsd-matrix", response_model=RMSDMatrixResponse)
def compute_rmsd_matrix(request: RMSDMatrixRequest) -> RMSDMatrixResponse:
    """Compute the pairwise RMSD distance matrix between all trajectory frames.

    For N frames, this produces an NxN symmetric matrix where entry (i, j) is the
    RMSD between frame i and frame j after optimal rigid-body superposition.
    This matrix is the fundamental building block for RMSD-based clustering and
    can be used as input for any distance-based analysis.

    For large trajectories, use the `stride` parameter to subsample frames and
    reduce the NxN cost. With `atom_indices`, you can focus on a subset of atoms
    (e.g., only surface atoms, only the adsorbate, etc.).

    Results are in Angstroms (mdtraj computes in nanometers internally).

    Args:
        request: RMSDMatrixRequest with trajectory data and options.

    Returns:
        RMSDMatrixResponse with the NxN distance matrix and frame indices.
    """
    traj = load_trajectory(request.trajectory_b64, request.format)

    # Validate atom indices
    atom_indices = validate_atom_indices(request.atom_indices, traj.n_atoms)

    # Apply stride for subsampling
    if request.stride is not None and request.stride > 1:
        original_indices = list(range(0, traj.n_frames, request.stride))
        traj = traj[::request.stride]
    else:
        original_indices = list(range(traj.n_frames))

    if traj.n_frames < 2:
        raise HTTPException(
            status_code=400,
            detail=f"Need at least 2 frames for a pairwise RMSD matrix. "
            f"Got {traj.n_frames} frame(s) after applying stride.",
        )

    # Compute pairwise RMSD (returns in nanometers)
    try:
        dist_matrix_nm = compute_pairwise_rmsd(traj, atom_indices=atom_indices)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Pairwise RMSD computation failed: {exc}",
        )

    # Convert nm -> Angstroms
    dist_matrix_ang = dist_matrix_nm * NM_TO_ANGSTROM

    return RMSDMatrixResponse(
        distance_matrix=dist_matrix_ang.tolist(),
        frame_indices=original_indices,
        n_frames=traj.n_frames,
    )


@router.post("/rmsd-cluster", response_model=RMSDClusterResponse)
def compute_rmsd_cluster(request: RMSDClusterRequest) -> RMSDClusterResponse:
    """Cluster trajectory frames based on pairwise RMSD similarity.

    This endpoint computes the full pairwise RMSD distance matrix, applies the
    chosen clustering algorithm, and projects the distance matrix into 2D via
    PCA for visualization. The result is everything needed to render a scatter
    plot where each dot is a trajectory frame colored by cluster assignment.

    Supported clustering methods:
    - **DBSCAN**: Density-based, finds clusters of arbitrary shape, marks outlier
      frames as noise (-1). Good for identifying distinct structural basins
      without specifying the number of clusters a priori. The `eps` parameter
      is in Angstroms.
    - **Hierarchical (agglomerative)**: Bottom-up merging with configurable
      linkage. "average" and "complete" use the precomputed RMSD matrix directly.
      "ward" treats RMSD matrix rows as feature vectors.
    - **KMeans**: Partitions frames into exactly n_clusters groups. Operates on
      the RMSD matrix rows as feature vectors (similar to kernel PCA embedding).

    Args:
        request: RMSDClusterRequest with trajectory data, clustering method
            and parameters.

    Returns:
        RMSDClusterResponse with cluster labels, 2D PCA embedding, cluster
        sizes, and representative frames.
    """
    traj = load_trajectory(request.trajectory_b64, request.format)

    # Validate atom indices
    atom_indices = validate_atom_indices(request.atom_indices, traj.n_atoms)

    # Apply stride
    if request.stride is not None and request.stride > 1:
        original_indices = list(range(0, traj.n_frames, request.stride))
        traj = traj[::request.stride]
    else:
        original_indices = list(range(traj.n_frames))

    if traj.n_frames < 2:
        raise HTTPException(
            status_code=400,
            detail=f"Need at least 2 frames for clustering. "
            f"Got {traj.n_frames} frame(s) after applying stride.",
        )

    # Step 1: Compute pairwise RMSD distance matrix
    try:
        dist_matrix_nm = compute_pairwise_rmsd(traj, atom_indices=atom_indices)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Pairwise RMSD computation failed: {exc}",
        )

    # Convert to Angstroms for clustering (so eps is in Angstroms)
    dist_matrix_ang = dist_matrix_nm * NM_TO_ANGSTROM

    # Step 2: Apply clustering
    labels = apply_clustering(
        method=request.method,
        distance_matrix=dist_matrix_ang,
        eps=request.eps,
        min_samples=request.min_samples,
        n_clusters=request.n_clusters,
        linkage=request.linkage,
    )

    # Step 3: PCA on the distance matrix for 2D visualization
    # Using the RMSD distance matrix rows as feature vectors (classical MDS-like).
    try:
        n_components = min(2, dist_matrix_ang.shape[0], dist_matrix_ang.shape[1])
        pca = PCA(n_components=n_components)
        pca_2d = pca.fit_transform(dist_matrix_ang)
        explained_variance = pca.explained_variance_ratio_.tolist()
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"PCA for 2D embedding failed: {exc}",
        )

    # Pad to 2 columns if only 1 component was possible
    if pca_2d.shape[1] < 2:
        pca_2d = np.column_stack([pca_2d, np.zeros(pca_2d.shape[0])])
        explained_variance = explained_variance + [0.0]

    # Step 4: Find representative frames (medoids)
    representatives = find_representative_frames(labels, dist_matrix_ang)

    # Map representative frame indices back to original trajectory indices
    representatives_original = {
        k: original_indices[v] for k, v in representatives.items()
    }

    # Count clusters (excluding noise label -1)
    unique_labels = set(labels)
    n_clusters_found = len(unique_labels - {-1})

    return RMSDClusterResponse(
        labels=labels.tolist(),
        n_clusters_found=n_clusters_found,
        cluster_sizes=compute_cluster_sizes(labels),
        pca_2d=pca_2d.tolist(),
        pca_explained_variance=explained_variance,
        frame_indices=original_indices,
        representative_frames=representatives_original,
    )


@router.post("/cv-cluster", response_model=CVClusterResponse)
def compute_cv_cluster(request: CVClusterRequest) -> CVClusterResponse:
    """Cluster trajectory frames based on collective variables (CVs).

    Instead of comparing frames by atomic positions (RMSD), this endpoint
    extracts user-defined collective variables and clusters in that feature
    space. This is powerful for identifying transitions along specific
    reaction coordinates, bond-breaking events, or conformational changes.

    Supported CV types:
    - **distances**: Track specific atom-atom distances (e.g., bond lengths,
      adsorbate-surface distance). Provide `atom_pairs` as [[i,j], ...].
    - **angles**: Track bond angles. Provide `atom_triplets` as [[i,j,k], ...].
    - **dihedrals**: Track torsion angles. Provide `atom_quartets` as
      [[i,j,k,l], ...].
    - **contacts**: Binary residue-residue contacts within a cutoff distance.
      Uses mdtraj's `compute_contacts` with configurable scheme and cutoff.
    - **mixed**: Combine any of the above CVs into a single feature vector.

    The workflow:
    1. Extract CVs from the trajectory using mdtraj
    2. Standardize features (zero mean, unit variance) so CVs with different
       units contribute equally
    3. Run PCA on the standardized features for 2D visualization
    4. Apply the chosen clustering algorithm in the standardized feature space

    Args:
        request: CVClusterRequest with trajectory data, CV specification,
            and clustering parameters.

    Returns:
        CVClusterResponse with cluster labels, 2D PCA embedding, and the
        full CV feature matrix.
    """
    traj = load_trajectory(request.trajectory_b64, request.format)

    # Apply stride
    if request.stride is not None and request.stride > 1:
        original_indices = list(range(0, traj.n_frames, request.stride))
        traj = traj[::request.stride]
    else:
        original_indices = list(range(traj.n_frames))

    if traj.n_frames < 2:
        raise HTTPException(
            status_code=400,
            detail=f"Need at least 2 frames for clustering. "
            f"Got {traj.n_frames} frame(s) after applying stride.",
        )

    # Step 1: Extract collective variables
    feature_matrix, cv_names = extract_collective_variables(
        traj, request.cv_type, request.cv_params
    )

    if feature_matrix.shape[1] == 0:
        raise HTTPException(
            status_code=400,
            detail="No features extracted. Check cv_type and cv_params.",
        )

    # Step 2: Standardize features
    scaler = StandardScaler()
    features_scaled = scaler.fit_transform(feature_matrix)

    # Handle any NaN/Inf that might arise from constant features
    features_scaled = np.nan_to_num(features_scaled, nan=0.0, posinf=0.0, neginf=0.0)

    # Step 3: PCA for 2D visualization
    try:
        n_pca_components = min(2, features_scaled.shape[0], features_scaled.shape[1])
        pca = PCA(n_components=n_pca_components)
        pca_2d = pca.fit_transform(features_scaled)
        pca_explained_variance = pca.explained_variance_ratio_.tolist()
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"PCA on CV features failed: {exc}",
        )

    # Pad to 2D if only 1 component
    if pca_2d.shape[1] < 2:
        pca_2d = np.column_stack([pca_2d, np.zeros(pca_2d.shape[0])])
        pca_explained_variance = pca_explained_variance + [0.0]

    # Step 4: Clustering in feature space
    if request.clustering_method == "dbscan":
        try:
            model = DBSCAN(eps=request.eps, min_samples=request.min_samples)
            labels = model.fit_predict(features_scaled)
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"DBSCAN clustering failed: {exc}",
            )
    elif request.clustering_method == "kmeans":
        try:
            model = KMeans(
                n_clusters=request.n_clusters, random_state=42, n_init=10
            )
            labels = model.fit_predict(features_scaled)
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"KMeans clustering failed: {exc}",
            )
    elif request.clustering_method == "hierarchical":
        try:
            model = AgglomerativeClustering(
                n_clusters=request.n_clusters,
                linkage=request.linkage,
            )
            labels = model.fit_predict(features_scaled)
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Hierarchical clustering failed: {exc}",
            )
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported clustering method: '{request.clustering_method}'",
        )

    labels = np.asarray(labels, dtype=int)

    # Count clusters (excluding noise)
    unique_labels = set(labels.tolist())
    n_clusters_found = len(unique_labels - {-1})

    return CVClusterResponse(
        labels=labels.tolist(),
        n_clusters_found=n_clusters_found,
        cluster_sizes=compute_cluster_sizes(labels),
        pca_2d=pca_2d.tolist(),
        cv_names=cv_names,
        cv_values=feature_matrix.tolist(),
        pca_explained_variance=pca_explained_variance,
        frame_indices=original_indices,
    )


@router.post("/dimreduce", response_model=DimReduceResponse)
def compute_dimreduce(request: DimReduceRequest) -> DimReduceResponse:
    """Apply dimensionality reduction to trajectory data for visualization.

    Projects high-dimensional trajectory features into a low-dimensional
    embedding (2D or 3D) for scatter plot visualization. Each point in the
    embedding corresponds to a trajectory frame, enabling visual identification
    of structural clusters, transitions, and rare events.

    Feature sources:
    - **coordinates**: Flatten XYZ atomic positions (after superposition onto
      the first frame for alignment). Captures the full configurational space.
    - **rmsd_matrix**: Use the pairwise RMSD distance matrix rows as features.
      This is a nonlinear embedding that captures structural similarity.
    - **custom_cv**: User-defined collective variables (same as cv-cluster endpoint).

    Dimensionality reduction methods:
    - **PCA**: Linear projection preserving maximum variance. Fast, deterministic,
      provides explained variance ratios.
    - **t-SNE**: Nonlinear embedding preserving local neighborhood structure.
      Good for revealing clusters but distances between clusters are not
      meaningful. Tunable via perplexity.
    - **UMAP**: Nonlinear embedding preserving both local and global structure.
      Often faster than t-SNE and better at preserving global topology.
      Requires umap-learn package.

    Optionally, clustering can be applied on the resulting embedding to color
    the points.

    Args:
        request: DimReduceRequest with trajectory data, method, feature source,
            and optional clustering parameters.

    Returns:
        DimReduceResponse with the low-dimensional embedding, optional cluster
        labels, and metadata.
    """
    traj = load_trajectory(request.trajectory_b64, request.format)

    # Validate atom indices
    atom_indices = validate_atom_indices(request.atom_indices, traj.n_atoms)

    # Apply stride
    if request.stride is not None and request.stride > 1:
        original_indices = list(range(0, traj.n_frames, request.stride))
        traj = traj[::request.stride]
    else:
        original_indices = list(range(traj.n_frames))

    if traj.n_frames < 2:
        raise HTTPException(
            status_code=400,
            detail=f"Need at least 2 frames for dimensionality reduction. "
            f"Got {traj.n_frames} frame(s) after applying stride.",
        )

    # ---- Build the feature matrix ----
    if request.feature_type == "coordinates":
        # Align trajectory to first frame, then flatten xyz
        try:
            traj.superpose(traj, frame=0, atom_indices=atom_indices)
        except Exception:
            pass  # Superposition may fail for single-atom systems; proceed anyway

        if atom_indices is not None:
            # Extract only the selected atoms
            xyz = traj.xyz[:, atom_indices, :]  # (n_frames, n_selected, 3)
        else:
            xyz = traj.xyz  # (n_frames, n_atoms, 3)

        # Flatten: each frame becomes a 1D vector of length n_atoms * 3
        # Coordinates are in nanometers from mdtraj; convert to Angstroms
        feature_matrix = (xyz * NM_TO_ANGSTROM).reshape(traj.n_frames, -1)

    elif request.feature_type == "rmsd_matrix":
        try:
            dist_matrix_nm = compute_pairwise_rmsd(traj, atom_indices=atom_indices)
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Pairwise RMSD computation failed: {exc}",
            )
        # Use distance matrix rows as features (in Angstroms)
        feature_matrix = dist_matrix_nm * NM_TO_ANGSTROM

    elif request.feature_type == "custom_cv":
        if request.cv_type is None:
            raise HTTPException(
                status_code=400,
                detail="feature_type='custom_cv' requires cv_type to be specified.",
            )
        cv_params = request.cv_params if request.cv_params is not None else CVParams()
        feature_matrix, _ = extract_collective_variables(traj, request.cv_type, cv_params)
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported feature_type: '{request.feature_type}'",
        )

    # Standardize features before dimensionality reduction
    scaler = StandardScaler()
    features_scaled = scaler.fit_transform(feature_matrix)
    features_scaled = np.nan_to_num(features_scaled, nan=0.0, posinf=0.0, neginf=0.0)

    # ---- Apply dimensionality reduction ----
    explained_variance: Optional[list[float]] = None
    n_components = min(request.n_components, features_scaled.shape[0], features_scaled.shape[1])

    if request.method == "pca":
        try:
            pca = PCA(n_components=n_components)
            embedding = pca.fit_transform(features_scaled)
            explained_variance = pca.explained_variance_ratio_.tolist()
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"PCA failed: {exc}",
            )

    elif request.method == "tsne":
        # t-SNE perplexity must be less than n_samples
        effective_perplexity = min(request.perplexity, traj.n_frames - 1)
        if effective_perplexity < 1:
            effective_perplexity = 1.0

        try:
            tsne = TSNE(
                n_components=n_components,
                perplexity=effective_perplexity,
                learning_rate=request.learning_rate,
                max_iter=request.n_iter,
                random_state=42,
            )
            embedding = tsne.fit_transform(features_scaled)
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"t-SNE failed: {exc}",
            )

    elif request.method == "umap":
        try:
            import umap
        except ImportError:
            raise HTTPException(
                status_code=501,
                detail=(
                    "UMAP is not available. Install the umap-learn package: "
                    "pip install umap-learn"
                ),
            )

        effective_n_neighbors = min(request.n_neighbors, traj.n_frames - 1)
        if effective_n_neighbors < 2:
            effective_n_neighbors = 2

        try:
            reducer = umap.UMAP(
                n_components=n_components,
                n_neighbors=effective_n_neighbors,
                min_dist=request.min_dist,
                random_state=42,
            )
            embedding = reducer.fit_transform(features_scaled)
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"UMAP failed: {exc}",
            )
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported dimensionality reduction method: '{request.method}'",
        )

    # Pad embedding to requested dimensions if fewer components were possible
    if embedding.shape[1] < request.n_components:
        padding = np.zeros((embedding.shape[0], request.n_components - embedding.shape[1]))
        embedding = np.column_stack([embedding, padding])
        if explained_variance is not None:
            explained_variance += [0.0] * (request.n_components - len(explained_variance))

    # ---- Optional clustering on the embedding ----
    labels: Optional[list[int]] = None
    if request.clustering is not None:
        cp = request.clustering
        try:
            if cp.method == "dbscan":
                model = DBSCAN(eps=cp.eps, min_samples=cp.min_samples)
                cluster_labels = model.fit_predict(embedding)
            elif cp.method == "kmeans":
                model = KMeans(n_clusters=cp.n_clusters, random_state=42, n_init=10)
                cluster_labels = model.fit_predict(embedding)
            elif cp.method == "hierarchical":
                model = AgglomerativeClustering(
                    n_clusters=cp.n_clusters,
                    linkage=cp.linkage,
                )
                cluster_labels = model.fit_predict(embedding)
            else:
                raise HTTPException(
                    status_code=400,
                    detail=f"Unsupported clustering method: '{cp.method}'",
                )
            labels = cluster_labels.tolist()
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Clustering on embedding failed: {exc}",
            )

    return DimReduceResponse(
        embedding=embedding.tolist(),
        labels=labels,
        method=request.method,
        explained_variance=explained_variance,
        frame_indices=original_indices,
    )
