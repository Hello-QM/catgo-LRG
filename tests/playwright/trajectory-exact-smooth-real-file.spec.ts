import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

const EXPECTED_SHA256 =
  `38d4554e93744b7efc53e2add4f7ef90ed8f72557b78e45f0696347434b3e41c`
const EXPECTED_FRAMES = 100
const EXPECTED_ATOMS = 19_968
const MIN_UNIQUE_FPS = 24
const TARGET_FPS = 30
const MAX_PREPARED_BYTES = 96 * 1024 * 1024
const traj_path = process.env.DUMP_TRAJ
const perf_gate = process.env.CATGO_GPU_PERF_GATE === `1`
const real_gate_configured = !!traj_path && perf_gate
const actual_sha256 = real_gate_configured
  ? createHash(`sha256`).update(readFileSync(traj_path!)).digest(`hex`)
  : null

test.skip(
  !real_gate_configured,
  `real GPU trajectory gate not configured`,
)

type Diagnostics = {
  requested_frames: number
  prepared_frames: number
  presented_frames: number
  unique_presented_frames: number
  stale_results: number
  failed_frames: number
  graph_hash_by_frame: Record<number, string>
  bond_count_by_frame: Record<number, number>
  renderer_installed_frames: number
  last_renderer_installed_frame: number | null
  renderer_graph_hash_by_frame: Record<number, string>
  renderer_bond_count_by_frame: Record<number, number>
  bond_compute_ms: number[]
  bond_worker_wasm_ms: number[]
  bond_worker_position_pack_ms: number[]
  bond_worker_table_copy_ms: number[]
  bond_worker_total_ms: number[]
  bond_worker_roundtrip_ms: number[]
  bond_renderer_update_ms: number[]
  bond_renderer_main_attrs_ms: number[]
  bond_renderer_ghosts_ms: number[]
  bond_manager_replace_ms: number[]
  typed_direct_sync_ms: number[]
  prepared_to_renderer_sync_ms: number[]
  bond_backend: string | null
  bond_threading_expected: boolean
  bond_thread_count: number
  bond_session_initializations: number
  bond_session_frames: number
  bond_grid_cache_hits: number
  bond_grid_rebuilds: number
  bond_capacity_growths: number
  cold_first_frame_ms: number | null
  warmup_ms: number | null
  frame_time_p95_ms: number | null
  main_thread_long_tasks: number
  cache_frames: number
  cache_bytes: number
  queued_bytes: number
  in_flight_bytes: number
  retained_bytes: number
  position_uploads: number
  position_upload_bytes: number
  topology_uploads: number
  topology_upload_bytes: number
  picker_position_uploads: number
  presentation_latency_ms: number[]
  unique_frame_fps: number
  last_presented_frame: number | null
}

type ExactReference = {
  graph_hash_by_frame: Record<number, string>
  bond_count_by_frame: Record<number, number>
  elapsed_ms: number
}

async function open_context(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  })
}

async function load_real_trajectory(
  page: Page,
  path: string,
  label: string,
): Promise<void> {
  page.on(`console`, (message) => {
    if (
      message.type() === `error` || message.type() === `warning` ||
      message.text().includes(`[bonds]`)
    ) {
      console.log(`[${label}:${message.type()}] ${message.text()}`)
    }
  })
  console.log(`[${label}] opening app`)
  await page.goto(`/`, { waitUntil: `load` })
  const import_card = page.locator(
    `button.import-card.add-own-card`,
    { hasText: /Open file/i },
  ).first()
  await expect(import_card).toBeVisible({ timeout: 30_000 })
  const [chooser] = await Promise.all([
    page.waitForEvent(`filechooser`, { timeout: 30_000 }),
    import_card.click(),
  ])
  console.log(`[${label}] loading ${path}`)
  await chooser.setFiles(path)

  const trajectory = page.locator(`.trajectory`)
  await expect(trajectory.locator(`.trajectory-controls`)).toBeVisible({
    timeout: 180_000,
  })
  await expect(trajectory.locator(`.trajectory-error`)).toHaveCount(0)
  await expect(trajectory.locator(`[aria-label="total frames"]`))
    .toContainText(`${EXPECTED_FRAMES}`)
  console.log(`[${label}] parsed ${EXPECTED_FRAMES} frames; enabling bonds`)
  const compute_bonds = page.getByRole(`button`, { name: `Compute bonds` })
  if (await compute_bonds.isVisible().catch(() => false)) {
    await compute_bonds.click()
    await expect(compute_bonds).toBeHidden()
  }
  await page.waitForFunction(
    () => {
      const snapshot = globalThis.__catgoTrajectoryDiagnostics?.()
      return typeof globalThis.__catgoTrajectoryExactReference === `function` &&
        !!snapshot &&
        (
          snapshot.failed_frames > 0 ||
          Object.values(snapshot.renderer_bond_count_by_frame)
            .some((count) => count > 0)
        )
    },
    undefined,
    { timeout: 180_000 },
  )
  const bonded = await diagnostics(page)
  console.log(
    `[${label}] bonded frame ready: prepared=${bonded.prepared_frames} ` +
    `failed=${bonded.failed_frames} counts=${
      JSON.stringify(bonded.renderer_bond_count_by_frame)
    }`,
  )
  expect(bonded.failed_frames).toBe(0)
  expect(Object.values(bonded.renderer_bond_count_by_frame).some(
    (count) => count > 20_000,
  )).toBe(true)
}

async function set_rate_and_pause(page: Page): Promise<void> {
  const play = page.locator(`.trajectory .play-button`)
  if (await play.getAttribute(`aria-label`) === `Play trajectory`) {
    await play.click()
  }
  await expect(play).toHaveAttribute(`aria-label`, `Pause playback`, {
    timeout: 30_000,
  })
  const fps = page.locator(`.trajectory .fps-section input[type="number"]`)
  await expect(fps).toBeVisible()
  await fps.fill(`${TARGET_FPS}`)
  await fps.press(`Enter`)
  await expect(fps).toHaveValue(`${TARGET_FPS}`)
  await play.click()
  await expect(play).toHaveAttribute(`aria-label`, `Play trajectory`)
}

async function diagnostics(page: Page): Promise<Diagnostics> {
  return page.evaluate(() => {
    const snapshot = globalThis.__catgoTrajectoryDiagnostics?.()
    if (!snapshot) throw new Error(`Trajectory diagnostics are unavailable`)
    return snapshot
  })
}

async function reset_diagnostics(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (!globalThis.__catgoTrajectoryDiagnosticsReset) {
      throw new Error(`Trajectory diagnostics reset is unavailable`)
    }
    globalThis.__catgoTrajectoryDiagnosticsReset()
  })
}

function merge_records<T>(
  ...records: Array<Record<number, T>>
): Record<number, T> {
  return Object.assign({}, ...records)
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

async function wait_for_segment(page: Page, duration_ms: number): Promise<Diagnostics> {
  await page.waitForTimeout(duration_ms)
  // Allow Svelte's publication effect and the shared texture update to finish
  // before reading counters from the browser.
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  ))
  return diagnostics(page)
}

function log_segment(label: string, snapshot: Diagnostics): void {
  console.log(
    `[${label}] unique_fps=${snapshot.unique_frame_fps.toFixed(2)} ` +
    `unique=${snapshot.unique_presented_frames} ` +
    `requested=${snapshot.requested_frames} prepared=${snapshot.prepared_frames} ` +
    `stale=${snapshot.stale_results} failed=${snapshot.failed_frames} ` +
    `cache=${snapshot.cache_frames} queued_bytes=${snapshot.queued_bytes} ` +
    `in_flight_bytes=${snapshot.in_flight_bytes} ` +
    `graph_keys=${
      Object.keys(snapshot.renderer_graph_hash_by_frame).join(`,`)
    } ` +
    `frame_p95_ms=${snapshot.frame_time_p95_ms?.toFixed(2) ?? `n/a`} ` +
    `compute_p95_ms=${
      percentile(snapshot.bond_compute_ms, 0.95)?.toFixed(2) ?? `n/a`
    } worker_wasm_p95_ms=${
      percentile(snapshot.bond_worker_wasm_ms, 0.95)?.toFixed(2) ?? `n/a`
    } worker_pack_p95_ms=${
      percentile(snapshot.bond_worker_position_pack_ms, 0.95)?.toFixed(2) ??
        `n/a`
    } worker_table_copy_p95_ms=${
      percentile(snapshot.bond_worker_table_copy_ms, 0.95)?.toFixed(2) ??
        `n/a`
    } worker_total_p95_ms=${
      percentile(snapshot.bond_worker_total_ms, 0.95)?.toFixed(2) ?? `n/a`
    } worker_roundtrip_p95_ms=${
      percentile(snapshot.bond_worker_roundtrip_ms, 0.95)?.toFixed(2) ??
        `n/a`
    } renderer_update_p95_ms=${
      percentile(snapshot.bond_renderer_update_ms, 0.95)?.toFixed(2) ?? `n/a`
    } renderer_attrs_p95_ms=${
      percentile(snapshot.bond_renderer_main_attrs_ms, 0.95)?.toFixed(2) ??
        `n/a`
    } renderer_ghosts_p95_ms=${
      percentile(snapshot.bond_renderer_ghosts_ms, 0.95)?.toFixed(2) ?? `n/a`
    } manager_replace_p95_ms=${
      percentile(snapshot.bond_manager_replace_ms, 0.95)?.toFixed(2) ?? `n/a`
    } typed_direct_p95_ms=${
      percentile(snapshot.typed_direct_sync_ms, 0.95)?.toFixed(2) ?? `n/a`
    } publish_sync_p95_ms=${
      percentile(snapshot.prepared_to_renderer_sync_ms, 0.95)?.toFixed(2) ??
        `n/a`
    } backend=${snapshot.bond_backend ?? `n/a`} ` +
    `threading_expected=${snapshot.bond_threading_expected} ` +
    `threads=${snapshot.bond_thread_count} ` +
    `session_initializations=${snapshot.bond_session_initializations} ` +
    `session_frames=${snapshot.bond_session_frames} ` +
    `grid_cache_hits=${snapshot.bond_grid_cache_hits} ` +
    `grid_rebuilds=${snapshot.bond_grid_rebuilds} ` +
    `capacity_growths=${snapshot.bond_capacity_growths} ` +
    `long_tasks=${snapshot.main_thread_long_tasks}`,
  )
}

test(`real dump.traj is exact and presents at least 24 unique FPS`, async ({
  browser,
}) => {
  test.setTimeout(15 * 60_000)
  expect(actual_sha256).toBe(EXPECTED_SHA256)

  // Reference pass: a separate context, serial scheduling, no presentation.
  const reference_context = await open_context(browser)
  const reference_page = await reference_context.newPage()
  await load_real_trajectory(reference_page, traj_path!, `reference`)
  await set_rate_and_pause(reference_page)
  const reference = await reference_page.evaluate(async (): Promise<ExactReference> => {
    const run = globalThis.__catgoTrajectoryExactReference
    if (!run) throw new Error(`Exact reference sweep is unavailable`)
    return run()
  })
  expect(Object.keys(reference.graph_hash_by_frame)).toHaveLength(EXPECTED_FRAMES)
  expect(Object.keys(reference.bond_count_by_frame)).toHaveLength(EXPECTED_FRAMES)
  expect(Object.values(reference.bond_count_by_frame).every(
    (count) => count > 20_000,
  )).toBe(true)
  await reference_context.close()

  // Measurement pass: fresh page/context and a fresh real UI file load.
  const context = await open_context(browser)
  const page = await context.newPage()
  const console_errors: string[] = []
  const page_errors: string[] = []
  page.on(`console`, (message) => {
    if (message.type() === `error`) console_errors.push(message.text())
  })
  page.on(`pageerror`, (error) => page_errors.push(error.message))
  await page.addInitScript(() => {
    ;(globalThis as unknown as { __catgoContextLosses: number })
      .__catgoContextLosses = 0
    addEventListener(`webglcontextlost`, () => {
      ;(globalThis as unknown as { __catgoContextLosses: number })
        .__catgoContextLosses++
    }, true)
  })

  await load_real_trajectory(page, traj_path!, `measurement`)
  await set_rate_and_pause(page)
  const step_input = page.locator(`.trajectory .step-input`)
  const step_slider = page.locator(`.trajectory .step-slider`)
  // Auto-play may have a requested frame ahead of the still-presented input
  // when pause lands. Force a complete 1 → 0 seek so frame 0 is a fresh
  // request even when both controls happened to read 0 at pause time.
  await step_slider.fill(`1`)
  await expect(step_slider).toHaveValue(`1`, { timeout: 10_000 })
  await expect(step_input).toHaveValue(`1`, { timeout: 180_000 })
  await step_slider.fill(`0`)
  await expect(step_slider).toHaveValue(`0`, { timeout: 10_000 })
  await expect(step_input).toHaveValue(`0`, { timeout: 10_000 })
  await expect(step_slider).toHaveAttribute(`aria-busy`, `false`, {
    timeout: 180_000,
  })
  await page.waitForFunction(() => {
    const snapshot = globalThis.__catgoTrajectoryDiagnostics?.()
    const test_api = (globalThis as typeof globalThis & {
      __catgo_traj_test?: { get_prepared_ready_ahead(): number }
    }).__catgo_traj_test
    return !!snapshot && snapshot.cold_first_frame_ms !== null &&
      snapshot.warmup_ms !== null &&
      (test_api?.get_prepared_ready_ahead() ?? 0) >= 3
  }, undefined, { timeout: 180_000 })
  // The static-only harness intentionally has no filesystem/backend service;
  // ignore its load-time sidebar noise and gate only the trajectory runtime.
  console_errors.length = 0
  page_errors.length = 0
  const cold = await diagnostics(page)

  const gpu = await page.locator(`canvas[data-render-backend="webgl2"]`)
    .first().evaluate((canvas) => {
      const gl = (canvas as HTMLCanvasElement).getContext(`webgl2`)
      const ext = gl?.getExtension(`WEBGL_debug_renderer_info`)
      return {
        renderer: gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
        vendor: gl && ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
        context_lost: gl?.isContextLost() ?? true,
        gl_error: gl?.getError() ?? -1,
      }
    })
  expect(gpu.context_lost).toBe(false)
  expect(gpu.gl_error).toBe(0)
  expect(gpu.renderer).toMatch(/RTX 4060 Laptop GPU/i)

  await reset_diagnostics(page)
  const play = page.locator(`.trajectory .play-button`)
  await play.click()
  await expect(play).toHaveAttribute(`aria-label`, `Pause playback`)

  const first_segment = await wait_for_segment(page, 4_000)
  log_segment(`warm-segment`, first_segment)
  expect(first_segment.unique_frame_fps).toBeGreaterThanOrEqual(MIN_UNIQUE_FPS)
  expect(first_segment.failed_frames).toBe(0)
  expect(first_segment.stale_results).toBe(0)
  expect(first_segment.position_uploads)
    .toBe(first_segment.unique_presented_frames)
  expect(first_segment.picker_position_uploads).toBe(0)
  expect(first_segment.cache_frames).toBeLessThanOrEqual(8)
  expect(first_segment.retained_bytes).toBeLessThanOrEqual(MAX_PREPARED_BYTES)

  await reset_diagnostics(page)
  await page.waitForFunction(() =>
    (globalThis.__catgoTrajectoryDiagnostics?.().requested_frames ?? 0) > 0
  )
  const steady_segment = await wait_for_segment(page, 4_000)
  log_segment(`steady-segment`, steady_segment)
  expect(steady_segment.unique_frame_fps).toBeGreaterThanOrEqual(MIN_UNIQUE_FPS)
  expect(steady_segment.failed_frames).toBe(0)
  expect(steady_segment.stale_results).toBe(0)
  expect(steady_segment.position_uploads)
    .toBe(steady_segment.unique_presented_frames)
  expect(steady_segment.picker_position_uploads).toBe(0)
  expect(steady_segment.cache_frames).toBeLessThanOrEqual(8)
  expect(steady_segment.retained_bytes).toBeLessThanOrEqual(MAX_PREPARED_BYTES)

  const observed_hashes = merge_records(
    first_segment.renderer_graph_hash_by_frame,
    steady_segment.renderer_graph_hash_by_frame,
  )
  const observed_counts = merge_records(
    first_segment.renderer_bond_count_by_frame,
    steady_segment.renderer_bond_count_by_frame,
  )
  expect(Object.keys(observed_hashes)).toHaveLength(EXPECTED_FRAMES)
  expect(Object.keys(observed_counts)).toHaveLength(EXPECTED_FRAMES)
  expect(observed_hashes).toEqual(reference.graph_hash_by_frame)
  expect(observed_counts).toEqual(reference.bond_count_by_frame)

  // Live random seeks: request acknowledgement is the pending slider update;
  // complete presentation is the truthful step input + diagnostic graph hash.
  let max_seek_ack_ms = 0
  for (const target of [73, 11, 96, 42, 7]) {
    const presented = page.waitForFunction(
      ({ frame, hash }) => {
        const snapshot = globalThis.__catgoTrajectoryDiagnostics?.()
        const input = document.querySelector<HTMLInputElement>(
          `.trajectory .step-input`,
        )
        return input?.value === String(frame) &&
          snapshot?.last_renderer_installed_frame === frame &&
          snapshot.renderer_graph_hash_by_frame[frame] === hash
      },
      { frame: target, hash: reference.graph_hash_by_frame[target] },
      { timeout: 10_000, polling: 1 },
    )
    const acknowledgement = await step_slider.evaluate(
      async (slider, frame) => {
        const started = performance.now()
        slider.value = String(frame)
        slider.dispatchEvent(new Event(`input`, { bubbles: true }))
        const app_requested_idx = await new Promise<number>((resolve, reject) => {
          const poll = () => {
            const test_api = (
              globalThis as typeof globalThis & {
                __catgo_traj_test?: { get_current_idx(): number }
              }
            ).__catgo_traj_test
            const requested_idx = test_api?.get_current_idx()
            if (requested_idx === frame) {
              resolve(requested_idx)
              return
            }
            if (performance.now() - started >= 100) {
              reject(new Error(
                `Application did not acknowledge trajectory frame ${frame}`,
              ))
              return
            }
            requestAnimationFrame(poll)
          }
          poll()
        })
        return {
          elapsed_ms: performance.now() - started,
          app_requested_idx,
        }
      },
      target,
    )
    expect(acknowledgement.app_requested_idx).toBe(target)
    max_seek_ack_ms = Math.max(
      max_seek_ack_ms,
      acknowledgement.elapsed_ms,
    )
    await presented
  }
  expect(max_seek_ack_ms).toBeLessThan(100)

  await play.click()
  await expect(play).toHaveAttribute(`aria-label`, `Play trajectory`)
  const final = await diagnostics(page)
  const context_losses = await page.evaluate(() =>
    (globalThis as unknown as { __catgoContextLosses: number })
      .__catgoContextLosses
  )
  expect(context_losses).toBe(0)
  expect(page_errors).toEqual([])
  expect(console_errors).toEqual([])

  const compute_median = percentile(
    [...first_segment.bond_compute_ms, ...steady_segment.bond_compute_ms],
    0.5,
  )
  const compute_p95 = percentile(
    [...first_segment.bond_compute_ms, ...steady_segment.bond_compute_ms],
    0.95,
  )
  const latency_median = percentile(
    [
      ...first_segment.presentation_latency_ms,
      ...steady_segment.presentation_latency_ms,
    ],
    0.5,
  )
  const latency_p95 = percentile(
    [
      ...first_segment.presentation_latency_ms,
      ...steady_segment.presentation_latency_ms,
    ],
    0.95,
  )
  console.log(JSON.stringify({
    reference_sha256: actual_sha256,
    shape: { frames: EXPECTED_FRAMES, atoms: EXPECTED_ATOMS },
    gpu,
    reference_elapsed_ms: reference.elapsed_ms,
    first_4s_unique_fps: first_segment.unique_frame_fps,
    steady_unique_fps: steady_segment.unique_frame_fps,
    target_fps: TARGET_FPS,
    cold_first_frame_ms: cold.cold_first_frame_ms,
    warmup_ms: cold.warmup_ms,
    frame_time_p95_ms: steady_segment.frame_time_p95_ms,
    main_thread_long_tasks: final.main_thread_long_tasks,
    bond_compute_median_ms: compute_median,
    bond_compute_p95_ms: compute_p95,
    presentation_latency_median_ms: latency_median,
    presentation_latency_p95_ms: latency_p95,
    position_uploads: first_segment.position_uploads +
      steady_segment.position_uploads,
    position_upload_bytes: first_segment.position_upload_bytes +
      steady_segment.position_upload_bytes,
    topology_uploads: first_segment.topology_uploads +
      steady_segment.topology_uploads,
    topology_upload_bytes: first_segment.topology_upload_bytes +
      steady_segment.topology_upload_bytes,
    peak_cache_frames: Math.max(
      first_segment.cache_frames,
      steady_segment.cache_frames,
    ),
    peak_cache_bytes: Math.max(
      first_segment.cache_bytes,
      steady_segment.cache_bytes,
    ),
    peak_retained_bytes: Math.max(
      first_segment.retained_bytes,
      steady_segment.retained_bytes,
    ),
    max_seek_ack_ms,
    exact_graphs: `${Object.keys(observed_hashes).length}/${EXPECTED_FRAMES}`,
  }, null, 2))

  await context.close()
})
