// Geometry selection for bond rendering. The impostor (a ray-cast OBB) is
// used exactly on the GPU-transform playback path (gpu_active); everything
// else keeps the CylinderGeometry mesh (segment count from bond_lod_segments).
export function bond_geometry_mode(
  gpu_active: boolean,
  _n_atoms: number,
  _playing: boolean,
): 'impostor' | 'cylinder' {
  return gpu_active ? 'impostor' : 'cylinder'
}
