/**
 * BondInstancedRenderer.sync_gpu_topology — the GPU vertex-transform playback
 * path. Verifies the static topology attributes (a_site / a_jimage / a_half),
 * per-half colors/kind/opacity, mesh.count, and that instanceMatrix is left
 * untouched (the shader's uGpuXform branch ignores it) until the mode-exit
 * force_full_resync rebuilds it.
 */
import { BOND_KIND, BondManager } from '$lib/structure/bonding/bond-manager.svelte'
import { BondInstancedRenderer } from '$lib/structure/bonding/bond-instanced-renderer'
import * as THREE from 'three'
import { beforeEach, describe, expect, test } from 'vitest'

const CAPACITY = 32

function make_mesh(): THREE.InstancedMesh {
	const geometry = new THREE.CylinderGeometry(0.15, 0.15, 1, 8)
	const material = new THREE.MeshBasicMaterial()
	return new THREE.InstancedMesh(geometry, material, CAPACITY)
}

// 3 atoms on a line, 1 Å apart.
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0])
// Solid per-atom colors: R, G, B.
const atom_colors = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
const lattice = new Float64Array([10, 0, 0, 0, 10, 0, 0, 0, 10])

let mesh: THREE.InstancedMesh
let manager: BondManager
let renderer: BondInstancedRenderer

function attr(name: string): THREE.InstancedBufferAttribute {
	return mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute
}

beforeEach(() => {
	mesh = make_mesh()
	manager = new BondManager(CAPACITY)
	renderer = new BondInstancedRenderer(
		mesh,
		manager,
		() => positions,
		() => lattice,
		() => ({ mode: false, scale: 0.5, hide_incomplete: true }),
		() => null,
		() => null,
		() => atom_colors,
	)
})

describe(`sync_gpu_topology`, () => {
	test(`writes a_site / a_jimage / a_half per half-instance`, () => {
		manager.add_bond(0, 1, BOND_KIND.AUTO)
		manager.add_bond(1, 2, BOND_KIND.AUTO, [0, 0, 1])
		renderer.sync_gpu_topology()

		const site = attr(`a_site`).array as Float32Array
		const jimage = attr(`a_jimage`).array as Int8Array
		const half = attr(`a_half`).array as Uint8Array

		// Slot 0 → instances 0 (half A) and 1 (half B), both carrying (0, 1).
		expect([site[0], site[1], site[2], site[3]]).toEqual([0, 1, 0, 1])
		// Slot 1 → instances 2, 3 carrying (1, 2).
		expect([site[4], site[5], site[6], site[7]]).toEqual([1, 2, 1, 2])
		// jimage mirrored across both halves of each slot.
		expect(Array.from(jimage.slice(0, 6))).toEqual([0, 0, 0, 0, 0, 0])
		expect(Array.from(jimage.slice(6, 12))).toEqual([0, 0, 1, 0, 0, 1])
		// Half parity is a static property of the instance index.
		expect([half[0], half[1], half[2], half[3]]).toEqual([0, 1, 0, 1])
		expect(mesh.count).toBe(4)
	})

	test(`writes per-half solid colors from the per-atom buffer`, () => {
		manager.add_bond(0, 2, BOND_KIND.AUTO)
		renderer.sync_gpu_topology()

		const start = attr(`instance_color_start`).array as Float32Array
		const end = attr(`instance_color_end`).array as Float32Array
		// Half A (instance 0) = atom 0's color (red), start == end (solid).
		expect(Array.from(start.slice(0, 3))).toEqual([1, 0, 0])
		expect(Array.from(end.slice(0, 3))).toEqual([1, 0, 0])
		// Half B (instance 1) = atom 2's color (blue).
		expect(Array.from(start.slice(3, 6))).toEqual([0, 0, 1])
		expect(Array.from(end.slice(3, 6))).toEqual([0, 0, 1])
	})

	test(`mirrors kind and opacity across both halves`, () => {
		manager.add_bond(0, 1, BOND_KIND.MANUAL)
		manager.ensure_opacity()
		manager.set_opacity(0, 0.25)
		renderer.sync_gpu_topology()

		const kind = attr(`bond_kind`).array as Uint8Array
		expect([kind[0], kind[1]]).toEqual([BOND_KIND.MANUAL, BOND_KIND.MANUAL])
		const op = attr(`instance_opacity`).array as Float32Array
		expect([op[0], op[1]]).toEqual([0.25, 0.25])
	})

	test(`leaves instanceMatrix untouched; mode-exit force_full_resync rebuilds it`, () => {
		manager.add_bond(0, 1, BOND_KIND.AUTO)
		const before = (mesh.instanceMatrix.array as Float32Array).slice()
		renderer.sync_gpu_topology()

		// The GPU sync must not write any matrix (the shader's texture branch
		// ignores instanceMatrix; whatever the mesh was constructed with stays).
		const mat = mesh.instanceMatrix.array as Float32Array
		expect(Array.from(mat)).toEqual(Array.from(before))

		// Mode exit: CPU path takes ownership again and composes real matrices
		// (translation to the half midpoints differs from the initial buffer).
		renderer.force_full_resync()
		expect(Array.from(mat.slice(0, 32))).not.toEqual(Array.from(before.slice(0, 32)))
	})

	test(`tracks manager version so a follow-up sync() is a no-op`, () => {
		manager.add_bond(0, 1, BOND_KIND.AUTO)
		const before = (mesh.instanceMatrix.array as Float32Array).slice()
		renderer.sync_gpu_topology()
		// sync() early-returns on version match — instanceMatrix stays untouched.
		renderer.sync()
		const mat = mesh.instanceMatrix.array as Float32Array
		expect(Array.from(mat)).toEqual(Array.from(before))
	})

	test(`replace_auto_bonds between GPU syncs lands in the attrs`, () => {
		manager.add_bond(0, 1, BOND_KIND.AUTO)
		renderer.sync_gpu_topology()
		manager.replace_auto_bonds(new Uint32Array([1, 2]), 1, new Int8Array([1, 0, 0]))
		renderer.sync_gpu_topology()

		const site = attr(`a_site`).array as Float32Array
		const jimage = attr(`a_jimage`).array as Int8Array
		expect([site[0], site[1], site[2], site[3]]).toEqual([1, 2, 1, 2])
		expect(Array.from(jimage.slice(0, 6))).toEqual([1, 0, 0, 1, 0, 0])
		expect(mesh.count).toBe(2)
	})

	test(`dispose removes the GPU topology attributes`, () => {
		manager.add_bond(0, 1, BOND_KIND.AUTO)
		renderer.sync_gpu_topology()
		renderer.dispose()
		expect(mesh.geometry.getAttribute(`a_site`)).toBeUndefined()
		expect(mesh.geometry.getAttribute(`a_jimage`)).toBeUndefined()
		expect(mesh.geometry.getAttribute(`a_half`)).toBeUndefined()
	})
})

describe(`GPU topology attr capacity`, () => {
	// A mesh at the production default scale (1M in the app; 100k here keeps
	// the test light) — the topology attrs must NOT be allocated at this size.
	const BIG = 100_000

	function make_big() {
		const big_mesh = new THREE.InstancedMesh(
			new THREE.CylinderGeometry(0.15, 0.15, 1, 8),
			new THREE.MeshBasicMaterial(),
			BIG,
		)
		const mgr = new BondManager()
		const r = new BondInstancedRenderer(
			big_mesh,
			mgr,
			() => positions,
			() => lattice,
			() => ({ mode: false, scale: 0.5, hide_incomplete: true }),
			() => null,
			() => null,
			() => atom_colors,
		)
		return { big_mesh, mgr, r }
	}

	function topo_attr(mesh_ref: THREE.InstancedMesh, name: string) {
		return mesh_ref.geometry.getAttribute(name) as THREE.InstancedBufferAttribute
	}

	test(`initial allocation is right-sized, not mesh capacity`, () => {
		const { big_mesh, mgr, r } = make_big()
		mgr.add_bond(0, 1, BOND_KIND.AUTO)
		mgr.add_bond(1, 2, BOND_KIND.AUTO)
		r.sync_gpu_topology()

		// 2 bonds → 4 instances. Capacity carries growth headroom + a small
		// floor, but must stay orders of magnitude below the 100k-instance
		// mesh capacity the old code allocated at (~12MB at the 1M default).
		for (const name of [`a_site`, `a_jimage`, `a_half`]) {
			const a = topo_attr(big_mesh, name)
			expect(a.count).toBeGreaterThanOrEqual(4)
			expect(a.count).toBeLessThanOrEqual(4096)
		}
	})

	test(`grows past initial capacity with data intact; steady-state re-sync reuses attrs`, () => {
		const { big_mesh, mgr, r } = make_big()
		mgr.add_bond(0, 1, BOND_KIND.AUTO)
		r.sync_gpu_topology()
		const site_initial = topo_attr(big_mesh, `a_site`)
		const initial_cap = site_initial.count

		// n bonds → 2n instances, guaranteed to exceed the initial capacity.
		const n = initial_cap
		const pairs = new Uint32Array(n * 2)
		const jimages = new Int8Array(n * 3)
		for (let i = 0; i < n; i++) {
			pairs[i * 2] = i % 3
			pairs[i * 2 + 1] = (i + 1) % 3
			jimages[i * 3 + 2] = i % 2
		}
		mgr.replace_auto_bonds(pairs, n, jimages)
		r.sync_gpu_topology()

		// Growth swaps in NEW attribute objects (a WebGL instanced attribute
		// cannot grow in place) at >= the needed instance count.
		const site = topo_attr(big_mesh, `a_site`)
		const jimage = topo_attr(big_mesh, `a_jimage`)
		const half = topo_attr(big_mesh, `a_half`)
		expect(site).not.toBe(site_initial)
		for (const a of [site, jimage, half]) {
			expect(a.count).toBeGreaterThanOrEqual(n * 2)
			expect(a.count).toBeLessThanOrEqual(BIG)
		}
		expect(big_mesh.count).toBe(n * 2)
		// needsUpdate is setter-only in three; the version bump proves it fired.
		expect(site.version).toBeGreaterThan(0)

		// Per-instance data survives the reallocation: spot-check the first
		// and last slot plus half parity at the top of the live range.
		const sb = site.array as Float32Array
		const jb = jimage.array as Int8Array
		const hb = half.array as Uint8Array
		const last = n - 1
		expect([sb[0], sb[1], sb[2], sb[3]]).toEqual([0, 1, 0, 1])
		expect([sb[last * 2 * 2], sb[last * 2 * 2 + 1]]).toEqual([last % 3, (last + 1) % 3])
		expect(jb[last * 2 * 3 + 2]).toBe(last % 2)
		expect(jb[(last * 2 + 1) * 3 + 2]).toBe(last % 2)
		expect([hb[n * 2 - 2], hb[n * 2 - 1]]).toEqual([0, 1])

		// Hot path: a re-sync at the same size must write in place — same
		// attribute objects, no reallocation.
		r.sync_gpu_topology()
		expect(topo_attr(big_mesh, `a_site`)).toBe(site)
		expect(topo_attr(big_mesh, `a_jimage`)).toBe(jimage)
		expect(topo_attr(big_mesh, `a_half`)).toBe(half)
	})
})
