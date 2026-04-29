/**
 * Frame selection syntax parser for multi-frame trajectory structures.
 * Supports: individual indices ("1,3,5"), ranges ("1-7"), combinations ("1,3,5-10")
 * User input is 1-indexed (frame 1 = first frame), internal storage is 0-indexed.
 */

/** Parse a frame selection string into a sorted, deduplicated array of 0-indexed frame indices. */
export function parse_frame_selection(input: string, total_frames: number): number[] {
  const indices = new Set<number>()
  const parts = input.split(`,`).map((s) => s.trim()).filter(Boolean)

  for (const part of parts) {
    if (part.includes(`-`)) {
      const [start_str, end_str] = part.split(`-`).map((s) => s.trim())
      const start = parseInt(start_str, 10)
      const end = parseInt(end_str, 10)
      if (isNaN(start) || isNaN(end)) continue
      for (let i = Math.max(0, start - 1); i <= Math.min(total_frames - 1, end - 1); i++) {
        indices.add(i)
      }
    } else {
      const idx = parseInt(part, 10)
      if (!isNaN(idx) && idx >= 1 && idx <= total_frames) {
        indices.add(idx - 1)
      }
    }
  }
  return [...indices].sort((a, b) => a - b)
}

/** Format 0-indexed frame indices back to a compact 1-indexed selection string. */
export function format_frame_selection(indices: number[]): string {
  if (indices.length === 0) return ``
  const sorted = [...indices].sort((a, b) => a - b)
  const ranges: string[] = []
  let start = sorted[0]
  let end = sorted[0]

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i]
    } else {
      ranges.push(start === end ? `${start + 1}` : `${start + 1}-${end + 1}`)
      start = sorted[i]
      end = sorted[i]
    }
  }
  ranges.push(start === end ? `${start + 1}` : `${start + 1}-${end + 1}`)
  return ranges.join(`,`)
}

/** Validate frame selection string. Returns null if valid, or error message if invalid. */
export function validate_frame_selection(input: string, total_frames: number): string | null {
  if (!input.trim()) return null
  const parts = input.split(`,`).map((s) => s.trim()).filter(Boolean)
  for (const part of parts) {
    if (part.includes(`-`)) {
      const segments = part.split(`-`)
      if (segments.length !== 2) return `Invalid range: ${part}`
      const [a, b] = segments.map((s) => s.trim())
      if (isNaN(Number(a)) || isNaN(Number(b))) return `Invalid range: ${part}`
      const na = Number(a), nb = Number(b)
      if (na < 1 || nb < 1) return `Frame numbers must be >= 1`
      if (na > nb) return `Invalid range (start > end): ${part}`
      if (nb > total_frames) return `Frame ${nb} exceeds total (${total_frames})`
    } else {
      if (isNaN(Number(part))) return `Invalid index: ${part}`
      const n = Number(part)
      if (n < 1) return `Frame numbers must be >= 1`
      if (n > total_frames) return `Frame ${n} exceeds total (${total_frames})`
    }
  }
  return null
}
