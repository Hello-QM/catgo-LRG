/**
 * Development-only comparison policy retained for profiling the retired
 * trajectory approximation. This module is never a fallback: callers may
 * import it only when the exact diagnostic query flag is present.
 */
export const LEGACY_TRAJECTORY_BOND_REFRESH_EVERY = 8

export function legacy_should_refresh_trajectory_bonds(
  frame_sequence: number,
  atom_count: number,
  compatible_connectivity: boolean,
): boolean {
  if (atom_count <= 1000 || !compatible_connectivity) return true
  return frame_sequence % LEGACY_TRAJECTORY_BOND_REFRESH_EVERY === 0
}
