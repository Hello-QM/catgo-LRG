"""Unit tests for parse_ase_opt_log — the ASE optimizer log parser backing
the `/mlp-progress/{step_id}` endpoint."""

from pathlib import Path

import pytest

from catgo.utils.job_parser import parse_ase_opt_log


def _write(tmp_path: Path, body: str) -> str:
    p = tmp_path / "opt.log"
    p.write_text(body)
    return str(p)


class TestHappyPath:
    def test_fire_log(self, tmp_path):
        body = """      Step     Time          Energy          fmax
FIRE:    0 14:10:01     -201.040130        9.461488
FIRE:    1 14:10:03     -201.234000        8.100000
FIRE:    2 14:10:05     -201.500000        0.030000
"""
        result = parse_ase_opt_log(_write(tmp_path, body), fmax_target=0.05)
        assert result.success
        assert len(result.points) == 3
        assert result.points[0].step == 0
        assert result.points[0].energy == pytest.approx(-201.040130)
        assert result.points[0].max_force == pytest.approx(9.461488)
        assert result.points[-1].max_force == pytest.approx(0.03)
        assert result.converged is True  # 0.03 <= 0.05

    def test_bfgs_log(self, tmp_path):
        body = """BFGS:    0 14:10:01      -11.234567        0.123456
BFGS:    1 14:10:03      -11.240000        0.019000
"""
        result = parse_ase_opt_log(_write(tmp_path, body), fmax_target=0.05)
        assert result.success
        assert result.converged is True
        assert len(result.points) == 2
        assert result.points[-1].max_force == pytest.approx(0.019)

    def test_non_converged(self, tmp_path):
        body = """FIRE:    0 14:10:01     -100.0        1.5
FIRE:    1 14:10:03     -100.5        1.2
"""
        result = parse_ase_opt_log(_write(tmp_path, body), fmax_target=0.05)
        assert result.success
        assert result.converged is False
        assert "step 1" in result.message
        assert "fmax=1.200" in result.message


class TestScientificNotation:
    """C-audit-B1 regression: near-converged lines emit scientific notation.

    Prior regex `-?\\d+\\.\\d+` dropped these silently, causing `converged`
    to use a stale earlier iteration as the last valid data point.
    """

    def test_fmax_in_scientific_notation(self, tmp_path):
        body = """FIRE:   47 09:03:12     -300.123456       1.23e-03
"""
        result = parse_ase_opt_log(_write(tmp_path, body), fmax_target=0.05)
        assert result.success
        assert len(result.points) == 1
        assert result.points[0].max_force == pytest.approx(1.23e-3)
        assert result.converged is True

    def test_mixed_decimal_and_scientific(self, tmp_path):
        body = """FIRE:    0 14:10:01     -201.04        9.4
FIRE:    1 14:10:03     -201.50        0.9e-01
FIRE:    2 14:10:05     -201.60        4.2E-03
"""
        result = parse_ase_opt_log(_write(tmp_path, body), fmax_target=0.05)
        assert result.success
        assert len(result.points) == 3
        assert result.points[1].max_force == pytest.approx(0.09)
        assert result.points[2].max_force == pytest.approx(0.0042)
        assert result.converged is True

    def test_energy_in_scientific_notation(self, tmp_path):
        body = """FIRE:    0 14:10:01     -1.234567e+02        0.02
"""
        result = parse_ase_opt_log(_write(tmp_path, body))
        assert result.success
        assert result.points[0].energy == pytest.approx(-123.4567)


class TestEdgeCases:
    def test_missing_file(self):
        result = parse_ase_opt_log("/nonexistent/path/opt.log")
        assert result.success is False
        assert "not found" in result.message.lower()

    def test_empty_path(self):
        result = parse_ase_opt_log("")
        assert result.success is False

    def test_empty_file(self, tmp_path):
        result = parse_ase_opt_log(_write(tmp_path, ""))
        assert result.success is True  # file exists, just no data
        assert result.points == []
        assert result.converged is False
        assert result.message == "No iterations logged yet"

    def test_header_only(self, tmp_path):
        result = parse_ase_opt_log(_write(tmp_path, "      Step     Time          Energy          fmax\n"))
        assert result.success is True
        assert result.points == []

    def test_malformed_lines_skipped(self, tmp_path):
        body = """FIRE:    0 14:10:01     -100.0        1.5
garbage line that does not match anything
FIRE:    1 14:10:03     -100.5        1.2
     Step     Time          Energy          fmax
FIRE:    2 14:10:05     -101.0        0.8
"""
        result = parse_ase_opt_log(_write(tmp_path, body))
        assert result.success
        assert [p.step for p in result.points] == [0, 1, 2]

    def test_unreadable_bytes_replaced(self, tmp_path):
        p = tmp_path / "opt.log"
        p.write_bytes(
            b"FIRE:    0 14:10:01     -201.04        9.4\n"
            b"\xff\xfe malformed \x00\n"
            b"FIRE:    1 14:10:03     -201.50        0.9\n"
        )
        result = parse_ase_opt_log(str(p))
        assert result.success
        assert len(result.points) == 2


class TestFmaxTarget:
    def test_default_target_005(self, tmp_path):
        body = "FIRE:    0 14:10:01     -100.0        0.04\n"
        result = parse_ase_opt_log(_write(tmp_path, body))
        assert result.converged is True  # 0.04 <= 0.05 default

    def test_custom_target(self, tmp_path):
        body = "FIRE:    0 14:10:01     -100.0        0.04\n"
        result = parse_ase_opt_log(_write(tmp_path, body), fmax_target=0.01)
        assert result.converged is False

    def test_exact_target(self, tmp_path):
        body = "FIRE:    0 14:10:01     -100.0        0.05\n"
        result = parse_ase_opt_log(_write(tmp_path, body), fmax_target=0.05)
        assert result.converged is True  # uses <=
