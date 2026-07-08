import { afterEach, describe, expect, it, vi } from 'vitest'
import { download_file } from '../common-export'

// Regression: the export panels' download buttons (INCAR/POSCAR/KPOINTS, etc.)
// did nothing in the Tauri desktop app because download_file used a raw
// `<a download>.click()`, which WebKitGTK silently ignores. It must instead
// route through the shared download() helper, which uses the native save
// override installed by init_tauri (globalThis.download).
describe('download_file', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).download
    vi.restoreAllMocks()
  })

  it('routes through the global download override (Tauri native save)', () => {
    const spy = vi.fn()
    ;(globalThis as Record<string, unknown>).download = spy
    download_file('Automatic kpoint scheme\n0\nGamma\n3 2 1\n', 'KPOINTS')
    expect(spy).toHaveBeenCalledWith(
      'Automatic kpoint scheme\n0\nGamma\n3 2 1\n',
      'KPOINTS',
      'text/plain',
    )
  })
})
