import { describe, it, expect, vi } from 'vitest'

vi.mock('$lib/api/project', () => ({
  read_file: vi.fn(async (p: string) => ({ path: p, name: 'a.txt', content: 'LOCAL' })),
  write_file: vi.fn(async (p: string) => ({ path: p, name: 'a.txt' })),
}))
vi.mock('$lib/api/hpc', () => ({
  readRemoteFile: vi.fn(async () => ({ success: true, content: 'REMOTE', total_lines: 1, message: '' })),
  readRemoteBinaryFile: vi.fn(async () => ({ success: true, data: 'BASE64', mime_type: 'application/pdf', size: 3 })),
  writeRemoteFile: vi.fn(async () => ({ success: true, message: '' })),
}))

import { load_doc_content } from '../../../src/lib/viewer/doc-content'
import type { DocTab } from '../../../src/lib/viewer/doc-viewer-state.svelte'

const tab = (over: Partial<DocTab>): DocTab => ({
  id: 'd1', filename: 'a.txt', kind: 'text', editable: true,
  origin: null, local_path: '/tmp/a.txt', inline: null, dirty: false, view: 'edit', ...over,
})

describe('load_doc_content', () => {
  it('reads local text', async () => {
    expect(await load_doc_content(tab({}))).toEqual({ text: 'LOCAL', binary: null, mime: null })
  })
  it('reads remote text', async () => {
    const r = await load_doc_content(tab({ origin: { session_id: 's', file_path: '/r/a.txt' }, local_path: null }))
    expect(r.text).toBe('REMOTE')
  })
  it('reads remote binary for pdf', async () => {
    const r = await load_doc_content(tab({ kind: 'pdf', filename: 'd.pdf', origin: { session_id: 's', file_path: '/r/d.pdf' }, local_path: null }))
    expect(r).toEqual({ text: null, binary: 'BASE64', mime: 'application/pdf' })
  })
  it('reads inline text carried in the ref', async () => {
    const r = await load_doc_content(tab({ local_path: null, inline: { text: 'INLINE', binary: null, mime: null } }))
    expect(r.text).toBe('INLINE')
  })
  it('reads inline binary carried in the ref', async () => {
    const r = await load_doc_content(tab({ local_path: null, inline: { text: null, binary: 'B64', mime: 'image/png' } }))
    expect(r).toEqual({ text: null, binary: 'B64', mime: 'image/png' })
  })
  it('reads local-path binary via the blank-session read-binary route', async () => {
    // Regression: this used to return {binary: null} ("no local binary API"),
    // so a local PDF rendered as an empty pane. A blank session_id maps to the
    // backend's local-filesystem connection since #451.
    const { readRemoteBinaryFile } = await import('$lib/api/hpc')
    const r = await load_doc_content(tab({ kind: 'pdf', filename: 'd.pdf', local_path: '/tmp/d.pdf', origin: null, inline: null }))
    expect(readRemoteBinaryFile).toHaveBeenCalledWith('', '/tmp/d.pdf')
    expect(r).toEqual({ text: null, binary: 'BASE64', mime: 'application/pdf' })
  })
})
