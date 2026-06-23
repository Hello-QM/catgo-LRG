# Workflow Freeze Correctness — Design

**Date:** 2026-06-23
**Status:** Approved (design), pending implementation plan

## Problem

Generated and edited catalysis workflows produce physically-incorrect DFT
setups, silently sending wrong jobs to HPC:

1. **freq uses the wrong constraint.** Frequency calculations on adsorbate/slab
   systems must fix the *entire slab* and vibrate *only the adsorbate* (the
   standard harmonic-adsorbate approximation). Today both the editor default and
   CatBot's quickbuild `vasp_freq` preset use `freeze_mode: bottom, 2 layers`
   (same as geo_opt) — so the top slab layers get vibrated. Physically wrong ZPE
   / entropy.
2. **CatBot's batch (LLM-authored) path applies no freeze at all.** The
   `_NODE_DEFAULTS` for `geo_opt`/`freq`/`slab_gen` carry no freeze keys, so a
   slab built that way is fully free.
3. **No parameter validation.** Nothing checks that freeze-layer count ≤ slab
   layers, or that VASP params (ENCUT/EDIFF/IBRION) are sane. `_get_layer_z_threshold`
   silently clamps an over-count to "freeze everything".
4. **No review nudge.** After CatBot builds a workflow the message just says
   "adjust or Run" — nothing tells the user to verify freeze/params.

Root enabler for #1: the adsorbate atoms are **not identifiable downstream**.
`adsorbate_placement.py` computes `adsorbate_indices` but `run_adsorbate_place`
discards them; the emitted structure carries no `is_adsorbate` marker.

## Approved decisions

- **Adsorbate identification: tag atoms** (Approach A). `run_adsorbate_place`
  persists an `is_adsorbate` site property. A new `freeze_mode: adsorbate` fixes
  every atom not tagged.
- **Validation severity: warn-mostly, block on severe.** Most issues are
  non-blocking warnings; hard errors (freeze layers > slab layers) block.

## Components

### C1 — Adsorbate-only freeze (physics core)

The one fix that makes freq correct and unblocks the paused ORR workflow.

- **Tag adsorbate atoms.** `run_adsorbate_place`
  (`server/catgo/workflow/builtins_impl.py`) writes a per-site boolean
  `is_adsorbate` site property (True on appended adsorbate atoms, False on slab)
  in **both** paths: ferrox (`~456-483`, uses the placement engine's
  `adsorbate_indices`/`n_slab`) and the pymatgen fallback (`~285-352`, the
  appended atoms). Stop discarding `adsorbate_placement.py:335-347`'s indices.
- **New `freeze_mode: adsorbate`** in backend `server/workflow/engines/vasp.py`
  freq block (`~289-349`) and frontend `src/lib/workflow/freeze.ts`: freeze every
  site whose `is_adsorbate` is not True → all-slab fixed, adsorbate free.
  - Fallback: if no `is_adsorbate` property is present on the structure, emit a
    **warning** and leave atoms free (do not silently mis-freeze); validation
    (C3) flags it.
- **freq node default** (`src/lib/workflow/node-defs/calculation/freq.ts:28`):
  `freeze_mode: adsorbate`.
- **Frontend preset**: `NodeConfigPanel.svelte` freq freeze quick-buttons gain
  "Fix slab, vibrate adsorbate only" → sets `freeze_mode: adsorbate`. Keep the
  existing freeze-warning (`:396-411`) but point its default fix at the new preset.
- **Running-workflow patch**: once C1 lands, set the 3 freq nodes in the paused
  ORR workflow to `freeze_mode: adsorbate` (they will get tagged structures from
  the re-run adsorbate_place).

### C2 — CatBot generation freeze defaults

- **Quickbuild** (`server/catgo/mcp_tools/server_claude_code.py:2339-2341`):
  `vasp_freq` preset → `freeze_mode: adsorbate` (drop `bottom`/`freeze_n_layers`).
  `vasp_opt` keeps `freeze_mode: bottom, freeze_n_layers: 2` (correct for geo_opt).
  Fix the `DOS` recipe geo_opt (`:2504`) to carry the same geo_opt freeze.
- **workflow_builder skill**
  (`server/catgo/workflow/skills/workflow_builder/SKILL.md`): update the freq
  examples (`L44, L139, L155, L159`) to `freeze_mode: adsorbate`; document the
  geo_opt-vs-freq freeze distinction.
- **Batch path** (`workflow_tools.py` `_NODE_DEFAULTS`): do **not** force freeze
  defaults (a molecular geo_opt must not freeze). Instead rely on the skill
  guidance + C3 validation warning for un-frozen slabs.

### C3 — Validation (warn-mostly, block-severe)

A shared validator invoked from `dry_run_graph`
(`server/catgo/routers/workflow_engine.py:319-376`, per-node with params +
upstream structure) and surfaced through `_validate_graph`
(`workflow_tools.py:959`) so all build paths see it.

- **Block (error):** freeze-layer count > slab's distinct-z layer count.
- **Warn:** slab/adsorbate `geo_opt` with no freeze; `freq` on a tagged-adsorbate
  structure that is not `freeze_mode: adsorbate`; VASP params out of sane range
  (e.g. ENCUT ∉ [200, 900], EDIFF > 1e-3, IBRION invalid for the calc type).
- Replace the silent clamp in `_get_layer_z_threshold` (`vasp.py:46-52`) with a
  surfaced warning/error.

### C4 — Post-generation reminder

- Quickbuild return (`server_claude_code.py:2639-2645`) and batch summary
  (`workflow_tools.py:1592-1604`) append a review nudge: "⚠️ Review freeze
  settings and key params (ENCUT/IBRION/frozen layers) before Run" plus any C3
  warnings.

## Sequencing & isolation

C1 → C2 → C3 → C4, each a separate PR. C1 is the physics core and unblocks the
paused workflow; C2 depends on C1's `adsorbate` mode; C3 and C4 are additive.

## Testing

- C1: `run_adsorbate_place` tags `is_adsorbate` (ferrox + fallback); `vasp.py`
  freq with `freeze_mode: adsorbate` → POSCAR fixes all slab, frees adsorbate;
  end-to-end slab→adsorbate→freq POSCAR (all-slab F F F, adsorbate T T T);
  missing-tag fallback warns.
- C2: quickbuild ORR/OER/HER recipes emit `freeze_mode: adsorbate` on freq;
  geo_opt keeps bottom-N.
- C3: validator blocks freeze-layers > slab-layers; warns on un-frozen slab
  geo_opt / non-adsorbate freq / out-of-range ENCUT.
- C4: quickbuild + batch responses contain the review nudge.

## Out of scope

- Re-architecting the workflow engine or the freeze UI beyond the new preset.
- Non-VASP engines' freeze handling (CP2K/ORCA) — follow-up if needed.
