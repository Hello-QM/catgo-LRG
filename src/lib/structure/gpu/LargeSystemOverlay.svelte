<script lang="ts">
  import { Color, type Camera } from 'three'
  import type { AnyStructure, ElementSymbol } from '$lib/structure'
  import { acquire_webgpu_device } from '$lib/structure/gpu/webgpu-context'
  import { pack_camera_full } from '$lib/structure/gpu/camera-uniform'
  import { pack_positions, pack_lattice } from '$lib/structure/gpu/frame-buffers'
  import { build_display_radii, build_atom_radii } from '$lib/structure/gpu/radius-lut'
  import { encode_bond_rules, type BondDistanceRuleLike } from '$lib/structure/gpu/bond-rules'
  import { to_compute_options } from '$lib/structure/gpu/large-system-mode.svelte'
  import { should_show_bonds } from '$lib/structure/scene'
  import type { ShowBonds } from '$lib/settings'
  import type { PymatgenLattice } from '$lib/structure'
  import {
    create_large_system_renderer,
    type LargeSystemRenderer,
  } from '$lib/structure/gpu/large-system-renderer'

  let {
    enabled = false,
    camera = undefined,
    structure = undefined,
    element_colors = undefined,
    atom_radius = 1.5,
    same_size_atoms = false,
    element_radius_overrides = undefined,
    site_radius_overrides = undefined,
    bonding_options = undefined,
    bond_distance_rules = undefined,
    show_bonds = `crystals`,
    background_color = undefined,
    background_opacity = 0.1,
    show_cell = false,
    cell_edge_color = `#808080`,
    trajectory_positions_version = undefined,
    get_displayed_frame_positions = undefined,
    trajectory_step_idx = -1,
    on_fallback = undefined,
    selected_sites = [],
    on_pick = undefined,
    supercell = [1, 1, 1],
    show_image_atoms = false,
  }: {
    enabled?: boolean
    camera?: Camera | undefined
    /** Current displayed structure whose atoms render as impostor spheres.
     *  During trajectory playback this carries the BASE/displayed topology
     *  (elements, count, supercell/PBC-image layout, and frame-0 xyz) — the
     *  per-frame xyz come from get_displayed_frame_positions, NOT from this
     *  object (whose identity / .sites[i].xyz stay static across frames in the
     *  fast path). The element/count/layout here MUST match the resolver's
     *  array index-for-index (both are the displayed-structure site order). */
    structure?: AnyStructure | undefined
    /** Per-element hex colors (e.g. state colors.element). */
    element_colors?: Partial<Record<ElementSymbol, string>> | undefined
    /** Global display-radius scale, mirrors the WebGL atom_radius prop. */
    atom_radius?: number
    /** Render all atoms at the same size (WebGL same_size_atoms). */
    same_size_atoms?: boolean
    /** Per-element radius overrides, mirrors the WebGL path. */
    element_radius_overrides?: Partial<Record<ElementSymbol, number>> | undefined
    /** Per-site radius overrides, mirrors the WebGL path. */
    site_radius_overrides?: Map<number, number> | undefined
    /** App bond options (tolerance / max_bond_dist / …) driving GPU bond
     *  detection. Same Record the CPU path reads (scene_props.bonding_options);
     *  mapped via to_compute_options. */
    bonding_options?: Record<string, number> | undefined
    /** Per-element-pair distance rules (the SAME `bond_distance_rules` the WebGL
     *  path reads). The overlay applies them as a POST-FILTER on the GPU-detected
     *  bonds, reproducing src/lib/structure/scene/visibility.ts exactly: for a
     *  detected bond with length d and element pair (eA,eB), if a rule exists for
     *  the SORTED pair it keeps the bond only when min ≤ d ≤ max, and if no rule
     *  exists it keeps the bond. Rules can only REMOVE strategy-detected bonds.
     *  Empty / undefined ⇒ no filtering (behaviour identical to no rules). */
    bond_distance_rules?:
      | { element_1: string; element_2: string; min_dist: number; max_dist: number }[]
      | undefined
    /** Viewer's bond-visibility setting (`never`/`always`/`crystals`/`molecules`),
     *  mirroring the WebGL path's `scene_props.show_bonds`. The overlay feeds this
     *  through the SAME `should_show_bonds(show_bonds, lattice)` predicate the
     *  WebGL view uses to decide whether bonds appear, so the two stay in lockstep:
     *  when bonds are hidden the overlay skips the GPU bond compute AND the bond
     *  draw (atoms + cell box still render). Defaults to `crystals` (the app
     *  default) so an absent prop matches the typical periodic-structure view. */
    show_bonds?: ShowBonds
    /** Viewer canvas background color (hex, e.g. `#000000`), mirroring the WebGL
     *  path's StructureScene `background_color`. The overlay resolves this the
     *  SAME way StructureScene's compute_canvas_bg does (lerp toward the theme
     *  bg by `background_opacity`) and converts it to linear RGB with the SAME
     *  conversion used for atom colors, so the overlay background matches the
     *  WebGL viewer's background and dark atoms keep their contrast. */
    background_color?: string | undefined
    /** Override strength of `background_color` over the theme bg: 0 → theme bg,
     *  1 → picked color, mid → lerp. Mirrors StructureScene's background_opacity. */
    background_opacity?: number
    /** Whether to draw the unit-cell box (lattice wireframe), mirroring the WebGL
     *  view's `scene_props.show_cell`. Default off ⇒ zero change. Only draws when
     *  true AND the structure carries a non-zero lattice (periodic). */
    show_cell?: boolean
    /** Cell edge line color (hex), mirroring the WebGL Lattice's `cell_edge_color`
     *  (DEFAULTS.structure.cell_edge_color = `#808080` grey). Converted to linear
     *  RGB the SAME way atom colors are. */
    cell_edge_color?: string
    /** Per-frame position version, mirroring Structure.svelte's bindable prop.
     *  `.v` bumps every time the trajectory frame's positions change (playback,
     *  scrub, or in-place edit) WITHOUT `structure` changing object identity, so
     *  it — not the structure ref — is the signal that drives per-frame
     *  re-upload. `.all` (edit-all fan-out) is not needed here; we always
     *  re-extract the whole frame. */
    trajectory_positions_version?: { v: number; all: boolean } | undefined
    /** Authoritative per-DISPLAYED-atom position source. Returns the current
     *  frame's xyz as a flat Float32Array(3 × n_displayed) indexed identically
     *  to `structure.sites` (the SAME array the WebGL atoms/bonds are drawn at:
     *  StructureScene.atom_positions_buffer — displayed-topology base overlaid
     *  with the manager's per-frame positions via site_ids_buffer). The overlay
     *  consumes this directly instead of re-deriving from base-only trajectory
     *  data, so its atoms/bonds match the WebGL view atom-for-atom — including
     *  the supercell base-block-animates / replica-static behaviour the WebGL
     *  position-write loop decides. null/undefined ⇒ fall back to the
     *  structure's own static sites xyz (no trajectory, or pre-mount). */
    get_displayed_frame_positions?: (() => Float32Array) | null | undefined
    /** Current trajectory frame index. -1 when no trajectory is active. Used
     *  (with trajectory_positions_version.v) only as the per-frame REFRESH
     *  TRIGGER — when it changes the overlay re-pulls get_displayed_frame_positions.
     *  The position values themselves come from that getter, not this index. */
    trajectory_step_idx?: number
    on_fallback?: (reason: string) => void
    /** App selection state (base site indices, same as the WebGL path's
     *  `selected_sites`). Mirrored into the overlay's GPU highlight buffer so the
     *  selected atoms glow — kept in sync whether selection changes via an overlay
     *  click (on_pick) or externally (toolbar, other panes). */
    selected_sites?: number[]
    /** Called when the user CLICKS (not drags) an atom in the overlay. `site_idx`
     *  is the picked atom's base site index, or -1 for empty space (background).
     *  The parent updates its `selected_sites` from this; the overlay then mirrors
     *  the new selection into the highlight buffer via the `selected_sites` prop. */
    on_pick?: ((site_idx: number) => void) | undefined
    /** GPU supercell factors [nx,ny,nz] (Phase 1). When the product > 1 AND the
     *  structure has a lattice, the parent keeps `structure` at the BASE cell and
     *  the overlay instances `base_count × nx·ny·nz` spheres on the GPU, each
     *  offset by ix·a + iy·b + iz·c. Default [1,1,1] ⇒ ncells = 1 ⇒ atom = inst,
     *  zero offset ⇒ byte-identical to the non-supercell draw. */
    supercell?: [number, number, number]
    /** Whether DISPLAYED PBC image atoms exist (the viewer's `show_image_atoms`).
     *  When true (non-supercell only), the renderer draws cross-cell bonds as FULL
     *  cylinders reaching the imaged partner where the displayed image atom sits,
     *  so image atoms gain bonds (matching the WebGL view). Default false ⇒ stubs
     *  ⇒ zero change; supercell mode is unaffected (Phase-2 logic is authoritative). */
    show_image_atoms?: boolean
  } = $props()

  let canvas = $state<HTMLCanvasElement | undefined>(undefined)

  // Active session resources. Kept outside $state — they are imperative GPU
  // handles, not reactive view data, and we don't want effects to re-run on
  // mutation. A monotonically increasing token cancels stale async starts.
  let renderer: LargeSystemRenderer | null = null
  let raf_id = 0
  let resize_observer: ResizeObserver | null = null
  let session_token = 0

  // Cached atom buffers, rebuilt only when the structure identity changes (not
  // every frame). `atom_source` is the identity sentinel we last built from.
  let atom_source: AnyStructure | undefined = undefined
  let atom_positions: Float32Array = new Float32Array(0)
  let atom_radii: Float32Array = new Float32Array(0)
  let atom_colors: Float32Array = new Float32Array(0)
  let atom_count = 0
  // Track the colors-object identity too, so a color-scheme swap rebuilds.
  let atom_colors_source: Partial<Record<ElementSymbol, string>> | undefined = undefined
  // Signature of the radius-affecting inputs we last built from; when it
  // changes the display radii must be recomputed.
  let atom_radius_sig = ``
  // Set when buffers were rebuilt and must be re-uploaded to the GPU.
  let atoms_dirty = false
  // Set when the structure IDENTITY or atom COUNT changed (supercell repeats,
  // structure swap) — i.e. the atom SET itself changed, not just its colors /
  // display radii. A color/radius-only change flips atoms_dirty (re-upload) but
  // NOT this. Used to force a full per-frame position re-extract + bond recompute
  // for the NEW atom set in the SAME frame, instead of waiting for a trajectory
  // frame event. `topology_count` is the count we last saw, so a supercell that
  // changes the count (e.g. 1x1x1 -> 3x3x3) is detected even if the structure
  // object identity comparison alone were insufficient.
  let topology_dirty = false
  let topology_count = -1

  // Cached bond inputs, rebuilt only when the structure identity or bonding
  // options change (not every frame). The renderer caches the compute dispatch
  // by its own dirty flag; here we just decide WHEN to re-push set_bond_data.
  let bond_source: AnyStructure | undefined = undefined
  let bond_covalent: Float32Array = new Float32Array(0)
  let bond_lattice: Float32Array = new Float32Array(9)
  let bond_periodic = false
  let bond_options_sig = ``
  let bond_compute_opts = { tolerance: 0, max_bond_dist: 0, min_dist: 0 }
  // Set when bond inputs changed and must be re-pushed to the renderer.
  let bonds_dirty = false

  // ── Per-element-pair distance-rule state ───────────────────────────────────
  // Encoded inputs for the GPU rule POST-FILTER (per-atom element ids + packed
  // rules), rebuilt when the structure identity OR the rules change. Pushed to
  // the renderer via set_bond_rules; the renderer re-runs the compute so editing
  // a rule updates the overlay bonds LIVE. Empty rules ⇒ no filtering.
  let rules_source: AnyStructure | undefined = undefined
  let rules_sig = ``
  let rule_elem_ids: Uint32Array = new Uint32Array(0)
  let rule_packed: Float32Array = new Float32Array(0)
  // Set when the encoded rules changed and must be re-pushed to the renderer.
  let rules_dirty = false

  /** Count of HOME (non-image) atoms in the displayed structure — the atoms the
   *  GPU bond compute must run over, matching the WebGL bond path which computes
   *  bonds on `bond_input_structure` (= supercell_structure, BEFORE PBC image
   *  expansion). When `show_image_atoms` is ON, find_pbc_images_fast APPENDS
   *  boundary replica atoms to displayed_structure.sites (indices ≥
   *  num_original_sites), each sitting ~one lattice vector OUTSIDE the cell. If
   *  those replicas were fed into the PERIODIC min-image bond compute (which uses
   *  the supercell lattice), the search would wrap a replica back across a full
   *  lattice vector → a bond cylinder spanning the whole supercell = the "spike"
   *  artefact. The home atoms are always the FIRST num_original_sites entries
   *  (create_supercell home block first, then find_pbc_images_fast pushes
   *  replicas after), so slicing the bond inputs to this count feeds the compute
   *  the exact home-atom set the WebGL path uses. Cross-cell bonds still appear
   *  via the periodic search's jimage on those home atoms; the replica spheres
   *  render but never participate in bonding (no double-count, no wrap). When no
   *  images are present (toggle OFF, or molecule) this is just sites.length. */
  function bond_home_count(): number {
    const sites = structure?.sites
    const n = sites?.length ?? 0
    const num_orig = (structure as { num_original_sites?: number } | undefined)?.num_original_sites
    if (typeof num_orig === `number` && num_orig > 0 && num_orig <= n) return num_orig
    return n
  }

  /** Cheap signature of the bond_distance_rules array; changes when any rule's
   *  elements or min/max do, so the GPU post-filter re-encodes + re-dispatches. */
  function bond_rules_signature(): string {
    const rs = bond_distance_rules
    if (!rs || rs.length === 0) return ``
    let s = ``
    for (const r of rs) s += `${r.element_1}-${r.element_2}:${r.min_dist},${r.max_dist};`
    return s
  }

  /** Re-encode the per-atom element ids + packed rules when the structure identity
   *  or the rules changed. Pure JS (encode_bond_rules); no-op otherwise. Note the
   *  elem-id mapping is per-structure, so a structure swap MUST re-encode even if
   *  the rules text is unchanged. */
  function rebuild_rules_if_needed(): void {
    const sig = bond_rules_signature()
    if (structure === rules_source && sig === rules_sig) return
    rules_source = structure
    rules_sig = sig
    rules_dirty = true
    const sites = structure?.sites
    if (!sites || sites.length === 0) {
      rule_elem_ids = new Uint32Array(0)
      rule_packed = new Float32Array(0)
      return
    }
    // Encode element ids over the HOME atoms only, in lockstep with bond_covalent
    // (the compute indexes elem_ids[i]/elem_ids[j] by the same atom index it uses
    // for radii). Slicing off appended PBC-image replicas keeps the two buffers
    // the same length (= bond_n) so the per-element-pair rule post-filter stays
    // aligned with the home-atom bond compute.
    const home_n = bond_home_count()
    const bond_sites = home_n < sites.length ? sites.slice(0, home_n) : sites
    const encoded = encode_bond_rules(
      bond_sites,
      (bond_distance_rules ?? []) as BondDistanceRuleLike[],
    )
    rule_elem_ids = encoded.elem_ids
    rule_packed = encoded.rules
  }
  // Whether bonds should render at all, decided by the SAME predicate the WebGL
  // path uses (should_show_bonds against the structure's lattice). When false the
  // overlay skips the GPU bond compute push AND the renderer skips compute+draw,
  // so flipping the viewer's show_bonds off clears the overlay's bonds while atoms
  // + cell box keep rendering. Reactive ⇒ toggling show_bonds repaints live.
  let bonds_visible = $derived(
    should_show_bonds(
      show_bonds,
      ((structure as { lattice?: PymatgenLattice } | undefined)?.lattice) ?? null,
    ),
  )
  // The enabled-state last pushed to the renderer, so we only call
  // set_bonds_enabled (+ re-push bond data on re-enable) when it actually flips.
  let last_bonds_enabled = true

  // ── Cell-box state ───────────────────────────────────────────────────────
  // Signature of the cell inputs last pushed to the renderer (lattice + show +
  // color), so set_cell is re-pushed only when one actually changes. The lattice
  // is read from bond_lattice (kept in lockstep by rebuild_bonds_if_needed and
  // refresh_frame_positions — including variable-cell trajectories).
  let cell_sig = ``

  // ── GPU supercell state (Phase 1) ──────────────────────────────────────────
  // Signature of the supercell dims + base lattice last pushed, so set_supercell
  // is re-pushed only when one actually changes (dims swap, or the base lattice
  // moves — e.g. cell edit / variable-cell). Default [1,1,1] ⇒ ncells 1 ⇒ the
  // renderer draws exactly as before.
  let supercell_sig = ``

  /** Push the GPU supercell dims + base lattice to the renderer when they
   *  changed. The base lattice is packed from `structure.lattice` (the parent
   *  keeps `structure` at the BASE cell while GPU-supercell is active). Returns
   *  true if it re-pushed (caller marks a redraw). */
  function sync_supercell(): boolean {
    if (!renderer) return false
    const dims: [number, number, number] = [
      Math.max(1, Math.floor(supercell?.[0] ?? 1)),
      Math.max(1, Math.floor(supercell?.[1] ?? 1)),
      Math.max(1, Math.floor(supercell?.[2] ?? 1)),
    ]
    const lat = (structure as { lattice?: PymatgenLattice } | undefined)?.lattice
    const base_lat = pack_lattice(lat)
    let sig = `${dims[0]}x${dims[1]}x${dims[2]}|`
    for (let i = 0; i < 9; i++) sig += `${base_lat[i]};`
    if (sig === supercell_sig) return false
    supercell_sig = sig
    renderer.set_supercell(dims, base_lat)
    return true
  }

  // Last show_image_atoms flag pushed to the renderer, so set_show_images fires
  // only when it actually flips. -1 = never pushed (forces the first sync).
  let show_images_sig = -1

  /** Push the viewer's show_image_atoms flag to the renderer when it changed.
   *  The renderer uses it (non-supercell path only) to draw cross-cell bonds full
   *  to the displayed image atom instead of as stubs. Returns true if re-pushed. */
  function sync_show_images(): boolean {
    if (!renderer) return false
    const next = show_image_atoms ? 1 : 0
    if (next === show_images_sig) return false
    show_images_sig = next
    renderer.set_show_images(!!show_image_atoms)
    return true
  }

  // ── Selection highlight state ──────────────────────────────────────────────
  // Signature of the selection last pushed to the renderer, so set_selection is
  // re-uploaded only when selected_sites actually changes (whether from an overlay
  // click or an external selection change).
  let selection_sig = ``

  /** Mirror the app's `selected_sites` into the renderer's GPU highlight buffer
   *  when it changed. Returns true if it re-pushed (caller marks a redraw). */
  function sync_selection(): boolean {
    if (!renderer) return false
    const sig = (selected_sites ?? []).join(`,`)
    if (sig === selection_sig) return false
    selection_sig = sig
    renderer.set_selection(selected_sites ?? [])
    return true
  }

  /** Push the unit-cell box to the renderer when its inputs (lattice / show /
   *  color) changed. Uses bond_lattice as the lattice source (already packed +
   *  kept current). Returns true if it re-pushed (caller marks a redraw). */
  function sync_cell(): boolean {
    if (!renderer) return false
    const [cr, cg, cb] = hex_to_linear_rgb(cell_edge_color)
    let lat_sig = ``
    for (let i = 0; i < 9; i++) lat_sig += `${bond_lattice[i]};`
    const sig = `${show_cell}|${cr},${cg},${cb}|${lat_sig}`
    if (sig === cell_sig) return false
    cell_sig = sig
    // bond_periodic is true exactly when the structure carries a lattice; pass
    // null otherwise so molecules never draw a (degenerate) box.
    renderer.set_cell(bond_periodic ? bond_lattice : null, show_cell, [cr, cg, cb])
    return true
  }

  // ── Per-frame trajectory state (milestone 9.4) ──────────────────────────
  // The last position-version we re-uploaded. When the parent bumps
  // trajectory_positions_version.v (playback / scrub / in-place edit) this
  // diverges and we re-extract + re-upload ONLY the xyz (set_positions) — radii
  // and colors are NOT rebuilt, since elements don't change between frames.
  let last_pos_version = -1
  // The last frame index we re-uploaded. Normal playback ADVANCES the frame
  // index (trajectory_step_idx) without necessarily bumping
  // trajectory_positions_version.v — that version bumps when the CURRENT frame's
  // positions change IN PLACE (editing), not on a plain frame advance. So we
  // must re-extract on EITHER signal diverging, mirroring the CPU/WebGL bond
  // cache which keys on both get_step_idx AND get_positions_version.
  let last_step_idx = -1
  // Current-frame xyz, indexed identically to structure.sites. Reused buffer.
  let frame_positions: Float32Array = new Float32Array(0)
  // Set when frame_positions changed and must be re-uploaded to the GPU.
  let positions_dirty = false
  // Lattice signature last pushed for bonds; for variable-cell trajectories the
  // lattice changes per frame and the bond compute + bond render need the new
  // one. Compared per frame so a static cell never re-uploads.
  let frame_lattice_sig = ``

  /** Re-extract the current frame's per-DISPLAYED-atom xyz from the shared
   *  WebGL resolver and mark positions (+ bonds) dirty. Falls back to the
   *  structure's own static sites xyz when the getter is unavailable (no
   *  trajectory active, or pre-mount before StructureScene bound the getter —
   *  in which case structure.sites already holds the static positions and this
   *  is a harmless re-upload). For variable-cell trajectories also re-checks the
   *  lattice and re-pushes bond data when it moved. */
  function refresh_frame_positions(): void {
    last_pos_version = trajectory_positions_version?.v ?? -1
    last_step_idx = trajectory_step_idx
    const sites = structure?.sites
    if (!sites || sites.length === 0) return
    // SINGLE SOURCE OF TRUTH: get_displayed_frame_positions() returns the exact
    // per-displayed-atom position array the WebGL atoms/bonds are drawn at
    // (StructureScene.atom_positions_buffer) — already resolved for supercell /
    // PBC-image atoms (base atoms carry the current trajectory frame, replicas
    // stay at their topology positions, exactly as the WebGL view shows). We
    // consume it as-is: no base→displayed remapping, no partial-apply guess.
    let pos: Float32Array | null = null
    if (get_displayed_frame_positions) pos = get_displayed_frame_positions()
    // Guard against a length mismatch (e.g. the resolver lagging a supercell
    // change by one tick): if the resolved array doesn't cover the current
    // displayed atom set, fall back to the structure's own static sites xyz so
    // we never index out of bounds or upload a short buffer. The topology_dirty
    // path re-fires once the resolver catches up.
    if (pos && pos.length === sites.length * 3) {
      // Copy into a private buffer so a later in-place mutation of the shared
      // $derived array can't corrupt what we already uploaded.
      if (frame_positions.length !== pos.length) frame_positions = new Float32Array(pos.length)
      frame_positions.set(pos)
    } else {
      frame_positions = pack_positions(sites)
    }
    positions_dirty = true

    // Variable-cell: if the displayed lattice changed, the bond compute + bond
    // render must use the new lattice. Re-pack and flag bonds for re-push. (A
    // static cell leaves frame_lattice_sig unchanged ⇒ no bond-input churn.)
    const lat = (structure as { lattice?: import('$lib/structure').PymatgenLattice }).lattice
    const packed = pack_lattice(lat)
    let sig = ``
    for (let i = 0; i < 9; i++) sig += `${packed[i]};`
    if (sig !== frame_lattice_sig) {
      frame_lattice_sig = sig
      bond_lattice = packed
      bond_periodic = !!lat
      bonds_dirty = true
      // Phase 3 — variable-cell supercell tracking: the GPU supercell uniform's
      // base lattice (rows a,b,c) feeds each replica's offset (ix·a + iy·b +
      // iz·c). For a VARIABLE-CELL trajectory that base cell changes per frame,
      // so the uniform must be re-uploaded with the new lattice or the replicas
      // keep their frame-0 spacing (drift / overlap as the cell breathes). Only
      // when a real supercell is active (product > 1) — at 1×1×1 ncells is 1 and
      // the offset is always zero, so this is a no-op cost we skip entirely. We
      // reuse the lattice we JUST packed (no second pack_lattice) and keep the
      // dims unchanged (they're constant during playback). sync_supercell() runs
      // later in frame(); refreshing supercell_sig here keeps the two in lockstep
      // so it doesn't redundantly re-push the same lattice it sees this frame.
      const nx = Math.max(1, Math.floor(supercell?.[0] ?? 1))
      const ny = Math.max(1, Math.floor(supercell?.[1] ?? 1))
      const nz = Math.max(1, Math.floor(supercell?.[2] ?? 1))
      if (renderer && nx * ny * nz > 1) {
        const dims: [number, number, number] = [nx, ny, nz]
        renderer.set_supercell(dims, packed)
        let scs = `${nx}x${ny}x${nz}|`
        for (let i = 0; i < 9; i++) scs += `${packed[i]};`
        supercell_sig = scs
      }
    }
  }

  /** Cheap signature of the bonding options Record; changes when any cutoff
   *  does so the GPU compute re-dispatches with the new value. */
  function bond_options_signature(): string {
    const o = bonding_options
    if (!o) return ``
    let s = ``
    for (const k of Object.keys(o).sort()) s += `${k}=${o[k]};`
    return s
  }

  /** Rebuild the bond inputs (covalent radii, lattice, options, periodicity)
   *  when the structure identity or bonding options change. No-op otherwise. */
  function rebuild_bonds_if_needed(): void {
    const sig = bond_options_signature()
    if (structure === bond_source && sig === bond_options_sig) return
    bond_source = structure
    bond_options_sig = sig
    bonds_dirty = true
    const sites = structure?.sites
    if (!sites || sites.length === 0) {
      bond_covalent = new Float32Array(0)
      bond_lattice = new Float32Array(9)
      bond_periodic = false
      return
    }
    // Bond compute runs over HOME atoms only (see bond_home_count): slice off
    // any appended PBC-image replicas so the periodic min-image search can't wrap
    // a replica across a full lattice vector → no spikes. Matches the WebGL bond
    // path (bonds on supercell_structure, replicas drawn but not bonded).
    const home_n = bond_home_count()
    const bond_sites = home_n < sites.length ? sites.slice(0, home_n) : sites
    bond_covalent = build_atom_radii(bond_sites)
    // Periodic only when the structure carries a lattice (molecules don't).
    const lat = (structure as { lattice?: import('$lib/structure').PymatgenLattice }).lattice
    bond_lattice = pack_lattice(lat)
    bond_periodic = !!lat
    bond_compute_opts = to_compute_options(bonding_options ?? {})
    // Keep the per-frame lattice signature in lockstep so refresh_frame_positions
    // doesn't redundantly re-push the lattice it just packed here.
    let lat_sig = ``
    for (let i = 0; i < 9; i++) lat_sig += `${bond_lattice[i]};`
    frame_lattice_sig = lat_sig
  }

  // Hex -> linear RGB, matching the WebGL path (Color.convertSRGBToLinear).
  const _col = new Color()
  function hex_to_linear_rgb(hex: string): [number, number, number] {
    _col.set(hex).convertSRGBToLinear()
    return [_col.r, _col.g, _col.b]
  }

  // ── Background color (Fix 1) ────────────────────────────────────────────
  // The last linear-RGB background pushed to the renderer, so we only re-push +
  // re-render when the resolved color actually changes.
  let last_bg: [number, number, number] | null = null
  const _bg = new Color()

  /** Walk up from the overlay canvas to find the first opaque CSS background
   *  color (the theme bg). Mirrors StructureScene.find_theme_bg so the overlay
   *  resolves the same theme background the WebGL clear color lerps toward. */
  function find_theme_bg(target: Color): Color {
    let el: HTMLElement | null = canvas ?? null
    while (el) {
      const bg = getComputedStyle(el).backgroundColor
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
      if (m) {
        const a = m[4] !== undefined ? parseFloat(m[4]) : 1
        if (a >= 0.5) return target.setRGB(+m[1] / 255, +m[2] / 255, +m[3] / 255)
      }
      el = el.parentElement
    }
    return target.setRGB(0, 0, 0)
  }

  /** Resolve the viewer background the SAME way StructureScene.compute_canvas_bg
   *  does (picked hex, theme bg, or a lerp by background_opacity), then convert
   *  to linear RGB with the SAME conversion used for atom colors. Returns the
   *  linear-RGB triple to upload as the overlay clear color. */
  function resolve_background_rgb(): [number, number, number] {
    const picked = new Color(background_color ?? `#000000`)
    const t = Math.max(0, Math.min(1, background_opacity))
    if (t >= 0.999) _bg.copy(picked)
    else if (t <= 0.001) find_theme_bg(_bg)
    else find_theme_bg(_bg).lerp(picked, t)
    // convertSRGBToLinear matches hex_to_linear_rgb (atom color space).
    _bg.convertSRGBToLinear()
    return [_bg.r, _bg.g, _bg.b]
  }

  /** Push the resolved background to the renderer when it changed. Marks a
   *  redraw so the new clear color paints. Returns true if it changed. */
  function sync_background(): boolean {
    if (!renderer) return false
    const rgb = resolve_background_rgb()
    if (
      last_bg &&
      Math.abs(last_bg[0] - rgb[0]) < 1e-6 &&
      Math.abs(last_bg[1] - rgb[1]) < 1e-6 &&
      Math.abs(last_bg[2] - rgb[2]) < 1e-6
    ) {
      return false
    }
    last_bg = rgb
    renderer.set_background(rgb)
    return true
  }

  /** Cheap signature of the radius-affecting inputs; changes when any of them
   *  do so the display radii get recomputed (identity for the override maps,
   *  size for the site map, values for the element map). */
  function radius_signature(): string {
    let sro = ``
    if (site_radius_overrides && site_radius_overrides.size > 0) {
      for (const [k, v] of site_radius_overrides) sro += `${k}=${v};`
    }
    let ero = ``
    if (element_radius_overrides) {
      for (const k of Object.keys(element_radius_overrides)) {
        ero += `${k}=${(element_radius_overrides as Record<string, number>)[k]};`
      }
    }
    return `${atom_radius}|${same_size_atoms}|${ero}|${sro}`
  }

  /** Rebuild the flat atom buffers from the current structure + element colors
   *  + display-radius inputs. No-op (reuses cached arrays) when nothing that
   *  affects them has changed. */
  function rebuild_atoms_if_needed(): void {
    const sig = radius_signature()
    // Detect a structure-IDENTITY or atom-COUNT change (supercell repeats,
    // structure swap) BEFORE we overwrite atom_source — independent of the
    // color/radius-only path below. A new identity OR a changed count means the
    // atom SET itself changed, so the current per-frame positions + bond compute
    // are stale for the new set and must be re-extracted/recomputed in THIS
    // frame (handled by the topology_dirty branch in frame()).
    const next_count = structure?.sites?.length ?? 0
    if (structure !== atom_source || next_count !== topology_count) {
      topology_dirty = true
      topology_count = next_count
    }
    if (
      structure === atom_source &&
      element_colors === atom_colors_source &&
      sig === atom_radius_sig
    ) {
      return
    }
    atom_source = structure
    atom_colors_source = element_colors
    atom_radius_sig = sig
    atoms_dirty = true
    const sites = structure?.sites
    if (!sites || sites.length === 0) {
      atom_positions = new Float32Array(0)
      atom_radii = new Float32Array(0)
      atom_colors = new Float32Array(0)
      atom_count = 0
      return
    }
    atom_positions = pack_positions(sites)
    // VISUAL sphere radius — matches the WebGL ball-and-stick display sizing
    // (atomic_radii[element] * atom_radius, with same_size / overrides). NOT
    // the covalent bond-cutoff radius (build_atom_radii) used by 9.3.
    atom_radii = build_display_radii(sites, {
      atom_radius,
      same_size_atoms,
      element_radius_overrides,
      site_radius_overrides,
    })
    atom_count = sites.length
    const cols = new Float32Array(sites.length * 3)
    for (let i = 0; i < sites.length; i++) {
      const elem = sites[i].species[0]?.element
      const hex = (elem != null ? element_colors?.[elem] : undefined) ?? `#ffffff`
      const [r, g, b] = hex_to_linear_rgb(hex)
      cols[i * 3] = r
      cols[i * 3 + 1] = g
      cols[i * 3 + 2] = b
    }
    atom_colors = cols
  }

  function stop_session(): void {
    session_token++ // invalidate any in-flight acquire_webgpu_device()
    if (raf_id) {
      cancelAnimationFrame(raf_id)
      raf_id = 0
    }
    if (typeof window !== `undefined`) {
      if (on_wake_event) {
        window.removeEventListener(`pointerdown`, on_wake_event)
        window.removeEventListener(`pointermove`, on_wake_event)
        window.removeEventListener(`wheel`, on_wake_event)
        window.removeEventListener(`keydown`, on_wake_event)
      }
      if (on_pointer_down) window.removeEventListener(`pointerdown`, on_pointer_down)
      if (on_pointer_up) window.removeEventListener(`pointerup`, on_pointer_up)
    }
    on_wake_event = null
    on_pointer_down = null
    on_pointer_up = null
    resize_observer?.disconnect()
    resize_observer = null
    renderer?.destroy()
    renderer = null
  }

  // On-demand render state. The rAF loop is self-suspending: it only runs while
  // there is motion (camera change, atom re-upload, or resize) and goes fully to
  // sleep — cancelAnimationFrame + raf_id=0, NO further scheduling — once the
  // camera has been stable for a short grace period. Interaction / data / size
  // events call wake() to restart it. This keeps the compositor/GPU idle (fan
  // quiet) when nothing is moving, instead of pinning a perpetual ~60fps tick.
  let last_camera_uniform: Float32Array | null = null
  let needs_render = true // force the first frame
  // Consecutive frames with no change seen so far. When this reaches
  // STABLE_FRAMES_TO_SLEEP the loop suspends. The grace tail (~0.4s @ 60fps)
  // lets control inertia/momentum settle before we stop scheduling.
  let stable_frames = 0
  const STABLE_FRAMES_TO_SLEEP = 24

  // Bound listener handles, kept so teardown can remove exactly what it added.
  let on_wake_event: ((ev: Event) => void) | null = null

  // ── Click-to-pick state ────────────────────────────────────────────────────
  // The overlay canvas is pointer-events:none so camera drags pass through to the
  // WebGL controls underneath. To pick WITHOUT stealing camera control we watch
  // window pointerdown/up: a pointerup close to the pointerdown (minimal movement)
  // is a CLICK ⇒ pick; movement beyond the threshold is a DRAG (camera rotate) ⇒
  // ignore. We never preventDefault, so the underlying controls always get the
  // drag. Bound listener handles for exact teardown.
  let on_pointer_down: ((ev: PointerEvent) => void) | null = null
  let on_pointer_up: ((ev: PointerEvent) => void) | null = null
  // pointerdown anchor (client coords) + button, used to classify the gesture.
  let down_x = 0
  let down_y = 0
  let down_button = -1
  // Max client-pixel movement between down and up that still counts as a click.
  const CLICK_MOVE_PX = 4

  /** Pick the atom under the given CLIENT (cursor) coords and notify the parent.
   *  Maps client → canvas-local CSS px → DEVICE px, the space the pick id texture
   *  is rendered at. The device scale is derived from the ACTUAL backing-store
   *  size (`canvas.width/height`) over the CSS box (`rect.width/height`), NOT from
   *  `devicePixelRatio` directly — the renderer sized the backing store to
   *  `clientWidth * dpr` then floored it, so the true per-axis scale can differ
   *  slightly from a bare `dpr` (fractional DPR, sub-pixel CSS rounding). Using
   *  the real ratio keeps the cursor texel exact and matches how `pick()` indexes
   *  the texture (sized to `canvas.width/height`). Only fires when the cursor is
   *  over the canvas. Calls on_pick(site_idx) with the picked base site index, or
   *  -1 for background (empty space) so the parent can clear the selection. */
  async function pick_at_client(client_x: number, client_y: number): Promise<void> {
    if (!renderer || !canvas || !on_pick) return
    const rect = canvas.getBoundingClientRect()
    // Ignore clicks outside the viewer canvas (e.g. on toolbars / panes).
    if (
      client_x < rect.left || client_x > rect.right ||
      client_y < rect.top || client_y > rect.bottom
    ) {
      return
    }
    // CSS-px offset within the canvas box, then scale by backing/CSS so the
    // result lands in the pick texture's device-pixel space exactly.
    const scale_x = rect.width > 0 ? canvas.width / rect.width : 1
    const scale_y = rect.height > 0 ? canvas.height / rect.height : 1
    const x = (client_x - rect.left) * scale_x
    const y = (client_y - rect.top) * scale_y
    const idx = await renderer.pick(x, y)
    on_pick(idx)
  }

  /** True if `next` differs from the last uploaded camera uniform (epsilon
   *  compare). Updates the cached copy when it returns true. */
  function camera_changed(next: Float32Array): boolean {
    const prev = last_camera_uniform
    if (!prev || prev.length !== next.length) {
      last_camera_uniform = next.slice()
      return true
    }
    for (let i = 0; i < next.length; i++) {
      if (Math.abs(prev[i] - next[i]) > 1e-6) {
        last_camera_uniform = next.slice()
        return true
      }
    }
    return false
  }

  function size_to_client(el: HTMLCanvasElement): void {
    const dpr = typeof window !== `undefined` ? window.devicePixelRatio || 1 : 1
    const w = el.clientWidth * dpr
    const h = el.clientHeight * dpr
    renderer?.resize(w, h)
    needs_render = true // resized backing store/depth must repaint
  }

  /** Restart the suspended rAF loop. Resets the stable-frame counter so the
   *  loop runs for at least a full grace period, and schedules a frame only if
   *  none is pending and the session is live. Idempotent while already awake. */
  function wake(): void {
    if (!enabled || !renderer) return
    stable_frames = 0
    if (raf_id === 0) raf_id = requestAnimationFrame(frame)
  }

  // Token the current loop belongs to. The `frame` closure lives at component
  // scope (so wake()/listeners can reschedule it) and re-reads this to bail when
  // its session has been superseded or torn down.
  let frame_token = 0

  function frame(): void {
    if (frame_token !== session_token || !renderer) {
      raf_id = 0
      return
    }
    // Only issue a GPU draw when something changed since the last drawn frame.
    let dirty = needs_render
    needs_render = false

    // Rebuild atom buffers only when the structure / colors / radius inputs
    // changed; re-upload + mark dirty on that same change. This uploads the
    // BASE-frame positions packed from structure.sites — the per-frame override
    // below replaces them with the live trajectory frame in the same frame.
    rebuild_atoms_if_needed()
    if (atoms_dirty) {
      renderer.set_atoms(atom_positions, atom_radii, atom_colors, atom_count)
      atoms_dirty = false
      dirty = true
    }
    // Structure IDENTITY / atom COUNT changed (supercell repeats, structure
    // swap). The atom buffers above are now sized to the NEW set, but the
    // per-frame POSITION buffer + GPU bond compute are still aligned to the OLD
    // set — left stale they connect atoms at wrong positions (garbled
    // bonds/spikes) until a later frame event bumps the version. So re-extract
    // the CURRENT frame's positions for the NEW set NOW and force a bond
    // recompute, in this same frame, AFTER set_atoms (buffers sized) and BEFORE
    // the per-frame/bond push below. We reset the version/step trackers first so
    // this forced refresh isn't skipped by the "≠ last_*" guard, and so the
    // SUBSEQUENT genuine frame change (≠ these reset values) still triggers
    // refresh_frame_positions normally.
    if (topology_dirty) {
      topology_dirty = false
      last_pos_version = -1
      last_step_idx = -1
      refresh_frame_positions() // sets positions_dirty (+ bonds_dirty if lattice moved)
      bonds_dirty = true // force the GPU bond compute against the consistent new positions
      dirty = true
    }

    // Per-frame positions: re-upload ONLY xyz when the trajectory frame moved —
    // EITHER the frame index advanced (normal playback / single-step / scrub)
    // OR the current frame's positions changed in place (version bump on edit).
    // radii + colors stay as last uploaded. set_positions also flags the
    // renderer's bonds dirty so the GPU bond compute re-runs against the moved
    // atoms (bonds form/break as atoms move).
    if (
      trajectory_step_idx !== last_step_idx ||
      (trajectory_positions_version?.v ?? -1) !== last_pos_version
    ) {
      refresh_frame_positions()
    }
    if (positions_dirty) {
      renderer.set_positions(frame_positions, atom_count)
      positions_dirty = false
      dirty = true
    }

    // Bond inputs: rebuild on structure/option change, then push to the renderer
    // (which re-runs the GPU bond compute on its own dirty flag). Also re-push
    // when atoms were re-uploaded, since set_atoms moves positions the compute
    // depends on (the renderer already flags itself dirty there, but pushing
    // keeps the covalent radii / count in lockstep with the atom buffer).
    // Sync bond visibility (should_show_bonds) to the renderer FIRST. Toggling it
    // gates the renderer's bond compute pass AND bond draw; a flip always forces a
    // repaint so bonds appear/disappear immediately. On re-enable, the renderer
    // flags itself bonds_dirty and we also re-push set_bond_data below so the
    // compute runs against the current atoms/lattice.
    if (bonds_visible !== last_bonds_enabled) {
      last_bonds_enabled = bonds_visible
      renderer.set_bonds_enabled(bonds_visible)
      if (bonds_visible) bonds_dirty = true // force a re-push + recompute on enable
      dirty = true
    }
    // Bond inputs: rebuild + push ONLY while bonds are visible. While hidden we
    // skip the GPU bond compute push entirely (and the renderer skips compute +
    // draw), so the overlay shows no bonds — atoms + cell box still render. We
    // still track the rebuild state so the next time bonds turn back on the
    // changed inputs are re-pushed (bonds_dirty was set on enable above).
    if (bonds_visible) {
      rebuild_bonds_if_needed()
      if (bonds_dirty) {
        renderer.set_bond_data(bond_covalent, bond_lattice, bond_compute_opts, bond_periodic)
        bonds_dirty = false
        dirty = true
      }
      // Per-element-pair distance-rule POST-FILTER: re-encode on structure/rule
      // change and push the per-atom element ids + packed rules. The renderer
      // re-runs the bond compute so editing a rule updates the overlay LIVE.
      // Pushed AFTER set_bond_data (which also flags the renderer bonds_dirty),
      // so a combined change still results in a single recompute next render.
      rebuild_rules_if_needed()
      if (rules_dirty) {
        renderer.set_bond_rules(rule_elem_ids, rule_packed)
        rules_dirty = false
        dirty = true
      }
    }

    // Cell box: push the lattice + show + color to the renderer when any of them
    // changed. Runs after the bond rebuild above so bond_lattice (the cell's
    // lattice source) is current for this frame — including variable-cell
    // trajectories where refresh_frame_positions re-packs it per frame.
    if (sync_cell()) dirty = true

    // GPU supercell: push the instancing dims + base lattice when they changed.
    // ncells > 1 makes the renderer draw base_count × nx·ny·nz sphere instances,
    // each offset by ix·a + iy·b + iz·c (the CPU stays at the base cell). Default
    // [1,1,1] ⇒ ncells 1 ⇒ identical draw to today.
    if (sync_supercell()) dirty = true

    // PBC image atoms: push the viewer's show_image_atoms flag so cross-cell bonds
    // reach the displayed image atoms (full cylinders) when it is on, or stay stubs
    // when off. Non-supercell only; supercell mode ignores it. Default off ⇒ stubs.
    if (sync_show_images()) dirty = true

    // Selection highlight: mirror the app's selected_sites into the GPU highlight
    // buffer when it changed (overlay click OR external selection change).
    if (sync_selection()) dirty = true

    // Background: resolve the viewer's bg color (theme/opacity/picked) and push
    // it to the renderer only when it changed. A change repaints so the new
    // clear color shows. Cheap when static (string compare + no GPU work).
    if (sync_background()) dirty = true

    // Camera: pack always (cheap), upload + mark dirty only when it moved.
    if (camera) {
      camera.updateMatrixWorld()
      const packed = pack_camera_full(camera)
      if (camera_changed(packed)) {
        renderer.set_camera_full(packed)
        dirty = true
      }
    }

    if (dirty) {
      renderer.render()
      stable_frames = 0 // motion this frame ⇒ stay awake
    } else {
      stable_frames++
    }

    // Suspend once the scene has been stable through the grace period: cancel
    // and stop scheduling entirely. wake() (interaction/data/resize) revives it.
    if (stable_frames >= STABLE_FRAMES_TO_SLEEP) {
      raf_id = 0
      return
    }
    raf_id = requestAnimationFrame(frame)
  }

  async function start_session(el: HTMLCanvasElement): Promise<void> {
    const token = ++session_token
    // Fresh renderer => fresh GPU buffers. Force a rebuild + re-upload on the
    // first frame even if the structure identity hasn't changed since last time.
    atom_source = undefined
    atom_colors_source = undefined
    atom_radius_sig = ``
    atoms_dirty = true
    // Fresh renderer ⇒ treat the topology as new so the first frame forces a
    // per-frame position re-extract + bond recompute for the current atom set.
    topology_dirty = false
    topology_count = -1
    // Fresh renderer ⇒ fresh bond buffers; force a rebuild + re-push.
    bond_source = undefined
    bond_options_sig = ``
    bonds_dirty = true
    // Fresh renderer ⇒ its rule buffers are placeholders; force a re-encode +
    // re-push of the per-atom element ids + packed rules on the first frame.
    rules_source = undefined
    rules_sig = ``
    rules_dirty = true
    // Fresh renderer ⇒ its bonds_enabled defaults to true; match that here so the
    // first frame re-syncs set_bonds_enabled when bonds are currently hidden.
    last_bonds_enabled = true
    // Fresh renderer ⇒ force a per-frame re-extract + re-upload on the first
    // frame, and re-detect the lattice for variable-cell bonds.
    last_pos_version = -1
    last_step_idx = -1
    frame_lattice_sig = ``
    positions_dirty = false
    // Fresh GPU camera buffer ⇒ force a first paint and a re-upload.
    last_camera_uniform = null
    // Fresh renderer ⇒ force the background to re-resolve + re-push.
    last_bg = null
    // Fresh renderer ⇒ force the cell box to re-resolve + re-push.
    cell_sig = ``
    // Fresh renderer ⇒ its supercell defaults to [1,1,1]; force a re-push of the
    // current dims + base lattice on the first frame.
    supercell_sig = ``
    // Fresh renderer ⇒ its show_image_atoms defaults to false; force a re-push of
    // the current flag on the first frame.
    show_images_sig = -1
    // Fresh renderer ⇒ its selection buffer is empty; force a re-push of the
    // current selection on the first frame.
    selection_sig = ``
    needs_render = true
    stable_frames = 0
    const device = await acquire_webgpu_device()
    // Bail if disabled / unmounted / superseded while awaiting.
    if (token !== session_token) return
    if (!device) {
      on_fallback?.(`Large-system performance mode unavailable on this device — using the standard viewer.`)
      return
    }
    let r: LargeSystemRenderer
    try {
      r = create_large_system_renderer(device, el)
    } catch (err) {
      on_fallback?.(`Large-system performance mode failed to start — using the standard viewer. (${err instanceof Error ? err.message : String(err)})`)
      return
    }
    renderer = r
    frame_token = token
    size_to_client(el)

    // Resize: repaint the new backing store and wake the loop if it had slept.
    resize_observer = new ResizeObserver(() => {
      if (renderer && canvas) {
        size_to_client(canvas)
        wake()
      }
    })
    resize_observer.observe(el)

    // Interaction wake triggers. The overlay canvas is pointer-events:none, so
    // we listen on `window` (passive — we never preventDefault). Each event just
    // revives the suspended loop; the frame itself decides whether to redraw.
    on_wake_event = () => wake()
    // Click-to-pick: record the pointerdown anchor; on pointerup decide click vs
    // drag. Only the primary (left) button picks; we never preventDefault so the
    // underlying WebGL orbit/trackball controls still receive every drag.
    on_pointer_down = (ev: PointerEvent) => {
      down_x = ev.clientX
      down_y = ev.clientY
      down_button = ev.button
    }
    on_pointer_up = (ev: PointerEvent) => {
      if (ev.button !== 0 || down_button !== 0) return
      const moved = Math.hypot(ev.clientX - down_x, ev.clientY - down_y)
      if (moved > CLICK_MOVE_PX) return // a drag (camera rotate) — not a pick
      // A click: render a fresh pick frame and feed the result to the parent.
      // (fire-and-forget; the async readback resolves shortly after.)
      void pick_at_client(ev.clientX, ev.clientY)
    }
    if (typeof window !== `undefined`) {
      window.addEventListener(`pointerdown`, on_wake_event, { passive: true })
      window.addEventListener(`pointermove`, on_wake_event, { passive: true })
      window.addEventListener(`wheel`, on_wake_event, { passive: true })
      window.addEventListener(`keydown`, on_wake_event)
      window.addEventListener(`pointerdown`, on_pointer_down, { passive: true })
      window.addEventListener(`pointerup`, on_pointer_up, { passive: true })
    }

    // First frame: render once and start the loop. It self-suspends after the
    // grace period if the camera never moves.
    raf_id = requestAnimationFrame(frame)
  }

  $effect(() => {
    // Re-run only on enabled / canvas changes. `camera` is read inside the RAF
    // loop (not tracked here) so a camera swap doesn't restart the session.
    if (enabled && canvas) {
      start_session(canvas)
      return () => stop_session()
    }
    // disabled or no canvas yet: ensure nothing is running.
    stop_session()
    return undefined
  })

  $effect(() => {
    // Atom-data wake trigger. Track the structure / color / radius inputs so a
    // rebuild revives a suspended loop and the new atoms repaint once. Reading
    // these here (not in the session effect) wakes without restarting the GPU
    // session. The `frame` does the actual rebuild + upload via
    // rebuild_atoms_if_needed(). Force the next frame to draw regardless.
    void [structure, element_colors, atom_radius, same_size_atoms, element_radius_overrides, site_radius_overrides, bonding_options, bond_distance_rules]
    if (renderer) {
      needs_render = true
      wake()
    }
  })

  $effect(() => {
    // Per-frame wake trigger. Track ONLY the position version (and the step
    // index it indexes) so a trajectory frame change — playback tick, scrub, or
    // single step — revives a suspended loop and renders that one frame. The
    // `frame` does the actual re-extract + re-upload via refresh_frame_positions
    // (gated on .v ≠ last_pos_version). Force the next frame to draw. Reading
    // these here (not in the session effect) wakes without restarting the GPU
    // session; when playback stops, .v stops bumping ⇒ no more wakes ⇒ the loop
    // suspends after its grace period (idle-quiet).
    void [trajectory_positions_version?.v, trajectory_step_idx]
    if (renderer) {
      needs_render = true
      wake()
    }
  })

  $effect(() => {
    // Background-color wake trigger. Track the bg inputs so a theme/opacity/
    // picked-color change revives a suspended loop; the frame re-resolves the
    // clear color via sync_background and repaints once. (Theme changes that
    // don't bump these props are caught lazily on the next wake from any other
    // source — consistent with the WebGL path's own mutation-observer resync.)
    void [background_color, background_opacity]
    if (renderer) {
      needs_render = true
      wake()
    }
  })

  $effect(() => {
    // Bond-visibility wake trigger. Read bonds_visible (derived from show_bonds +
    // the structure's lattice) so flipping the viewer's "show bonds" setting
    // revives a suspended loop; the frame syncs set_bonds_enabled and repaints
    // once — bonds appear/disappear while atoms + cell box stay. Reading the
    // derived here (not in the session effect) wakes without restarting the GPU
    // session.
    void bonds_visible
    if (renderer) {
      needs_render = true
      wake()
    }
  })

  $effect(() => {
    // Cell-box wake trigger. Track show_cell + cell_edge_color so toggling the
    // cell on/off or recoloring it revives a suspended loop; the frame re-pushes
    // via sync_cell and repaints once. (Lattice changes are caught by the
    // structure/per-frame wakes, which update bond_lattice.)
    void [show_cell, cell_edge_color]
    if (renderer) {
      needs_render = true
      wake()
    }
  })

  $effect(() => {
    // GPU-supercell wake trigger. Track the supercell dims so changing the
    // requested supercell (e.g. 1×1×1 → 5×5×5) revives a suspended loop; the frame
    // re-pushes via sync_supercell and repaints once with the new instance count.
    // (Base-lattice changes are caught by the structure wake, which also drives
    // the atom/cell rebuilds.)
    void [supercell[0], supercell[1], supercell[2]]
    if (renderer) {
      needs_render = true
      wake()
    }
  })

  $effect(() => {
    // show_image_atoms wake trigger. Track the flag so toggling displayed PBC
    // image atoms revives a suspended loop; the frame re-pushes via sync_show_images
    // (which marks the renderer bonds dirty) and repaints once with full-to-image
    // bonds (on) or stubs (off).
    void show_image_atoms
    if (renderer) {
      needs_render = true
      wake()
    }
  })

  $effect(() => {
    // Selection wake trigger. Track selected_sites so an external selection change
    // (toolbar, other panes, or our own on_pick round-trip) revives a suspended
    // loop; the frame mirrors it into the GPU highlight buffer via sync_selection
    // and repaints once. Reading it here (not in the session effect) wakes without
    // restarting the GPU session.
    void selected_sites
    if (renderer) {
      needs_render = true
      wake()
    }
  })
</script>

{#if enabled}
  <canvas
    bind:this={canvas}
    class="large-system-overlay"
    style="position: absolute; inset: 0; width: 100%; height: 100%;"
  ></canvas>
{/if}

<style>
  .large-system-overlay {
    display: block;
    pointer-events: none;
  }
</style>
