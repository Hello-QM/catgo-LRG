export const POSITION_TEXTURE_ROW_ATOMS = 2048

export function position_texture_shape(atom_count: number): {
  width: number
  height: number
  float_count: number
} {
  const width = Math.max(
    1,
    Math.min(POSITION_TEXTURE_ROW_ATOMS, atom_count),
  )
  const height = Math.max(1, Math.ceil(atom_count / width))
  return { width, height, float_count: width * height * 4 }
}
