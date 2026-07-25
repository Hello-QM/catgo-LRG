/**
 * Transform Controller — extracted from Structure.svelte
 *
 * Manages the structure transformation pipeline:
 * - Cell type transformation (original, conventional, primitive)
 * - PBC image atom expansion (display decoration only)
 * - Lattice alignment rotation
 * - displayed_structure and saveable_structure sync
 *
 * The pipeline is: structure -> cell_transformed (base) -> PBC images -> displayed
 *
 * Visual T6: the viewer's bottom-right visual supercell control is VIEW-ONLY.
 * It never materializes a scientific supercell here — replica dims travel
 * exclusively as a `ReplicaLayout` inside the render packet (see
 * scene/render-packet-builder.ts), and both `displayed_structure` and
 * `saveable_structure` stay at the base effective frame. True scientific
 * supercells are the explicit Build/LatticePane operation channel.
 *
 * Uses .svelte.ts suffix because internal state uses $state/$derived/$effect runes.
 */

import type { AnyStructure, Crystal, PymatgenStructure } from '$lib/structure'
import type { Vec3 } from '$lib/math'
import { get_periodic_repeat_sites, find_pbc_images_fast } from '$lib/structure'
import { transform_cell } from '$lib/symmetry'
import type { MoyoDataset } from '@spglib/moyo-wasm'

// ─── Types ───

export interface TransformDeps {
  get_structure: () => AnyStructure | undefined
  get_symmetry_data: () => MoyoDataset | null
  get_cell_type: () => 'original' | 'conventional' | 'primitive'
  get_show_image_atoms: () => boolean
  get_periodic_repeats: () => Vec3
  /** True while the render packet path owns visual replication (replicas AND
   *  ghost images are GPU instancing concerns — see `visual_replication_active`
   *  in ./transform-controller.ts). While true the CPU must NOT append PBC
   *  image sites: `displayed_structure` stays the base cell. Read reactively
   *  so flipping OFF resumes the legacy CPU image decoration. Defaults to
   *  () => false (absent dep). Note this is a DISPLAY routing flag only — the
   *  scientific structure stays at the base frame in either state. */
  get_visual_replicas_active?: () => boolean
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

  // ═══ PBC Image Atoms (display decoration only) ═══
  let pbc_gen = 0

  $effect(() => {
    const show_image_atoms = deps.get_show_image_atoms()
    const repeats = deps.get_periodic_repeats()
    const base: AnyStructure | undefined = cell_transformed_structure
    // Packet gate: while the render packet owns visual replication, ghost
    // images are GPU instancing concerns (`boundary_policy: ghost-images`),
    // so the CPU must NOT append image sites. `displayed_structure` stays
    // the base cell. Read reactively so flipping OFF resumes CPU images.
    const visual_replicas_active = deps.get_visual_replicas_active?.() ?? false

    if (visual_replicas_active) {
      deps.set_displayed_structure(base)
    } else if (show_image_atoms && base && 'lattice' in base && base.lattice) {
      // Guard above proves a real lattice — safe periodic narrowing.
      const periodic = base as PymatgenStructure
      const has_repeats = repeats[0] > 0 || repeats[1] > 0 || repeats[2] > 0
      if (has_repeats) {
        deps.set_displayed_structure(get_periodic_repeat_sites(periodic, repeats))
      } else {
        const gen = ++pbc_gen
        // Show structure immediately while WASM computes images
        deps.set_displayed_structure(periodic)
        find_pbc_images_fast(periodic).then((result) => {
          if (gen === pbc_gen) {
            deps.set_displayed_structure(result)
          }
        })
      }
    } else {
      deps.set_displayed_structure(base)
    }
  })

  // ═══ Saveable Structure Sync ═══
  // The scientific structure is ALWAYS the base effective frame — visual
  // replica dims and PBC image decoration never reach it.
  $effect(() => {
    const structure = deps.get_structure()
    deps.set_saveable_structure(cell_transformed_structure ?? structure)
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
    /** The BASE (cell-type-transformed) structure, BEFORE any PBC-image
     *  append. This is what the render packet / GPU overlay instances when
     *  `get_visual_replicas_active` is true. */
    get base_structure() { return cell_transformed_structure },
    /** Back-compat alias — visual replication is view-only (Visual T6), so
     *  the "supercell" structure IS the base effective frame. */
    get supercell_structure() { return cell_transformed_structure },
    /** Always false — no CPU/WASM supercell materialization remains. */
    get supercell_loading() { return false },

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
