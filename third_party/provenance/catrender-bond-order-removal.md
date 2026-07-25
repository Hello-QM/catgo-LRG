# CatRender bond-order perception removal record

## Status and scope

This record documents a technical source-lineage audit and removal. It is not
a legal conclusion about compatibility, copyrightability, substantiality, or
distribution rights. Maintainer and counsel review remain separate release
decisions.

- Audit baseline: CatGo commit
  `de23b87c93e7478cb49928887426fd9da42699c7`
- CatGo introducing commit:
  `40d0c44c2190a0b46e6bfd9ef99a80206c55c2a2`
- Reconstructed Open Babel snapshot:
  `7ba0614b1fa51116f49dbbc669940e7af7df716a`
- Audit and removal executor: Codex (OpenAI)
- Audit and removal date: 2026-07-25
- Independent review status: not performed as part of the removal task;
  reviewer identity and review date must be recorded only when that review
  actually occurs.

The Open Babel repository snapshot above declares GPL version 2 in `COPYING`.
The declaration is recorded as a source fact, not as a conclusion about the
removed CatGo material.

## Technical lineage map

The baseline file
`extensions/catrender-wasm/src/perceive.rs` had Git blob
`b335280b0148eeca70ffa8ad5cb269896c17b59d`. The table records functional
lineage without retaining source text, pseudocode, fixtures, or expected
outputs from the removed implementation.

| Deleted baseline lines | Removed responsibility | Audited Open Babel snapshot location |
|---|---|---|
| 1–4 | Port declaration and documented deviations | `src/mol.cpp:3222–3587` |
| 6–92 | Element rows and radius/valence/electronegativity access | `src/elementtable.h:17–29,37–92` |
| 94–142 | Radius correction and geometry helpers | `src/atom.cpp:1132–1180`; `src/mol.cpp:214–220,309–334` |
| 144–282 | Graph queries, ring substitute, average-angle support | OB graph/SSSR query use; `src/atom.cpp:918–944` |
| 284–357 | Hybridization passes | `src/mol.cpp:3239–3347` |
| 359–382 | Aromatic typing pass | `src/mol.cpp:3355–3416` |
| 384–415 | Double-bond geometry and local support | `src/bond.cpp:481–518` |
| 417–541 | Multiple-bond assignment pass | `src/mol.cpp:204–207,3430–3575` |
| 543–562 | Perception entry pipeline | `src/mol.cpp:3222–3587` |
| 564–797 | Inline implementation tests and attributed fixtures | Removed with the implementation; not retained as clean-room inputs |

Upstream audit references use immutable snapshot URLs:

- https://github.com/openbabel/openbabel/blob/7ba0614b1fa51116f49dbbc669940e7af7df716a/COPYING
- https://github.com/openbabel/openbabel/blob/7ba0614b1fa51116f49dbbc669940e7af7df716a/src/mol.cpp
- https://github.com/openbabel/openbabel/blob/7ba0614b1fa51116f49dbbc669940e7af7df716a/src/atom.cpp
- https://github.com/openbabel/openbabel/blob/7ba0614b1fa51116f49dbbc669940e7af7df716a/src/bond.cpp
- https://github.com/openbabel/openbabel/blob/7ba0614b1fa51116f49dbbc669940e7af7df716a/src/elementtable.h

## Removed material and interfaces

The release-tree treatment removed:

- `extensions/catrender-wasm/src/perceive.rs`, including its 15 inline tests;
- `docs/superpowers/plans/2026-05-21-catrender-ob-bond-perception.md`, baseline
  Git blob `dde34f3d78ecbfab4cdcf8f04973c5a130c8b3e1`;
- the private Rust module registration and perception call;
- `Style.perceive_orders`;
- `CatRenderState.perceive_orders`;
- the CatRender checkbox, reactive dependency, and render-payload key.

Removal of the Rust implementation is committed at
`7e9962c84fa7dffcbd7ff5f1cc926472f32bedb1`. Legacy JSON containing the
retired style key remains parseable as an ignored unknown field. Supplied bond
orders, including aromatic order 1.5, remain authoritative. The independent
distance-only connectivity fallback and long-bond pruning remain available.

The main Structure/trajectory bond worker and the WebGL2/WebGPU production
renderers were outside the removed call path and were not modified.

## Independent covalent-radius input

Long-bond pruning and CatRender distance connectivity now consume a narrow
generated lookup whose only chemistry-data input is CatGo's pre-existing
element data:

- Input: `src/lib/element/data.ts`
- Audited input Git blob:
  `d28d96c24f29a98944f1ae806f5c002266075c86`
- Byte-identical historical MIT evidence commit:
  `4da4da53631c057bf486a996f463201cf707d8a6`
- License notice: `third_party/licenses/MatterViz-MIT.txt`
- Generator: `scripts/generate-catrender-covalent-radii.mjs`
- Generated output: `extensions/catrender-wasm/src/element_data.rs`
- Reproducibility check:
  `rtk node scripts/generate-catrender-covalent-radii.mjs --check`

The generated lookup contains symbols and non-null covalent radii only. It
does not contain valence, electronegativity, hybridization, ring, aromaticity,
or bond-order logic.

## Future clean-room boundary

Any future bond-order implementation is a separate project, not a continuation
of the removed code. Its implementers must receive a `.git`-free source archive
created after this removal. They must not receive the deleted Rust file, the
deleted implementation plan, or the deleted tests.

Permitted design inputs must be approved and logged before implementation:
independent published descriptions, independently licensed fixtures, the
audited CatGo element blob above, and pinned dependencies whose permissive
license evidence has been reviewed. A future project must record immutable
source versions, implementer and reviewer identities, review dates, dependency
license expressions, fixture licenses, and generation commands. It must not
use Open Babel output parity as its behavioral specification.
