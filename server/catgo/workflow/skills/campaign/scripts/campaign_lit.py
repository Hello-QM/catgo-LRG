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
