# C1 — Adsorbate-Only Freeze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make frequency calculations physically correct — fix the entire slab and vibrate only the adsorbate — by tagging adsorbate atoms and adding a `freeze_mode: adsorbate`.

**Architecture:** `run_adsorbate_place` writes an `is_adsorbate` boolean site property on every output structure. A new `adsorbate` freeze mode (backend `vasp.py` + frontend `freeze.ts`) freezes every atom whose `is_adsorbate` is not True. The freq node defaults to this mode and the editor offers a one-click preset.

**Tech Stack:** Python (pymatgen, pytest), Svelte 5 / TypeScript (vitest).

## Global Constraints

- Python style: type hints, docstrings, specific exceptions, module logger (no `print`).
- Frontend style (enforced by `deno fmt`, do by hand — no deno here): single quotes, no semicolons, 2-space indent, 90-col.
- Tests: pytest under `server/tests/` run via `uv run pytest` (pytest-asyncio NOT installed — drive coroutines with `asyncio.run`). Frontend vitest via `pnpm test`.
- `is_adsorbate` is a per-site boolean stored under each site's `properties` (pymatgen `site_properties`), True on adsorbate atoms, False on slab atoms.

---

### Task 1: Tag adsorbate atoms in `run_adsorbate_place`

**Files:**
- Modify: `server/catgo/workflow/builtins_impl.py` (ferrox path `463-477`, pymatgen fallback `345-352`)
- Test: `server/tests/test_adsorbate_tagging.py`

**Interfaces:**
- Produces: `run_adsorbate_place(...)` output `{"structure": <json>}` where the parsed pymatgen Structure has site property `is_adsorbate: list[bool]` (len == n_atoms), False for the first `n_slab` slab atoms and True for the appended adsorbate atoms.

- [ ] **Step 1: Write the failing test**

```python
# server/tests/test_adsorbate_tagging.py
"""run_adsorbate_place must tag adsorbate atoms with is_adsorbate=True."""
import json
from pymatgen.core import Lattice, Structure
from catgo.workflow.builtins_impl import run_adsorbate_place


def _slab_json() -> str:
    lat = Lattice.from_parameters(3, 3, 20, 90, 90, 90)
    s = Structure(lat, ["Pt"] * 4, [[0, 0, 0.2], [0, 0, 0.3], [0, 0, 0.4], [0, 0, 0.5]])
    s.add_site_property("selective_dynamics", [[False] * 3, [False] * 3, [True] * 3, [True] * 3])
    return json.dumps(s.as_dict())


def test_adsorbate_atoms_are_tagged():
    out = run_adsorbate_place(structure=_slab_json(), species="OH", site="ontop", height=2.0)
    s = Structure.from_dict(json.loads(out["structure"]))
    tag = s.site_properties.get("is_adsorbate")
    assert tag is not None, "is_adsorbate property missing"
    assert len(tag) == len(s)
    assert tag[:4] == [False, False, False, False]   # slab
    assert all(tag[4:]) and len(tag) > 4              # adsorbate (OH = 2 atoms)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_adsorbate_tagging.py -q`
Expected: FAIL — `is_adsorbate property missing` (ferrox absent here → fallback path runs).

- [ ] **Step 3: Implement — pymatgen fallback path**

In `builtins_impl.py`, replace the fallback return (currently lines ~345-352):

```python
        new_slab = slab.copy()
        for elem, off in zip(elements, coords):
            new_slab.append(
                elem,
                [chosen_3d[0] + off[0], chosen_3d[1] + off[1], chosen_3d[2] + off[2]],
                coords_are_cartesian=True,
            )
        n_slab = len(slab)
        new_slab.add_site_property(
            "is_adsorbate", [i >= n_slab for i in range(len(new_slab))]
        )
        return {"structure": json.dumps(new_slab.as_dict())}
```

- [ ] **Step 4: Implement — ferrox path**

In the ferrox `out_sites` loop (lines ~464-477), tag each site. Change the loop body so `props` always carries the flag:

```python
        if i < n_slab:
            props = dict(slab_dict["sites"][i].get("properties") or {})
        else:
            props = {"selective_dynamics": [True, True, True]} if slab_has_sd else {}
        props["is_adsorbate"] = i >= n_slab
        out_sites.append({
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && uv run pytest tests/test_adsorbate_tagging.py -q`
Expected: PASS (fallback path here; ferrox path covered by code review since ferrox is unavailable in this env).

- [ ] **Step 6: Commit**

```bash
git add server/catgo/workflow/builtins_impl.py server/tests/test_adsorbate_tagging.py
git commit -m "feat(workflow): tag adsorbate atoms with is_adsorbate in adsorbate_place"
```

---

### Task 2: Backend `freeze_mode: adsorbate` in VASP freq generation

**Files:**
- Modify: `server/workflow/engines/vasp.py` (freq freeze block `289-349`)
- Test: `server/tests/test_freq_adsorbate_freeze.py`

**Interfaces:**
- Consumes: structures carrying `is_adsorbate` site property (Task 1).
- Produces: when `params["freeze_mode"] == "adsorbate"`, `generate_vasp_input_files("freq", params, structure_str)` returns a POSCAR whose adsorbate atoms (is_adsorbate True) are `T T T` and all other atoms `F F F`. When no `is_adsorbate` tag is present, it logs a warning and freezes nothing.

- [ ] **Step 1: Write the failing test**

```python
# server/tests/test_freq_adsorbate_freeze.py
"""freeze_mode=adsorbate fixes the whole slab, frees only tagged adsorbate atoms."""
import json
from pymatgen.core import Lattice, Structure
from workflow.engines.vasp import generate_vasp_input_files


def _tagged_structure() -> str:
    lat = Lattice.from_parameters(3, 3, 20, 90, 90, 90)
    s = Structure(lat, ["Pt", "Pt", "Pt", "O", "H"],
                  [[0, 0, 0.2], [0, 0, 0.3], [0, 0, 0.4], [0, 0, 0.6], [0, 0, 0.65]])
    s.add_site_property("is_adsorbate", [False, False, False, True, True])
    return json.dumps(s.as_dict())


def _counts(poscar: str):
    lines = poscar.splitlines()
    fff = sum(1 for l in lines if "F F F" in l)
    ttt = sum(1 for l in lines if "T T T" in l)
    hdr = any("elective" in l for l in lines[:9])
    return hdr, fff, ttt


def test_adsorbate_mode_freezes_slab_frees_adsorbate():
    files, _, _ = generate_vasp_input_files("freq", {"freeze_mode": "adsorbate"}, _tagged_structure())
    hdr, fff, ttt = _counts(files["POSCAR"])
    assert hdr and fff == 3 and ttt == 2   # 3 slab fixed, 2 adsorbate free


def test_adsorbate_mode_without_tag_warns_and_freezes_nothing():
    lat = Lattice.from_parameters(3, 3, 20, 90, 90, 90)
    s = Structure(lat, ["Pt", "O"], [[0, 0, 0.2], [0, 0, 0.6]])
    files, _, _ = generate_vasp_input_files("freq", {"freeze_mode": "adsorbate"}, json.dumps(s.as_dict()))
    _, fff, _ = _counts(files["POSCAR"])
    assert fff == 0   # no tag -> nothing frozen
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_freq_adsorbate_freeze.py -q`
Expected: FAIL — `adsorbate` mode not handled, frozen_set empty → `fff == 0` (first test fails).

- [ ] **Step 3: Implement the adsorbate branch**

In `vasp.py`, inside the `if node_type in ("freq", "frequency"):` block, add a branch alongside the others (after the `element` branch, before `layers/bottom`):

```python
        elif freeze_mode == "adsorbate" and struct:
            tags = struct.site_properties.get("is_adsorbate")
            if not tags or not any(tags):
                logger.warning(
                    "[FREEZE] freeze_mode=adsorbate but structure has no is_adsorbate "
                    "tag (%d atoms) — freezing nothing", n_atoms)
            else:
                for idx, is_ads in enumerate(tags):
                    if not is_ads:
                        frozen_set.add(idx)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && uv run pytest tests/test_freq_adsorbate_freeze.py -q`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add server/workflow/engines/vasp.py server/tests/test_freq_adsorbate_freeze.py
git commit -m "feat(vasp): add freeze_mode=adsorbate for frequency calcs"
```

---

### Task 3: Frontend `freeze.ts` adsorbate mode (parity)

**Files:**
- Modify: `src/lib/workflow/freeze.ts` (mode handling `31-70`)
- Test: `src/lib/workflow/__tests__/freeze.test.ts`

**Interfaces:**
- Consumes: a structure object whose sites carry `properties.is_adsorbate` (or top-level `site_properties.is_adsorbate`).
- Produces: `apply_freeze_to_structure(struct, { freeze_mode: 'adsorbate' })` returns the structure with `selective_dynamics` = `[false,false,false]` for non-adsorbate sites, `[true,true,true]` for adsorbate sites.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/lib/workflow/__tests__/freeze.test.ts
import { describe, it, expect } from 'vitest'
import { apply_freeze_to_structure } from '../freeze'

describe('freeze_mode adsorbate', () => {
  it('fixes non-adsorbate atoms, frees adsorbate', () => {
    const struct = {
      sites: [
        { properties: { is_adsorbate: false } },
        { properties: { is_adsorbate: false } },
        { properties: { is_adsorbate: true } },
      ],
    }
    const out = apply_freeze_to_structure(struct as never, { freeze_mode: 'adsorbate' } as never)
    const sd = out.sites.map((s: never) => (s as { properties: { selective_dynamics: boolean[] } }).properties.selective_dynamics)
    expect(sd[0]).toEqual([false, false, false])
    expect(sd[1]).toEqual([false, false, false])
    expect(sd[2]).toEqual([true, true, true])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- freeze`
Expected: FAIL — adsorbate mode unhandled (no selective_dynamics set / wrong values).

- [ ] **Step 3: Implement the adsorbate branch in `freeze.ts`**

In `apply_freeze_to_structure`, add a branch where the other modes are handled (mirror the structure of the `element`/`layers` branches). Read each site's `properties.is_adsorbate` (fall back to `site_properties.is_adsorbate[i]`), and freeze where it is not true:

```ts
  } else if (mode === 'adsorbate') {
    const tag = (i: number): boolean => {
      const per = struct.sites[i]?.properties?.is_adsorbate
      if (typeof per === 'boolean') return per
      const top = struct.site_properties?.is_adsorbate
      return Array.isArray(top) ? !!top[i] : false
    }
    frozen = new Set(struct.sites.map((_s, i) => i).filter(i => !tag(i)))
```

(Match the exact local variable names/shape used by the surrounding branches — read `freeze.ts:20-70` first and adapt; the test above pins the observable behaviour.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- freeze`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/freeze.ts src/lib/workflow/__tests__/freeze.test.ts
git commit -m "feat(workflow): add adsorbate freeze mode to frontend freeze helper"
```

---

### Task 4: freq node default + editor preset

**Files:**
- Modify: `src/lib/workflow/node-defs/calculation/freq.ts` (default `28-31`, options `50-61`, help `60`)
- Modify: `src/lib/workflow/NodeConfigPanel.svelte` (freq freeze quick-buttons `404-414`)

**Interfaces:**
- Consumes: `freeze_mode: 'adsorbate'` handled by Task 3.
- Produces: new freq nodes default to `freeze_mode: 'adsorbate'`; the editor shows a "Fix slab, vibrate adsorbate only" quick-button and an `adsorbate` option in the Freeze Mode select.

- [ ] **Step 1: freq default + select option**

In `freq.ts`, change the default `freeze_mode: 'none'` → `freeze_mode: 'adsorbate'`, and add to the `freeze_mode` select options:

```ts
        { label: `Adsorbate only (fix slab)`, value: `adsorbate` },
```

Update the help text to note this is the recommended surface-frequency setting.

- [ ] **Step 2: Editor quick-button**

In `NodeConfigPanel.svelte` freq freeze quick-buttons block, add (matching the surrounding button markup/style):

```svelte
          <button class="freeze-quick-btn" onclick={() => emit({ ...node.params, freeze_mode: `adsorbate` })}>
            Fix slab, vibrate adsorbate only
          </button>
```

- [ ] **Step 3: Type-check + manual sanity**

Run: `pnpm check`
Expected: no new type errors in the two files.

- [ ] **Step 4: Commit**

```bash
git add src/lib/workflow/node-defs/calculation/freq.ts src/lib/workflow/NodeConfigPanel.svelte
git commit -m "feat(workflow): default freq to adsorbate-only freeze + editor preset"
```

---

### Task 5: Patch the paused ORR workflow's freq nodes (operational)

**Files:** none (data edit via running backend API at `http://127.0.0.1:8000`).

- [ ] **Step 1: Set the 3 freq nodes to adsorbate mode**

After Tasks 1-4 are merged and the backend restarted on the merged code, set
`freeze_mode: adsorbate` (remove `freeze_mode: bottom`, `freeze_n_layers`) on
`freq_OOH`, `freq_O`, `freq_OH` by re-saving the workflow graph (same
graph-edit + `POST /api/workflow/` pattern used for the parallel re-wire), then
`reset`. The adsorbate_place nodes will re-run and emit `is_adsorbate`-tagged
structures the freq nodes consume.

- [ ] **Step 2: Verify**

Re-run; confirm each freq preview POSCAR fixes the whole slab and frees only the
adsorbate (slab atoms `F F F`, adsorbate `T T T`).

---

## Self-Review

- **Spec coverage (C1):** adsorbate tagging (Task 1), backend adsorbate mode (Task 2), frontend parity (Task 3), freq default + preset (Task 4), running-workflow patch (Task 5). ✓ C2/C3/C4 are separate plans.
- **Placeholders:** Task 3 Step 3 intentionally defers to the surrounding `freeze.ts` variable shape; the test pins behaviour. Acceptable (UI-helper internals vary).
- **Type consistency:** `is_adsorbate` (bool per site) is produced in Task 1 and consumed by name in Tasks 2/3. `freeze_mode: 'adsorbate'` consistent across Tasks 2-4.
