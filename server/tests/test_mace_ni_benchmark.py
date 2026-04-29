"""Regression tests for MACE Ni benchmark engine infrastructure.

The frontend ships its own hardcoded "UMA Catalysis Tutorial" preset in
`src/lib/workflow/graph-model.ts::uma_catalysis_screening`, so there is
no backend preset to exercise here. These tests cover the engine-level
plumbing the benchmark relies on — the same plumbing any MACE workflow
needs:

  - C1 reproducibility metadata preamble + footer in every MLP script
  - device / model_path params wired through
  - C2 is_valid_ts flag + 20 cm⁻¹ trivial-mode filter on freq results

The slow end-to-end smoke test runs a real MACE relax via subprocess
(matches `execute_mlp_local`). Run manually with
``pytest -m slow server/tests/test_mace_ni_benchmark.py``.
"""

import ast
import json
import subprocess
import sys

import pytest


# ---------------------------------------------------------------------------
# 1. Metadata preamble (C1)
# ---------------------------------------------------------------------------

class TestMetadataPreamble:
    """The C1 footer writes metadata.json; every MLP script must include it."""

    @pytest.mark.parametrize("node_type", [
        "mlp_single_point", "mlp_relax", "mlp_vibrations", "mlp_neb",
    ])
    def test_script_writes_metadata_json(self, node_type):
        from workflow.engines.mlp import _build_mlp_script
        script = _build_mlp_script(node_type, "MACE", {})
        ast.parse(script)
        assert "metadata.json" in script
        assert "wall_time_s" in script
        assert "mace_torch_version" in script or "__mace_model_name" in script

    def test_script_captures_device_param(self):
        from workflow.engines.mlp import _build_mlp_script
        script = _build_mlp_script("mlp_relax", "MACE", {"device": "cpu"})
        ast.parse(script)
        # Device should be honored, not silently defaulted to auto.
        assert '"cpu"' in script or "'cpu'" in script


# ---------------------------------------------------------------------------
# 2. is_valid_ts flag (C2)
# ---------------------------------------------------------------------------

class TestIsValidTsFlag:
    """C2 adds is_valid_ts / n_nontrivial_imag / dominant_imag_freq_cm."""

    def test_script_emits_is_valid_ts(self):
        from workflow.engines.mlp import _build_mlp_script
        script = _build_mlp_script("mlp_vibrations", "MACE", {})
        ast.parse(script)
        assert "is_valid_ts" in script
        assert "dominant_imag_freq_cm" in script
        assert "n_nontrivial_imag" in script

    def test_script_applies_20cm_trivial_mode_filter(self):
        from workflow.engines.mlp import _build_mlp_script
        script = _build_mlp_script("mlp_vibrations", "MACE", {})
        # The 20 cm⁻¹ cutoff from C2 filters translation/rotation modes so a
        # real TS isn't flagged as "not a TS" just because it has 6 extra
        # near-zero modes.
        assert "20" in script


# ---------------------------------------------------------------------------
# 3. HPC Jinja template coverage (F2 fix)
# ---------------------------------------------------------------------------

class TestHpcTemplateCoverage:
    """All 5 MLP node types must render to valid Python in the HPC template.

    Pre-F2 the template only had mlp_relax and mlp_md branches; HPC runs of
    mlp_single_point / mlp_vibrations / mlp_neb failed at runtime with
    RuntimeError("Unknown MLP node type").
    """

    @pytest.fixture(scope="class")
    def template(self):
        import os
        try:
            import jinja2
        except ImportError:
            pytest.skip("jinja2 not installed")
            return None  # unreachable — pytest.skip raises
        base = "server/workflow/templates" if os.path.isdir("server") else "workflow/templates"
        env = jinja2.Environment(loader=jinja2.FileSystemLoader(base))
        return env.get_template("mlp/run_mlp.py.j2")

    @pytest.mark.parametrize("node_type", [
        "mlp_relax", "mlp_md", "mlp_single_point", "mlp_vibrations", "mlp_neb",
    ])
    def test_node_type_renders_valid_python(self, template, node_type):
        rendered = template.render(node_type=node_type, params={"model": "mace-mp-0"})
        ast.parse(rendered)
        # Should NOT fall through to the error branch.
        assert "Unknown MLP node type" not in rendered

    @pytest.mark.parametrize("model", ["mace-mp-0", "chgnet", "m3gnet"])
    def test_every_model_renders_for_relax(self, template, model):
        rendered = template.render(node_type="mlp_relax", params={"model": model})
        ast.parse(rendered)
        assert "Unknown ML model" not in rendered


# ---------------------------------------------------------------------------
# 4. Optional slow end-to-end (requires MACE + torch + ASE)
# ---------------------------------------------------------------------------

@pytest.mark.slow
class TestEndToEndSmoke:
    """Run a tiny MACE calculation and verify metadata lands in result_json.

    Skipped unless ``pytest -m slow`` is passed. Requires mace-torch, torch,
    and ASE to be importable; otherwise the test is skipped at runtime.
    """

    @pytest.fixture(scope="class")
    def mace_available(self):
        # Probe availability so the test is skipped (not errored) on machines
        # without mace-torch / torch / ase installed. Imports are re-done in
        # the test body — the fixture's only job is the skip check.
        try:
            import mace  # noqa: F401
            import torch  # noqa: F401
            import ase  # noqa: F401
        except ImportError:
            pytest.skip("mace-torch / torch / ase not installed — skipping slow smoke")
        return True

    def test_relax_script_runs_on_two_atom_ni(self, mace_available, tmp_path):
        """Relax a 2-atom Ni bulk with MACE. ~30 s on CPU.

        Matches the production path: we invoke the generated script as a
        subprocess, exactly how ``execute_mlp_local`` does, instead of
        importing it into the pytest process.
        """
        from ase.build import bulk
        from ase.io import write as ase_write
        from workflow.engines.mlp import _build_mlp_script

        atoms = bulk("Ni", cubic=False)
        ase_write(str(tmp_path / "POSCAR"), atoms, format="vasp")

        params = {
            "device": "cpu",
            "fmax": 0.05,
            "max_steps": 20,
            "relax_cell": False,
            "mlp_optimizer": "FIRE",
        }
        script = _build_mlp_script("mlp_relax", "MACE", params)
        script_path = tmp_path / "run_mlp.py"
        script_path.write_text(script)

        proc = subprocess.run(
            [sys.executable, str(script_path)],
            cwd=str(tmp_path),
            capture_output=True,
            text=True,
            timeout=300,
        )
        assert proc.returncode == 0, (
            f"MACE relax failed (rc={proc.returncode}):\n"
            f"STDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
        )

        meta = tmp_path / "metadata.json"
        assert meta.exists(), "Smoke run did not emit metadata.json"
        meta_data = json.loads(meta.read_text())
        # Spot-check reproducibility fields — exact values depend on the
        # installed mace / torch versions.
        for key in ("wall_time_s", "host", "timestamp", "mace_torch_version"):
            assert key in meta_data, f"metadata.json missing {key}"
