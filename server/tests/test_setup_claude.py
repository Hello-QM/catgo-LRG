"""Tests for catgo.setup_claude — Claude Code MCP + skills registration.

All filesystem access is redirected into tmp dirs (via monkeypatching
``Path.home``) so the real ``~/.claude.json`` / ``~/.claude/skills`` are never
touched.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from catgo import setup_claude


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    """Redirect ``Path.home()`` to a tmp dir for the duration of a test."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    return home


def _make_skills_src(root: Path) -> Path:
    """Build a skills source tree: two real skills + one decoy dir + a file."""
    src = root / "skills_src"
    src.mkdir()
    for name in ("catgo-campaign", "catgo-gibbs-pipeline"):
        d = src / name
        d.mkdir()
        (d / "SKILL.md").write_text(f"# {name}\n")
        (d / "reference.md").write_text("ref\n")
    # A subdir WITHOUT SKILL.md must be skipped.
    (src / "not-a-skill").mkdir()
    (src / "not-a-skill" / "readme.txt").write_text("nope\n")
    # A stray file at the top level must be ignored.
    (src / "loose.txt").write_text("ignore me\n")
    return src


# ───────────────────────────── register_mcp_http ────────────────────────────


def test_register_mcp_http_writes_correct_shape(fake_home):
    url = setup_claude.register_mcp_http("http://127.0.0.1:8000/api")
    assert url == "http://127.0.0.1:8000/api/mcp"

    claude_json = fake_home / ".claude.json"
    assert claude_json.exists()
    cfg = json.loads(claude_json.read_text())
    assert cfg["mcpServers"]["catgo"] == {
        "type": "http",
        "url": "http://127.0.0.1:8000/api/mcp",
    }


def test_register_mcp_http_strips_trailing_slash(fake_home):
    url = setup_claude.register_mcp_http("http://127.0.0.1:8000/api/")
    assert url == "http://127.0.0.1:8000/api/mcp"


def test_register_mcp_http_preserves_other_keys(fake_home):
    claude_json = fake_home / ".claude.json"
    claude_json.write_text(
        json.dumps(
            {
                "numStartups": 42,
                "theme": "dark",
                "mcpServers": {
                    "other-server": {"type": "stdio", "command": "foo"},
                },
            }
        )
    )

    setup_claude.register_mcp_http("http://127.0.0.1:8000/api")

    cfg = json.loads(claude_json.read_text())
    # Pre-existing top-level keys preserved.
    assert cfg["numStartups"] == 42
    assert cfg["theme"] == "dark"
    # Pre-existing unrelated MCP server preserved.
    assert cfg["mcpServers"]["other-server"] == {"type": "stdio", "command": "foo"}
    # catgo entry added.
    assert cfg["mcpServers"]["catgo"]["url"] == "http://127.0.0.1:8000/api/mcp"


def test_register_mcp_http_idempotent(fake_home):
    setup_claude.register_mcp_http("http://127.0.0.1:8000/api")
    setup_claude.register_mcp_http("http://127.0.0.1:8000/api")

    cfg = json.loads((fake_home / ".claude.json").read_text())
    # Exactly one catgo entry, no corruption.
    assert list(cfg["mcpServers"].keys()) == ["catgo"]
    assert cfg["mcpServers"]["catgo"] == {
        "type": "http",
        "url": "http://127.0.0.1:8000/api/mcp",
    }


def test_register_mcp_http_recovers_from_corrupt_file(fake_home):
    claude_json = fake_home / ".claude.json"
    claude_json.write_text("{ this is not valid json ]]")

    url = setup_claude.register_mcp_http("http://127.0.0.1:8000/api")

    cfg = json.loads(claude_json.read_text())
    assert url == "http://127.0.0.1:8000/api/mcp"
    assert cfg["mcpServers"]["catgo"]["url"] == url


# ─────────────────────────────── install_skills ─────────────────────────────


def test_install_skills_copies_only_skill_dirs(fake_home, tmp_path):
    src = _make_skills_src(tmp_path)

    installed = setup_claude.install_skills(src, prefer_symlink=False)

    assert sorted(installed) == ["catgo-campaign", "catgo-gibbs-pipeline"]
    skills_dir = fake_home / ".claude" / "skills"
    # Dirs with SKILL.md were copied.
    assert (skills_dir / "catgo-campaign" / "SKILL.md").is_file()
    assert (skills_dir / "catgo-gibbs-pipeline" / "reference.md").is_file()
    # Decoy dir (no SKILL.md) and loose file were NOT installed.
    assert not (skills_dir / "not-a-skill").exists()
    assert not (skills_dir / "loose.txt").exists()


def test_install_skills_idempotent(fake_home, tmp_path):
    src = _make_skills_src(tmp_path)

    setup_claude.install_skills(src, prefer_symlink=False)
    # Re-run with modified source content — refresh must replace, not stack.
    (src / "catgo-campaign" / "SKILL.md").write_text("# updated\n")
    installed = setup_claude.install_skills(src, prefer_symlink=False)

    assert sorted(installed) == ["catgo-campaign", "catgo-gibbs-pipeline"]
    skills_dir = fake_home / ".claude" / "skills"
    # Only the expected skill dirs exist (no duplicates / leftovers).
    names = sorted(p.name for p in skills_dir.iterdir())
    assert names == ["catgo-campaign", "catgo-gibbs-pipeline"]
    # Content reflects the refreshed source.
    assert (skills_dir / "catgo-campaign" / "SKILL.md").read_text() == "# updated\n"


def test_install_skills_replaces_existing_stale_dir(fake_home, tmp_path):
    src = _make_skills_src(tmp_path)
    skills_dir = fake_home / ".claude" / "skills"
    skills_dir.mkdir(parents=True)
    # A pre-existing real dir with stale content at the target name.
    stale = skills_dir / "catgo-campaign"
    stale.mkdir()
    (stale / "STALE.md").write_text("old\n")

    setup_claude.install_skills(src, prefer_symlink=False)

    # Stale content gone, fresh content present.
    assert not (stale / "STALE.md").exists()
    assert (stale / "SKILL.md").is_file()


def test_install_skills_symlink_with_copy_fallback(fake_home, tmp_path):
    src = _make_skills_src(tmp_path)

    installed = setup_claude.install_skills(src, prefer_symlink=True)

    assert sorted(installed) == ["catgo-campaign", "catgo-gibbs-pipeline"]
    target = fake_home / ".claude" / "skills" / "catgo-campaign"
    # Either a symlink (POSIX) or a real copy (fallback) — both must resolve to
    # readable SKILL.md content.
    assert (target / "SKILL.md").is_file()


def test_install_skills_missing_src_returns_empty(fake_home, tmp_path):
    installed = setup_claude.install_skills(tmp_path / "does-not-exist", prefer_symlink=False)
    assert installed == []


# ───────────────────────── ensure_claude_integration ────────────────────────


def test_ensure_claude_integration_happy_path(fake_home, tmp_path):
    src = _make_skills_src(tmp_path)

    result = setup_claude.ensure_claude_integration(
        api_base="http://127.0.0.1:8000/api",
        prefer_symlink=False,
        skills_src=src,
    )

    assert result["mcp_url"] == "http://127.0.0.1:8000/api/mcp"
    assert sorted(result["skills"]) == ["catgo-campaign", "catgo-gibbs-pipeline"]
    assert result["claude_json"] == str(fake_home / ".claude.json")
    assert "errors" not in result


def test_ensure_claude_integration_collects_errors_without_raising(
    fake_home, tmp_path, monkeypatch
):
    src = _make_skills_src(tmp_path)

    def _boom(*a, **k):
        raise PermissionError("denied")

    # Make the skills step fail; the MCP step must still succeed.
    monkeypatch.setattr(setup_claude, "install_skills", _boom)

    result = setup_claude.ensure_claude_integration(
        api_base="http://127.0.0.1:8000/api",
        skills_src=src,
    )

    assert result["mcp_url"] == "http://127.0.0.1:8000/api/mcp"
    assert result["skills"] == []
    assert "skills" in result["errors"]
    assert "PermissionError" in result["errors"]["skills"]
