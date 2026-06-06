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
