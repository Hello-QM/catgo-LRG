# Plan: freq --ir-spectrum (Slice E)

Spec: `docs/superpowers/specs/2026-05-19-catgo-cli-ir-spectrum-design.md`.
Branch: `feature/catgo-cli-ir-spectrum` (base = `feature/catgo-cli-hpc-submit`).

Each task: failing test → impl → green → commit.

## Task E1 — `FreqData.eigenvectors_for_real()`

Test: `test_vib.py::test_eigenvectors_for_real_method` — using the
existing `_OUTCAR` fixture, `parse_outcar_freqs(p).eigenvectors_for_real()`
returns a list of length `len(real_freqs_cm)`, in OUTCAR order,
excluding any eigenvector that appears in `imag_mode_indices`.
Test the dedup'd `_OUTCAR_DEDUP` too: 3 modes in → 3 eigenvectors out.

Impl: small method on `FreqData`:

```python
def eigenvectors_for_real(self) -> list:
    imag = set(self.imag_mode_indices)
    return [v for k, v in enumerate(self.eigenvectors) if k not in imag]
```

Commit: `feat(cli): FreqData.eigenvectors_for_real() helper [E1]`

## Task E2 — `parse_born_charges`

Test: `test_ir.py::test_parse_born_charges_minimal` — feed a 2-atom
synthetic OUTCAR snippet with a clean BEC block; assert returned
shape == `[2][3][3]` and values match.
Test: `test_parse_born_charges_missing_returns_none` — string without
`BORN EFFECTIVE CHARGES` → None.
Test: `test_parse_born_charges_truncated_returns_none` — block missing
rows → None (NOT a silent zero).

Impl: `catgo/cli/ir.py`:

```python
_BORN_HDR = "BORN EFFECTIVE CHARGES"
def parse_born_charges(text: str, n_atoms: int):
    idx = text.find(_BORN_HDR)
    if idx == -1: return None
    lines = text[idx:].splitlines()
    out = []
    cur = 0
    while cur < len(lines):
        if not lines[cur].lstrip().startswith("ion"):
            cur += 1
            continue
        rows = []
        for j in range(cur+1, cur+4):
            parts = lines[j].split()
            if len(parts) < 4: return None
            rows.append([float(x) for x in parts[1:4]])
        out.append(rows)
        if len(out) == n_atoms: break
        cur += 4
    return out if len(out) == n_atoms else None
```

Commit: `feat(cli): IR Born-effective-charge parser [E2]`

## Task E3 — `compute_ir_spectrum` (uniform branch)

Test: `test_compute_ir_spectrum_uniform` — 3 modes at 100/200/300 cm⁻¹,
eigenvectors any, `born=None`, σ=10, default range → grid covers all
three with 1 cm⁻¹ step; spectrum has 3 local maxima near 100/200/300.

Impl: stdlib + math (no numpy required):

```python
def compute_ir_spectrum(freqs_cm, eigenvectors, born, emin, emax,
                        sigma=10.0, step_cm=1.0):
    if not freqs_cm:
        return IrSpectrum([], [], used_bec=False, n_modes=0)
    used_bec = born is not None
    intensities = (_bec_intensities(eigenvectors, born) if used_bec
                   else [1.0] * len(freqs_cm))
    lo = emin if emin is not None else max(0.0, min(freqs_cm) - 4*sigma)
    hi = emax if emax is not None else max(freqs_cm) + 4*sigma
    grid = [lo + i*step_cm for i in range(int((hi-lo)/step_cm) + 1)]
    two_s_sq = 2 * sigma * sigma
    spec = [sum(I * math.exp(-(w-f)**2 / two_s_sq)
                for f, I in zip(freqs_cm, intensities))
            for w in grid]
    return IrSpectrum(grid, spec, used_bec=used_bec,
                      n_modes=len(freqs_cm))
```

Commit: `feat(cli): IR spectrum computation (uniform branch) [E3]`

## Task E4 — `_bec_intensities` + BEC branch

Test: `test_compute_ir_spectrum_with_bec` — 2 modes, same eigenvectors
in shape but different BEC magnitudes for the two atoms; assert the
peak corresponding to the heavier-BEC atom is taller.

Impl: `_bec_intensities(eigenvectors, born)` computes
`I_k = sum_j ( sum_a sum_i born[a][i][j] * e_k[a][i] )^2`
over Cartesian indices i,j and atoms a.

Commit: `feat(cli): BEC-weighted IR intensities [E4]`

## Task E5 — `write_ir_text` (2-column)

Test: `test_write_ir_text_2col` — given a 3-point spectrum, the file
has 3 lines `freq intensity` with whitespace separator; round-trip
parses back to the same numbers.

Impl: simple `"\n".join(f"{w:.6f} {y:.6f}" ...)`.

Commit: `feat(cli): IR spectrum 2-column text writer [E5]`

## Task E6 — `write_ir_plot`

Test: `test_write_ir_plot_calls_render` — monkeypatch
`catgo.cli.plotting.render` to capture the PlotSpec; assert
`spec.kind == "ir"`, `spec.x` matches the IR grid, exactly one series,
xlabel "wavenumber (cm$^{-1}$)" or similar, ylabel "intensity (arb.)".

Impl:

```python
def write_ir_plot(spec, out, edit=False, latex=False):
    from catgo.cli.plotting import PlotSpec, render
    plot_spec = PlotSpec(
        kind="ir", x=spec.grid_cm,
        series=[("IR", spec.intensity, {})],
        xlabel=r"wavenumber (cm$^{-1}$)",
        ylabel="intensity (arb.)")
    return render(plot_spec, out, edit, latex)
```

Commit: `feat(cli): IR spectrum plot writer (reuses PlotSpec) [E6]`

## Task E7 — `freq --ir-spectrum` wiring + extension keyed dispatch

Test: `test_freq_ir_spectrum_text_output` — pass a synthetic OUTCAR
with 3 real modes, `params["ir_spectrum"] = "out.dat"`, `no_anim=True`;
assert `out.dat` exists, has > 3 lines, freq column values match the
parsed modes within σ.
Test: `test_freq_ir_spectrum_plot_output` — `"out.pdf"`; monkeypatch
`catgo.cli.plotting.render` to assert called with `kind=="ir"` and
the output path.
Test: `test_freq_ir_uniform_when_no_bec` — message includes
`"uniform"` (no BEC in the fixture).
Test: `test_freq_no_ir_spectrum_no_change` — without `--ir-spectrum`
the result message contains `G_corr=` and no IR mention.
Test: `test_freq_ir_with_imag_warns_excluded` — fixture has 1 imag,
1 real; IR uses only the real one; message mentions excluded imag.

Impl: insert the block described in the spec into `ops_analyze.freq`,
guarded by `params.get("ir_spectrum")`. Wire the extension-based
dispatch.

Commit: `feat(cli): freq --ir-spectrum wired into the analyze op [E7]`

## Task E8 — registry + dash-flag aliases

Test: `test_argparse.py::test_freq_ir_dash_flag_parses` — passing
`--ir-spectrum`, `--ir-sigma`, `--ir-emin`, `--ir-emax` parses
without error; resulting args carry `ir_spectrum/ir_sigma/...`
attributes.

Impl: add four new `Param`s to the `freq` op in `ops.py`:

```python
Param("ir_spectrum", str, default="", help="write IR spectrum (.dat/.pdf)"),
Param("ir_sigma", float, default=10.0, help="Gaussian width (cm-1)"),
Param("ir_emin", float, default=-1.0, help="ω lower bound (cm-1); <0 = auto"),
Param("ir_emax", float, default=-1.0, help="ω upper bound (cm-1); <0 = auto"),
```

Note: registry has no "optional float with no default" — use sentinel
`-1.0` and translate to `None` in the handler. This avoids changing
the Param surface (P1 backlog item, deferred).

Commit: `feat(cli): register freq --ir-spectrum params + dash aliases [E8]`

## Task E9 — full suite green + self-review

`python -m pytest tests/cli/ -q` → 141 → ~150 passed, 3 skipped.

Run a manual smoke against a real OUTCAR (or synthetic) end-to-end
through the subprocess `[python, -m, catgo, freq, ...]` path to
confirm the argparse layer parses the new flags.

Commit: `chore(cli): suite green for slice E`

## Order

E1 → E2 → E3 → E4 → E5 → E6 → E7 → E8 → E9.

Each commit standalone.

## Open items deferred

- Force-constant-based IR (LDIPOL workflow).
- Raman spectrum (needs polarizability derivatives, not in any
  current router).
