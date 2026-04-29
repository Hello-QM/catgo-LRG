import { decompress_data } from '$lib/io/decompress'

export async function fetch_zipped<T>(
  url: string,
  { unzip = true } = {},
): Promise<T | null> {
  const response = await fetch(url)
  if (!response.ok) {
    console.error(
      `${response.status} ${response.statusText} for ${response.url}`,
    )
    return null
  }
  if (!unzip) return (await response.blob()) as T
  return JSON.parse(await decompress_data(response.body, `gzip`))
}

// Map MIME types to file extensions for the Save As dialog
const mime_to_ext: Record<string, { description: string; accept: Record<string, string[]> }> = {
  'image/png': { description: `PNG Image`, accept: { 'image/png': [`.png`] } },
  'image/svg+xml': { description: `SVG Image`, accept: { 'image/svg+xml': [`.svg`] } },
  'image/svg+xml;charset=utf-8': { description: `SVG Image`, accept: { 'image/svg+xml': [`.svg`] } },
  'application/json': { description: `JSON File`, accept: { 'application/json': [`.json`] } },
  'chemical/x-xyz': { description: `XYZ File`, accept: { 'chemical/x-xyz': [`.xyz`] } },
  'chemical/x-cif': { description: `CIF File`, accept: { 'chemical/x-cif': [`.cif`] } },
  'application/zip': { description: `ZIP Archive`, accept: { 'application/zip': [`.zip`] } },
  'video/webm': { description: `WebM Video`, accept: { 'video/webm': [`.webm`] } },
  'image/tiff': { description: `TIFF Image`, accept: { 'image/tiff': [`.tif`, `.tiff`] } },
  'image/jpeg': { description: `JPEG Image`, accept: { 'image/jpeg': [`.jpg`, `.jpeg`] } },
  'application/pdf': { description: `PDF Document`, accept: { 'application/pdf': [`.pdf`] } },
}

// Try using File System Access API (shows Save As dialog), fall back to <a> download
// Try File System Access API for Save As dialog, returns false only if API unavailable
async function save_with_dialog(blob: Blob, filename: string, type: string): Promise<boolean> {
  if (typeof window === `undefined` || !(`showSaveFilePicker` in window)) return false
  const ext_info = mime_to_ext[type]
  // showSaveFilePicker throws AbortError if user cancels — that's fine
  const handle = await (window as any).showSaveFilePicker({
    suggestedName: filename,
    types: ext_info ? [ext_info] : undefined,
  })
  const writable = await handle.createWritable()
  await writable.write(blob)
  await writable.close()
  return true
}

// Fallback download via hidden <a> link (saves to Downloads folder)
function fallback_download(file: Blob, filename: string) {
  const link = document.createElement(`a`)
  const url = URL.createObjectURL(file)
  link.style.display = `none`
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

// Original download implementation — tries Save As dialog first
function default_download(data: string | Blob, filename: string, type: string) {
  const file = data instanceof Blob ? data : new Blob([data], { type })
  save_with_dialog(file, filename, type).then((saved) => {
    // If Save As dialog succeeded, we're done
    if (saved) return
    // API not available — fall back to <a> link download
    fallback_download(file, filename)
  }).catch((err: any) => {
    // AbortError = user cancelled the dialog, don't fall back
    if (err?.name === `AbortError`) return
    // Other error — use fallback
    fallback_download(file, filename)
  })
}

// Function to download data to a file - checks for global override first
export function download(data: string | Blob, filename: string, type: string): void {
  // Check if there's a global download override (used by VSCode extension or Tauri)
  const global_download = (globalThis as Record<string, unknown>).download
  if (typeof global_download === `function` && global_download !== download) {
    // Handle async download functions (like Tauri)
    const result = global_download(data, filename, type)
    if (result instanceof Promise) {
      // Fire and forget for async downloads (Tauri will show dialog)
      result.catch((error) => {
        console.error('Download error:', error)
        // Fallback to browser download on error
        default_download(data, filename, type)
      })
      return
    }
    return
  }

  // Use default browser download
  return default_download(data, filename, type)
}
