// Cylinder-segment level-of-detail for bond rendering.
//
// The per-bond cylinder is the trajectory-playback vertex bottleneck: at ~52k
// half-bond instances, a 16-sided cylinder is ~10x the vertices of an 8-sided
// one. During playback the segment count is imperceptible (motion + attention
// on the whole structure), so a large system drops to fewer segments while
// playing and restores full segments the instant it pauses — where the eye
// starts scrutinising individual bonds. Small systems never pay the price
// (the GPU is not the bottleneck there), so they always render full segments.

/** Full-quality cylinder segments — static frames, small systems. */
export const BOND_SEGMENTS_FULL = 16
/** Reduced segments during large-system playback (motion hides the facets). */
export const BOND_SEGMENTS_LOD = 8
/** Atom count above which playback engages the reduced segment count. */
export const BOND_LOD_MIN_ATOMS = 2000

/** Choose the cylinder segment count for the current frame. Full segments
 *  unless the system is large AND actively playing; degenerate counts
 *  (0 / negative / NaN) fall back to full. */
export function bond_lod_segments(n_atoms: number, playing: boolean): number {
  if (!(n_atoms > BOND_LOD_MIN_ATOMS)) return BOND_SEGMENTS_FULL
  return playing ? BOND_SEGMENTS_LOD : BOND_SEGMENTS_FULL
}
