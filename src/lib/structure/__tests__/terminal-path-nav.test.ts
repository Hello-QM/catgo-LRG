import { describe, it, expect, vi, afterEach } from 'vitest'
import { open_terminal_click, path_is_directory } from '../terminal-path-nav'

describe('open_terminal_click', () => {
  it('navigates the Files panel when the path is a directory', async () => {
    const open_file = vi.fn()
    const navigate_dir = vi.fn()
    await open_terminal_click(
      '/home/u/proj/iso_search',
      '',
      { open_file, navigate_dir },
      async () => true, // is_directory
    )
    expect(navigate_dir).toHaveBeenCalledWith('/home/u/proj/iso_search', '')
    expect(open_file).not.toHaveBeenCalled()
  })

  it('opens the file when the path is NOT a directory', async () => {
    const open_file = vi.fn()
    const navigate_dir = vi.fn()
    await open_terminal_click(
      '/home/u/proj/ir20_bare_distinct.extxyz',
      '',
      { open_file, navigate_dir },
      async () => false, // is_directory
    )
    expect(open_file).toHaveBeenCalledWith('/home/u/proj/ir20_bare_distinct.extxyz', '')
    expect(navigate_dir).not.toHaveBeenCalled()
  })

  it('forwards the remote session_id to navigate_dir for remote terminals', async () => {
    const open_file = vi.fn()
    const navigate_dir = vi.fn()
    await open_terminal_click(
      '/scratch/run42',
      'sess-abc',
      { open_file, navigate_dir },
      async () => true,
    )
    expect(navigate_dir).toHaveBeenCalledWith('/scratch/run42', 'sess-abc')
  })

  it('forwards the remote session_id to open_file for a remote file (regression)', async () => {
    const open_file = vi.fn()
    const navigate_dir = vi.fn()
    await open_terminal_click(
      '/home/jzhang89/build_prod500.py',
      'sess-abc',
      { open_file, navigate_dir },
      async () => false, // it's a file
    )
    // Bug: open_file was called with only the path, dropping session_id — so the
    // file-open handler read the LOCAL fs instead of the remote SSH session, and an
    // existing remote file came back "Not found".
    expect(open_file).toHaveBeenCalledWith('/home/jzhang89/build_prod500.py', 'sess-abc')
    expect(navigate_dir).not.toHaveBeenCalled()
  })

  it('treats a detection failure as a file (safe fallback)', async () => {
    const open_file = vi.fn()
    const navigate_dir = vi.fn()
    await open_terminal_click(
      '/maybe/gone',
      '',
      { open_file, navigate_dir },
      async () => false, // path_is_directory swallows errors → false
    )
    expect(open_file).toHaveBeenCalledWith('/maybe/gone', '')
    expect(navigate_dir).not.toHaveBeenCalled()
  })
})

describe('path_is_directory (local browse shape-check)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const stub_fetch = (res: Partial<Response> & { json?: () => Promise<unknown> }) =>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res))

  it('is true only for a real directory-listing JSON (has items array)', async () => {
    stub_fetch({ ok: true, json: async () => ({ dir: '/d', parent: '/', items: [] }) })
    expect(await path_is_directory('/d', '')).toBe(true)
  })

  it('is false for an SPA-fallback 200 text/html (json parse throws)', async () => {
    stub_fetch({ ok: true, json: async () => { throw new Error('not json') } })
    expect(await path_is_directory('/some/file.cif', '')).toBe(false)
  })

  it('is false for the STATIC_ONLY 200 stub ({detail}, no items)', async () => {
    stub_fetch({ ok: true, json: async () => ({ detail: 'requires desktop app' }) })
    expect(await path_is_directory('/some/file.cif', '')).toBe(false)
  })

  it('is false on a 404 (backend: not a directory)', async () => {
    stub_fetch({ ok: false, json: async () => ({ detail: 'Not a directory' }) })
    expect(await path_is_directory('/some/file.cif', '')).toBe(false)
  })
})
