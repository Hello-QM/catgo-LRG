<script lang="ts">
  import '$lib/dialog-shared.css'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { PymatgenStructure, Site } from '$lib'
  import type { NodeDefinition } from './workflow-types'
  import { STATUS_COLORS } from './workflow-types'
  import type { AdsorptionSite } from '$lib/structure/ferrox-wasm-types'
  import { ADSORBATE_PRESETS, ADSORBATE_PRESET_GROUPS, place_adsorbate_local, type AdsorbatePreset } from '$lib/api/adsorbate'
  import { wasm_find_adsorption_sites } from '$lib/structure/ferrox-wasm'
  import { search_pubchem_compounds, fetch_pubchem_compound, extract_atoms_from_pubchem } from '$lib/api/pubchem'
  import { atomic_number_to_symbol } from '$lib/composition/parse'
  import StructurePreview from '$lib/structure/StructurePreview.svelte'
  import StructureScene from '$lib/structure/StructureScene.svelte'
  import { DEFAULTS } from '$lib/settings'
  import { Canvas } from '@threlte/core'
  import { ACESFilmicToneMapping } from 'three'
  import type { Vec3 } from '$lib/structure'

  load_i18n_module(`workflow`)

  // ─── Site selection strategies ───
  // Extensible: add new strategies here, select via `site_strategy` param.
  type SiteStrategy = `nearest_center_top` | `first_top` | `first_bridge` | `first_hollow` | `manual_position`

  /**
   * Auto-select a site from the list based on a strategy.
   * Returns the chosen site, or null if no matching site is found.
   */
  function select_site(
    sites: AdsorptionSite[],
    structure: PymatgenStructure,
    strategy: SiteStrategy,
  ): AdsorptionSite | null {
    if (sites.length === 0) return null

    switch (strategy) {
      case `nearest_center_top`: {
        // Find the top site closest to the cell center
        const top_sites = sites.filter(s => s.site_type === `top`)
        if (top_sites.length === 0) return sites[0] // fallback: first site of any type

        // Compute cell center from lattice matrix (0.5*a + 0.5*b + 0.5*c)
        const lat = structure.lattice?.matrix
        let cx = 0, cy = 0, cz = 0
        if (lat && lat.length >= 3) {
          for (let i = 0; i < 3; i++) {
            cx += 0.5 * lat[i][0]
            cy += 0.5 * lat[i][1]
            cz += 0.5 * lat[i][2]
          }
        } else {
          // No lattice — use atom centroid
          for (const s of structure.sites) {
            const xyz = s.xyz ?? s.abc
            if (xyz) { cx += xyz[0]; cy += xyz[1]; cz += xyz[2] }
          }
          const n = structure.sites.length || 1
          cx /= n; cy /= n; cz /= n
        }

        let best: AdsorptionSite | null = null
        let best_d2 = Infinity
        for (const s of top_sites) {
          const dx = s.position[0] - cx
          const dy = s.position[1] - cy
          const dz = s.position[2] - cz
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 < best_d2) { best_d2 = d2; best = s }
        }
        return best
      }
      case `first_top`:
        return sites.find(s => s.site_type === `top`) ?? sites[0]
      case `first_bridge`:
        return sites.find(s => s.site_type === `bridge`) ?? sites[0]
      case `first_hollow`:
        return sites.find(s => s.site_type === `hollow3` || s.site_type === `hollow4`) ?? sites[0]
      case `manual_position`:
        // Manual strategy: don't auto-select from sites list
        return null
      default:
        return sites[0]
    }
  }

  let {
    node,
    definition,
    status,
    onparams_change,
    onedit_3d,
    upstream_structure_json,
    upstream_structures_json,
  }: {
    node: { id: string; type: string; params: Record<string, unknown> }
    definition: NodeDefinition
    status?: string
    onparams_change?: (params: Record<string, unknown>) => void
    onedit_3d?: (
      preview?: PymatgenStructure,
      sites?: import('$lib/structure/ferrox-wasm-types').AdsorptionSite[],
      on_site_picked?: (site_idx: number) => PymatgenStructure | null,
      on_confirm?: (final_structure: PymatgenStructure) => void,
    ) => void
    upstream_structure_json?: string | null
    upstream_structures_json?: string[] | null
  } = $props()

  // ─── Local state ───
  let show_help = $state(false)

  // ─── Multi-structure slider ───
  let struct_index = $state<number>((node.params._struct_index as number) ?? 0)

  const upstream_structs_parsed = $derived.by((): PymatgenStructure[] | null => {
    if (!upstream_structures_json || upstream_structures_json.length <= 1) return null
    try {
      return upstream_structures_json.map(s => JSON.parse(s) as PymatgenStructure)
    } catch { return null }
  })

  const has_multi_structs = $derived(!!(upstream_structs_parsed && upstream_structs_parsed.length > 1))

  // ─── Derived state ───
  const status_color = $derived(status ? STATUS_COLORS[status] ?? `#475569` : null)

  const upstream_structure = $derived.by(() => {
    // Multi-structure: use slider index
    if (upstream_structs_parsed && upstream_structs_parsed.length > 1) {
      const idx = Math.min(struct_index, upstream_structs_parsed.length - 1)
      return upstream_structs_parsed[idx] ?? null
    }
    if (!upstream_structure_json) return null
    try { return JSON.parse(upstream_structure_json) as PymatgenStructure } catch { return null }
  })

  const upstream_info = $derived.by(() => {
    if (!upstream_structure?.sites) return null
    const counts: Record<string, number> = {}
    for (const site of upstream_structure.sites) {
      const el = site.species?.[0]?.element ?? site.label ?? `?`
      counts[el] = (counts[el] ?? 0) + 1
    }
    const formula = Object.entries(counts).map(([el, n]) => n === 1 ? el : `${el}${n}`).join(``)
    return { formula, n_atoms: upstream_structure.sites.length }
  })

  // ─── Node params ───
  type SourceType = `preset` | `xyz` | `pubchem` | `self_define`
  let source_type = $state<SourceType>((node.params._source_type as SourceType) ?? `preset`)

  // Resolve initial species_idx. The panel used to read only its internal
  // cache key `_species_idx`, which CatBot / MCP never set — they store the
  // canonical formula in `params.species`. So a workflow with
  // `params.species = "OH"` opened in this panel showed ADSORBATE_PRESETS[0]
  // (Atomic hydrogen), making the user think CatBot hadn't picked an
  // adsorbate at all. Now we fall back to looking up the formula in the
  // preset library (stripping any leading "*" / Unicode subscripts), so
  // MCP-built workflows display the right molecule.
  function _resolve_initial_species_idx(): number {
    if (typeof node.params._species_idx === `number`) return node.params._species_idx as number
    const raw = node.params.species
    if (typeof raw !== `string` || !raw) return 0
    const ascii = raw.replace(/^\*+/, ``).replace(/[₀-₉]/g, (c) =>
      String(c.charCodeAt(0) - 0x2080),
    ).toUpperCase()
    const idx = ADSORBATE_PRESETS.findIndex((p) => p.formula.toUpperCase() === ascii)
    return idx >= 0 ? idx : 0
  }
  let species_idx = $state<number>(_resolve_initial_species_idx())

  // XYZ custom input
  let xyz_text = $state<string>((node.params._xyz_text as string) ?? `C 0.000 0.000 0.000\nO 0.000 0.000 1.128`)
  let xyz_parse_error = $state<string | null>(null)

  // PubChem
  let pubchem_query = $state<string>((node.params._pubchem_query as string) ?? ``)
  let pubchem_searching = $state(false)
  let pubchem_results = $state<{ cid: number; formula: string; name?: string }[]>([])
  let pubchem_loading = $state(false)
  let pubchem_error = $state<string | null>(null)

  // Self-define editor
  let sd_open = $state(false)
  let sd_text = $state((node.params._xyz_text as string) ?? `C 0.000 0.000 0.000`)
  let sd_element = $state(`C`)
  let sd_x = $state(0)
  let sd_y = $state(0)
  let sd_z = $state(0)

  // Custom atoms (from XYZ, PubChem, or Self-define)
  type CustomAtom = { symbol: string; position: [number, number, number] }
  let custom_atoms = $state<CustomAtom[]>(
    Array.isArray(node.params._custom_atoms) ? (node.params._custom_atoms as CustomAtom[]) : []
  )
  let custom_binding_index = $state<number>((node.params._custom_binding_index as number) ?? 0)

  /** The currently active adsorbate, regardless of source */
  const active_adsorbate = $derived.by((): AdsorbatePreset | null => {
    if (source_type === `preset`) {
      return ADSORBATE_PRESETS[species_idx] ?? null
    }
    // XYZ, PubChem, or Self-define: build from custom_atoms
    if (custom_atoms.length === 0) return null
    const names: Record<string, string> = { pubchem: pubchem_query || `Custom`, self_define: `Self-defined`, xyz: `Custom XYZ` }
    return {
      name: names[source_type] ?? `Custom`,
      formula: [...new Set(custom_atoms.map(a => a.symbol))].join(``),
      atoms: custom_atoms,
      default_binding_index: custom_binding_index,
    }
  })

  // Molecule preview for binding atom visualization
  let mol_preview = $derived.by(() => {
    const mol = active_adsorbate
    if (!mol || mol.atoms.length === 0) return null
    return {
      sites: mol.atoms.map(a => ({
        species: [{ element: a.symbol, occu: 1, oxidation_state: 0 }],
        abc: a.position, xyz: a.position,
        label: a.symbol, properties: {},
      })) as any,
    }
  })
  let mol_pw = $state(0)
  let mol_ph = $state(0)
  const {
    show_image_atoms: _mia, atom_color_mode: _mcm, atom_color_scale: _mcs,
    atom_color_scale_type: _mcst, show_gizmo: _mg, show_cell: _mc,
    show_cell_vectors: _mcv, cell_edge_opacity: _meo, cell_surface_opacity: _mso,
    cell_edge_color: _mec, cell_surface_color: _msc, cell_edge_width: _mew,
    fullscreen_toggle: _mft, keyboard_movement_step: _mks,
    frozen_atom_indicator: _mfi, force_shaft_radius: _mfsr,
    force_arrow_head_radius: _mfar, force_arrow_head_length: _mfal,
    ...mol_scene_defaults
  } = DEFAULTS.structure
  const mol_scene_props = {
    ...mol_scene_defaults, auto_rotate: 0, rotation_damping: 0,
    camera_position: [0, 0, 0] as [number, number, number],
    show_cell: false, show_cell_vectors: false, show_gizmo: false,
  }

  // XYZ parser
  function parse_xyz_text(text: string): { atoms: typeof custom_atoms; error: string | null } {
    const lines = text.trim().split(`\n`).filter(l => l.trim())
    if (lines.length === 0) return { atoms: [], error: `No atoms defined` }
    const atoms: typeof custom_atoms = []
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 4) return { atoms: [], error: `Invalid line: ${line}` }
      const [symbol, x, y, z] = parts
      if (isNaN(Number(x)) || isNaN(Number(y)) || isNaN(Number(z)))
        return { atoms: [], error: `Invalid coordinates: ${line}` }
      atoms.push({ symbol, position: [Number(x), Number(y), Number(z)] })
    }
    return { atoms, error: null }
  }

  $effect(() => {
    if (source_type !== `xyz` && source_type !== `self_define`) return
    const text = source_type === `self_define` ? sd_text : xyz_text
    const result = parse_xyz_text(text)
    if (result.error) { xyz_parse_error = result.error; custom_atoms = [] }
    else { xyz_parse_error = null; custom_atoms = result.atoms }
  })


  // Self-define helpers
  function sd_add_atom() {
    const line = `${sd_element} ${sd_x.toFixed(3)} ${sd_y.toFixed(3)} ${sd_z.toFixed(3)}`
    sd_text = sd_text.trim() ? sd_text.trim() + `\n` + line : line
    update_param(`_xyz_text`, sd_text)
  }

  function sd_remove_last() {
    const lines = sd_text.trim().split(`\n`).filter(l => l.trim())
    lines.pop()
    sd_text = lines.join(`\n`)
    update_param(`_xyz_text`, sd_text)
  }

  function sd_clear() {
    sd_text = ``
    custom_atoms = []
    update_param(`_xyz_text`, ``)
  }

  function sd_confirm() {
    sd_open = false
    update_param(`_custom_atoms`, custom_atoms)
    result_structure = null

  }

  // Pending action after user answers the keep/clear prompt
  let sd_pending_action = $state<`editor` | `surface` | null>(null)
  let sd_show_prompt = $state(false)

  function sd_handle_prompt(keep: boolean) {
    sd_show_prompt = false
    if (!keep) { custom_atoms = []; sd_text = `` }
    if (sd_pending_action === `editor`) _do_open_3d_editor()
    else if (sd_pending_action === `surface`) _do_open_with_surface()
    sd_pending_action = null
  }

  function sd_open_3d_editor() {
    if (custom_atoms.length > 0) {
      sd_pending_action = `editor`
      sd_show_prompt = true
      return
    }
    _do_open_3d_editor()
  }

  function _do_open_3d_editor() {
    const seed_atoms = custom_atoms.length > 0 ? custom_atoms : [{ symbol: `C`, position: [0, 0, 0] as [number, number, number] }]
    const box = 10
    const seed_structure: PymatgenStructure = {
      lattice: {
        matrix: [[box, 0, 0], [0, box, 0], [0, 0, box]],
        a: box, b: box, c: box,
        alpha: 90, beta: 90, gamma: 90,
        volume: box ** 3,
        pbc: [false, false, false],
      },
      sites: seed_atoms.map(a => ({
        species: [{ element: a.symbol, occu: 1, oxidation_state: 0 }],
        abc: [a.position[0] / box + 0.5, a.position[1] / box + 0.5, a.position[2] / box + 0.5],
        xyz: [a.position[0] + box / 2, a.position[1] + box / 2, a.position[2] + box / 2],
        label: a.symbol,
        properties: {},
      }) as Site),
    }

    _open_sd_editor(seed_structure, 0, box / 2)
  }

  function sd_open_with_surface() {
    if (!upstream_structure?.sites) return
    if (custom_atoms.length > 0) {
      sd_pending_action = `surface`
      sd_show_prompt = true
      return
    }
    _do_open_with_surface()
  }

  function _do_open_with_surface() {
    if (!upstream_structure?.sites) return
    const n_slab = upstream_structure.sites.length

    // Find the topmost z-coordinate of the slab to place adsorbate above it
    let z_top = 0
    for (const site of upstream_structure.sites) {
      const z = site.xyz?.[2] ?? 0
      if (z > z_top) z_top = z
    }
    // Find the xy center of the slab
    let cx = 0, cy = 0
    for (const site of upstream_structure.sites) {
      cx += (site.xyz?.[0] ?? 0)
      cy += (site.xyz?.[1] ?? 0)
    }
    cx /= n_slab
    cy /= n_slab

    // Place custom_atoms above the slab surface (centered over slab, 2Å above top)
    let editor_struct: PymatgenStructure = upstream_structure
    if (custom_atoms.length > 0) {
      const new_sites = custom_atoms.map(a => ({
        species: [{ element: a.symbol, occu: 1, oxidation_state: 0 }],
        abc: [0, 0, 0] as [number, number, number],
        xyz: [
          a.position[0] + cx,
          a.position[1] + cy,
          a.position[2] + z_top + 2.0,
        ] as [number, number, number],
        label: a.symbol,
        properties: {},
      }) as Site)
      editor_struct = {
        ...upstream_structure,
        sites: [...upstream_structure.sites, ...new_sites],
      }
    }

    _open_sd_editor(editor_struct, n_slab, 0)
  }

  function _open_sd_editor(editor_struct: PymatgenStructure, n_background: number, center_offset: number) {
    // Capture current params snapshot — node may be stale when on_confirm fires
    const params_snapshot = { ...(node?.params ?? {}) }

    // Guard: editor crashes if sites is empty — add a default C atom.
    // Place it above the slab surface (or at box center if no slab).
    if (!editor_struct.sites || editor_struct.sites.length === 0) {
      let px = (editor_struct.lattice?.a ?? 10) / 2
      let py = (editor_struct.lattice?.b ?? 10) / 2
      let pz = (editor_struct.lattice?.c ?? 10) / 2
      editor_struct = {
        ...editor_struct,
        sites: [{
          species: [{ element: `C`, occu: 1, oxidation_state: 0 }],
          abc: [0.5, 0.5, 0.5],
          xyz: [px, py, pz],
          label: `C`,
          properties: {},
        }],
      }
      // This C is NOT background — user can keep or delete it
    } else if (n_background > 0) {
      // "Edit with Surface" mode: check if any non-background atom sits inside
      // the slab and push it above the surface
      let z_top = 0
      for (let i = 0; i < n_background && i < editor_struct.sites.length; i++) {
        const z = editor_struct.sites[i].xyz?.[2] ?? 0
        if (z > z_top) z_top = z
      }
      const updated_sites = editor_struct.sites.map((site, i) => {
        if (i < n_background) return site // slab atom — don't touch
        const z = site.xyz?.[2] ?? 0
        if (z <= z_top + 0.5) {
          // Atom is inside or too close to slab — push above surface
          return { ...site, xyz: [site.xyz?.[0] ?? 0, site.xyz?.[1] ?? 0, z_top + 2.0] as [number, number, number] }
        }
        return site
      })
      editor_struct = { ...editor_struct, sites: updated_sites }
    }

    onedit_3d?.(
      editor_struct,
      undefined,
      undefined,
      (final_struct: PymatgenStructure) => {
        if (!final_struct?.sites) return
        // Only keep atoms added AFTER the background (slab or box seed)
        const new_sites = final_struct.sites.slice(n_background)
        if (new_sites.length === 0) return

        // Compute centroid of new atoms for relative coordinates
        const cx = new_sites.reduce((s, site) => s + (site.xyz?.[0] ?? 0), 0) / new_sites.length
        const cy = new_sites.reduce((s, site) => s + (site.xyz?.[1] ?? 0), 0) / new_sites.length
        const cz = new_sites.reduce((s, site) => s + (site.xyz?.[2] ?? 0), 0) / new_sites.length

        const atoms = new_sites.map(s => ({
          symbol: s.species?.[0]?.element ?? s.label ?? `X`,
          position: [
            (s.xyz?.[0] ?? 0) - cx,
            (s.xyz?.[1] ?? 0) - cy,
            (s.xyz?.[2] ?? 0) - cz,
          ] as [number, number, number],
        }))

        custom_atoms = atoms
        sd_text = atoms.map(a => `${a.symbol} ${a.position[0].toFixed(3)} ${a.position[1].toFixed(3)} ${a.position[2].toFixed(3)}`).join(`\n`)
        result_structure = null
    
        // Use captured params snapshot — node.params may be null here
        onparams_change?.({ ...params_snapshot, _custom_atoms: atoms, _xyz_text: sd_text, _source_type: `self_define` })
        // Re-place with the new adsorbate at the currently selected site
        const new_ads: AdsorbatePreset = {
          name: `Self-defined`, formula: [...new Set(atoms.map(a => a.symbol))].join(``),
          atoms, default_binding_index: 0,
        }
        if (upstream_structure && selected_site) {
          do_place(upstream_structure, new_ads, selected_site, ++place_counter)
        }
      },
    )
  }

  // PubChem search
  let search_timer: ReturnType<typeof setTimeout> | null = null

  function on_pubchem_input() {
    if (search_timer) clearTimeout(search_timer)
    pubchem_error = null
    if (!pubchem_query.trim()) { pubchem_results = []; return }
    search_timer = setTimeout(do_pubchem_search, 400)
  }

  async function do_pubchem_search() {
    if (!pubchem_query.trim()) return
    pubchem_searching = true
    pubchem_error = null
    try {
      const resp = await search_pubchem_compounds(pubchem_query.trim())
      pubchem_results = resp.compounds.slice(0, 8)
    } catch (err) {
      pubchem_error = err instanceof Error ? err.message : String(err)
      pubchem_results = []
    } finally { pubchem_searching = false }
  }

  async function select_pubchem_compound(cid: number) {
    pubchem_loading = true
    pubchem_error = null
    try {
      const compound = await fetch_pubchem_compound(cid)
      if (!compound) { pubchem_error = `No 3D structure for CID ${cid}`; return }
      const { atoms } = extract_atoms_from_pubchem(compound)
      if (atoms.length === 0) { pubchem_error = `No atoms in compound`; return }
      custom_atoms = atoms.map(a => ({
        symbol: atomic_number_to_symbol[a.number] || `X`,
        position: [a.x, a.y, a.z] as [number, number, number],
      }))
      custom_binding_index = 0
      // Auto re-place with new adsorbate
  
      if (upstream_structure && selected_site) {
        const ads: AdsorbatePreset = { name: pubchem_query || `PubChem`, formula: [...new Set(custom_atoms.map(a => a.symbol))].join(``), atoms: custom_atoms, default_binding_index: 0 }
        do_place(upstream_structure, ads, selected_site, ++place_counter)
      }
    } catch (err) {
      pubchem_error = err instanceof Error ? err.message : String(err)
    } finally { pubchem_loading = false }
  }

  let auto_rotate = $state<boolean>((node.params._auto_rotate as boolean) ?? true)
  let height = $state<number>((node.params.height as number) ?? 2.0)
  // Default to `nearest_center_top` so CatBot-generated workflows place the
  // adsorbate immediately at the most-central top site without forcing the
  // user to click on the 3D preview. Users who want explicit placement can
  // still switch the dropdown to `manual_position`.
  let site_strategy = $state<SiteStrategy>((node.params._site_strategy as SiteStrategy) ?? `nearest_center_top`)
  let selected_site_id = $state<number | null>(
    typeof node.params._selected_site_id === `number` ? node.params._selected_site_id : null
  )

  // ─── Manual position state ───
  let manual_position = $state<[number, number, number]>(
    Array.isArray(node.params._manual_position) ? (node.params._manual_position as [number, number, number]) : [0, 0, 0]
  )
  let manual_normal = $state<[number, number, number]>(
    Array.isArray(node.params._manual_normal) ? (node.params._manual_normal as [number, number, number]) : [0, 0, 1]
  )
  let manual_position_set = $state<boolean>((node.params._manual_position_set as boolean) ?? false)
  /** Saved adsorbate atoms in Cartesian coords — the user's final edited placement */
  let manual_adsorbate_cart = $state<CustomAtom[]>(
    Array.isArray(node.params._manual_adsorbate_cart) ? (node.params._manual_adsorbate_cart as CustomAtom[]) : []
  )

  /** Binding atom indices — supports multi-dentate like the interactive pane */
  let binding_atom_indices = $state<number[]>(
    Array.isArray(node.params._binding_atom_indices) ? (node.params._binding_atom_indices as number[]) : [0]
  )

  // Sync binding indices when adsorbate changes — same logic as AdsorbatePlacementPane
  $effect(() => {
    const mol = active_adsorbate
    if (!mol) return
    if (source_type === `preset`) {
      // Preset: always reset to the preset's default binding atom
      binding_atom_indices = [mol.default_binding_index]
    } else {
      // Custom (xyz/pubchem): validate existing indices, trim invalid
      const valid = binding_atom_indices.filter(i => i < mol.atoms.length)
      if (valid.length === 0 && mol.atoms.length > 0) {
        binding_atom_indices = [0]
      } else if (valid.length !== binding_atom_indices.length) {
        binding_atom_indices = valid
      }
    }
  })

  // ─── Site finding ───
  let sites = $state<AdsorptionSite[]>([])
  let sites_loading = $state(false)
  let sites_error = $state<string | null>(null)
  let sites_searched = $state(false)

  // ─── Placement ───
  let placing = $state(false)
  let place_error = $state<string | null>(null)
  let result_structure = $state<PymatgenStructure | null>((() => {
    // Initialize from node params if already placed
    if (node.params.structure_json) {
      try { return JSON.parse(node.params.structure_json as string) as PymatgenStructure }
      catch { return null }
    }
    return null
  })())

  // If node params update externally with new structure_json, sync it
  $effect(() => {
    if (node.params.structure_json && !result_structure) {
      try {
        result_structure = JSON.parse(node.params.structure_json as string) as PymatgenStructure
      } catch { /* ignore */ }
    }
  })

  const preview_structure = $derived(result_structure ?? upstream_structure)
  const preview_info = $derived.by(() => {
    if (!preview_structure?.sites) return null
    const n = preview_structure.sites.length
    const is_placed = !!result_structure
    return { n_atoms: n, is_placed }
  })

  const selected_site = $derived(sites.find(s => s.id === selected_site_id) ?? null)

  // ─── Preview structure with site markers ───
  // Convert Cartesian site position to fractional coords for correct rendering.
  function cart_to_frac(xyz: [number, number, number], lattice: number[][] | undefined): [number, number, number] {
    if (!lattice || lattice.length < 3) return xyz
    // frac = xyz @ inv(lattice_matrix)  where lattice rows are vectors
    const m = lattice
    const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
      - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
      + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    if (Math.abs(det) < 1e-14) return xyz
    const inv = [
      [(m[1][1]*m[2][2]-m[1][2]*m[2][1])/det, (m[0][2]*m[2][1]-m[0][1]*m[2][2])/det, (m[0][1]*m[1][2]-m[0][2]*m[1][1])/det],
      [(m[1][2]*m[2][0]-m[1][0]*m[2][2])/det, (m[0][0]*m[2][2]-m[0][2]*m[2][0])/det, (m[0][2]*m[1][0]-m[0][0]*m[1][2])/det],
      [(m[1][0]*m[2][1]-m[1][1]*m[2][0])/det, (m[0][1]*m[2][0]-m[0][0]*m[2][1])/det, (m[0][0]*m[1][1]-m[0][1]*m[1][0])/det],
    ]
    return [
      xyz[0]*inv[0][0] + xyz[1]*inv[1][0] + xyz[2]*inv[2][0],
      xyz[0]*inv[0][1] + xyz[1]*inv[1][1] + xyz[2]*inv[2][1],
      xyz[0]*inv[0][2] + xyz[1]*inv[1][2] + xyz[2]*inv[2][2],
    ]
  }

  // Sites to display: in manual mode always show, otherwise only before placement
  const display_sites = $derived(
    (site_strategy === `manual_position` || !result_structure) ? sites : []
  )

  // ─── Site type counts for display ───
  const site_counts = $derived.by(() => {
    const counts: Record<string, number> = {}
    for (const s of sites) counts[s.site_type] = (counts[s.site_type] ?? 0) + 1
    return counts
  })

  // ─── Auto find sites when upstream changes ───
  let find_counter = 0
  let find_timer: ReturnType<typeof setTimeout> | null = null

  $effect(() => {
    const struct = upstream_structure
    if (!struct) {
      sites = []
      sites_searched = false
      result_structure = null
      return
    }

    // New upstream structure → clear old placement so auto-place triggers
    result_structure = null

    if (find_timer) clearTimeout(find_timer)
    const my_gen = ++find_counter

    find_timer = setTimeout(() => {
      find_sites_impl(struct, my_gen)
    }, 500)
  })

  async function find_sites_impl(struct: PymatgenStructure, gen: number) {
    sites_loading = true
    sites_error = null
    try {
      const result = await wasm_find_adsorption_sites(struct, { height })
      if (gen !== find_counter) return
      sites = result.sites
      sites_searched = true

      // Auto-select + auto-place if no result yet and adsorbate is configured
      if (!result_structure && active_adsorbate && sites.length > 0) {
        if (site_strategy === `manual_position` && manual_position_set && manual_adsorbate_cart.length > 0) {
          // Manual: append saved Cartesian atoms directly (preserves user edits)
          const merged = append_manual_adsorbate(struct)
          if (merged) {
            result_structure = merged
            onparams_change?.({
              ...node.params,
              structure_json: JSON.stringify(merged),
            })
          }
        } else if (site_strategy !== `manual_position`) {
          const auto_site = select_site(sites, struct, site_strategy)
          if (auto_site) {
            selected_site_id = auto_site.id
            do_place(struct, active_adsorbate, auto_site, ++place_counter)
          }
        }
      }
    } catch (err) {
      if (gen !== find_counter) return
      sites_error = err instanceof Error ? err.message : String(err)
      sites = []
    } finally {
      if (gen === find_counter) sites_loading = false
    }
  }

  /** Build a virtual AdsorptionSite from user-specified manual coordinates */
  function make_manual_site(): AdsorptionSite {
    return {
      id: -1,
      site_type: `top`,
      position: [...manual_position] as [number, number, number],
      normal: [...manual_normal] as [number, number, number],
      neighbor_indices: [],
      neighbor_elements: [],
      env_signature: `manual`,
      height: height,
    }
  }

  /** Lock the currently selected site's position as the manual position */
  function lock_site_as_manual(site: AdsorptionSite) {
    manual_position = [...site.position] as [number, number, number]
    manual_normal = [...site.normal] as [number, number, number]
    manual_position_set = true
  }

  /** Called when user confirms the final edited structure from the 3D editor.
   *  Extracts ALL adsorbate atoms' Cartesian positions for reuse on subsequent structures. */
  function handle_confirm(final_struct: PymatgenStructure) {
    const mol = active_adsorbate
    if (!mol || !final_struct?.sites) return
    const n_ads = mol.atoms.length
    const n_total = final_struct.sites.length
    const slab_count = n_total - n_ads

    // Extract all adsorbate atom Cartesian positions from the user-edited structure
    const ads_atoms: typeof manual_adsorbate_cart = []
    for (let i = 0; i < n_ads; i++) {
      const site = final_struct.sites[slab_count + i]
      if (!site) continue
      const xyz = site.xyz ?? site.abc
      ads_atoms.push({
        symbol: site.species?.[0]?.element ?? site.label ?? mol.atoms[i]?.symbol ?? `X`,
        position: [...xyz] as [number, number, number],
      })
    }
    manual_adsorbate_cart = ads_atoms
    manual_position_set = true

    // Save the final structure
    result_structure = final_struct
    onparams_change?.({
      ...node.params,
      species: `*${mol.formula}`,
      height,
      _species_idx: species_idx,
      _source_type: source_type,
      _site_strategy: site_strategy,
      _auto_rotate: auto_rotate,
      _binding_atom_indices: binding_atom_indices,
      _custom_atoms: source_type !== `preset` ? custom_atoms : undefined,
      _custom_binding_index: source_type !== `preset` ? custom_binding_index : undefined,
      _manual_normal: manual_normal,
      _manual_position_set: true,
      _manual_adsorbate_cart: ads_atoms,
      structure_json: JSON.stringify(final_struct),
    })
  }

  /** Append saved adsorbate atoms (Cartesian) to a new slab, with overlap push-up.
   *  Returns the merged structure or null on failure. */
  function append_manual_adsorbate(slab: PymatgenStructure): PymatgenStructure | null {
    if (manual_adsorbate_cart.length === 0) return null
    const n = manual_normal
    const n_len = Math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2)
    const norm: Vec3 = n_len < 1e-9 ? [0, 0, 1] : [n[0] / n_len, n[1] / n_len, n[2] / n_len]

    // Clone positions so we can shift
    let ads_positions = manual_adsorbate_cart.map(a => [...a.position] as Vec3)

    // Overlap detection — push up along normal
    const COV_R: Record<string, number> = {
      H: 0.31, C: 0.76, N: 0.71, O: 0.66, F: 0.57, S: 1.05, P: 1.07, Cl: 1.02,
      Br: 1.20, Fe: 1.32, Co: 1.26, Ni: 1.24, Cu: 1.32, Zn: 1.22, Pt: 1.36, Au: 1.36,
      Ag: 1.45, Pd: 1.39, Ru: 1.46, Rh: 1.42, Ir: 1.41, Ti: 1.60, Al: 1.21, Si: 1.11,
    }
    const cov_r = (s: string) => COV_R[s] ?? 1.5
    const OVERLAP_FACTOR = 0.7
    const NUDGE = 0.2
    const MAX_NUDGES = 20

    for (let step = 0; step < MAX_NUDGES; step++) {
      let overlap = false
      outer: for (let ai = 0; ai < ads_positions.length; ai++) {
        const ap = ads_positions[ai]
        const ar = cov_r(manual_adsorbate_cart[ai].symbol)
        for (const ss of slab.sites) {
          const sxyz = ss.xyz ?? ss.abc
          if (!sxyz) continue
          const dx = ap[0] - sxyz[0], dy = ap[1] - sxyz[1], dz = ap[2] - sxyz[2]
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
          const sr = cov_r(ss.species?.[0]?.element ?? ss.label ?? `X`)
          if (dist < (ar + sr) * OVERLAP_FACTOR) { overlap = true; break outer }
        }
      }
      if (!overlap) break
      ads_positions = ads_positions.map((p: Vec3) => [
        p[0] + NUDGE * norm[0], p[1] + NUDGE * norm[1], p[2] + NUDGE * norm[2],
      ] as Vec3)
    }

    // Build merged structure
    const lat = slab.lattice?.matrix
    // If the slab carries selective_dynamics (frozen layers), mark the adsorbate
    // atoms as fully free so the fixity stays consistent downstream — issue #222.
    const slab_has_sd = slab.sites.some((s: any) => s.properties?.selective_dynamics)
    const ads_props = (): Record<string, unknown> =>
      slab_has_sd ? { selective_dynamics: [true, true, true] } : {}
    const new_sites = [
      ...slab.sites,
      ...manual_adsorbate_cart.map((atom: CustomAtom, i: number) => {
        const xyz = ads_positions[i]
        const abc = cart_to_frac(xyz, lat)
        return {
          species: [{ element: atom.symbol, occu: 1 }],
          abc, xyz,
          label: atom.symbol,
          properties: ads_props(),
        }
      }),
    ]
    return { ...slab, sites: new_sites } as PymatgenStructure
  }

  /** Place adsorbate at the manual position */
  function place_at_manual() {
    if (!upstream_structure || !active_adsorbate || !manual_position_set) return
    const site = make_manual_site()
    result_structure = null
    selected_site_id = null
    do_place(upstream_structure, active_adsorbate, site, ++place_counter)
  }

  /** Called from the 3D preview modal when user clicks a site sphere.
   *  Locks the position, does placement, returns the placed structure for display. */
  function handle_site_picked(site_idx: number): PymatgenStructure | null {
    const site = sites[site_idx]
    if (!site || !upstream_structure || !active_adsorbate) return null
    lock_site_as_manual(site)
    selected_site_id = site.id
    try {
      const result = place_adsorbate_local(
        upstream_structure,
        active_adsorbate.atoms.map(a => ({ symbol: a.symbol, position: a.position })),
        binding_atom_indices,
        site.position as [number, number, number],
        site.normal as [number, number, number],
        0,
        auto_rotate,
      )
      result_structure = result.structure as PymatgenStructure
      // Save to node params
      onparams_change?.({
        ...node.params,
        species: `*${active_adsorbate.formula}`,
        height,
        _species_idx: species_idx,
        _source_type: source_type,
        _selected_site_id: site.id,
        _site_strategy: site_strategy,
        _auto_rotate: auto_rotate,
        _binding_atom_indices: binding_atom_indices,
        _custom_atoms: source_type !== `preset` ? custom_atoms : undefined,
        _custom_binding_index: source_type !== `preset` ? custom_binding_index : undefined,
        _manual_position: manual_position,
        _manual_normal: manual_normal,
        _manual_position_set: true,
        structure_json: JSON.stringify(result.structure),
      })
      return result_structure
    } catch {
      return null
    }
  }

  // ─── Placement counter (used by do_place to discard stale results) ───
  let place_counter = 0

  function do_place(
    slab: PymatgenStructure,
    mol: AdsorbatePreset,
    site: AdsorptionSite,
    gen: number,
  ) {
    placing = true
    place_error = null
    try {
      // site.position already includes height offset from Alpha Shape,
      // so pass height_offset = 0 to avoid double-counting.
      const result = place_adsorbate_local(
        slab,
        mol.atoms.map((a) => ({ symbol: a.symbol, position: a.position })),
        binding_atom_indices,
        site.position as [number, number, number],
        site.normal as [number, number, number],
        0, // height already baked into site.position
        auto_rotate,
      )
      if (gen !== place_counter) return
      result_structure = result.structure as PymatgenStructure
      // Save to node params
      onparams_change?.({
        ...node.params,
        species: `*${mol.formula}`,
        height,
        _species_idx: species_idx,
        _source_type: source_type,
        _selected_site_id: site.id,
        _site_strategy: site_strategy,
        _auto_rotate: auto_rotate,
        _binding_atom_indices: binding_atom_indices,
        _custom_atoms: source_type !== `preset` ? custom_atoms : undefined,
        _custom_binding_index: source_type !== `preset` ? custom_binding_index : undefined,
        _xyz_text: source_type === `xyz` ? xyz_text : undefined,
        _pubchem_query: source_type === `pubchem` ? pubchem_query : undefined,
        _manual_position: site_strategy === `manual_position` ? manual_position : undefined,
        _manual_normal: site_strategy === `manual_position` ? manual_normal : undefined,
        _manual_position_set: site_strategy === `manual_position` ? manual_position_set : undefined,
        structure_json: JSON.stringify(result.structure),
      })
    } catch (err) {
      if (gen !== place_counter) return
      place_error = err instanceof Error ? err.message : String(err)
    } finally {
      if (gen === place_counter) placing = false
    }
  }

  // ─── Helpers ───
  function update_param(key: string, value: unknown) {
    onparams_change?.({ ...node.params, [key]: value })
  }

  function reset() {
    result_structure = null
    selected_site_id = null
    source_type = `preset`
    species_idx = 0
    custom_atoms = []
    xyz_text = `C 0.000 0.000 0.000\nO 0.000 0.000 1.128`
    pubchem_query = ``
    pubchem_results = []
    custom_binding_index = 0
    binding_atom_indices = [0]
    height = 2.0
    auto_rotate = true
    site_strategy = `nearest_center_top`
    manual_position = [0, 0, 0]
    manual_normal = [0, 0, 1]
    manual_position_set = false
    manual_adsorbate_cart = []
    place_error = null
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node.params)) {
      if (!k.startsWith(`_`) && k !== `structure_json`) clean[k] = v
    }
    onparams_change?.({ ...clean, species: `*CO`, height: 2.0 })
  }
</script>

<!-- Keep/Clear adsorbate prompt -->
{#if sd_show_prompt}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="sd-prompt-overlay" onclick={() => { sd_show_prompt = false; sd_pending_action = null }}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="sd-prompt" onclick={(e) => e.stopPropagation()}>
      <div class="sd-prompt-title">{t(`workflow.ads_existing_adsorbate_atoms`, { n: custom_atoms.length })}</div>
      <div class="sd-prompt-buttons">
        <button class="primary" onclick={() => sd_handle_prompt(true)}>{t(`workflow.ads_keep_and_edit`)}</button>
        <button class="sd-btn" onclick={() => sd_handle_prompt(false)}>{t(`workflow.ads_clear_and_start_fresh`)}</button>
        <button class="sd-btn" onclick={() => { sd_show_prompt = false; sd_pending_action = null }}>{t(`workflow.cancel`)}</button>
      </div>
    </div>
  </div>
{/if}

<div class="config-panel dialog-modal">
  <!-- Header -->
  <div class="panel-header">
    <div class="header-row">
      <div class="node-icon" style="background:{definition.color}20;border-color:{definition.color}50">
        {definition.icon}
      </div>
      <div class="header-info">
        <div class="node-label">{definition.label}</div>
        <div class="node-id">{node.id.slice(0, 16)}</div>
      </div>
      <button
        class="help-btn"
        class:active={show_help}
        onclick={() => show_help = !show_help}
        title={t(`workflow.ads_toggle_help`)}
      >?</button>
    </div>
    {#if show_help}
      <div class="node-desc">{definition.description}</div>
    {/if}
    {#if status && status_color}
      <div class="status-badge" style="background:{status_color}15;border-color:{status_color}40;color:{status_color}">
        <span class="status-dot" style="background:{status_color}"></span>
        {status}
      </div>
    {/if}
  </div>

  <!-- Multi-structure slider (when upstream provides multiple structures) -->
  {#if has_multi_structs && upstream_structs_parsed}
    <div class="section" style="padding: 4px 8px;">
      <div class="field-row" style="align-items: center; gap: 6px;">
        <label class="field-label-sm" style="white-space: nowrap;">{t(`workflow.ads_structure`)}</label>
        <input type="range" min="0" max={upstream_structs_parsed.length - 1} step="1"
          value={struct_index}
          oninput={(e) => {
            struct_index = Number((e.target as HTMLInputElement).value)
            result_structure = null
            update_param(`_struct_index`, struct_index)
          }}
          style="flex: 1; accent-color: #7c3aed;"
        />
        <span style="font-size: 10px; min-width: 40px; text-align: right; color: var(--text-color-dim);">
          {struct_index + 1} / {upstream_structs_parsed.length}
        </span>
      </div>
    </div>
  {/if}

  <!-- 3D Preview (above Display Name, consistent with other panels) -->
  {#if preview_structure}
    <div class="section preview-section">
      <div class="preview-header">
        <span class="section-label">{t(`workflow.ads_preview`)}</span>
        {#if placing}
          <div class="mini-spinner"></div>
        {/if}
        {#if onedit_3d && preview_structure}
          <button class="expand-btn" onclick={() => onedit_3d?.()} title={t(`workflow.ads_open_full_3d_editor`)}>&#x26F6;</button>
        {/if}
      </div>
      <div class="preview-viewport">
        <StructurePreview
          structure={preview_structure}
          adsorption_sites={display_sites}
          on_adsorption_site_click={(site_idx) => {
            const site = sites[site_idx]
            if (!site) return
            if (site_strategy === `manual_position`) {
              lock_site_as_manual(site)
              selected_site_id = site.id
              if (upstream_structure && active_adsorbate) {
                result_structure = null
                do_place(upstream_structure, active_adsorbate, make_manual_site(), ++place_counter)
              }
            } else {
              // Non-manual: just select and re-place at clicked site
              selected_site_id = site.id
              if (upstream_structure && active_adsorbate) {
                result_structure = null
                do_place(upstream_structure, active_adsorbate, site, ++place_counter)
              }
            }
          }}
        />
      </div>
      {#if preview_info}
        <div class="preview-info">
          {#if preview_info.is_placed}
            *{active_adsorbate?.display_formula ?? active_adsorbate?.formula ?? `?`} {t(`workflow.ads_placed`)}
          {/if}
          &middot; {t(`workflow.ads_atom_count`, { n: preview_info.n_atoms })}
          {#if !result_structure && sites.length > 0}
            &middot; {t(`workflow.ads_sites_shown`, { n: sites.length })}
            {#if site_strategy === `manual_position`}
              &middot; {t(`workflow.ads_click_site_to_lock`)}
            {:else if selected_site}
              &middot; {t(`workflow.ads_site_selected`, { n: selected_site.id })}
            {/if}
          {/if}
        </div>
      {/if}
      {#if place_error}
        <div class="place-error">{place_error}</div>
      {/if}
    </div>
  {/if}

  <!-- Display Name -->
  <div class="label-row">
    <label class="field-label">{t(`workflow.ads_display_name`)}</label>
    <input type="text" class="field-input" placeholder={definition.label}
      value={node.params.label ?? ``}
      oninput={(e) => onparams_change?.({ ...node.params, label: e.currentTarget.value || undefined })} />
  </div>

  <!-- Upstream Slab Info -->
  <div class="section">
    <div class="section-label">{t(`workflow.ads_upstream_structure`)}</div>
    {#if upstream_info}
      <div class="upstream-info">
        <span class="upstream-formula">{upstream_info.formula}</span>
        <span class="upstream-atoms">{t(`workflow.ads_atom_count`, { n: upstream_info.n_atoms })}</span>
      </div>
    {:else if upstream_structure_json === undefined}
      <div class="upstream-hint">{t(`workflow.ads_open_in_main_window`)}</div>
    {:else}
      <div class="upstream-missing">{t(`workflow.ads_connect_upstream`)}</div>
    {/if}
  </div>

  <!-- Adsorbate Config -->
  <div class="section">
    <div class="section-label">{t(`workflow.ads_adsorbate`)}</div>

    <!-- Source tabs -->
    <div class="source-tabs">
      <button class="tab" class:active={source_type === `preset`} onclick={() => { source_type = `preset`; update_param(`_source_type`, `preset`) }}>{t(`workflow.ads_source_preset`)}</button>
      <button class="tab" class:active={source_type === `xyz`} onclick={() => { source_type = `xyz`; update_param(`_source_type`, `xyz`) }}>XYZ</button>
      <button class="tab" class:active={source_type === `pubchem`} onclick={() => { source_type = `pubchem`; update_param(`_source_type`, `pubchem`) }}>{t(`workflow.ads_source_pubchem`)}</button>
      <button class="tab" class:active={source_type === `self_define`} onclick={() => { source_type = `self_define`; sd_open = true; update_param(`_source_type`, `self_define`) }}>{t(`workflow.ads_source_self_define`)}</button>
    </div>

    {#if source_type === `preset`}
      <div class="field-row">
        <label class="field-label-sm">{t(`workflow.ads_species`)}</label>
        <select class="field-select" value={species_idx}
          onchange={(e) => {
            species_idx = Number((e.target as HTMLSelectElement).value)
            result_structure = null
        
            update_param(`_species_idx`, species_idx)
            // Auto re-place with new adsorbate at current site
            const ads = ADSORBATE_PRESETS[species_idx]
            if (ads && upstream_structure && selected_site) {
              do_place(upstream_structure, ads, selected_site, ++place_counter)
            }
          }}>
          {#each ADSORBATE_PRESET_GROUPS as group}
            <optgroup label={group.label}>
              {#each group.presets as p}
                {@const flat_idx = ADSORBATE_PRESETS.indexOf(p)}
                <option value={flat_idx}>{p.display_formula ?? p.formula} — {p.name}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
      </div>
    {:else if source_type === `xyz`}
      <textarea class="xyz-input" rows="4" placeholder={t(`workflow.ads_xyz_placeholder`)}
        value={xyz_text}
        oninput={(e) => { xyz_text = (e.target as HTMLTextAreaElement).value; result_structure = null; update_param(`_xyz_text`, xyz_text) }}
      ></textarea>
      {#if xyz_parse_error}
        <div class="site-status error">{xyz_parse_error}</div>
      {:else if custom_atoms.length > 0}
        <div class="site-status">{t(`workflow.ads_atoms_parsed`, { n: custom_atoms.length })}</div>
      {/if}
      <!-- Binding atom selection via atom badges below (same as manual pane) -->
    {:else if source_type === `pubchem`}
      <input type="text" class="field-select" placeholder={t(`workflow.ads_pubchem_placeholder`)}
        value={pubchem_query}
        oninput={(e) => { pubchem_query = (e.target as HTMLInputElement).value; on_pubchem_input() }} />
      {#if pubchem_searching}
        <div class="site-status"><div class="mini-spinner"></div> {t(`workflow.ads_searching`)}</div>
      {/if}
      {#if pubchem_error}
        <div class="site-status error">{pubchem_error}</div>
      {/if}
      {#if pubchem_results.length > 0}
        <div class="pubchem-results">
          {#each pubchem_results as compound}
            <button class="pubchem-item" class:loading={pubchem_loading}
              onclick={() => { select_pubchem_compound(compound.cid); result_structure = null }}
              disabled={pubchem_loading}>
              <span class="formula">{compound.formula}</span>
              {#if compound.name}<span class="name">{compound.name}</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
      {#if custom_atoms.length > 0}
        <div class="site-status">{t(`workflow.ads_loaded_atoms`, { n: custom_atoms.length })}</div>
      {/if}
    {:else if source_type === `self_define`}
      <!-- Self-define: two editor options -->
      <div class="sd-buttons" style="display: flex; flex-wrap: wrap; gap: 4pt; margin: 4pt 0">
        {#if onedit_3d}
          <button class="sd-btn" onclick={sd_open_3d_editor}>
            {custom_atoms.length > 0 ? t(`workflow.ads_edit_atoms`, { n: custom_atoms.length }) : t(`workflow.ads_empty_editor`)}
          </button>
          {#if upstream_structure?.sites}
            <button class="primary" onclick={sd_open_with_surface}>
              {t(`workflow.ads_edit_with_surface`)}
            </button>
          {/if}
        {/if}
        <button class="sd-btn" onclick={() => (sd_open = !sd_open)}>
          {sd_open ? t(`workflow.ads_hide_text`) : t(`workflow.ads_text`)}
        </button>
      </div>

      <!-- Inline text editor (collapsible) -->
      {#if sd_open}
        <div class="sd-editor">
          <!-- XYZ text editor (live-synced with preview) -->
          <textarea class="xyz-input" rows="5" placeholder={t(`workflow.ads_xyz_placeholder`)}
            bind:value={sd_text}
            oninput={() => { update_param(`_xyz_text`, sd_text); result_structure = null }}
          ></textarea>

          {#if xyz_parse_error}
            <div class="site-status error">{xyz_parse_error}</div>
          {:else if custom_atoms.length > 0}
            <div class="site-status">{t(`workflow.ads_atom_count`, { n: custom_atoms.length })}</div>
          {/if}

          <!-- Editor controls -->
          <div class="sd-controls">
            <button class="sd-btn" onclick={sd_remove_last} disabled={custom_atoms.length === 0} title={t(`workflow.ads_remove_last_atom`)}>{t(`workflow.undo`)}</button>
            <button class="sd-btn" onclick={sd_clear} title={t(`workflow.ads_clear_all`)}>{t(`workflow.clear`)}</button>
            <span style="flex:1"></span>
            <button class="primary" onclick={sd_confirm} disabled={custom_atoms.length === 0}>{t(`workflow.confirm`)}</button>
          </div>
        </div>
      {/if}
    {/if}

    <!-- Adsorbate molecule preview with binding atom highlighting -->
    {#if mol_preview && mol_preview.sites.length > 0}
      <div class="mol-preview" bind:clientWidth={mol_pw} bind:clientHeight={mol_ph}>
        {#if typeof WebGLRenderingContext !== 'undefined'}
            <Canvas toneMapping={ACESFilmicToneMapping} {...{rendererParameters: { alpha: true }} as any}>
              <StructureScene
                structure={mol_preview}
                {...mol_scene_props}
                width={mol_pw}
                height={mol_ph}
                show_site_indices={true}
                active_sites={binding_atom_indices}
                active_highlight_color="#ff6b35"
              />
            </Canvas>
        {/if}
      </div>
    {/if}

    <!-- Binding atoms (click to toggle, like interactive pane) -->
    {#if active_adsorbate && active_adsorbate.atoms.length > 1}
      <div class="binding-section">
        <label class="field-label-sm">{binding_atom_indices.length > 1 ? t(`workflow.ads_binding_atoms`) : t(`workflow.ads_binding_atom`)}</label>
        <div class="atom-badges">
          {#each active_adsorbate.atoms as atom, idx}
            <button class="atom-badge" class:selected={binding_atom_indices.includes(idx)}
              onclick={() => {
                if (binding_atom_indices.includes(idx)) {
                  if (binding_atom_indices.length > 1)
                    binding_atom_indices = binding_atom_indices.filter(i => i !== idx)
                } else {
                  binding_atom_indices = [...binding_atom_indices, idx]
                }
                result_structure = null
                if (selected_site && upstream_structure && active_adsorbate)
                  do_place(upstream_structure, active_adsorbate, selected_site, ++place_counter)
              }}
              title="{atom.symbol} (#{idx + 1})"
            >{atom.symbol}<sub>{idx + 1}</sub></button>
          {/each}
        </div>
      </div>
    {/if}

    <div class="field-row">
      <label class="field-label-sm">{t(`workflow.ads_height_angstrom`)}</label>
      <input type="number" class="field-input-sm" step="0.1" min="0.5" max="5"
        value={height} oninput={(e) => { height = Number(e.currentTarget.value) || 2; update_param(`height`, height) }} />
    </div>
    <label class="checkbox-row">
      <input type="checkbox" checked={auto_rotate}
        onchange={(e) => { auto_rotate = (e.target as HTMLInputElement).checked; update_param(`_auto_rotate`, auto_rotate) }} />
      <span class="field-label-sm">{t(`workflow.ads_auto_rotate_to_surface_normal`)}</span>
    </label>
    {#if active_adsorbate}
      <div class="site-status">{t(`workflow.ads_active_adsorbate`, { formula: active_adsorbate.formula, n: active_adsorbate.atoms.length })}</div>
    {/if}
  </div>

  <!-- Adsorption Sites -->
  <div class="section">
    <div class="section-label">
      {t(`workflow.ads_adsorption_sites`)}
      {#if sites.length > 0}
        <span class="site-count">{sites.length}</span>
      {/if}
    </div>

    <div class="field-row">
      <label class="field-label-sm">{t(`workflow.ads_strategy`)}</label>
      <select class="field-select" value={site_strategy}
        onchange={(e) => {
          site_strategy = (e.target as HTMLSelectElement).value as SiteStrategy
          update_param(`_site_strategy`, site_strategy)
          if (site_strategy === `manual_position`) {
            // Clear placement so site markers become visible for picking
            result_structure = null
            // If a site was already selected, lock it as starting point
            if (selected_site) lock_site_as_manual(selected_site)
          }
        }}>
        <option value="nearest_center_top">{t(`workflow.ads_strategy_nearest_center_top`)}</option>
        <option value="first_top">{t(`workflow.ads_strategy_first_top`)}</option>
        <option value="first_bridge">{t(`workflow.ads_strategy_first_bridge`)}</option>
        <option value="first_hollow">{t(`workflow.ads_strategy_first_hollow`)}</option>
        <option value="manual_position">{t(`workflow.ads_strategy_manual_position`)}</option>
      </select>
    </div>

    {#if site_strategy === `manual_position`}
      <div class="manual-pos-section">
        {#if manual_position_set}
          <div class="manual-pos-display">
            <span class="manual-pos-label">{t(`workflow.ads_locked_position`)}</span>
            <div class="manual-pos-coords">
              <label class="coord-field">
                <span>X</span>
                <input type="number" step="0.01" value={manual_position[0]}
                  oninput={(e) => { manual_position = [Number(e.currentTarget.value) || 0, manual_position[1], manual_position[2]] }} />
              </label>
              <label class="coord-field">
                <span>Y</span>
                <input type="number" step="0.01" value={manual_position[1]}
                  oninput={(e) => { manual_position = [manual_position[0], Number(e.currentTarget.value) || 0, manual_position[2]] }} />
              </label>
              <label class="coord-field">
                <span>Z</span>
                <input type="number" step="0.01" value={manual_position[2]}
                  oninput={(e) => { manual_position = [manual_position[0], manual_position[1], Number(e.currentTarget.value) || 0] }} />
              </label>
            </div>
            <div class="manual-pos-actions">
              <button class="action-btn" onclick={() => { onedit_3d?.(upstream_structure ?? undefined, sites, handle_site_picked, handle_confirm) }}>{t(`workflow.ads_pick_site`)}</button>
              <button class="action-btn reset-btn" onclick={() => { manual_position_set = false; manual_position = [0,0,0]; manual_normal = [0,0,1] }}>{t(`workflow.clear`)}</button>
            </div>
          </div>
        {:else}
          <div class="manual-pos-hint">
            {t(`workflow.ads_click_site_hint`)}
          </div>
          <div class="manual-pos-coords">
            <label class="coord-field">
              <span>X</span>
              <input type="number" step="0.01" value={manual_position[0]}
                oninput={(e) => { manual_position = [Number(e.currentTarget.value) || 0, manual_position[1], manual_position[2]] }} />
            </label>
            <label class="coord-field">
              <span>Y</span>
              <input type="number" step="0.01" value={manual_position[1]}
                oninput={(e) => { manual_position = [manual_position[0], Number(e.currentTarget.value) || 0, manual_position[2]] }} />
            </label>
            <label class="coord-field">
              <span>Z</span>
              <input type="number" step="0.01" value={manual_position[2]}
                oninput={(e) => { manual_position = [manual_position[0], manual_position[1], Number(e.currentTarget.value) || 0] }} />
            </label>
          </div>
          <button class="action-btn find-btn" onclick={() => { onedit_3d?.(upstream_structure ?? undefined, sites, handle_site_picked, handle_confirm) }}>
            {t(`workflow.ads_pick_site`)}
          </button>
        {/if}
      </div>
    {/if}

    {#if sites_loading}
      <div class="site-status">
        <div class="mini-spinner"></div>
        {t(`workflow.ads_finding_sites`)}
      </div>
    {:else if sites_error}
      <div class="site-status error">{sites_error}</div>
    {:else if sites.length > 0 && site_strategy !== `manual_position`}
      <div class="site-summary">
        {#each Object.entries(site_counts) as [type, count]}
          <span class="site-tag site-{type}">{count} {type}</span>
        {/each}
      </div>
      <select class="field-select site-select" value={selected_site_id ?? ``}
        onchange={(e) => {
          const id = Number((e.target as HTMLSelectElement).value) || null
          selected_site_id = id
          if (id !== null && upstream_structure && active_adsorbate) {
            const site = sites.find(s => s.id === id)
            if (site) {
              if (site_strategy === `manual_position`) {
                // Lock this site's position for manual mode
                lock_site_as_manual(site)
                result_structure = null
                do_place(upstream_structure, active_adsorbate, make_manual_site(), ++place_counter)
              } else {
                result_structure = null
                do_place(upstream_structure, active_adsorbate, site, ++place_counter)
              }
            }
          }
        }}>
        <option value="">{(site_strategy as SiteStrategy) === `manual_position` ? t(`workflow.ads_pick_site_to_lock`) : t(`workflow.ads_auto_strategy`, { strategy: site_strategy.replace(/_/g, ` `) })}</option>
        {#each sites as s}
          <option value={s.id}>
            #{s.id} {s.site_type} — {s.env_signature}
          </option>
        {/each}
      </select>
    {:else if sites_searched}
      <div class="site-status">{t(`workflow.ads_no_sites_found`)}</div>
    {:else if !upstream_structure}
      <div class="site-status dim">{t(`workflow.ads_waiting_for_upstream_structure`)}</div>
    {/if}

    {#if upstream_structure && !sites_loading && site_strategy !== `manual_position`}
      <button class="action-btn find-btn" onclick={() => {
        result_structure = null // allow re-placement
        find_counter++
        find_sites_impl(upstream_structure!, find_counter)
      }}>
        {sites_searched ? t(`workflow.ads_refind_and_place`) : t(`workflow.ads_find_sites_and_place`)}
      </button>
    {/if}
  </div>

  <!-- Actions -->
  <div class="actions-section">
    {#if sites.length > 0 && active_adsorbate}
      <button class="action-btn find-btn" onclick={() => {
        if (!upstream_structure || !active_adsorbate) return
        const site = selected_site ?? select_site(sites, upstream_structure, site_strategy)
        if (site) {
          result_structure = null
          selected_site_id = site.id
          do_place(upstream_structure, active_adsorbate, site, ++place_counter)
        }
      }}>
        {result_structure ? t(`workflow.ads_replace_adsorbate`) : t(`workflow.ads_place_adsorbate`)}
      </button>
    {/if}
    <button class="action-btn reset-btn" onclick={reset}>{t(`workflow.reset`)}</button>
  </div>

  <!-- IO -->
  <div class="io-section">
    <div class="section-label">{t(`workflow.ads_inputs_outputs`)}</div>
    <div class="io-row">
      <div class="io-col">
        <span class="io-heading">IN</span>
        {#each definition.inputs as inp}
          <span class="io-item">{inp}</span>
        {/each}
      </div>
      <div class="io-arrow">&rarr;</div>
      <div class="io-col">
        <span class="io-heading">OUT</span>
        {#each definition.outputs as out}
          <span class="io-item">{out}</span>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .config-panel {
    display: flex;
    flex-direction: column;
    gap: 0;
    height: 100%;
    overflow-y: auto;
    color: var(--text-color, light-dark(#374151, #eee));
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-size: 12px;
    background: var(--dialog-bg, light-dark(#fff, #1c1d21));
  }

  /* ─── Header ─── */
  .panel-header { padding: 12px; border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); }
  .header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .node-icon {
    width: 34px; height: 34px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; border: 1px solid; flex-shrink: 0;
  }
  .header-info { flex: 1; min-width: 0; }
  .node-label { font-size: 13px; font-weight: 600; color: var(--text-color, light-dark(#1f2937, #eee)); }
  .node-id { font-size: 9px; color: var(--text-color-dim, light-dark(#9ca3af, #484f58)); margin-top: 1px; }
  .help-btn {
    width: 22px; height: 22px; border-radius: 50%;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    font-size: 11px; font-weight: 700; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; transition: all 0.15s; font-family: inherit;
  }
  .help-btn:hover, .help-btn.active {
    background: light-dark(rgba(0,0,0,0.06), #1a3050);
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }
  .node-desc { font-size: 10px; color: var(--text-color-dim, light-dark(#9ca3af, #484f58)); line-height: 1.5; }
  .status-badge {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 8px; border-radius: 4px; font-size: 10px;
    font-weight: 600; border: 1px solid; margin-top: 8px;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .status-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

  /* ─── Display Name ─── */
  .label-row { padding: 6px 12px; border-bottom: 1px solid var(--border-color, light-dark(#e5e7eb, #2d333b)); }
  .label-row .field-label {
    display: block; font-size: 10px; font-weight: 600;
    color: var(--text-color-muted, light-dark(#6b7280, #768390));
    margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .label-row .field-input {
    width: 100%; box-sizing: border-box; padding: 4px 8px;
    font-size: 11px; font-family: inherit;
    border: 1px solid var(--border-color, light-dark(#d1d5db, #373e47));
    border-radius: 4px;
    background: var(--input-bg, light-dark(#f9fafb, #22272e));
    color: var(--text-color, light-dark(#374151, #adbac7));
  }

  /* ─── Sections ─── */
  .section { padding: 10px 12px; border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); }
  .section-label {
    font-size: 9px; font-weight: 700;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 8px;
    display: flex; align-items: center; gap: 6px;
  }

  /* ─── Upstream ─── */
  .upstream-info {
    display: flex; align-items: baseline; gap: 8px;
    padding: 4px 8px; border-radius: 4px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
  }
  .upstream-formula { font-weight: 700; font-size: 13px; color: var(--accent-color, light-dark(#4f46e5, #3b82f6)); }
  .upstream-atoms { font-size: 10px; color: var(--text-color-muted, light-dark(#6b7280, #9ca3af)); }
  .upstream-missing { font-size: 10px; color: #f97316; font-style: italic; }
  .upstream-hint { font-size: 10px; color: var(--text-color-dim, #505860); font-style: italic; }

  /* ─── Fields ─── */
  .field-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .field-label-sm {
    font-size: 10px; font-weight: 600; min-width: 60px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
  }
  .field-select, .field-input-sm {
    flex: 1; padding: 4px 6px; font-size: 11px; font-family: inherit;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
    color: var(--text-color, light-dark(#374151, #eee));
  }

  /* ─── Sites ─── */
  .site-count {
    font-size: 9px; background: var(--accent-color, #3b82f6);
    color: #fff; padding: 1px 5px; border-radius: 8px; font-weight: 700;
  }
  .site-summary { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
  .site-tag {
    font-size: 9px; font-weight: 600; padding: 2px 6px; border-radius: 3px;
    letter-spacing: 0.3px;
  }
  .site-tag.site-top { background: #00ff0020; color: #22c55e; }
  .site-tag.site-bridge { background: #0088ff20; color: #3b82f6; }
  .site-tag.site-hollow3, .site-tag.site-hollow4 { background: #ff880020; color: #f59e0b; }
  .source-tabs {
    display: flex; gap: 2px; margin-bottom: 8px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
    border-radius: 5px; padding: 2px;
  }
  .source-tabs .tab {
    flex: 1; padding: 3px 6px; border: none; border-radius: 4px;
    font-size: 10px; font-weight: 600; cursor: pointer; font-family: inherit;
    background: transparent; color: var(--text-color-muted, #9ca3af);
    transition: all 0.15s;
  }
  .source-tabs .tab.active {
    background: var(--accent-color, #3b82f6);
    color: #fff;
  }
  .source-tabs .tab:hover:not(.active) {
    background: var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .xyz-input {
    width: 100%; box-sizing: border-box; padding: 4px 6px;
    font-size: 10px; font-family: 'SF Mono', 'Cascadia Code', monospace;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px; resize: vertical; margin-bottom: 4px;
    background: var(--input-bg, light-dark(#f9fafb, #22272e));
    color: var(--text-color, light-dark(#374151, #eee));
  }
  /* Self-define editor */
  .sd-editor {
    display: flex; flex-direction: column; gap: 4px;
    padding: 6px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    background: var(--input-bg, light-dark(#f9fafb, #1a1f26));
  }
  .sd-add-row {
    display: flex; gap: 3px; align-items: center;
  }
  .sd-elem {
    width: 50px; padding: 2px; font-size: 10px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 3px; background: var(--input-bg); color: var(--text-color);
  }
  .sd-coord {
    width: 52px; padding: 2px 4px; font-size: 10px; text-align: right;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 3px; background: var(--input-bg); color: var(--text-color);
  }
  .sd-btn {
    padding: 2px 8px; font-size: 10px; cursor: pointer;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 3px; background: var(--btn-bg, light-dark(#f3f4f6, #2d333b));
    color: var(--text-color);
  }
  .sd-btn:hover { opacity: 0.8; }
  .sd-btn:disabled { opacity: 0.4; cursor: default; }
  .sd-controls {
    display: flex; gap: 4px; align-items: center; margin-top: 2px;
  }
  /* Keep/Clear prompt */
  .sd-prompt-overlay {
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0,0,0,0.35);
    display: flex; align-items: center; justify-content: center;
    padding: 16px;
    overflow: auto;
    box-sizing: border-box;
  }
  .sd-prompt {
    background: var(--dialog-bg, light-dark(#fff, #1e2028));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 8px; padding: 16px 20px;
    width: min(360px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
    min-width: 0;
    box-sizing: border-box;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  }
  .sd-prompt-title {
    font-size: 13px; font-weight: 600; margin-bottom: 12px;
    color: var(--text-color, light-dark(#1f2937, #eee));
    overflow-wrap: anywhere;
  }
  .sd-prompt-buttons {
    display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap;
  }
  .pubchem-results {
    max-height: 120px; overflow-y: auto; display: flex; flex-direction: column;
    gap: 2px; margin: 4px 0;
  }
  .pubchem-item {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 6px; border-radius: 4px; cursor: pointer;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    text-align: left; font-family: inherit; font-size: 10px;
    color: var(--text-color, light-dark(#374151, #eee));
  }
  .pubchem-item:hover:not(:disabled) {
    background: var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .pubchem-item.loading { opacity: 0.6; }
  .pubchem-item .formula { font-weight: 600; min-width: 40px; }
  .pubchem-item .name { opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mol-preview {
    width: 100%;
    height: 150px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    overflow: hidden;
    margin: 6px 0;
    background: rgba(0, 0, 0, 0.3);
    position: relative;
  }
  :global(.mol-preview canvas) {
    position: absolute !important;
    top: 0; left: 0;
    width: 100% !important;
    height: 100% !important;
  }
  .binding-section { margin: 6px 0; }
  .atom-badges { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px; }
  .atom-badge {
    padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600;
    cursor: pointer; font-family: inherit; border: 1px solid var(--dialog-border, #404040);
    background: var(--input-bg, rgba(255,255,255,0.05));
    color: var(--text-color, #eee); transition: all 0.15s;
  }
  .atom-badge sub { font-size: 8px; }
  .atom-badge:hover { border-color: var(--accent-color, #3b82f6); }
  .atom-badge.selected {
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 25%, transparent);
    border-color: var(--accent-color, #3b82f6);
    color: var(--accent-color, #3b82f6);
  }
  .checkbox-row {
    display: flex; align-items: center; gap: 6px; margin: 4px 0;
    cursor: pointer;
  }
  .site-select { margin-top: 4px; width: 100%; }

  /* ─── Manual position ─── */
  .manual-pos-section { margin: 6px 0; }
  .manual-pos-hint { font-size: 10px; color: var(--text-color-muted, #9ca3af); margin-bottom: 6px; line-height: 1.4; }
  .manual-pos-display { display: flex; flex-direction: column; gap: 4px; }
  .manual-pos-label {
    font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
    color: #22c55e;
  }
  .manual-pos-coords { display: flex; gap: 4px; }
  .coord-field {
    flex: 1; display: flex; flex-direction: column; gap: 1px;
  }
  .coord-field span {
    font-size: 9px; font-weight: 600; color: var(--text-color-dim, #484f58);
  }
  .coord-field input {
    width: 100%; box-sizing: border-box; padding: 3px 4px; font-size: 10px; font-family: inherit;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); border-radius: 3px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
    color: var(--text-color, light-dark(#374151, #eee));
  }
  .manual-pos-actions { display: flex; gap: 4px; margin-top: 4px; }
  .site-status { font-size: 10px; color: var(--text-color-muted, #9ca3af); display: flex; align-items: center; gap: 6px; }
  .site-status.error { color: #ef4444; }
  .site-status.dim { opacity: 0.6; }

  .mini-spinner {
    width: 12px; height: 12px;
    border: 1.5px solid #555; border-top-color: var(--accent-color, #3b82f6);
    border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ─── Preview ─── */
  .preview-section { padding: 10px 12px; }
  .preview-header {
    display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;
  }
  .preview-header .section-label { margin-bottom: 0; }
  .expand-btn {
    background: none; border: 1px solid color-mix(in srgb, var(--text-color, #ccc) 30%, transparent);
    color: var(--text-color, #ccc); cursor: pointer; border-radius: 3px;
    padding: 1px 5px; font-size: 0.8rem; line-height: 1;
  }
  .expand-btn:hover {
    background: color-mix(in srgb, var(--accent-color, #4fc3f7) 20%, transparent);
    border-color: var(--accent-color, #4fc3f7);
  }
  .preview-viewport {
    height: 250px; position: relative; background: #111;
    border-radius: 6px; overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--text-color, #ccc) 20%, transparent);
  }
  .preview-info {
    padding: 3px 0; font-size: 10px;
    color: var(--text-color-muted, #9ca3af); text-align: center;
  }
  .place-error {
    font-size: 10px; color: #ef4444; margin-top: 4px;
    padding: 4px 8px; background: #ef444410; border-radius: 4px;
  }

  /* ─── Action buttons ─── */
  .actions-section { padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); }
  .action-btn {
    width: 100%; padding: 6px 10px; border-radius: 5px;
    font-size: 11px; font-weight: 600; cursor: pointer;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    font-family: inherit; transition: all 0.15s; text-align: center;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
    color: var(--text-color, light-dark(#374151, #eee));
  }
  .action-btn:hover { background: var(--dialog-border, light-dark(#d1d5db, #404040)); }
  .find-btn { margin-top: 6px; }
  .edit3d-btn {
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 12%, transparent);
    border-color: color-mix(in srgb, var(--accent-color, #3b82f6) 30%, transparent);
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }
  .edit3d-btn:hover { background: color-mix(in srgb, var(--accent-color, #3b82f6) 20%, transparent); }
  .reset-btn { color: var(--text-color-muted, #9ca3af); }

  /* ─── IO ─── */
  .io-section {
    padding: 10px 12px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
  }
  .io-row { display: flex; align-items: flex-start; gap: 8px; }
  .io-col { flex: 1; display: flex; flex-direction: column; gap: 2px; }
  .io-heading { font-size: 9px; font-weight: 700; color: var(--text-color-dim, #484f58); letter-spacing: 1px; margin-bottom: 2px; }
  .io-item {
    font-size: 10px; color: var(--text-color-muted, #9ca3af);
    padding: 1px 6px; background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
    border-radius: 3px; border: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    display: inline-block; margin-bottom: 2px;
  }
  .io-arrow { color: var(--text-color-dim, #484f58); font-size: 14px; padding-top: 14px; flex-shrink: 0; }
</style>
