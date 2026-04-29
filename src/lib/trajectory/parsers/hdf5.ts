// HDF5 trajectory parser (torch-sim, VASP vaspout.h5, etc.)
import type { ElementSymbol } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import type { Dataset, Entity, Group } from 'h5wasm'
import * as h5wasm from 'h5wasm'
import type { TrajectoryType } from '../index'
import { convert_atomic_numbers, create_trajectory_frame } from './common'

// HDF5 utilities - consolidated type guards and helpers
// Use duck typing for robustness — instanceof can fail across WASM module boundaries
const is_hdf5_dataset = (entity: Entity | null): entity is Dataset =>
  entity !== null && typeof (entity as any).to_array === `function`

const is_hdf5_group = (entity: Entity | null): entity is Group =>
  entity !== null && typeof (entity as any).keys === `function` && !(`to_array` in entity)

export const parse_torch_sim_hdf5 = async (
  buffer: ArrayBuffer,
  filename?: string,
): Promise<TrajectoryType> => {
  await h5wasm.ready
  const { FS } = await h5wasm.ready
  const temp_filename = filename || `temp.h5`

  FS.writeFile(temp_filename, new Uint8Array(buffer))
  const h5_file = new h5wasm.File(temp_filename, `r`)

  try {
    // Unified dataset discovery with path tracking
    const found_paths: Record<string, string> = {}
    const find_dataset = (names: string[]) => {
      const discover = (parent: Group, path = ``): Dataset | null => {
        for (const name of parent.keys()) {
          const item = parent.get(name)
          const full_path = path ? `${path}/${name}` : `/${name}`
          if (names.includes(name) && is_hdf5_dataset(item)) {
            // Track which name was found and its path
            const found_name = names.find((n) => n === name)
            if (found_name) found_paths[found_name] = full_path
            return item
          }
          if (is_hdf5_group(item)) {
            const result = discover(item, full_path)
            if (result) return result
          }
        }
        return null
      }
      return discover(h5_file as unknown as Group)
    }

    const positions_data = find_dataset([`positions`])?.to_array() as
      | number[][]
      | number[][][]
      | null
    const atomic_numbers_data = find_dataset([
      `atomic_numbers`,
      `numbers`,
      `Z`,
      `species`,
    ])?.to_array() as number[] | number[][] | null
    const cells_data = find_dataset([`cell`, `cells`, `lattice`])?.to_array() as
      | number[][][]
      | null
    const energies_data = find_dataset([`potential_energy`, `energy`])?.to_array() as
      | number[][]
      | null

    if (!positions_data) {
      throw new Error(
        `Missing positions dataset in HDF5 file (tried: positions). Available datasets: ${Array.from(h5_file.keys()).join(`, `)}`,
      )
    }

    const positions = Array.isArray(positions_data[0]?.[0])
      ? positions_data as number[][][]
      : [positions_data as number[][]]
    const num_atoms = positions[0]?.length ?? 0

    // Fall back to unknown elements ('X') when atomic_numbers is missing
    let elements: ElementSymbol[]
    if (atomic_numbers_data) {
      const atomic_numbers = Array.isArray(atomic_numbers_data[0])
        ? atomic_numbers_data as number[][]
        : [atomic_numbers_data as number[]]
      elements = convert_atomic_numbers(atomic_numbers[0])
    } else {
      console.warn(`HDF5 file missing atomic_numbers dataset, using 'X' for all ${num_atoms} atoms`)
      elements = Array(num_atoms).fill(`X`) as ElementSymbol[]
    }

    const frames = positions.map((frame_positions, idx) => {
      const lattice_matrix = cells_data?.[idx] as Matrix3x3 | undefined
      const energy = energies_data?.[idx]?.[0]
      const metadata: Record<string, unknown> = {}
      if (energy !== undefined) metadata.energy = energy
      if (lattice_matrix) {
        metadata.volume = math.calc_lattice_params(lattice_matrix).volume
      }

      return create_trajectory_frame(
        frame_positions,
        elements,
        lattice_matrix,
        lattice_matrix ? [true, true, true] : [false, false, false],
        idx,
        metadata,
      )
    })

    return {
      frames,
      metadata: {
        source_format: `hdf5_trajectory`,
        frame_count: frames.length,
        num_atoms: elements.length,
        periodic_boundary_conditions: cells_data
          ? [true, true, true]
          : [false, false, false],
        element_counts: elements.reduce((counts: Record<string, number>, element) => {
          counts[element] = (counts[element] || 0) + 1
          return counts
        }, {}),
        discovered_datasets: {
          positions: found_paths.positions || `positions`,
          atomic_numbers: found_paths.atomic_numbers || found_paths.numbers ||
            found_paths.Z || found_paths.species || `unknown`,
          cells: found_paths.cell || found_paths.cells || found_paths.lattice,
          energies: found_paths.potential_energy || found_paths.energy,
        },
        total_groups_found: 1, // Simplified for now, could be enhanced
        has_cell_info: Boolean(cells_data),
      },
    }
  } finally {
    h5_file.close()
    try {
      FS.unlink(temp_filename)
    } catch { /* ignore */ }
  }
}
