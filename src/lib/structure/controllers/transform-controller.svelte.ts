/**
 * Transform Controller — extracted from Structure.svelte
 *
 * Manages the structure transformation pipeline:
 * - Cell type transformation (original, conventional, primitive)
 * - Supercell generation (async WASM)
 * - PBC image atom expansion
 * - Lattice alignment rotation
 * - displayed_structure and saveable_structure sync
 *
 * The pipeline is: structure -> cell_transformed -> supercell -> PBC images -> displayed
 *
 * Uses .svelte.ts suffix because internal state uses $state/$derived/$effect runes.
 */

import type { AnyStructure, PymatgenStructure, Crystal } from '$lib/structure'
import type { Vec3 } from '$lib/math'
import { get_periodic_repeat_sites, find_pbc_images_fast } from '$lib/structure'
import { is_valid_supercell_input, parse_supercell_scaling } from '$lib/structure/supercell'
import { create_supercell, is_ok } from '$lib/structure/ferrox-wasm'
import { transform_cell } from '$lib/symmetry'
import type { MoyoDataset } from '@spglib/moyo-wasm'

// ─── Types ───

export interface TransformDeps {
  get_structure: () => AnyStructure | undefined
  get_symmetry_data: () => MoyoDataset | null
  get_cell_type: () => 'original' | 'conventional' | 'primitive'
  get_supercell_scaling: () => string
  get_show_image_atoms: () => boolean
  get_periodic_repeats: () => Vec3
  /** When true, the GPU overlay renders the supercell by INSTANCING the base
   *  cell on the GPU, so the CPU must NOT expand it. The supercell + PBC-image
   *  effects then short-circuit to the BASE (cell-transformed) structure — net
   *  `displayed_structure` stays base-cell sized, no N× Site objects built.
   *  Defaults to () => false (absent dep) ⇒ unchanged CPU expansion behaviour. */
  get_gpu_supercell_active?: () => boolean
  set_displayed_structure: (s: AnyStructure | undefined) => void
  set_saveable_structure: (s: AnyStructure | undefined) => void
}

// ─── Factory ───

export function create_transform_controller(deps: TransformDeps) {
  // ═══ Cell Type Transform ═══
  let cell_transformed_structure = $derived.by(() => {
    const structure = deps.get_structure()
    const cell_type = deps.get_cell_type()
    if (!structure || !('lattice' in structure)) return structure
    if (cell_type === 'original') return structure
    const symmetry_data = deps.get_symmetry_data()
    if (!symmetry_data) return structure
    try {
      return transform_cell(structure as Crystal, cell_type, symmetry_data)
    } catch (error) {
      console.error(`Failed to transform cell to ${cell_type}:`, error)
      return structure
    }
  })

  // ═══ Supercell ═══
  let supercell_structure = $state<AnyStructure | undefined>(undefined)
  let supercell_loading = $state(false)
  let supercell_run_id = 0

  $effect(() => {
    const base_structure = cell_transformed_structure
    const supercell_scaling = deps.get_supercell_scaling()
    // GPU-supercell gate: when the overlay instances the base cell on the GPU,
    // the CPU must keep `supercell_structure` at the BASE cell (no WASM expand,
    // no N× Site objects). Read reactively so flipping it OFF re-fires this
    // effect and the CPU resumes building the real supercell.
    const gpu_supercell_active = deps.get_gpu_supercell_active?.() ?? false

    if (gpu_supercell_active) {
      supercell_structure = base_structure
      supercell_loading = false
    } else if (!base_structure || !('lattice' in base_structure)) {
      supercell_structure = base_structure
      supercell_loading = false
    } else if (['', '1x1x1', '1'].includes(supercell_scaling)) {
      supercell_structure = base_structure
      supercell_loading = false
    } else if (!is_valid_supercell_input(supercell_scaling)) {
      supercell_structure = base_structure
      supercell_loading = false
    } else {
      const run_id = ++supercell_run_id
      supercell_loading = true
      const [nx, ny, nz] = parse_supercell_scaling(supercell_scaling)

      create_supercell(base_structure as Crystal, nx, ny, nz)
        .then((result) => {
          if (run_id !== supercell_run_id) return
          if (is_ok(result)) {
            const sc = result.ok as PymatgenStructure
            const orig_n = base_structure.sites.length
            if (orig_n > 0) {
              for (let i = 0; i < sc.sites.length; i++) {
                sc.sites[i].properties = { ...sc.sites[i].properties, orig_unit_cell_idx: i % orig_n }
              }
            }
            supercell_structure = sc
          } else {
            console.error('Failed to create supercell:', result.error)
            supercell_structure = base_structure
          }
        })
        .catch((error) => {
          if (run_id !== supercell_run_id) return
          console.error('Failed to create supercell:', error)
          supercell_structure = base_structure
        })
        .finally(() => {
          if (run_id === supercell_run_id) supercell_loading = false
        })
    }
  })

  // ═══ PBC Image Atoms ═══
  let pbc_gen = 0

  $effect(() => {
    const show_image_atoms = deps.get_show_image_atoms()
    const repeats = deps.get_periodic_repeats()
    const ss = supercell_structure
    // GPU-supercell gate: the overlay instances the base cell (+ later phases its
    // PBC partners) entirely on the GPU, so the CPU must NOT append image atoms.
    // `displayed_structure` stays the base cell (= ss, which the supercell effect
    // above pinned to base). Read reactively so flipping OFF resumes CPU images.
    const gpu_supercell_active = deps.get_gpu_supercell_active?.() ?? false

    if (gpu_supercell_active) {
      deps.set_displayed_structure(ss)
    } else if (show_image_atoms && ss && 'lattice' in ss && ss.lattice) {
      const has_repeats = repeats[0] > 0 || repeats[1] > 0 || repeats[2] > 0
      if (has_repeats) {
        deps.set_displayed_structure(get_periodic_repeat_sites(ss, repeats))
      } else {
        const gen = ++pbc_gen
        // Show structure immediately while WASM computes images
        deps.set_displayed_structure(ss)
        find_pbc_images_fast(ss).then((result) => {
          if (gen === pbc_gen) {
            deps.set_displayed_structure(result)
          }
        })
      }
    } else {
      deps.set_displayed_structure(ss)
    }
  })

  // ═══ Saveable Structure Sync ═══
  $effect(() => {
    const structure = deps.get_structure()
    deps.set_saveable_structure(supercell_structure ?? structure)
  })

  // ═══ Lattice Alignment ═══
  let lattice_alignment_rotation: Vec3 = $state([0, 0, 0])
  let lattice_align_trigger = $state(0)

  function compute_lattice_rotation(lattice_matrix: [Vec3, Vec3, Vec3]): Vec3 {
    const [a, b] = lattice_matrix
    const nx = a[1] * b[2] - a[2] * b[1]
    const ny = a[2] * b[0] - a[0] * b[2]
    const nz = a[0] * b[1] - a[1] * b[0]
    const n_len = Math.hypot(nx, ny, nz)
    if (n_len < 1e-10) return [0, 0, 0]

    const n_hat: Vec3 = [nx / n_len, ny / n_len, nz / n_len]
    const a_len = Math.hypot(a[0], a[1], a[2])
    if (a_len < 1e-10) return [0, 0, 0]
    const a_hat: Vec3 = [a[0] / a_len, a[1] / a_len, a[2] / a_len]

    const ux = n_hat[1] * a_hat[2] - n_hat[2] * a_hat[1]
    const uy = n_hat[2] * a_hat[0] - n_hat[0] * a_hat[2]
    const uz = n_hat[0] * a_hat[1] - n_hat[1] * a_hat[0]
    const u_len = Math.hypot(ux, uy, uz)
    if (u_len < 1e-10) return [0, 0, 0]
    const up_hat: Vec3 = [ux / u_len, uy / u_len, uz / u_len]

    const sin_beta = Math.max(-1, Math.min(1, -n_hat[0]))
    const beta = Math.asin(sin_beta)
    const cos_beta = Math.cos(beta)

    let alpha: number, gamma: number
    if (Math.abs(cos_beta) > 1e-6) {
      alpha = Math.atan2(n_hat[1], n_hat[2])
      gamma = Math.atan2(up_hat[0], a_hat[0])
    } else {
      alpha = Math.atan2(-a_hat[1], up_hat[1])
      gamma = 0
    }
    return [alpha, beta, gamma]
  }

  // ═══ Public Interface ═══

  return {
    /** The BASE (cell-type-transformed) structure, BEFORE any supercell expansion
     *  or PBC-image append. This is what the GPU overlay instances when
     *  `get_gpu_supercell_active` is true. */
    get base_structure() { return cell_transformed_structure },
    get supercell_structure() { return supercell_structure },
    get supercell_loading() { return supercell_loading },

    get lattice_alignment_rotation() { return lattice_alignment_rotation },
    set lattice_alignment_rotation(v: Vec3) { lattice_alignment_rotation = v },
    get lattice_align_trigger() { return lattice_align_trigger },
    set lattice_align_trigger(v: number) { lattice_align_trigger = v },

    compute_lattice_rotation,

    /**
     * Align the view so lattice a -> X, lattice normal(a x b) -> Z.
     * Caller must also set scene_props.rotation and reset camera state.
     */
    compute_alignment(structure: AnyStructure | undefined): Vec3 {
      const lattice_matrix = (structure as any)?.lattice?.matrix
      if (lattice_matrix) {
        lattice_alignment_rotation = compute_lattice_rotation(lattice_matrix as [Vec3, Vec3, Vec3])
      } else {
        lattice_alignment_rotation = [0, 0, 0]
      }
      lattice_align_trigger++
      return [...lattice_alignment_rotation] as Vec3
    },
  }
}

export type TransformController = ReturnType<typeof create_transform_controller>
