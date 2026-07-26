# Third-party notices and provenance audit

This file records third-party code and assets identified in the CatGo source
tree as audited at commit `ba35376e98d888aaee02f9cb34848da25110a0cf`.
It is an evidence inventory, not a legal opinion or a claim that every
third-party item has been found. CatGo is licensed under AGPL-3.0-or-later,
which does not replace or override the licenses described here. Requested
acknowledgement and citation are not additional conditions of that license.

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
`scaler.py` was changed from JAX to NumPy/SciPy.

### PORMAKE database and RCSR-derived topology collection — notice-backed evidence

- Paths: `server/catgo/vendor/pormake/database/` and
  `server/catgo/vendor/pormake/database/topologies/RCSR_topology.zip`
- Official PyPI project and version: `pormake 0.2.2`
- Machine-readable evidence:
  [`third_party/provenance/pormake-database-provenance.json`](third_party/provenance/pormake-database-provenance.json)
- Official publisher artifacts:
  - `pormake-0.2.2-py3-none-any.whl`
    (SHA-256 `cdcd945ed9146781cb05154b34cc4fb283c84e0d12cd6e0bb6c31e223c293c20`):
    https://files.pythonhosted.org/packages/c4/a5/f374f804c02b2be4d31f2f70452d5028f28753ce9a19bc664efdf36e4893/pormake-0.2.2-py3-none-any.whl
  - `pormake-0.2.2.tar.gz`
    (SHA-256 `d5b73897cf4f3b3828073f7ba71ece535172318e709a9a2186b925c40c37a04e`):
    https://files.pythonhosted.org/packages/22/c2/0b8ce705072c2c7aa52bcd15c08d1ee96ef1abb5971c6c6195e827e12a25/pormake-0.2.2.tar.gz

Both artifacts contain the identical 3,274-file database at
`pormake/database`. Both artifacts retain the MIT license: the wheel has
`pormake-0.2.2.dist-info/LICENSE.md` and the sdist has `LICENSE.md`. That
1,064-byte text has SHA-256
`62bf3249aed0b2105bd66c0f99283f68d97e6afac79cd5a2df083821373c1a31` and is
byte-identical to both retained CatGo copies at
`server/catgo/vendor/pormake/LICENSE` and
`third_party/licenses/PORMAKE-MIT.txt`.

This supplies the immediate-publisher notice basis for **NOTICE_BACKED**
distribution evidence for the listed CatGo database path. It does not establish
an independent chain of title for each dataset contribution. The
ToBaCCo/CoRE/RCSR independent chain of title was not separately established;
the source-specific caveats below remain part of the record. The audited ACS
supporting-information terms are CC BY-NC only for the supporting information
and are not extrapolated to the underlying ToBaCCo data. CoRE Zenodo record
3370144 is CC BY 4.0, but an E/N per-file mapping to the 796 bundled files has not been established. The current `odf/RCSR` repository declares no license,
and no dedicated open redistribution license was found for the audited CGD/ZIP
collection. This is a provenance record, not a legal conclusion.

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

## Confirmed source references with bounded provenance maps

The following records separate exact imports, adapted implementations, adapted
tests, copied data, and format/API interoperability. The complete
machine-readable evidence ledger is
[`third_party/provenance/pymatgen-ase-xterm-provenance.json`](third_party/provenance/pymatgen-ase-xterm-provenance.json).
These technical mappings make no legal conclusion. Where the historical record
does not prove the revision actually used by the original author, the immutable
revision below is identified only as a verified audit snapshot and the external
evidence gate remains open.

The bounded pymatgen, ASE, MatterViz, and xterm.js mappings are supported by
retained notices that provide **NOTICE_BACKED** release evidence:
`extensions/rust/src/algorithms/ewald.rs`,
`extensions/rust/src/cif.rs`, `extensions/rust/src/composition.rs`,
`extensions/rust/src/crystal_nn.rs`, `extensions/rust/src/element.rs`,
`extensions/rust/src/integrators.rs`, `extensions/rust/src/io.rs`,
`extensions/rust/src/lattice.rs`, `extensions/rust/src/matcher.rs`,
`extensions/rust/src/structure_matcher.rs`,
`extensions/rust/src/voronoi_cell.rs`, `extensions/rust/src/wasm_types.rs`,
`src/lib/structure/TerminalPanel.svelte`,
`src/lib/xrd/atomic-scattering-params.ts`, and `src/lib/xrd/calc-xrd.ts`.
This bounded release classification neither identifies an actual adopted
revision nor closes either external evidence gate.

### pymatgen

- Source: https://github.com/materialsproject/pymatgen
- Upstream license declaration: MIT
- Preserved upstream text:
  [`third_party/licenses/pymatgen-MIT.txt`](third_party/licenses/pymatgen-MIT.txt)
- Verified audit snapshot:
  `7b92f9ab4112d538381f4ee4dd6119295c200245`

That snapshot is an immutable point at which the mapped data, symbols, and test
fixtures can be reproduced. It is **not evidence that this was the revision
actually adopted**, which was not recorded.

The import history also establishes a MatterViz/Ferrox intermediary:

- MatterViz PR 274 head
  `63a222673cd21d6b4542ac8b819714aa3104b625` maps to CatGo commit
  `b4ce49e30eca8547b57f3f57fa251f8936a1b589`. `cif.rs`, `element.rs`, and
  `lattice.rs` have exact whole-file blobs; the marked test blocks in
  `composition.rs` and `io.rs` are exact; the first four marked `matcher.rs`
  tests are exact.
- MatterViz PR 290 head
  `34d031638685869f40ebfc8c5233c29584fb86f5` maps to CatGo commit
  `ce041a67c21232232de7f096652c1c5eb841b6eb`.
  `integrators.rs`, `structure_matcher.rs`, `algorithms/ewald.rs`, `xrd.rs`,
  and `elastic.rs` have exact whole-file blobs at import.

Bounded pymatgen mappings:

- **Copied data:** `src/lib/xrd/atomic-scattering-params.ts` is byte-identical
  to MatterViz revision `e17228c29d744c07b8b4d8315fa79fbc342551b2`;
  its 99 entries have zero value mismatches against
  `src/pymatgen/analysis/diffraction/atomic_scattering_params.json` at the
  audit snapshot.
- **Adapted production implementation:** `src/lib/xrd/calc-xrd.ts` maps
  `WAVELENGTHS`, diffraction tolerances, `get_unique_families`, and
  `compute_xrd_pattern` to pymatgen's diffraction `core.py` and `xrd.py`,
  through MatterViz revision `e17228c29d744c07b8b4d8315fa79fbc342551b2`.
- **Adapted production implementation:** CatGo commit
  `2c2439028ba65bde30866a3bf5efbf1963c5212b` explicitly introduced
  `extensions/rust/src/crystal_nn.rs` as a pymatgen port.
  `extensions/rust/src/voronoi_cell.rs::solid_angle` also states that it
  matches pymatgen's implementation. A reproducible pre-reorganization
  reference is `cc57da9bb90cf1e46ff72ca8fe8642514692cb8f` at
  `src/pymatgen/analysis/local_env.py`; the actual adopted revision remains
  unrecorded.
- **Adapted production implementation:** `extensions/rust/src/algorithms/ewald.rs`
  names pymatgen `analysis/ewald.py` for implementation details, and
  `extensions/rust/src/{matcher,structure_matcher}.rs` adapts
  `StructureMatcher` behavior.
- **Adapted tests:** the marked Rust tests map to pymatgen
  `test_composition.py`, `test_periodic_table.py`, `test_lattice.py`,
  `test_structure_matcher.py`, and `test_cif.py`; they are consolidated
  cross-language test scenarios, not byte-identical Python imports.
- **Interoperability only:** pymatgen `Structure.as_dict()` JSON,
  `PymatgenStructure` TypeScript shapes, and compatible element/structure
  field names do not by themselves establish copied implementation.

External evidence is still required to identify the actual pymatgen revisions
used by the original authors. The audit snapshot must not be promoted to an
adopted-revision claim without that evidence.

### ASE

- Source: https://gitlab.com/ase/ase
- Upstream license declaration: LGPL-2.1-or-later
- Preserved upstream text:
  [`third_party/licenses/ASE-LGPL-2.1.txt`](third_party/licenses/ASE-LGPL-2.1.txt)
- Verified audit snapshot:
  `e311e0ab9a04202b94799229e43357ead6243830`

That revision is a reproducible audit snapshot, **not proof of the revision
actually adopted**, which was not recorded. CatGo's
`extensions/rust/src/integrators.rs` was imported byte-identically in commit
`ce041a67c21232232de7f096652c1c5eb841b6eb` from MatterViz PR 290 head
`34d031638685869f40ebfc8c5233c29584fb86f5`.

The four explicit adapted-test mappings are:

- `test_nose_hoover_momentum_conservation` →
  `test_nose_hoover_chain.py::test_nose_hoover_chain_nvt`
- `test_velocity_verlet_symplectic` →
  `test_nose_hoover_chain.py::test_thermostat_round_trip`
- `test_nve_total_energy_conserved_high_precision` →
  `test_verlet_thermostats_asap.py::test_verlet_thermostats_asap`
- `test_langevin_temperature_distribution` →
  `test_nvt_npt.py::{propagate,test_langevin}`

These are rewritten Rust scenarios, not byte-identical Python imports. ASE
Atoms dictionaries, ASE-compatible units, and compatible field names are
recorded separately as interoperability only. External evidence is still
required to identify the actual ASE revision used by the original author.

### xterm.js

- Source: https://github.com/xtermjs/xterm.js
- Upstream license declaration: MIT
- Preserved upstream text:
  [`third_party/licenses/xterm.js-MIT.txt`](third_party/licenses/xterm.js-MIT.txt)
- PR: https://github.com/xtermjs/xterm.js/pull/5704
- Fixed comparison base:
  `fb25eb8f79fd223acef90828dc2990bb7e196a1d`
- Fixed comparison head:
  `16c7a837be902403383142016936059c90b6706e`
- Logic commits:
  `d70c52da926584f6865ab22e1a98a7d83a4c38bc` and
  `c02ba2cf07d3f46c594cd1eb37e5785e2b5e8f5a`

CatGo commit `99ebfb0015b9e19e8cc83ef43f21f2e7a63dc2e6` explicitly describes
the terminal IME architecture as based on PR 5704. The bounded scope is the IME
block in `src/lib/structure/TerminalPanel.svelte`, where
`wk_composing`, `wk_pending`, `isCJK`, `wkFlush`, `beforeinput`, keydown
flushing, and `term.onData` suppression correspond to xterm.js
`_wkImeComposing`, `_wkImePending`, `_isHangul`, `_wkFlush`, `_inputEvent`,
`_keyDown`, and `CompositionHelper.wkImeComposing`.

The CatGo patch ID is
`6a61e2bb0cca035bf2500e0afee4e0b2de734b38`; the two upstream logic patch
IDs are `7330ecfab8076b9baad43bfebc9b68aa0e8a1cf7` and
`a2eab2de989c9bd7a224d744244b851cd9310fd2`. None match. This rules out a
patch-identical import but, together with the state-machine and symbol mapping,
supports classification as an **adapted implementation**, rather than merely
conceptual use. CatGo-specific extensions include Chinese
`insertFromComposition`, a post-composition suppression window, and synthetic
DEL-debt handling. No blanket assignment is made outside that IME block.

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
  [`third_party/provenance/catrender-bond-order-removal.md`](third_party/provenance/catrender-bond-order-removal.md)

The implementation and its embedded port plan were
removed from the current release tree. The ledger records the immutable
technical source map and the replacement provenance for CatRender's remaining
covalent-radius data. This
historical notice does not make a compatibility, substantiality, or other legal
conclusion, and removal does not settle those questions.

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
