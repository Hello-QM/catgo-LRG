import type { CubeMesh } from "$lib/cube";
import type { VolumetricGrid } from "$lib/cube/parse-cube";
import {
  color_at,
  color_mesh,
  make_sampler,
  surface_extrema,
} from "$lib/cube/vertex-colors";
import OrbitalPanel from "$lib/structure/OrbitalPanel.svelte";
import {
  has_nbo_results,
  type NboResult,
  parse_atom_ranges,
  type WavefunctionInfo,
} from "$lib/wavefunction/api";
import { flushSync, mount, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock(`$lib/workflow/plotly-utils`, () => ({
  lazy_load_plotly: () => new Promise(() => {}),
  make_target_writable: () => {},
  base_layout: (l: unknown) => l,
  base_config: () => ({}),
  observe_resize: () => () => {},
}));

/** 4×4×4 grid, 0.5 Å steps, origin (1, 2, 3), value = x + 2y + 3z (Å). */
function linear_grid(): VolumetricGrid {
  const dims: [number, number, number] = [4, 4, 4];
  const origin: [number, number, number] = [1, 2, 3];
  const data = new Float32Array(64);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      for (let k = 0; k < 4; k++) {
        const [x, y, z] = [1 + 0.5 * i, 2 + 0.5 * j, 3 + 0.5 * k];
        data[i * 16 + j * 4 + k] = x + 2 * y + 3 * z;
      }
    }
  }
  return {
    data,
    dims,
    origin,
    voxel_axes: [[0.5, 0, 0], [0, 0.5, 0], [0, 0, 0.5]],
    data_min: Math.min(...data),
    data_max: Math.max(...data),
  };
}

describe(`vertex colouring`, () => {
  test(`trilinear sampling reproduces a linear field`, () => {
    const sample = make_sampler(linear_grid());
    expect(sample(1.3, 2.7, 3.9)).toBeCloseTo(1.3 + 2 * 2.7 + 3 * 3.9, 4);
    // outside the box: clamped to the edge
    expect(sample(0, 2, 3)).toBeCloseTo(1 + 4 + 9, 4);
  });

  test(`colour scales pin their middle colour at zero`, () => {
    const bgr = { name: `bgr` as const, min: -0.04, max: 0.02 };
    expect(color_at(-0.04, bgr)).toEqual([0, 0, 1]);
    expect(color_at(0, bgr)[1]).toBeCloseTo(1);
    expect(color_at(0.02, bgr)).toEqual([1, 0, 0]);
    expect(color_at(0, { name: `esp`, min: -1, max: 1 })).toEqual([1, 1, 1]);
  });

  test(`colours a mesh and keeps the sampled values`, () => {
    const mesh: CubeMesh = {
      positions: new Float32Array([1, 2, 3, 2, 3, 4]),
      normals: new Float32Array(6),
      indices: new Uint32Array([]),
    };
    const out = color_mesh(mesh, linear_grid(), {
      name: `esp`,
      min: 0,
      max: 20,
    });
    expect(Array.from(out.values!)).toEqual([14, 20]);
    expect(out.colors).toHaveLength(6);
  });

  test(`finds and merges surface extrema`, () => {
    // a 3×3 vertex patch: centre is a minimum, two corners compete as maxima
    const pos: number[] = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) pos.push(i, j, 0);
    const idx: number[] = [];
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        const a = i * 3 + j;
        idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4);
      }
    }
    const values = new Float32Array([5, 1, 1, 1, -3, 1, 1, 1, 4]);
    const mesh: CubeMesh = {
      positions: new Float32Array(pos),
      normals: new Float32Array(pos.length),
      indices: new Uint32Array(idx),
    };
    const found = surface_extrema(mesh, values, 0.5);
    expect(found.find((e) => e.kind === `min`)).toMatchObject({
      value: -3,
      position: [1, 1, 0],
    });
    expect(found.filter((e) => e.kind === `max`).map((e) => e.value)).toEqual([
      5,
      4,
    ]);
    // merging radius larger than the corner spacing keeps only the strongest maximum
    expect(surface_extrema(mesh, values, 3).filter((e) => e.kind === `max`))
      .toHaveLength(1);
  });
});

describe(`api helpers`, () => {
  test(`parses atom ranges`, () => {
    expect(parse_atom_ranges(`1-3, 7 5`)).toEqual([1, 2, 3, 5, 7]);
    expect(() => parse_atom_ranges(`3-1`)).toThrow();
    expect(() => parse_atom_ranges(`a`)).toThrow();
  });

  test(`detects NBO output`, () => {
    expect(has_nbo_results(` Summary of Natural Population Analysis:`)).toBe(
      true,
    );
    expect(has_nbo_results(`SCF Done`)).toBe(false);
  });
});

const WATER: WavefunctionInfo = {
  session_id: `b`.repeat(32),
  format: `fchk`,
  filename: `water.fchk`,
  title: `water`,
  atoms: [
    { Z: 8, symbol: `O`, xyz: [0, 0, 0] },
    { Z: 1, symbol: `H`, xyz: [0, 0.76, 0.59] },
    { Z: 1, symbol: `H`, xyz: [0, -0.76, 0.59] },
  ],
  xyz: ``,
  charge: 0,
  multiplicity: 1,
  energy: -76,
  unrestricted: false,
  orbitals: [],
  frontier: {},
};

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

function click_tab(label: string) {
  const tab = [
    ...document.querySelectorAll<HTMLButtonElement>(`.orb-tabs button`),
  ].find((b) => b.textContent?.trim() === label);
  if (!tab) throw new Error(`no tab ${label}`);
  tab.click();
  flushSync();
}

function visible_pane(): HTMLElement {
  const pane = [...document.querySelectorAll<HTMLElement>(`.orb-pane`)].find((
    p,
  ) => !p.classList.contains(`hidden`));
  if (!pane) throw new Error(`no visible pane`);
  return pane;
}

describe(`wavefunction analysis panel`, () => {
  let calls: { url: string; body: unknown }[];

  beforeEach(() => {
    document.body.innerHTML = ``;
    calls = [];
    vi.stubGlobal(
      `fetch`,
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = typeof init?.body === `string`
          ? JSON.parse(init.body)
          : init?.body;
        calls.push({ url, body });
        if (url.includes(`multiwfn-status`)) {
          return json({ found: true, path: `/x/Multiwfn`, source: `PATH` });
        }
        if (url.endsWith(`/wavefunction/iri`)) {
          return json({
            iri_cube: `iri`,
            sl2r_cube: `sl2r`,
            scatter: { traces: [], layout: {}, annotations: [], n_points: 0 },
          });
        }
        if (url.endsWith(`/wavefunction/aim`)) {
          return json({
            critical_points: [
              {
                index: 1,
                type: `(3,-3)`,
                kind: `NCP`,
                position: [0, 0, 0],
                nucleus: 1,
                element: `O`,
              },
              {
                index: 4,
                type: `(3,-1)`,
                kind: `BCP`,
                position: [0, 0.5, 0.4],
                rho: 0.36,
                laplacian: -1.9,
                H: -0.5,
                ellipticity: 0.02,
                atoms: [1, 2],
              },
            ],
            bond_paths: [{
              cp: 4,
              atoms: [1, 2],
              points: [[0, 0, 0], [0, 0.5, 0.4], [0, 0.76, 0.59]],
            }],
            counts: { NCP: 1, BCP: 1 },
          });
        }
        return json({ detail: `unexpected ${url}` }, 500);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  test(`IRI sends the iso-surface coloured by sign(λ2)ρ`, async () => {
    const on_cube = vi.fn();
    mount(OrbitalPanel, {
      target: document.body,
      props: { pane_open: true, wavefunction: WATER, on_cube },
    });
    await settle();
    click_tab(`Weak interactions`);
    visible_pane().querySelector<HTMLButtonElement>(`.wfa-run`)!.click();
    await settle();

    const iri = calls.find((c) => c.url.endsWith(`/iri`));
    expect(iri?.body).toMatchObject({
      session_id: WATER.session_id,
      grid: `medium`,
    });
    const [file, options] = on_cube.mock.calls[0] as [
      File,
      Record<string, unknown>,
    ];
    expect(file.name).toBe(`water_IRI.cub`);
    expect(await file.text()).toBe(`iri`);
    expect(options).toMatchObject({
      color_scale: { name: `bgr`, min: -0.04, max: 0.02 },
      isovalue: 1,
    });
    expect((options.color_file as File).name).toBe(`water_sl2r.cub`);
  });

  test(`AIM shows critical points and bond paths`, async () => {
    const on_overlay = vi.fn();
    mount(OrbitalPanel, {
      target: document.body,
      props: {
        pane_open: true,
        wavefunction: WATER,
        on_cube: vi.fn(),
        on_overlay,
      },
    });
    await settle();
    click_tab(`AIM`);
    visible_pane().querySelector<HTMLButtonElement>(`.wfa-run`)!.click();
    await settle();

    const overlay = on_overlay.mock.calls.at(-1)?.[0];
    // NCPs hidden by default, BCP shown, one bond path
    expect(overlay.markers).toHaveLength(1);
    expect(overlay.lines).toHaveLength(1);
    const row = visible_pane().querySelector(`tbody tr`);
    expect(row?.textContent).toContain(`O1–H2`);
    expect(row?.textContent).toContain(`0.3600`);
  });

  test(`ESP extrema come from the mapped surface`, async () => {
    const on_overlay = vi.fn();
    const pos: number[] = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) pos.push(i, j, 0);
    const idx: number[] = [];
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        const a = i * 3 + j;
        idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4);
      }
    }
    const surface: CubeMesh = {
      positions: new Float32Array(pos),
      normals: new Float32Array(pos.length),
      indices: new Uint32Array(idx),
      values: new Float32Array([0.01, 0, 0, 0, -0.04, 0, 0, 0, 0.02]),
    };
    vi.stubGlobal(
      `fetch`,
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/esp`)) {
          return json({ density_cube: `rho`, esp_cube: `esp` });
        }
        return json({ found: true, path: `/x/Multiwfn`, source: `PATH` });
      }),
    );
    const on_cube = vi.fn();
    const panel = mount(OrbitalPanel, {
      target: document.body,
      props: {
        pane_open: true,
        wavefunction: WATER,
        on_cube,
        on_overlay,
        surface_mesh: surface,
      },
    });
    await settle();
    click_tab(`ESP`);
    // before the ESP run the shown surface is not an ESP map
    expect(visible_pane().textContent).not.toContain(`kcal/mol`);
    visible_pane().querySelector<HTMLButtonElement>(`.wfa-run`)!.click();
    await settle();
    expect(on_cube.mock.calls[0][1]).toMatchObject({
      isovalue: 0.001,
      color_scale: { name: `esp` },
    });
    expect(visible_pane().textContent).toContain(`-25.10`); // -0.04 Ha in kcal/mol

    const find = [
      ...visible_pane().querySelectorAll<HTMLButtonElement>(`.wfa-link`),
    ].find((b) => b.textContent?.includes(`extrema`))!;
    find.click();
    await settle();
    const overlay = on_overlay.mock.calls.at(-1)?.[0];
    expect(overlay.markers.length).toBeGreaterThanOrEqual(2);
    void panel;
  });

  test(`NBO-only mode opens the NBO tab and colours atoms by charge`, async () => {
    const nbo: NboResult = {
      charges: [
        {
          atom: 1,
          symbol: `O`,
          charge: -0.91,
          core: 2,
          valence: 6.9,
          rydberg: 0.01,
          total: 8.91,
        },
        {
          atom: 2,
          symbol: `H`,
          charge: 0.455,
          core: 0,
          valence: 0.54,
          rydberg: 0,
          total: 0.545,
        },
        {
          atom: 3,
          symbol: `H`,
          charge: 0.455,
          core: 0,
          valence: 0.54,
          rydberg: 0,
          total: 0.545,
        },
      ],
      wiberg: [],
      bonds: [{ atoms: [1, 2], wbi: 0.876 }],
      e2: [{
        donor_index: 4,
        donor: `LP ( 2) O 1`,
        acceptor_index: 8,
        acceptor: `BD*( 1) O 1 - H 2`,
        e2: 5.12,
        gap: 0.88,
        fock: 0.06,
        spin: null,
      }],
      n_e2: 1,
    };
    const on_charges = vi.fn();
    mount(OrbitalPanel, {
      target: document.body,
      props: {
        pane_open: true,
        wavefunction: null,
        nbo,
        on_cube: vi.fn(),
        on_charges,
      },
    });
    await settle();
    const tabs = [
      ...document.querySelectorAll<HTMLButtonElement>(`.orb-tabs button`),
    ];
    expect(tabs.filter((b) => !b.disabled).map((b) => b.textContent?.trim()))
      .toEqual([`NBO`]);
    const pane = visible_pane();
    expect(pane.textContent).toContain(`-0.9100`);
    pane.querySelector<HTMLButtonElement>(`.wfa-link`)!.click();
    expect(on_charges).toHaveBeenCalledWith([-0.91, 0.455, 0.455]);
  });
});
