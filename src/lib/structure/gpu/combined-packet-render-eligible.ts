export type CombinedPacketRenderFeatures = {
  atom_opacity_overrides: number
  bond_opacity_overrides: number
  cutting_active: boolean
  drag_overrides: number
  hidden_atoms?: number
  partial_occupancy: boolean
  multibond: boolean
}

/**
 * The combined packet layer implements one uniform atom style and one uniform
 * bond style. Features that need per-instance visual modulation stay on the
 * exact legacy managers until the packet shaders implement them.
 */
export function combined_packet_render_eligible(
  features: CombinedPacketRenderFeatures,
): boolean {
  return features.atom_opacity_overrides === 0 &&
    features.bond_opacity_overrides === 0 &&
    !features.cutting_active &&
    features.drag_overrides === 0 &&
    (features.hidden_atoms ?? 0) === 0 &&
    !features.partial_occupancy &&
    !features.multibond
}
