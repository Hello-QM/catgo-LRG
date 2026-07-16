import type { PymatgenStructure } from '$lib'
import { LatticePane } from '$lib/structure'
import type {
  IntMatrix3,
  SupercellOp,
  SupercellRequestResult,
} from '$lib/structure/supercell-operation'
import {
  SUPERCELL_SYNC_ATOM_LIMIT,
  SupercellExecutor,
} from '$lib/structure/workers/supercell-worker-api'
import { flushSync, mount } from 'svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Fixtures ──────────────────────────────────────────────────────────────

/** Cubic cell with `n_atoms` H sites spread along x. Plain data (no proxies). */
function make_cubic(n_atoms = 2, a = 4): PymatgenStructure {
  return {
    id: `cubic-test`,
    lattice: {
      matrix: [[a, 0, 0], [0, a, 0], [0, 0, a]],
      pbc: [true, true, true],
      volume: a ** 3,
      a,
      b: a,
      c: a,
      alpha: 90,
      beta: 90,
      gamma: 90,
    },
    sites: Array.from({ length: n_atoms }, (_, idx) => ({
      species: [{ element: `H`, occu: 1, oxidation_state: 0 }],
      abc: [idx / n_atoms, 0, 0],
      xyz: [(idx / n_atoms) * a, 0, 0],
      label: `H${idx + 1}`,
      properties: {},
    })),
    charge: 0,
  } as unknown as PymatgenStructure
}

const DIAG_2: IntMatrix3 = [[2, 0, 0], [0, 2, 0], [0, 0, 2]]
const SINGULAR: IntMatrix3 = [[1, 1, 0], [1, 1, 0], [0, 0, 1]]

function op(matrix: IntMatrix3, reorient = false): SupercellOp {
  return { kind: `supercell`, matrix, reorient }
}

// ── SupercellExecutor (staged execution, atomic result) ───────────────────

describe(`SupercellExecutor.execute`, () => {
  it(`executes a small transform on the calling thread and never mutates the input`, async () => {
    const structure = make_cubic(2)
    const before = JSON.stringify(structure)
    const { structure: out, provenance } = await SupercellExecutor.execute(
      structure,
      op(DIAG_2),
    )
    expect(out.sites.length).toBe(2 * 8) // N × |det|
    expect(out).not.toBe(structure)
    expect(provenance.cell_count).toBe(8)
    expect(JSON.stringify(structure)).toBe(before)
  })

  it(`falls back to the calling thread above SUPERCELL_SYNC_ATOM_LIMIT when Worker is unavailable`, async () => {
    // happy-dom has no global Worker, so this exercises the vitest/same-thread
    // fallback branch of the staged (worker) path.
    expect(typeof Worker).toBe(`undefined`)
    const base = Math.ceil((SUPERCELL_SYNC_ATOM_LIMIT + 1) / 8)
    const structure = make_cubic(base)
    const before = JSON.stringify(structure)
    const { structure: out } = await SupercellExecutor.execute(structure, op(DIAG_2))
    expect(out.sites.length).toBe(base * 8)
    expect(out.sites.length).toBeGreaterThan(SUPERCELL_SYNC_ATOM_LIMIT)
    expect(JSON.stringify(structure)).toBe(before)
  })

  it(`rejects a singular matrix without touching the input`, async () => {
    const structure = make_cubic(2)
    const before = JSON.stringify(structure)
    await expect(SupercellExecutor.execute(structure, op(SINGULAR))).rejects.toThrow(
      /singular/i,
    )
    expect(JSON.stringify(structure)).toBe(before)
  })

  it(`honors the max_atoms option and rejects before staging`, async () => {
    const structure = make_cubic(2)
    const before = JSON.stringify(structure)
    await expect(
      SupercellExecutor.execute(structure, op(DIAG_2), { max_atoms: 4 }),
    ).rejects.toThrow(/exceeds limit 4/)
    expect(JSON.stringify(structure)).toBe(before)
  })

  it(`rejects when the signal is already aborted, executing nothing`, async () => {
    const structure = make_cubic(2)
    const before = JSON.stringify(structure)
    const controller = new AbortController()
    controller.abort()
    await expect(
      SupercellExecutor.execute(structure, op(DIAG_2), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: `AbortError` })
    expect(JSON.stringify(structure)).toBe(before)
  })

  it(`stamps source_frame_id from options into provenance`, async () => {
    const structure = make_cubic(2)
    const { provenance } = await SupercellExecutor.execute(structure, op(DIAG_2), {
      source_frame_id: `frame-42`,
    })
    expect(provenance.source_frame_id).toBe(`frame-42`)
  })

  it(`defaults source_frame_id to the structure id`, async () => {
    const { provenance } = await SupercellExecutor.execute(make_cubic(2), op(DIAG_2))
    expect(provenance.source_frame_id).toBe(`cubic-test`)
  })
})

// ── LatticePane delegation (design §9.1 operation channel) ────────────────

type PaneSpies = {
  on_push_undo: ReturnType<typeof vi.fn>
  on_structure_change: ReturnType<typeof vi.fn>
}

function mount_pane(
  structure: PymatgenStructure,
  extra_props: Record<string, unknown> = {},
): PaneSpies {
  const on_push_undo = vi.fn()
  const on_structure_change = vi.fn()
  mount(LatticePane, {
    target: document.body,
    props: {
      structure,
      embedded: true,
      pane_open: true,
      on_push_undo,
      on_structure_change,
      ...extra_props,
    },
  })
  flushSync()
  return { on_push_undo, on_structure_change }
}

function open_transform_tab() {
  const tab = Array.from(
    document.querySelectorAll<HTMLButtonElement>(`.tab-bar button`),
  ).find((btn) => btn.textContent?.trim() === `Transform`)
  if (!tab) throw new Error(`Transform tab button not found`)
  tab.click()
  flushSync()
}

function click_preset_2x2x2() {
  const preset = Array.from(
    document.querySelectorAll<HTMLButtonElement>(`.preset-grid button`),
  ).find((btn) => btn.textContent?.trim() === `2x2x2`)
  if (!preset) throw new Error(`2x2x2 preset button not found`)
  preset.click()
  flushSync()
}

function set_matrix_cell(idx: number, value: string) {
  const cells = document.querySelectorAll<HTMLInputElement>(`.matrix-cell`)
  const cell = cells[idx]
  if (!cell) throw new Error(`matrix cell ${idx} not found`)
  cell.value = value
  cell.dispatchEvent(new Event(`input`, { bubbles: true }))
  flushSync()
}

function click_apply() {
  const btn = document.querySelector<HTMLButtonElement>(`.apply-btn`)
  if (!btn) throw new Error(`apply button not found`)
  btn.click()
  flushSync()
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

describe(`LatticePane supercell delegation`, () => {
  beforeEach(() => {
    document.body.innerHTML = ``
  })

  it(`delegates to on_supercell_request BEFORE any local mutation or undo push`, async () => {
    const structure = make_cubic(2)
    const before = JSON.stringify(structure)
    let received: SupercellOp | null = null
    const on_supercell_request = vi.fn(
      (incoming: SupercellOp): Promise<SupercellRequestResult> => {
        received = incoming
        return Promise.resolve({ status: `applied`, history_token: `traj:1` })
      },
    )
    const spies = mount_pane(structure, { on_supercell_request })

    open_transform_tab()
    click_preset_2x2x2()
    click_apply()

    await vi.waitFor(() => expect(on_supercell_request).toHaveBeenCalledTimes(1))
    expect(received).toMatchObject({
      kind: `supercell`,
      matrix: [[2, 0, 0], [0, 2, 0], [0, 0, 2]],
    })
    // The delegated host owns execution + history — the pane must not touch
    // either. No local undo entry, no local structure publish, no mutation.
    expect(spies.on_push_undo).not.toHaveBeenCalled()
    expect(spies.on_structure_change).not.toHaveBeenCalled()
    expect(JSON.stringify(structure)).toBe(before)
  })

  it(`honors a rejected delegation result without mutating or pushing undo`, async () => {
    const structure = make_cubic(2)
    const before = JSON.stringify(structure)
    const on_supercell_request = vi.fn(
      (): Promise<SupercellRequestResult> =>
        Promise.resolve({ status: `rejected`, message: `view scope is read-only` }),
    )
    const spies = mount_pane(structure, { on_supercell_request })

    open_transform_tab()
    click_preset_2x2x2()
    click_apply()

    await vi.waitFor(() => expect(on_supercell_request).toHaveBeenCalledTimes(1))
    await settle()
    expect(spies.on_push_undo).not.toHaveBeenCalled()
    expect(spies.on_structure_change).not.toHaveBeenCalled()
    expect(JSON.stringify(structure)).toBe(before)
  })

  it(`standalone (no delegate) performs a true edit and publishes only after success`, async () => {
    const spies = mount_pane(make_cubic(2))

    open_transform_tab()
    click_preset_2x2x2()
    click_apply()

    await vi.waitFor(() => expect(spies.on_structure_change).toHaveBeenCalledTimes(1))
    const published = spies.on_structure_change.mock.calls[0][0] as PymatgenStructure
    expect(published.sites.length).toBe(16) // 2 atoms × det 8 — a TRUE edit
    expect(spies.on_push_undo).toHaveBeenCalledTimes(1)
    // Atomic publish: the undo entry is recorded (pre-op state) immediately
    // before the single structure replacement — never before execution.
    expect(spies.on_push_undo.mock.invocationCallOrder[0]).toBeLessThan(
      spies.on_structure_change.mock.invocationCallOrder[0],
    )
  })

  it(`standalone rejection (singular matrix) preserves structure and history`, async () => {
    const structure = make_cubic(2)
    const before = JSON.stringify(structure)
    const spies = mount_pane(structure)

    open_transform_tab()
    set_matrix_cell(0, `0`) // identity with m00=0 → singular
    click_apply()

    await settle()
    expect(spies.on_push_undo).not.toHaveBeenCalled()
    expect(spies.on_structure_change).not.toHaveBeenCalled()
    expect(JSON.stringify(structure)).toBe(before)
  })

  it(`large_system_mode still performs a TRUE edit — never visual replication`, async () => {
    // The old renderer shortcut turned Build supercell into a supercell_scaling
    // (visual replication) write when large-system mode was on. Build semantics
    // must not depend on renderer state (design §9.2).
    const spies = mount_pane(make_cubic(2), {
      large_system_mode: true,
      supercell_scaling: `1x1x1`,
    })

    open_transform_tab()
    click_preset_2x2x2()
    click_apply()

    await vi.waitFor(() => expect(spies.on_structure_change).toHaveBeenCalledTimes(1))
    const published = spies.on_structure_change.mock.calls[0][0] as PymatgenStructure
    expect(published.sites.length).toBe(16)
    expect(spies.on_push_undo).toHaveBeenCalledTimes(1)
  })
})
