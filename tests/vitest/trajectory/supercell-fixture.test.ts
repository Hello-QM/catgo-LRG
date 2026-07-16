import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse_trajectory_data } from '$lib/trajectory/parse'
import { expect, test } from 'vitest'

const FIXTURE_PATH = resolve(
  process.cwd(),
  'tests/fixtures/trajectory/supercell-small.extxyz',
)
const FIXTURE_SHA256 = '44b481def4adeb28d2fbcf4ac8f82d537a11baa9eb0dfec95354086f945b880f'
const FRAME_SHA256 = [
  'dbc64406bf7dc70234fef86dd83602f4ca38b2e1a7606000d784fa152444db71',
  'aa67b87a010a617b2e13fd403a312ea9181f872353461a4c60c942b582c4970d',
  '874bfcdd33e38009a88e6b97441f599dbcdb0a7c6e3010f1d7d9426f99b04009',
]

const EXPECTED_SPECIES = [['C'], ['C', 'C'], ['C', 'C', 'H']]
const EXPECTED_POSITIONS = [
  [[0, 0, 0]],
  [[0, 0, 0], [1.4, 0, 0]],
  [[0, 0, 0], [1.4, 0, 0], [2.45, 0, 0]],
]
const EXPECTED_LATTICES = [
  [[1.4, 0, 0], [0, 1.4, 0], [0, 0, 1.4]],
  [[4.2, 0, 0], [0, 4, 0], [0, 0, 4]],
  [[4.4, 0.2, 0], [0, 4.1, 0], [0, 0, 4.2]],
]

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

test('parses the deterministic variable-cell, variable-N supercell fixture', async () => {
  const content = readFileSync(FIXTURE_PATH, 'utf8')
  expect(sha256(content)).toBe(FIXTURE_SHA256)

  const trajectory = await parse_trajectory_data(content, 'supercell-small.extxyz')
  expect(trajectory.metadata).toMatchObject({
    source_format: 'xyz_trajectory',
    frame_count: 3,
  })
  expect(trajectory.frames).toHaveLength(3)

  const species = trajectory.frames.map((frame) =>
    frame.structure.sites.map((site) => site.species[0].element)
  )
  const positions = trajectory.frames.map((frame) =>
    frame.structure.sites.map((site) => site.xyz)
  )
  const lattices = trajectory.frames.map((frame) => frame.structure.lattice?.matrix)

  expect(trajectory.frames.map((frame) => frame.structure.sites.length)).toEqual([1, 2, 3])
  expect(species).toEqual(EXPECTED_SPECIES)
  expect(positions).toEqual(EXPECTED_POSITIONS)
  expect(lattices).toEqual(EXPECTED_LATTICES)
  expect(trajectory.frames.map((frame) => frame.structure.lattice?.pbc)).toEqual([
    [true, true, true],
    [true, true, true],
    [true, true, true],
  ])

  const frame_checksums = trajectory.frames.map((_frame, idx) =>
    sha256(JSON.stringify({
      species: species[idx],
      positions: positions[idx],
      lattice: lattices[idx],
    }))
  )
  expect(frame_checksums).toEqual(FRAME_SHA256)

  const primitive = trajectory.frames[0].structure
  const shortest_periodic_image_distance = Math.min(
    ...primitive.lattice!.matrix.map((vector) => Math.hypot(...vector)),
  )
  // With one C atom, every periodic neighbor is its own image. The 1.4 Å
  // primitive translation is C-C-bond-scale, so the nearest edge is a self-edge.
  expect(primitive.sites).toHaveLength(1)
  expect(shortest_periodic_image_distance).toBe(1.4)
  expect(shortest_periodic_image_distance).toBeLessThan(1.5)
})
