# CatGO CLI — `freq --ir-spectrum` (Gaussian-broadened IR)

Slice E of the P3 backlog. Builds on Slice D (`feature/catgo-cli-hpc-submit`,
PR catgo-dev#4); stacked PR base = that branch.

## Goal

Extend the existing `catgo freq <OUTCAR>` op (P2) with a new optional
output: a Gaussian-broadened IR absorption spectrum computed from the
**real** (non-imaginary) modes parsed out of OUTCAR. Two artifacts:

1. A 2-column text dump `freq_cm intensity` (one row per ω-grid point),
   when `--ir-spectrum <path>` is given.
2. A SciencePlots-styled publication-grade PDF/PNG plot when
   `--ir-spectrum` is given and `<path>` ends in `.pdf`/`.png`/`.svg`
   (text-only when the path ends in `.dat`/`.txt`/`.csv` or has no
   recognized extension).

## Why this is its own slice

- Same input file as `freq` (a local OUTCAR); the parser already
  exists (`vib.parse_outcar_freqs`).
- The current `freq` op writes a TS imaginary-mode animation; that
  output is orthogonal — IR uses the *real* modes. Combining the two
  in one op keeps the user from re-parsing OUTCAR twice.
- Plotting reuses `plotting.PlotSpec` / `render` with `kind="ir"` —
  identical SciencePlots fallback, identical `--edit` / `--latex`
  treatment. The optional `[analyze]` extra already covers the deps.

## Intensities — design decision

VASP OUTCAR alone does NOT contain IR intensities. Two regimes:

1. **No Born effective charges available** → emit unit intensities
   (1.0 for every real mode). Document this clearly in the message
   (`"intensities=uniform 1.0 (no BEC parseable)"`). Spectrum is
   essentially a mode-count histogram broadened by `--ir-sigma`.

2. **OUTCAR contains LEPSILON Born effective charges**, parsed via a
   regex that targets the `BORN EFFECTIVE CHARGES (in e, cummulative
   output)` block (VASP writes this when LEPSILON=.TRUE.):

   ```
   BORN EFFECTIVE CHARGES (in e, cummulative output)
   ion    1
       1     2.34123  0.00000  0.00000
       2     0.00000  2.34123  0.00000
       3     0.00000  0.00000  1.91012
   ion    2
       1    -2.34123 ...
   ```

   For each real mode k with eigenvector e_k (per-atom Cartesian
   displacements normalized), intensity ∝ |Σ_a Z*_a · e_k(a)|² where
   Z*_a is the 3×3 BEC tensor for atom a (Cartesian basis assumed —
   matches the OUTCAR convention).

If LEPSILON IS present but malformed, fall back to uniform and warn
on stderr (don't silently lie about intensities).

## Spectrum construction

For each real mode k with frequency ω_k (cm⁻¹) and intensity I_k:

  S(ω) = Σ_k I_k · exp(−(ω − ω_k)² / (2σ²))

σ is `--ir-sigma` (default 10 cm⁻¹, common for ab-initio IR plots).
ω-grid runs from `--ir-emin` (default `max(0, min(ω)−4σ)`) to
`--ir-emax` (default `max(ω)+4σ`), step 1 cm⁻¹.

## CLI surface

New flags on the existing `freq` op (all optional; existing TS
animation behavior unchanged when `--ir-spectrum` is omitted):

```
--ir-spectrum <path>   write IR spectrum (text or plot by extension)
--ir-sigma <cm>        Gaussian width (default 10)
--ir-emin <cm>         spectrum lower bound (default auto)
--ir-emax <cm>         spectrum upper bound (default auto)
```

Underscore aliases auto-emitted by P3b C1 (`--ir_spectrum`, `--ir_sigma`,
`--ir_emin`, `--ir_emax`).

`--edit` honored when the output is a plot (same path as DOS / band /
COHP).

## Architecture

- `catgo.cli.ir` (new module): pure functions for parsing BEC + computing
  the spectrum. Side-effect-free, easily testable.
- `catgo.cli.ops_analyze.freq` (extend): after the Gibbs block, if
  `params.get("ir_spectrum")` is non-empty, build the spectrum and
  write it.
- `catgo.cli.plotting`: add `kind="ir"` — currently `_build_figure`
  ignores `kind` (it's a label hint), so the only practical change is
  documenting the new kind value. No code change needed there.

### `ir.py`

```python
@dataclass
class IrSpectrum:
    grid_cm: list[float]
    intensity: list[float]
    used_bec: bool          # True iff Born charges were parsed
    n_modes: int

def parse_born_charges(outcar_text: str, n_atoms: int
                       ) -> Optional[list[list[list[float]]]]:
    """Return BEC[a][i][j] (3x3 per atom) or None if missing/malformed."""

def compute_ir_spectrum(freqs_cm: list[float],
                        eigenvectors: list[list[list[float]]],
                        born: Optional[list[list[list[float]]]] | None,
                        emin: Optional[float], emax: Optional[float],
                        sigma: float = 10.0,
                        step_cm: float = 1.0) -> IrSpectrum:
    ...
```

### `ops_analyze.freq` extension

After the Gibbs block, before the final OpResult assembly:

```python
ir_out = params.get("ir_spectrum")
if ir_out:
    from catgo.cli.ir import (parse_born_charges, compute_ir_spectrum,
                              write_ir_text, write_ir_plot)
    text = Path(src).read_text(errors="ignore")
    born = parse_born_charges(text, data.total_atoms)
    spec = compute_ir_spectrum(
        data.real_freqs_cm, data.eigenvectors_for_real(),
        born, params.get("ir_emin"), params.get("ir_emax"),
        float(params.get("ir_sigma", 10.0)))
    if Path(ir_out).suffix.lower() in (".pdf", ".png", ".svg"):
        write_ir_plot(spec, ir_out, bool(params.get("edit")),
                      bool(params.get("latex")))
    else:
        write_ir_text(spec, ir_out)
    ir_note = ("  (IR spec: " +
               f"{spec.n_modes} modes, "
               f"{'BEC' if spec.used_bec else 'uniform'} → {ir_out})")
    # appended to existing freq message
```

`data.eigenvectors_for_real()` is a small new method on `FreqData`
that returns only the eigenvectors corresponding to real modes,
indexed by their position in `real_freqs_cm`. Today `eigenvectors`
mixes real and imaginary in OUTCAR order; the IR computation
explicitly needs the real-only view. (Don't slice by
`len(real_freqs_cm)` — `imag_mode_indices` already exists for the
same reason; mirror that pattern.)

## Tests

```
server/tests/cli/test_ir.py
    test_parse_born_charges_minimal         # 2-atom synthetic
    test_parse_born_charges_missing_returns_none
    test_parse_born_charges_malformed_returns_none
    test_compute_ir_spectrum_uniform        # 3 modes, no BEC; 3 peaks
    test_compute_ir_spectrum_with_bec       # 2 modes, distinct BECs;
                                            # heavier atom gives higher peak
    test_write_ir_text_2col
    test_freqdata_eigenvectors_for_real     # parser-level helper

server/tests/cli/test_ops_analyze.py (extend)
    test_freq_ir_spectrum_text_output       # --ir-spectrum out.dat
                                            # 2 columns, peaks at f
    test_freq_ir_spectrum_plot_output       # --ir-spectrum out.pdf
                                            # monkeypatched plt.savefig
    test_freq_ir_spectrum_uniform_when_no_bec
    test_freq_no_ir_spectrum_no_change      # baseline still works
    test_freq_ir_with_imaginary_modes_excluded

server/tests/cli/test_argparse.py (extend)
    test_freq_ir_dash_flag_parses           # --ir-spectrum etc.
```

## Out of scope

- Anharmonic / Raman / VCD / SFG / IR + ATR — separate analysis class.
- Multiple OUTCAR aggregation (only one file at a time, matches the
  rest of the analyze group).
- Force-constant DFPT outputs (LDIPOL etc.) — not needed for the
  simple BEC × eigenvector model.
- High-throughput temperature-dependent spectra.

## Autonomous design decisions

1. **Default σ = 10 cm⁻¹** — common value for ab-initio IR plots
   (e.g. PHONOPY, ASE). Live-tunable via `--ir-sigma`.
2. **Default grid step = 1 cm⁻¹** — not configurable in P3 (the
   registry has no Param surface for "internal numerics"); ω-grid
   span comes from data ±4σ. Adds at most a few thousand points,
   trivial in size.
3. **Output format keyed by extension** — `.pdf`/`.png`/`.svg` →
   plot; otherwise → 2-column text. Mirrors how `band/dos/cohp`
   already infer plot vs. dump by usage pattern (their `dump` is a
   separate flag — but `freq` already has `dump` for the Gibbs JSON,
   so we keep `--ir-spectrum` single-flag and dispatch by extension).
4. **BEC parsing is best-effort** — present and well-formed → use
   it; present and malformed → warn + uniform fallback; absent →
   uniform. Document in the result message which path fired.
5. **Imaginary modes are excluded** from the IR spectrum — physically
   meaningless above the TS, and IR experiments don't measure them.
6. **`--edit` only triggers GUI for plot outputs** (text dump opens
   no figure to edit).
7. **Reusing PlotSpec + render** instead of inlining matplotlib —
   shares the SciencePlots/pylustrator stack with DOS/band/COHP and
   the [analyze]-extra error message.
