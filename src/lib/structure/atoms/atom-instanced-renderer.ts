/**
 * Three.js InstancedMesh renderer for an AtomManager (SoA atom store).
 *
 * Parallels `src/lib/structure/bonding/bond-instanced-renderer.ts` — per-
 * attribute sparse GPU uploads driven by the manager's per-attribute
 * dirty-slot sets.
 *
 * Contract:
 * - The caller owns the InstancedMesh, its geometry, and its material. This
 *   renderer only writes per-instance attributes (instancePosition,
 *   instanceRadius, instanceAtomColor, instanceOpacity, instanceSaturation)
 *   and never disposes those caller-owned objects.
 * - `sync()` is meant to be called from a Svelte `$effect` that tracks
 *   `atom_manager.version`. It performs the minimal GPU buffer rewrite for
 *   slots that changed since the last successful sync, coalescing dirty
 *   slots into contiguous `addUpdateRange` calls (Three.js r161+ API).
 * - `force_full_resync()` rewrites every live slot's attributes
 *   unconditionally. Used when the caller cannot rely on the manager's
 *   dirty tracking (e.g. after remount, when the `hidden_site_ids` prop
 *   changed — since that's not tracked by manager.version).
 * - Mesh capacity is fixed at construction. If `manager.count` exceeds the
 *   instanceMatrix capacity, `sync()` throws — caller is responsible for
 *   reconstructing the mesh at a larger capacity.
 *
 * This is explicitly a Phase X3 PoC renderer — same model as bond phase-3.
 * Documented gaps (see `AtomManagerInstances.svelte` for the enumerated
 * list) are deferred to X4–X6. The visibility model here is intentionally
 * simple: atoms in `hidden_site_ids` get opacity=0 and the fragment shader
 * discards on `vOpacity < epsilon`.
 *
 * Unlike AtomImpostors, this renderer does NOT use Three.js `instanceMatrix`
 * at all — positions are passed via the custom `instancePosition` attribute.
 * The shader must match (copied verbatim from AtomImpostors).
 *
 * X6 note: `sync()` calls `manager.clear_dirty()` unconditionally at the end.
 * If X6 splits into separate opaque/transparent renderers sharing ONE
 * AtomManager, the first to sync would blind the second. At that point the
 * dirty-state model must move from "manager owns + one renderer clears" to
 * per-renderer epoch counters (the manager holds the version; each renderer
 * remembers its last-seen per-attr version). Flagged here because it's easier
 * to design around up-front than to debug later.
 */

import * as THREE from 'three'
import type { AtomManager } from './atom-manager.svelte'

const EMPTY = new Int32Array(0)

/** Convert AtomManager's "logical" per-atom radius (matching
 *  `atom_data[i].radius` in StructureScene) to the GPU's per-instance
 *  billboard extent. Mirrors `AtomImpostors.svelte:403`
 *  (`visual_radius = atom.radius * 0.5`) so the new render path produces
 *  the same on-screen atom size as the legacy path. Without this scale,
 *  atoms render at exactly 2× their intended size. */
const VISUAL_RADIUS_SCALE = 0.5

/** Per-atom cutting-plane modulation (mirrors `CuttingVisibility` in
 *  `AtomImpostors.svelte`). Opacity and saturation are independent multipliers
 *  layered into the effective-opacity chain. Exported for callers that need
 *  to build the visibility map without duplicating the shape. */
export interface CuttingVisibilityEntry {
	inside: boolean
	opacity: number
	saturation: number
}

export class AtomInstancedRenderer {
	#mesh: THREE.InstancedMesh
	#manager: AtomManager
	#hidden_site_ids: ReadonlySet<number> | null

	// ─── X6b render-side modulations ───
	// These mirror AtomImpostors's `get_effective_opacity` +
	// `get_effective_saturation` chain (AtomImpostors.svelte:286-309). They are
	// NOT per-atom manager data — they are per-frame props that modulate the
	// final GPU-uploaded opacity/saturation. When any of them changes the caller
	// must call `force_full_resync()` (the manager doesn't know about them).
	#cutting_active = false
	#cutting_visibility_map: ReadonlyMap<number, CuttingVisibilityEntry> | null = null
	#num_original_sites: number | undefined = undefined
	#image_atom_opacity = 1
	#image_to_original_map: readonly number[] | undefined = undefined
	#atom_opacity_overrides: ReadonlyMap<number, number> | null = null

	// Per-attribute instanced buffers. Allocated at construction at mesh
	// capacity so we can write contiguous ranges via `addUpdateRange`.
	#position_attr: THREE.InstancedBufferAttribute
	#radius_attr: THREE.InstancedBufferAttribute
	#color_attr: THREE.InstancedBufferAttribute
	#opacity_attr: THREE.InstancedBufferAttribute
	#saturation_attr: THREE.InstancedBufferAttribute

	#last_synced_version = -1
	#last_synced_count = 0

	constructor(
		mesh: THREE.InstancedMesh,
		manager: AtomManager,
		hidden_site_ids: ReadonlySet<number> | null = null,
	) {
		this.#mesh = mesh
		this.#manager = manager
		this.#hidden_site_ids = hidden_site_ids

		const cap = mesh.instanceMatrix.count

		const pos_buf = new Float32Array(cap * 3)
		this.#position_attr = new THREE.InstancedBufferAttribute(pos_buf, 3, false)
		this.#position_attr.setUsage(THREE.DynamicDrawUsage)
		mesh.geometry.setAttribute('instancePosition', this.#position_attr)

		const rad_buf = new Float32Array(cap)
		this.#radius_attr = new THREE.InstancedBufferAttribute(rad_buf, 1, false)
		this.#radius_attr.setUsage(THREE.DynamicDrawUsage)
		mesh.geometry.setAttribute('instanceRadius', this.#radius_attr)

		const col_buf = new Float32Array(cap * 3)
		// Default to white so if an atom is ever drawn before colors are populated
		// it doesn't render as pure black.
		col_buf.fill(1)
		this.#color_attr = new THREE.InstancedBufferAttribute(col_buf, 3, false)
		this.#color_attr.setUsage(THREE.DynamicDrawUsage)
		mesh.geometry.setAttribute('instanceAtomColor', this.#color_attr)

		const op_buf = new Float32Array(cap)
		op_buf.fill(1)
		this.#opacity_attr = new THREE.InstancedBufferAttribute(op_buf, 1, false)
		this.#opacity_attr.setUsage(THREE.DynamicDrawUsage)
		mesh.geometry.setAttribute('instanceOpacity', this.#opacity_attr)

		const sat_buf = new Float32Array(cap)
		sat_buf.fill(1)
		this.#saturation_attr = new THREE.InstancedBufferAttribute(sat_buf, 1, false)
		this.#saturation_attr.setUsage(THREE.DynamicDrawUsage)
		mesh.geometry.setAttribute('instanceSaturation', this.#saturation_attr)
	}

	/** Update the visibility set. Renderer does NOT know when this changes —
	 *  caller must call `force_full_resync()` (or at minimum re-run sync for
	 *  the affected slots) after mutating it. */
	set_hidden_site_ids(hidden_site_ids: ReadonlySet<number> | null): void {
		this.#hidden_site_ids = hidden_site_ids
	}

	/** X6b: update the cutting-plane modulation. Caller must `force_full_resync()`
	 *  after changing this — it affects every atom's opacity/saturation, and
	 *  the manager's per-slot dirty tracking can't detect the change. */
	set_cutting(
		active: boolean,
		visibility_map: ReadonlyMap<number, CuttingVisibilityEntry> | null,
	): void {
		this.#cutting_active = active
		this.#cutting_visibility_map = visibility_map
	}

	/** X6b: update image-atom dimming. Image atoms are the tail of the manager
	 *  (slot site_id >= num_original_sites). Caller must `force_full_resync()`. */
	set_image_atoms(
		num_original_sites: number | undefined,
		image_atom_opacity: number,
		image_to_original_map: readonly number[] | undefined,
	): void {
		this.#num_original_sites = num_original_sites
		this.#image_atom_opacity = image_atom_opacity
		this.#image_to_original_map = image_to_original_map
	}

	/** X6b: update the per-site opacity overrides map (drives vibration mode +
	 *  user dim + polyhedra-hidden pass-through). Caller must
	 *  `force_full_resync()`. */
	set_atom_opacity_overrides(map: ReadonlyMap<number, number> | null): void {
		this.#atom_opacity_overrides = map
	}

	/**
	 * Compute the effective opacity for an atom at `site_id`. Mirrors
	 * `AtomImpostors.svelte:get_effective_opacity` (L286-301) exactly:
	 *
	 * 1. Start with `atom_opacity_overrides[site_id]` (default 1)
	 * 2. If opacity is still 1 AND this is an image atom, inherit from parent
	 *    via `image_to_original_map`
	 * 3. If image atom AND `image_atom_opacity < 1`: multiply by it
	 * 4. If cutting active: multiply by `cutting_visibility_map[site_id].opacity`
	 * 5. Hidden-site ids force 0 (takes precedence)
	 */
	#compute_effective_opacity(_slot: number, site_id: number, base_opacity: number): number {
		// Hidden-site ids always win.
		if (this.#hidden_site_ids !== null && this.#hidden_site_ids.has(site_id)) return 0

		const overrides = this.#atom_opacity_overrides
		const num_orig = this.#num_original_sites
		const image_map = this.#image_to_original_map
		const image_multiplier = this.#image_atom_opacity
		const is_image = num_orig !== undefined && site_id >= num_orig

		let opacity = overrides?.get(site_id) ?? 1
		// Image atoms inherit per-atom opacity from their original (only when
		// the image itself has no explicit override).
		if (opacity === 1 && is_image && image_map !== undefined) {
			const orig_idx = image_map[site_id - num_orig!]
			if (orig_idx !== undefined) opacity = overrides?.get(orig_idx) ?? 1
		}
		if (is_image && image_multiplier < 1) {
			opacity *= image_multiplier
		}
		if (this.#cutting_active && this.#cutting_visibility_map !== null && this.#cutting_visibility_map.size > 0) {
			const vis = this.#cutting_visibility_map.get(site_id)
			if (vis) opacity *= vis.opacity
		}
		// Fold in the manager's own opacity buffer value (same role as the
		// "base" in AtomImpostors — typically 1, but a future consumer could
		// set it directly on the manager).
		if (base_opacity !== 1) opacity *= base_opacity
		return opacity
	}

	/** Mirrors `AtomImpostors.svelte:get_effective_saturation` (L303-309). */
	#compute_effective_saturation(site_id: number, base_saturation: number): number {
		if (this.#cutting_active && this.#cutting_visibility_map !== null && this.#cutting_visibility_map.size > 0) {
			const vis = this.#cutting_visibility_map.get(site_id)
			if (vis) return vis.saturation
		}
		return base_saturation
	}

	/** Is any render-side modulation active that forces per-slot computation?
	 *  Used to decide between the fast path (manager dirty-set driven) and the
	 *  full rewrite path (every slot re-evaluated each sync). */
	#has_opacity_modulation(): boolean {
		return (
			(this.#hidden_site_ids !== null && this.#hidden_site_ids.size > 0) ||
			(this.#atom_opacity_overrides !== null && this.#atom_opacity_overrides.size > 0) ||
			(this.#cutting_active && this.#cutting_visibility_map !== null && this.#cutting_visibility_map.size > 0) ||
			(this.#num_original_sites !== undefined && this.#image_atom_opacity < 1)
		)
	}

	#has_saturation_modulation(): boolean {
		return (
			this.#cutting_active && this.#cutting_visibility_map !== null && this.#cutting_visibility_map.size > 0
		)
	}

	sync(): void {
		const manager = this.#manager
		if (manager.version === this.#last_synced_version) return

		const mesh = this.#mesh
		const capacity = mesh.instanceMatrix.count
		const count = manager.count

		if (count > capacity) {
			throw new Error(
				`AtomInstancedRenderer: manager.count (${count}) exceeds mesh capacity (${capacity}). Caller must reconstruct the mesh at a larger capacity.`,
			)
		}

		this.#position_attr.clearUpdateRanges()
		this.#radius_attr.clearUpdateRanges()
		this.#color_attr.clearUpdateRanges()
		this.#opacity_attr.clearUpdateRanges()
		this.#saturation_attr.clearUpdateRanges()

		const positions = manager.positions_buffer
		const radii = manager.radii_buffer
		const colors = manager.colors_buffer
		const opacities = manager.opacities_buffer
		const saturations = manager.saturations_buffer
		const site_ids = manager.site_ids_buffer

		// Was this a full-count transition (grew or shrank)? If so every "new"
		// slot is implicitly dirty; force an attribute-wide rewrite for ranges.
		// We fold the `gap` into the dirty-slot coalescing per attribute.
		const gap_start = this.#last_synced_count
		const gap_end = count
		const gap_size = Math.max(0, gap_end - gap_start)

		// ── Positions ──
		this.#sync_attr_vec3(
			manager.dirty_all_positions,
			manager.dirty_positions,
			gap_start,
			gap_end,
			gap_size,
			count,
			positions,
			this.#position_attr,
		)

		// ── Radii ──
		// Apply VISUAL_RADIUS_SCALE so the GPU instance radius matches the
		// halved value AtomImpostors writes at L403 (otherwise atoms render
		// at exactly 2× their intended size).
		this.#sync_attr_float(
			manager.dirty_all_radii,
			manager.dirty_radii,
			gap_start,
			gap_end,
			gap_size,
			count,
			radii,
			this.#radius_attr,
			VISUAL_RADIUS_SCALE,
		)

		// ── Colors ──
		// If the manager hasn't allocated colors yet, leave the default white
		// fill. The X2 shadow sync always populates colors so this branch is
		// defensive — see the PoC gap list.
		if (colors !== null) {
			this.#sync_attr_vec3(
				manager.dirty_all_colors,
				manager.dirty_colors,
				gap_start,
				gap_end,
				gap_size,
				count,
				colors,
				this.#color_attr,
			)
		}

		// ── Opacities ──
		// Opacity is the combination of:
		//   - manager's own opacity buffer (if any, usually 1)
		//   - hidden_site_ids (forces 0)
		//   - atom_opacity_overrides (vibration mode, polyhedra-hidden, user dim, clip, isolation)
		//   - image_atom_opacity multiplier for image atoms
		//   - cutting_visibility_map modulation
		//
		// When any modulation is active we can't cheaply know which slots
		// changed membership, so we rewrite every live slot (1 float each —
		// same cost as a full draw-call attribute upload).
		const has_op_mod = this.#has_opacity_modulation()
		if (has_op_mod) {
			// Rewrite all live slots' opacity. Cheap (1 float per atom).
			this.#sync_attr_float_computed(count, this.#opacity_attr, (slot) => {
				const base = opacities !== null ? opacities[slot] : 1
				return this.#compute_effective_opacity(slot, site_ids[slot], base)
			})
		} else if (opacities !== null) {
			this.#sync_attr_float(
				manager.dirty_all_opacities,
				manager.dirty_opacities,
				gap_start,
				gap_end,
				gap_size,
				count,
				opacities,
				this.#opacity_attr,
			)
		} else {
			// Manager has no opacity buffer and no modulation active — the
			// default buffer fill (1.0) is already correct. But we still need
			// to write 1.0 into any newly-live slots (swap-and-pop into a
			// previously-stale slot would not normally touch opacity_attr).
			if (gap_size > 0) {
				const buf = this.#opacity_attr.array as Float32Array
				for (let slot = gap_start; slot < gap_end; slot++) buf[slot] = 1
				this.#opacity_attr.addUpdateRange(gap_start, gap_size)
			}
		}

		// ── Saturations ──
		const has_sat_mod = this.#has_saturation_modulation()
		if (has_sat_mod) {
			// Cutting desaturation is per-site — rewrite all live slots.
			this.#sync_attr_float_computed(count, this.#saturation_attr, (slot) => {
				const base = saturations !== null ? saturations[slot] : 1
				return this.#compute_effective_saturation(site_ids[slot], base)
			})
		} else if (saturations !== null) {
			this.#sync_attr_float(
				manager.dirty_all_saturations,
				manager.dirty_saturations,
				gap_start,
				gap_end,
				gap_size,
				count,
				saturations,
				this.#saturation_attr,
			)
		} else if (gap_size > 0) {
			const buf = this.#saturation_attr.array as Float32Array
			for (let slot = gap_start; slot < gap_end; slot++) buf[slot] = 1
			this.#saturation_attr.addUpdateRange(gap_start, gap_size)
		}

		mesh.count = count
		this.#position_attr.needsUpdate = true
		this.#radius_attr.needsUpdate = true
		this.#color_attr.needsUpdate = true
		this.#opacity_attr.needsUpdate = true
		this.#saturation_attr.needsUpdate = true

		manager.clear_dirty()
		this.#last_synced_version = manager.version
		this.#last_synced_count = count
	}

	force_full_resync(): void {
		const manager = this.#manager
		const mesh = this.#mesh
		const capacity = mesh.instanceMatrix.count
		const count = manager.count

		if (count > capacity) {
			throw new Error(
				`AtomInstancedRenderer: manager.count (${count}) exceeds mesh capacity (${capacity}). Caller must reconstruct the mesh at a larger capacity.`,
			)
		}

		this.#position_attr.clearUpdateRanges()
		this.#radius_attr.clearUpdateRanges()
		this.#color_attr.clearUpdateRanges()
		this.#opacity_attr.clearUpdateRanges()
		this.#saturation_attr.clearUpdateRanges()

		if (count > 0) {
			const positions = manager.positions_buffer
			const radii = manager.radii_buffer
			const colors = manager.colors_buffer
			const opacities = manager.opacities_buffer
			const saturations = manager.saturations_buffer
			const site_ids = manager.site_ids_buffer

			const pos_buf = this.#position_attr.array as Float32Array
			const rad_buf = this.#radius_attr.array as Float32Array
			const col_buf = this.#color_attr.array as Float32Array
			const op_buf = this.#opacity_attr.array as Float32Array
			const sat_buf = this.#saturation_attr.array as Float32Array

			for (let slot = 0; slot < count; slot++) {
				const i3 = slot * 3
				pos_buf[i3] = positions[i3]
				pos_buf[i3 + 1] = positions[i3 + 1]
				pos_buf[i3 + 2] = positions[i3 + 2]
				// Apply VISUAL_RADIUS_SCALE — see same comment on the sync()
				// path above.
				rad_buf[slot] = radii[slot] * VISUAL_RADIUS_SCALE
				if (colors !== null) {
					col_buf[i3] = colors[i3]
					col_buf[i3 + 1] = colors[i3 + 1]
					col_buf[i3 + 2] = colors[i3 + 2]
				}
				const sid = site_ids[slot]
				const base_op = opacities !== null ? opacities[slot] : 1
				op_buf[slot] = this.#compute_effective_opacity(slot, sid, base_op)
				const base_sat = saturations !== null ? saturations[slot] : 1
				sat_buf[slot] = this.#compute_effective_saturation(sid, base_sat)
			}

			this.#position_attr.addUpdateRange(0, count * 3)
			this.#radius_attr.addUpdateRange(0, count)
			this.#color_attr.addUpdateRange(0, count * 3)
			this.#opacity_attr.addUpdateRange(0, count)
			this.#saturation_attr.addUpdateRange(0, count)
		}

		mesh.count = count
		this.#position_attr.needsUpdate = true
		this.#radius_attr.needsUpdate = true
		this.#color_attr.needsUpdate = true
		this.#opacity_attr.needsUpdate = true
		this.#saturation_attr.needsUpdate = true

		manager.clear_dirty()
		this.#last_synced_version = manager.version
		this.#last_synced_count = count
	}

	dispose(): void {
		const geom = this.#mesh.geometry
		geom.deleteAttribute('instancePosition')
		geom.deleteAttribute('instanceRadius')
		geom.deleteAttribute('instanceAtomColor')
		geom.deleteAttribute('instanceOpacity')
		geom.deleteAttribute('instanceSaturation')
	}

	// ─── Attribute sync helpers ───

	#sync_attr_vec3(
		dirty_all: boolean,
		dirty: ReadonlySet<number>,
		gap_start: number,
		gap_end: number,
		gap_size: number,
		count: number,
		src: Float32Array,
		attr: THREE.InstancedBufferAttribute,
	): void {
		const buf = attr.array as Float32Array
		if (dirty_all || this.#should_rewrite_whole(dirty.size + gap_size, count)) {
			if (count > 0) {
				// Rewrite entire live range.
				for (let slot = 0; slot < count; slot++) {
					const i3 = slot * 3
					buf[i3] = src[i3]
					buf[i3 + 1] = src[i3 + 1]
					buf[i3 + 2] = src[i3 + 2]
				}
				attr.addUpdateRange(0, count * 3)
			}
			return
		}
		const slots = this.#coalesce_slots(dirty, gap_start, gap_end, count)
		if (slots.length === 0) return
		let i = 0
		while (i < slots.length) {
			const run_start = slots[i]
			let run_end = run_start
			let j = i + 1
			while (j < slots.length && slots[j] === run_end + 1) {
				run_end = slots[j]
				j++
			}
			for (let slot = run_start; slot <= run_end; slot++) {
				const i3 = slot * 3
				buf[i3] = src[i3]
				buf[i3 + 1] = src[i3 + 1]
				buf[i3 + 2] = src[i3 + 2]
			}
			const len = run_end - run_start + 1
			attr.addUpdateRange(run_start * 3, len * 3)
			i = j
		}
	}

	#sync_attr_float(
		dirty_all: boolean,
		dirty: ReadonlySet<number>,
		gap_start: number,
		gap_end: number,
		gap_size: number,
		count: number,
		src: Float32Array,
		attr: THREE.InstancedBufferAttribute,
		// Optional GPU-upload scale. The radius write passes
		// VISUAL_RADIUS_SCALE so AtomManager can keep storing logical
		// (atom_data-equivalent) radii while the GPU sees the same
		// halved value AtomImpostors writes at L403. Other attributes
		// pass 1 (default) and incur no per-element multiply.
		scale: number = 1,
	): void {
		const buf = attr.array as Float32Array
		if (dirty_all || this.#should_rewrite_whole(dirty.size + gap_size, count)) {
			if (count > 0) {
				if (scale === 1) {
					for (let slot = 0; slot < count; slot++) buf[slot] = src[slot]
				} else {
					for (let slot = 0; slot < count; slot++) buf[slot] = src[slot] * scale
				}
				attr.addUpdateRange(0, count)
			}
			return
		}
		const slots = this.#coalesce_slots(dirty, gap_start, gap_end, count)
		if (slots.length === 0) return
		let i = 0
		while (i < slots.length) {
			const run_start = slots[i]
			let run_end = run_start
			let j = i + 1
			while (j < slots.length && slots[j] === run_end + 1) {
				run_end = slots[j]
				j++
			}
			if (scale === 1) {
				for (let slot = run_start; slot <= run_end; slot++) buf[slot] = src[slot]
			} else {
				for (let slot = run_start; slot <= run_end; slot++) buf[slot] = src[slot] * scale
			}
			const len = run_end - run_start + 1
			attr.addUpdateRange(run_start, len)
			i = j
		}
	}

	/** Rewrite a float attribute for all live slots using a supplied per-slot
	 *  function. Used for the opacity attribute when the visibility mask is
	 *  non-empty — we can't cheaply know which slots changed membership so we
	 *  rewrite all of them. */
	#sync_attr_float_computed(
		count: number,
		attr: THREE.InstancedBufferAttribute,
		compute: (slot: number) => number,
	): void {
		if (count === 0) return
		const buf = attr.array as Float32Array
		for (let slot = 0; slot < count; slot++) buf[slot] = compute(slot)
		attr.addUpdateRange(0, count)
	}

	/** Bond-renderer mirror: if dirty count >= 1/4 of capacity, rewrite in
	 *  one shot (cheaper than many small `addUpdateRange` calls). */
	#should_rewrite_whole(dirty_total: number, count: number): boolean {
		if (count === 0) return false
		const capacity = this.#mesh.instanceMatrix.count
		return dirty_total >= Math.max(1, capacity >> 2)
	}

	#coalesce_slots(
		dirty: ReadonlySet<number>,
		gap_start: number,
		gap_end: number,
		count: number,
	): Int32Array {
		if (dirty.size === 0 && gap_start >= gap_end) return EMPTY

		const seen = new Set<number>()
		for (const s of dirty) {
			if (s >= 0 && s < count) seen.add(s)
		}
		for (let s = gap_start; s < gap_end; s++) {
			if (s >= 0 && s < count) seen.add(s)
		}
		if (seen.size === 0) return EMPTY
		const out = new Int32Array(seen.size)
		let idx = 0
		for (const s of seen) out[idx++] = s
		out.sort()
		return out
	}
}
