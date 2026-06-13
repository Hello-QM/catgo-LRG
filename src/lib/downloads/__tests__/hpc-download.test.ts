import { describe, expect, it, vi } from 'vitest'
import { create_download_manager } from '../download-manager.svelte'
import { start_hpc_managed_download_with_deps, type HpcDownloadDeps } from '../hpc-download'

const input = {
  session_id: `s1`,
  remote_path: `/home/user/out.dat`,
  filename: `out.dat`,
  is_dir: false,
}

function response(bytes: Uint8Array): Response {
  const body = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(body).set(bytes)
  return new Response(body, {
    status: 200,
    headers: { 'Content-Length': String(bytes.byteLength) },
  })
}

function deps(overrides: Partial<HpcDownloadDeps> = {}): HpcDownloadDeps {
  return {
    manager: create_download_manager(),
    check_tauri: () => true,
    is_mobile: () => false,
    translate: (key) => key,
    get_download_url: vi.fn(() => `/api/hpc/download?x=1`),
    save_dialog: vi.fn(async () => `C:\\Users\\me\\Downloads\\out.dat`),
    fetch_impl: vi.fn(async () => response(new Uint8Array([1, 2, 3, 4]))) as unknown as typeof fetch,
    write_file: vi.fn(async (_path, data) => {
      if (data instanceof ReadableStream) {
        const reader = data.getReader()
        while (!(await reader.read()).done) {}
      }
    }),
    ...overrides,
  }
}

describe(`start_hpc_managed_download_with_deps`, () => {
  it(`returns false outside Tauri so browser download remains unchanged`, async () => {
    const d = deps({ check_tauri: () => false })

    await expect(start_hpc_managed_download_with_deps(input, d)).resolves.toBe(false)
    expect(d.manager.tasks).toHaveLength(0)
    expect(d.save_dialog).not.toHaveBeenCalled()
    expect(d.fetch_impl).not.toHaveBeenCalled()
  })

  it(`shows an explicit failed task on mobile`, async () => {
    const d = deps({
      is_mobile: () => true,
      translate: () => `mobile unsupported`,
    })

    await expect(start_hpc_managed_download_with_deps(input, d)).resolves.toBe(true)
    expect(d.manager.tasks).toHaveLength(1)
    expect(d.manager.tasks[0]).toMatchObject({
      filename: `out.dat`,
      platform: `mobile`,
      status: `failed`,
      error: `mobile unsupported`,
    })
    expect(d.fetch_impl).not.toHaveBeenCalled()
  })

  it(`marks the task canceled when the save dialog is canceled`, async () => {
    const d = deps({ save_dialog: vi.fn(async () => null) })

    await expect(start_hpc_managed_download_with_deps(input, d)).resolves.toBe(true)
    expect(d.manager.tasks[0].status).toBe(`canceled`)
    expect(d.fetch_impl).not.toHaveBeenCalled()
    expect(d.write_file).not.toHaveBeenCalled()
  })

  it(`streams desktop downloads to the selected path and updates progress`, async () => {
    const d = deps()

    await expect(start_hpc_managed_download_with_deps(input, d)).resolves.toBe(true)

    expect(d.get_download_url).toHaveBeenCalledWith(`s1`, `/home/user/out.dat`, {
      is_dir: false,
      skip_stat: false,
    })
    expect(d.write_file).toHaveBeenCalledTimes(1)
    expect(d.write_file).toHaveBeenCalledWith(`C:\\Users\\me\\Downloads\\out.dat`, expect.any(ReadableStream))
    expect(d.manager.tasks[0]).toMatchObject({
      status: `completed`,
      received_bytes: 4,
      total_bytes: 4,
      save_path: `C:\\Users\\me\\Downloads\\out.dat`,
    })
  })

  it(`uses skip_stat for directory archive downloads`, async () => {
    const d = deps()

    await start_hpc_managed_download_with_deps({ ...input, filename: `workdir.tar.gz`, is_dir: true }, d)

    expect(d.get_download_url).toHaveBeenCalledWith(`s1`, `/home/user/out.dat`, {
      is_dir: true,
      skip_stat: true,
    })
    expect(d.manager.tasks[0].is_archive).toBe(true)
  })
})
