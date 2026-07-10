/**
 * Source-format-preserving save mapper (close/save guard).
 *
 * The binding plan constraint is: "Save in the SOURCE file's format — never
 * change format on save." This maps a source file path/name to the
 * `$lib/structure/export` serializer format that round-trips it faithfully.
 *
 * When a source has NO faithful serializer — an unknown extension, an
 * extension-less non-POSCAR file, or a compressed (.gz/.bz2/.xz/.zst/…) path —
 * this returns `null`. Callers MUST treat `null` as "refuse the silent save":
 * fall back to Save-As where a dialog is reachable, otherwise surface an error
 * and keep the tab open. They must NEVER fall back to writing CIF (or any other
 * format) into the source path, which would silently corrupt it.
 *
 * The set of faithful formats mirrors the serializers exported by
 * `$lib/structure/export`: poscar, xyz, extxyz, cif, json, mol2, pdb.
 *
 * DRIFT NOTE: the VS Code webview keeps its own copy of this dispatch in
 * `extensions/vscode/src/webview/main.ts` (`serialize_current`) for bundle
 * isolation. Keep the two in lockstep — this module is the desktop source of
 * truth. See that function's comment for the pointer back here.
 */

import { COMPRESSION_EXTENSIONS_REGEX } from '$lib/constants'

/** On-disk formats `$lib/structure/export` can faithfully serialize back to. */
export type SaveFormat = 'poscar' | 'xyz' | 'extxyz' | 'cif' | 'json' | 'mol2' | 'pdb'

/**
 * Map a source file path/name to the serializer format that PRESERVES its
 * on-disk format, or `null` when no faithful serializer exists (caller must
 * refuse the silent overwrite — see the module doc).
 */
export function save_format_from_path(path: string): SaveFormat | null {
  const base = path.split(/[/\\]/).pop() || ``
  // A compressed source (foo.cif.gz): the serializers emit plaintext, so
  // writing their output back into the .gz path would corrupt it. Refuse
  // rather than strip-and-mislabel.
  if (COMPRESSION_EXTENSIONS_REGEX.test(base)) return null
  const dot = base.lastIndexOf(`.`)
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ``
  switch (ext) {
    case `poscar`:
    case `vasp`:
    case `contcar`:
      return `poscar`
    case `xyz`:
      return `xyz`
    case `extxyz`:
      return `extxyz`
    case `cif`:
      return `cif`
    case `json`:
      return `json`
    case `mol2`:
      return `mol2`
    case `pdb`:
      return `pdb`
  }
  // Extension-less VASP files (POSCAR, CONTCAR, POSCAR_relaxed, CONTCAR_1, …).
  if (ext === `` && /^(poscar|contcar)/i.test(base)) return `poscar`
  return null
}
