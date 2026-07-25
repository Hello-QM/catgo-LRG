# CatGo Noncommercial and Citation License Design

**Date:** 2026-07-25  
**Target release:** CatGo 1.4.6  
**Status:** Approved under the maintainer's standing instruction to apply the
recommended option without further confirmation

## Problem

CatGo currently declares `AGPL-3.0-or-later`. The AGPL permits commercial use,
so it cannot enforce the project's new requirement that commercial use needs
prior permission. The existing README merely requests a citation when CatGo
contributes to a publication; it does not make acknowledgement and citation
conditions of the software license.

Changing the license also has an ownership constraint. The repository contains
work from multiple contributors. A maintainer can change repository metadata,
but that alone does not prove authority to relicense every contribution.
Previously distributed AGPL versions remain available under the grants that
applied to those copies.

## Decision

CatGo 1.4.6 will use a source-available, non-open-source license named
`CatGo Noncommercial Research License 1.0`.

The license will use the PolyForm Noncommercial License 1.0.0 as its
noncommercial foundation and add CatGo-specific conditions for acknowledgement
and citation. Because those additional conditions make the complete terms
custom, package metadata must not describe the result as plain PolyForm or
AGPL. It will use `LicenseRef-CatGo-Noncommercial-1.0`, `license-file`, or
`SEE LICENSE IN license`, depending on the package ecosystem.

`CITATION.cff` is not a package manifest. To remain valid under the official
CFF 1.2 schema, it will omit the top-level `license` field, whose values are a
closed SPDX enumeration, and use the exact root-license URL in `license-url`.

This is preferred over:

1. Keeping AGPL and adding a README prohibition. AGPL users may remove
   additional restrictions, so this would not prohibit commercial use.
2. Applying Creative Commons BY-NC to the program. Creative Commons recommends
   against its licenses for software, and they do not address software-specific
   source and patent concerns.
3. Using only "all rights reserved". That is stricter, but it would also remove
   the clear permission that the project wants to give researchers and
   educators.

The final legal text must be reviewed by the relevant institutional or company
counsel. The implementation must not claim that source availability makes the
project open source.

## Licensed Scope and Ownership

The CatGo terms cover only portions for which the relevant CatGo copyright
holder can grant rights. Third-party components, vendored code, dependencies,
fonts, models, icons, and separately licensed subprojects retain their own
licenses. `THIRD_PARTY_NOTICES.md` remains authoritative for those materials.

The license identifies the licensor generically as the copyright holder or
holders of the CatGo-owned portion. It does not assert that UC San Diego,
Hello-QM, or an individual owns every contribution without supporting records.
Commercial-license requests go to `gul026@ucsd.edu`.

Before the license-changing pull request is merged, maintainers must retain
documentary evidence of one of the following:

- consent from every copyright holder whose contribution remains in the
  relicensed tree;
- a contributor agreement or assignment that already permits relicensing; or
- institutional counsel confirmation that the relevant contributions are
  owned or controlled by one entity that authorizes the change.

This manual evidence gate cannot be replaced by a passing software test.

## Permission Model

The license grants a non-exclusive, non-transferable copyright and patent
license for personal study, teaching, reproducible academic research, and
internal noncommercial evaluation.

The following are commercial uses and require a separate written agreement:

- use by or for a for-profit entity, including internal research and
  development;
- use in a paid product, hosted service, consulting engagement, client
  deliverable, or revenue-generating workflow;
- use to train, validate, or operate a model, dataset, or service intended for
  commercial deployment;
- redistribution for compensation; and
- sponsored work that gives a commercial sponsor rights in the CatGo-derived
  output.

Statutory exceptions such as fair use are not restricted.

Noncommercial modification and redistribution are permitted only when the
recipient receives the same license, all required notices, the citation file,
and a prominent description of changes. Sublicensing is not permitted.

## Mandatory Acknowledgement and Citation

Every public output materially produced with CatGo must:

1. visibly acknowledge CatGo with the sentence
   `This work used CatGo (https://catgo-ucsd.org).`; and
2. cite the preferred citation in `CITATION.cff`.

Public outputs include papers, preprints, theses, reports, presentations,
posters, datasets, benchmarks, websites, software documentation, and
CatGo-derived services. The condition applies to permitted noncommercial use
and to commercial agreements unless the written commercial agreement replaces
it explicitly.

Distributions must retain `license`, `CITATION.cff`, the acknowledgement
sentence, copyright notices, and `THIRD_PARTY_NOTICES.md`.

## Enforcement Terms

Unauthorized commercial use or failure to satisfy a material condition
terminates the license automatically. The copyright holder retains all
remedies available under applicable law, including injunctive relief and
damages where available. Delay or failure to enforce one breach is not a waiver
of later enforcement. The terms include severability, no warranty, limitation
of liability, no trademark grant, and no implied rights.

The project will not state a governing jurisdiction or ownership entity until
the rights holder provides that information to counsel.

## Repository Changes

The implementation changes:

- root `license`;
- `CITATION.cff` (renamed from lowercase `citation.cff`);
- English and Chinese README badges and license/citation language;
- first-party npm, Python, Rust, Tauri, WASM, and VS Code package metadata;
- contribution guidance to warn that contributions must be compatible with the
  project's ability to license and enforce the software; and
- a dedicated commercial-license document with the permitted-use summary and
  contact address.

Separately licensed third-party crates and vendored directories are not
relicensed.

## Verification

A Node regression test will fail before implementation and then require:

- the exact custom license identifier in every first-party manifest;
- no stale first-party AGPL claims in package metadata, README files, or
  `CITATION.cff`;
- no top-level `license` field in `CITATION.cff`, the exact root
  `license-url`, and full validation against the official CFF 1.2 schema;
- the mandatory acknowledgement sentence and ChemRxiv DOI in the license,
  READMEs, and `CITATION.cff`;
- explicit commercial-use, termination, enforcement, and third-party
  exceptions in the root license;
- `CITATION.cff` to use the canonical uppercase filename; and
- references to the commercial-license contact and third-party notices.

Release verification also runs:

- the full Node/Worker regression suite;
- the normal frontend test, type-check, and build gates;
- Python distribution metadata inspection;
- Cargo metadata checks for all changed first-party crates; and
- a repository search proving that remaining AGPL strings occur only in
  historical documents or materials intentionally left under that license.

## Release Consequences

CatGo 1.4.6 must not be tagged or published until both the technical gates and
the manual relicensing-authority gate pass. Release notes must call out the
license change prominently. Historical releases and copies already obtained
under AGPL are not represented as retroactively relicensed or revoked.
