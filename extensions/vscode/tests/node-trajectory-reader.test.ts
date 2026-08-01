import { Buffer } from 'node:buffer'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'
import { NodeASEFrameLoader } from '../src/node-ase-reader'
import { NodeHDF5FrameLoader } from '../src/node-hdf5-reader'
import { NodeJSONFrameLoader } from '../src/node-json-reader'
import {
  build_local_trajectory_manifest,
  create_local_trajectory_loader,
} from '../src/node-trajectory-reader'
import {
  NodeLammpsFrameLoader,
  NodeGaussianFrameLoader,
  NodeOrcaFrameLoader,
  NodeOutcarFrameLoader,
  NodeVasprunFrameLoader,
  NodeXdatcarFrameLoader,
} from '../src/node-text-trajectory-reader'

describe(`file-backed trajectory readers`, () => {
  const temp_dirs: string[] = []

  afterEach(async () => {
    await Promise.all(temp_dirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true })
    ))
  })

  async function fixture(filename: string, contents: string | Buffer): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `catgo-trajectory-reader-`))
    temp_dirs.push(dir)
    const file_path = join(dir, filename)
    await writeFile(file_path, contents)
    return file_path
  }

  test(`uses the native ASE ULM offset table`, async () => {
    const frame_json = [
      JSON.stringify({
        numbers: [1, 8],
        positions: [[0, 0, 0], [1, 0, 0]],
        cell: [[5, 0, 0], [0, 5, 0], [0, 0, 5]],
        calculator: { energy: -1 },
      }),
      JSON.stringify({
        positions: [[0.5, 0, 0], [1.5, 0, 0]],
        cell: [[6, 0, 0], [0, 6, 0], [0, 0, 6]],
        calculator: { energy: -2 },
      }),
    ]
    const header = Buffer.alloc(48)
    header.write(`- of Ulm`, 0, `utf8`)
    header.writeBigInt64LE(3n, 24)
    header.writeBigInt64LE(2n, 32)
    header.writeBigInt64LE(48n, 40)
    const table = Buffer.alloc(16)
    const first_offset = 64
    const first_record = Buffer.concat([
      bigint_buffer(frame_json[0].length),
      Buffer.from(frame_json[0]),
    ])
    const second_offset = first_offset + first_record.length
    const second_record = Buffer.concat([
      bigint_buffer(frame_json[1].length),
      Buffer.from(frame_json[1]),
    ])
    table.writeBigInt64LE(BigInt(first_offset), 0)
    table.writeBigInt64LE(BigInt(second_offset), 8)
    const file_path = await fixture(
      `sample.traj`,
      Buffer.concat([header, table, first_record, second_record]),
    )

    const loader = await NodeASEFrameLoader.create(file_path, `sample.traj`)
    try {
      expect(await loader.get_total_frames(``)).toBe(2)
      const frame = await loader.load_frame_positions(``, 1)
      expect(Array.from(frame?.positions ?? [])).toEqual([0.5, 0, 0, 1.5, 0, 0])
      expect(frame?.lattice?.[0][0]).toBe(6)
      expect(frame?.topology_changed).toBe(false)
    } finally {
      await loader.dispose()
    }
  })

  test(`inflates gzip once and keeps the decompressed trajectory file-backed`, async () => {
    const source = [
      `2`, `energy=-1`, `H 0 0 0`, `O 1 0 0`,
      `1`, `energy=-2`, `He 2 0 0`,
    ].join(`\n`)
    const file_path = await fixture(`variable.extxyz.gz`, gzipSync(source))
    const local = await create_local_trajectory_loader(file_path, `variable.extxyz.gz`)
    expect(local).not.toBeNull()
    try {
      const manifest = await build_local_trajectory_manifest(local!)
      expect(manifest.total_frames).toBe(2)
      expect(manifest.frames[0].structure.sites).toHaveLength(2)
      expect(manifest.frames[1].structure.sites).toHaveLength(1)
      expect(await local!.loader.load_frame_positions?.(``, 1)).toMatchObject({
        topology_changed: true,
      })
    } finally {
      await local?.loader.dispose?.()
    }
  })

  test(`indexes JSON frame objects without parsing the complete document`, async () => {
    const structure = (element: string, x: number) => ({
      structure: {
        lattice: { matrix: [[5, 0, 0], [0, 5, 0], [0, 0, 5]] },
        sites: [{ species: [{ element, occu: 1 }], xyz: [x, 0, 0], abc: [x / 5, 0, 0] }],
      },
      metadata: { energy: -x },
    })
    const file_path = await fixture(
      `relax-frames.json`,
      JSON.stringify({ metadata: { label: `fixture` }, frames: [structure(`H`, 1), structure(`He`, 2)] }),
    )
    const loader = await NodeJSONFrameLoader.create(file_path, `relax-frames.json`)
    try {
      expect(await loader.get_total_frames()).toBe(2)
      const second = await loader.load_frame_positions(``, 1)
      expect(Array.from(second?.positions ?? [])).toEqual([2, 0, 0])
      expect(second?.topology_changed).toBe(true)
    } finally {
      await loader.dispose()
    }
  })

  test(`seeks coordinate arrays in pymatgen Trajectory JSON`, async () => {
    const file_path = await fixture(
      `pymatgen-relax.json`,
      JSON.stringify({
        '@class': `Trajectory`,
        species: [{ element: `H` }, { element: `O` }],
        lattice: [[4, 0, 0], [0, 4, 0], [0, 0, 4]],
        coords: [
          [[0, 0, 0], [0.5, 0, 0]],
          [[0.25, 0, 0], [0.75, 0, 0]],
        ],
      }),
    )
    const loader = await NodeJSONFrameLoader.create(file_path, `pymatgen-relax.json`)
    try {
      const second = await loader.load_frame_positions(``, 1)
      expect(Array.from(second?.positions ?? [])).toEqual([1, 0, 0, 3, 0, 0])
      expect(second?.topology_changed).toBe(false)
    } finally {
      await loader.dispose()
    }
  })

  test(`seeks XDATCAR configurations and honors repeated NPT cells`, async () => {
    const file_path = await fixture(`XDATCAR`, [
      `constant cell`,
      `1`,
      `5 0 0`,
      `0 5 0`,
      `0 0 5`,
      `H O`,
      `1 1`,
      `Direct configuration=     1`,
      `0.0 0.0 0.0`,
      `0.5 0.5 0.5`,
      `NPT cell`,
      `1`,
      `6 0 0`,
      `0 6 0`,
      `0 0 6`,
      `H O`,
      `1 1`,
      `Direct configuration=     2`,
      `0.0 0.0 0.0`,
      `0.5 0.5 0.5`,
    ].join(`\n`))
    const loader = await NodeXdatcarFrameLoader.create(file_path, `XDATCAR`)
    try {
      expect(await loader.get_total_frames(``)).toBe(2)
      const second = await loader.load_frame_positions(``, 1)
      expect(second?.lattice?.[0][0]).toBe(6)
      expect(Array.from(second?.positions ?? []).slice(3)).toEqual([3, 3, 3])
    } finally {
      await loader.dispose()
    }
  })

  test(`indexes OUTCAR ionic steps with per-step lattice, force, and energy`, async () => {
    const file_path = await fixture(`OUTCAR`, [
      ` VRHFIN =H:`,
      ` ions per type = 2`,
      ` direct lattice vectors`,
      ` 5 0 0  0 0 0`,
      ` 0 5 0  0 0 0`,
      ` 0 0 5  0 0 0`,
      ` POSITION                                       TOTAL-FORCE (eV/Angst)`,
      ` -----------------------------------------------------------------------------------`,
      ` 0 0 0  0.1 0.2 0.3`,
      ` 1 0 0  0.4 0.5 0.6`,
      ` free energy TOTEN = -10.0 eV`,
      ` energy(sigma->0) = -9.9`,
      ` direct lattice vectors`,
      ` 6 0 0  0 0 0`,
      ` 0 6 0  0 0 0`,
      ` 0 0 6  0 0 0`,
      ` POSITION                                       TOTAL-FORCE (eV/Angst)`,
      ` -----------------------------------------------------------------------------------`,
      ` 0 0 0  1.1 1.2 1.3`,
      ` 2 0 0  1.4 1.5 1.6`,
      ` energy(sigma->0) = -11.1`,
    ].join(`\n`))
    const loader = await NodeOutcarFrameLoader.create(file_path, `OUTCAR`)
    try {
      expect(await loader.get_total_frames(``)).toBe(2)
      const second = await loader.load_frame_positions(``, 1)
      expect(second?.lattice?.[0][0]).toBe(6)
      expect(second?.metadata?.energy).toBe(-11.1)
      expect(Array.from(second?.forces ?? []).slice(0, 3)).toEqual([
        expect.closeTo(1.1),
        expect.closeTo(1.2),
        expect.closeTo(1.3),
      ])
    } finally {
      await loader.dispose()
    }
  })

  test(`indexes LAMMPS dump timesteps`, async () => {
    const lammps_frame = (step: number, x: number) => [
      `ITEM: TIMESTEP`,
      String(step),
      `ITEM: NUMBER OF ATOMS`,
      `1`,
      `ITEM: BOX BOUNDS pp pp pp`,
      `0 10`,
      `0 10`,
      `0 10`,
      `ITEM: ATOMS id type x y z`,
      `1 6 ${x} 0 0`,
    ].join(`\n`)
    const file_path = await fixture(
      `dump.lammpstrj`,
      `${lammps_frame(0, 1)}\n${lammps_frame(100, 2)}\n`,
    )
    const loader = await NodeLammpsFrameLoader.create(file_path, `dump.lammpstrj`)
    try {
      const second = await loader.load_frame_positions(``, 1)
      expect(second?.step).toBe(100)
      expect(Array.from(second?.positions ?? [])).toEqual([2, 0, 0])
    } finally {
      await loader.dispose()
    }
  })

  test(`slices vasprun.xml calculations without parsing the whole XML`, async () => {
    const calculation = (x: number, energy: number) => [
      `<calculation>`,
      `<energy><i name="e_fr_energy">${energy}</i></energy>`,
      `<structure><crystal><varray name="basis">`,
      `<v>5 0 0</v><v>0 5 0</v><v>0 0 5</v>`,
      `</varray></crystal><varray name="positions">`,
      `<v>${x} 0 0</v><v>0.5 0.5 0.5</v>`,
      `</varray></structure>`,
      `<varray name="forces"><v>0.1 0 0</v><v>0.2 0 0</v></varray>`,
      `</calculation>`,
    ].join(`\n`)
    const file_path = await fixture(`vasprun.xml`, [
      `<modeling>`,
      `<atominfo><array name="atoms"><set>`,
      `<rc><c>H</c></rc><rc><c>O</c></rc>`,
      `</set></array></atominfo>`,
      calculation(0, -1),
      calculation(0.2, -2),
      `</modeling>`,
    ].join(`\n`))
    const loader = await NodeVasprunFrameLoader.create(file_path, `vasprun.xml`)
    try {
      const second = await loader.load_frame_positions(``, 1)
      expect(second?.metadata?.energy).toBe(-2)
      expect(Array.from(second?.positions ?? []).slice(0, 3)).toEqual([1, 0, 0])
      expect(Array.from(second?.forces ?? []).slice(0, 3)).toEqual([
        expect.closeTo(0.1),
        0,
        0,
      ])
    } finally {
      await loader.dispose()
    }
  })

  test(`preserves physical Path-2 → TS → Path-1 ordering for Gaussian IRC`, async () => {
    const orientation = (x: number, energy: number) => [
      ` Input orientation:`,
      ` ---------------------------------------------------------------------`,
      ` Center     Atomic      Atomic             Coordinates (Angstroms)`,
      ` Number     Number       Type             X           Y           Z`,
      ` ---------------------------------------------------------------------`,
      `      1          6           0        ${x}    0.000000    0.000000`,
      ` ---------------------------------------------------------------------`,
      ` SCF Done:  E(RB3LYP) =  ${energy}     A.U. after 10 cycles`,
    ].join(`\n`) + `\n`
    const point = (point_number: number, path_number: number) =>
      ` Point Number: ${point_number} Path Number: ${path_number}\n`
    const file_path = await fixture(`irc.log`, [
      ` Entering Gaussian System`,
      ` IRC-IRC-IRC-IRC-IRC-`,
      ` Redundant internal coordinates found in file.  (old form).`,
      ` C,0,0.000000,0.000000,0.000000`,
      ` Recover connectivity data from disk.`,
      ` Energy From Chk = -10.0`,
      point(0, 1).trimEnd(),
      orientation(1, -10.1).trimEnd(),
      point(1, 1).trimEnd(),
      orientation(2, -10.2).trimEnd(),
      point(2, 1).trimEnd(),
      orientation(3, -10.3).trimEnd(),
      point(1, 2).trimEnd(),
      orientation(4, -10.4).trimEnd(),
      point(2, 2).trimEnd(),
    ].join(`\n`) + `\n`)
    const loader = await NodeGaussianFrameLoader.create(file_path, `irc.log`)
    try {
      const total = await loader.get_total_frames(``)
      const frames = await Promise.all(
        Array.from({ length: total }, (_, idx) => loader.load_frame(``, idx)),
      )
      expect(frames.map((frame) => frame?.structure.sites[0].xyz[0])).toEqual([
        4,
        3,
        0,
        1,
        2,
      ])
      expect(frames[2]?.metadata?.is_transition_state).toBe(true)
    } finally {
      await loader.dispose()
    }
  })

  test(`indexes ORCA output geometries independently from Gaussian logs`, async () => {
    const geometry = (x: number, energy: number) => [
      `CARTESIAN COORDINATES (ANGSTROEM)`,
      `---------------------------------`,
      `C ${x} 0 0`,
      `H ${x + 1} 0 0`,
      ``,
      `FINAL SINGLE POINT ENERGY ${energy}`,
    ].join(`\n`)
    const file_path = await fixture(
      `orca.out`,
      `O   R   C   A\n${geometry(0, -20)}\n${geometry(2, -21)}`,
    )
    const loader = await NodeOrcaFrameLoader.create(file_path, `orca.out`)
    try {
      expect(await loader.get_total_frames(``)).toBe(2)
      const second = await loader.load_frame(``, 1)
      expect(second?.structure.sites.map((site) => site.species[0].element)).toEqual([
        `C`, `H`,
      ])
      expect(second?.structure.sites[1].xyz).toEqual([3, 0, 0])
      expect(second?.metadata?.energy).toBe(-21)
    } finally {
      await loader.dispose()
    }
  })

  test(`reads HDF5 frames through hyperslabs`, async () => {
    const dir = await mkdtemp(join(tmpdir(), `catgo-hdf5-reader-`))
    temp_dirs.push(dir)
    const file_path = join(dir, `trajectory.h5`)
    const h5 = await import(`h5wasm/node`)
    await h5.ready
    const file = new h5.File(file_path, `w`)
    file.create_dataset({
      name: `positions`,
      data: Array.from({ length: 12 }, (_, idx) => idx),
      shape: [2, 2, 3],
      dtype: `<d`,
    })
    file.create_dataset({
      name: `atomic_numbers`,
      data: [1, 8],
      shape: [2],
      dtype: `<i`,
    })
    file.create_dataset({
      name: `cell`,
      data: [
        5, 0, 0, 0, 5, 0, 0, 0, 5,
        6, 0, 0, 0, 6, 0, 0, 0, 6,
      ],
      shape: [2, 3, 3],
      dtype: `<d`,
    })
    file.create_dataset({
      name: `energy`,
      data: [-1, -2],
      shape: [2],
      dtype: `<d`,
    })
    file.close()

    const loader = await NodeHDF5FrameLoader.create(file_path, `trajectory.h5`)
    try {
      const second = await loader.load_frame_positions(``, 1)
      expect(Array.from(second?.positions ?? [])).toEqual([6, 7, 8, 9, 10, 11])
      expect(second?.lattice?.[0][0]).toBe(6)
      expect(second?.metadata?.energy).toBe(-2)
    } finally {
      loader.dispose()
    }
  })

  test(`reads official VASP vaspout.h5 ion-dynamics datasets`, async () => {
    const dir = await mkdtemp(join(tmpdir(), `catgo-vasp-hdf5-reader-`))
    temp_dirs.push(dir)
    const file_path = join(dir, `vaspout.h5`)
    const h5 = await import(`h5wasm/node`)
    await h5.ready
    const file = new h5.File(file_path, `w`)
    const poscar = file.create_group(`input`).create_group(`poscar`)
    poscar.create_dataset({
      name: `ion_types`,
      data: [`H`, `O`],
      shape: [2],
      dtype: `S1`,
    })
    poscar.create_dataset({
      name: `number_ion_types`,
      data: [1, 1],
      shape: [2],
      dtype: `<i`,
    })
    const dynamics = file.create_group(`intermediate`).create_group(`ion_dynamics`)
    dynamics.create_dataset({
      name: `position_ions`,
      data: [
        0, 0, 0, 0.5, 0, 0,
        0.25, 0, 0, 0.75, 0, 0,
      ],
      shape: [2, 2, 3],
      dtype: `<d`,
    })
    dynamics.create_dataset({
      name: `lattice_vectors`,
      data: [
        4, 0, 0, 0, 4, 0, 0, 0, 4,
        8, 0, 0, 0, 8, 0, 0, 0, 8,
      ],
      shape: [2, 3, 3],
      dtype: `<d`,
    })
    dynamics.create_dataset({
      name: `forces`,
      data: Array.from({ length: 12 }, (_, idx) => idx / 10),
      shape: [2, 2, 3],
      dtype: `<d`,
    })
    dynamics.create_dataset({
      name: `energies`,
      data: [-10, -11, -12, -20, -21, -22],
      shape: [2, 3],
      dtype: `<d`,
    })
    file.close()

    const loader = await NodeHDF5FrameLoader.create(file_path, `vaspout.h5`)
    try {
      const second = await loader.load_frame(``, 1)
      expect(second?.structure.sites.map((site) => site.species[0].element)).toEqual([
        `H`, `O`,
      ])
      expect(second?.structure.sites.map((site) => site.xyz)).toEqual([
        [2, 0, 0], [6, 0, 0],
      ])
      expect(second?.metadata?.energy).toBe(-22)
      expect(second?.structure.sites[1].properties?.force).toEqual([0.9, 1, 1.1])
    } finally {
      loader.dispose()
    }
  })
})

function bigint_buffer(value: number): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeBigInt64LE(BigInt(value))
  return buffer
}
