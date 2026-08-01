/**
 * AtomInstancedRenderer — GPU upload survival across multiple sync() calls
 * between draws (the supercell atom-vanish bug).
 *
 * Three.js consumes an attribute's `updateRanges` at DRAW time
 * (WebGLAttributes.updateBuffer): it uploads only the ranges present at that
 * moment, then clears them; with zero ranges it uploads the whole array.
 * Svelte can flush the renderer's sync $effect several times before the next
 * RAF draw (e.g. a supercell apply: X2 shadow sync grows the manager, then
 * the image-atom pass grows it again). If a later sync() destroys the ranges
 * a previous sync() queued — via renderer-side clearUpdateRanges() — the
 * covered slots never reach the GPU. Freshly grown slots keep their
 * allocation-time zeros (radius 0 → invisible atoms) while manager.count,
 * mesh.count and the CPU-side attribute arrays all look correct.
 *
 * The fake GPU below mirrors three's updateBuffer contract exactly
 * (three@0.181 three.module.js L139-214): version-gated, ranges-or-full,
 * clear-after-consume.
 */
import { AtomManager } from '$lib/structure/atoms/atom-manager.svelte'
import { AtomInstancedRenderer } from '$lib/structure/atoms/atom-instanced-renderer'
import { VISUAL_RADIUS_SCALE } from '$lib/structure/rendering/visual-state'
import * as THREE from 'three'
import { beforeEach, describe, expect, test } from 'vitest'

const CAPACITY = 32

let mesh: THREE.InstancedMesh
let manager: AtomManager
let renderer: AtomInstancedRenderer

function make_mesh(): THREE.InstancedMesh {
	const geometry = new THREE.PlaneGeometry(2, 2, 1, 1)
	const material = new THREE.MeshBasicMaterial()
	return new THREE.InstancedMesh(geometry, material, CAPACITY)
}

function attr(name: string): THREE.InstancedBufferAttribute {
	return mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute
}

// ─── Fake GPU: three.js WebGLAttributes.update / updateBuffer semantics ───
// - first use: gl.bufferData with the full CPU array (createBuffer)
// - later: only if attribute.version advanced (needsUpdate):
//   - updateRanges empty → full-array gl.bufferSubData
//   - else → upload ONLY those ranges, then attribute.clearUpdateRanges()
const gpu = new Map<
	THREE.InstancedBufferAttribute,
	{ data: Float32Array; version: number }
>()

function draw_upload(attribute: THREE.InstancedBufferAttribute): Float32Array {
	const cpu = attribute.array as Float32Array
	let entry = gpu.get(attribute)
	if (!entry) {
		entry = { data: cpu.slice(), version: attribute.version }
		gpu.set(attribute, entry)
		return entry.data
	}
	if (entry.version === attribute.version) return entry.data
	const ranges = attribute.updateRanges
	if (ranges.length === 0) {
		entry.data.set(cpu)
	} else {
		for (const range of ranges) {
			for (let i = range.start; i < range.start + range.count; i++) {
				entry.data[i] = cpu[i]
			}
		}
		attribute.clearUpdateRanges()
	}
	entry.version = attribute.version
	return entry.data
}

/** Simulate one WebGL draw: upload every instanced attribute the renderer owns. */
function draw_all(): Record<string, Float32Array> {
	const names = [
		`instancePosition`,
		`instanceRadius`,
		`instanceAtomColor`,
		`instanceOpacity`,
		`instanceSaturation`,
	]
	const out: Record<string, Float32Array> = {}
	for (const name of names) out[name] = draw_upload(attr(name))
	return out
}

function add_batch(first_site: number, n: number, radius: number): void {
	const site_ids = new Uint32Array(n)
	const positions = new Float32Array(n * 3)
	const elements = new Uint8Array(n)
	const radii = new Float32Array(n)
	for (let i = 0; i < n; i++) {
		site_ids[i] = first_site + i
		positions[i * 3] = first_site + i
		positions[i * 3 + 1] = 1
		positions[i * 3 + 2] = 2
		elements[i] = 8
		radii[i] = radius
	}
	manager.add_atoms(site_ids, positions, elements, radii)
}

beforeEach(() => {
	gpu.clear()
	mesh = make_mesh()
	manager = new AtomManager(CAPACITY)
	renderer = new AtomInstancedRenderer(mesh, manager, null)
})

describe(`AtomInstancedRenderer — in-place growth between draws`, () => {
	test(`two growth syncs before one draw upload every grown slot`, () => {
		// Initial structure: 2 atoms, synced and drawn (GPU is current).
		add_batch(0, 2, 0.5)
		renderer.sync()
		draw_all()

		// Growth #1: 2 → 4 (e.g. X2 shadow sync after a supercell apply).
		add_batch(2, 2, 0.6)
		renderer.sync()

		// Growth #2 lands in the SAME task, before the browser draws
		// (e.g. the image-atom pass appends boundary copies).
		add_batch(4, 2, 0.7)
		renderer.sync()

		const gpu_state = draw_all()

		expect(mesh.count).toBe(6)
		// Every grown slot must have reached the GPU. The regression left
		// growth #1's slots at their allocation-time zeros (radius 0 →
		// invisible) because growth #2's sync destroyed the pending ranges.
		for (let slot = 2; slot < 4; slot++) {
			expect(gpu_state.instanceRadius[slot], `radius slot ${slot}`)
				.toBeCloseTo(0.6 * VISUAL_RADIUS_SCALE)
			expect(gpu_state.instancePosition[slot * 3], `pos.x slot ${slot}`)
				.toBeCloseTo(slot)
		}
		for (let slot = 4; slot < 6; slot++) {
			expect(gpu_state.instanceRadius[slot], `radius slot ${slot}`)
				.toBeCloseTo(0.7 * VISUAL_RADIUS_SCALE)
		}
	})

	test(`force_full_resync followed by a growth sync keeps full coverage (supercell signature)`, () => {
		// "112-era" baseline: 3 atoms on the GPU.
		add_batch(0, 3, 0.5)
		renderer.sync()
		draw_all()

		// Supercell apply, one flush: grow 3 → 6 …
		add_batch(3, 3, 0.6)
		renderer.sync()
		// … a modulation prop flips identity → the component calls
		// force_full_resync() (covers [0, 6) on every attribute) …
		renderer.force_full_resync()
		// … then the image-atom pass grows 6 → 8 and syncs again. The
		// regression: this sync destroyed the force's pending [0, 6) ranges,
		// so slots 3..5 (never drawn since baseline) stayed radius-0 forever.
		add_batch(6, 2, 0.7)
		renderer.sync()

		const gpu_state = draw_all()

		expect(mesh.count).toBe(8)
		for (let slot = 3; slot < 6; slot++) {
			expect(gpu_state.instanceRadius[slot], `radius slot ${slot}`)
				.toBeCloseTo(0.6 * VISUAL_RADIUS_SCALE)
		}
		for (let slot = 6; slot < 8; slot++) {
			expect(gpu_state.instanceRadius[slot], `radius slot ${slot}`)
				.toBeCloseTo(0.7 * VISUAL_RADIUS_SCALE)
		}
		// Baseline slots must still be intact.
		for (let slot = 0; slot < 3; slot++) {
			expect(gpu_state.instanceRadius[slot], `radius slot ${slot}`)
				.toBeCloseTo(0.5 * VISUAL_RADIUS_SCALE)
		}
	})
})
