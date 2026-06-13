# Plan: port TS structure parsers (inspired by acoord) to drop sidecar for more formats

## Goal

Let CatGo parse more DFT input/output formats **client-side in TypeScript**, so basic
structure viewing for those formats needs **no Python sidecar** — works locally, under
Remote-SSH (incl. `ui` kind), in the web build, and on mobile, with zero download.
Complements the `catgo.server.url` / `catgo.server.sidecarPath` escape hatches (PR #332):
common formats render with no backend; the sidecar stays only for heavy work
(trajectory indexing, DFT input generation, xTB).

Reference posture: `wxia529/acoord` (MIT) shows ~15 pure-TS parsers exist and which
formats/edge-cases matter. We **write our own parsers from the public file-format specs**
(QE/CASTEP/SIESTA/OpenMX/ORCA/Gaussian/VASP docs are open standards) — acoord is a
feature checklist, **not a code source**. Do not copy its code; original implementation
against the specs means no third-party attribution is owed.

## Non-goals

- **Do NOT support acoord's own `.acoord` format.** (Explicitly out of scope.)
- Do not copy acoord's Three.js renderer (`acoord-3d`) — CatGo's WASM renderer is better.
- Do not touch formats CatGo already parses in TS.

## Current state (what exists, don't redo)

TS parsers in `src/lib/structure/parsers/` dispatched by `dispatch.ts`
(`parse_structure_file(content, filename) -> ParsedStructure | null`):
CIF, POSCAR + vasprun.xml, XYZ/extXYZ, PDB, MOL2, LAMMPS data, CP2K (`.inp`/`.restart`),
phonopy YAML, JSON (OPTIMADE/PubChem/pymatgen).
Trajectories in `src/lib/trajectory/parsers/`: **XDATCAR already done** (`vasp.ts`),
plus ASE/HDF5/LAMMPS/XYZ/Gaussian/JSON.

Target type (`src/lib/structure/parsers/common.ts`):
```ts
interface ParsedStructure { sites: Site[]; lattice?: { matrix: Matrix3x3; a,b,c,alpha,beta,gamma,volume: number } }
```
Reuse existing helpers: `parseElement`/element utils, `normalize_scientific_notation`,
fractional→cartesian math in `$lib/math`.

## Scope — gap formats to add (acoord has, CatGo lacks)

| Format | Ext / filename | Type | Value | Notes / gotchas |
|---|---|---|---|---|
| QE input | `.in`, `pw.in`, `*.relax.in` | static | high | namelists `&system/&control`; `ATOMIC_POSITIONS {alat\|bohr\|angstrom\|crystal}`, `CELL_PARAMETERS`; unit convert. **ibrav≠0 needs lattice generation → Phase 3; start with ibrav=0 + explicit CELL_PARAMETERS** |
| OUTCAR | `OUTCAR*` (extensionless) | static (last) / multi | high | lattice from "direct lattice vectors", coords from "POSITION TOTAL-FORCE" blocks; elements from POTCAR `VRHFIN`/`ions per type`. Default = **last ionic step**; multi-frame → route to trajectory layer (Phase 2) |
| CASTEP cell | `.cell` | static | med | `%BLOCK LATTICE_CART`/`LATTICE_ABC`, `%BLOCK POSITIONS_FRAC`/`POSITIONS_ABS`, optional units line |
| SIESTA | `.fdf` | static | med | `LatticeConstant`, `%block LatticeVectors`, `AtomicCoordinatesAndAtomicSpecies`, `ChemicalSpeciesLabel` (species idx→element); coord scale flag |
| OpenMX | `.dat`/`.in` (content) | static | med | `Atoms.SpeciesAndCoordinates` + `Atoms.UnitVectors` blocks + unit keywords |
| ORCA input | `.inp` (collides w/ CP2K!) | static | med | `* xyz <charge> <mult> ... *` or `* xyzfile`; Cartesian Å. **Needs content disambiguation vs CP2K** |
| Gaussian input | `.gjf`, `.com` | static | med | `#` route, title, charge/mult, `El x y z` (Å). Cartesian first; redundant internal coords → later |
| ABACUS STRU | `STRU` (extensionless) | static | low-med | `LATTICE_CONSTANT`, `LATTICE_VECTORS`, `ATOMIC_POSITIONS` (Direct/Cartesian) |

## Dispatch changes (`dispatch.ts`) — the tricky part

1. **`.inp` is ambiguous** (CP2K vs ORCA). Add content sniff:
   - `&GLOBAL`/`&FORCE_EVAL`/`&` sections → CP2K (existing)
   - leading `!` keyword line or `* xyz`/`* xyzfile` → ORCA
2. **`.in` / `pw.in`** → QE (sniff `&control`/`&system`/`ATOMIC_POSITIONS` to be safe).
3. **Extensionless filenames** (like POSCAR today): `OUTCAR*`→OUTCAR, `STRU`→ABACUS.
4. `.cell`→CASTEP, `.fdf`→SIESTA, `.gjf`/`.com`→Gaussian.
5. Content fallback sniffs for each (when no/odd filename), ordered to avoid misfires.
6. Update `is_structure_file` / `STRUCTURE_EXTENSIONS_REGEX` in `$lib/constants` and the
   VS Code extension's `should_auto_render` + `package.json` language/`activationEvents`
   so these open/auto-render. Keep en/zh i18n in parity if any labels added.

## Per-parser contract

Each new file `src/lib/structure/parsers/<fmt>.ts`:
```ts
export function parse_<fmt>(content: string): ParsedStructure | null
```
- Return `null` on unrecognized content (let dispatch fall through), throw only on clearly
  corrupt input of a confirmed format.
- Convert all coords to Cartesian Å; fill `lattice` when periodic, omit for molecules.
- Written from the format spec; comment edge-cases by the spec rule, not by any source repo.

## Multi-frame (OUTCAR) integration

OUTCAR/relax/MD has many ionic steps. Phase 1: return last frame as a static
`ParsedStructure`. Phase 2: add `parse_vasp_outcar` to `trajectory/parsers/vasp.ts`
(sibling of `parse_vasp_xdatcar`) returning `TrajectoryType`, and route multi-step OUTCAR
there from the trajectory dispatch.

## Testing (mirror acoord)

- `vitest` unit test per parser with a small real fixture under
  `src/lib/structure/parsers/__tests__/` (or existing test dir): assert atom count,
  elements, lattice matrix, a couple of coords, and round-trip vs a known reference.
- Add a dispatch test for each new extension + the `.inp` CP2K-vs-ORCA disambiguation.
- `pnpm test` (vitest) is the real CI gate — keep these green.

## License

No attribution needed — parsers are original code written against public format specs,
not derived from acoord. (MIT only obliges a notice if you copy substantial code; we
don't.) No NOTICE/THIRD-PARTY entry, no per-file header.

## Phasing (each phase = one PR, vitest-gated)

- **Phase 1** (highest value, unambiguous): QE input (ibrav=0), CASTEP `.cell`,
  SIESTA `.fdf`, OUTCAR (last frame). Pure static, extension/filename detectable.
- **Phase 2**: OUTCAR multi-frame → trajectory; OpenMX; ORCA `.inp` (+ `.inp` sniff);
  Gaussian `.gjf`/`.com`.
- **Phase 3**: ABACUS `STRU`; QE `ibrav≠0` lattice generation; internal-coord Gaussian.

## Payoff

After Phase 1, these formats view with **zero backend** on remote/web/mobile — directly
shrinking the sidecar's required surface. Document in CLAUDE.md / the VS Code README that
static viewing of the supported formats no longer needs the Python server.
