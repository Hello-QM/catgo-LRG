import OrbitalPanel from "$lib/structure/OrbitalPanel.svelte";
import {
  create_file_handlers,
  type FileHandlerDeps,
} from "$lib/structure/controllers/file-handlers";
import {
  fetch_orbital_cube,
  frontier_label,
  is_wavefunction_file,
  type Orbital,
  type WavefunctionInfo,
} from "$lib/wavefunction/api";
import { flushSync, mount, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
  session_id: `a`.repeat(32),
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
};

type Route = (url: string, init?: RequestInit) => Response | undefined;

function stub_fetch(route: Route) {
  const fetch_mock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = route(String(input), init);
      if (!res) throw new Error(`unexpected fetch ${input}`);
      return res;
    },
  );
  vi.stubGlobal(`fetch`, fetch_mock);
  return fetch_mock;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": `application/json` },
  });

async function settle() {
  for (let i = 0; i < 5; i++) await tick();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  test(`surfaces the backend error detail`, async () => {
    stub_fetch(() => json({ detail: `Multiwfn not found` }, 424));
    await expect(fetch_orbital_cube(`x`, 1, `low`)).rejects.toThrow(
      `Multiwfn not found`,
    );
  });
});

describe(`OrbitalPanel`, () => {
  beforeEach(() => {
    document.body.innerHTML = ``;
    try {
      localStorage.clear();
    } catch {
      // storage unavailable in this environment
    }
  });

  test(`lists orbitals highest first and sends the clicked one to Multiwfn`, async () => {
    const fetch_mock = stub_fetch((url, init) => {
      if (url.includes(`/wavefunction/multiwfn-status`)) {
        return json({
          found: true,
          path: `/opt/Multiwfn/Multiwfn`,
          source: `PATH`,
        });
      }
      if (url.endsWith(`/wavefunction/orbital-cube`)) {
        const body = JSON.parse(String(init?.body));
        return new Response(`cube for ${body.orbital_index} at ${body.grid}`);
      }
      return undefined;
    });
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
    expect(document.querySelector(`.orb-status`)?.textContent).toContain(
      `/opt/Multiwfn/Multiwfn`,
    );

    rows[2].click();
    await settle();

    const cube_call = fetch_mock.mock.calls.find(([u]) =>
      String(u).endsWith(`/orbital-cube`)
    );
    expect(JSON.parse(String(cube_call?.[1]?.body))).toEqual({
      session_id: WATER.session_id,
      orbital_index: 5,
      grid: `medium`,
      multiwfn_path: null,
    });
    expect(on_cube).toHaveBeenCalledOnce();
    const [file, options] = on_cube.mock.calls[0] as [File, object];
    expect(file.name).toBe(`water_MO5.cub`);
    expect(await file.text()).toBe(`cube for 5 at medium`);
    expect(options).toEqual({}); // plain orbital: no colouring grid
  });

  test(`shows the Multiwfn error instead of calling on_cube`, async () => {
    stub_fetch((url) => {
      if (url.includes(`multiwfn-status`)) {
        return json({ found: false, path: null, source: null });
      }
      return json({ detail: `Multiwfn not found. Set its path` }, 424);
    });
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
      `Multiwfn not found`,
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

  test(`loads a wavefunction file: geometry into the viewer, orbitals to the panel`, async () => {
    const fetch_mock = stub_fetch((url) =>
      url.endsWith(`/wavefunction/load`) ? json(WATER) : undefined
    );
    const deps = make_deps();
    const handlers = create_file_handlers(deps);
    expect(handlers.process_parsed_content(`fchk text`, `water.fchk`)).toBe(
      true,
    );
    await settle();

    expect(fetch_mock).toHaveBeenCalledOnce();
    const form = fetch_mock.mock.calls[0][1]?.body as FormData;
    expect((form.get(`file`) as File).name).toBe(`water.fchk`);
    expect(deps.set_wavefunction).toHaveBeenCalledWith(WATER);
    const structure = deps.set_structure.mock.calls[0][0];
    expect(structure.sites).toHaveLength(3);
    expect(structure._aligned).toBe(true);
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
