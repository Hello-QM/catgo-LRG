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


def test_volcano_plot_writes_png(tmp_path):
    root = _project_with_results(tmp_path)
    dest = ca.volcano_plot(str(root))
    assert dest.is_file()
    assert dest.suffix == ".png"
    assert dest.stat().st_size > 0


def test_nan_results_excluded_from_aggregates(tmp_path):
    # a failed job writing `dG_H: nan` must not silently scramble ordering
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    d = root / "calc" / "01-stability-formation-energy"
    for name, vals in (("good", {"E_form": -0.3, "dG_H": 0.05}),
                       ("failed", {"E_form": float("nan"), "dG_H": float("nan")})):
        (d / name).mkdir(parents=True)
        (d / name / "result.md").write_text(cl.render_result(name, vals))
    results = ca.collect_results(str(root))
    md, csv = ca.rank_formation_energy(results)
    assert "good" in md and "failed" not in md          # nan row dropped
    assert "1 candidates" in md
    funnel = ca.funnel_md(results)
    assert "1 candidates" in funnel                       # only the finite one counts
