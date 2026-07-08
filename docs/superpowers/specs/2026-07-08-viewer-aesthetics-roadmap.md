# CatGo Viewer Aesthetics — Roadmap

**Date:** 2026-07-08
**Trigger:** Competitor `pretty-lattice` (github.com/songfeitong/pretty-lattice) reported as
"more beautiful". Goal: **surpass it on perceived visual quality** without sacrificing CatGo's
breadth (editing, trajectories, bond orders, workflows, HPC, AI/MCP).

This is a decomposition roadmap, not a spec. Each track below gets its own
brainstorm → spec → plan → implementation cycle. Order and dependencies are fixed here.

---

## Competitive analysis (why it looks nicer)

`pretty-lattice` is a **read-only** crystal figure generator (React + R3F + shadcn/Radix +
Geist). It spends its entire budget on looks. Under the hood its 3D is **basic**:

- Materials: plain `MeshStandardMaterial` metalness/roughness pairs (glossy 0/0.2,
  modern-matte 0.1/0.6, metallic 0.4/0.4, 2.5D 0/0.75 + hemisphere light). 6 presets.
- Lighting: 1 ambient + 1 **camera-attached directional headlight** (offset `[0.32,0.22,0]`).
- Colors: **soft/pastel** VESTA & Jmol variants (`vesta-soft`, `jmol-soft`) — the single
  biggest 3D differentiator; default element colors are muted so figures look "designed".
- Background: off-white `#fafafa` + subtle **fog** (fog color == bg, front padding 0.4).
- No environment map / IBL, **no post-processing** (no SSAO, no real depth-of-field —
  their "depth" is just fog + orthographic camera), no ground shadows.
- Standard-view auto-orientation (VESTA / Naumann) so structures load at a canonical angle.
- UI chrome: **Geist font + shadcn/Radix components** (consistent radius/shadow/spacing).

**Key insight:** it wins on (1) UI chrome, (2) tasteful 3D *defaults* — **not on rendering
capability**. CatGo already has MORE shader tech than it: VESTA depth-cueing shader,
silhouette outline, auto-fog (tracks zoom), toon shading, per-style 5-param lighting profiles.
CatGo looks rougher because of **missing defaults and zero UI-chrome consistency**, not
missing ability.

**Current CatGo gaps found in recon:**
- No `toneMapping` set anywhere → relying on Threlte default (must pin ACES explicitly).
- No IBL / environment map.
- No post-processing (no SSAO/DoF) — `postprocessing` pmndrs pkg not a dependency.
- Element colors: single raw VESTA set (`src/lib/element/data.ts`), no soft variant.
- Default background is black `#000000`.
- Materials: only 3 styles (`glossy` / `matte` / `toon`) vs its 6.
- **No global UI font** — inherits system default (inconsistent across platforms).
- **No unified radius/shadow/spacing tokens** — 208 files hardcode `border-radius`,
  61 hardcode `box-shadow`, mixing `px` and `pt` (2pt/3px/4pt/8px/10px). Color tokens
  exist (`--accent-color`, `--bg-color`, `--border-color`) but geometry tokens do not.

**Perceived-impact ranking (for "surpass looks"):** Font ≳ Component-system > 3D renderer > Post-processing.

---

## Tracks

### Track A — UI Font (Geist)  ·  small · impact HIGH · independent
Ship a deliberate UI typeface. CatGo currently sets no `font-family` at all.
- Bundle **Geist Sans** (OFL, self-hosted `@font-face`, Tauri offline-safe).
- Global font stack with **mandatory CJK fallback** (Geist is Latin-only):
  `Geist, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', system-ui, sans-serif`.
- Apply at global root (no global CSS exists today → create one / app.html).
- **Do NOT touch terminal/mono** (terminal font was recently fixed — avoid regression).
- Acceptance: zh UI renders (no tofu), Latin UI shows Geist, terminal unchanged.

### Track B — Component Design System  ·  large · impact HIGHEST · independent · own brainstorm
Introduce unified geometry tokens and sweep the sprawl. This is the biggest perceived win
and the most subjective — **gets its own brainstorm round + `frontend-design` skill**.
- Define scales: `--radius-{sm,md,lg}`, `--shadow-{sm,md,lg}`, `--space-*` (single unit, px).
- Establish visual language: elevation model, hover/focus rings, transitions, neutral palette.
- **Decide theme direction here** (dark-primary vs light/off-white) — this DECISION GATES
  Track C's background choice, so B precedes C.
- Sweep 208 `border-radius` + 61 `box-shadow` sites onto tokens (token-first, then apply;
  half-done = worse than untouched).
- Acceptance: consistent corners/shadows/spacing across panels; no `pt` units left.

### Track C — 3D Renderer Overhaul  ·  medium · impact MEDIUM · depends on B (theme direction)
Tasteful 3D defaults (default-on, aggressive per user approval). Harmonize bg with Track B's
theme decision.
- IBL environment map — `<Environment>` (three `RoomEnvironment`, procedural, zero-asset, offline).
- Pin **ACES Filmic tone mapping + sRGB** explicitly across all ~6 Canvas instances.
- **Soft pastel colormap** default (vesta-soft) — add soft table to `src/lib/element/data.ts`.
- Camera-attached headlight (offset `[0.32,0.22,0]`).
- Background default → off-white (only if Track B lands light-leaning; else harmonize).
- Materials +3: `metallic` / `2D-flat` / `2.5D-soft` (extend existing render_style enum +
  5-param lighting profiles) → 6 built-in + keep unique `toon` = 7, beating its 6.
- Standard-view auto-orientation (VESTA / Naumann) on load.
- Depth tuning: fog color tracks bg exactly + orthographic default + restrained default amount.

### Track D — Post-processing  ·  medium · impact MEDIUM · depends on C · new dependency
Leapfrog effects neither tool has. New dep `postprocessing` (pmndrs) + Threlte EffectComposer.
- **SSAO / GTAO** ambient occlusion (crevices between packed atoms → depth flat lighting can't fake).
- Real **DoF bokeh** — **default OFF** (blurs atoms; bad for analysis/publication). Opt-in for
  export / presentation "hero" renders only.
- Optional: contact soft shadows on ground plane, subtle bloom on speculars.
- **Perf gating (mandatory):** disable SSAO/IBL-heavy paths during `large_system_mode` and
  trajectory playback; enable full quality for static frames + the **export path** (publication figures).

---

## Order & dependencies

```
A (font)  ──────────────► ship first (fastest ROI, no deps)
B (design system) ──────► own brainstorm; sets theme direction
        │ theme decision
        ▼
C (renderer) ───────────► harmonize 3D bg with B
        │
        ▼
D (post-processing) ────► depends on C; new dep; perf-gated
```

**Sequence:** A → B → C → D. Font first for velocity; design-system before renderer so the 3D
background/theme harmonizes; post-processing last (riskiest, depends on renderer).

## Cross-cutting engineering constraints
- Develop each track in a **git worktree**; copy `ferrox-wasm` pkg into the worktree.
- **Never** start/kill the shared `:8000` backend or `:3100` FE from a worktree agent.
- One **PR per track** (user prefers PR separation; stack dependents on prerequisites).
- Offline-safe assets only (Tauri/WebKitGTK): procedural `RoomEnvironment`, self-hosted fonts —
  no CDN.
- CI gate that matters is `test.yml` (vitest); keep en/zh i18n key parity.

## Status
- [ ] A — UI Font
- [ ] B — Component Design System
- [ ] C — 3D Renderer Overhaul
- [ ] D — Post-processing
