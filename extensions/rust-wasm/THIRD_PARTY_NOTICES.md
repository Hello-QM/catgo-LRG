# Third-party notices and provenance audit

This file records third-party code and assets identified in the CatGo source
tree as audited at commit `ba35376e98d888aaee02f9cb34848da25110a0cf`.
It is an evidence inventory, not a legal opinion or a claim that every
third-party item has been found. The CatGo Noncommercial Research License 1.0
does not replace or override the licenses described here.

The path scopes below are deliberately narrow. A path listed for one component
does not imply that every byte in that path came from that component, and an
unlisted path is not thereby classified as CatGo-owned. Package-manager
dependencies retain the terms shipped by their publishers and are not
enumerated here unless CatGo also copies or adapts their source or asset into
the repository.

## Confirmed notices

### Forblaze Project UFF and VSEPR crates

- Components and source:
  - `extensions/uff-relax/`:
    https://github.com/ForblazeProject/uff-relax.git
  - `extensions/vsepr-rs/`:
    https://github.com/ForblazeProject/vsepr-rs.git
- Author recorded by both component manifests: Forblaze Project
- License recorded by both component manifests: MIT OR Apache-2.0, at the
  recipient's option
- Complete retained license texts:
  - uff-relax:
    [MIT](third_party/licenses/uff-relax-MIT.txt) or
    [Apache-2.0](third_party/licenses/uff-relax-Apache-2.0.txt)
  - vsepr-rs:
    [MIT](third_party/licenses/vsepr-rs-MIT.txt) or
    [Apache-2.0](third_party/licenses/vsepr-rs-Apache-2.0.txt)

CatGo commit `dcb8a503245602dae82a4157de6a69ab1d795fe1` introduced both
component directories with their manifests, source URLs, authors, and complete
MIT and Apache-2.0 texts. Later CatGo history modifies each component's
`src/optimizer.rs`, so this notice preserves the recorded license choice for
the imported/upstream portions without claiming that every current line is
third-party-authored.

### MatterViz / historical Janosh Riebesell snapshot

- Source: https://github.com/janosh/matterviz
- Historical source URL recorded in CatGo package metadata:
  https://github.com/janosh/catgo
- License: MIT
- Preserved notice and full text:
  [`third_party/licenses/MatterViz-MIT.txt`](third_party/licenses/MatterViz-MIT.txt)

Repository evidence:

- CatGo commit `4da4da53631c057bf486a996f463201cf707d8a6` carried
  an MIT license with `Copyright (c) 2021 Janosh Riebesell`.
- The same snapshot's `package.json` named Janosh Riebesell as author and
  `https://github.com/janosh/catgo` as repository.
- Comparing that snapshot with the audited tree by exact path and Git blob ID
  finds 1,306 current path-and-blob pairs that are byte-identical.
- `readme.md` and `readme.zh.md` document MatterViz origins for the structure
  viewer, periodic table, element data, color schemes, and UI patterns.
  `src/lib/structure/polyhedra.ts` and `tests/e2e/smoke.test.ts` contain more
  specific MatterViz provenance comments.

The blob comparison proves that those 1,306 path-and-blob pairs were already
present under the historical notice. It does not establish that every current
file came from MatterViz, identify all modified descendants, or separate later
CatGo contributions within a modified file. Until maintainers complete that
mapping, the historical MIT notice is preserved for all applicable portions.

### CatRender: xyzrender, xyz2svg, and xyzgraph lineage

CatGo commit `40d0c44c2190a0b46e6bfd9ef99a80206c55c2a2` and current
source comments describe CatRender as a faithful port rather than independent
reimplementation.

Primary CatGo scope:

- `extensions/catrender-wasm/src/`
- `extensions/catrender-wasm/src/presets/`
- `src/lib/structure/catrender/`
- `tests/fidelity/`

#### xyzrender

- Source: https://github.com/aligfellow/xyzrender
- Version exercised by the fidelity report: `0.2.10`
- License: MIT
- Notice and full text:
  [`third_party/licenses/xyzrender-MIT.txt`](third_party/licenses/xyzrender-MIT.txt)

Current CatRender comments identify verbatim formulas, palette data, named
colors, presets, projection, canvas fitting, fog, and orientation behavior
from xyzrender. The exact upstream Git revision used for every ported file was
not recorded, so this is a component-and-feature scope, not a file-by-file
revision map.

#### xyz2svg

- Source: https://github.com/briling/xyz2svg
- License: MIT
- Notice and full text:
  [`third_party/licenses/xyz2svg-MIT.txt`](third_party/licenses/xyz2svg-MIT.txt)

The CatRender design identifies xyzrender as built on xyz2svg and specifically
records xyz2svg lineage for bond/SVG rendering. No direct xyz2svg revision or
complete copied-line map is recorded in CatGo history.

#### xyzgraph

- Source: https://github.com/aligfellow/xyzgraph
- Version named in current source: `1.6.10`
- License: MIT
- Notice and full text:
  [`third_party/licenses/xyzgraph-MIT.txt`](third_party/licenses/xyzgraph-MIT.txt)

`extensions/catrender-wasm/src/vdw.rs` says its data are sourced verbatim from
xyzgraph, and `extensions/catrender-wasm/src/svg.rs` identifies the symbol to
atomic-number table as verbatim xyzgraph data.

### AtomCanvas ports

- Source: https://github.com/zyc2806/atomcanvas
- License: MIT
- Notice and full text:
  [`third_party/licenses/AtomCanvas-MIT.txt`](third_party/licenses/AtomCanvas-MIT.txt)

CatGo history and source identify these adaptations:

- `src/lib/structure/select-dsl.ts`: selection parser and operation semantics;
- `src/lib/structure/bonding/bond-orders.ts`: a one-to-one TypeScript port of
  AtomCanvas bond-order heuristics; and
- `src/lib/structure/StructureScene.svelte` and related atom shader paths:
  ToonHighlightMaterial behavior.

CatGo did not record the exact AtomCanvas source revision for these ports.

### pretty-lattice material presets

- Source: https://github.com/songfeitong/pretty-lattice
- License: MIT
- Notice and full text:
  [`third_party/licenses/pretty-lattice-MIT.txt`](third_party/licenses/pretty-lattice-MIT.txt)

`src/lib/structure/atoms/render-style.ts` and `src/lib/settings/config.ts`
identify glossy and metallic material values ported from pretty-lattice.
The audit confirms the upstream repository and MIT notice but found no pinned
upstream revision in CatGo history.

### OVITO Basic ray-cylinder implementation

- Source: https://gitlab.com/stuko/ovito
- Official project license information:
  https://www.ovito.org/manual/licenses/
- Recorded upstream revision:
  `0b2cdccef7452bf28212e15daf9df2dc7a545bcc`
- License option selected in the CatGo source comments: MIT
- Notice and full text:
  [`third_party/licenses/OVITO-MIT.txt`](third_party/licenses/OVITO-MIT.txt)

CatGo's analytic WebGL bond cylinder rendering and picking code in
`src/lib/structure/gpu/webgl2/bond-replica-renderer.ts` and
`src/lib/structure/gpu/webgl2/replica-id-picker.ts` is adapted from these
recorded upstream files:

- `src/ovito/opengl/OpenGLCylinderPrimitive.cpp`
- `src/ovito/opengl/resources/glsl/cylinder/cylinder.vert`
- `src/ovito/opengl/resources/glsl/cylinder/cylinder.frag`
- `src/ovito/opengl/resources/glsl/cylinder/cylinder_picking.vert`
- `src/ovito/opengl/resources/glsl/cylinder/cylinder_picking.frag`

Material CatGo changes include WebGL2 GLSL3 syntax, Three.js uniforms,
half-bond replica decoding, static atom-color lookup, analytic coverage,
sparse ghost halves, and GPU picking.

### whisper.cpp optional STT accelerator

- Source: https://github.com/ggml-org/whisper.cpp
- Recorded upstream revision:
  `080bbbe85230f624f0b52127f1ae1218247989f9`
- License: MIT
- Scope: optional `whisper-cli` accelerator release archives
- Preserved notice and full text:
  [`third_party/licenses/whisper.cpp-MIT.txt`](third_party/licenses/whisper.cpp-MIT.txt)

Every accelerator archive also retains the upstream file byte-for-byte at
`whisper.cpp/LICENSE` and records the repository and exact revision in
`whisper.cpp/SOURCE.json`. The CatGo noncommercial terms do not replace the
MIT terms for whisper.cpp.

### Vendored PORMAKE

- Source: https://github.com/Sangwon91/PORMAKE
- Recorded upstream revision:
  `639caad9d315ef6cb4838d0f8e44336d4a41aa7a`
- License: MIT
- Scope: `server/catgo/vendor/pormake/`
- Retained upstream text:
  [`third_party/licenses/PORMAKE-MIT.txt`](third_party/licenses/PORMAKE-MIT.txt)

CatGo commit `5e7411ef1da98fd0139cf72e586b43f5451b94d9` records that
the tree was copied from PORMAKE, `experimental/` was omitted, and
`scaler.py` was changed from JAX to NumPy/SciPy. See the unresolved database
provenance item below for a narrower caveat about the bundled data collection.

### sql.js WebAssembly binary

- Source: https://github.com/sql-js/sql.js
- License: MIT
- Scope: `static/sql-wasm.wasm`
- Notice and full text:
  [`third_party/licenses/sql.js-MIT.txt`](third_party/licenses/sql.js-MIT.txt)

CatGo commit `fa62230e` records adding this binary for the sql.js desktop
fallback. The audited binary SHA-256 is
`9125e039f90b91617b6327d6fe271865248a1ae36fa3857d022cd213c730f6f6`.
The exact sql.js release/build revision used to produce it was not recorded.

### Bundled fonts

- Scope: `src/lib/fonts/`
- License: SIL Open Font License 1.1 (`OFL-1.1`)
- Font-specific notices:
  [`third_party/licenses/BUNDLED-FONTS.txt`](third_party/licenses/BUNDLED-FONTS.txt)
- Complete common license text:
  [`third_party/licenses/OFL-1.1.txt`](third_party/licenses/OFL-1.1.txt)

The bundled files' internal font metadata confirms the named copyright and
license records for Geist, Cascadia Code, Fira Code, JetBrains Mono, and
Source Code Pro. Geist also retains its source-specific text at
`src/lib/fonts/Geist-OFL.txt`.

### MediaPipe Hand Landmarker model bundle

- Scope: `static/models/hand_landmarker.task`
- Official Google model guide:
  https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker
- Official bundle URL linked as "Latest" by that guide:
  https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task
- Official model card linked by that guide:
  https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20%28Lite_Full%29%20with%20Fairness%20Oct%202021.pdf
- License: Apache-2.0
- [Apache-2.0 full text](third_party/licenses/Apache-2.0.txt)
- Audited SHA-256:
  `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`

The official guide says the Hand Landmarker task bundle contains the palm
detection and hand-landmark models, links the bundle above as its full,
float16 "Latest" model, and links the model card above for model information.
That model card identifies the license as Apache License, Version 2.0. On
2026-07-25 the official "Latest" download was byte-identical to CatGo's
bundled file at the recorded SHA-256.

## Confirmed source references with mapping still incomplete

These records identify an upstream and its published license, but CatGo does
not yet have a sufficiently precise revision/path map to state that the named
license applies to every current affected line.

### pymatgen

- Source: https://github.com/materialsproject/pymatgen
- Upstream license declaration: MIT
- Concrete CatGo references:
  `src/lib/xrd/calc-xrd.ts` says its scattering table is copied from
  `pymatgen/analysis/diffraction/atomic_scattering_params.json`; several
  `extensions/rust/src/` test modules say cases are ported from pymatgen.

The exact pymatgen revision and complete copied-test/data map were not recorded.
Maintainers should pin those facts and preserve the applicable upstream notice
before release.

### ASE

- Source: https://gitlab.com/ase/ase
- Upstream license declaration: LGPL-2.1-or-later
- Concrete CatGo reference:
  `extensions/rust/src/integrators.rs` says a test is ported from ASE's
  `test_nose_hoover_chain.py`.

The exact ASE revision and copied scope were not recorded.

### xterm.js

- Source: https://github.com/xtermjs/xterm.js
- Upstream license declaration: MIT
- Concrete CatGo reference:
  `src/lib/structure/TerminalPanel.svelte` identifies behavior based on xterm.js
  PR 5704.

CatGo history does not distinguish conceptual use from copied code for that
change, so no blanket path assignment is made here.

## Unresolved provenance and license mappings

These items require maintainer/counsel mapping before a release represents the
third-party inventory as complete. Recording a source URL or a repository's
general license would not by itself resolve model, dataset, artwork, or copied
code rights.

### Historical KMC Git submodule reference

- Historical path: `server/ext/KMC`
- Source: https://github.com/leshenzhang/KMC
- Historical pinned Git object:
  `7ebf5913bdaabdf78f248fcc7e71327e9f1f96ab`

No license file or license declaration was found in the historical pinned
upstream repository. No license ID is assigned here, and reuse of that source
still requires maintainer/counsel mapping. The audited Git tree contains no
`server/ext/KMC` entry. CatGo also removes the stale `.gitmodules` entry and
tests that KMC is absent from Git source archives, CI submodule checkout, and
the Python release configurations. The unresolved historical license therefore
does not supply rights for any future reintroduction.

### Historical Open Babel-derived CatRender perception code — removed

- Removed paths: `extensions/catrender-wasm/src/perceive.rs` and
  `docs/superpowers/plans/2026-05-21-catrender-ob-bond-perception.md`
- Source: https://github.com/openbabel/openbabel
- Audited upstream snapshot:
  `7ba0614b1fa51116f49dbbc669940e7af7df716a`
- Upstream repository license declaration: GPL-2.0
- Provenance ledger:
  `third_party/provenance/catrender-bond-order-removal.md`

The implementation and its embedded port plan were
removed from the current release tree. The ledger records the immutable
technical source map and the replacement provenance for CatRender's remaining
covalent-radius data. This
historical notice does not make a compatibility, substantiality, or other legal
conclusion, and removal does not settle those questions.

### PORMAKE database and RCSR-derived topology collection

- Paths: `server/catgo/vendor/pormake/database/` and
  `server/catgo/vendor/pormake/database/topologies/RCSR_topology.zip`
- Immediate source: the recorded PORMAKE revision above

The PORMAKE MIT file is retained for the vendored package, but the repository
does not document whether every building-block and topology data file was
authored by the PORMAKE copyright holder or imported under separate dataset
terms. This narrower dataset provenance question requires maintainer/counsel
mapping.

### Application icons, logos, screenshots, and QR image

- Generated icon paths: `src-tauri/icons/`
- Base/application artwork paths include `desktop/logo.png`,
  `desktop/logo.svg`, `static/favicon.svg`, `docs/public/logo-*.svg`, and
  `extensions/vscode/icon.png`
- Other media paths include `image/`, `static/*.png`, `static/*.webp`, and
  `static/qr-qq-group.jpg`

Repository history calls the application icon design custom and documents that
Tauri icons are generated from `desktop/logo.png`, but it does not retain
authorship, assignment, stock-asset, screenshot-subject, or QR-image rights
records. No third-party license is guessed. Maintainers should classify each
base artwork/media source and retain the supporting records.

### Other documented inspirations without revision maps

- `server/catgo/utils/nanotube_algorithm.py` names
  https://github.com/shm-phy/MOIRE-LATTICE_NANO-TUBE as inspiration.
- `server/catgo/utils/pseudo_hydrogen.py` says it is adapted from
  `reference_code/pseudo_hydrogen.py`, but that source is not identified in
  the current tree.

These references do not establish a copied scope or applicable notice. They
remain provenance follow-ups rather than confirmed license assignments.
