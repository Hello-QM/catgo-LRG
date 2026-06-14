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
