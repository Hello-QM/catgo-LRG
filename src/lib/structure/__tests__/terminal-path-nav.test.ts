import { describe, it, expect, vi } from 'vitest'
import { open_terminal_click } from '../terminal-path-nav'

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
    expect(open_file).toHaveBeenCalledWith('/home/u/proj/ir20_bare_distinct.extxyz')
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

  it('treats a detection failure as a file (safe fallback)', async () => {
    const open_file = vi.fn()
    const navigate_dir = vi.fn()
    await open_terminal_click(
      '/maybe/gone',
      '',
      { open_file, navigate_dir },
      async () => false, // path_is_directory swallows errors → false
    )
    expect(open_file).toHaveBeenCalledWith('/maybe/gone')
    expect(navigate_dir).not.toHaveBeenCalled()
  })
})
