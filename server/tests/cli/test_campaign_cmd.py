"""`catgo campaign ...` portable launcher (dispatches to the skill scripts)."""
from catgo.cli.campaign_cmd import run_campaign, _scripts_dir


def test_scripts_dir_points_at_shipped_scripts():
    assert (_scripts_dir() / "new_campaign.py").is_file()
    assert (_scripts_dir() / "campaign_lib.py").is_file()


def test_campaign_new_scaffolds(tmp_path):
    rc = run_campaign(["new", str(tmp_path / "p"), "--name", "SAA HER",
                       "--template", "saa_her"])
    assert rc == 0
    assert (tmp_path / "p" / "plan.md").is_file()
    assert (tmp_path / "p" / "calc" / "02-activity-dGH" / "INDEX.md").is_file()


def test_unknown_action_errors(capsys):
    rc = run_campaign(["bogus"])
    assert rc == 2
    assert "unknown campaign action" in capsys.readouterr().err


def test_no_args_prints_usage(capsys):
    rc = run_campaign([])
    assert rc == 2
    assert "usage" in capsys.readouterr().out.lower()


def test_parser_wires_campaign_remainder():
    from catgo.cli import _build_legacy_parser
    parser, _ = _build_legacy_parser()
    args = parser.parse_args(["campaign", "poll", "--project", "x", "--ssh", "y"])
    assert args.command == "campaign"
    assert args.rest == ["poll", "--project", "x", "--ssh", "y"]
