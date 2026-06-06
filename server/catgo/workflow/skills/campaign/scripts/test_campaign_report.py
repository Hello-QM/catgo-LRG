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
