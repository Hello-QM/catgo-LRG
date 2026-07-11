# CP2K Frequency Analysis — Design

**Date:** 2026-07-11
**Status:** Approved (approach A ratified by user)

## Goal

CatGo's frequency analysis (FreqAnalysisPane: frequency table, imaginary-mode
flags, normal-mode animation, Gibbs/ZPE correction at a user-given temperature)
currently only parses VASP OUTCAR. CatGo users run CP2K `VIBRATIONAL_ANALYSIS`
jobs and want the same analysis for those outputs, plus an IR spectrum (CP2K
provides IR intensities; VASP OUTCAR does not).

## Inputs (decided)

Sample data: `/home/james0001/Downloads/freq` — a 169-atom La-Cu-oxide surface
with a CO-NH₂ adsorbate, partial Hessian (only the 5 adsorbate atoms displaced,
15 modes). Representative of the target use case (electrocatalysis adsorbate
frequencies).

Priority order:

1. **Molden `.mol`** (e.g. `*-VIBRATIONS-1.mol`) — primary. Contains everything:
   - `[Atoms] AU` / `[FR-COORD]` — element symbols + coordinates in **Bohr**
     (convert to Å, ×0.52917721)
   - `[FREQ]` — frequencies in cm⁻¹; **negative value ⇒ imaginary mode**
   - `[FR-NORM-COORD]` — `vibration N` blocks, one 3-vector per atom,
     full-length (frozen atoms are all-zero) ⇒ animation works for partial
     Hessians as-is
   - `[INT]` — IR intensities in KM/mol
2. **Main output `.out`** (`GLOBAL| Run type VIBRATIONAL_ANALYSIS`) — fallback.
   `VIB|Frequency (cm^-1)` rows (3 per line) + `VIB|IR int (KM/Mole)` rows.
   Intensity fields can be Fortran overflow stars (`************`) → parse as
   missing (None), never crash. No coordinates / eigenvectors extracted from
   `.out` (frequency table + Gibbs only, no animation).
3. Binary `.eig` / `.hess` — **out of scope**.

## Decisions (ratified)

- Entry points: **upload + remote from-directory + MCP** (all three).
- Feature scope: parity with VASP (table / imaginary flags / animation /
  Gibbs@T) **plus IR spectrum plot** (Gaussian-broadened) when intensities
  are present.
- Implementation: **approach A** — backend parser extension, no new Python
  dependencies (hand-rolled Molden text parse, ~80 lines). Rejected: frontend
  TS parser (logic would be duplicated for remote/MCP), cclib/ASE dependency
  (packaging risk, ASE has no Molden-vibration reader).

## Architecture

### New module `server/catgo/services/cp2k_freq.py`

Two pure functions, no FastAPI imports:

- `parse_molden_vibrations(text: str) -> dict`
  Returns frequencies (cm⁻¹, signed), elements, positions (Å),
  eigenvectors `[n_modes][n_atoms][3]`, intensities (KM/mol, optional).
- `parse_cp2k_out_vibrations(text: str) -> dict`
  Returns frequencies + best-effort intensities (None on overflow); no
  positions/eigenvectors.

### Router changes `server/catgo/routers/freq_analysis.py`

- `/upload` and `/from-directory` gain **content sniffing**:
  - `[Molden Format]` → Molden parser
  - `VIB|` → CP2K `.out` parser
  - otherwise → existing OUTCAR parser (unchanged)
- Response stays the existing `VaspFrequencyData` shape (real_freqs,
  imag_freqs, eigenvectors, positions) with new optional fields:
  `intensities_km_mol: list[float | None] | None`, `source_format:
  "outcar" | "cp2k-molden" | "cp2k-out"`.
- `from-directory` file discovery priority: `*VIBRATIONS*.mol` → `OUTCAR` →
  `*.out` containing `VIB|`.
- New endpoint `POST /freq-analysis/ir-spectrum`: `{freqs_cm, intensities,
  fwhm_cm, x_min?, x_max?, n_points?}` → `{x_cm, y}`. Broadening algorithm
  reused from `server/catgo/cli/ir.py` (extract shared helper; CLI keeps
  working).

### Frontend `src/lib/electronic/FreqAnalysisPane.svelte`

- Upload accept list gains `.mol`, `.out` (and keeps OUTCAR). No data-shape
  changes — table/flags/animation/Gibbs work as-is.
- When `intensities_km_mol` has any non-null values, show an "IR spectrum"
  section: FWHM input + line plot (reuse the existing DOS-pane line-plot
  component + PNG/DPI export), data from `/freq-analysis/ir-spectrum`.

### MCP

The existing freq-analysis action in the consolidated registry accepts the
same files; format sniffing happens in the shared router/service code, so MCP
gets CP2K support with no new tool surface.

## Error handling

- Molden missing `[FR-NORM-COORD]` or `[FR-COORD]` → degrade to
  frequency-table-only result (no animation), not an error.
- `.out` without `VIB|` → explicit error "not a CP2K vibrational analysis
  output".
- Eigenvector atom count ≠ position atom count → drop eigenvectors (no
  animation), keep frequencies.
- Overflowed IR intensities (`************`) → None for that mode; spectrum
  endpoint skips None entries.
- Partial Hessian is the normal case, not an edge case (full-length zero-padded
  eigenvectors).

## Testing

- **pytest**: fixtures cut from the sample set (truncated `.mol` with 2–3
  modes + a `.out` fragment including an overflow-stars intensity row).
  Cover: mode/atom counts, Bohr→Å conversion, negative-frequency → imaginary
  classification, overflow → None, missing-section degradation, sniffing
  dispatch (Molden vs `.out` vs OUTCAR), ir-spectrum endpoint values.
- **vitest**: none required (pane logic unchanged except conditional IR
  section; covered by existing pane tests).
- **Manual E2E**: full 169-atom sample through upload → animation → Gibbs at
  298.15 K → IR spectrum; remote from-directory against an HPC dir; MCP call.
