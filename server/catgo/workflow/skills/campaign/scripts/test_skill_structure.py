"""The campaign SKILL + template exist and document the gates + conventions."""
from pathlib import Path

_SKILL = Path(__file__).resolve().parents[1]   # .../skills/campaign


def test_skill_md_documents_gates_and_conventions():
    text = (_SKILL / "SKILL.md").read_text()
    low = text.lower()
    assert "input-file gate" in low
    assert "cluster.md" in text
    assert "yolo" in low
    assert "never guess" in low or "do not guess" in low
    assert "STATUS.md" in text
    assert "submit_calc.py" in text     # points the agent at the scripts
    assert "progressive" in low


def test_saa_her_template_has_funnel():
    text = (_SKILL / "templates" / "saa_her" / "plan.md").read_text()
    assert text.lstrip().startswith("# ")
    assert "**TL;DR:**" in text
    assert "decision point" in text.lower()
    assert "dG_H" in text or "ΔG" in text


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


def test_skill_md_offers_brainstorm_choice():
    text = (_SKILL / "SKILL.md").read_text()
    low = text.lower()
    assert "brainstorm" in low
    # the agent must ASK the user how to create the plan, not assume
    assert "ask the user" in low or "ask first" in low
    assert "plan.md" in text
