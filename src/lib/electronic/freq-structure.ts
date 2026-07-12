/** Build an XYZ file string from parsed frequency-structure data so the
 * host can load it via the existing structure parser. */
export function freq_data_to_xyz(elements: string[], positions: number[][]): string {
  const lines = elements.map((el, i) => {
    const [x, y, z] = positions[i]
    return `${el} ${x.toFixed(8)} ${y.toFixed(8)} ${z.toFixed(8)}`
  })
  return `${elements.length}\nCP2K vibrational analysis structure\n${lines.join('\n')}\n`
}
