export type TrajectoryBondSessionDescriptor = {
  atomic_numbers: Uint8Array
  site_ids: Uint32Array | null
  pbc: readonly [boolean, boolean, boolean] | null
  strategy: 'atom_radii'
  options: Readonly<Record<string, number>>
  rules_version: string
}

function same_typed_array(
  left: Uint8Array | Uint32Array,
  right: Uint8Array | Uint32Array,
): boolean {
  if (left.length !== right.length) return false
  for (let idx = 0; idx < left.length; idx++) {
    if (left[idx] !== right[idx]) return false
  }
  return true
}

function sorted_numeric_options(
  options: Readonly<Record<string, number>>,
): [string, number][] {
  return Object.entries(options).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  )
}

function same_options(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  const left_entries = sorted_numeric_options(left)
  const right_entries = sorted_numeric_options(right)
  if (left_entries.length !== right_entries.length) return false
  for (let idx = 0; idx < left_entries.length; idx++) {
    const [left_key, left_value] = left_entries[idx]
    const [right_key, right_value] = right_entries[idx]
    if (left_key !== right_key || !Object.is(left_value, right_value)) {
      return false
    }
  }
  return true
}

export function same_trajectory_bond_topology(
  left: TrajectoryBondSessionDescriptor,
  right: TrajectoryBondSessionDescriptor,
): boolean {
  if (
    left.strategy !== right.strategy ||
    left.rules_version !== right.rules_version ||
    !same_typed_array(left.atomic_numbers, right.atomic_numbers) ||
    !same_options(left.options, right.options)
  ) {
    return false
  }
  if (left.site_ids === null || right.site_ids === null) {
    if (left.site_ids !== right.site_ids) return false
  } else if (!same_typed_array(left.site_ids, right.site_ids)) {
    return false
  }
  if (left.pbc === null || right.pbc === null) return left.pbc === right.pbc
  return left.pbc[0] === right.pbc[0] &&
    left.pbc[1] === right.pbc[1] &&
    left.pbc[2] === right.pbc[2]
}

function canonical_text(value: string): string {
  return `${value.length}:${value}`
}

const number_buffer = new ArrayBuffer(8)
const number_view = new DataView(number_buffer)

function canonical_number(value: number): string {
  if (Number.isNaN(value)) return `nan`
  number_view.setFloat64(0, value, false)
  let encoded = ``
  for (let idx = 0; idx < 8; idx++) {
    encoded += number_view.getUint8(idx).toString(16).padStart(2, `0`)
  }
  return encoded
}

function canonical_array(values: Uint8Array | Uint32Array): string {
  return `${values.length}:${Array.from(values).join(`,`)}`
}

export function trajectory_bond_topology_fingerprint(
  descriptor: TrajectoryBondSessionDescriptor,
): string {
  const site_ids = descriptor.site_ids === null
    ? `null`
    : canonical_array(descriptor.site_ids)
  const pbc = descriptor.pbc === null
    ? `null`
    : `${Number(descriptor.pbc[0])}${Number(descriptor.pbc[1])}${
      Number(descriptor.pbc[2])
    }`
  const option_entries = sorted_numeric_options(descriptor.options)
  const options = option_entries
    .map(([key, value]) =>
      `${canonical_text(key)}=${canonical_number(value)}`
    )
    .join(`;`)
  return [
    `trajectory-bond-topology:v1`,
    `atomic_numbers:${canonical_array(descriptor.atomic_numbers)}`,
    `site_ids:${site_ids}`,
    `pbc:${pbc}`,
    `strategy:${canonical_text(descriptor.strategy)}`,
    `options:${option_entries.length}:${options}`,
    `rules_version:${canonical_text(descriptor.rules_version)}`,
  ].join(`|`)
}

export class TrajectoryBondFrameLengthError extends RangeError {
  override readonly name = `TrajectoryBondFrameLengthError`
  readonly session_id: number
  readonly expected_atom_count: number
  readonly expected_float_count: number
  readonly actual_float_count: number
  readonly frame_idx: number | null

  constructor(
    session_id: number,
    expected_atom_count: number,
    actual_float_count: number,
    frame_idx: number | null = null,
  ) {
    const expected_float_count = expected_atom_count * 3
    const frame = frame_idx === null ? `` : ` frame ${frame_idx}`
    super(
      `Invalid positions for trajectory bond session ${session_id}${frame}: ` +
        `expected ${expected_atom_count} atoms (${expected_float_count} ` +
        `position floats), received ${actual_float_count}`,
    )
    this.session_id = session_id
    this.expected_atom_count = expected_atom_count
    this.expected_float_count = expected_float_count
    this.actual_float_count = actual_float_count
    this.frame_idx = frame_idx
  }
}

export function assert_trajectory_bond_frame_length(
  session_id: number,
  expected_atom_count: number,
  actual_float_count: number,
  frame_idx: number | null = null,
): void {
  if (actual_float_count === expected_atom_count * 3) return
  throw new TrajectoryBondFrameLengthError(
    session_id,
    expected_atom_count,
    actual_float_count,
    frame_idx,
  )
}
