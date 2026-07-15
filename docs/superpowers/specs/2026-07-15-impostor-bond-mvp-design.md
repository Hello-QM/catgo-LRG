# Impostor-Cylinder Bond Rendering — MVP Design

Date: 2026-07-15
Status: approved (design), pending implementation plan

## Background

Round-5 attribution established that trajectory-playback frame time is
**GPU-bound, not CPU-bound**. On a 20k-atom / 52k-half-bond trajectory the
per-frame synchronous JS is ~0.6ms (after the round-4 proxy work), and a
drawingBuffer 1/16 shrink lifts fps only +46% — so the frame splits between
fill (~14ms) and **non-fill vertex/upload work (~28ms)**. The per-bond
cylinder dominates the vertex cost.

The segment-LOD change (#529) attacks this by dropping a 16-sided cylinder to
8 sides during playback (2× fewer vertices). A **ray-cylinder impostor** goes
further: 12 triangles/bond (a unit box) regardless of cylinder smoothness —
5.3× fewer than the 16-segment mesh — with the cylinder ray-cast per-fragment,
so it is always perfectly smooth.

A standalone spike (`e2e/impostor-spike/`, branch `spike/impostor-cylinder`)
ported the OVITO/PyMOL ray-cylinder impostor to Three.js WebGL2 and verified,
side-by-side against a CylinderGeometry reference, that all four impostor
artifacts are solved:

1. **Flicker / z-fight** — analytic `gl_FragDepth` (view-space hit reprojected
   to window depth), same encoding as the rest of the scene.
2. **Card / plane reveal** — an oriented bounding box (OBB) proxy, not a flat
   billboard; a box encloses the cylinder from every angle.
3. **Flat look** — per-fragment radial normal fed through the existing
   lighting.
4. **Silhouette + cap aliasing** — analytic edge coverage
   (`(r - pd)/fwidth(pd)`) output as alpha with `alphaToCoverage`, so MSAA
   resolves the discard edge. Side-wall uses ray-to-axis distance; caps use
   hit radial distance.

Residual limit: at the sub-pixel depth seam where two opaque impostors
overlap, `alphaToCoverage` + `gl_FragDepth` cannot fully resolve (MSAA samples
test depth independently) — negligible in dense small-bond scenes.

## Goal

Wire the spike's impostor into the real bond renderer for the **narrow,
low-risk case only**, so we can measure the absolute cached-lap fps on a real
52k-half-bond trajectory against the current #524 mesh path (baseline
27.8fps). This validates whether impostors take 24→near-60 before committing
to a full production port.

Explicit non-goal: replacing the mesh path everywhere. This is a measurement
MVP.

## Scope

**In:** the impostor renders only when `gpu_active` is true — the existing
signal for "typed-direct playback AND no multibond AND no image-atom
decorators AND not DEV-disabled". That signal already gates the #524
GPU-transform path, and it is exactly the MVP eligibility set.

**Out (falls back to the existing mesh path, unchanged):**
- static frames / paused (segment-LOD already renders mesh there)
- multibond (order > 1 rendering)
- image-atom decorators
- transparent bonds (opacity < 1) — `alphaToCoverage` interaction deferred
- periodic cross-cell stubs — see Open Decision below

## Architecture

### Trigger & geometry switch (reuse segment-LOD mechanism)

The `geometry` `$derived` in `BondManagerInstances.svelte` already rebuilds the
InstancedMesh on the play/pause edge (segment LOD, #529). Extend it: when
`gpu_active`, the geometry is the impostor OBB (a unit box, instanced), else
the CylinderGeometry (16/8-seg per LOD). Same switch point, same mesh-rebuild
path, same composition with the GPU-mode transition effect (the mount effect
syncs `last_gpu_active` so the mode effect short-circuits).

Because `atom_positions` gets a fresh identity every frame, the geometry
selector must read the playback flag and atom count the same untracked way
segment LOD does — no per-frame mesh rebuild.

### Shader (second material, impostor)

A second `ShaderMaterial`/`RawShaderMaterial` for the impostor path, used when
`gpu_active`. It reuses the #524 per-instance attributes and uniforms verbatim:
- `a_site` (endpoint indices) → `uPosTex` texelFetch for pa / pb_base
- `a_jimage` + `uLattice` → cross-cell `b_eff`
- `a_half` → which half (A anchored at pa, B at pb) this instance draws

The vertex shader builds an OBB covering the half-bond (pa → mid for half A,
mid → pb for half B) instead of transforming cylinder vertices. The fragment
shader ray-casts the half-cylinder (Koradi method), computes the radial
normal, the axial position (for the colour gradient), and the hit (for
`gl_FragDepth`), then feeds the **existing** studio_env lighting / ACES /
depth-cue / outline / colour-gradient code unchanged.

Colour: half A gradients `vColorStart` → mid-colour, half B mid → `vColorEnd`,
matching the current `mix(vColorStart, vColorEnd, vYPosition + 0.5)` where the
impostor supplies the axial parameter in place of `vYPosition`.

Caps: the outer end (pa for half A, pb for half B) is capped; the inner (mid)
end butts against the other half and needs no cap (or a shared flat cut).
Match the current mesh half-bond appearance.

### Antialiasing

`alphaToCoverage: true` on the impostor material. **Requires the production
renderer to have MSAA enabled** (`antialias: true`). Confirm CatGo's WebGL
renderer config; if MSAA is off, either enable it for this pass or accept
aliased impostor silhouettes for the MVP measurement (document which).

## Open Decision (resolve in the plan)

Periodic cross-cell bonds have a stub branch in the #524 shader
(`uStubMode` / `uStubScale`, VESTA Mode 1) and a paired-stub branch. Two MVP
options:
- **(a)** Also build the OBB + ray-cast for the stub geometry (more shader
  work, full coverage of `gpu_active` frames).
- **(b)** Fall back to mesh whenever the current frame has any periodic bond
  (simpler, but a slab/bulk trajectory — the common large case — is mostly
  periodic, so this could fall back almost always and defeat the measurement).

Recommendation: **(a)** for the side-wall + outward paired stubs (the spike's
ray-cast already handles finite cylinders with caps; the stub is just a
shorter half), because (b) risks never exercising the impostor on realistic
periodic systems. Decide in the plan after reading the #524 stub branch.

## Verification

1. Unit: the geometry selector returns the impostor OBB iff `gpu_active` (pure
   function, like `bond_lod_segments`).
2. Runtime: on the real 48MB / 20k-atom / 52k-bond trajectory, drive the
   cached-lap scrubber benchmark and compare fps to the #524 mesh baseline
   (27.8 avg). Confirm no visual regression vs mesh at rest (the tail-sync
   rebuilds the mesh on pause, so paused frames are unchanged).
3. Confirm `gl.getError()` clean and no shader-compile errors in prod build.

## Follow-ups (not in this MVP)

- full production port (all cases: multibond, image-atom, transparent)
- always-on impostor (static frames too — perpetually smooth; but pathtracer
  Render Still still rebuilds real mesh)
- cap-edge sub-pixel depth-seam refinement
- stub impostor if deferred to (b) above

## Risks

- Half-bond OBB endpoint/cap handling must match the mesh half-bond visually,
  or paused↔playing transitions will pop.
- `alphaToCoverage` depends on production MSAA; verify before relying on it.
- Reusing the #524 fragment lighting requires the impostor to supply
  view-space normal + axial colour param + hit position in the exact form the
  existing code consumes.
- Second material doubles the bond shader surface; keep the impostor material
  construction beside the existing one and share uniform-sync effects.
