import { describe, expect, it } from 'vitest'
import { create_download_manager, format_download_size } from '../download-manager.svelte'

describe(`download manager`, () => {
  it(`adds new tasks at the top and opens the panel`, () => {
    const manager = create_download_manager()
    const first = manager.add({
      filename: `a.txt`,
      source_path: `/remote/a.txt`,
      platform: `desktop`,
      is_archive: false,
      status: `queued`,
      received_bytes: 0,
      total_bytes: 100,
    })
    const second = manager.add({
      filename: `b.txt`,
      source_path: `/remote/b.txt`,
      platform: `desktop`,
      is_archive: false,
      status: `downloading`,
      received_bytes: 25,
      total_bytes: 100,
    })

    expect(manager.panel_open).toBe(true)
    expect(manager.tasks.map((task) => task.id)).toEqual([second.id, first.id])
    expect(manager.tasks[0].updated_at).toBeGreaterThanOrEqual(manager.tasks[0].created_at)
  })

  it(`updates and removes tasks by id`, () => {
    const manager = create_download_manager()
    const task = manager.add({
      filename: `job.tar.gz`,
      source_path: `/remote/job`,
      platform: `desktop`,
      is_archive: true,
      status: `queued`,
      received_bytes: 0,
      total_bytes: null,
    })

    manager.update(task.id, {
      status: `downloading`,
      received_bytes: 2048,
      save_path: `C:\\Users\\me\\Downloads\\job.tar.gz`,
    })
    expect(manager.tasks[0].status).toBe(`downloading`)
    expect(manager.tasks[0].received_bytes).toBe(2048)
    expect(manager.tasks[0].save_path).toContain(`job.tar.gz`)

    manager.remove(task.id)
    expect(manager.tasks).toHaveLength(0)
  })

  it(`cancels active tasks and aborts their controller`, () => {
    const manager = create_download_manager()
    const abort_controller = new AbortController()
    const task = manager.add({
      filename: `large.bin`,
      source_path: `/remote/large.bin`,
      platform: `desktop`,
      is_archive: false,
      status: `downloading`,
      received_bytes: 1,
      total_bytes: null,
      abort_controller,
    })

    manager.cancel(task.id)
    expect(abort_controller.signal.aborted).toBe(true)
    expect(manager.tasks[0].status).toBe(`canceled`)
  })

  it(`clear_finished keeps only active tasks`, () => {
    const manager = create_download_manager()
    for (const status of [`queued`, `selecting`, `downloading`, `completed`, `failed`, `canceled`] as const) {
      manager.add({
        filename: `${status}.txt`,
        source_path: `/remote/${status}.txt`,
        platform: `desktop`,
        is_archive: false,
        status,
        received_bytes: 0,
        total_bytes: null,
      })
    }

    manager.clear_finished()
    expect(manager.tasks.map((task) => task.status).sort()).toEqual([
      `downloading`,
      `queued`,
      `selecting`,
    ])
  })
})

describe(`format_download_size`, () => {
  it(`formats byte counts with binary units`, () => {
    expect(format_download_size(0)).toBe(`0 B`)
    expect(format_download_size(512)).toBe(`512 B`)
    expect(format_download_size(1536)).toBe(`1.5 KB`)
    expect(format_download_size(1024 * 1024)).toBe(`1.0 MB`)
    expect(format_download_size(Number.NaN)).toBe(`0 B`)
  })
})
