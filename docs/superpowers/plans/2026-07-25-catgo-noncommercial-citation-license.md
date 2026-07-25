# CatGo Noncommercial and Citation License Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CatGo's commercial-use-permitting AGPL declaration with a
noncommercial research license that requires acknowledgement and citation,
while preserving third-party licenses and emitting consistent package
metadata.

**Architecture:** The root `license` file is the single legal source of truth
for CatGo-owned code. Ecosystem manifests refer to that custom license through
their supported nonstandard-license mechanism, while package-local license
copies are byte-identical when an archive cannot include the root file.
`CITATION.cff`, the English and Chinese READMEs, and a commercial-license page
provide one exact acknowledgement and preferred citation.

**Tech Stack:** Node.js built-in test runner, CFF 1.2 YAML, npm package
metadata, PEP 639/Hatchling, Cargo manifests, VS Code extension packaging,
Markdown.

## Global Constraints

- The custom identifier is exactly
  `LicenseRef-CatGo-Noncommercial-1.0`.
- The exact acknowledgement is
  `This work used CatGo (https://catgo-ucsd.org).`
- The required publication DOI is
  `10.26434/chemrxiv.15002984/v1`.
- Commercial permission requests go to `gul026@ucsd.edu`.
- The license covers only CatGo-owned portions; separately licensed and
  third-party materials retain their existing terms.
- Do not rewrite historical release notes to imply that older AGPL grants were
  revoked.
- Do not tag or publish 1.4.6 until maintainers retain documentary authority
  to relicense all current CatGo-owned contributions.
- Do not describe the resulting source-available license as OSI open source.

---

### Task 1: Make the Core License and Citation Contract Executable

**Files:**
- Create: `scripts/__tests__/license-policy.test.mjs`
- Modify: `license`
- Rename: `citation.cff` to `CITATION.cff`
- Create: `COMMERCIAL_LICENSE.md`

**Interfaces:**
- Consumes: the policy constants in Global Constraints.
- Produces: root legal source `license`, canonical citation metadata
  `CITATION.cff`, and the user-facing commercial-license entry point.

- [ ] **Step 1: Write the failing policy test**

Create `scripts/__tests__/license-policy.test.mjs` with Node's built-in test
runner. Resolve paths from the test file rather than from `process.cwd()`:

```js
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')
const ACK = 'This work used CatGo (https://catgo-ucsd.org).'
const DOI = '10.26434/chemrxiv.15002984/v1'

test('root license prohibits unauthorized commercial use', () => {
  const text = read('license')
  assert.match(text, /CatGo Noncommercial Research License 1\.0/)
  assert.match(text, /prior written permission/i)
  assert.match(text, /for-profit entity/i)
  assert.match(text, /terminates automatically/i)
  assert.match(text, /injunctive relief/i)
  assert.match(text, /THIRD_PARTY_NOTICES\.md/)
  assert.match(text, new RegExp(ACK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(text, new RegExp(DOI.replaceAll('.', '\\.')))
})

test('canonical citation file contains mandatory citation data', () => {
  assert.equal(existsSync(resolve(ROOT, 'citation.cff')), false)
  const text = read('CITATION.cff')
  assert.match(text, /^cff-version: 1\.2\.0$/m)
  assert.match(text, /^version: 1\.4\.6$/m)
  assert.match(text, /CatGo: Bridging CLI Coding Agents/)
  assert.match(text, new RegExp(DOI.replaceAll('.', '\\.')))
  assert.match(text, /If you use CatGo, you must acknowledge and cite it/)
})

test('commercial license page repeats the enforceable entry points', () => {
  const text = read('COMMERCIAL_LICENSE.md')
  assert.match(text, /gul026@ucsd\.edu/)
  assert.match(text, /LicenseRef-CatGo-Noncommercial-1\.0/)
  assert.match(text, /not open source/i)
  assert.match(text, /historical releases/i)
})
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
rtk node --test scripts/__tests__/license-policy.test.mjs
```

Expected: FAIL because the current root file is AGPL, `CITATION.cff` does not
exist, and `COMMERCIAL_LICENSE.md` does not exist.

- [ ] **Step 3: Replace the root legal terms**

Replace `license` with `CatGo Noncommercial Research License 1.0`. Its opening
application notice must state:

```text
CatGo Noncommercial Research License 1.0

Copyright (c) CatGo copyright holders. All rights reserved except as
expressly granted below.

This license applies only to portions of CatGo for which the relevant CatGo
copyright holder can grant rights. Third-party and separately licensed
materials retain their own terms; see THIRD_PARTY_NOTICES.md and license files
shipped with those materials.
```

The operative sections must be named and cover these exact rules:

1. `Acceptance and Scope` — use is conditional on every term.
2. `Permitted Noncommercial Use` — personal study, teaching, reproducible
   academic research, and internal noncommercial evaluation.
3. `Commercial Use Requires Prior Written Permission` — any use by or for a
   for-profit entity, paid product/service/consulting/client work, commercial
   model or dataset work, compensated redistribution, and sponsor-controlled
   work is prohibited without a signed agreement from the licensor.
4. `Acknowledgement and Citation` — every public output must include the exact
   acknowledgement and cite DOI `10.26434/chemrxiv.15002984/v1`.
5. `Modification and Redistribution` — noncommercial only, same terms,
   retained `license`, `CITATION.cff`, acknowledgement,
   `THIRD_PARTY_NOTICES.md`, and a prominent change notice.
6. `No Sublicense or Transfer`.
7. `Patent and Trademark Rights` — limited patent grant for permitted use and
   no trademark grant.
8. `Termination and Enforcement` — unauthorized commercial use or material
   noncompliance terminates automatically; licensors retain legal remedies,
   including injunctive relief and damages where available; non-enforcement is
   not waiver.
9. `Fair Use and Statutory Rights`.
10. `No Warranty and Limitation of Liability`.
11. `Severability and No Implied Rights`.
12. `Commercial Licensing` — `gul026@ucsd.edu`.

Append the unmodified official PolyForm Noncommercial 1.0.0 text under
`Noncommercial Foundation Terms`, identify the source URL as
`https://polyformproject.org/licenses/noncommercial/1.0.0`, and state that the
CatGo-specific terms above are additional conditions of the CatGo grant. Do
not rename the complete custom license to plain PolyForm.

- [ ] **Step 4: Canonicalize the CFF file and commercial-license page**

Rename `citation.cff` to `CITATION.cff`. Set `version: 1.4.6`,
`license: LicenseRef-CatGo-Noncommercial-1.0`, and the GitHub license URL ending
in `/blob/main/license`. Set the message exactly to:

```yaml
message: If you use CatGo, you must acknowledge and cite it as described below.
```

Keep the software record and add `preferred-citation` for the ChemRxiv
preprint using the complete author order and BibTeX data already present in
`readme.md`.

Create `COMMERCIAL_LICENSE.md` with:

- a prominent "source-available, not open source" statement;
- noncommercial examples and commercial examples matching `license`;
- the exact acknowledgement and DOI;
- `mailto:gul026@ucsd.edu` for written commercial permission;
- third-party exclusions; and
- an explicit statement that historical releases remain governed by the terms
  attached to those copies.

- [ ] **Step 5: Run focused verification and confirm GREEN**

Run:

```bash
rtk node --test scripts/__tests__/license-policy.test.mjs
rtk git diff --check
```

Expected: all 3 tests PASS and no whitespace errors.

- [ ] **Step 6: Commit**

```bash
rtk git add license CITATION.cff COMMERCIAL_LICENSE.md \
  scripts/__tests__/license-policy.test.mjs
rtk git add -u citation.cff
rtk git commit -m "legal: adopt noncommercial citation license"
```

---

### Task 2: Synchronize Every First-Party Package Manifest

**Files:**
- Modify: `scripts/__tests__/license-policy.test.mjs`
- Modify: `package.json`
- Modify: `extensions/rust-wasm/package.json`
- Create: `extensions/rust-wasm/license`
- Modify: `extensions/vscode/package.json`
- Modify: `extensions/vscode/license`
- Modify: `server/pyproject.toml`
- Create: `server/LICENSE`
- Modify: `crates/catgo-graph/Cargo.toml`
- Modify: `extensions/catrender-wasm/Cargo.toml`
- Modify: `extensions/chgdiff-wasm/Cargo.toml`
- Modify: `extensions/rust/Cargo.toml`
- Modify: `src-tauri/Cargo.toml`
- Modify: `tools/cube-processor/Cargo.toml`
- Modify: `examples/plugins/charge-coloring/catgo-plugin.json`
- Modify: `examples/plugins/lennard-jones-calculator/catgo-plugin.json`

**Interfaces:**
- Consumes: the root `license` produced by Task 1.
- Produces: ecosystem-specific metadata that resolves to the same custom
  license without changing MIT/Apache third-party crates.

- [ ] **Step 1: Extend the test with exact manifest expectations**

Append:

```js
const customNpm = [
  'package.json',
  'extensions/rust-wasm/package.json',
  'extensions/vscode/package.json',
]
const customCargo = [
  ['crates/catgo-graph/Cargo.toml', '../../license'],
  ['extensions/catrender-wasm/Cargo.toml', '../../license'],
  ['extensions/chgdiff-wasm/Cargo.toml', '../../license'],
  ['extensions/rust/Cargo.toml', '../../license'],
  ['src-tauri/Cargo.toml', '../license'],
  ['tools/cube-processor/Cargo.toml', '../../license'],
]

test('first-party manifests resolve to the custom license', () => {
  for (const file of customNpm) {
    assert.equal(JSON.parse(read(file)).license, 'SEE LICENSE IN license', file)
  }
  const pyproject = read('server/pyproject.toml')
  assert.match(pyproject, /^license = "LicenseRef-CatGo-Noncommercial-1\.0"$/m)
  assert.match(pyproject, /^license-files = \["LICENSE"\]$/m)
  for (const [file, relative] of customCargo) {
    const text = read(file)
    assert.match(text, new RegExp(`^license-file = "${relative.replaceAll('.', '\\.')}"$`, 'm'), file)
    assert.doesNotMatch(text, /^license = /m, file)
  }
})

test('package-local license copies are byte-identical', () => {
  const rootLicense = read('license')
  assert.equal(read('server/LICENSE'), rootLicense)
  assert.equal(read('extensions/rust-wasm/license'), rootLicense)
  assert.equal(read('extensions/vscode/license'), rootLicense)
})

test('separately licensed crates retain their own terms', () => {
  assert.match(read('extensions/uff-relax/Cargo.toml'), /MIT OR Apache-2\.0/)
  assert.match(read('extensions/vsepr-rs/Cargo.toml'), /MIT OR Apache-2\.0/)
  assert.match(read('extensions/rust/pyproject.toml'), /MIT/)
})
```

- [ ] **Step 2: Run and confirm RED**

Run:

```bash
rtk node --test scripts/__tests__/license-policy.test.mjs
```

Expected: the three Task 1 tests PASS and the manifest/copy tests FAIL on stale
AGPL values.

- [ ] **Step 3: Update npm, Python, Rust, plugin, and VSIX metadata**

Use `SEE LICENSE IN license` in the three npm manifests. Copy the root license
byte-for-byte to `extensions/rust-wasm/license` and add `"license"` to that
package's `files` array. Ensure the VS Code extension archive still contains
`extensions/vscode/license`, also copied byte-for-byte from the root.

In `server/pyproject.toml`, use:

```toml
license = "LicenseRef-CatGo-Noncommercial-1.0"
license-files = ["LICENSE"]
```

Copy root `license` byte-for-byte to `server/LICENSE`.

For each first-party Cargo manifest, replace `license =
"AGPL-3.0-or-later"` with the exact `license-file` path in the test. Do not
change `extensions/uff-relax`, `extensions/vsepr-rs`, or
`extensions/rust/pyproject.toml`.

Set both example plugin JSON license values to
`LicenseRef-CatGo-Noncommercial-1.0`.

- [ ] **Step 4: Validate the metadata formats**

Run:

```bash
rtk node --test scripts/__tests__/license-policy.test.mjs
rtk cargo metadata --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1
rtk cargo metadata --manifest-path extensions/rust/Cargo.toml --no-deps --format-version 1
rtk cargo metadata --manifest-path extensions/catrender-wasm/Cargo.toml --no-deps --format-version 1
rtk cargo metadata --manifest-path extensions/chgdiff-wasm/Cargo.toml --no-deps --format-version 1
rtk cargo metadata --manifest-path crates/catgo-graph/Cargo.toml --no-deps --format-version 1
rtk cargo metadata --manifest-path tools/cube-processor/Cargo.toml --no-deps --format-version 1
rtk python -m build server --sdist --wheel --outdir /tmp/catgo-license-dist-146
rtk bash -lc 'python -m zipfile -l "$(find /tmp/catgo-license-dist-146 -maxdepth 1 -name "*.whl" -print -quit)"'
```

Expected: tests PASS; every Cargo command returns valid JSON; Python builds
succeed and the wheel listing contains the custom license file. Use a fresh
temporary directory if `/tmp/catgo-license-dist` already exists.

- [ ] **Step 5: Commit**

```bash
rtk git add package.json extensions/rust-wasm/package.json \
  extensions/rust-wasm/license \
  extensions/vscode/package.json extensions/vscode/license \
  server/pyproject.toml server/LICENSE \
  crates/catgo-graph/Cargo.toml extensions/catrender-wasm/Cargo.toml \
  extensions/chgdiff-wasm/Cargo.toml extensions/rust/Cargo.toml \
  src-tauri/Cargo.toml tools/cube-processor/Cargo.toml \
  examples/plugins/charge-coloring/catgo-plugin.json \
  examples/plugins/lennard-jones-calculator/catgo-plugin.json \
  scripts/__tests__/license-policy.test.mjs
rtk git commit -m "chore: align package license metadata"
```

---

### Task 3: Make the User and Contributor Contract Unambiguous

**Files:**
- Modify: `scripts/__tests__/license-policy.test.mjs`
- Modify: `readme.md`
- Modify: `readme.zh.md`
- Modify: `server/README-pypi.md`
- Modify: `contributing.md`
- Modify: `contributing.zh.md`

**Interfaces:**
- Consumes: `license`, `CITATION.cff`, and `COMMERCIAL_LICENSE.md`.
- Produces: consistent English, Chinese, PyPI, and contributor-facing policy.

- [ ] **Step 1: Extend tests for every public policy surface**

Append:

```js
const userDocs = ['readme.md', 'readme.zh.md', 'server/README-pypi.md']

test('user docs require acknowledgement, citation, and commercial permission', () => {
  for (const file of userDocs) {
    const text = read(file)
    assert.match(text, /CatGo Noncommercial Research License 1\.0/, file)
    assert.match(text, /CITATION\.cff/, file)
    assert.match(text, new RegExp(DOI.replaceAll('.', '\\.')), file)
    assert.match(text, /COMMERCIAL_LICENSE\.md/, file)
    assert.doesNotMatch(text, /AGPL-3\.0-or-later|AGPL v3/, file)
  }
  assert.match(read('readme.md'), new RegExp(ACK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(read('readme.zh.md'), /必须.*致谢.*引用/)
})

test('contribution guides disclose the relicensing authority requirement', () => {
  assert.match(read('contributing.md'), /right to license and enforce/i)
  assert.match(read('contributing.md'), /not.*relicense third-party/i)
  assert.match(read('contributing.zh.md'), /许可和维权/)
  assert.match(read('contributing.zh.md'), /第三方/)
})
```

- [ ] **Step 2: Run and confirm RED**

Run:

```bash
rtk node --test scripts/__tests__/license-policy.test.mjs
```

Expected: Task 1 and Task 2 tests PASS; documentation tests FAIL on AGPL and
optional citation language.

- [ ] **Step 3: Update English, Chinese, and PyPI documentation**

Replace the AGPL badge with an orange
`CatGo Noncommercial Research License 1.0` badge linked to `license`.

In English, state that all public outputs must include the exact
acknowledgement and preferred citation, and that commercial use needs prior
written permission through `COMMERCIAL_LICENSE.md`.

In Chinese, state equivalently that all public outputs "必须致谢并引用" and
commercial use "必须事先取得书面许可". Keep the exact English acknowledgement
sentence in a fenced block because it is the required wording.

Update all lowercase `citation.cff` links to `CITATION.cff`. Preserve the
existing BibTeX record and DOI.

Update `server/README-pypi.md` with the same license name, DOI, canonical CFF
link, and commercial-license link to the GitHub main branch.

- [ ] **Step 4: Update contribution terms without claiming assignment**

Add a `Licensing of contributions` section to both contribution guides. It
must say:

- contributors must have the right to submit their work;
- third-party code must retain its original notices and cannot be relicensed
  by merely copying it into CatGo;
- accepting a pull request does not by itself prove copyright assignment; and
- maintainers may require a separate contributor agreement before accepting a
  contribution so the project has the right to license and enforce its code.

Do not claim that historical contributors have already signed an agreement.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
rtk node --test scripts/__tests__/license-policy.test.mjs
rtk git diff --check
```

Expected: all policy tests PASS.

Commit:

```bash
rtk git add readme.md readme.zh.md server/README-pypi.md \
  contributing.md contributing.zh.md scripts/__tests__/license-policy.test.mjs
rtk git commit -m "docs: require CatGo acknowledgement and citation"
```

---

### Task 4: Prove Archive Contents and Repository Consistency

**Files:**
- Modify: `scripts/__tests__/license-policy.test.mjs`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: all policy and manifest changes from Tasks 1–3.
- Produces: a release-grade consistency gate and a prominent 1.4.6 license
  migration note.

- [ ] **Step 1: Add the stale-license allowlist test**

Append:

```js
test('active first-party surfaces contain no stale AGPL grant', () => {
  const active = [
    'package.json',
    'server/pyproject.toml',
    'extensions/rust-wasm/package.json',
    'extensions/vscode/package.json',
    'crates/catgo-graph/Cargo.toml',
    'extensions/catrender-wasm/Cargo.toml',
    'extensions/chgdiff-wasm/Cargo.toml',
    'extensions/rust/Cargo.toml',
    'src-tauri/Cargo.toml',
    'tools/cube-processor/Cargo.toml',
    'readme.md',
    'readme.zh.md',
    'server/README-pypi.md',
    'CITATION.cff',
  ]
  for (const file of active) {
    assert.doesNotMatch(read(file), /AGPL|GNU AFFERO/i, file)
  }
})
```

- [ ] **Step 2: Confirm the new test is meaningful**

Temporarily point one array entry at `docs/reference/changelog.md`, run the
focused test, and confirm it fails because historical notes intentionally
mention AGPL. Revert that one-line test mutation and rerun.

Run:

```bash
rtk node --test scripts/__tests__/license-policy.test.mjs
```

Expected after reverting the mutation: all tests PASS.

- [ ] **Step 3: Add the 1.4.6 changelog entry**

Under 1.4.6, state:

- new distributions use `CatGo Noncommercial Research License 1.0`;
- commercial use requires prior written permission;
- public outputs require acknowledgement and citation;
- third-party materials retain their licenses; and
- historical copies remain under the license distributed with them.

Do not edit older changelog entries.

- [ ] **Step 4: Run the complete local verification matrix**

Run:

```bash
rtk node --test scripts/__tests__/*.test.mjs workers/downloads/__tests__/*.test.mjs
rtk pnpm test
rtk pnpm check
rtk pnpm deploy:build
rtk pnpm exec wrangler deploy --dry-run --config wrangler.toml
rtk git diff --check
rtk git status --short
```

Expected:

- every Node/Worker policy and workflow test passes;
- Vitest has zero failures;
- Svelte check has zero errors;
- production build and Wrangler dry run succeed; and
- only the planned Task 4 files are uncommitted before the final task commit.

- [ ] **Step 5: Inspect package archives**

Build each published artifact without uploading it:

```bash
rtk npm pack --dry-run
rtk pnpm --dir extensions/vscode exec vsce ls
rtk python -m build server --sdist --wheel --outdir /tmp/catgo-license-dist-146
rtk cargo package --manifest-path crates/catgo-graph/Cargo.toml --allow-dirty --no-verify --list
```

Expected: every first-party archive lists the applicable `license` or
package-local `LICENSE` plus citation/readme content where the ecosystem
supports it. No command publishes an artifact.

- [ ] **Step 6: Commit**

```bash
rtk git add CHANGELOG.md scripts/__tests__/license-policy.test.mjs
rtk git commit -m "test: enforce release license consistency"
```

- [ ] **Step 7: Manual legal release gate**

Before merging this branch or publishing 1.4.6, record outside the repository
the rights-holder evidence required by the design. A GitHub approval,
successful CI run, or maintainer merge button is not a substitute for that
evidence. If evidence is unavailable, leave the license PR open and do not
represent 1.4.6 as relicensed.
