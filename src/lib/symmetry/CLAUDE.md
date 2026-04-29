# `src/lib/symmetry/` Guide

This directory contains browser-side symmetry analysis built on `moyo-wasm`.

## Main Files

- `index.ts`
  - symmetry analysis entry points
  - Wyckoff mapping helpers
- `cell-transform.ts`
  - converts moyo standardized cells back into frontend structure objects
- `SymmetryStats.svelte`
  - symmetry summary UI
- `WyckoffTable.svelte`
  - Wyckoff-position table and interaction UI
- `spacegroups.ts`
  - lookup data

## Most Important Fact

`std_cell` is not the same atom ordering as the input structure.

That means:

- `orbits` are indexed by the input cell
- `wyckoffs` correspond to the standardized cell ordering
- direct `wyckoffs[i]` lookup against an input-structure atom index is wrong

## Current Usage Rules

- use `orbits` when you need stable grouping back on the original structure
- use the standardized-cell data only when you explicitly mean the standardized structure
- be careful when converting symmetry results back into color, label, or selection state used by the main structure viewer

## Performance Reality

- symmetry analysis is intentionally user-triggered
- it should not be treated as a cheap derived computation on every structure change
- stale symmetry data must be cleared when the underlying structure changes

## Why This Module Still Causes Bugs

Status note:

- this section describes recurring failure modes, not a list of currently open bug tickets
- for current confirmed open issues, use `reports/bug-*.md`

- index-space mismatch between input cell and standardized cell
- interaction with the structure viewer's own base / displayed index mapping
- temptation to over-derive symmetry reactively instead of gating it behind explicit analysis

Related reading:

- `src/lib/structure/CLAUDE.md`
- `reports/bug-followup-2026-03-13.md`
