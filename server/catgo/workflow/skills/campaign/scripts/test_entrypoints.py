"""Entrypoints are thin: importable, expose main(argv) delegating to campaign_lib."""
import campaign_lib as cl


def test_new_campaign_main_scaffolds(tmp_path, capsys):
    import new_campaign
    rc = new_campaign.main([str(tmp_path / "p"), "--name", "SAA HER",
                            "--template", "saa_her"])
    assert rc == 0
    assert (tmp_path / "p" / "plan.md").is_file()
    assert "created" in capsys.readouterr().out.lower()


def test_submit_main_surfaces_gate_error(tmp_path, capsys):
    import submit_calc
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    calc = root / "calc" / "01-stability-formation-energy" / "c"
    calc.mkdir(parents=True)
    (calc / "INCAR").write_text("ENCUT=520\n")
    rc = submit_calc.main([
        "--project", str(root),
        "--calc", "calc/01-stability-formation-energy/c", "--ssh", "lab",
    ])
    assert rc != 0                       # gate refused
    assert "cluster.md" in capsys.readouterr().err


def test_poll_main_runs_with_no_active(tmp_path):
    import poll
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    rc = poll.main(["--project", str(root), "--ssh", "lab"])
    assert rc == 0                        # nothing active -> no ssh calls -> ok


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
