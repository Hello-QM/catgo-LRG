import DistortionInteractionPanel from '$lib/workflow/DistortionInteractionPanel.svelte'
import EnergeticSpanPanel from '$lib/workflow/EnergeticSpanPanel.svelte'
import { flushSync, mount, tick } from 'svelte'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock(`$lib/workflow/plotly-utils`, () => ({
  lazy_load_plotly: () => new Promise(() => {}),
  make_target_writable: () => {},
  base_layout: (l: unknown) => l,
  base_config: () => ({}),
  observe_resize: () => () => {},
}))

const EMPTY_PLOT = { traces: [], layout: {}, annotations: [] }

function mock_fetch(response: unknown) {
  const fetch_mock = vi.fn(async () =>
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': `application/json` },
    })
  )
  vi.stubGlobal(`fetch`, fetch_mock)
  return fetch_mock
}

async function settle() {
  for (let i = 0; i < 5; i++) await tick()
  await new Promise((r) => setTimeout(r, 0))
  flushSync()
}

function set_input(el: HTMLInputElement, value: string) {
  el.value = value
  el.dispatchEvent(new Event(`input`, { bubbles: true }))
}

describe(`EnergeticSpanPanel`, () => {
  beforeEach(() => {
    document.body.innerHTML = ``
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test(`posts the selected pathway and shows TDI/TDTS`, async () => {
    const fetch_mock = mock_fetch({
      unit: `eV`,
      temperature: 298.15,
      reaction_energy: -0.5,
      energetic_span: 0.8,
      tdi: { index: 0, label: `Cat`, energy: 0 },
      tdts: { index: 1, label: `TS1`, energy: 0.8 },
      tdts_before_tdi: false,
      tof: 1.23e-1,
      tof_approx: 2e-1,
      states: [
        { index: 0, label: `Cat`, energy: 0, is_ts: false, degree_of_tof_control: 1, role: `TDI` },
        { index: 1, label: `TS1`, energy: 0.8, is_ts: true, degree_of_tof_control: 1, role: `TDTS` },
      ],
      warnings: [],
      plotly_data: EMPTY_PLOT,
    })
    const steps = [
      { label: `Cat`, energy: 0, is_ts: false },
      { label: `TS1`, energy: 0.8, is_ts: true },
      { label: `Cat + P`, energy: -0.5, is_ts: false },
    ]
    mount(EnergeticSpanPanel, {
      target: document.body,
      props: { pathways: [{ name: `Cycle`, color: `#000`, steps }] },
    })

    document.querySelector<HTMLButtonElement>(`.es-run`)?.click()
    await settle()

    expect(fetch_mock).toHaveBeenCalledOnce()
    const [url, init] = fetch_mock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/workflow\/catalysis\/energetic-span$/)
    const body = JSON.parse(String(init.body))
    expect(body.steps).toEqual(steps)
    expect(body.reaction_energy).toBeNull()
    expect(body.unit).toBe(`eV`)

    const text = document.querySelector(`.es-summary`)?.textContent ?? ``
    expect(text).toContain(`0.800 eV`)
    expect(text).toContain(`TS1`)
    expect(text).toContain(`1.230e-1`)
  })

  test(`shows a hint when there is no pathway`, () => {
    mount(EnergeticSpanPanel, { target: document.body, props: { pathways: [] } })
    expect(document.querySelector(`.es-note`)).toBeTruthy()
    expect(document.querySelector<HTMLButtonElement>(`.es-run`)?.disabled).toBe(true)
  })
})

describe(`DistortionInteractionPanel`, () => {
  beforeEach(() => {
    document.body.innerHTML = ``
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test(`does not call the backend until every energy is filled`, async () => {
    const fetch_mock = mock_fetch({})
    mount(DistortionInteractionPanel, { target: document.body })
    document.querySelector<HTMLButtonElement>(`.di-run`)?.click()
    await settle()
    expect(fetch_mock).not.toHaveBeenCalled()
    expect(document.querySelector(`.di-error`)).toBeTruthy()
  })

  test(`builds the request from the tables and renders the decomposition`, async () => {
    const fetch_mock = mock_fetch({
      unit: `kcal/mol`,
      entries: [{
        label: `TS`,
        fragments: [{ name: `A`, distortion: 6.28 }, { name: `B`, distortion: 3.14 }],
        distortion: 9.42,
        interaction: -21.96,
        total: -12.55,
      }],
      plotly_data: EMPTY_PLOT,
    })
    mount(DistortionInteractionPanel, { target: document.body })
    flushSync()

    const tables = document.querySelectorAll(`.di-table`)
    const relaxed = tables[0].querySelectorAll<HTMLInputElement>(`input[type="number"]`)
    set_input(relaxed[0], `-120`)
    set_input(relaxed[1], `-80`)
    // entry row: coordinate, complex, E(A), E(B)
    const entry = tables[1].querySelectorAll<HTMLInputElement>(`input[type="number"]`)
    set_input(entry[1], `-200.02`)
    set_input(entry[2], `-119.99`)
    set_input(entry[3], `-79.995`)
    flushSync()

    document.querySelector<HTMLButtonElement>(`.di-run`)?.click()
    await settle()

    expect(fetch_mock).toHaveBeenCalledOnce()
    const [url, init] = fetch_mock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/workflow\/catalysis\/distortion-interaction$/)
    const body = JSON.parse(String(init.body))
    expect(body.fragment_references).toEqual({ A: -120, B: -80 })
    expect(body.entries).toEqual([{
      label: `TS`,
      complex_energy: -200.02,
      fragments: [
        { name: `A`, energy_in_complex: -119.99 },
        { name: `B`, energy_in_complex: -79.995 },
      ],
    }])
    expect(body.input_unit).toBe(`hartree`)
    expect(body.output_unit).toBe(`kcal/mol`)

    const results = document.querySelector(`.di-results`)?.textContent ?? ``
    expect(results).toContain(`-21.96`)
    expect(results).toContain(`-12.55`)
  })
})
