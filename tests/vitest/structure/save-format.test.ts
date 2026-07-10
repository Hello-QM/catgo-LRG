import { describe, expect, it } from 'vitest'
import { save_format_from_path } from '$lib/structure/save-format'

describe(`save_format_from_path`, () => {
  it(`maps every faithfully-serializable extension to its serializer format`, () => {
    expect(save_format_from_path(`/a/b/model.cif`)).toBe(`cif`)
    expect(save_format_from_path(`/a/b/model.xyz`)).toBe(`xyz`)
    expect(save_format_from_path(`/a/b/model.extxyz`)).toBe(`extxyz`)
    expect(save_format_from_path(`/a/b/model.poscar`)).toBe(`poscar`)
    expect(save_format_from_path(`/a/b/model.vasp`)).toBe(`poscar`)
    expect(save_format_from_path(`/a/b/model.contcar`)).toBe(`poscar`)
    expect(save_format_from_path(`/a/b/model.json`)).toBe(`json`)
    expect(save_format_from_path(`/a/b/model.mol2`)).toBe(`mol2`)
    expect(save_format_from_path(`/a/b/model.pdb`)).toBe(`pdb`)
  })

  it(`is case-insensitive on the extension`, () => {
    expect(save_format_from_path(`FOO.CIF`)).toBe(`cif`)
    expect(save_format_from_path(`Foo.MOL2`)).toBe(`mol2`)
    expect(save_format_from_path(`Foo.PDB`)).toBe(`pdb`)
    expect(save_format_from_path(`Foo.ExtXYZ`)).toBe(`extxyz`)
  })

  it(`matches extension-less POSCAR/CONTCAR by filename (incl. suffixed variants)`, () => {
    expect(save_format_from_path(`POSCAR`)).toBe(`poscar`)
    expect(save_format_from_path(`CONTCAR`)).toBe(`poscar`)
    expect(save_format_from_path(`/scratch/run/POSCAR`)).toBe(`poscar`)
    expect(save_format_from_path(`/scratch/run/CONTCAR`)).toBe(`poscar`)
    expect(save_format_from_path(`POSCAR_relaxed`)).toBe(`poscar`)
    expect(save_format_from_path(`CONTCAR_1`)).toBe(`poscar`)
    expect(save_format_from_path(`poscar`)).toBe(`poscar`) // lowercase
  })

  it(`handles Windows-style backslash paths`, () => {
    expect(save_format_from_path(`C:\\Users\\me\\model.mol2`)).toBe(`mol2`)
    expect(save_format_from_path(`C:\\Users\\me\\POSCAR`)).toBe(`poscar`)
    expect(save_format_from_path(`C:\\Users\\me\\slab.pdb`)).toBe(`pdb`)
  })

  it(`refuses (null) sources with no faithful serializer`, () => {
    // Formats CatGO can PARSE but has no faithful frontend serializer for.
    expect(save_format_from_path(`/a/b/dump.data`)).toBeNull() // LAMMPS data
    expect(save_format_from_path(`/a/b/model.xsf`)).toBeNull()
    expect(save_format_from_path(`/a/b/model.lmp`)).toBeNull()
    expect(save_format_from_path(`/a/b/OUTCAR`)).toBeNull()
    expect(save_format_from_path(`/a/b/vasprun.xml`)).toBeNull()
    // Extension-less non-POSCAR files must not be silently CIF-ified.
    expect(save_format_from_path(`notes`)).toBeNull()
    expect(save_format_from_path(`/a/b/README`)).toBeNull()
  })

  it(`refuses (null) compressed sources — never write plaintext into a .gz path`, () => {
    expect(save_format_from_path(`/a/b/model.cif.gz`)).toBeNull()
    expect(save_format_from_path(`/a/b/model.xyz.bz2`)).toBeNull()
    expect(save_format_from_path(`/a/b/model.poscar.xz`)).toBeNull()
    expect(save_format_from_path(`/a/b/model.pdb.zst`)).toBeNull()
    expect(save_format_from_path(`/a/b/POSCAR.gz`)).toBeNull()
  })

  it(`ignores directory components that look like extensions`, () => {
    // A ".cif" in a directory name must not be mistaken for the file format.
    expect(save_format_from_path(`/home/user.cif/model.mol2`)).toBe(`mol2`)
    expect(save_format_from_path(`/data.xyz/notes`)).toBeNull()
  })
})
