# Gaussian IRC Point Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PR #539 associate every Gaussian IRC point with the final geometry and SCF energy from that point's own output interval, so correction iterations cannot shift frames or discard the endpoint.

**Architecture:** Parse `Point Number` markers as interval boundaries instead of collecting geometry, energy, and markers into independent arrays. Each completed interval yields one aligned record; checkpoint TS data fills only a missing point-zero record. TypeScript and Python implement the same record model and ordering contract.

**Tech Stack:** TypeScript, Python 3.11, Vitest, pytest, Gaussian text output.

## Global Constraints

- Preserve ordinary Gaussian orientation deduplication and Input-orientation fallback.
- Preserve physical IRC ordering: Path 2 endpoint → transition state → Path 1 endpoint.
- Never associate geometry, energy, and point metadata by independent global-array index.
- For an interval with multiple correction iterations, retain its final valid geometry and final SCF energy.
- Ignore orientation/energy blocks printed after the IRC summary.
- Keep Python and TypeScript behavior in parity.
- Follow strict TDD and commit after each task.
- Every shell command starts with `rtk`.
- Do not stage or modify `.claude/gate-approvals/`, `.claude/tmp-dump.traj`, or `.superpowers/`.

---

## File map

- Modify `src/lib/trajectory/parsers/gaussian.ts`: marker-bound interval records and trajectory construction.
- Modify `tests/vitest/trajectory/gaussian.test.ts`: realistic marker ordering and multi-correction regression.
- Modify `scripts/parse_gaussian.py`: Python interval-record parity.
- Modify `tests/test_parse_gaussian.py`: Python multi-correction regression and endpoint checks.

---

### Task 1: TypeScript interval-aligned IRC records

**Files:**
- Modify: `src/lib/trajectory/parsers/gaussian.ts`
- Modify: `tests/vitest/trajectory/gaussian.test.ts`

**Interfaces:**
- Produces:
  - `GaussianIrcRecord { point, path, geometry, energy }`
  - `parse_irc_records(content, lines): GaussianIrcRecord[] | undefined`
- Consumes: existing orientation and checkpoint parsers.

- [ ] **Step 1: Rewrite the synthetic fixture in actual completed-point order**

Add a helper that prints all geometry/SCF attempts before the marker that
completes the point:

```ts
const completed_point = (
  point_number: number,
  path_number: number,
  attempts: Array<{ x: number; energy: number }>,
) => attempts.map(({ x, energy }) =>
  orientation_block(`Input orientation`, x) + scf_energy(energy)
).join(``) + point(point_number, path_number)
```

Checkpoint point zero remains a marker with no preceding orientation/SCF; it is
filled from `Redundant internal coordinates` and `Energy From Chk`.

- [ ] **Step 2: Add the failing correction-iteration regression**

```ts
it(`keeps the final correction geometry and energy inside each IRC point`, () => {
  const content = ` IRC-IRC-IRC-IRC-IRC-
 Redundant internal coordinates found in file.  (old form).
 C,0,0.000000,0.000000,0.000000
 Recover connectivity data from disk.
 Energy From Chk = -10.00000000
${point(0, 1)}
${completed_point(1, 1, [
  { x: 1.1, energy: -10.01 },
  { x: 1.0, energy: -10.10 },
])}
${completed_point(2, 1, [{ x: 2.0, energy: -10.20 }])}
${completed_point(1, 2, [{ x: -1.0, energy: -10.30 }])}
${completed_point(2, 2, [{ x: -2.0, energy: -10.40 }])}
${irc_summary}
${orientation_block(`Input orientation`, 999)}
${scf_energy(-99)}
`

  const trajectory = parse_gaussian_output(content)

  expect(trajectory.frames.map((frame) => frame.structure.sites[0].xyz[0])).toEqual([
    -2, -1, 0, 1, 2,
  ])
  expect(trajectory.frames.map((frame) => frame.metadata?.energy)).toEqual([
    -10.4, -10.3, -10, -10.1, -10.2,
  ].map((value) => value * 27.211386245988))
  expect(trajectory.frames.some((frame) => frame.structure.sites[0].xyz[0] === 1.1)).toBe(false)
  expect(trajectory.frames.some((frame) => frame.structure.sites[0].xyz[0] === 999)).toBe(false)
})
```

- [ ] **Step 3: Run the test and verify RED**

```bash
rtk pnpm vitest run tests/vitest/trajectory/gaussian.test.ts
```

Expected: FAIL because global-array indexing selects the intermediate attempt,
shifts following records, or drops the final endpoint.

- [ ] **Step 4: Implement interval records**

Define:

```ts
type GaussianIrcRecord = {
  point: number
  path: number
  geometry: GaussianGeometry
  energy: number
}
```

Use `matchAll` to retain each marker's `index`. For marker `i`, inspect only the
text after marker `i - 1` and before marker `i`; choose the final preferred
orientation and final `SCF Done` value in that interval.

```ts
const marker_matches = [...content.matchAll(
  /Point Number:\s*(\d+)\s+Path Number:\s*(\d+)/g,
)]
const irc_start = content.lastIndexOf(`IRC-IRC-IRC-`, marker_matches[0].index)

for (let idx = 0; idx < marker_matches.length; idx++) {
  const marker = marker_matches[idx]
  const interval_start = idx === 0
    ? Math.max(0, irc_start)
    : marker_matches[idx - 1].index! + marker_matches[idx - 1][0].length
  const interval = content.slice(interval_start, marker.index)
  const geometries = parse_orientation_blocks(
    interval.split(/\r?\n/),
    preferred_orientation,
  )
  const energies = parse_scf_energies(interval)
  let geometry = geometries.at(-1)
  let energy = energies.at(-1)

  const point = Number(marker[1])
  const path = Number(marker[2])
  if (point === 0) {
    geometry ??= checkpoint_geometry
    energy ??= checkpoint_energy
  }
  if (!geometry || energy === undefined) return undefined
  records.push({ point, path, geometry, energy })
}
```

Extract `parse_scf_energies(content)` so interval and ordinary parsing use one
number conversion.

Build frames from records, not `raw_geometries`, `raw_energies`, or
`ordered_indices` into unrelated arrays:

```ts
const ordered_records = [
  ...records.filter(({ path }) => path === 2).reverse(),
  ...records.filter(({ path }) => path === 1),
]
```

The summary is outside every completed-point interval and cannot contribute a
geometry or energy.

- [ ] **Step 5: Run TypeScript tests and verify GREEN**

```bash
rtk pnpm vitest run tests/vitest/trajectory/gaussian.test.ts
```

Expected: all Gaussian parser tests PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add \
  src/lib/trajectory/parsers/gaussian.ts \
  tests/vitest/trajectory/gaussian.test.ts
rtk git commit -m "fix(trajectory): align Gaussian IRC point records"
```

---

### Task 2: Python parser parity

**Files:**
- Modify: `scripts/parse_gaussian.py`
- Modify: `tests/test_parse_gaussian.py`

**Interfaces:**
- Produces: `_parse_irc_records(content, orientation)` with record dictionaries.
- Consumes: `_parse_orientation_blocks`, checkpoint parsers.

- [ ] **Step 1: Add the matching failing Python test**

Use the same `completed_point` helper and correction sequence as Task 1.
Assert exact ordered X coordinates and Hartree energies:

```py
def test_keeps_final_correction_for_each_irc_point(tmp_path):
    output = tmp_path / "irc-corrections.out"
    output.write_text(
        " IRC-IRC-IRC-IRC-IRC-\n"
        " Redundant internal coordinates found in file.  (old form).\n"
        " C,0,0.000000,0.000000,0.000000\n"
        " Recover connectivity data from disk.\n"
        " Energy From Chk = -10.00000000\n"
        + _point(0, 1)
        + _completed_point(1, 1, [(1.1, -10.01), (1.0, -10.1)])
        + _completed_point(2, 1, [(2.0, -10.2)])
        + _completed_point(1, 2, [(-1.0, -10.3)])
        + _completed_point(2, 2, [(-2.0, -10.4)])
        + " Summary of reaction path following\n"
        + _orientation_block("Input orientation", 999)
        + _scf_energy(-99)
    )

    energies, *_, geometries = parse_gaussian(output)

    assert [frame[0][1] for frame in geometries] == [-2, -1, 0, 1, 2]
    assert energies == [-10.4, -10.3, -10.0, -10.1, -10.2]
```

- [ ] **Step 2: Run the test and verify RED**

```bash
rtk python -m pytest tests/test_parse_gaussian.py -q
```

Expected: FAIL with shifted geometry/energy or a missing endpoint.

- [ ] **Step 3: Implement the same interval model**

Use `re.finditer` for marker spans. For each marker, slice from the previous
marker end to the current marker start; select `geometries[-1]` and
`energies[-1]`. Apply checkpoint fallback only when `point == 0` lacks a value.

Return records and order them as:

```py
ordered = (
    list(reversed([record for record in records if record["path"] == 2]))
    + [record for record in records if record["path"] == 1]
)
energies = [record["energy"] for record in ordered]
geometries = [record["geometry"] for record in ordered]
```

Delete the global-array length guard and index-based truncation.

- [ ] **Step 4: Run Python and cross-language tests**

```bash
rtk python -m pytest tests/test_parse_gaussian.py -q
rtk pnpm vitest run tests/vitest/trajectory/gaussian.test.ts
```

Expected: both suites PASS with matching coordinate and energy order.

- [ ] **Step 5: Commit**

```bash
rtk git add scripts/parse_gaussian.py tests/test_parse_gaussian.py
rtk git commit -m "fix(parser): align Python Gaussian IRC records"
```

---

### Task 3: Parser acceptance gates and PR update

**Files:**
- Modify only if a verification gate exposes a regression.

- [ ] **Step 1: Run all Gaussian-specific tests**

```bash
rtk python -m pytest tests/test_parse_gaussian.py -q
rtk pnpm vitest run tests/vitest/trajectory/gaussian.test.ts
```

Expected: all tests PASS.

- [ ] **Step 2: Run adjacent trajectory parser tests**

```bash
rtk pnpm vitest run tests/vitest/trajectory tests/vitest/vasprun-trajectory.test.ts
```

Expected: all tests PASS.

- [ ] **Step 3: Run frontend typecheck**

```bash
rtk pnpm check
```

Expected: 0 errors.

- [ ] **Step 4: Run the Python parser suite**

```bash
rtk python -m pytest tests/test_parse_gaussian.py tests/test_scripts.py -q
```

If `tests/test_scripts.py` does not exist on the PR branch, run the complete
`tests/test_parse_gaussian.py` file plus the repository's parser test directory
identified by `rtk rg --files tests | rtk rg 'parse|parser'`.

Expected: all in-scope parser tests PASS.

- [ ] **Step 5: Verify repository hygiene**

```bash
rtk git diff --check
rtk git status --short
```

Expected: clean tracked worktree; protected paths are not staged.

- [ ] **Step 6: Update PR #539**

Push the local commits to `AmonB/fix/gaussian-frame-count-irc` using the
maintainer-edit permission, update the PR verification section, and leave the
worktree intact for review.
