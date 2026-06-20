import type { AnyStructure } from '$lib'
import type { TrajectoryType } from './index'

export function topology_signature(structure: AnyStructure): string {
  return structure.sites
    .map((site) => site.species?.[0]?.element ?? site.label ?? `?`)
    .join(`,`)
}

export function validate_uniform_topology(trajectory: TrajectoryType): string | null {
  const first = trajectory.frames[0]?.structure
  if (!first) return `Trajectory has no loaded frame.`
  const signature = topology_signature(first)
  for (let i = 1; i < trajectory.frames.length; i++) {
    const frame = trajectory.frames[i]
    if (!frame?.structure || topology_signature(frame.structure) !== signature) {
      return `Frame ${i} has a different atom count or element order; an all-frame topology edit would be unsafe.`
    }
  }
  return null
}

export function scale_structure_geometry(structure: AnyStructure, factor: number): AnyStructure {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error(`Scale factor must be positive.`)
  const sites = structure.sites
  if (`lattice` in structure && structure.lattice) {
    const next_sites = sites.map((site) => ({
      ...site,
      // Scaling lattice and Cartesian coordinates about the lattice origin
      // preserves fractional coordinates exactly.
      xyz: site.xyz.map((x) => x * factor) as [number, number, number],
      ...(site.abc ? { abc: [...site.abc] as [number, number, number] } : {}),
    }))
    const matrix = structure.lattice.matrix.map((row) => row.map((x) => x * factor))
    return {
      ...structure,
      sites: next_sites,
      lattice: {
        ...structure.lattice,
        matrix,
        a: structure.lattice.a != null ? structure.lattice.a * factor : structure.lattice.a,
        b: structure.lattice.b != null ? structure.lattice.b * factor : structure.lattice.b,
        c: structure.lattice.c != null ? structure.lattice.c * factor : structure.lattice.c,
        volume: structure.lattice.volume != null ? structure.lattice.volume * factor ** 3 : structure.lattice.volume,
      },
    } as AnyStructure
  }
  const center = sites.reduce(
    (acc, site) => [acc[0] + site.xyz[0], acc[1] + site.xyz[1], acc[2] + site.xyz[2]],
    [0, 0, 0],
  ).map((x) => x / Math.max(1, sites.length))
  const next_sites = sites.map((site) => ({
    ...site,
    xyz: site.xyz.map((x, axis) => center[axis] + (x - center[axis]) * factor) as [number, number, number],
    ...(site.abc ? { abc: [...site.abc] as [number, number, number] } : {}),
  }))
  return { ...structure, sites: next_sites } as AnyStructure
}
