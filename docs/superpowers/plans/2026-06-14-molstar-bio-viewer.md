# Mol\* Bio Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render biomolecular files (PDB / bio-mmCIF) in an embedded Mol\* viewer pane, auto-routed by a content sniffer, while materials files keep using the native Three.js viewer.

**Architecture:** Mol\* is a *parallel* viewer pane with its own WebGL2 context and parser. A pure content sniffer (`detect_bio`) decides bio vs. material at file-ingest time. Bio files bypass the pymatgen/ferrox pipeline entirely — their raw text is handed straight to Mol\*, which preserves residue/chain/secondary-structure. A per-pane `viewer_kind` field plus a small floating toggle gives the user a manual override either direction.

**Tech Stack:** SvelteKit 2 / Svelte 5 runes, Vite 7, `molstar` npm package (lazy `import()`), vitest.

---

## File Structure

| File | Responsibility | Create/Modify |
|------|----------------|---------------|
| `package.json` | add `molstar` dep | Modify |
| `src/lib/structure/bio/detect.ts` | pure sniffer: raw text + filename → `{isBio, kind, format, reason}` | Create |
| `src/lib/structure/bio/detect.test.ts` | vitest unit tests for the sniffer | Create |
| `src/lib/structure/bio/MolstarViewer.svelte` | lazy-loads Mol\*, mounts the all-in-one Viewer, loads raw data, disposes on unmount | Create |
| `src/lib/structure/bio/BioViewerToggle.svelte` | floating "open in native ⇄ open in Mol\*" override button | Create |
| `desktop/pane-utils.ts` | extend `PaneState` + `LibraryEntry` with `viewer_kind` / `bio_raw_content` / `bio_format` | Modify |
| `desktop/App.svelte` | route bio in `ingest_one`, copy fields in `apply_entry_to_pane`, add render branch + toggle | Modify |
| `src/lib/mobile/MobileWorkspace.svelte` | mirror the render branch on mobile | Modify |
| `src/lib/i18n/en/structure.ts` / `zh/structure.ts` | toggle-button strings (en+zh parity) | Modify |

**Conventions reminder:** `deno fmt` is enforced by a pre-commit hook — single quotes, **no semicolons**, 2-space indent, 90-col. `.svelte` files are excluded from `deno fmt`. Let the hook format `.ts` files, then re-stage. Use Svelte 5 runes (`$props`, `$state`, `$effect`), never `export let`.

---

## Task 1: Add the `molstar` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install molstar**

Run (from the repo root):
```bash
pnpm add molstar
```
Expected: `package.json` gains a `"molstar": "^4.x.x"` line under `dependencies`; `pnpm-lock.yaml` updates.

- [ ] **Step 2: Confirm the embed entry points resolve**

Run:
```bash
ls node_modules/molstar/lib/apps/viewer/app.js node_modules/molstar/build/viewer/molstar.css
```
Expected: both paths exist (the JS entry we import, and the prebuilt CSS skin — prebuilt avoids needing a sass toolchain).

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "build(bio): add molstar dependency for bio viewer"
```

---

## Task 2: Content sniffer `detect_bio` (TDD)

**Files:**
- Create: `src/lib/structure/bio/detect.ts`
- Test: `src/lib/structure/bio/detect.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/structure/bio/detect.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { detect_bio } from './detect'

const PROTEIN_PDB = `HEADER    OXYGEN TRANSPORT
SEQRES   1 A    3  VAL LEU SER
ATOM      1  N   VAL A   1      11.104  13.207  10.000  1.00 20.00           N
ATOM      2  CA  VAL A   1      12.560  13.100  10.100  1.00 20.00           C
ATOM      3  N   LEU A   2      13.000  14.000  10.200  1.00 20.00           N
ATOM      4  CA  SER A   3      14.000  15.000  10.300  1.00 20.00           C
END`

const NUCLEIC_PDB = `ATOM      1  P    DA A   1      11.000  13.000  10.000  1.00 20.00           P
ATOM      2  P    DT A   2      12.000  13.000  10.100  1.00 20.00           P
ATOM      3  P    DG A   3      13.000  14.000  10.200  1.00 20.00           P
END`

const LIGAND_PDB = `HETATM    1  C1  LIG A   1      11.000  13.000  10.000  1.00 20.00           C
HETATM    2  O1  LIG A   1      12.000  13.000  10.100  1.00 20.00           O
END`

const PROTEIN_MMCIF = `data_1ABC
loop_
_entity_poly.entity_id
_entity_poly.type
1 'polypeptide(L)'`

const CRYSTAL_CIF = `data_NaCl
_cell_length_a   5.64
_cell_length_b   5.64
_symmetry_space_group_name_H-M 'Fm-3m'
loop_
_atom_site_label
Na1 0 0 0`

describe('detect_bio', () => {
  it('flags a protein PDB (SEQRES + amino residues)', () => {
    const r = detect_bio(PROTEIN_PDB, 'prot.pdb')
    expect(r.isBio).toBe(true)
    expect(r.kind).toBe('protein')
    expect(r.format).toBe('pdb')
  })

  it('flags a nucleic-acid PDB', () => {
    const r = detect_bio(NUCLEIC_PDB, 'dna.pdb')
    expect(r.isBio).toBe(true)
    expect(r.kind).toBe('nucleic')
    expect(r.format).toBe('pdb')
  })

  it('does NOT flag a small-molecule/ligand-only PDB', () => {
    expect(detect_bio(LIGAND_PDB, 'lig.pdb').isBio).toBe(false)
  })

  it('flags a polypeptide mmCIF', () => {
    const r = detect_bio(PROTEIN_MMCIF, 'prot.cif')
    expect(r.isBio).toBe(true)
    expect(r.kind).toBe('protein')
    expect(r.format).toBe('mmcif')
  })

  it('does NOT flag a crystal CIF', () => {
    expect(detect_bio(CRYSTAL_CIF, 'nacl.cif').isBio).toBe(false)
  })

  it('does NOT flag a non-candidate extension (POSCAR)', () => {
    expect(detect_bio('Si\n1.0\n...', 'POSCAR').isBio).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `rtk proxy pnpm exec vitest run src/lib/structure/bio/detect.test.ts`
Expected: FAIL — `Cannot find module './detect'` (or `detect_bio is not a function`).

(Note: use `rtk proxy pnpm exec vitest` — RTK is known to serve stale `pnpm vitest` output in this project.)

- [ ] **Step 3: Implement `detect.ts`**

Create `src/lib/structure/bio/detect.ts`:

```ts
/**
 * Content sniffer: decide whether a file is a biological macromolecule
 * (protein / nucleic acid) that should render in Mol* rather than the native
 * viewer. Pure function — no I/O, fully unit-tested.
 *
 * Only PDB and (mm)CIF extensions are candidates; within those we sniff content
 * (heuristic B). Conservative: when ambiguous, return isBio:false so the file
 * falls through to the native pipeline (the user can still force Mol* via the
 * manual override).
 */

export type BioKind = 'protein' | 'nucleic' | 'mixed'
export type BioFormat = 'pdb' | 'mmcif'

export interface BioDetectResult {
  isBio: boolean
  kind: BioKind | null
  /** Mol* BuiltInTrajectoryFormat string to feed loadStructureFromData. */
  format: BioFormat | null
  /** Human-readable explanation (drives the override hint + debugging). */
  reason: string
}

const AMINO = new Set([
  'ALA', 'ARG', 'ASN', 'ASP', 'CYS', 'GLN', 'GLU', 'GLY', 'HIS', 'ILE',
  'LEU', 'LYS', 'MET', 'PHE', 'PRO', 'SER', 'THR', 'TRP', 'TYR', 'VAL',
  'SEC', 'PYL', 'MSE', 'HSD', 'HSE', 'HSP',
])
const NUCLEIC = new Set([
  'DA', 'DT', 'DG', 'DC', 'DU', 'A', 'U', 'G', 'C', 'I',
  'RA', 'RU', 'RG', 'RC',
])

function ext_of(filename: string): string {
  return filename.replace(/\.(gz|bz2|xz|zst)$/i, '').split('.').pop()?.toLowerCase() || ''
}

function not_bio(format: BioFormat | null, reason: string): BioDetectResult {
  return { isBio: false, kind: null, format: null, reason }
}

function bio(kind: BioKind, format: BioFormat, reason: string): BioDetectResult {
  return { isBio: true, kind, format, reason }
}

function detect_pdb(text: string): BioDetectResult {
  const amino_res = new Set<string>()
  const nucleic_res = new Set<string>()
  let has_seqres = false
  let has_helix_sheet = false

  for (const ln of text.split(/\r?\n/)) {
    const rec = ln.slice(0, 6).trim()
    if (rec === 'SEQRES') has_seqres = true
    if (rec === 'HELIX' || rec === 'SHEET') has_helix_sheet = true
    if (rec === 'ATOM' || rec === 'HETATM') {
      const res = ln.slice(17, 20).trim().toUpperCase()
      const res_key = ln.slice(21, 26) // chainID + resSeq
      if (AMINO.has(res)) amino_res.add(res_key)
      else if (NUCLEIC.has(res)) nucleic_res.add(res_key)
    }
  }

  const protein_like = has_seqres || has_helix_sheet || amino_res.size >= 3
  const nucleic_like = nucleic_res.size >= 2

  if (protein_like && nucleic_like) {
    return bio('mixed', 'pdb', 'protein + nucleic residues present')
  }
  if (protein_like) {
    const why = has_seqres
      ? 'SEQRES record present'
      : has_helix_sheet
      ? 'HELIX/SHEET record present'
      : `${amino_res.size} amino-acid residues`
    return bio('protein', 'pdb', why)
  }
  if (nucleic_like) return bio('nucleic', 'pdb', `${nucleic_res.size} nucleotide residues`)
  return not_bio('pdb', `no polymer markers (amino=${amino_res.size}, nucleic=${nucleic_res.size})`)
}

function detect_cif(text: string): BioDetectResult {
  const t = text.toLowerCase()
  const protein = t.includes('polypeptide')
  const nucleic = t.includes('polyribonucleotide') || t.includes('polydeoxyribonucleotide')
  const has_conf = t.includes('_struct_conf') || t.includes('_struct_sheet')

  if (protein && nucleic) return bio('mixed', 'mmcif', '_entity_poly: protein + nucleic')
  if (protein) return bio('protein', 'mmcif', '_entity_poly polypeptide')
  if (nucleic) return bio('nucleic', 'mmcif', '_entity_poly polynucleotide')
  if (has_conf) return bio('protein', 'mmcif', '_struct_conf/_struct_sheet present')
  return not_bio('mmcif', 'no _entity_poly polypeptide/nucleotide markers')
}

export function detect_bio(text: string, filename: string): BioDetectResult {
  const ext = ext_of(filename)
  if (ext === 'pdb' || ext === 'ent') return detect_pdb(text)
  if (ext === 'cif' || ext === 'mmcif' || ext === 'mcif') return detect_cif(text)
  return not_bio(null, `.${ext} is not a bio-candidate extension`)
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `rtk proxy pnpm exec vitest run src/lib/structure/bio/detect.test.ts`
Expected: PASS — 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/bio/detect.ts src/lib/structure/bio/detect.test.ts
git commit -m "feat(bio): content sniffer to route protein/nucleic files to Mol*"
```

---

## Task 3: `MolstarViewer.svelte` component

**Files:**
- Create: `src/lib/structure/bio/MolstarViewer.svelte`

This component owns the Mol\* lifecycle. It lazy-loads molstar (JS + CSS) inside
`onMount` so the multi-MB bundle is split out of the main chunk and only fetched
when a bio file is actually opened — mirroring the existing dynamic-import
patterns (`TerminalPanel.svelte` lazy-loads `@xterm`, `App.svelte` lazy-loads
`chgdiff-wasm`).

- [ ] **Step 1: Create the component**

Create `src/lib/structure/bio/MolstarViewer.svelte`:

```svelte
<script lang="ts">
  import { onDestroy, onMount } from 'svelte'

  let {
    content,
    format = `pdb`,
    label = `structure`,
  }: { content: string; format?: string; label?: string } = $props()

  let container = $state<HTMLDivElement>()
  let viewer: {
    dispose: () => void
    loadStructureFromData: (
      data: string,
      format: string,
      options?: { dataLabel?: string },
    ) => Promise<void>
  } | null = null
  let error = $state<string | null>(null)

  onMount(async () => {
    try {
      // Prebuilt CSS skin (plain CSS — no sass toolchain needed).
      await import(`molstar/build/viewer/molstar.css`)
      const { Viewer } = await import(`molstar/lib/apps/viewer/app`)
      if (!container) return
      viewer = await Viewer.create(container, {
        layoutIsExpanded: false,
        layoutShowControls: true,
        layoutShowSequence: true,
        layoutShowLog: false,
        layoutShowLeftPanel: true,
        viewportShowExpand: true,
        viewportShowSelectionMode: true,
      })
      await viewer.loadStructureFromData(content, format, { dataLabel: label })
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      console.error(`[MolstarViewer] failed to load:`, e)
    }
  })

  onDestroy(() => {
    viewer?.dispose()
    viewer = null
  })
</script>

<div class="molstar-pane" bind:this={container}>
  {#if error}
    <div class="molstar-error">Mol* failed to load: {error}</div>
  {/if}
</div>

<style>
  /* Mol*'s UI positions absolutely inside this box; it needs relative + size.
     Never display:none this pane on mobile — it zeroes the WebGL canvas
     (see CLAUDE.md iOS invariants). */
  .molstar-pane {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  .molstar-error {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 1rem;
    color: var(--error-color, #c0392b);
    font-size: 0.9rem;
    text-align: center;
  }
</style>
```

- [ ] **Step 2: Type-check**

Run: `pnpm check`
Expected: no new errors referencing `MolstarViewer.svelte`. (If `molstar/lib/apps/viewer/app` has no bundled types, the structural `viewer` type annotation above keeps `pnpm check` green without a `molstar.d.ts` shim. If `check` complains about the dynamic-import module path, add `// @ts-expect-error molstar ships no types for this entry` directly above the `import(\`molstar/lib/apps/viewer/app\`)` line.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/structure/bio/MolstarViewer.svelte
git commit -m "feat(bio): MolstarViewer component (lazy-loaded Mol* pane)"
```

---

## Task 4: `BioViewerToggle.svelte` override control

**Files:**
- Create: `src/lib/structure/bio/BioViewerToggle.svelte`
- Modify: `src/lib/i18n/en/structure.ts`, `src/lib/i18n/zh/structure.ts`

A small floating button that flips a pane between Mol\* and native. Rendered by
App.svelte (and mobile) only when the pane carries `bio_raw_content`, so it never
touches the heavy `Structure.svelte` internals.

- [ ] **Step 1: Add i18n strings (en)**

In `src/lib/i18n/en/structure.ts`, add to the exported `structure` record:

```ts
  bio_open_in_native: `Open in native viewer`,
  bio_open_in_molstar: `Open in Mol*`,
```

- [ ] **Step 2: Add i18n strings (zh) — keep key parity**

In `src/lib/i18n/zh/structure.ts`, add the SAME keys:

```ts
  bio_open_in_native: `用原生查看器打开`,
  bio_open_in_molstar: `在 Mol* 中打开`,
```

- [ ] **Step 3: Create the toggle component**

Create `src/lib/structure/bio/BioViewerToggle.svelte`:

```svelte
<script lang="ts">
  import { t } from '$lib/i18n/index.svelte'

  let {
    is_molstar,
    on_toggle,
  }: { is_molstar: boolean; on_toggle: () => void } = $props()
</script>

<button class="bio-toggle" onclick={on_toggle} type="button">
  {is_molstar ? t(`structure.bio_open_in_native`) : t(`structure.bio_open_in_molstar`)}
</button>

<style>
  .bio-toggle {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 20;
    padding: 4px 10px;
    font-size: 0.78rem;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 6px;
    background: var(--panel-bg, rgba(255, 255, 255, 0.9));
    color: var(--text-color, #222);
    cursor: pointer;
  }
  .bio-toggle:hover {
    background: var(--hover-bg, rgba(0, 0, 0, 0.06));
  }
</style>
```

- [ ] **Step 4: Verify i18n key parity**

Run:
```bash
rtk proxy pnpm exec vitest run -t i18n
```
Expected: PASS — if a parity test exists it stays green (en/zh key sets match). If no such test runs, instead confirm both files have the two new keys with:
```bash
grep -c "bio_open_in_native\|bio_open_in_molstar" src/lib/i18n/en/structure.ts src/lib/i18n/zh/structure.ts
```
Expected: each file reports `2`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/bio/BioViewerToggle.svelte src/lib/i18n/en/structure.ts src/lib/i18n/zh/structure.ts
git commit -m "feat(bio): viewer override toggle + i18n strings"
```

---

## Task 5: Extend pane / library types

**Files:**
- Modify: `desktop/pane-utils.ts:11-58`

- [ ] **Step 1: Add fields to `PaneState`**

In `desktop/pane-utils.ts`, inside `interface PaneState` (after `source_filename` at line 34), add:

```ts
  /** Which viewer renders this pane. Absent/'native' = Three.js viewer. */
  viewer_kind?: 'native' | 'molstar'
  /** Raw file text for Mol* (bio files bypass pymatgen parsing). */
  bio_raw_content?: string
  /** Mol* format string ('pdb' | 'mmcif') for loadStructureFromData. */
  bio_format?: string
```

- [ ] **Step 2: Add the same fields to `LibraryEntry`**

In the same file, inside `interface LibraryEntry` (after `raw_traj_format?` at line 57), add:

```ts
  viewer_kind?: 'native' | 'molstar'
  bio_raw_content?: string
  bio_format?: string
```

- [ ] **Step 3: Type-check**

Run: `pnpm check`
Expected: no new errors (fields are optional; existing code unaffected).

- [ ] **Step 4: Commit**

```bash
git add desktop/pane-utils.ts
git commit -m "feat(bio): pane/library fields for Mol* routing"
```

---

## Task 6: Route bio files through `ingest_one` + carry into the pane

**Files:**
- Modify: `desktop/App.svelte` (imports near line 16; `ingest_one` ~993; `apply_entry_to_pane` ~1027)

- [ ] **Step 1: Import the sniffer**

In `desktop/App.svelte`, near the other `$lib/structure` imports (around line 16), add:

```ts
  import { detect_bio } from '$lib/structure/bio/detect'
```

- [ ] **Step 2: Add the bio branch in `ingest_one`**

In `ingest_one`, immediately BEFORE the final `const parsed = parse_structure_file(text, filename)` (currently line 993), insert:

```ts
    // Biological macromolecule (protein / nucleic acid) → render in Mol*.
    // Bio files bypass pymatgen/ferrox entirely: handing Mol* the raw text
    // preserves residue/chain/secondary-structure and skips the (expensive,
    // metadata-lossy) native parse of large proteins.
    const bio = detect_bio(text, filename)
    if (bio.isBio && bio.format) {
      return {
        kind: `entry`,
        entry: {
          filename, source_path: null, format: ext, structure: undefined,
          trajectory: undefined, is_trajectory: false, cube_file: null,
          viewer_kind: `molstar`, bio_raw_content: text, bio_format: bio.format,
        },
      }
    }
```

- [ ] **Step 3: Carry the fields into the pane in `apply_entry_to_pane`**

In `apply_entry_to_pane`, find the trailing common assignments (after the `if/else if/else` structure block, around line 1035 where `p.selected_sites = []` begins) and add, right after `p.source_filename = e.filename` (line 1040):

```ts
    p.viewer_kind = e.viewer_kind ?? `native`
    p.bio_raw_content = e.bio_raw_content
    p.bio_format = e.bio_format
```

Also, at the TOP of `apply_entry_to_pane`, the existing branches set `p.structure`. For a molstar entry `e.structure` is `undefined`, so it falls into the final `else` branch and sets `p.structure = undefined` — correct (the molstar render branch does not need a parsed structure). No change needed there.

- [ ] **Step 4: Type-check**

Run: `pnpm check`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add desktop/App.svelte
git commit -m "feat(bio): route detected bio files to Mol* at ingest"
```

---

## Task 7: Desktop render branch + override wiring

**Files:**
- Modify: `desktop/App.svelte` (imports ~line 5; render switch ~1769)

- [ ] **Step 1: Import the new components**

Near the top component imports of `desktop/App.svelte` (the `import { Structure, Trajectory } from '$lib'` line is line 5), add:

```ts
  import MolstarViewer from '$lib/structure/bio/MolstarViewer.svelte'
  import BioViewerToggle from '$lib/structure/bio/BioViewerToggle.svelte'
```

- [ ] **Step 2: Add a helper to toggle a pane's viewer**

In the `<script>` block of `desktop/App.svelte` (near `apply_entry_to_pane`), add:

```ts
  /** Flip a pane between Mol* and the native viewer (manual override). */
  function toggle_pane_viewer(ts: StructureTabState, idx: number) {
    const p = ts.panes[idx]
    if (!p.bio_raw_content) return
    if (p.viewer_kind === `molstar`) {
      // → native: parse the raw text on demand (lazy; only when overridden).
      const parsed = parse_structure_file(p.bio_raw_content, p.source_filename || `bio`)
      if (parsed?.sites?.length) {
        p.structure = parsed
        p.initial_site_count = parsed.sites.length
        p.initial_structure_ref = parsed
      }
      p.viewer_kind = `native`
    } else {
      p.viewer_kind = `molstar`
    }
  }
```

- [ ] **Step 3: Insert the molstar render branch**

In the render switch, the chain currently is: trajectory branch → `{:else if pane.structure}` (line 1769) → `{:else}` landing. Insert a molstar branch BEFORE `{:else if pane.structure}` so a bio pane never falls into the native `Structure` branch.

Replace the line `{:else if pane.structure}` (1769) with:

```svelte
              {:else if pane.viewer_kind === `molstar` && pane.bio_raw_content}
                <div class="bio-pane-wrap">
                  <BioViewerToggle
                    is_molstar={true}
                    on_toggle={() => toggle_pane_viewer(ts, idx)}
                  />
                  {#key pane.bio_raw_content}
                    <MolstarViewer
                      content={pane.bio_raw_content}
                      format={pane.bio_format ?? `pdb`}
                      label={pane.source_filename ?? `structure`}
                    />
                  {/key}
                </div>
              {:else if pane.structure}
```

The `{#key pane.bio_raw_content}` remounts Mol\* when a different bio file lands
in the same pane (Mol\* loads once in `onMount`).

- [ ] **Step 4: Add the "back to Mol\*" override on the native branch**

So a user who overrode to native (or whose bio file they want re-opened in Mol\*) can switch back: inside the existing `{:else if pane.structure}` branch, wrap the `<Structure .../>` so the toggle shows when the pane has bio content. Immediately AFTER the opening of that branch and BEFORE `<Structure`, add:

```svelte
                {#if pane.bio_raw_content}
                  <BioViewerToggle
                    is_molstar={false}
                    on_toggle={() => toggle_pane_viewer(ts, idx)}
                  />
                {/if}
```

(The pane container is already `position: relative` for the existing layout; the toggle is absolutely positioned. If the toggle does not appear, confirm the immediate wrapper has `position: relative` and add it in Step 6 styling.)

- [ ] **Step 5: Add wrapper styling**

In the `<style>` block of `desktop/App.svelte`, add:

```css
  .bio-pane-wrap {
    position: relative;
    width: 100%;
    height: 100%;
  }
```

- [ ] **Step 6: Type-check**

Run: `pnpm check`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add desktop/App.svelte
git commit -m "feat(bio): desktop Mol* render branch + manual override toggle"
```

---

## Task 8: Mobile render branch

**Files:**
- Modify: `src/lib/mobile/MobileWorkspace.svelte`

- [ ] **Step 1: Locate the mobile structure mount**

Run:
```bash
grep -n "<Structure\|import Structure\|viewer_kind\|pane.structure" src/lib/mobile/MobileWorkspace.svelte
```
Expected: shows the `import Structure from '$lib/structure/Structure.svelte'` (~line 19) and the `<Structure ... />` mount site.

- [ ] **Step 2: Import MolstarViewer + toggle**

Near the existing `import Structure` line in `src/lib/mobile/MobileWorkspace.svelte`, add:

```ts
  import MolstarViewer from '$lib/structure/bio/MolstarViewer.svelte'
  import BioViewerToggle from '$lib/structure/bio/BioViewerToggle.svelte'
```

- [ ] **Step 3: Mirror the desktop branch**

At the `<Structure ... />` mount site, wrap it in the same conditional used on
desktop. The mobile workspace uses a single active pane (call its pane object
`pane` — match the variable the surrounding markup already uses). Add BEFORE the
`<Structure` mount:

```svelte
{#if pane.viewer_kind === `molstar` && pane.bio_raw_content}
  <div class="bio-pane-wrap">
    <BioViewerToggle is_molstar={true} on_toggle={() => /* mobile toggle handler */ toggle_mobile_viewer()} />
    {#key pane.bio_raw_content}
      <MolstarViewer content={pane.bio_raw_content} format={pane.bio_format ?? `pdb`} label={pane.source_filename ?? `structure`} />
    {/key}
  </div>
{:else}
  <!-- existing <Structure ... /> mount stays here, unchanged -->
{/if}
```

Implement `toggle_mobile_viewer()` to flip the active pane's `viewer_kind`
the same way `toggle_pane_viewer` does on desktop (parse `bio_raw_content` via
`parse_any_structure` — already imported in this file at ~line 22 — when
switching to native). Add `.bio-pane-wrap { position: relative; width: 100%; height: 100%; }` to the component `<style>`.

- [ ] **Step 4: Type-check**

Run: `pnpm check`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mobile/MobileWorkspace.svelte
git commit -m "feat(bio): mobile Mol* render branch"
```

---

## Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `rtk proxy pnpm exec vitest run`
Expected: PASS — the prior baseline (≈3872 tests / 142 files) plus the 6 new `detect_bio` tests, no regressions.

- [ ] **Step 2: Type-check the whole project**

Run: `pnpm check`
Expected: no new errors introduced by this branch.

- [ ] **Step 3: Desktop manual verification (agent-browser)**

Use the `verify` skill / agent-browser against the dev app (`pnpm desktop:serve`).
Fetch a real small protein PDB to disk first, e.g.:
```bash
curl -sL https://files.rcsb.org/download/1CRN.pdb -o /tmp/1crn.pdb
```
Then, in the running app: load `/tmp/1crn.pdb` (drag-drop or the file-open flow).

Verify:
- The pane renders the Mol\* UI (cartoon ribbon for crangin), not the native ball-and-stick viewer.
- The floating "Open in native viewer" toggle is visible; clicking it switches to the native Three.js viewer (ball-and-stick), and the toggle now reads "Open in Mol\*"; clicking again returns to Mol\*.
- Load a crystal file (`.cif`/POSCAR) and confirm it still opens in the **native** viewer (no regression, no Mol\* pane, no toggle).

- [ ] **Step 4: Mobile smoke test (on device, per iOS notes)**

Per `deploy/ios/LOCAL-TESTING-PROGRESS.md`, launch the iOS dev build
(`TAURI_DEV_HOST=<Mac LAN IP> pnpm tauri ios dev "<device>"`). Load a small PDB
and confirm Mol\* initializes (WebGL2) and renders without the WKWebView going
blank. Note any UI-cramping of Mol\*'s panels on the small screen as a known
follow-up (acceptable for v1).

- [ ] **Step 5: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to decide merge / PR.

---

## Self-Review notes (addressed)

- **Spec coverage:** sniffer (Task 2) = §Components.1 + heuristic B; MolstarViewer (Task 3) = §Components.2 + full Mol\* UI decision; routing (Tasks 6–7) = §Components.3 + data-flow (raw bytes bypass pymatgen); override toggle (Tasks 4,7) = decision C; mobile (Task 8) = §Mobile; testing (Task 9) = §Testing. HTTP/MCP path is explicitly Deferred in the spec — no task, by design.
- **Type consistency:** `viewer_kind`/`bio_raw_content`/`bio_format` names identical across `PaneState`, `LibraryEntry`, `ingest_one` entry, `apply_entry_to_pane`, and render branch. `detect_bio` returns `format: 'pdb'|'mmcif'` which is exactly what Mol\*'s `loadStructureFromData` accepts and what the pane stores in `bio_format`.
- **No placeholders:** every code step is concrete. The two grep-and-mirror steps (mobile Task 8, native-branch wrapper) reference exact files and give the full code to insert; the only deliberately open detail is the surrounding mobile pane variable name, which must match existing markup (cannot be hard-coded blind).
