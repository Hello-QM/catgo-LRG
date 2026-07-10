import { describe, it, expect, vi } from 'vitest'
import { gunzipSync } from 'node:zlib'
// CatgoDocument lives in its own VS-Code-free module (re-exported by
// extension.ts). Importing it directly here keeps this unit test off the
// heavy extension.ts import chain (Svelte/@threlte/ferrox-wasm) — see
// task-A2 report for the controller-sanctioned deviation rationale.
import { CatgoDocument } from '../catgo-document'

describe('CatgoDocument', () => {
  it('marks dirty on a dirty signal and clears after save', async () => {
    const uri = { fsPath: '/tmp/IS_raw.xyz' } as any
    const writes: Array<[string, Uint8Array]> = []
    const doc = new CatgoDocument(uri, {
      requestContent: async () => ({ content: 'XYZ...', is_binary: false }),
      writeFile: async (u: any, data: Uint8Array) => { writes.push([u.fsPath, data]) },
    })
    const changed = vi.fn()
    doc.onDidChange(changed)
    doc.signalEdit()
    expect(changed).toHaveBeenCalledTimes(1)
    await doc.save()
    expect(writes[0][0]).toBe('/tmp/IS_raw.xyz')
    expect(new TextDecoder().decode(writes[0][1])).toBe('XYZ...')
  })

  it('rejects (no write, error surfaced) when the webview returns empty content', async () => {
    const uri = { fsPath: '/tmp/OUTCAR' } as any
    const writes: Array<[string, Uint8Array]> = []
    const showError = vi.fn()
    const doc = new CatgoDocument(uri, {
      requestContent: async () => ({ content: '', is_binary: false }),
      writeFile: async (u: any, data: Uint8Array) => { writes.push([u.fsPath, data]) },
      showError,
    })
    await expect(doc.save()).rejects.toThrow(/not editable/i)
    expect(writes.length).toBe(0)
    expect(showError).toHaveBeenCalledTimes(1)
  })

  it('re-gzips content before writing a .gz target', async () => {
    const uri = { fsPath: '/tmp/POSCAR.xyz.gz' } as any
    const writes: Array<[string, Uint8Array]> = []
    const doc = new CatgoDocument(uri, {
      requestContent: async () => ({ content: 'XYZ...', is_binary: false }),
      writeFile: async (u: any, data: Uint8Array) => { writes.push([u.fsPath, data]) },
    })
    await doc.save()
    expect(writes[0][0]).toBe('/tmp/POSCAR.xyz.gz')
    // Bytes on disk must be a valid gzip stream that decompresses to the text.
    expect(new TextDecoder().decode(gunzipSync(writes[0][1]))).toBe('XYZ...')
  })

  it('propagates a requestContent rejection (e.g. webview timeout) without writing', async () => {
    // The Provider's requestContentFor rejects on timeout / panel dispose; a
    // rejected save must reach VS Code (tab stays open & dirty) and not write.
    const uri = { fsPath: '/tmp/IS_raw.xyz' } as any
    const writes: Array<[string, Uint8Array]> = []
    const doc = new CatgoDocument(uri, {
      requestContent: async () => {
        throw new Error('CatGo viewer did not return the file content (timeout)')
      },
      writeFile: async (u: any, data: Uint8Array) => { writes.push([u.fsPath, data]) },
    })
    await expect(doc.save()).rejects.toThrow(/timeout/)
    expect(writes.length).toBe(0)
  })
})
