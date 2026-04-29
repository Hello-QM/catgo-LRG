/**
 * Three.js InstancedMesh renderer for a BondManager (SoA bond store).
 *
 * Half-bond model (Phase 4 of the PBC half-bond refactor):
 *   Each logical bond at slot `S` produces TWO instances on the mesh —
 *   one half-cylinder per atom. The instances live at mesh indices
 *   `2*S` (half A, anchored at atom A) and `2*S + 1` (half B, anchored
 *   at atom B's effective position `b_eff = pos_b + lattice·jimage`).
 *   Both halves meet at the geometric midpoint of the (a, b_eff) line.
 *
 *   - Intra-cell bonds (jimage = [0,0,0]) collapse to two halves meeting
 *     at the geometric midpoint of the (a, b) segment — visually identical
 *     to the pre-refactor whole-cylinder.
 *   - Cross-cell bonds (jimage != [0,0,0]) appear as paired stubs at the
 *     cell boundary, anchored to the original cell's atoms.
 *   - Each half is colored solid with its anchor atom's color (start ==
 *     end in the gradient), producing the hard mid-point color step that
 *     matches crystaltoolkit / VESTA / MP visual conventions.
 *
 * Contract:
 * - The caller owns the InstancedMesh, its geometry, and its material. This
 *   renderer only writes per-instance data (matrix + `bond_kind` attribute
 *   + per-half color and opacity) and never disposes those caller-owned
 *   objects.
 * - `sync()` is meant to be called from a Svelte `$effect` that tracks
 *   `bond_manager.version`. It performs the minimal GPU buffer rewrite for
 *   slots that changed since the last successful sync, coalescing dirty
 *   slots into contiguous `addUpdateRange` calls (Three.js r161+ API).
 *   Each dirty bond slot S maps to two consecutive instance indices
 *   (2S, 2S+1), so a contiguous slot run [s0..s1] writes a contiguous
 *   instance range [2s0..2s1+1].
 * - `force_full_resync()` rewrites every live slot unconditionally. Use it
 *   when atom positions or the lattice change — every bond's transform
 *   depends on two atom positions and (for cross-cell bonds) the lattice
 *   matrix, so the entire matrix buffer is invalid even though the bond
 *   topology hasn't changed.
 * - Mesh capacity is fixed at construction. If `2 * manager.count` exceeds
 *   the instanceMatrix capacity, `sync()` throws — caller is responsible
 *   for reconstructing the mesh at a larger capacity.
 *
 * The renderer installs an `InstancedBufferAttribute` named `bond_kind`
 * (Uint8, 1 item per instance, DynamicDrawUsage) on the mesh geometry so
 * custom shaders can dispatch on bond kind (dashed HBOND, etc.). Both
 * halves of a logical bond share the same kind byte — selection state and
 * hover decoration are slot-level, not half-level.
 */

import * as THREE from 'three';
import type { BondManager } from './bond-manager.svelte';
import type { ImageAtomLayout } from './image-atom-layout';

const UP_Y = new THREE.Vector3(0, 1, 0);
const EMPTY = new Int32Array(0);
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Incomplete-edge stub mode (Phase 6 / VESTA Mode 1). When `mode` is true,
 * cross-cell bonds (jimage ≠ 0) emit only Half A scaled by `scale`; Half
 * B is collapsed to a zero-scale matrix so it occupies an instance slot
 * but renders no visible geometry.
 */
export type IncompleteEdgeOpts = { mode: boolean; scale: number };

/**
 * Phase 7d partner-drawn predicate: given the partner atom's pre-ghost
 * site index and its full image-atom-space jimage (entry's `jimage_img`
 * combined with the bond's own jimage, sign-adjusted for which end is the
 * anchor), return `true` iff `(idx, jimage)` is in the caller's
 * `sites_to_draw` set. A `null` accessor means "treat every partner as
 * drawn" — Phase 7c default, decorator pass renders full bonds always.
 */
export type PartnerDrawnLookup = (
	idx: number,
	jx: number,
	jy: number,
	jz: number,
) => boolean;

export class BondInstancedRenderer {
	#mesh: THREE.InstancedMesh;
	#manager: BondManager;
	#get_positions: () => Float32Array;
	/**
	 * Returns the current lattice as a 3×3 row-major Float64Array of length 9.
	 * Rows are lattice vectors a, b, c — matches pymatgen `lattice.matrix`
	 * convention: `a = (matrix[0], matrix[1], matrix[2])`, etc. Returns null
	 * for non-periodic structures (molecules); in that case `jimage` MUST be
	 * `[0, 0, 0]` for every bond — the renderer asserts this in DEV.
	 */
	#get_lattice: (() => Float64Array | null) | null;
	#get_incomplete_edge: (() => IncompleteEdgeOpts) | null;
	/**
	 * Phase 7 image-atom decorator layout. Each non-home image atom in the
	 * layout contributes `2 × n_incident_bonds` instances, written *after*
	 * the cell-internal half-bond range. `null` (or a layout with
	 * `n_image_atoms === 0`) suppresses the decorator pass entirely.
	 */
	#get_image_atom_layout: (() => ImageAtomLayout | null) | null;
	/**
	 * Phase 7d partner-drawn predicate. When `null`, decorator instances
	 * always render as full bonds (Phase 7c default). When non-null and
	 * the predicate returns `false` for a decorator's partner, the
	 * decorator emits an incomplete-edge stub on the anchor side and
	 * collapses the partner-side instance to a zero-scale matrix.
	 */
	#get_partner_drawn: (() => PartnerDrawnLookup | null) | null;

	#kind_buf: Uint8Array;
	#kind_attr: THREE.InstancedBufferAttribute;

	#color_start_attr: THREE.InstancedBufferAttribute | null = null;
	#color_end_attr: THREE.InstancedBufferAttribute | null = null;

	#opacity_attr: THREE.InstancedBufferAttribute | null = null;

	#last_synced_version = -1;
	#last_synced_count = 0;

	#tmp_matrix = new THREE.Matrix4();
	#v_mid = new THREE.Vector3();
	#v_dir = new THREE.Vector3();
	#v_half_mid_a = new THREE.Vector3();
	#v_half_mid_b = new THREE.Vector3();
	#q_rot = new THREE.Quaternion();
	#v_scale = new THREE.Vector3();

	constructor(
		mesh: THREE.InstancedMesh,
		manager: BondManager,
		get_positions: () => Float32Array,
		get_lattice?: (() => Float64Array | null) | null,
		get_incomplete_edge?: (() => IncompleteEdgeOpts) | null,
		get_image_atom_layout?: (() => ImageAtomLayout | null) | null,
		get_partner_drawn?: (() => PartnerDrawnLookup | null) | null,
	) {
		this.#mesh = mesh;
		this.#manager = manager;
		this.#get_positions = get_positions;
		this.#get_lattice = get_lattice ?? null;
		this.#get_incomplete_edge = get_incomplete_edge ?? null;
		this.#get_image_atom_layout = get_image_atom_layout ?? null;
		this.#get_partner_drawn = get_partner_drawn ?? null;

		const cap = mesh.instanceMatrix.count;
		this.#kind_buf = new Uint8Array(cap);
		const attr = new THREE.InstancedBufferAttribute(this.#kind_buf, 1, false);
		attr.setUsage(THREE.DynamicDrawUsage);
		this.#kind_attr = attr;
		mesh.geometry.setAttribute('bond_kind', attr);
	}

	sync(): void {
		const manager = this.#manager;
		if (manager.version === this.#last_synced_version) return;

		this.#ensure_color_attrs();
		this.#ensure_opacity_attr();

		const mesh = this.#mesh;
		const matrix_attr = mesh.instanceMatrix;
		const capacity = matrix_attr.count;
		const count = manager.count;
		const instance_count = count * 2;
		const layout = this.#get_image_atom_layout ? this.#get_image_atom_layout() : null;
		const decorator_instance_count = layout !== null ? layout.bonds_csr.length * 2 : 0;
		const total_instances = instance_count + decorator_instance_count;

		if (total_instances > capacity) {
			throw new Error(
				`BondInstancedRenderer: instance count (${total_instances} = ${instance_count} cell-internal + ${decorator_instance_count} decorator) exceeds mesh capacity (${capacity}). Caller must reconstruct the mesh at a larger capacity.`,
			);
		}

		matrix_attr.clearUpdateRanges();
		this.#kind_attr.clearUpdateRanges();
		this.#color_start_attr?.clearUpdateRanges();
		this.#color_end_attr?.clearUpdateRanges();
		this.#opacity_attr?.clearUpdateRanges();

		// Hoist buffer refs once per sync — avoid per-slot getter + closure overhead.
		const pairs = manager.pairs_buffer;
		const kinds = manager.kinds_buffer;
		const jimages = manager.jimages_buffer;
		const positions = this.#get_positions();
		const colors_start = manager.colors_start_buffer;
		const colors_end = manager.colors_end_buffer;
		const opacity = manager.opacity_buffer;
		const lattice = this.#get_lattice ? this.#get_lattice() : null;
		const stub = this.#get_incomplete_edge ? this.#get_incomplete_edge() : null;

		if (manager.dirty_all) {
			if (count > 0) {
				for (let slot = 0; slot < count; slot++) {
					this.#write_slot(slot, pairs, kinds, jimages, positions, lattice, stub, colors_start, colors_end, opacity);
				}
				matrix_attr.addUpdateRange(0, instance_count * 16);
				this.#kind_attr.addUpdateRange(0, instance_count);
				this.#color_start_attr?.addUpdateRange(0, instance_count * 3);
				this.#color_end_attr?.addUpdateRange(0, instance_count * 3);
				this.#opacity_attr?.addUpdateRange(0, instance_count);
			}
		} else {
			const slots = this.#collect_dirty_slots(count);
			if (slots.length > 0) {
				let i = 0;
				while (i < slots.length) {
					const run_start = slots[i];
					let run_end = run_start;
					let j = i + 1;
					while (j < slots.length && slots[j] === run_end + 1) {
						run_end = slots[j];
						j++;
					}
					for (let slot = run_start; slot <= run_end; slot++) {
						this.#write_slot(slot, pairs, kinds, jimages, positions, lattice, stub, colors_start, colors_end, opacity);
					}
					const slot_len = run_end - run_start + 1;
					const inst_start = run_start * 2;
					const inst_len = slot_len * 2;
					matrix_attr.addUpdateRange(inst_start * 16, inst_len * 16);
					this.#kind_attr.addUpdateRange(inst_start, inst_len);
					this.#color_start_attr?.addUpdateRange(inst_start * 3, inst_len * 3);
					this.#color_end_attr?.addUpdateRange(inst_start * 3, inst_len * 3);
					this.#opacity_attr?.addUpdateRange(inst_start, inst_len);
					i = j;
				}
			}
		}

		// Phase 7 — image-atom decorator pass. Always rewrites the entire
		// decorator range; total instance count is bounded by `sites_to_draw`
		// × bond density (typically <1k), and most invalidations require a
		// full rewrite anyway. Layout reference changes go through
		// `force_full_resync` (BondManagerInstances.svelte $effect) so this
		// fast path can stay topology-free.
		this.#write_decorators(
			layout, instance_count, decorator_instance_count, matrix_attr,
			pairs, kinds, jimages, positions, lattice, stub,
			colors_start, colors_end, opacity,
		);

		mesh.count = total_instances;
		matrix_attr.needsUpdate = true;
		this.#kind_attr.needsUpdate = true;
		if (this.#color_start_attr !== null) this.#color_start_attr.needsUpdate = true;
		if (this.#color_end_attr !== null) this.#color_end_attr.needsUpdate = true;
		if (this.#opacity_attr !== null) this.#opacity_attr.needsUpdate = true;

		manager.clear_dirty();
		this.#last_synced_version = manager.version;
		this.#last_synced_count = count;
	}

	force_full_resync(): void {
		const manager = this.#manager;

		this.#ensure_color_attrs();
		this.#ensure_opacity_attr();

		const mesh = this.#mesh;
		const matrix_attr = mesh.instanceMatrix;
		const capacity = matrix_attr.count;
		const count = manager.count;
		const instance_count = count * 2;
		const layout = this.#get_image_atom_layout ? this.#get_image_atom_layout() : null;
		const decorator_instance_count = layout !== null ? layout.bonds_csr.length * 2 : 0;
		const total_instances = instance_count + decorator_instance_count;

		if (total_instances > capacity) {
			throw new Error(
				`BondInstancedRenderer: instance count (${total_instances} = ${instance_count} cell-internal + ${decorator_instance_count} decorator) exceeds mesh capacity (${capacity}). Caller must reconstruct the mesh at a larger capacity.`,
			);
		}

		matrix_attr.clearUpdateRanges();
		this.#kind_attr.clearUpdateRanges();
		this.#color_start_attr?.clearUpdateRanges();
		this.#color_end_attr?.clearUpdateRanges();
		this.#opacity_attr?.clearUpdateRanges();

		const pairs = manager.pairs_buffer;
		const kinds = manager.kinds_buffer;
		const jimages = manager.jimages_buffer;
		const positions = this.#get_positions();
		const colors_start = manager.colors_start_buffer;
		const colors_end = manager.colors_end_buffer;
		const opacity = manager.opacity_buffer;
		const lattice = this.#get_lattice ? this.#get_lattice() : null;
		const stub = this.#get_incomplete_edge ? this.#get_incomplete_edge() : null;

		if (count > 0) {
			for (let slot = 0; slot < count; slot++) {
				this.#write_slot(slot, pairs, kinds, jimages, positions, lattice, stub, colors_start, colors_end, opacity);
			}
			matrix_attr.addUpdateRange(0, instance_count * 16);
			this.#kind_attr.addUpdateRange(0, instance_count);
			this.#color_start_attr?.addUpdateRange(0, instance_count * 3);
			this.#color_end_attr?.addUpdateRange(0, instance_count * 3);
			this.#opacity_attr?.addUpdateRange(0, instance_count);
		}

		this.#write_decorators(
			layout, instance_count, decorator_instance_count, matrix_attr,
			pairs, kinds, jimages, positions, lattice, stub,
			colors_start, colors_end, opacity,
		);

		mesh.count = total_instances;
		matrix_attr.needsUpdate = true;
		this.#kind_attr.needsUpdate = true;
		if (this.#color_start_attr !== null) this.#color_start_attr.needsUpdate = true;
		if (this.#color_end_attr !== null) this.#color_end_attr.needsUpdate = true;
		if (this.#opacity_attr !== null) this.#opacity_attr.needsUpdate = true;

		manager.clear_dirty();
		this.#last_synced_version = -1;
		this.#last_synced_count = 0;
	}

	dispose(): void {
		this.#mesh.geometry.deleteAttribute('bond_kind');
		if (this.#color_start_attr !== null) this.#mesh.geometry.deleteAttribute('instance_color_start');
		if (this.#color_end_attr !== null) this.#mesh.geometry.deleteAttribute('instance_color_end');
		if (this.#opacity_attr !== null) this.#mesh.geometry.deleteAttribute('instance_opacity');
	}

	#ensure_color_attrs(): void {
		if (this.#color_start_attr !== null) return;
		if (!this.#manager.has_colors) return;
		const cap = this.#mesh.instanceMatrix.count;

		const start_buf = new Float32Array(cap * 3);
		const start_attr = new THREE.InstancedBufferAttribute(start_buf, 3, false);
		start_attr.setUsage(THREE.DynamicDrawUsage);
		this.#color_start_attr = start_attr;
		this.#mesh.geometry.setAttribute('instance_color_start', start_attr);

		const end_buf = new Float32Array(cap * 3);
		const end_attr = new THREE.InstancedBufferAttribute(end_buf, 3, false);
		end_attr.setUsage(THREE.DynamicDrawUsage);
		this.#color_end_attr = end_attr;
		this.#mesh.geometry.setAttribute('instance_color_end', end_attr);
	}

	#ensure_opacity_attr(): void {
		if (this.#opacity_attr !== null) return;
		if (!this.#manager.has_opacity) return;
		const cap = this.#mesh.instanceMatrix.count;
		const buf = new Float32Array(cap);
		buf.fill(1);
		const attr = new THREE.InstancedBufferAttribute(buf, 1, false);
		attr.setUsage(THREE.DynamicDrawUsage);
		this.#opacity_attr = attr;
		this.#mesh.geometry.setAttribute('instance_opacity', attr);
	}

	#collect_dirty_slots(count: number): Int32Array {
		const manager = this.#manager;
		const dirty = manager.dirty_slots;
		const gap_start = this.#last_synced_count;
		const gap_end = count; // exclusive
		const gap_size = Math.max(0, gap_end - gap_start);

		if (dirty.size === 0 && gap_size === 0) return EMPTY;

		const seen = new Set<number>();
		for (const s of dirty) {
			if (s >= 0 && s < count) seen.add(s);
		}
		for (let s = gap_start; s < gap_end; s++) {
			if (s >= 0 && s < count) seen.add(s);
		}

		if (seen.size === 0) return EMPTY;

		const out = new Int32Array(seen.size);
		let idx = 0;
		for (const s of seen) out[idx++] = s;
		out.sort();
		return out;
	}

	#write_slot(
		slot: number,
		pairs: Uint32Array,
		kinds: Uint8Array,
		jimages: Int8Array,
		positions: Float32Array,
		lattice: Float64Array | null,
		stub: IncompleteEdgeOpts | null,
		colors_start: Float32Array | null,
		colors_end: Float32Array | null,
		opacity: Float32Array | null,
	): void {
		const a = pairs[slot * 2];
		const b = pairs[slot * 2 + 1];

		const ax = positions[a * 3];
		const ay = positions[a * 3 + 1];
		const az = positions[a * 3 + 2];
		const bx_base = positions[b * 3];
		const by_base = positions[b * 3 + 1];
		const bz_base = positions[b * 3 + 2];

		const ji = slot * 3;
		const dx = jimages[ji];
		const dy = jimages[ji + 1];
		const dz = jimages[ji + 2];

		// b_eff = pos_b + dx·a_vec + dy·b_vec + dz·c_vec where (a_vec, b_vec, c_vec)
		// are the rows of the lattice matrix (pymatgen convention). Matches Rust
		// pbc.rs:132 displacement convention exactly.
		let bx = bx_base;
		let by = by_base;
		let bz = bz_base;
		if ((dx | dy | dz) !== 0) {
			if (lattice === null) {
				if (import.meta.env?.DEV) {
					console.warn(
						`[BondInstancedRenderer] Bond ${a}↔${b} has non-zero jimage [${dx}, ${dy}, ${dz}] but no lattice matrix is available — falling back to base position. This usually indicates a bond was detected with PBC enabled on a structure that lost its lattice between detection and render.`,
					);
				}
			} else {
				bx += dx * lattice[0] + dy * lattice[3] + dz * lattice[6];
				by += dx * lattice[1] + dy * lattice[4] + dz * lattice[7];
				bz += dx * lattice[2] + dy * lattice[5] + dz * lattice[8];
			}
		}

		// Geometric midpoint of the (a, b_eff) segment.
		const mx = (ax + bx) * 0.5;
		const my = (ay + by) * 0.5;
		const mz = (az + bz) * 0.5;

		// Direction and length of the FULL bond (a → b_eff). Both halves share
		// rotation; the cylinder geometry is symmetric around its axis.
		const fx = bx - ax;
		const fy = by - ay;
		const fz = bz - az;
		const length_sq = fx * fx + fy * fy + fz * fz;
		const length = Math.sqrt(length_sq);
		const half_length = length * 0.5;

		if (length < 1e-8) {
			this.#v_dir.set(0, 1, 0);
		} else {
			const inv = 1 / length;
			this.#v_dir.set(fx * inv, fy * inv, fz * inv);
		}
		this.#q_rot.setFromUnitVectors(UP_Y, this.#v_dir);

		const is_periodic = (dx | dy | dz) !== 0;
		const stub_active = stub !== null && stub.mode && is_periodic;

		if (is_periodic) {
			// Cross-cell bond: render TWO independent stubs, one at each
			// atom's CELL-INTERNAL position. Each stub points toward the
			// cell boundary along the bond direction.
			//   Half A stub: anchored at pos_a, length = half_length·scale,
			//                pointing +v_dir (toward b_eff outside cell).
			//   Half B stub: anchored at pos_b (the BASE position, NOT b_eff),
			//                length = half_length·scale, pointing -v_dir
			//                (toward a_eff_inverse = pos_a + lattice·-jimage,
			//                outside the opposite cell boundary). v_dir is the
			//                a→b_eff direction; pos_b's stub goes opposite
			//                because pos_b's nearest A-image is in the -jimage
			//                direction relative to pos_b.
			// In Phase 6 stub mode, scale is `stub.scale` (default 0.5);
			// otherwise full half_length so paired stubs meet visually at
			// the cell edge for a continuous "broken bond" appearance.
			const stub_scale = stub_active ? stub.scale : 1.0;
			const stub_len = half_length * stub_scale;
			this.#v_scale.set(1, stub_len, 1);
			const half_stub = stub_len * 0.5;

			// Half A stub
			this.#v_half_mid_a.set(
				ax + this.#v_dir.x * half_stub,
				ay + this.#v_dir.y * half_stub,
				az + this.#v_dir.z * half_stub,
			);
			this.#tmp_matrix.compose(this.#v_half_mid_a, this.#q_rot, this.#v_scale);
			this.#mesh.setMatrixAt(slot * 2, this.#tmp_matrix);

			// Half B stub anchored at the BASE pos_b (cell-internal), pointing
			// in the -v_dir direction (toward atom A's image across the
			// opposite cell boundary).
			this.#v_half_mid_b.set(
				bx_base - this.#v_dir.x * half_stub,
				by_base - this.#v_dir.y * half_stub,
				bz_base - this.#v_dir.z * half_stub,
			);
			this.#tmp_matrix.compose(this.#v_half_mid_b, this.#q_rot, this.#v_scale);
			this.#mesh.setMatrixAt(slot * 2 + 1, this.#tmp_matrix);
		} else {
			// Intra-cell bond: classic two-half cylinder meeting at midpoint.
			this.#v_scale.set(1, half_length, 1);

			this.#v_half_mid_a.set(
				(ax + mx) * 0.5,
				(ay + my) * 0.5,
				(az + mz) * 0.5,
			);
			this.#tmp_matrix.compose(this.#v_half_mid_a, this.#q_rot, this.#v_scale);
			this.#mesh.setMatrixAt(slot * 2, this.#tmp_matrix);

			this.#v_half_mid_b.set(
				(mx + bx) * 0.5,
				(my + by) * 0.5,
				(mz + bz) * 0.5,
			);
			this.#tmp_matrix.compose(this.#v_half_mid_b, this.#q_rot, this.#v_scale);
			this.#mesh.setMatrixAt(slot * 2 + 1, this.#tmp_matrix);
		}

		// Both halves share the kind byte (selection state, dashed HBOND, etc).
		const kind = kinds[slot];
		this.#kind_buf[slot * 2] = kind;
		this.#kind_buf[slot * 2 + 1] = kind;

		// Per-half solid color: Half A = atom A's color (= colors_start[slot]),
		// Half B = atom B's color (= colors_end[slot]). Both endpoints of each
		// half are set to the same color, so the gradient shader's
		// `mix(vColorStart, vColorEnd, vYPosition + 0.5)` renders solid. The
		// hard color step at the midpoint between the two halves matches
		// crystaltoolkit / VESTA / MP convention — do not blend across halves.
		if (colors_start !== null && this.#color_start_attr !== null) {
			const cb_start = this.#color_start_attr.array as Float32Array;
			const cb_end = this.#color_end_attr!.array as Float32Array;
			const src = slot * 3;
			const dst_a = (slot * 2) * 3;
			const dst_b = (slot * 2 + 1) * 3;

			const ar = colors_start[src];
			const ag = colors_start[src + 1];
			const ab = colors_start[src + 2];
			const br = colors_end![src];
			const bg = colors_end![src + 1];
			const bb = colors_end![src + 2];

			cb_start[dst_a]     = ar; cb_start[dst_a + 1] = ag; cb_start[dst_a + 2] = ab;
			cb_end[dst_a]       = ar; cb_end[dst_a + 1]   = ag; cb_end[dst_a + 2]   = ab;
			cb_start[dst_b]     = br; cb_start[dst_b + 1] = bg; cb_start[dst_b + 2] = bb;
			cb_end[dst_b]       = br; cb_end[dst_b + 1]   = bg; cb_end[dst_b + 2]   = bb;
		}

		// Both halves share opacity — selection / fade is slot-level.
		if (opacity !== null && this.#opacity_attr !== null) {
			const buf = this.#opacity_attr.array as Float32Array;
			const op = opacity[slot];
			buf[slot * 2] = op;
			buf[slot * 2 + 1] = op;
		}
	}

	/**
	 * Phase 7 image-atom decorator pass. Writes `2 × layout.bonds_csr.length`
	 * instances starting at `instance_count` (immediately after the cell-
	 * internal half-bond range). Each (image atom × incident bond) emits two
	 * halves — atom A side and atom B side — at the image-atom-shifted
	 * positions, exactly mirroring the cell-internal layout but with the
	 * image atom's `jimage_img` applied to BOTH endpoints (offset_a and
	 * offset_b adjust based on whether the anchor is the bond's atom A or B).
	 *
	 * Phase 7c writes full bonds unconditionally — Phase 7d adds the
	 * `is_partner_drawn` dispatch that converts non-drawn-partner instances
	 * into incomplete-edge stubs.
	 */
	#write_decorators(
		layout: ImageAtomLayout | null,
		base_instance: number,
		decorator_instance_count: number,
		matrix_attr: THREE.InstancedBufferAttribute,
		pairs: Uint32Array,
		kinds: Uint8Array,
		jimages: Int8Array,
		positions: Float32Array,
		lattice: Float64Array | null,
		stub: IncompleteEdgeOpts | null,
		colors_start: Float32Array | null,
		colors_end: Float32Array | null,
		opacity: Float32Array | null,
	): void {
		if (layout === null || decorator_instance_count === 0) return;

		const partner_drawn_lookup = this.#get_partner_drawn ? this.#get_partner_drawn() : null;
		// Stub scale defaults to 0.5 (Phase 6 VESTA convention) when an
		// incomplete-edge accessor isn't wired.
		const stub_scale = stub !== null ? stub.scale : 0.5;

		let dec_idx = base_instance;
		for (let img = 0; img < layout.n_image_atoms; img++) {
			const orig_idx = layout.orig_site_indices[img];
			const jx = layout.jimage_offsets[img * 3];
			const jy = layout.jimage_offsets[img * 3 + 1];
			const jz = layout.jimage_offsets[img * 3 + 2];
			const csr_lo = layout.row_offsets[img];
			const csr_hi = layout.row_offsets[img + 1];
			for (let k = csr_lo; k < csr_hi; k++) {
				const slot = layout.bonds_csr[k];
				let is_partner_drawn = true;
				if (partner_drawn_lookup !== null) {
					// Resolve the partner identity in image-atom space so the
					// caller can match against its `sites_to_draw` Map directly.
					const a = pairs[slot * 2];
					const b = pairs[slot * 2 + 1];
					const ji = slot * 3;
					const bdx = jimages[ji];
					const bdy = jimages[ji + 1];
					const bdz = jimages[ji + 2];
					const anchor_is_a = a === (orig_idx >>> 0);
					const partner_idx = anchor_is_a ? b : a;
					const pjx = anchor_is_a ? jx + bdx : jx - bdx;
					const pjy = anchor_is_a ? jy + bdy : jy - bdy;
					const pjz = anchor_is_a ? jz + bdz : jz - bdz;
					is_partner_drawn = partner_drawn_lookup(partner_idx, pjx, pjy, pjz);
				}
				this.#write_image_slot(
					slot, orig_idx, jx, jy, jz, dec_idx,
					pairs, kinds, jimages, positions, lattice,
					colors_start, colors_end, opacity,
					is_partner_drawn, stub_scale,
				);
				dec_idx += 2;
			}
		}

		matrix_attr.addUpdateRange(base_instance * 16, decorator_instance_count * 16);
		this.#kind_attr.addUpdateRange(base_instance, decorator_instance_count);
		this.#color_start_attr?.addUpdateRange(base_instance * 3, decorator_instance_count * 3);
		this.#color_end_attr?.addUpdateRange(base_instance * 3, decorator_instance_count * 3);
		this.#opacity_attr?.addUpdateRange(base_instance, decorator_instance_count);
	}

	/**
	 * Write one image-atom decorator (2 instances at `dec_idx` and
	 * `dec_idx + 1`). Same geometric model as `#write_slot` but with the
	 * image atom's lattice offset applied to both endpoints. The anchor's
	 * offset is `jimage_img`; the partner's offset is `jimage_img ± bond.jimage`
	 * (sign depends on which end of the bond the anchor is).
	 *
	 * Color / opacity / kind are read from the underlying BondManager slot —
	 * a selection or opacity change on slot `S` is automatically reflected
	 * in every decorator copy of `S` (plan §4.4).
	 */
	#write_image_slot(
		slot: number,
		orig_idx: number,
		jimage_img_x: number,
		jimage_img_y: number,
		jimage_img_z: number,
		dec_idx: number,
		pairs: Uint32Array,
		kinds: Uint8Array,
		jimages: Int8Array,
		positions: Float32Array,
		lattice: Float64Array | null,
		colors_start: Float32Array | null,
		colors_end: Float32Array | null,
		opacity: Float32Array | null,
		is_partner_drawn: boolean,
		stub_scale: number,
	): void {
		const a = pairs[slot * 2];
		const b = pairs[slot * 2 + 1];

		const ji = slot * 3;
		const bond_dx = jimages[ji];
		const bond_dy = jimages[ji + 1];
		const bond_dz = jimages[ji + 2];

		// Which end of the bond is the anchor? When the orig_idx matches both
		// ends (self-bond), default to the atom-A interpretation.
		const anchor_is_a = (a === orig_idx >>> 0);

		let oax: number, oay: number, oaz: number;
		let obx: number, oby: number, obz: number;
		if (anchor_is_a) {
			oax = jimage_img_x;
			oay = jimage_img_y;
			oaz = jimage_img_z;
			obx = jimage_img_x + bond_dx;
			oby = jimage_img_y + bond_dy;
			obz = jimage_img_z + bond_dz;
		} else {
			// anchor is atom B: the matching atom A image lives `-bond.jimage`
			// away from the anchor's image cell.
			oax = jimage_img_x - bond_dx;
			oay = jimage_img_y - bond_dy;
			oaz = jimage_img_z - bond_dz;
			obx = jimage_img_x;
			oby = jimage_img_y;
			obz = jimage_img_z;
		}

		let ax = positions[a * 3];
		let ay = positions[a * 3 + 1];
		let az = positions[a * 3 + 2];
		let bx = positions[b * 3];
		let by = positions[b * 3 + 1];
		let bz = positions[b * 3 + 2];

		if (lattice !== null) {
			if ((oax | oay | oaz) !== 0) {
				ax += oax * lattice[0] + oay * lattice[3] + oaz * lattice[6];
				ay += oax * lattice[1] + oay * lattice[4] + oaz * lattice[7];
				az += oax * lattice[2] + oay * lattice[5] + oaz * lattice[8];
			}
			if ((obx | oby | obz) !== 0) {
				bx += obx * lattice[0] + oby * lattice[3] + obz * lattice[6];
				by += obx * lattice[1] + oby * lattice[4] + obz * lattice[7];
				bz += obx * lattice[2] + oby * lattice[5] + obz * lattice[8];
			}
		}

		const mx = (ax + bx) * 0.5;
		const my = (ay + by) * 0.5;
		const mz = (az + bz) * 0.5;

		const fx = bx - ax;
		const fy = by - ay;
		const fz = bz - az;
		const length = Math.sqrt(fx * fx + fy * fy + fz * fz);
		const half_length = length * 0.5;

		if (length < 1e-8) {
			this.#v_dir.set(0, 1, 0);
		} else {
			const inv = 1 / length;
			this.#v_dir.set(fx * inv, fy * inv, fz * inv);
		}
		this.#q_rot.setFromUnitVectors(UP_Y, this.#v_dir);

		if (is_partner_drawn) {
			// Full bond — both halves anchored at their respective image
			// positions, meeting at the midpoint.
			this.#v_scale.set(1, half_length, 1);
			this.#v_half_mid_a.set(
				(ax + mx) * 0.5,
				(ay + my) * 0.5,
				(az + mz) * 0.5,
			);
			this.#tmp_matrix.compose(this.#v_half_mid_a, this.#q_rot, this.#v_scale);
			this.#mesh.setMatrixAt(dec_idx, this.#tmp_matrix);

			this.#v_half_mid_b.set(
				(mx + bx) * 0.5,
				(my + by) * 0.5,
				(mz + bz) * 0.5,
			);
			this.#tmp_matrix.compose(this.#v_half_mid_b, this.#q_rot, this.#v_scale);
			this.#mesh.setMatrixAt(dec_idx + 1, this.#tmp_matrix);
		} else {
			// Phase 7d incomplete-edge stub: render only the anchor's half,
			// scaled by `stub_scale`. The other half collapses to a
			// zero-scale matrix (occupies an instance slot for picker decode
			// alignment but renders no visible geometry).
			const stub_len = half_length * stub_scale;
			this.#v_scale.set(1, stub_len, 1);
			const half_stub = stub_len * 0.5;

			// Anchor side: A → matrix at dec_idx; B → matrix at dec_idx + 1.
			// The other half collapses to a zero-scale matrix.
			if (anchor_is_a) {
				this.#v_half_mid_a.set(
					ax + this.#v_dir.x * half_stub,
					ay + this.#v_dir.y * half_stub,
					az + this.#v_dir.z * half_stub,
				);
				this.#tmp_matrix.compose(this.#v_half_mid_a, this.#q_rot, this.#v_scale);
				this.#mesh.setMatrixAt(dec_idx, this.#tmp_matrix);
				this.#mesh.setMatrixAt(dec_idx + 1, ZERO_MATRIX);
			} else {
				this.#v_half_mid_b.set(
					bx - this.#v_dir.x * half_stub,
					by - this.#v_dir.y * half_stub,
					bz - this.#v_dir.z * half_stub,
				);
				this.#mesh.setMatrixAt(dec_idx, ZERO_MATRIX);
				this.#tmp_matrix.compose(this.#v_half_mid_b, this.#q_rot, this.#v_scale);
				this.#mesh.setMatrixAt(dec_idx + 1, this.#tmp_matrix);
			}
		}

		const kind = kinds[slot];
		this.#kind_buf[dec_idx] = kind;
		this.#kind_buf[dec_idx + 1] = kind;

		if (colors_start !== null && this.#color_start_attr !== null) {
			const cb_start = this.#color_start_attr.array as Float32Array;
			const cb_end = this.#color_end_attr!.array as Float32Array;
			const src = slot * 3;
			const dst_a = dec_idx * 3;
			const dst_b = (dec_idx + 1) * 3;

			const ar = colors_start[src];
			const ag = colors_start[src + 1];
			const ab = colors_start[src + 2];
			const br = colors_end![src];
			const bg = colors_end![src + 1];
			const bb = colors_end![src + 2];

			cb_start[dst_a]     = ar; cb_start[dst_a + 1] = ag; cb_start[dst_a + 2] = ab;
			cb_end[dst_a]       = ar; cb_end[dst_a + 1]   = ag; cb_end[dst_a + 2]   = ab;
			cb_start[dst_b]     = br; cb_start[dst_b + 1] = bg; cb_start[dst_b + 2] = bb;
			cb_end[dst_b]       = br; cb_end[dst_b + 1]   = bg; cb_end[dst_b + 2]   = bb;
		}

		if (opacity !== null && this.#opacity_attr !== null) {
			const buf = this.#opacity_attr.array as Float32Array;
			const op = opacity[slot];
			buf[dec_idx] = op;
			buf[dec_idx + 1] = op;
		}
	}
}
