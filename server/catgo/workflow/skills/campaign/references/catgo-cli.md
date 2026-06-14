# catgo CLI — use during a campaign

> **TL;DR:** During an md-orchestration campaign, use the existing `catgo` CLI to
> build structures and analyze results. `catgo <op>` runs offline (no viewer
> needed for build/convert/analyze). Render inputs into the calc folder, then
> `submit_calc.py`; after a job finishes, analyze its outputs into `result.md`.

## Build / prepare structure (writes into the calc folder)

- `catgo slab --miller 1,1,1 --layers 4 --vacuum 15` — bulk -> surface slab.
- `catgo supercell --scaling 2,2,1` — integer supercell.
- `catgo reticular --preset mof-5` — MOF/COF from topology + building blocks.
- `catgo convert --out POSCAR` — write the active structure to another format
  (extension picks the format).
- `catgo inspect` — composition / symmetry / nearest-neighbor sanity check.

## Analyze results (after a job finishes; feed values into result.md)

- `catgo dos --atoms all --channels spd` — `vaspout.h5` -> PDOS plot + d-band center.
- `catgo band` — `vasprun.xml` -> band structure + gap.
- `catgo cohp` — `COHPCAR.lobster` -> -pCOHP + ICOHP.
- `catgo freq --mode adsorbed --T 298.15` — `OUTCAR` -> Gibbs correction
  (ZPE + TS) + imaginary-mode animation. This gives the gibbs/ΔG terms you write
  into `result.md` for the volcano.

## How it fits the loop

1. Build/prepare -> rendered `INCAR`/`POSCAR`/`KPOINTS` land in the calc folder.
2. Input-file gate (show the user) -> `submit_calc.py`.
3. Job done (`poll.py` marks DONE) -> pull outputs / run `catgo freq` etc. ->
   write the numbers into the calc's `result.md`.
4. `aggregate.py` rolls every `result.md` into `analysis/` (ranking / volcano /
   funnel); `make_report.py` drafts the report.

Run these from the calc folder (or pass paths). They are offline and do not need
the `:8000` viewer for build/convert/analyze.
