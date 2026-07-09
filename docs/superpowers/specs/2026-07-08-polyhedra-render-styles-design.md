# Polyhedra render styles (flat / matte / glass)

**Date:** 2026-07-08
**Branch:** feat/polyhedra-elegance
**Status:** approved

## Problem

Commit 52f2993c made the new "glassy" polyhedra look (smooth radial normals +
frosted-white tint + Fresnel rim glow + specular sheen) the **only** face
rendering. Not everyone likes it. It should be one selectable mode among
several, with the classic look available and default.

## Decision

Add a `polyhedra_style` setting with three modes, default **flat**:

| Mode | Shader path | Look |
| --- | --- | --- |
| `flat` (default) | Facet normals via `dFdx`/`dFdy` + headlamp lambert `0.3 + 0.7·ndotl`, raw element color | Classic VESTA-like hard facets — pixel-identical intent to pre-52f2993c |
| `matte` | Smooth radial normal (`vNormal`) + soft diffuse `0.62 + 0.38·NdotV`, raw color; no tint / Fresnel / spec / rim-alpha densify | Middle ground: soft gradient, not glassy |
| `glass` | Current path unchanged (tint + Fresnel + spec + rim alpha) | The 52f2993c look |

## Implementation outline

1. **Settings** — `src/lib/settings/config.ts`: `polyhedra_style` enum setting
   (`flat`/`matte`/`glass`), default `flat`; `types.ts` gains
   `PolyhedraStyle` type + `SettingType` entry.
   Revert `polyhedra_edge_color` default `#cfd6e2` → `#333333` (dark edges suit
   the flat default; glass users tune manually — no auto-linkage, it would
   fight persisted settings).
2. **Shader** — `CoordinationPolyhedra.svelte`: single material, new `u_style`
   int uniform (0 flat / 1 matte / 2 glass); fragment branches per table above.
   Geometry unchanged — `face_normals` attribute stays, flat branch ignores it.
3. **Wiring** — `StructureScene.svelte` passes `polyhedra_style` prop;
   `StructureControls.svelte` polyhedra section gets a select at the top;
   i18n en (`Flat / Smooth Matte / Glass`) + zh (`经典平面 / 平滑哑光 / 玻璃`),
   key sets in parity.
4. **Edges** — fat `LineSegments2` edges + width slider stay shared across all
   modes (pure improvement over 1px GL lines).

Out of scope: exposing `whiteness` in the UI (stays an internal glass-only
prop), per-mode edge-color linkage, atom render styles.

## Verification

- `pnpm check` (svelte-check 0 errors), `rtk proxy pnpm exec vitest` green.
- Live: dev server, screenshot each of the three modes on a polyhedra-bearing
  structure; flat must visually match pre-52f2993c.
