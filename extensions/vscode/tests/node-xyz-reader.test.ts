import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { NodeXYZFrameLoader, scan_xyz_file } from '../src/node-xyz-reader'

describe(`file-backed XYZ reader`, () => {
  const temp_dirs: string[] = []

  afterEach(async () => {
    await Promise.all(temp_dirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true })
    ))
  })

  async function fixture(contents: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `catgo-xyz-reader-`))
    temp_dirs.push(dir)
    const file_path = join(dir, `trajectory.extxyz`)
    await writeFile(file_path, contents)
    return file_path
  }

  test(`indexes byte ranges and drops a truncated final frame`, async () => {
    const complete = [
      `2`,
      `energy=-1`,
      `H 0 0 0`,
      `H 1 0 0`,
      `1`,
      `energy=-2`,
      `O 2 0 0`,
    ].join(`\n`)
    const file_path = await fixture(`${complete}\n2\ntruncated\nH 0 0 0`)

    const index = await scan_xyz_file(file_path)

    expect(index.offsets).toHaveLength(3)
    expect(index.offsets[0]).toBe(0)
    expect(index.offsets[1]).toBe(
      new TextEncoder().encode(`2\nenergy=-1\nH 0 0 0\nH 1 0 0\n`).length,
    )
    expect(index.offsets[2]).toBe(
      new TextEncoder().encode(`${complete}\n`).length,
    )
  })

  test(`seeks individual frames and preserves variable topology verdicts`, async () => {
    const file_path = await fixture([
      `2`,
      `Lattice="10 0 0 0 10 0 0 0 10" energy=-1`,
      `H 0 0 0`,
      `H 1 0 0`,
      `1`,
      `Lattice="11 0 0 0 11 0 0 0 11" energy=-2`,
      `O 2 0 0`,
    ].join(`\n`))
    const loader = await NodeXYZFrameLoader.create(file_path, `trajectory.extxyz`)

    try {
      expect(await loader.get_total_frames(``)).toBe(2)
      const first = await loader.load_frame(``, 0)
      const second = await loader.load_frame_positions(``, 1)
      expect(first?.structure.sites).toHaveLength(2)
      expect(Array.from(second?.positions ?? [])).toEqual([2, 0, 0])
      expect(second?.topology_changed).toBe(true)
      expect(second?.lattice).toEqual([
        [11, 0, 0],
        [0, 11, 0],
        [0, 0, 11],
      ])

      const metadata = await loader.extract_plot_metadata(``)
      expect(metadata.map((item) => item.properties.energy)).toEqual([-1, -2])
    } finally {
      await loader.dispose()
    }
  })
})
