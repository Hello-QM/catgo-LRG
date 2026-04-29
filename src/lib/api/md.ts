/**
 * API client for MD trajectory analysis endpoints.
 *
 * Each function takes typed request parameters and an optional server URL,
 * performs a POST request to the corresponding backend endpoint, validates
 * the response, and returns the typed response object.
 */

import type {
  PairwiseDistancesRequest,
  PairwiseDistancesResponse,
  NeighborsRequest,
  NeighborsResponse,
  CenterOfMassRequest,
  CenterOfMassResponse,
  RdfRequest,
  RdfResponse,
  AngleRequest,
  AngleResponse,
  DihedralRequest,
  DihedralResponse,
  RMSDRequest,
  RMSDResponse,
  RMSFRequest,
  RMSFResponse,
  DensityProfileRequest,
  DensityProfileResponse,
  PlanarDensityRequest,
  PlanarDensityResponse,
  HBondDetectRequest,
  HBondDetectResponse,
  HBondLifetimeRequest,
  HBondLifetimeResponse,
  HBondDensityRequest,
  HBondDensityResponse,
  RMSDMatrixRequest,
  RMSDMatrixResponse,
  RMSDClusterRequest,
  RMSDClusterResponse,
  CVClusterRequest,
  CVClusterResponse,
  DimReduceRequest,
  DimReduceResponse,
  MSDRequest,
  MSDResponse,
  VACFRequest,
  VACFResponse,
  WaterOrientationRequest,
  WaterOrientationResponse,
  CavitationRequest,
  CavitationResponse,
} from '$lib/md/types'

const DEFAULT_SERVER = `http://localhost:8000`

// ============================================================================
// Helper: generic POST request
// ============================================================================

async function post<TReq, TRes>(
  endpoint: string,
  params: TReq,
  server_url: string,
): Promise<TRes> {
  const response = await fetch(`${server_url}${endpoint}`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(params),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`${endpoint} failed: ${detail}`)
  }

  return response.json()
}

// ============================================================================
// File utilities
// ============================================================================

/** Convert a File to a base64-encoded string (without the data URI prefix). */
export async function file_to_base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Strip the data URL prefix (e.g. "data:application/octet-stream;base64,")
      const b64 = result.split(`,`, 2)[1]
      if (b64) resolve(b64)
      else reject(new Error(`Failed to encode file as base64`))
    }
    reader.onerror = () => reject(reader.error ?? new Error(`FileReader error`))
    reader.readAsDataURL(file)
  })
}

/** Format file size in human-readable form. */
export function format_file_size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// ============================================================================
// Distance analysis endpoints
// ============================================================================

export async function compute_pairwise_distances(
  params: PairwiseDistancesRequest,
  server_url = DEFAULT_SERVER,
): Promise<PairwiseDistancesResponse> {
  return post(`/md/distances/pairwise`, params, server_url)
}

export async function compute_neighbors(
  params: NeighborsRequest,
  server_url = DEFAULT_SERVER,
): Promise<NeighborsResponse> {
  return post(`/md/distances/neighbors`, params, server_url)
}

export async function compute_center_of_mass(
  params: CenterOfMassRequest,
  server_url = DEFAULT_SERVER,
): Promise<CenterOfMassResponse> {
  return post(`/md/distances/center-of-mass`, params, server_url)
}

export async function compute_rdf(
  params: RdfRequest,
  server_url = DEFAULT_SERVER,
): Promise<RdfResponse> {
  return post(`/md/distances/rdf`, params, server_url)
}

// ============================================================================
// Angle analysis endpoints
// ============================================================================

export async function compute_angles(
  params: AngleRequest,
  server_url = DEFAULT_SERVER,
): Promise<AngleResponse> {
  return post(`/md/angles/angles`, params, server_url)
}

export async function compute_dihedrals(
  params: DihedralRequest,
  server_url = DEFAULT_SERVER,
): Promise<DihedralResponse> {
  return post(`/md/angles/dihedrals`, params, server_url)
}

// ============================================================================
// RMSD/RMSF analysis endpoints
// ============================================================================

export async function compute_rmsd(
  params: RMSDRequest,
  server_url = DEFAULT_SERVER,
): Promise<RMSDResponse> {
  return post(`/md/rmsd/rmsd`, params, server_url)
}

export async function compute_rmsf(
  params: RMSFRequest,
  server_url = DEFAULT_SERVER,
): Promise<RMSFResponse> {
  return post(`/md/rmsd/rmsf`, params, server_url)
}

// ============================================================================
// Density analysis endpoints
// ============================================================================

export async function compute_density_profile(
  params: DensityProfileRequest,
  server_url = DEFAULT_SERVER,
): Promise<DensityProfileResponse> {
  return post(`/md/density/profile`, params, server_url)
}

export async function compute_planar_density(
  params: PlanarDensityRequest,
  server_url = DEFAULT_SERVER,
): Promise<PlanarDensityResponse> {
  return post(`/md/density/planar`, params, server_url)
}

// ============================================================================
// Hydrogen bond analysis endpoints
// ============================================================================

export async function detect_hbonds(
  params: HBondDetectRequest,
  server_url = DEFAULT_SERVER,
): Promise<HBondDetectResponse> {
  return post(`/md/hbonds/detect`, params, server_url)
}

export async function compute_hbond_lifetime(
  params: HBondLifetimeRequest,
  server_url = DEFAULT_SERVER,
): Promise<HBondLifetimeResponse> {
  return post(`/md/hbonds/lifetime`, params, server_url)
}

export async function compute_hbond_density(
  params: HBondDensityRequest,
  server_url = DEFAULT_SERVER,
): Promise<HBondDensityResponse> {
  return post(`/md/hbonds/density`, params, server_url)
}

// ============================================================================
// Clustering and dimensionality reduction endpoints
// ============================================================================

export async function compute_rmsd_matrix(
  params: RMSDMatrixRequest,
  server_url = DEFAULT_SERVER,
): Promise<RMSDMatrixResponse> {
  return post(`/md/clustering/rmsd-matrix`, params, server_url)
}

export async function compute_rmsd_cluster(
  params: RMSDClusterRequest,
  server_url = DEFAULT_SERVER,
): Promise<RMSDClusterResponse> {
  return post(`/md/clustering/rmsd-cluster`, params, server_url)
}

export async function compute_cv_cluster(
  params: CVClusterRequest,
  server_url = DEFAULT_SERVER,
): Promise<CVClusterResponse> {
  return post(`/md/clustering/cv-cluster`, params, server_url)
}

export async function compute_dimreduce(
  params: DimReduceRequest,
  server_url = DEFAULT_SERVER,
): Promise<DimReduceResponse> {
  return post(`/md/clustering/dimreduce`, params, server_url)
}

// ============================================================================
// Dynamics: MSD / diffusion coefficient / VACF (md_dynamics router)
// ============================================================================

export async function compute_msd(
  params: MSDRequest,
  server_url = DEFAULT_SERVER,
): Promise<MSDResponse> {
  return post(`/md/dynamics/msd`, params, server_url)
}

export async function compute_vacf(
  params: VACFRequest,
  server_url = DEFAULT_SERVER,
): Promise<VACFResponse> {
  return post(`/md/dynamics/vacf`, params, server_url)
}

// ============================================================================
// Water orientation order parameter (md_orientation router)
// ============================================================================

export async function compute_water_orientation(
  params: WaterOrientationRequest,
  server_url = DEFAULT_SERVER,
): Promise<WaterOrientationResponse> {
  return post(`/md/orientation/water`, params, server_url)
}

// ============================================================================
// LCW cavitation free energy ΔG_cav(R, z) (md_cavitation router)
// ============================================================================

export async function compute_cavitation(
  params: CavitationRequest,
  server_url = DEFAULT_SERVER,
): Promise<CavitationResponse> {
  return post(`/md/cavitation/profile`, params, server_url)
}
