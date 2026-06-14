# Mol\* Bio Viewer — Design

**Date:** 2026-06-14
**Branch:** `feat/molstar-bio-viewer`
**Status:** Approved design, pending implementation plan

## Goal

Let CatGo visualize biological systems (proteins, nucleic acids). When the user
opens a biomolecular structure file (PDB / mmCIF), render it with **Mol\***
(molstar) — which provides cartoon/ribbon, surface, sequence view, and
measurement out of the box. Materials systems (crystals, slabs, molecules)
continue to use the existing native Three.js viewer, unchanged.

**Scope: pure viewing only.** No compute handoff, no active-site cutout, no
bridge into the DFT/QM pipeline. User clicks a file → it visualizes.

## Non-goals (explicit YAGNI)

- No Mol\* → CatGo compute bridge (no "cut active site → QM region").
- No custom cartoon/surface re-implementation in the native Three.js viewer.
- No re-skinning Mol\*; we use its built-in UI as-is.
- No routing for the HTTP/MCP/`curl` `upload-and-load` path in v1 (see Deferred).
- No editing of biomolecules inside Mol\* persisted back to CatGo.

## Background (current state)

From codebase exploration:

- PDB/mmCIF already load via pymatgen + a custom TS PDB parser, but the pipeline
  **drops** residue name/number, chain id, B-factor, occupancy — `Site` keeps
  only `label`. (`src/lib/structure/index.ts:87-93`, `src/lib/structure/parsers/pdb.ts`)
- The native viewer is ball-and-stick + polyhedra only — **no cartoon/ribbon,
  no surface mesh, no residue/chain coloring**. (`src/lib/structure/StructureScene.svelte`)
- Bonds come from ferrox-wasm distance/solid-angle detection; fine for crystals,
  not built for protein-scale secondary structure.
- Non-periodic (no-cell) systems already render via a synthetic padding box, so
  "molecule mode" works.

Conclusion: matching PyMOL/Mol\* fidelity natively is months of work. Embedding
Mol\* gets full bio fidelity fast. We embed it as a **parallel viewer**.

## Architecture — parallel viewer

Mol\* ships its own WebGL2 context, canvas, camera, scene graph, and file
parsers. It does **not** reuse CatGo's Three.js scene, ferrox bonding, or
pymatgen pipeline. It is a **second viewer pane** that lives alongside the
native viewer.

```
file opened (raw text + filename)
        │
        ▼
   bio sniffer  ──── not bio ────▶  existing native load path (unchanged)
        │
       bio
        │
        ▼
   Mol* pane  ◀── raw bytes fed straight to Mol*'s own parser
   (cartoon + ligand, full Mol* UI)
        │
   manual override toggle ⇄ "open in native" / "open in Mol*"
```

Two **parallel pipelines** that do not interfere. Bio files bypass
pymatgen/ferrox entirely (which is what preserves residue/chain/B-factor —
Mol\* keeps all of it).

## Components

### 1. `src/lib/structure/bio/detect.ts` — content sniffer (pure)

- **Input:** raw file text + filename.
- **Output:** `{ isBio: boolean, kind: 'protein' | 'nucleic' | 'mixed' | null, reason: string }`.
- **Heuristics (B — content sniff, not just extension):**
  - PDB: presence of `SEQRES`, `HELIX`, or `SHEET` records; OR ≥ K (e.g. 10)
    ATOM records whose residue name is a standard amino acid / nucleotide.
  - mmCIF: `_entity_poly.type` containing `polypeptide` or `polynucleotide`;
    OR `_struct_conf` / `_struct_sheet` categories present.
  - Reason string is human-readable (drives the manual-override UI hint and
    aids debugging).
- **Pure function → vitest-unit-testable** (vitest is the CI gate).
- Conservative: when ambiguous, return `isBio: false` (fall through to native),
  since the manual override (C) lets the user force Mol\*.

### 2. `src/lib/structure/bio/MolstarViewer.svelte`

- **Lazy-loads** `molstar` via dynamic `import('molstar')` inside `onMount` —
  keeps the multi-MB Mol\* bundle out of the main chunk; only fetched when a bio
  file is actually opened.
- Mounts Mol\*'s **built-in all-in-one `Viewer`** (full UI: left/right control
  panels, sequence track, representation switcher, measurement). No custom
  layout.
- Feeds raw file content (string) + format to Mol\*'s loader; default preset =
  cartoon for polymer + ball-and-stick for ligands/het.
- Cleans up the Mol\* plugin on unmount (dispose context, free WebGL).

### 3. Routing integration (frontend file-open flow)

- In the frontend load orchestrator (the function that today receives file
  content + name and dispatches to the parser — **exact function identified
  during planning**): after reading content, call `detect()`.
  - `isBio` → mount a `MolstarViewer` pane for that tab/structure.
  - else → existing native path, untouched.
- **Manual override (C):** a small control on the pane to switch
  "Open in Mol\* ⇄ Open in native viewer", so a misrouted file is one click to
  fix either direction.

### 4. Pane / tab integration

- The Mol\* pane slots into CatGo's existing tab/pane model the same way the
  native viewer pane does — a tab can host either a native viewer or a Mol\*
  viewer.
- **iOS invariant (from CLAUDE.md):** never `display:none` a live WebGL pane —
  it zeroes the canvas. Keep Mol\* mounted/off-screen rather than hidden, same
  rule as the native 3D pane.

## Data flow

Bio files take raw bytes → Mol\*'s in-browser parser. They never touch
pymatgen serialization or ferrox bond detection, which is precisely why
residue/chain/secondary-structure/B-factor survive. The native pipeline is
untouched for everything else.

## Mobile / iOS (in scope)

Mobile is **included**, with these constraints to verify on-device (per the
`deploy/ios/LOCAL-TESTING-PROGRESS.md` flow):

- Mol\* requires **WebGL2** — supported in iOS 15+ WKWebView; verify it
  initializes and renders a real PDB on a device.
- **Bundle size / memory:** lazy import is mandatory on mobile; confirm the
  chunk loads over `TAURI_DEV_HOST` and the WebView doesn't OOM on a mid-size
  protein.
- **Mol\* full UI on a small screen** is desktop-oriented and may be cramped;
  acceptable for v1 (built-in UI per decision), but note responsiveness as a
  known rough edge to revisit, not a blocker.
- Because Mol\* parses raw bytes **client-side**, it has no backend-URL / CORS
  dependency — fewer mobile gotchas than the native pipeline.

## Testing

- `detect.ts` → vitest unit tests: protein PDB, nucleic-acid PDB, mmCIF polymer,
  vs. a crystal CIF, a POSCAR, a small-molecule mol2 → assert correct routing.
- Mol\* rendering (WebGL) is not unit-testable → **agent-browser** manual
  verification: open a real PDB (e.g. a small protein) on desktop, confirm
  cartoon renders and the manual override switches to native and back.
- Mobile: on-device smoke test per iOS notes (load one PDB, confirm render).

## Deferred (future, not v1)

- Routing for the HTTP/MCP/`curl upload-and-load` path. v1 routes only the
  frontend file-open flow (the user's stated "click a file" use case). Files
  pushed via curl/MCP continue to the native pipeline, with the manual override
  available to switch to Mol\*. Porting the sniffer to Python for backend
  auto-routing is a later step.
- Compute handoff (active-site cutout → DFT/QM).
- Custom/trimmed Mol\* layout.

## Open items to resolve in planning

1. Exact frontend load-orchestrator function where routing hooks in.
2. How a Mol\* pane is represented in the tab/pane store (new pane "kind").
3. Which `molstar` entry point: the prebuilt `Viewer` wrapper vs. constructing
   `PluginUIContext` — both give full UI; pick the lower-friction one for the
   bundler (Vite 7).
