import type { AnyStructure, Vec3 } from '$lib'
import type { TrajectoryFrame } from '$lib/trajectory'
import { electro_neg_formula } from '$lib'
import { download } from '$lib/io/fetch'
import * as math from '$lib/math'
import {
  Group,
  type InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Scene,
} from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js'

// Helper function to convert InstancedMesh to regular Mesh objects for export
// This is necessary because GLB/OBJ exporters don't handle InstancedMesh properly
// Note: Threlte's InstancedMesh sets isInstancedMesh=true but type remains "Mesh"
function convert_instanced_meshes_to_regular(scene: Scene): Scene {
  const cloned_scene = scene.clone()

  // Find all InstancedMesh objects in the cloned scene
  const instanced_meshes: InstancedMesh[] = []
  cloned_scene.traverse((object) => {
    // Check for isInstancedMesh property (Threlte) or type === InstancedMesh (vanilla Three.js)
    // @ts-expect-error - checking for isInstancedMesh property
    const is_instanced = object.isInstancedMesh === true ||
      object.type === `InstancedMesh`
    if (is_instanced) {
      instanced_meshes.push(object as InstancedMesh)
    }
  })

  // Convert each InstancedMesh to individual Mesh objects
  for (const instanced_mesh of instanced_meshes) {
    const parent = instanced_mesh.parent
    if (!parent || !instanced_mesh.instanceMatrix) continue

    // Create a group to hold all the individual meshes
    const group = new Group()
    group.name = instanced_mesh.name

    // Get the base transform from the InstancedMesh
    const base_matrix = new Matrix4()
    base_matrix.copy(instanced_mesh.matrix)

    // Create individual meshes for each instance
    const instance_matrix = new Matrix4()
    for (let idx = 0; idx < instanced_mesh.count; idx++) {
      instanced_mesh.getMatrixAt(idx, instance_matrix)

      // Clone geometry for each instance (applyMatrix4 modifies geometry in place)
      const mesh = new Mesh(
        instanced_mesh.geometry.clone(),
        instanced_mesh.material instanceof Array
          ? instanced_mesh.material.map((mat) => mat.clone())
          : instanced_mesh.material.clone(),
      )

      // Combine base transform with instance transform
      const combined_matrix = new Matrix4()
      combined_matrix.multiplyMatrices(base_matrix, instance_matrix)
      mesh.applyMatrix4(combined_matrix)

      // Copy instance color if it exists
      if (instanced_mesh.instanceColor) {
        const color_r = instanced_mesh.instanceColor.getX(idx)
        const color_g = instanced_mesh.instanceColor.getY(idx)
        const color_b = instanced_mesh.instanceColor.getZ(idx)

        if (mesh.material instanceof MeshStandardMaterial) {
          mesh.material.color.setRGB(color_r, color_g, color_b)
        } else if (Array.isArray(mesh.material)) {
          mesh.material.forEach((mat) => {
            if (mat instanceof MeshStandardMaterial) {
              mat.color.setRGB(color_r, color_g, color_b)
            }
          })
        }
      }

      group.add(mesh)
    }

    // Replace the InstancedMesh with the Group in the parent
    parent.remove(instanced_mesh)
    parent.add(group)

    // Update world matrices after scene graph modification
    group.updateMatrixWorld(true)
  }

  // Update all world matrices in the modified scene
  cloned_scene.updateMatrixWorld(true)

  return cloned_scene
}

// Generate a filename for structure exports based on structure metadata
export function create_structure_filename(
  structure: AnyStructure | undefined,
  extension: string,
): string {
  if (!structure) return `structure.${extension}`

  const parts: string[] = []

  if (structure.id) parts.push(structure.id) // Add ID if available

  // Add formula
  const formula_html = electro_neg_formula(structure)
  if (formula_html && formula_html !== `Unknown`) {
    const formula_plain = formula_html.replace(/<\/?sub>|<\/?sup>/g, ``)
    parts.push(formula_plain)
  }

  // Add space group if available
  if (
    `symmetry` in structure &&
    structure.symmetry &&
    typeof structure.symmetry === `object` &&
    `space_group_symbol` in structure.symmetry
  ) parts.push(String(structure.symmetry.space_group_symbol))

  // Add lattice system if available
  if (
    `lattice` in structure &&
    structure.lattice &&
    typeof structure.lattice === `object` &&
    `lattice_system` in structure.lattice
  ) parts.push(String(structure.lattice.lattice_system))

  // Add number of sites
  if (structure.sites?.length) parts.push(`${structure.sites.length}sites`)

  const base_name = parts.length > 0 ? parts.join(`_`) : `structure`
  return `${base_name}.${extension}`
}

// Generate XYZ content string without saving
export function structure_to_xyz_str(
  structure?: AnyStructure,
  include_forces = false,
): string {
  if (!structure?.sites) throw new Error(`No structure or sites to export`)

  const lines: string[] = []

  // First line: number of atoms
  lines.push(String(structure.sites.length))

  // Second line: comment (extended XYZ format)
  const comment_parts: string[] = []

  // Include extended XYZ lattice information when available
  if ((`lattice` in structure) && structure.lattice?.matrix?.length === 3) {
    const lattice_values = structure.lattice.matrix
      .flat()
      .map((value: number) => (Number.isFinite(value) ? value : 0).toFixed(8))
      .join(` `)
    comment_parts.push(`Lattice="${lattice_values}"`)
  }

  // Check if any site has forces
  const has_forces = include_forces && structure.sites.some(
    (site) => site.properties?.force && Array.isArray(site.properties.force),
  )

  // Build Properties string for extended XYZ
  const properties_cols = [`species:S:1`, `pos:R:3`]
  if (has_forces) properties_cols.push(`forces:R:3`)
  comment_parts.push(`Properties="${properties_cols.join(`:`)}"`)

  // Add energy/fmax/step if available
  const struct_any = structure as Record<string, unknown>
  if (`energy` in struct_any && typeof struct_any.energy === `number`) {
    comment_parts.push(`energy=${struct_any.energy}`)
  }
  if (`fmax` in struct_any && typeof struct_any.fmax === `number`) {
    comment_parts.push(`fmax=${struct_any.fmax}`)
  }
  if (`step` in struct_any && typeof struct_any.step === `number`) {
    comment_parts.push(`step=${struct_any.step}`)
  }

  // Add pbc
  if ((`lattice` in structure) && structure.lattice?.pbc) {
    const pbc_str = structure.lattice.pbc.map((v: boolean) => v ? `T` : `F`).join(` `)
    comment_parts.push(`pbc="${pbc_str}"`)
  }

  const comment = comment_parts.join(` `)
  lines.push(comment)

  // Atom lines: element symbol followed by coordinates and optionally forces
  for (const site of structure.sites) {
    // Extract element symbol from species
    let element_symbol = `X` // default fallback
    if (
      site.species &&
      Array.isArray(site.species) &&
      site.species.length > 0
    ) {
      const first_species = site.species[0]
      if (
        first_species && `element` in first_species && first_species.element
      ) element_symbol = first_species.element
    }

    // Get coordinates - prefer xyz; fallback to abc (converted to cartesian if lattice available)
    let coords: number[]
    if (site.xyz && Array.isArray(site.xyz) && site.xyz.length >= 3) {
      coords = site.xyz.slice(0, 3)
    } else if (
      site.abc &&
      Array.isArray(site.abc) &&
      site.abc.length >= 3 &&
      `lattice` in structure &&
      structure.lattice
    ) {
      // Convert fractional coordinates to cartesian
      const [a, b, c] = site.abc
      const lattice = structure.lattice
      if (
        lattice.matrix &&
        Array.isArray(lattice.matrix) &&
        lattice.matrix.length >= 3
      ) {
        const lattice_transposed = math.transpose_3x3_matrix(lattice.matrix)
        coords = math.mat3x3_vec3_multiply(lattice_transposed, [a, b, c])
      } else coords = [0, 0, 0] // fallback
    } else coords = [0, 0, 0] // fallback

    // Format coordinates to reasonable precision
    const [x, y, z] = coords.map((coord) => coord.toFixed(8))
    let line = `${element_symbol} ${x} ${y} ${z}`

    // Add forces if available
    if (has_forces) {
      const force = site.properties?.force as number[] | undefined
      if (force && force.length >= 3) {
        const [fx, fy, fz] = force.map((f) => f.toFixed(8))
        line += ` ${fx} ${fy} ${fz}`
      } else {
        line += ` 0.00000000 0.00000000 0.00000000`
      }
    }

    lines.push(line)
  }

  return lines.join(`\n`)
}

// Generate extended XYZ content with forces for optimization results
export function structure_to_extxyz_str(structure?: AnyStructure): string {
  return structure_to_xyz_str(structure, true)
}

// Generate multi-frame extended XYZ string from trajectory frames
export function trajectory_to_xyz_str(frames: TrajectoryFrame[]): string {
  return frames
    .map((frame) => structure_to_xyz_str(frame.structure, true))
    .join(`\n`)
}

// Generate CIF content string without saving
export function structure_to_cif_str(structure?: AnyStructure): string {
  if (!structure?.sites) throw new Error(`No structure or sites to export`)
  if (!(`lattice` in structure) || !structure.lattice) {
    throw new Error(`No lattice information for CIF export`)
  }

  const lines: string[] = []

  // CIF header
  lines.push(`# CIF file generated by CatGo`)
  // `data_<name>` is REQUIRED by the CIF spec — without it, downstream
  // parsers (ASE / pymatgen / OpenBabel) refuse the file. Derive the
  // block name from the structure id or formula, falling back to a
  // safe default.
  const data_name = (
    structure.id ||
    (`formula` in structure && structure.formula) ||
    `structure`
  ).toString().replace(/[^A-Za-z0-9_]/g, `_`).slice(0, 64) || `structure`
  lines.push(`data_${data_name}`)
  lines.push(``)

  // Cell parameters. Some upstream pipelines (server ASE → JSON, MLP
  // optimizer results, etc.) hand back `lattice.matrix` only, without
  // derived scalar a/b/c/alpha/beta/gamma fields. Falling through with
  // an empty cell block would silently produce a CIF with no lattice
  // information — atoms only — which is what the user reported.
  // Derive the scalars from the matrix when missing.
  const lattice = structure.lattice as Record<string, unknown>
  let a = lattice.a as number | undefined
  let b = lattice.b as number | undefined
  let c = lattice.c as number | undefined
  let alpha = lattice.alpha as number | undefined
  let beta = lattice.beta as number | undefined
  let gamma = lattice.gamma as number | undefined
  const matrix = lattice.matrix as number[][] | undefined
  const missing_scalars = !a || !b || !c || !alpha || !beta || !gamma
  if (missing_scalars && matrix && matrix.length === 3) {
    const [v1, v2, v3] = matrix
    const norm = (v: number[]) => Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
    const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
    const clamp = (x: number) => Math.max(-1, Math.min(1, x))
    const to_deg = (rad: number) => (rad * 180) / Math.PI
    a = a || norm(v1)
    b = b || norm(v2)
    c = c || norm(v3)
    alpha = alpha || to_deg(Math.acos(clamp(dot(v2, v3) / (b * c))))
    beta = beta || to_deg(Math.acos(clamp(dot(v1, v3) / (a * c))))
    gamma = gamma || to_deg(Math.acos(clamp(dot(v1, v2) / (a * b))))
  }

  if (a && b && c) {
    lines.push(`_cell_length_a ${a.toFixed(6)}`)
    lines.push(`_cell_length_b ${b.toFixed(6)}`)
    lines.push(`_cell_length_c ${c.toFixed(6)}`)
  } else {
    throw new Error(
      `No usable lattice parameters (need scalar a/b/c or 3x3 matrix) for CIF export`,
    )
  }
  if (alpha && beta && gamma) {
    lines.push(`_cell_angle_alpha ${alpha.toFixed(6)}`)
    lines.push(`_cell_angle_beta ${beta.toFixed(6)}`)
    lines.push(`_cell_angle_gamma ${gamma.toFixed(6)}`)
  }

  // Space group information
  if (
    `symmetry` in structure && structure.symmetry &&
    typeof structure.symmetry === `object`
  ) {
    const symmetry = structure.symmetry as Record<string, unknown>
    if (`space_group_symbol` in symmetry && symmetry.space_group_symbol) {
      lines.push(`_space_group_name_H-M_alt ${symmetry.space_group_symbol}`)
    }
    if (`space_group_number` in symmetry && symmetry.space_group_number) {
      lines.push(`_space_group_IT_number ${symmetry.space_group_number}`)
    }
  }

  lines.push(``)

  // Atom site loop header
  lines.push(`loop_`)
  lines.push(`_atom_site_label`)
  lines.push(`_atom_site_type_symbol`)
  lines.push(`_atom_site_fract_x`)
  lines.push(`_atom_site_fract_y`)
  lines.push(`_atom_site_fract_z`)
  lines.push(`_atom_site_occupancy`)

  // Atom sites
  for (let idx = 0; idx < structure.sites.length; idx++) {
    const site = structure.sites[idx]
    if (!site) continue // Skip if site is undefined

    // Extract element symbol from species
    let element_symbol = `X` // default fallback
    let occupancy = 1
    if (
      site.species &&
      Array.isArray(site.species) &&
      site.species.length > 0
    ) {
      const first_species = site.species[0]
      if (
        first_species && `element` in first_species && first_species.element
      ) {
        element_symbol = first_species.element
        occupancy = first_species?.occu ?? 1
      }
    }

    // Get fractional coordinates
    let frac_coords: number[]
    if (site.abc && Array.isArray(site.abc) && site.abc.length >= 3) {
      frac_coords = site.abc.slice(0, 3)
    } else if (
      site.xyz &&
      Array.isArray(site.xyz) &&
      site.xyz.length >= 3 &&
      matrix &&
      matrix.length === 3
    ) {
      // Convert cartesian to fractional coordinates. Cast the lattice
      // matrix to the strict 3-tuple-of-3-tuples shape that math helpers
      // expect — we've already validated length === 3 above.
      const m3 = matrix as unknown as math.Matrix3x3
      const lattice_transposed = math.transpose_3x3_matrix(m3)
      const lattice_inv = math.matrix_inverse_3x3(lattice_transposed)
      frac_coords = math.mat3x3_vec3_multiply(lattice_inv, site.xyz as Vec3)
    } else throw new Error(`No valid coordinates found for site ${idx}`)

    // Format: label element_symbol x y z
    const label = site.label || `${element_symbol}${idx + 1}`
    lines.push(
      `${label} ${element_symbol} ${frac_coords[0].toFixed(8)} ${
        frac_coords[1].toFixed(8)
      } ${frac_coords[2].toFixed(8)} ${occupancy.toFixed(8)}`,
    )
  }

  return lines.join(`\n`)
}

// Generate VASP POSCAR content string without saving
export function structure_to_poscar_str(structure?: AnyStructure): string {
  if (!structure?.sites) throw new Error(`No structure or sites to export`)
  if (!(`lattice` in structure) || !structure.lattice) {
    throw new Error(`No lattice information for POSCAR export`)
  }
  const lines: string[] = []

  // Use structure.id if available, otherwise generate plain-text formula
  // (electro_neg_formula returns HTML with <sub> tags, not suitable for POSCAR)
  let title = structure.id || ``
  if (!title) {
    const formula = electro_neg_formula(structure)
    title = formula ? formula.replace(/<\/?sub>/g, ``) : `Generated from structure`
  }
  lines.push(title)
  lines.push(`1.0`) // Scale factor (1.0 for direct coordinates)

  const lattice = structure.lattice
  if (lattice.matrix && Array.isArray(lattice.matrix) && lattice.matrix.length >= 3) {
    // Convert 3x3 matrix to 3 vectors
    const matrix = lattice.matrix
    lines.push(
      `${matrix[0][0].toFixed(8)} ${matrix[0][1].toFixed(8)} ${matrix[0][2].toFixed(8)}`,
    )
    lines.push(
      `${matrix[1][0].toFixed(8)} ${matrix[1][1].toFixed(8)} ${matrix[1][2].toFixed(8)}`,
    )
    lines.push(
      `${matrix[2][0].toFixed(8)} ${matrix[2][1].toFixed(8)} ${matrix[2][2].toFixed(8)}`,
    )
  } else {
    throw new Error(`No valid lattice matrix for POSCAR export`)
  }

  // Count atoms by group. For pseudo-hydrogen atoms (sites with
  // pseudo_h_potcar property), split into separate groups by charge type
  // so that the POSCAR element ordering matches the POTCAR concatenation.
  // Group key format: "Fe", "O", "H__H.50", "H__H1.50" etc.
  const group_counts = new Map<string, number>()
  const group_keys: string[] = []
  // Map group_key -> display element symbol (for POSCAR element line)
  const group_element: Map<string, string> = new Map()
  // Map group_key -> POTCAR comment (for pseudo-H annotation)
  const group_potcar: Map<string, string> = new Map()

  for (const site of structure.sites) {
    let element_symbol = `X`
    if (
      site.species &&
      Array.isArray(site.species) &&
      site.species.length > 0
    ) {
      const first_species = site.species[0]
      if (
        first_species && `element` in first_species && first_species.element
      ) {
        element_symbol = first_species.element
      }
    }

    // For pseudo-H atoms, use potcar name as sub-group key
    const potcar_name = site.properties?.pseudo_h_potcar as string | undefined
    const group_key = potcar_name ? `${element_symbol}__${potcar_name}` : element_symbol

    if (!group_counts.has(group_key)) {
      group_counts.set(group_key, 0)
      group_keys.push(group_key)
      group_element.set(group_key, element_symbol)
      if (potcar_name) group_potcar.set(group_key, potcar_name)
    }
    group_counts.set(group_key, Number(group_counts.get(group_key)) + 1)
  }

  // Element symbols line. For pseudo-H groups, use POTCAR name (e.g. "H.50")
  // so the user knows which POTCAR variant to concatenate.
  lines.push(group_keys.map((k) => group_potcar.get(k) ?? group_element.get(k)).join(` `))

  // Atom counts line
  lines.push(group_keys.map((k) => group_counts.get(k)).join(` `))

  // Check if any site has selective dynamics
  const has_selective_dynamics = structure.sites.some(
    (site) => site.properties?.selective_dynamics,
  )
  if (has_selective_dynamics) {
    lines.push(`Selective dynamics`)
  }

  // Coordinate mode (Direct = fractional coordinates)
  lines.push(`Direct`)

  // Atom coordinates grouped by group_key
  for (const group_key of group_keys) {
    for (const site of structure.sites) {
      let site_element = `X`
      if (
        site.species &&
        Array.isArray(site.species) &&
        site.species.length > 0
      ) {
        const first_species = site.species[0]
        if (
          first_species && `element` in first_species && first_species.element
        ) {
          site_element = first_species.element
        }
      }

      // Match site to group: for pseudo-H use potcar, otherwise use element
      const site_potcar = site.properties?.pseudo_h_potcar as string | undefined
      const site_key = site_potcar ? `${site_element}__${site_potcar}` : site_element

      if (site_key === group_key) {
        // Get fractional coordinates
        let frac_coords: number[]
        if (site.abc && Array.isArray(site.abc) && site.abc.length >= 3) {
          frac_coords = site.abc.slice(0, 3)
        } else if (
          site.xyz &&
          Array.isArray(site.xyz) &&
          site.xyz.length >= 3 &&
          lattice.matrix &&
          Array.isArray(lattice.matrix)
        ) {
          // Convert cartesian to fractional coordinates
          const lattice_transposed = math.transpose_3x3_matrix(lattice.matrix)
          const lattice_inv = math.matrix_inverse_3x3(lattice_transposed)
          frac_coords = math.mat3x3_vec3_multiply(
            lattice_inv,
            site.xyz.slice(0, 3) as Vec3,
          )
        } else {
          throw new Error(`No valid coordinates found for site`)
        }

        let selective_dynamics_str = ``
        if (has_selective_dynamics) {
          const sel_dyn = (site.properties?.selective_dynamics ?? [
            true,
            true,
            true,
          ]) as boolean[]
          selective_dynamics_str = ` ${sel_dyn[0] ? `T` : `F`} ${
            sel_dyn[1] ? `T` : `F`
          } ${sel_dyn[2] ? `T` : `F`}`
        }

        lines.push(
          `${frac_coords[0].toFixed(8)} ${frac_coords[1].toFixed(8)} ${
            frac_coords[2].toFixed(8)
          }${selective_dynamics_str}`,
        )
      }
    }
  }

  // Append pseudo-H POTCAR annotation as comments if any pseudo-H groups exist
  if (group_potcar.size > 0) {
    lines.push(``)
    const potcar_order = group_keys.map((k) => group_potcar.get(k) ?? group_element.get(k))
    lines.push(`# POTCAR order: ${potcar_order.join(` `)}`)
    for (const [key, potcar] of group_potcar) {
      const count = group_counts.get(key) ?? 0
      lines.push(`# ${potcar}: ${count} pseudo-H atoms`)
    }
  }

  return lines.join(`\n`)
}

// Generate JSON content string without saving
export function structure_to_json_str(structure?: AnyStructure): string {
  if (!structure) throw new Error(`No structure to export`)
  return JSON.stringify(structure, null, 2)
}

// Export structure as CIF format
export function export_structure_as_cif(structure?: AnyStructure): void {
  try {
    const content = structure_to_cif_str(structure)
    const filename = create_structure_filename(structure, `cif`)
    download(content, filename, `chemical/x-cif`)
  } catch (error) {
    console.error(`Failed to export CIF:`, error)
  }
}

// Export structure as VASP POSCAR format
export function export_structure_as_poscar(structure?: AnyStructure): void {
  try {
    const content = structure_to_poscar_str(structure)
    const filename = create_structure_filename(structure, `poscar`)
    download(content, filename, `text/plain`)
  } catch (error) {
    console.error(`Failed to export POSCAR:`, error)
  }
}

// Export structure as XYZ format. Format specification:
// - Line 1: Number of atoms
// - Line 2: Comment line (structure ID, formula, etc.)
// - Remaining lines: Element symbol followed by x, y, z coordinates (in Angstrom)
export function export_structure_as_xyz(structure?: AnyStructure): void {
  try {
    const xyz_content = structure_to_xyz_str(structure)
    const filename = create_structure_filename(structure, `xyz`)
    download(xyz_content, filename, `text/plain`)
  } catch (error) {
    console.error(`Error exporting XYZ:`, error)
  }
}

// Export structure as extended XYZ format with forces
// Includes lattice, forces, and energy for visualization in CatGo
export function export_structure_as_extxyz(structure?: AnyStructure): void {
  try {
    const xyz_content = structure_to_extxyz_str(structure)
    const filename = create_structure_filename(structure, `extxyz`)
    download(xyz_content, filename, `text/plain`)
  } catch (error) {
    console.error(`Error exporting extXYZ:`, error)
  }
}

// Export structure in pymatgen JSON format
export function export_structure_as_json(structure?: AnyStructure): void {
  try {
    const data = structure_to_json_str(structure)
    const filename = create_structure_filename(structure, `json`)
    download(data, filename, `application/json`)
  } catch (error) {
    console.error(`Error exporting JSON:`, error)
  }
}

// Export Three.js scene as GLB (binary GLTF) file
// GLB preserves materials and colors, making it ideal for element visualization
export function export_structure_as_glb(
  scene: Scene | null,
  structure: AnyStructure | undefined,
): void {
  try {
    if (!scene) {
      console.warn(`No scene available for GLB export`)
      return
    }

    // Convert instanced meshes to regular meshes for export
    const export_scene = convert_instanced_meshes_to_regular(scene)

    const exporter = new GLTFExporter()
    const filename = create_structure_filename(structure, `glb`)

    // Export as binary GLB format
    exporter.parse(
      export_scene,
      (result) => {
        if (result instanceof ArrayBuffer) {
          const blob = new Blob([result], { type: `model/gltf-binary` })
          download(blob, filename, `model/gltf-binary`)
        } else {
          console.error(`GLB export returned unexpected format`)
        }
      },
      (error) => {
        console.error(`GLB export failed:`, error)
      },
      { binary: true },
    )
  } catch (error) {
    console.error(`Error exporting GLB:`, error)
  }
}

// Export Three.js scene as OBJ (Wavefront Object) file
// OBJ exports geometry with material references, widely supported format
export function export_structure_as_obj(
  scene: Scene | null,
  structure: AnyStructure | undefined,
): void {
  try {
    if (!scene) {
      console.warn(`No scene available for OBJ export`)
      return
    }

    // Convert instanced meshes to regular meshes for export
    const export_scene = convert_instanced_meshes_to_regular(scene)

    const exporter = new OBJExporter()
    const filename = create_structure_filename(structure, `obj`)

    const result = exporter.parse(export_scene)

    // OBJ exporter returns a string
    const blob = new Blob([result], { type: `text/plain` })
    download(blob, filename, `text/plain`)
  } catch (error) {
    console.error(`Error exporting OBJ:`, error)
  }
}

// Generate MOL2 (Tripos Mol2) content string without saving
// MOL2 format is widely used in molecular modeling and computational chemistry
export function structure_to_mol2_str(structure?: AnyStructure): string {
  if (!structure?.sites) throw new Error(`No structure or sites to export`)

  const lines: string[] = []

  // MOL2 header
  lines.push(`@<TRIPOS>MOLECULE`)
  const title = structure.id || electro_neg_formula(structure) || `Molecule`
  lines.push(title)
  lines.push(`${structure.sites.length} ${structure.sites.length - 1} 1 0 0`) // num_atoms num_bonds num_subst num_feat num_sets

  // Molecular type and charges
  lines.push(`SMALL`)
  lines.push(`NO_CHARGES`)
  lines.push(``)
  lines.push(`@<TRIPOS>ATOM`)

  // Atom information
  for (let idx = 0; idx < structure.sites.length; idx++) {
    const site = structure.sites[idx]
    if (!site) continue

    // Extract element symbol and other info
    let element_symbol = `X`
    let atom_type = `C.3` // default sp3 carbon
    if (
      site.species &&
      Array.isArray(site.species) &&
      site.species.length > 0
    ) {
      const first_species = site.species[0]
      if (
        first_species && `element` in first_species && first_species.element
      ) {
        element_symbol = first_species.element
        // Simple atom type mapping
        atom_type = `${element_symbol}.3`
      }
    }

    // Get coordinates - prefer xyz (cartesian in Angstrom)
    let coords: number[]
    if (site.xyz && Array.isArray(site.xyz) && site.xyz.length >= 3) {
      coords = site.xyz.slice(0, 3)
    } else if (
      site.abc &&
      Array.isArray(site.abc) &&
      site.abc.length >= 3 &&
      `lattice` in structure &&
      structure.lattice?.matrix?.length === 3
    ) {
      // Convert fractional to cartesian
      const [a, b, c] = site.abc
      const lattice = structure.lattice.matrix
      const lattice_transposed = math.transpose_3x3_matrix(lattice)
      coords = math.mat3x3_vec3_multiply(lattice_transposed, [a, b, c])
    } else {
      coords = [0, 0, 0]
    }

    const atom_id = idx + 1
    const atom_name = `${element_symbol}${idx + 1}`
    const x = coords[0].toFixed(6)
    const y = coords[1].toFixed(6)
    const z = coords[2].toFixed(6)
    const residue_id = 1
    const residue_name = `UNK`
    const charge = `0.0000`

    // Format: atom_id atom_name x y z atom_type subst_id residue_id charge
    lines.push(
      `${atom_id} ${atom_name.padEnd(4)} ${x} ${y} ${z} ${atom_type.padEnd(6)} ${residue_id} ${residue_name.padEnd(4)} ${charge}`
    )
  }

  // Bond information (simple connectivity based on distance)
  lines.push(`@<TRIPOS>BOND`)
  let bond_id = 1
  const bond_threshold = 2.0 // Angstrom, simple threshold

  for (let i = 0; i < structure.sites.length; i++) {
    for (let j = i + 1; j < structure.sites.length; j++) {
      const site_i = structure.sites[i]
      const site_j = structure.sites[j]
      if (!site_i?.xyz || !site_j?.xyz) continue

      const dx = site_i.xyz[0] - site_j.xyz[0]
      const dy = site_i.xyz[1] - site_j.xyz[1]
      const dz = site_i.xyz[2] - site_j.xyz[2]
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)

      if (distance < bond_threshold) {
        const bond_type = `1` // single bond as default
        lines.push(`${bond_id} ${i + 1} ${j + 1} ${bond_type}`)
        bond_id++
      }
    }
  }

  return lines.join(`\n`)
}

// Generate PDB (Protein Data Bank) content string without saving
// PDB format is standard for biomolecular structures
export function structure_to_pdb_str(structure?: AnyStructure): string {
  if (!structure?.sites) throw new Error(`No structure or sites to export`)

  const lines: string[] = []

  // PDB header
  lines.push(`HEADER    Generated by CatGO`)
  if (structure.id) {
    const title = structure.id.substring(0, 50).padEnd(50)
    lines.push(`TITLE     ${title}`)
  }
  lines.push(`REMARK   255 This is a converted crystal structure, not a protein`)

  // Atom records
  for (let idx = 0; idx < structure.sites.length; idx++) {
    const site = structure.sites[idx]
    if (!site) continue

    // Extract element symbol
    let element_symbol = `X`
    let atom_name = `X`
    if (
      site.species &&
      Array.isArray(site.species) &&
      site.species.length > 0
    ) {
      const first_species = site.species[0]
      if (
        first_species && `element` in first_species && first_species.element
      ) {
        element_symbol = first_species.element
        // PDB atom name: element symbol right-aligned in 4 chars
        atom_name = element_symbol.length === 4
          ? element_symbol
          : element_symbol.padStart(3, ` `)
      }
    }

    // Get coordinates - prefer xyz (cartesian in Angstrom)
    let coords: number[]
    if (site.xyz && Array.isArray(site.xyz) && site.xyz.length >= 3) {
      coords = site.xyz.slice(0, 3)
    } else if (
      site.abc &&
      Array.isArray(site.abc) &&
      site.abc.length >= 3 &&
      `lattice` in structure &&
      structure.lattice?.matrix?.length === 3
    ) {
      // Convert fractional to cartesian
      const [a, b, c] = site.abc
      const lattice = structure.lattice.matrix
      const lattice_transposed = math.transpose_3x3_matrix(lattice)
      coords = math.mat3x3_vec3_multiply(lattice_transposed, [a, b, c])
    } else {
      coords = [0, 0, 0]
    }

    const serial = idx + 1
    const name = atom_name.padEnd(4)
    const altLoc = ` `
    const resName = `UNK`
    const chainID = `A`
    const resSeq = ((idx % 9999) + 1).toString().padStart(4)
    const iCode = ` `
    const x = coords[0].toFixed(3).padStart(12)
    const y = coords[1].toFixed(3).padStart(12)
    const z = coords[2].toFixed(3).padStart(12)
    const occupancy = `1.00`.padStart(6)
    const tempFactor = `0.00`.padStart(6)
    const element = element_symbol.padEnd(2)
    const charge = `  `

    // PDB ATOM record format (columns 1-80 fixed width)
    lines.push(
      `ATOM  ${serial.toString().padStart(6)} ${name} ${altLoc}${resName} ${chainID}${resSeq}${iCode} ${x}${y}${z}${occupancy}${tempFactor}          ${element}${charge}`
    )
  }

  // PDB footer
  lines.push(`END`)
  lines.push(`ENDMDL`)

  return lines.join(`\n`)
}

// Export structure as MOL2 format
export function export_structure_as_mol2(structure?: AnyStructure): void {
  try {
    const content = structure_to_mol2_str(structure)
    const filename = create_structure_filename(structure, `mol2`)
    download(content, filename, `text/plain`)
  } catch (error) {
    console.error(`Failed to export MOL2:`, error)
  }
}

// Export structure as PDB format
export function export_structure_as_pdb(structure?: AnyStructure): void {
  try {
    const content = structure_to_pdb_str(structure)
    const filename = create_structure_filename(structure, `pdb`)
    download(content, filename, `text/plain`)
  } catch (error) {
    console.error(`Failed to export PDB:`, error)
  }
}
