# CatGO Campaign md-orchestration — P2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the P2 layer on top of the campaign MVP: cross-calc **analysis aggregation** (ranking / volcano / funnel), **report generation**, **MinerU literature ingestion + literature→skill**, and a **catgo-CLI reference skill** so the campaign agent uses the existing `catgo` CLI (build / convert / analyze) during a campaign.

**Architecture:** New modules beside the MVP under `server/catgo/workflow/skills/campaign/scripts/`: `campaign_analysis.py` (aggregation + volcano plot), `campaign_report.py` (report draft), `campaign_lit.py` (literature ingest). A small `result.md` parser is added to `campaign_lib.py` (the per-calc results format both aggregation and reports read). Thin entrypoints `aggregate.py` / `make_report.py` / `ingest_lit.py`. A reference doc `references/catgo-cli.md` + SKILL.md wiring. All stdlib + matplotlib (already in the catgo env); MinerU is invoked via the mockable `campaign_lib._run` seam and degrades gracefully when absent.

**Tech Stack:** Python 3.11, stdlib + matplotlib (Agg). pytest for dev verification. No new hard deps (MinerU optional).

**Spec:** `docs/superpowers/specs/2026-06-06-catgo-campaign-md-orchestration-design.md` (P2 phasing).
**Builds on:** the MVP plan `2026-06-06-catgo-campaign-md-orchestration-mvp.md` (campaign_lib + scaffold + submit/poll already shipped on this branch).

**Conventions / gotchas:**
- catgo python: `/home/james0001/miniforge3/envs/catgo/bin/python`.
- Run tests from the scripts dir: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest <file> -v`.
- Do NOT push (user keeps this for a private repo). Do NOT touch the shared `:8000` backend. Do NOT `deno fmt` (`.md` excluded anyway; Python untouched by deno fmt).
- **`result.md` format** (the contract): a progressive-md header + `key: value` lines with numeric values, e.g.
  ```
  # result: Pt1-Cu_SAA
  > **TL;DR:** E_form=-0.42 eV, dG_H=0.08 eV

  energy: -123.456
  E_form: -0.42
  dG_H: 0.08
  ```

---

### Task 1: `campaign_lib.py` — result.md parse/render

**Files:**
- Modify: `server/catgo/workflow/skills/campaign/scripts/campaign_lib.py` (append)
- Test: `server/catgo/workflow/skills/campaign/scripts/test_campaign_lib.py` (append)

- [ ] **Step 1: Write the failing test** — append to `test_campaign_lib.py`:

```python
# ---- result.md (P2) ----

def test_result_render_then_parse_coerces_numbers():
    text = cl.render_result("Pt1-Cu_SAA", {"energy": -123.456, "E_form": -0.42,
                                           "dG_H": 0.08})
    assert text.lstrip().startswith("# result: Pt1-Cu_SAA")
    assert "**TL;DR:**" in text
    v = cl.parse_result(text)
    assert v["E_form"] == -0.42 and v["dG_H"] == 0.08
    assert isinstance(v["energy"], float)


def test_result_parse_keeps_non_numeric_as_string_and_skips_header():
    text = ("# result: x\n> **TL;DR:** whatever\n\n"
            "energy: -1.0\nnote: converged in 42 steps\n")
    v = cl.parse_result(text)
    assert v["energy"] == -1.0
    assert v["note"] == "converged in 42 steps"   # non-numeric stays string
    assert "result" not in v                        # title line not captured
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_campaign_lib.py -k result -v`
Expected: FAIL with `AttributeError: module 'campaign_lib' has no attribute 'render_result'`

- [ ] **Step 3: Write minimal implementation** — append to `campaign_lib.py`:

```python
# ================================ result.md ================================

def render_result(name: str, values: dict, tldr: str = "") -> str:
    summary = tldr or ", ".join(f"{k}={v}" for k, v in values.items()) or "no values"
    lines = [tldr_header(f"result: {name}", summary), ""]
    lines += [f"{k}: {v}" for k, v in values.items()]
    return "\n".join(lines) + "\n"


def parse_result(text: str) -> dict:
    """Parse a result.md's ``key: value`` lines; coerce numbers to float."""
    out: dict = {}
    for raw in text.splitlines():
        line = raw.strip()
        if ":" not in line or line.startswith("#") or line.startswith(">"):
            continue
        key, _, val = line.partition(":")
        key, val = key.strip(), val.strip()
        if not key:
            continue
        try:
            out[key] = float(val)
        except ValueError:
            out[key] = val
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_campaign_lib.py -v`
Expected: PASS (existing 23 + 2 new = 25)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/skills/campaign/scripts/campaign_lib.py \
        server/catgo/workflow/skills/campaign/scripts/test_campaign_lib.py
git commit -m "feat(campaign): result.md render/parse (P2 aggregation contract)"
```

---

### Task 2: `campaign_analysis.py` — collect + ranking + volcano CSV + funnel

**Files:**
- Create: `server/catgo/workflow/skills/campaign/scripts/campaign_analysis.py`
- Test: `server/catgo/workflow/skills/campaign/scripts/test_campaign_analysis.py`

- [ ] **Step 1: Write the failing test** — create `test_campaign_analysis.py`:

```python
"""campaign_analysis — cross-calc aggregation (ranking / volcano / funnel)."""
import campaign_lib as cl
import campaign_analysis as ca


def _project_with_results(tmp_path):
    root = cl.scaffold_project(tmp_path / "SAA-HER", "SAA HER", template="saa_her")
    data = {
        "Pt1-Cu_SAA": {"E_form": -0.42, "dG_H": 0.08},
        "Ni1-Cu_SAA": {"E_form": -0.10, "dG_H": -0.30},
        "Au1-Cu_SAA": {"E_form": 0.25, "dG_H": 0.02},   # unstable (E_form > 0)
    }
    for name, vals in data.items():
        d = root / "calc" / "01-stability-formation-energy" / name
        d.mkdir(parents=True)
        (d / "result.md").write_text(cl.render_result(name, vals))
    return root


def test_collect_results_reads_all_with_stage_and_name(tmp_path):
    root = _project_with_results(tmp_path)
    results = ca.collect_results(str(root))
    assert len(results) == 3
    names = {r["name"] for r in results}
    assert names == {"Pt1-Cu_SAA", "Ni1-Cu_SAA", "Au1-Cu_SAA"}
    assert all(r["stage"] == "01-stability-formation-energy" for r in results)
    pt = next(r for r in results if r["name"] == "Pt1-Cu_SAA")
    assert pt["values"]["E_form"] == -0.42


def test_rank_formation_energy_sorts_most_stable_first(tmp_path):
    root = _project_with_results(tmp_path)
    md, csv = ca.rank_formation_energy(ca.collect_results(str(root)))
    # most negative E_form ranked first
    assert md.index("Pt1-Cu_SAA") < md.index("Ni1-Cu_SAA") < md.index("Au1-Cu_SAA")
    assert csv.startswith("rank,candidate,E_form")
    assert "1,Pt1-Cu_SAA" in csv


def test_volcano_csv_sorted_by_abs_dG(tmp_path):
    root = _project_with_results(tmp_path)
    csv = ca.volcano_csv(ca.collect_results(str(root)))
    assert csv.startswith("candidate,dG_H,abs_dG_H")
    body = csv.strip().splitlines()[1:]
    # Au (|0.02|) before Pt (|0.08|) before Ni (|0.30|)
    assert body[0].startswith("Au1-Cu_SAA")
    assert body[-1].startswith("Ni1-Cu_SAA")


def test_funnel_counts_survivors(tmp_path):
    root = _project_with_results(tmp_path)
    md = ca.funnel_md(ca.collect_results(str(root)), eform_threshold=0.0, top=2)
    assert "3 candidates" in md
    # only Pt and Ni have E_form < 0
    assert "2" in md and "Pt1-Cu_SAA" in md and "Ni1-Cu_SAA" in md
    assert "Au1-Cu_SAA" not in md.split("survivors")[1].split("stage 2")[0]


def test_write_aggregates_creates_files(tmp_path):
    root = _project_with_results(tmp_path)
    info = ca.write_aggregates(str(root), eform_threshold=0.0, top=2)
    assert info["n_results"] == 3
    adir = root / "analysis"
    for f in ("formation_energy_ranking.md", "formation_energy_ranking.csv",
              "volcano.csv", "funnel.md"):
        assert (adir / f).is_file(), f"missing {f}"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_campaign_analysis.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'campaign_analysis'`

- [ ] **Step 3: Write minimal implementation** — create `campaign_analysis.py`:

```python
"""Cross-calc aggregation for a campaign: ranking, volcano, funnel.

Reads every ``calc/**/result.md`` (the per-calc results contract) and writes
human-readable summaries into ``analysis/``. This is the campaign-level view the
DB-only engine made hard to see.
"""
from __future__ import annotations

from pathlib import Path

import campaign_lib as cl


def collect_results(project) -> list[dict]:
    proj = Path(project).expanduser()
    out: list[dict] = []
    for rf in sorted(proj.glob("calc/**/result.md")):
        rel = rf.relative_to(proj).parts            # calc/<stage>/<name>/result.md
        stage = rel[1] if len(rel) >= 3 else ""
        out.append({"name": rf.parent.name, "stage": stage,
                    "values": cl.parse_result(rf.read_text())})
    return out


def _numeric(results, key):
    return [(r["name"], r["values"][key]) for r in results
            if isinstance(r["values"].get(key), (int, float))]


def rank_formation_energy(results, key: str = "E_form") -> tuple[str, str]:
    rows = sorted(_numeric(results, key), key=lambda t: t[1])
    md = [cl.tldr_header("formation-energy ranking",
                         f"{len(rows)} candidates, most stable first"), "",
          "| rank | candidate | E_form (eV) |", "|---|---|---|"]
    md += [f"| {i} | {n} | {e:.3f} |" for i, (n, e) in enumerate(rows, 1)]
    csv = "rank,candidate,E_form\n" + "".join(
        f"{i},{n},{e}\n" for i, (n, e) in enumerate(rows, 1))
    return "\n".join(md) + "\n", csv


def volcano_csv(results, key: str = "dG_H") -> str:
    rows = sorted(_numeric(results, key), key=lambda t: abs(t[1]))
    return "candidate,dG_H,abs_dG_H\n" + "".join(
        f"{n},{v},{abs(v)}\n" for n, v in rows)


def funnel_md(results, eform_key: str = "E_form", eform_threshold: float = 0.0,
              dg_key: str = "dG_H", top: int = 3) -> str:
    stage1 = _numeric(results, eform_key)
    survivors = [(n, e) for n, e in stage1 if e < eform_threshold]
    activity = sorted(_numeric(results, dg_key), key=lambda t: abs(t[1]))
    md = [cl.tldr_header(
        "funnel",
        f"{len(stage1)} candidates -> {len(survivors)} stable -> "
        f"top {min(top, len(activity))} active"), ""]
    md.append(f"- stage 1 (stability): {len(stage1)} candidates")
    md.append(f"- survivors (E_form < {eform_threshold}): {len(survivors)} -> "
              + ", ".join(n for n, _ in survivors))
    md.append(f"- stage 2 (activity) top {top} by |dG_H|: "
              + ", ".join(f"{n}({v})" for n, v in activity[:top]))
    return "\n".join(md) + "\n"


def write_aggregates(project, eform_threshold: float = 0.0, top: int = 3) -> dict:
    proj = Path(project).expanduser()
    adir = proj / "analysis"
    adir.mkdir(exist_ok=True)
    results = collect_results(project)
    rank_md, rank_csv = rank_formation_energy(results)
    (adir / "formation_energy_ranking.md").write_text(rank_md)
    (adir / "formation_energy_ranking.csv").write_text(rank_csv)
    (adir / "volcano.csv").write_text(volcano_csv(results))
    (adir / "funnel.md").write_text(
        funnel_md(results, eform_threshold=eform_threshold, top=top))
    return {"n_results": len(results)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_campaign_analysis.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/skills/campaign/scripts/campaign_analysis.py \
        server/catgo/workflow/skills/campaign/scripts/test_campaign_analysis.py
git commit -m "feat(campaign): analysis aggregation (ranking/volcano/funnel)"
```

---

### Task 3: volcano plot + `aggregate.py` entrypoint

**Files:**
- Modify: `server/catgo/workflow/skills/campaign/scripts/campaign_analysis.py` (append `volcano_plot`)
- Create: `server/catgo/workflow/skills/campaign/scripts/aggregate.py`
- Test: `server/catgo/workflow/skills/campaign/scripts/test_campaign_analysis.py` (append) + `test_entrypoints.py` (append)

- [ ] **Step 1: Write the failing test** — append to `test_campaign_analysis.py`:

```python
def test_volcano_plot_writes_png(tmp_path):
    root = _project_with_results(tmp_path)
    dest = ca.volcano_plot(str(root))
    assert dest.is_file()
    assert dest.suffix == ".png"
    assert dest.stat().st_size > 0
```

Append to `test_entrypoints.py`:

```python
def test_aggregate_main_writes_analysis(tmp_path, capsys):
    import aggregate
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    d = root / "calc" / "01-stability-formation-energy" / "c"
    d.mkdir(parents=True)
    (d / "result.md").write_text(cl.render_result("c", {"E_form": -0.5, "dG_H": 0.1}))
    rc = aggregate.main(["--project", str(root), "--plot"])
    assert rc == 0
    assert (root / "analysis" / "funnel.md").is_file()
    assert (root / "analysis" / "volcano.png").is_file()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_campaign_analysis.py::test_volcano_plot_writes_png test_entrypoints.py::test_aggregate_main_writes_analysis -v`
Expected: FAIL (`AttributeError: ... no attribute 'volcano_plot'` / `ModuleNotFoundError: No module named 'aggregate'`)

- [ ] **Step 3: Write minimal implementation**

Append to `campaign_analysis.py`:

```python
def volcano_plot(project, key: str = "dG_H", out: str = "analysis/volcano.png") -> Path:
    """Scatter |dG_H| per candidate -> analysis/volcano.png (Agg, headless)."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    proj = Path(project).expanduser()
    pts = _numeric(collect_results(project), key)
    fig, ax = plt.subplots(figsize=(max(4, len(pts) * 0.8), 4))
    xs = list(range(len(pts)))
    ax.scatter(xs, [abs(v) for _, v in pts])
    ax.set_xticks(xs)
    ax.set_xticklabels([n for n, _ in pts], rotation=45, ha="right")
    ax.set_ylabel(f"|{key}| (eV)")
    ax.set_title("HER activity volcano (closer to 0 = better)")
    fig.tight_layout()
    dest = proj / out
    dest.parent.mkdir(exist_ok=True)
    fig.savefig(dest, dpi=120)
    plt.close(fig)
    return dest
```

Create `aggregate.py`:

```python
#!/usr/bin/env python3
"""Aggregate per-calc results into analysis/ (ranking / volcano / funnel).

    python aggregate.py --project <dir> [--eform_threshold 0.0] [--top 3] [--plot]
"""
from __future__ import annotations

import argparse
import sys

import campaign_analysis as ca


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="aggregate campaign results")
    ap.add_argument("--project", required=True)
    ap.add_argument("--eform_threshold", type=float, default=0.0)
    ap.add_argument("--top", type=int, default=3)
    ap.add_argument("--plot", action="store_true", help="also write volcano.png")
    args = ap.parse_args(argv)
    info = ca.write_aggregates(args.project, eform_threshold=args.eform_threshold,
                               top=args.top)
    if args.plot:
        ca.volcano_plot(args.project)
    print(f"aggregated {info['n_results']} results -> {args.project}/analysis/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_campaign_analysis.py test_entrypoints.py -v`
Expected: PASS (analysis 6 + entrypoints 4)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/skills/campaign/scripts/campaign_analysis.py \
        server/catgo/workflow/skills/campaign/scripts/aggregate.py \
        server/catgo/workflow/skills/campaign/scripts/test_campaign_analysis.py \
        server/catgo/workflow/skills/campaign/scripts/test_entrypoints.py
git commit -m "feat(campaign): volcano plot + aggregate.py entrypoint"
```

---

### Task 4: `campaign_report.py` + `make_report.py`

**Files:**
- Create: `server/catgo/workflow/skills/campaign/scripts/campaign_report.py`
- Create: `server/catgo/workflow/skills/campaign/scripts/make_report.py`
- Test: `server/catgo/workflow/skills/campaign/scripts/test_campaign_report.py`

- [ ] **Step 1: Write the failing test** — create `test_campaign_report.py`:

```python
"""campaign_report — draft a group-meeting / seminar report from current state."""
import campaign_lib as cl
import campaign_analysis as ca
import campaign_report as cr


def _project(tmp_path):
    root = cl.scaffold_project(tmp_path / "SAA-HER", "SAA HER", template="saa_her")
    d = root / "calc" / "01-stability-formation-energy" / "Pt1-Cu_SAA"
    d.mkdir(parents=True)
    (d / "result.md").write_text(cl.render_result("Pt1-Cu_SAA",
                                                  {"E_form": -0.42, "dG_H": 0.08}))
    ca.write_aggregates(str(root))
    return root


def test_make_report_writes_dated_folder_with_sections(tmp_path):
    root = _project(tmp_path)
    dest = cr.make_report(str(root), occasion="groupmeeting", date="2026-06-06")
    assert dest.is_file()
    assert dest.parent.name == "2026-06-06-groupmeeting"
    assert (dest.parent / "figures").is_dir()
    text = dest.read_text()
    assert text.lstrip().startswith("# ")
    assert "**TL;DR:**" in text
    for section in ("## Background", "## Methods", "## Results", "## Conclusion",
                    "## References"):
        assert section in text
    # Results section pulls in the funnel summary
    assert "candidates" in text


def test_make_report_copies_volcano_when_present(tmp_path):
    root = _project(tmp_path)
    ca.volcano_plot(str(root))
    dest = cr.make_report(str(root), occasion="seminar", date="2026-07-01")
    assert (dest.parent / "figures" / "volcano.png").is_file()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_campaign_report.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'campaign_report'`

- [ ] **Step 3: Write minimal implementation** — create `campaign_report.py`:

```python
"""Draft a group-meeting / seminar report from the campaign's current state.

Pulls the funnel + ranking from analysis/, the narrative from README/plan, and
the sources from literature/INDEX into a progressive-md report under
report/<date>-<occasion>/. A draft the user edits — not a final artifact.
"""
from __future__ import annotations

from pathlib import Path

import campaign_lib as cl


def _read(p: Path, fallback: str) -> str:
    return p.read_text() if p.is_file() else fallback


def make_report(project, occasion: str, date: str) -> Path:
    proj = Path(project).expanduser()
    name = proj.name
    funnel = _read(proj / "analysis" / "funnel.md", "(run aggregate.py first)")
    ranking = _read(proj / "analysis" / "formation_energy_ranking.md", "")
    lit = _read(proj / "literature" / "INDEX.md", "(no literature/INDEX.md)")

    slug = cl.slugify(f"{date}-{occasion}")
    rdir = proj / "report" / slug
    (rdir / "figures").mkdir(parents=True, exist_ok=True)

    body = [
        cl.tldr_header(f"{name} — {occasion} ({date})", "campaign report draft"),
        "",
        "## Background\n\n<from literature; see References below>\n",
        "## Methods\n\n<from cluster.md + per-calc plan.md>\n",
        "## Results\n",
        funnel,
        "",
        ranking,
        "",
        "## Conclusion\n\n<fill in>\n",
        "## References\n",
        lit,
    ]
    dest = rdir / "report.md"
    dest.write_text("\n".join(body) + "\n")

    volcano = proj / "analysis" / "volcano.png"
    if volcano.is_file():
        (rdir / "figures" / "volcano.png").write_bytes(volcano.read_bytes())
    return dest
```

Create `make_report.py`:

```python
#!/usr/bin/env python3
"""Draft a campaign report under report/<date>-<occasion>/.

    python make_report.py --project <dir> --occasion groupmeeting [--date YYYY-MM-DD]
"""
from __future__ import annotations

import argparse
import datetime
import sys

import campaign_report as cr


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="draft a campaign report")
    ap.add_argument("--project", required=True)
    ap.add_argument("--occasion", required=True, help="e.g. groupmeeting / seminar")
    ap.add_argument("--date", default="", help="YYYY-MM-DD (default: today)")
    args = ap.parse_args(argv)
    date = args.date or datetime.date.today().isoformat()
    dest = cr.make_report(args.project, occasion=args.occasion, date=date)
    print(f"report draft -> {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_campaign_report.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/skills/campaign/scripts/campaign_report.py \
        server/catgo/workflow/skills/campaign/scripts/make_report.py \
        server/catgo/workflow/skills/campaign/scripts/test_campaign_report.py
git commit -m "feat(campaign): report draft generation (analysis + narrative + literature)"
```

---

### Task 5: `campaign_lit.py` + `ingest_lit.py` (MinerU + literature→skill)

**Files:**
- Create: `server/catgo/workflow/skills/campaign/scripts/campaign_lit.py`
- Create: `server/catgo/workflow/skills/campaign/scripts/ingest_lit.py`
- Test: `server/catgo/workflow/skills/campaign/scripts/test_campaign_lit.py`

- [ ] **Step 1: Write the failing test** — create `test_campaign_lit.py`:

```python
"""campaign_lit — literature ingestion (MinerU PDF->md, repo pointers, skills)."""
import pytest

import campaign_lib as cl
import campaign_lit as lit


def test_ingest_repo_writes_pointer_and_index(tmp_path):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    p = lit.ingest_repo(str(root), "https://github.com/foo/saa-her.git",
                        purpose="reference DFT workflow", commit="abc123")
    assert p.is_file()
    txt = p.read_text()
    assert "https://github.com/foo/saa-her.git" in txt
    assert "abc123" in txt
    idx = (root / "literature" / "INDEX.md").read_text()
    assert "repos/saa-her" in idx


def test_append_extracted_skill_creates_then_appends(tmp_path):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    f = lit.append_extracted_skill(str(root), "VASP HSE gotcha", "use LH5=False ...")
    assert f.is_file()
    lit.append_extracted_skill(str(root), "k-point note", "use 5x5x1 ...")
    body = f.read_text()
    assert "## VASP HSE gotcha" in body
    assert "## k-point note" in body
    assert "**TL;DR:**" in body   # progressive header present once


def test_ingest_pdf_uses_injected_converter(tmp_path):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")

    def fake_converter(pdf_path, out_dir):
        from pathlib import Path
        md = Path(out_dir) / "converted.md"
        md.write_text("# Paper\nAbstract ...\n")
        return md

    paper = lit.ingest_pdf(str(root), "/tmp/some-paper.pdf", converter=fake_converter)
    assert paper.is_file()
    assert "Abstract" in paper.read_text()
    assert (paper.parent / "notes.md").is_file()
    idx = (root / "literature" / "INDEX.md").read_text()
    assert "papers/some-paper" in idx


def test_mineru_convert_clean_error_when_missing(tmp_path, monkeypatch):
    def boom(argv):
        raise FileNotFoundError("mineru")
    monkeypatch.setattr(cl, "_run", boom)
    with pytest.raises(cl.CampaignError) as ei:
        lit.mineru_convert("/tmp/x.pdf", str(tmp_path))
    assert "MinerU" in str(ei.value)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_campaign_lit.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'campaign_lit'`

- [ ] **Step 3: Write minimal implementation** — create `campaign_lit.py`:

```python
"""Literature ingestion: MinerU PDF->md, GitHub repo pointers, skill extraction.

Grounds plan/brainstorm in real sources and mines reusable recipes. MinerU is
optional — invoked through campaign_lib._run so it is mockable and degrades with
a clear install hint when absent.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import campaign_lib as cl


def _append_index(index_path: Path, line: str) -> None:
    if not index_path.is_file():
        index_path.parent.mkdir(parents=True, exist_ok=True)
        index_path.write_text(
            cl.tldr_header("literature/", "papers + repos + extracted-skills") + "\n")
    with index_path.open("a") as fh:
        fh.write(line + "\n")


def ingest_repo(project, url: str, purpose: str = "", commit: str = "") -> Path:
    proj = Path(project).expanduser()
    slug = cl.slugify(url.rstrip("/").split("/")[-1].replace(".git", ""))
    d = proj / "literature" / "repos" / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / "POINTER.md").write_text(
        cl.tldr_header(f"repo: {slug}", purpose or url)
        + f"\nurl: {url}\ncommit: {commit}\npurpose: {purpose}\n"
    )
    _append_index(proj / "literature" / "INDEX.md", f"- `repos/{slug}/` — {purpose or url}")
    return d / "POINTER.md"


def append_extracted_skill(project, title: str, body: str) -> Path:
    proj = Path(project).expanduser()
    f = proj / "literature" / "extracted-skills.md"
    if not f.is_file():
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(cl.tldr_header(
            "extracted skills", "reusable recipes mined from literature/repos") + "\n")
    with f.open("a") as fh:
        fh.write(f"\n## {title}\n{body}\n")
    return f


def mineru_convert(pdf_path, out_dir) -> Path:
    """Run MinerU on a PDF; return the produced .md. Clear error if absent."""
    try:
        rc, _, err = cl._run(["mineru", "-p", str(pdf_path), "-o", str(out_dir)])
    except FileNotFoundError:
        raise cl.CampaignError(
            "MinerU not installed — `pip install mineru` (or `magic-pdf`). "
            "PDF ingest needs it; or drop a converted paper.md in literature/papers/."
        )
    if rc != 0:
        raise cl.CampaignError(f"mineru failed: {err.strip() or f'rc={rc}'}")
    mds = sorted(Path(out_dir).rglob("*.md"))
    if not mds:
        raise cl.CampaignError(f"mineru produced no .md in {out_dir}")
    return mds[0]


def ingest_pdf(project, pdf_path, converter=mineru_convert) -> Path:
    proj = Path(project).expanduser()
    slug = cl.slugify(Path(pdf_path).stem)
    pdir = proj / "literature" / "papers" / slug
    pdir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        md = converter(pdf_path, tmp)
        (pdir / "paper.md").write_text(Path(md).read_text())
    (pdir / "notes.md").write_text(
        cl.tldr_header(f"notes: {slug}", "key settings/method/findings (fill in)") + "\n")
    _append_index(proj / "literature" / "INDEX.md",
                  f"- `papers/{slug}/` — <relevance; fill in>")
    return pdir / "paper.md"
```

Create `ingest_lit.py`:

```python
#!/usr/bin/env python3
"""Ingest literature into a campaign: a PDF (via MinerU) or a GitHub repo pointer.

    python ingest_lit.py --project <dir> --pdf <paper.pdf>
    python ingest_lit.py --project <dir> --repo <url> [--purpose "..."] [--commit SHA]
"""
from __future__ import annotations

import argparse
import sys

import campaign_lib as cl
import campaign_lit as lit


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="ingest literature")
    ap.add_argument("--project", required=True)
    ap.add_argument("--pdf", default="", help="PDF to convert via MinerU")
    ap.add_argument("--repo", default="", help="GitHub repo URL")
    ap.add_argument("--purpose", default="")
    ap.add_argument("--commit", default="")
    args = ap.parse_args(argv)
    if not args.pdf and not args.repo:
        print("provide --pdf or --repo", file=sys.stderr)
        return 2
    try:
        if args.pdf:
            dest = lit.ingest_pdf(args.project, args.pdf)
        else:
            dest = lit.ingest_repo(args.project, args.repo,
                                   purpose=args.purpose, commit=args.commit)
    except cl.CampaignError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"ingested -> {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_campaign_lit.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/skills/campaign/scripts/campaign_lit.py \
        server/catgo/workflow/skills/campaign/scripts/ingest_lit.py \
        server/catgo/workflow/skills/campaign/scripts/test_campaign_lit.py
git commit -m "feat(campaign): literature ingest (MinerU PDF + repo pointers + extracted-skills)"
```

---

### Task 6: catgo-CLI reference skill + SKILL.md wiring

**Files:**
- Create: `server/catgo/workflow/skills/campaign/references/catgo-cli.md`
- Modify: `server/catgo/workflow/skills/campaign/SKILL.md` (add a "catgo CLI during a campaign" section + reference link; extend the loop steps)
- Test: `server/catgo/workflow/skills/campaign/scripts/test_skill_structure.py` (append)

- [ ] **Step 1: Write the failing test** — append to `test_skill_structure.py`:

```python
def test_catgo_cli_reference_exists_and_lists_ops():
    ref = _SKILL / "references" / "catgo-cli.md"
    assert ref.is_file()
    text = ref.read_text()
    assert text.lstrip().startswith("# ")
    assert "**TL;DR:**" in text
    for op in ("catgo slab", "catgo convert", "catgo dos", "catgo freq",
               "catgo band", "catgo cohp"):
        assert op in text, f"{op} not documented"


def test_skill_md_links_cli_reference_and_aggregate():
    text = (_SKILL / "SKILL.md").read_text()
    assert "references/catgo-cli.md" in text
    assert "aggregate.py" in text        # P2 aggregation wired into the loop
    assert "make_report.py" in text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_skill_structure.py -v`
Expected: FAIL (catgo-cli.md missing / SKILL.md lacks the links)

- [ ] **Step 3: Write minimal implementation**

Create `server/catgo/workflow/skills/campaign/references/catgo-cli.md`:

```markdown
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
```

In `server/catgo/workflow/skills/campaign/SKILL.md`, replace the existing
"## The loop ..." section's steps 3-4 and add a CLI section. Specifically, change
the loop step 3 and add the analysis/report wiring. Replace this block:

```
2. `python poll.py --project <dir> --ssh <alias>` (updates STATUS via squeue).
3. For finished calcs: collect results into `result.md`; note gotchas in `LESSONS.md`.
4. Render inputs for newly-ready calcs -> input-file gate -> `submit_calc.py`.
5. At a stage/decision point -> write a summary -> checkpoint.
6. On an unhandleable problem -> write it to STATUS/LESSONS and stop.
```

with:

```
2. `python poll.py --project <dir> --ssh <alias>` (updates STATUS via squeue).
3. For finished calcs: analyze outputs with the catgo CLI (`catgo freq` for
   Gibbs/ΔG, `catgo dos`/`band`/`cohp` as needed — see references/catgo-cli.md)
   and write the numbers into the calc's `result.md`; note gotchas in `LESSONS.md`.
4. Render inputs for newly-ready calcs (build with `catgo slab`/`supercell` etc.)
   -> input-file gate -> `submit_calc.py`.
5. At a stage/decision point -> `python aggregate.py --project <dir> --plot`
   (ranking / volcano / funnel into analysis/) -> write a summary -> checkpoint.
6. For a group meeting: `python make_report.py --project <dir> --occasion groupmeeting`.
7. On an unhandleable problem -> write it to STATUS/LESSONS and stop.
```

And add this section to SKILL.md just before the "## Literature -> plan -> skill" section:

```
## catgo CLI during a campaign

Use the existing `catgo` CLI for the actual chemistry — see
`references/catgo-cli.md`. Build structures (`catgo slab`/`supercell`/`reticular`/
`convert`/`inspect`) and analyze results (`catgo dos`/`band`/`cohp`/`freq`). These
run offline (no viewer needed). Aggregate per-calc `result.md` files with
`scripts/aggregate.py`; draft reports with `scripts/make_report.py`; ingest
literature with `scripts/ingest_lit.py`.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_skill_structure.py -v`
Expected: PASS (existing 2 + 2 new = 4)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/skills/campaign/references/catgo-cli.md \
        server/catgo/workflow/skills/campaign/SKILL.md \
        server/catgo/workflow/skills/campaign/scripts/test_skill_structure.py
git commit -m "feat(campaign): catgo-CLI reference skill + wire CLI/aggregate/report into the loop"
```

---

### Task 7: full P2 suite + end-to-end sanity

**Files:** none (verification only)

- [ ] **Step 1: Run the whole campaign script suite**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest -v`
Expected: PASS — MVP (23) + result (2) + analysis (6) + report (2) + lit (4) + entrypoints (now 5) + skill_structure (4) ≈ 46 tests, all green.

- [ ] **Step 2: End-to-end aggregation + report sanity**

Run:
```bash
cd server/catgo/workflow/skills/campaign/scripts && PY=/home/james0001/miniforge3/envs/catgo/bin/python && \
rm -rf /tmp/camp-p2 && $PY new_campaign.py /tmp/camp-p2 --name "SAA HER" --template saa_her && \
for n in Pt1-Cu_SAA Ni1-Cu_SAA Au1-Cu_SAA; do \
  mkdir -p /tmp/camp-p2/calc/01-stability-formation-energy/$n; done && \
$PY -c "import campaign_lib as cl; import pathlib; \
d=pathlib.Path('/tmp/camp-p2/calc/01-stability-formation-energy'); \
vals={'Pt1-Cu_SAA':{'E_form':-0.42,'dG_H':0.08},'Ni1-Cu_SAA':{'E_form':-0.10,'dG_H':-0.30},'Au1-Cu_SAA':{'E_form':0.25,'dG_H':0.02}}; \
[ (d/n/'result.md').write_text(cl.render_result(n,v)) for n,v in vals.items() ]" && \
$PY aggregate.py --project /tmp/camp-p2 --plot && \
$PY make_report.py --project /tmp/camp-p2 --occasion groupmeeting --date 2026-06-06 && \
$PY ingest_lit.py --project /tmp/camp-p2 --repo https://github.com/foo/saa-her.git --purpose "ref workflow" && \
echo "--- analysis ---" && cat /tmp/camp-p2/analysis/funnel.md && \
echo "--- report tree ---" && find /tmp/camp-p2/report /tmp/camp-p2/literature -type f | sort && \
rm -rf /tmp/camp-p2
```
Expected: funnel shows `3 candidates -> 2 stable`, `analysis/volcano.png` exists,
`report/2026-06-06-groupmeeting/report.md` + `figures/volcano.png` exist,
`literature/repos/saa-her/POINTER.md` + an updated `literature/INDEX.md` exist.

---

## Self-Review

**1. Spec coverage (P2):**
- analysis aggregation (ranking / volcano / funnel) → Tasks 2-3. ✓
- report generation → Task 4. ✓
- MinerU literature ingestion + literature→skill → Task 5 (`ingest_pdf`/`mineru_convert` + `append_extracted_skill`). ✓
- catgo-CLI as skill, usable during computation → Task 6 (`references/catgo-cli.md` + loop wiring). ✓
- result.md contract (shared by aggregation + report) → Task 1. ✓
- archive automation + mode-selection GUI → still deferred (not in this plan; archive is a trivial agent `mv` per SKILL, GUI is frontend). Intentional.

**2. Placeholder scan:** no TBD/TODO; complete code + exact commands everywhere. `<fill in>` / `<from ...>` strings appear only inside *generated* report/notes stubs (runtime artifacts the user edits), not as plan placeholders. ✓

**3. Type consistency:** `collect_results` returns `[{name, stage, values}]` used identically by `rank_formation_energy`/`volcano_csv`/`funnel_md`/`volcano_plot`. `cl.parse_result`/`cl.render_result` signatures match all call sites. `make_report(project, occasion, date)` matches `make_report.py`. `ingest_pdf(project, pdf_path, converter=...)` / `ingest_repo(project, url, purpose, commit)` / `mineru_convert(pdf, out_dir)` match their tests + `ingest_lit.py`. Entrypoints all expose `main(argv)->int`. All modules import the single `campaign_lib as cl`. ✓
```
