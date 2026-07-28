# Indexed Trajectory Frame-Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every frame of a locally indexed trajectory loadable after desktop library/pane handoff, and keep the last valid 3D scene mounted when an individual frame cannot be loaded.

**Architecture:** Indexed parse results own an explicit `frame_loader` plus immutable `frame_source_data` reference. Pane cloning shares the source buffer while forking loader state; `Trajectory.svelte` delegates async loading and latest-request arbitration to a focused frame-request helper, and treats missing frames as recoverable errors instead of clearing `current_structure`.

**Tech Stack:** TypeScript 5.9, Svelte 5, Vitest 4, browser WebGL2/Three.js, existing `TrajFrameReader` ASE/XYZ parser.

## Global Constraints

- No 60 FPS work, renderer redesign, or impostor changes.
- Do not eagerly materialize all frames.
- Do not create a base64 or second ArrayBuffer copy of large local trajectories.
- Keep decoded-frame caching bounded exactly as it is today.
- A failed frame must keep the previous structure visible, pause playback, and report the requested index.
- Use the exact `/home/james0001/Downloads/dump.traj` browser regression after automated tests.

---

## File map

- `src/lib/trajectory/index.ts`: public runtime shape for indexed source data.
- `src/lib/trajectory/parse.ts`: publishes loader and immutable source with indexed results.
- `src/lib/trajectory/clone.ts`: shares source by identity and forks loader state per pane.
- `src/lib/trajectory/parsers/frame-loader.ts`: preserves cached ASE atomic numbers when forking.
- `src/lib/trajectory/frame-loading.ts`: focused latest-request and recoverable-failure policy.
- `src/lib/trajectory/Trajectory.svelte`: integrates the source contract without clearing a valid scene.
- `tests/vitest/trajectory/streaming.test.ts`: parser → pane-clone boundary regression.
- `tests/vitest/trajectory/pane-isolation.test.ts`: source sharing and loader isolation regression.
- `tests/vitest/trajectory/frame-loading.test.ts`: request ordering, source selection, and failure retention.

### Task 1: Publish and preserve the local indexed source

**Files:**
- Modify: `tests/vitest/trajectory/streaming.test.ts`
- Modify: `tests/vitest/trajectory/pane-isolation.test.ts`
- Modify: `src/lib/trajectory/index.ts:39-52`
- Modify: `src/lib/trajectory/parse.ts:354-422`
- Modify: `src/lib/trajectory/clone.ts:8-10,194-215`
- Modify: `src/lib/trajectory/Trajectory.svelte:37-40,1332-1353`

**Interfaces:**
- Produces: `TrajectoryType.frame_loader?: FrameLoader`
- Produces: `TrajectoryType.frame_source_data?: string | ArrayBuffer`
- Invariant: pane clones share `frame_source_data` by `===` and own distinct loaders.

- [ ] **Step 1: Write the failing parser-to-pane regression test**

Add `clone_trajectory_for_pane` to the imports in `streaming.test.ts`, then add:

```ts
it(`keeps the first non-preloaded local ASE frame loadable after pane cloning`, async () => {
  const source = create_synthetic_ase(5)
  const parsed = await parse_trajectory_async(
    source,
    `local.traj`,
    undefined,
    { extract_plot_metadata: false },
  )

  expect(parsed.frames).toHaveLength(4)
  expect(parsed.total_frames).toBe(5)

  const pane = clone_trajectory_for_pane(parsed)
  expect(pane.frame_loader).toBeDefined()
  expect(pane.frame_source_data).toBe(source)
  expect(pane.frame_loader).not.toBe(parsed.frame_loader)

  const frame_4 = await pane.frame_loader!.load_frame(
    pane.frame_source_data!,
    4,
  )
  expect(frame_4?.step).toBe(4)
  expect(frame_4?.structure.sites).toHaveLength(2)
})
```

In `pane-isolation.test.ts`, extend the existing loader-fork test with a small
`ArrayBuffer` source and assert both clones retain the same source reference.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/vitest/trajectory/streaming.test.ts tests/vitest/trajectory/pane-isolation.test.ts
```

Expected: FAIL because `frame_loader` and `frame_source_data` are absent from the parser result; existing tests remain green.

- [ ] **Step 3: Add the typed source contract and publish it atomically**

Add to `TrajectoryType`:

```ts
/** Runtime loader for indexed/local or remotely streamed frames. */
frame_loader?: FrameLoader
/** Immutable source consumed by frame_loader; shared by reference across panes. */
frame_source_data?: string | ArrayBuffer
```

Return both values from `parse_with_unified_loader()`:

```ts
return {
  frames,
  // existing metadata/index fields
  frame_loader: loader,
  frame_source_data: data,
}
```

Simplify `PaneTrajectory` so it inherits `frame_loader` and
`frame_source_data` from `TrajectoryType`. The existing object spread in
`clone_trajectory_for_pane()` intentionally retains the source reference;
keep the existing `fork_loader()` assignment for loader isolation.

In `Trajectory.svelte::load_with_indexing`, stop attaching a second loader.
Use the parser-owned loader/source pair and retain `orig_data = data` only as
a compatibility fallback for older external trajectory objects.

- [ ] **Step 4: Run the targeted tests and verify GREEN**

Run the Step 2 command.

Expected: all streaming and pane-isolation tests PASS; the new test confirms
the first non-preloaded frame is loadable and the source is not copied.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/lib/trajectory/index.ts src/lib/trajectory/parse.ts src/lib/trajectory/clone.ts src/lib/trajectory/Trajectory.svelte tests/vitest/trajectory/streaming.test.ts tests/vitest/trajectory/pane-isolation.test.ts
git commit -m "fix(trajectory): preserve indexed frame source"
```

### Task 2: Preserve ASE element state across loader forks

**Files:**
- Modify: `tests/vitest/trajectory/streaming.test.ts`
- Modify: `src/lib/trajectory/parsers/frame-loader.ts:31-37`

**Interfaces:**
- Consumes: `FrameLoader.fork(): FrameLoader`
- Produces: a forked `TrajFrameReader` that can random-access ASE frames whose record omits unchanged atomic numbers.

- [ ] **Step 1: Add a synthetic ASE helper with numbers only in frame zero**

Reuse the existing fixed-size ASE fixture and replace the later frames'
`numbers` property with equal-length JSON whitespace. Equal length keeps its
ULM offset table valid while accurately modelling ASE's shared-number layout:

```ts
const strip_ase_numbers_after_first = (
  buffer: ArrayBuffer,
  num_frames: number,
): ArrayBuffer => {
  const view = new DataView(buffer)
  const offsets_pos = Number(view.getBigInt64(40, true))
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const token = `"numbers":[1,1],`
  for (let idx = 1; idx < num_frames; idx++) {
    const frame_offset = Number(view.getBigInt64(offsets_pos + idx * 8, true))
    const json_length = Number(view.getBigInt64(frame_offset, true))
    const bytes = new Uint8Array(buffer, frame_offset + 8, json_length)
    const json = decoder.decode(bytes)
    const stripped = json.replace(token, ` `.repeat(token.length))
    expect(stripped).not.toBe(json)
    bytes.set(encoder.encode(stripped))
  }
  return buffer
}
```

- [ ] **Step 2: Write and verify the failing fork test**

```ts
it(`preserves ASE global numbers when a reader is forked`, async () => {
  const data = strip_ase_numbers_after_first(create_synthetic_ase(5), 5)
  const original = new TrajFrameReader(`local.traj`)
  expect(await original.load_frame(data, 0)).not.toBeNull()

  const fork = original.fork!()
  const frame_4 = await fork.load_frame(data, 4)

  expect(frame_4?.step).toBe(4)
  expect(frame_4?.structure.sites).toHaveLength(2)
})
```

Run:

```bash
pnpm exec vitest run tests/vitest/trajectory/streaming.test.ts
```

Expected: FAIL because the fresh fork has no `global_numbers`; the loader logs
that atomic numbers or positions are missing and returns `null`.

- [ ] **Step 3: Copy immutable cached numbers into the fork**

Implement `TrajFrameReader.fork()` as:

```ts
fork(): FrameLoader {
  const fork = new TrajFrameReader(this.filename)
  fork.global_numbers = this.global_numbers ? [...this.global_numbers] : undefined
  return fork
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run the Step 2 command.

Expected: all streaming tests PASS with no missing-numbers warning.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/lib/trajectory/parsers/frame-loader.ts tests/vitest/trajectory/streaming.test.ts
git commit -m "fix(trajectory): preserve ASE loader state on fork"
```

### Task 3: Keep the last valid frame on load failure

**Files:**
- Create: `src/lib/trajectory/frame-loading.ts`
- Create: `tests/vitest/trajectory/frame-loading.test.ts`
- Modify: `src/lib/trajectory/Trajectory.svelte:460-502,772-806`

**Interfaces:**
- Produces: `create_frame_request_loader(): FrameRequestLoader`
- Produces: `FrameRequestLoader.load(trajectory, frame_idx, previous, fallback_source): Promise<FrameRequestOutcome>`
- Produces: `select_in_memory_frame(next, previous, frame_idx): FrameRequestOutcome`
- Produces outcomes: `{ status: 'loaded'; frame }`, `{ status: 'failed'; frame; error }`, or `{ status: 'stale' }`.

- [ ] **Step 1: Write failing tests for source ownership, failure retention, and latest-wins ordering**

Create `frame-loading.test.ts` with real `FrameLoader` implementations and
these complete helpers:

```ts
import type {
  FrameLoader,
  TrajectoryFrame,
  TrajectoryType,
} from '$lib/trajectory'
import {
  create_frame_request_loader,
  select_in_memory_frame,
} from '$lib/trajectory/frame-loading'
import { describe, expect, it } from 'vitest'

const frame = (step: number): TrajectoryFrame => ({
  step,
  structure: { sites: [] } as TrajectoryFrame['structure'],
})

const trajectory_with_loader = (
  load_frame: FrameLoader['load_frame'],
  frame_source_data: string | ArrayBuffer,
): TrajectoryType => ({
  frames: [frame(0)],
  total_frames: 2,
  is_indexed: true,
  frame_source_data,
  frame_loader: {
    get_total_frames: async () => 2,
    build_frame_index: async () => [],
    load_frame,
    extract_plot_metadata: async () => [],
  },
})

const deferred_frame_loader = () => {
  const resolvers = new Map<
    number,
    (value: TrajectoryFrame | null) => void
  >()
  const load_frame: FrameLoader['load_frame'] = (_data, idx) =>
    new Promise((resolve) => resolvers.set(idx, resolve))
  return {
    load_frame,
    resolve: (idx: number, value: TrajectoryFrame | null) => {
      const resolve = resolvers.get(idx)
      if (!resolve) throw new Error(`No pending frame ${idx}`)
      resolve(value)
    },
  }
}
```

Then add:

```ts
it(`uses trajectory source data instead of the compatibility fallback`, async () => {
  const owned = new ArrayBuffer(8)
  const fallback = new ArrayBuffer(4)
  let received: string | ArrayBuffer | undefined
  const previous = frame(0)
  const trajectory = trajectory_with_loader(async (data) => {
    received = data
    return frame(1)
  }, owned)
  const requests = create_frame_request_loader()

  const result = await requests.load(trajectory, 1, previous, fallback)

  expect(result.status).toBe(`loaded`)
  expect(received).toBe(owned)
})

it(`keeps the previous frame when the loader returns null`, async () => {
  const previous = frame(3)
  const requests = create_frame_request_loader()
  const result = await requests.load(
    trajectory_with_loader(async () => null, new ArrayBuffer(1)),
    4,
    previous,
    null,
  )

  expect(result.status).toBe(`failed`)
  if (result.status === `failed`) {
    expect(result.frame).toBe(previous)
    expect(result.error.message).toContain(`frame 4`)
  }
})

it(`marks an older async completion stale`, async () => {
  const pending = deferred_frame_loader()
  const trajectory = trajectory_with_loader(pending.load_frame, new ArrayBuffer(1))
  const requests = create_frame_request_loader()
  const old_request = requests.load(trajectory, 1, frame(0), null)
  const new_request = requests.load(trajectory, 2, frame(0), null)

  pending.resolve(2, frame(2))
  expect((await new_request).status).toBe(`loaded`)
  pending.resolve(1, frame(1))
  expect((await old_request).status).toBe(`stale`)
})
```

Add the thrown-loader and in-memory guard tests:

```ts
it(`keeps the previous frame when the loader throws`, async () => {
  const previous = frame(3)
  const requests = create_frame_request_loader()
  const result = await requests.load(
    trajectory_with_loader(async () => { throw new Error(`decode failed`) }, new ArrayBuffer(1)),
    4,
    previous,
    null,
  )

  expect(result.status).toBe(`failed`)
  if (result.status === `failed`) {
    expect(result.frame).toBe(previous)
    expect(result.error.message).toContain(`decode failed`)
  }
})

it(`keeps the previous frame when an in-memory index is missing`, () => {
  const previous = frame(3)
  const result = select_in_memory_frame(undefined, previous, 4)
  expect(result.status).toBe(`failed`)
  if (result.status === `failed`) {
    expect(result.frame).toBe(previous)
    expect(result.error.message).toContain(`frame 4`)
  }
})
```

- [ ] **Step 2: Run the new test and verify RED**

```bash
pnpm exec vitest run tests/vitest/trajectory/frame-loading.test.ts
```

Expected: FAIL because `frame-loading.ts` and
`create_frame_request_loader()` do not exist.

- [ ] **Step 3: Implement the minimal request loader**

Create `frame-loading.ts`:

```ts
import type { TrajectoryFrame, TrajectoryType } from './index'

export type FrameRequestOutcome =
  | { status: `loaded`; frame: TrajectoryFrame }
  | { status: `failed`; frame: TrajectoryFrame | null; error: Error }
  | { status: `stale` }

export interface FrameRequestLoader {
  invalidate(): void
  load(
    trajectory: TrajectoryType,
    frame_idx: number,
    previous: TrajectoryFrame | null,
    fallback_source: string | ArrayBuffer | null,
  ): Promise<FrameRequestOutcome>
}

export function select_in_memory_frame(
  next: TrajectoryFrame | null | undefined,
  previous: TrajectoryFrame | null,
  frame_idx: number,
): Exclude<FrameRequestOutcome, { status: `stale` }> {
  return next?.structure
    ? { status: `loaded`, frame: next }
    : {
        status: `failed`,
        frame: previous,
        error: new Error(`Failed to load frame ${frame_idx}`),
      }
}

export function create_frame_request_loader(): FrameRequestLoader {
  let latest_request = 0
  return {
    invalidate: () => { latest_request += 1 },
    async load(
      trajectory: TrajectoryType,
      frame_idx: number,
      previous: TrajectoryFrame | null,
      fallback_source: string | ArrayBuffer | null,
    ): Promise<FrameRequestOutcome> {
      const request = ++latest_request
      const loader = trajectory.frame_loader
      if (!loader) {
        return { status: `failed`, frame: previous, error: new Error(`No loader for frame ${frame_idx}`) }
      }
      try {
        const source = trajectory.frame_source_data ?? fallback_source ?? ``
        const frame = await loader.load_frame(source, frame_idx)
        if (request !== latest_request) return { status: `stale` }
        if (!frame?.structure) {
          return { status: `failed`, frame: previous, error: new Error(`Failed to load frame ${frame_idx}`) }
        }
        return { status: `loaded`, frame }
      } catch (cause) {
        if (request !== latest_request) return { status: `stale` }
        const detail = cause instanceof Error ? cause.message : String(cause)
        return {
          status: `failed`,
          frame: previous,
          error: new Error(`Failed to load frame ${frame_idx}: ${detail}`),
        }
      }
    },
  }
}
```

- [ ] **Step 4: Run the new test and verify GREEN**

Run the Step 2 command.

Expected: all four frame-loading tests PASS.

- [ ] **Step 5: Integrate the request loader into `Trajectory.svelte`**

Create one request loader per component, invalidate it when trajectory identity
changes, and replace `load_frame_on_demand()` with:

```ts
const frame_requests = create_frame_request_loader()

async function load_frame_on_demand(frame_idx: number) {
  if (!trajectory?.frame_loader) return
  const result = await frame_requests.load(
    trajectory,
    frame_idx,
    untrack(() => current_frame),
    untrack(() => orig_data),
  )
  if (result.status === `stale`) return
  if (result.status === `loaded`) {
    current_frame = result.frame
    return
  }
  current_frame = result.frame
  if (is_playing) pause_playback()
  on_error?.({
    error_msg: result.error.message,
    filename: current_filename,
    file_size,
    step_idx: frame_idx,
    frame_count: total_frames,
  })
}
```

In the in-memory branch, pass `trajectory.frames[idx]`, `current_frame`, and
the index through `select_in_memory_frame()`. Feed its loaded/failed outcome
through the same assignment, pause, and error-report path as indexed loads.

Change idle warmup to pass
`traj.frame_source_data ?? untrack(() => orig_data) ?? ''` to the loader.

- [ ] **Step 6: Run trajectory tests and project type checks**

```bash
pnpm exec vitest run tests/vitest/trajectory
pnpm run check
```

Expected: all trajectory tests PASS and `svelte-check` reports 0 errors.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/lib/trajectory/frame-loading.ts src/lib/trajectory/Trajectory.svelte tests/vitest/trajectory/frame-loading.test.ts
git commit -m "fix(trajectory): retain scene on frame load failure"
```

### Task 4: Build and reproduce the exact user workflow

**Files:**
- Verify only; no planned production edits.

**Interfaces:**
- Consumes: the complete indexed source and recoverable failure behavior from Tasks 1–3.
- Produces: fresh automated and browser evidence for the exact 48 MB trajectory.

- [ ] **Step 1: Run the full focused verification suite**

```bash
pnpm exec vitest run tests/vitest/trajectory tests/vitest/structure/bonding
pnpm run check
```

Expected: 0 failed tests and 0 check errors.

- [ ] **Step 2: Build the static desktop frontend**

```bash
VITE_STATIC_ONLY=true pnpm exec vite build --config vite.desktop.config.ts
```

Expected: exit code 0 and a fresh `build-desktop` bundle.

- [ ] **Step 3: Run the exact browser regression**

Serve `build-desktop` and `/home/james0001/Downloads/dump.traj` from temporary
localhost ports, then use a clean isolated browser context to:

1. load the exact file and confirm 100 reported frames;
2. scrub from index 3 to index 4 and confirm one live Canvas remains;
3. press Play and cross index 3 → 4;
4. jump to index 99 and confirm the structure remains visible;
5. assert `gl.isContextLost() === false`, no `webglcontextlost` event, and no
   `WEBGL_lose_context.loseContext()` call during navigation.

Expected: all five checks pass. Backend `Failed to list ~` noise is ignored.

- [ ] **Step 4: Inspect final diff and commit any verification-only correction**

```bash
git status --short
git diff --check
git log --oneline -5
```

Expected: only intentional files changed, no whitespace errors, and the three
implementation commits are present. Do not create a correction commit unless
the browser regression required a production change followed by another red-green cycle.
