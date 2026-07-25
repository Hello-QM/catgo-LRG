# Shared WebGL2/WebGPU Visual Pipeline Design

**Date:** 2026-07-24  
**Target:** PR #540 (`feat/large-system-shading-parity`)  
**Status:** proposed

## Problem

CatGo has two GPU presentation backends:

- WebGL2 renders the normal structure view and remains the compatibility fallback.
- WebGPU renders the large-system overlay.

The backends currently resolve some visual behavior independently. Theme
background parsing, color-space conversion, atom-radius scaling, render-style
mapping, shading defaults, depth-cue state, and gizmo layout can therefore drift.
PR #540 improves WebGPU shading, but it also adds another backend-specific copy of
several rules. The review found three concrete consequences:

1. WebGL2 and WebGPU still interpret computed CSS background colors differently.
2. WebGPU shading can remain stale after its render loop goes to sleep.
3. The new WebGPU shading buffer is not explicitly destroyed.

Fixing only those three symptoms would leave two visual-semantic pipelines to
maintain. The intended architecture is one shared visual pipeline with two thin
GPU adapters.

## Goals

- Make WebGL2 and WebGPU consume the same resolved visual state.
- Keep WebGL2 as a supported fallback on devices without WebGPU.
- Share CPU-side scene semantics, constants, lifecycle revisions, and test
  vectors.
- Restrict backend-specific code to shader language, GPU resource binding, and
  command submission.
- Preserve the current visual settings and public component behavior.
- Add regression tests that fail when the two backends diverge.

## Non-goals

- Removing either GPU backend.
- Introducing a general-purpose cross-GPU framework.
- Generating complete GLSL and WGSL programs from a new shader DSL.
- Implementing the WebGPU `matcap` texture path.
- Making unrelated changes to trajectory ownership or PR #531.

## Architecture

### Shared visual core

A backend-neutral module owns the semantic inputs used by both renderers:

```text
Structure settings + camera + DOM theme
                  │
                  ▼
        Shared visual-state resolver
                  │
          ResolvedVisualState
          revision / equality
             ┌────┴────┐
             ▼         ▼
       WebGL2 adapter  WebGPU adapter
       uniforms/textures  buffers/bind groups
             │         │
             ▼         ▼
            GLSL      WGSL
```

The shared core contains no `WebGLRenderingContext`, `GPUDevice`, Three material,
or Svelte component lifecycle. It produces immutable or snapshot-like values
whose units and color spaces are explicit.

The core owns:

- `VISUAL_RADIUS_SCALE`;
- render-style branch and PBR parameter resolution;
- toon thresholds and other shared numeric shading constants;
- linear RGB background resolution from CSS theme and selected background;
- a backend-neutral `ResolvedVisualState` type;
- equality/revision helpers used to decide whether a backend needs an upload;
- gizmo palette and layout parameters.

### Backend adapters

WebGL2 and WebGPU remain separate adapters because their execution APIs and
shader languages are incompatible.

The WebGL2 adapter maps `ResolvedVisualState` to Three/GLSL uniforms. The WebGPU
adapter packs the same state into its uniform buffer. Neither adapter re-derives
render-style, PBR, background, or radius rules.

GLSL and WGSL implementations remain separate source code. Both use the shared
constants where source interpolation is practical and are checked against one
CPU reference implementation for representative numeric inputs. This avoids a
new shader code generator while still making semantic drift observable.

## Resolved visual state

The shared state contains:

- normalized view-space light direction;
- projection kind;
- ambient, directional, and specular strengths;
- roughness and metalness;
- render-style branch;
- outline strength;
- depth-cue strength, near plane, far plane, and linear-RGB target color;
- toon thresholds and shadow brightness;
- resolved linear-RGB canvas background;
- the current visual revision.

Camera-dependent fields are refreshed by the owner in `StructureScene`. Setting
or camera changes increment the revision. Both backends receive the same
snapshot for a frame.

The bridge to the large-system overlay passes a state snapshot plus revision,
not an opaque getter whose internal reactive reads are invisible to Svelte.
The overlay has an effect that observes the revision and calls `wake()`. Its
frame loop may still avoid buffer uploads when the snapshot compares equal.

This preserves sleep efficiency while guaranteeing that a style change, late
bridge initialization, or depth-cue change produces a new frame.

## Background and color spaces

All shared CPU colors use linear RGB.

The background resolver:

1. walks from the rendering element to the first sufficiently opaque computed
   CSS background;
2. parses the CSS components as sRGB;
3. converts them to linear RGB exactly once;
4. converts the selected hex color to linear RGB exactly once;
5. blends in linear RGB using `background_opacity`;
6. returns the resolved linear value.

WebGL2 passes the linear value to Three, which performs the configured output
encoding. WebGPU fragment shaders encode linear output for a non-sRGB swapchain.
The WebGPU render-pass clear value is explicitly encoded because it bypasses a
fragment shader.

The parser and blend logic are called by both backends; there is no duplicate
`find_theme_bg()` implementation.

## Atom radii and render styles

`VISUAL_RADIUS_SCALE` moves to the shared visual core and is imported by:

- the WebGL2 atom instance writer;
- the WebGL2 replica renderer and picker;
- the WebGPU display-radius builder.

Render-style branch selection and PBR values also move to the shared core. The
WebGL2 material and WebGPU state packer consume the same result. Unsupported
WebGPU `matcap` remains an explicit adapter fallback rather than a hidden
alternate mapping.

## Gizmo

The gizmo's semantic model is shared:

- positive and negative axis colors;
- edge inset and HUD safe-area behavior;
- responsive size limits;
- camera orientation.

The drawing implementation remains backend-specific because the WebGL gizmo and
the WebGPU overlay do not share a render target. The WebGPU implementation must
not duplicate palette or layout constants. If the existing DOM gizmo can later
be layered above both canvases without keeping the WebGL render loop active, it
can replace the WebGPU draw adapter in a separate change.

## Resource lifecycle

Every resource allocated by the WebGPU adapter is owned by the renderer instance
and explicitly destroyed by `destroy()`. The shading uniform buffer is added to
that teardown contract.

Wake/sleep behavior follows one rule:

- semantic revision changes wake the overlay;
- camera, resize, position, selection, and topology revisions continue to wake
  it through their existing paths;
- an unchanged snapshot does not upload a buffer or force another frame.

## Testing

Implementation follows TDD. Each regression test must fail before production
code changes.

Required tests:

1. A shared background test using `rgb(28, 28, 28)` proves both adapters start
   from the same linear value and display-equivalent output.
2. Mixed selected/theme background tests cover opacity `0`, `0.1`, and `1`.
3. WebGL2 and WebGPU state packing are checked against the same
   `ResolvedVisualState` fixture.
4. A render-style/PBR table test covers every supported style and the explicit
   WebGPU `matcap` fallback.
5. All radius consumers import the same `VISUAL_RADIUS_SCALE`.
6. A sleeping overlay wakes when the visual revision changes and stays asleep
   when an equal snapshot is republished.
7. Renderer teardown destroys the shading buffer exactly once.
8. Existing WebGL2, WebGPU, structure GPU, and typecheck gates remain green.

Real GPU validation should compare normal and large-system mode on the same
structure and background, including a dark theme, partial background opacity,
toon shading, orbit/zoom after sleep, and repeated overlay toggles.

## Compatibility and rollout

WebGL2 remains the fallback and keeps its current rendering behavior except for
the corrected CSS color-space interpretation. WebGPU continues to be activated
only by the existing large-system mode.

The refactor is internal: component callers keep their current settings and
events. The bridge shape changes from a getter-only contract to a reactive
snapshot/revision contract inside the structure renderer hierarchy.

PR #540 should contain the shared-core extraction and the three reviewed fixes
in one coherent update. PR #539 remains a separate parser correction with its
own tests and commit history.
