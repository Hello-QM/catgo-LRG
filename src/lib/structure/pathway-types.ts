import type { ElementSymbol, Vec3 } from '$lib'

/** A single adsorbate atom anchored relative to a surface site */
export interface AnchoredAtom {
  element: ElementSymbol
  anchor_site_idx: number // index of the surface atom this is relative to
  offset: Vec3 // cartesian offset from the anchor atom's xyz (Angstroms)
}

/** A single step in a reaction pathway (cumulative: all atoms present at this stage) */
export interface PathwayStep {
  id: string
  name: string // e.g. "*N₂", "*NNH", "*NNH₂"
  description?: string
  adsorbate_atoms: AnchoredAtom[]
}

/** A complete reaction pathway (sequence of intermediates) */
export interface ReactionPathway {
  id: string
  name: string // e.g. "NRR (Distal)", "OER"
  steps: PathwayStep[]
}

/** Preset template — defines step names but no geometry (user fills that in) */
export interface PathwayPreset {
  id: string
  name: string
  category: string // "NRR", "OER", "HER", etc.
  steps: { name: string; description?: string }[]
}

/** Metadata attached to each generated frame in the output trajectory */
export interface PathwayFrameMetadata {
  surface_idx: number
  pathway_id: string
  pathway_name: string
  step_idx: number
  step_name: string
  label: string // e.g. "Surface 2 / NRR Distal / *NNH"
}

/** Trajectory-level metadata for pathway trajectories */
export interface PathwayTrajectoryMetadata {
  type: `reaction_pathway`
  n_surfaces: number
  n_pathways: number
  pathways: {
    id: string
    name: string
    n_steps: number
    step_names: string[]
  }[]
}
