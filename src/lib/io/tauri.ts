// Tauri-specific file handling
// This module provides Tauri-compatible implementations for file operations

let is_tauri = false

// Check if running in Tauri environment
export function check_tauri(): boolean {
  if (typeof window !== 'undefined') {
    is_tauri = '__TAURI__' in window || '__TAURI_INTERNALS__' in window
  }
  return is_tauri
}

// Initialize Tauri file handling overrides
export async function init_tauri(): Promise<void> {
  if (!check_tauri()) return

  try {
    // Dynamically import Tauri APIs only when in Tauri environment
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { writeFile, writeTextFile } = await import('@tauri-apps/plugin-fs') // Override global download function
    ;(globalThis as Record<string, unknown>).download = async (
      data: string | Blob,
      filename: string,
      _type: string,
    ) => {
      try {
        // Determine file type from filename extension
        const ext = filename.split('.').pop()?.toLowerCase() || ''

        // Build filters based on file type
        const filters: Array<{ name: string; extensions: string[] }> = [
          { name: 'All Files', extensions: ['*'] },
        ]

        // Add specific filters based on extension
        if (['cif', 'poscar', 'vasp', 'xyz', 'json', 'extxyz'].includes(ext)) {
          filters.push({
            name: 'Structure Files',
            extensions: ['cif', 'poscar', 'vasp', 'xyz', 'json', 'extxyz', 'cube', 'cub'],
          })
        }
        if (['in', 'pwi', 'pw'].includes(ext)) {
          filters.push({ name: 'Input Files', extensions: ['in', 'pwi', 'pw'] })
        }
        if (['png', 'svg', 'jpg', 'jpeg'].includes(ext)) {
          filters.push({ name: 'Images', extensions: ['png', 'svg', 'jpg', 'jpeg'] })
        }
        if (['incar', 'kpoints'].includes(ext)) {
          filters.push({ name: 'VASP Files', extensions: ['incar', 'poscar', 'kpoints'] })
        }
        if (['data'].includes(ext)) {
          filters.push({ name: 'Data Files', extensions: ['data', 'dat'] })
        }

        // Open save dialog
        const path = await save({
          defaultPath: filename,
          filters,
        })

        if (!path) {
          console.log('User cancelled file save dialog')
          return // User cancelled
        }

        if (data instanceof Blob) {
          // Convert Blob to Uint8Array
          const arrayBuffer = await data.arrayBuffer()
          const uint8Array = new Uint8Array(arrayBuffer)
          await writeFile(path, uint8Array)
        } else {
          // Write string directly
          await writeTextFile(path, data)
        }

        console.log(`File saved to: ${path}`)
      } catch (error) {
        console.error('Tauri file save error:', error)
        // Re-throw so the download function can handle it
        throw error
      }
    }

    console.log('✅ Tauri file handling initialized - save dialogs enabled')
  } catch (error) {
    console.error('❌ Failed to initialize Tauri file handling:', error)
    console.warn('Downloads will use browser default behavior')
  }
}

const STRUCTURE_DIALOG_FILTERS = [
  {
    name: 'Structure Files',
    extensions: ['cif', 'poscar', 'vasp', 'xyz', 'json', 'extxyz', 'cube', 'cub', 'xml'],
  },
  { name: 'All Files', extensions: ['*'] },
]

export interface OpenedFile {
  content: string | ArrayBuffer
  filename: string
  path: string
}

/** Read a single absolute path as text, falling back to binary. */
async function read_one(path: string): Promise<OpenedFile> {
  const { readFile, readTextFile } = await import('@tauri-apps/plugin-fs')
  const filename = path.split(/[/\\]/).pop() || 'unknown'
  try {
    const content = await readTextFile(path)
    return { content, filename, path }
  } catch {
    const content = await readFile(path)
    return { content: content.buffer as ArrayBuffer, filename, path }
  }
}

// Open file dialog and read file content (single file — kept for legacy callers)
export async function open_file(): Promise<
  { content: string | ArrayBuffer; filename: string } | null
> {
  if (!check_tauri()) return null

  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const path = await open({ multiple: false, filters: STRUCTURE_DIALOG_FILTERS })
    if (!path || Array.isArray(path)) return null
    const { content, filename } = await read_one(path)
    return { content, filename }
  } catch (error) {
    console.error('Tauri file open error:', error)
    return null
  }
}

/** Open a multi-select file dialog; returns all chosen files (text or binary). */
export async function open_files(): Promise<OpenedFile[] | null> {
  if (!check_tauri()) return null

  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const picked = await open({ multiple: true, filters: STRUCTURE_DIALOG_FILTERS })
    if (!picked) return null
    const paths = Array.isArray(picked) ? picked : [picked]
    const out: OpenedFile[] = []
    for (const p of paths) {
      try {
        out.push(await read_one(p))
      } catch (err) {
        console.error('Tauri read error for', p, err)
      }
    }
    return out.length ? out : null
  } catch (error) {
    console.error('Tauri multi-file open error:', error)
    return null
  }
}

/** Recursively collect accepted file paths under `base` (depth/symlink/count guarded). */
async function walk_dir(
  base: string,
  accept: (filename: string) => boolean,
  collected: string[],
  depth: number,
  max_depth: number,
  max_files: number,
): Promise<void> {
  if (depth > max_depth || collected.length >= max_files) return
  const { readDir } = await import('@tauri-apps/plugin-fs')
  const { join } = await import('@tauri-apps/api/path')
  let entries
  try {
    entries = await readDir(base)
  } catch {
    return
  }
  for (const e of entries) {
    if (collected.length >= max_files) return
    if (e.isSymlink) continue
    const full = await join(base, e.name)
    if (e.isDirectory) {
      await walk_dir(full, accept, collected, depth + 1, max_depth, max_files)
    } else if (e.isFile && accept(e.name)) {
      collected.push(full)
    }
  }
}

async function read_paths(paths: string[]): Promise<OpenedFile[]> {
  const out: OpenedFile[] = []
  for (const p of paths) {
    try {
      out.push(await read_one(p))
    } catch (err) {
      console.error('Tauri read error for', p, err)
    }
  }
  return out
}

/**
 * Open a directory picker and return every recognizable structure file inside,
 * recursing up to `max_depth` levels (default 3). Symlinks are skipped and the
 * total is hard-capped to avoid pathological traversals.
 */
export async function open_folder(
  accept: (filename: string) => boolean,
  max_depth = 3,
  max_files = 500,
): Promise<OpenedFile[] | null> {
  if (!check_tauri()) return null

  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const dir = await open({ directory: true, multiple: false })
    if (!dir || Array.isArray(dir)) return null

    const collected: string[] = []
    await walk_dir(dir, accept, collected, 0, max_depth, max_files)
    const out = await read_paths(collected)
    return out.length ? out : null
  } catch (error) {
    console.error('Tauri folder open error:', error)
    return null
  }
}

/**
 * Expand a list of dropped paths (files and/or directories) into readable
 * files, filtering by `accept`. Directories are walked like open_folder.
 */
export async function read_dropped_paths(
  paths: string[],
  accept: (filename: string) => boolean,
  max_depth = 3,
  max_files = 500,
): Promise<OpenedFile[]> {
  if (!check_tauri()) return []
  const { stat } = await import('@tauri-apps/plugin-fs')
  const collected: string[] = []
  for (const p of paths) {
    if (collected.length >= max_files) break
    try {
      const info = await stat(p)
      if (info.isDirectory) {
        await walk_dir(p, accept, collected, 0, max_depth, max_files)
      } else if (info.isFile) {
        // Directly-dropped files are read regardless of extension, mirroring the
        // Open File dialog (which has no accept gate). `accept` still filters
        // the contents of dropped directories above.
        collected.push(p)
      }
    } catch (err) {
      console.error('Tauri stat error for', p, err)
    }
  }
  return read_paths(collected)
}
