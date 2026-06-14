"""Cross-calc aggregation for a campaign: ranking, volcano, funnel.

Reads every ``calc/**/result.md`` (the per-calc results contract) and writes
human-readable summaries into ``analysis/``. This is the campaign-level view the
DB-only engine made hard to see.
"""
from __future__ import annotations

import math
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
    # Drop non-finite values (NaN/inf): a failed job's collect step may write
    # `dG_H: nan`, and NaN compares false against everything, which would
    # silently scramble the sorted ranking/volcano/funnel order. Exclude them.
    return [(r["name"], v) for r in results
            if isinstance((v := r["values"].get(key)), (int, float))
            and not isinstance(v, bool) and math.isfinite(v)]


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
    md.append(f"- stage 2 (activity) top {min(top, len(activity))} by |dG_H|: "
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
