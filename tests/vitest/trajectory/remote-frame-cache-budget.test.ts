import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe(`remote frame cache budget`, () => {
  test(`sizes binary packet batches and the LRU by retained position bytes`, () => {
    const source = readFileSync(
      `src/lib/trajectory/remote-frame-loader.ts`,
      `utf8`,
    )

    expect(source).toContain(`export function remote_frame_cache_plan(`)
    expect(source).toContain(`REMOTE_BATCH_POSITION_BYTE_BUDGET`)
    expect(source).toContain(`REMOTE_CACHE_POSITION_BYTE_BUDGET`)
    expect(source).toContain(`this.cache_plan.batch_size`)
    expect(source).toContain(`this.cache_plan.cache_capacity`)
    expect(source).toContain(`load_frame_positions(`)
    expect(source).toContain(`Float32Array`)
    expect(source).toContain(`positions_url(`)
    expect(source).toContain(`await resp.arrayBuffer()`)
    expect(source).toContain(`CGTP`)
    expect(source).toContain(`initial = 1`)
    expect(source).toContain(`plot_metadata_loader`)
    expect(source).not.toContain(
      `const plot_metadata_promise = loader.extract_plot_metadata`,
    )
    expect(source).not.toContain(`const BATCH = 16`)
    expect(source).not.toContain(`const CACHE_CAP = 400`)
    expect(source).not.toContain(`REMOTE_BATCH_SITE_BUDGET`)
    expect(source).not.toContain(`REMOTE_CACHE_SITE_BUDGET`)
    expect(source).not.toContain(
      `this.cache.set(bf.frame_number, backend_frame_to_trajectory_frame(bf))`,
    )
  })
})
