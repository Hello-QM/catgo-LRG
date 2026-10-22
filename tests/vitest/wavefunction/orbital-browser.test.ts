import OrbitalPanel from "$lib/structure/OrbitalPanel.svelte";
import {
  create_file_handlers,
  type FileHandlerDeps,
} from "$lib/structure/controllers/file-handlers";
import {
  frontier_label,
  is_wavefunction_file,
  type Orbital,
  type WavefunctionInfo,
} from "$lib/wavefunction/api";
import { flushSync, mount, tick } from "svelte";
import { beforeEach, describe, expect, test, vi } from "vitest";

// The built-in engine is exercised in engine.test.ts; here it is a stub
const engine = vi.hoisted(() => ({ open_wavefunction: vi.fn() }));
vi.mock(`$lib/wavefunction/engine`, async (importOriginal) => ({
  ...(await importOriginal<object>()),
  open_wavefunction: engine.open_wavefunction,
}));
const analyses = vi.hoisted(() => ({ local_orbital_cube: vi.fn() }));
vi.mock(`$lib/wavefunction/local-analyses`, async (importOriginal) => ({
  ...(await importOriginal<object>()),
  local_orbital_cube: analyses.local_orbital_cube,
}));

function orbital(index: number, occupation: number, energy: number): Orbital {
  return {
    index,
    number: index,
    spin: `restricted`,
    energy,
    energy_ev: energy * 27.211386245988,
    occupation,
  };
}

const WATER: WavefunctionInfo = {
  key: `wfn1`,
  format: `fchk`,
  filename: `water.fchk`,
  title: `water`,
  atoms: [
    { Z: 8, symbol: `O`, xyz: [0, 0, 0] },
    { Z: 1, symbol: `H`, xyz: [0, 0, 0.95] },
    { Z: 1, symbol: `H`, xyz: [0.9, 0, -0.3] },
  ],
  xyz: `3\nwater\nO 0 0 0\nH 0 0 0.95\nH 0.9 0 -0.3\n`,
  charge: 0,
  multiplicity: 1,
  energy: -74.96,
  unrestricted: false,
  orbitals: [
    orbital(1, 2, -20.25),
    orbital(2, 2, -1.26),
    orbital(3, 2, -0.59),
    orbital(4, 2, -0.46),
    orbital(5, 2, -0.39),
    orbital(6, 0, 0.58),
    orbital(7, 0, 0.69),
  ],
  frontier: { restricted: { homo: 5, lumo: 6, gap: 0.97, gap_ev: 26.4 } },
  n_electrons: 10,
  trace_ps: 10,
};

async function settle() {
  for (let i = 0; i < 5; i++) await tick();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

describe(`wavefunction api helpers`, () => {
  test(`recognises wavefunction file names`, () => {
    for (
      const name of [
        `a.fchk`,
        `a.FCH`,
        `b.molden`,
        `b.molden.input`,
        `c.wfn`,
        `d.wfx`,
      ]
    ) {
      expect(is_wavefunction_file(name)).toBe(true);
    }
    for (const name of [`a.xyz`, `a.cube`, `fchk.txt`]) {
      expect(is_wavefunction_file(name)).toBe(false);
    }
  });

  test(`labels orbitals relative to HOMO and LUMO`, () => {
    const frontier = WATER.frontier.restricted;
    expect(frontier_label(WATER.orbitals[4], frontier)).toBe(`HOMO`);
    expect(frontier_label(WATER.orbitals[2], frontier)).toBe(`HOMO-2`);
    expect(frontier_label(WATER.orbitals[5], frontier)).toBe(`LUMO`);
    expect(frontier_label(WATER.orbitals[6], frontier)).toBe(`LUMO+1`);
    expect(frontier_label(WATER.orbitals[0], undefined)).toBe(``);
  });
});

describe(`OrbitalPanel`, () => {
  beforeEach(() => {
    document.body.innerHTML = ``;
    analyses.local_orbital_cube.mockReset();
  });

  test(`lists orbitals highest first and computes the clicked one`, async () => {
    analyses.local_orbital_cube.mockImplementation(
      async (_wf: WavefunctionInfo, index: number, grid: string) =>
        `cube for ${index} at ${grid}`,
    );
    const on_cube = vi.fn();
    mount(OrbitalPanel, {
      target: document.body,
      props: { pane_open: true, wavefunction: WATER, on_cube },
    });
    await settle();

    const rows = [
      ...document.querySelectorAll<HTMLTableRowElement>(`.orb-list tbody tr`),
    ];
    expect(rows.map((r) => r.cells[1].textContent)).toEqual([
      `7`,
      `6`,
      `5`,
      `4`,
      `3`,
      `2`,
      `1`,
    ]);
    expect(rows[2].cells[0].textContent).toBe(`HOMO`);
    // no external program to configure any more
    expect(document.body.textContent).not.toContain(`Multiwfn path`);
    expect(document.querySelector(`.orb-cite`)?.textContent).toContain(
      `J. Comput. Chem. 33, 580`,
    );

    rows[2].click();
    await settle();

    expect(analyses.local_orbital_cube).toHaveBeenCalledWith(
      WATER,
      5,
      `medium`,
    );
    expect(on_cube).toHaveBeenCalledOnce();
    const [file, options] = on_cube.mock.calls[0] as [File, object];
    expect(file.name).toBe(`water_MO5.cub`);
    expect(await file.text()).toBe(`cube for 5 at medium`);
    expect(options).toEqual({}); // plain orbital: no colouring grid
  });

  test(`shows the engine error instead of calling on_cube`, async () => {
    analyses.local_orbital_cube.mockRejectedValue(
      new Error(`orbital 99 does not exist`),
    );
    const on_cube = vi.fn();
    mount(OrbitalPanel, {
      target: document.body,
      props: { pane_open: true, wavefunction: WATER, on_cube },
    });
    await settle();
    document.querySelector<HTMLTableRowElement>(`.orb-list tbody tr`)?.click();
    await settle();
    expect(on_cube).not.toHaveBeenCalled();
    expect(document.querySelector(`.orb-error`)?.textContent).toContain(
      `does not exist`,
    );
  });

  test(`warns when Tr(P·S) does not match the electron count`, async () => {
    mount(OrbitalPanel, {
      target: document.body,
      props: {
        pane_open: true,
        wavefunction: { ...WATER, trace_ps: 7.9976 },
        on_cube: vi.fn(),
      },
    });
    await settle();
    expect(document.querySelector(`.orb-error`)?.textContent).toContain(
      `7.9976`,
    );
  });
});

describe(`file handlers`, () => {
  function make_deps(overrides: Partial<FileHandlerDeps> = {}) {
    const deps = {
      get_structure: () => undefined,
      set_structure: vi.fn(),
      get_loading: () => false,
      set_loading: vi.fn(),
      get_error_msg: () => undefined,
      set_error_msg: vi.fn(),
      inc_center_camera: vi.fn(),
      set_cube_file: vi.fn(),
      set_cube_pane_open: vi.fn(),
      set_dos_session: vi.fn(),
      set_analysis_open: vi.fn(),
      set_analysis_tab: vi.fn(),
      set_imported_traj: vi.fn(),
      set_dragover: vi.fn(),
      get_allow_file_drop: () => true,
      get_on_file_drop: () => undefined,
      get_on_file_load: () => undefined,
      get_on_error: () => undefined,
      apply_charges: vi.fn(),
      set_wavefunction: vi.fn(),
      ...overrides,
    };
    return deps;
  }

  test(`loads a wavefunction file in the engine: geometry to the viewer, orbitals to the panel`, async () => {
    const { key: _k, filename: _f, trace_ps: _t, ...info } = WATER;
    engine.open_wavefunction.mockResolvedValueOnce({
      key: `wfn7`,
      info,
      trace_ps: 10,
    });
    const deps = make_deps();
    const handlers = create_file_handlers(deps);
    expect(handlers.process_parsed_content(`fchk text`, `water.fchk`)).toBe(
      true,
    );
    await settle();

    expect(engine.open_wavefunction).toHaveBeenCalledWith(
      `fchk text`,
      `water.fchk`,
    );
    expect(deps.set_wavefunction).toHaveBeenCalledWith({
      ...WATER,
      key: `wfn7`,
    });
    const structure = deps.set_structure.mock.calls[0][0];
    expect(structure.sites).toHaveLength(3);
    expect(structure._aligned).toBe(true);
  });

  test(`a file the engine rejects reports the error`, async () => {
    engine.open_wavefunction.mockRejectedValueOnce(
      new Error(`x.fchk: missing 'Atomic numbers'`),
    );
    const deps = make_deps();
    create_file_handlers(deps).process_parsed_content(`junk`, `x.fchk`);
    await settle();
    expect(deps.set_error_msg).toHaveBeenCalledWith(
      expect.stringContaining(`missing 'Atomic numbers'`),
    );
    expect(deps.set_wavefunction).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.any(String) }),
    );
  });

  test(`a regular structure file clears the orbital panel`, () => {
    const deps = make_deps();
    create_file_handlers(deps).process_parsed_content(
      `1\nH\nH 0 0 0\n`,
      `h.xyz`,
    );
    expect(deps.set_wavefunction).toHaveBeenCalledWith(null);
  });
});
