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

// Open file dialog and read file content
export async function open_file(): Promise<
  { content: string | ArrayBuffer; filename: string } | null
> {
  if (!check_tauri()) return null

  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const { readFile, readTextFile } = await import('@tauri-apps/plugin-fs')

    const path = await open({
      multiple: false,
      filters: [
        {
          name: 'Structure Files',
          extensions: ['cif', 'poscar', 'vasp', 'xyz', 'json', 'extxyz', 'cube', 'cub', 'xml'],
        },
        { name: 'All Files', extensions: ['*'] },
      ],
    })

    if (!path || Array.isArray(path)) return null

    // Extract filename from path
    const filename = path.split(/[/\\]/).pop() || 'unknown'

    // Try to read as text first, fall back to binary
    try {
      const content = await readTextFile(path)
      return { content, filename }
    } catch {
      const content = await readFile(path)
      return { content: content.buffer as ArrayBuffer, filename }
    }
  } catch (error) {
    console.error('Tauri file open error:', error)
    return null
  }
}
