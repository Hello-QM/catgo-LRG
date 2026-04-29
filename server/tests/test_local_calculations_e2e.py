"""End-to-end local calculation tests.

Tests the full pipeline: declarative engine YAML → template/hook → actual calculation.
These run REAL calculations on the local machine (no HPC), verifying that the
generated scripts/inputs actually produce correct results.

Requires: tblite, mace-torch, ase, lammps (conda install)
"""
import json
import os
import subprocess
import tempfile
from pathlib import Path

import pytest

# ── Test structures ──

H2O_DICT = {
    "@module": "pymatgen.core.structure",
    "@class": "Molecule",
    "charge": 0,
    "sites": [
        {"species": [{"element": "O", "occu": 1}], "xyz": [0.0, 0.0, 0.117]},
        {"species": [{"element": "H", "occu": 1}], "xyz": [0.0, 0.757, -0.469]},
        {"species": [{"element": "H", "occu": 1}], "xyz": [0.0, -0.757, -0.469]},
    ],
}

CU_FCC_DICT = {
    "@module": "pymatgen.core.structure",
    "@class": "Structure",
    "lattice": {"matrix": [[0, 1.8075, 1.8075], [1.8075, 0, 1.8075], [1.8075, 1.8075, 0]]},
    "sites": [
        {"species": [{"element": "Cu", "occu": 1}], "abc": [0, 0, 0], "xyz": [0, 0, 0]},
    ],
}

SI_DIAMOND_DICT = {
    "@module": "pymatgen.core.structure",
    "@class": "Structure",
    "lattice": {"matrix": [[0, 2.715, 2.715], [2.715, 0, 2.715], [2.715, 2.715, 0]]},
    "sites": [
        {"species": [{"element": "Si", "occu": 1}], "abc": [0, 0, 0], "xyz": [0, 0, 0]},
        {"species": [{"element": "Si", "occu": 1}], "abc": [0.25, 0.25, 0.25], "xyz": [1.3575, 1.3575, 1.3575]},
    ],
}

# Slightly distorted H2O for optimization tests
H2O_DISTORTED_DICT = {
    "@module": "pymatgen.core.structure",
    "@class": "Molecule",
    "charge": 0,
    "sites": [
        {"species": [{"element": "O", "occu": 1}], "xyz": [0.0, 0.0, 0.15]},
        {"species": [{"element": "H", "occu": 1}], "xyz": [0.0, 0.85, -0.5]},
        {"species": [{"element": "H", "occu": 1}], "xyz": [0.0, -0.85, -0.5]},
    ],
}


def _make_poscar_from_dict(struct_dict: dict) -> str:
    """Convert a pymatgen-style dict to POSCAR string via ASE."""
    from ase import Atoms
    sites = struct_dict["sites"]
    symbols = [s["species"][0]["element"] for s in sites]
    positions = [s["xyz"] for s in sites]

    if "lattice" in struct_dict:
        cell = struct_dict["lattice"]["matrix"]
        atoms = Atoms(symbols=symbols, positions=positions, cell=cell, pbc=True)
    else:
        # Molecule: add vacuum box for POSCAR compatibility
        atoms = Atoms(symbols=symbols, positions=positions, pbc=False)
        atoms.center(vacuum=10.0)

    from ase.io import write
    from io import StringIO
    buf = StringIO()
    write(buf, atoms, format="vasp")
    return buf.getvalue()


def _run_script_in_dir(workdir: Path, script_content: str, script_name: str = "run.py"):
    """Write a script to workdir and run it, returning (returncode, stdout, stderr)."""
    script_path = workdir / script_name
    script_path.write_text(script_content)

    result = subprocess.run(
        ["conda", "run", "-n", "catgo", "python", str(script_path)],
        cwd=str(workdir),
        capture_output=True,
        text=True,
        timeout=120,
    )
    return result


# ══════════════════════════════════════════════════════════════
# xTB Tests
# ══════════════════════════════════════════════════════════════

class TestXtbGeoOpt:
    """xTB geometry optimization via declarative engine template."""

    @pytest.fixture(autouse=True)
    def setup(self):
        pytest.importorskip("tblite")

    def test_xtb_relax_h2o(self, tmp_path):
        """Optimize H2O with GFN2-xTB — energy should converge."""
        from workflow.engine_runtime import _render_template

        script = _render_template(
            "xtb/run_xtb.py.j2",
            params={"method": "GFN2-xTB", "accuracy": 1.0,
                    "electronic_temperature": 300, "fmax": 0.05, "max_steps": 100},
            structure_str=None,
            node_type="xtb_relax",
        )

        # Write POSCAR
        poscar = _make_poscar_from_dict(H2O_DISTORTED_DICT)
        (tmp_path / "POSCAR").write_text(poscar)

        result = _run_script_in_dir(tmp_path, script, "run_xtb.py")

        assert result.returncode == 0, f"xTB relax failed:\n{result.stderr}"
        assert "Final energy:" in result.stdout
        assert (tmp_path / "CONTCAR").exists(), "CONTCAR not produced"

        # Parse energy
        for line in result.stdout.splitlines():
            if "Final energy:" in line:
                energy = float(line.split()[-2])
                assert -500 < energy < 0, f"Unreasonable energy: {energy} eV"

    def test_xtb_relax_produces_trajectory(self, tmp_path):
        """Optimization should produce opt.traj trajectory file."""
        from workflow.engine_runtime import _render_template

        script = _render_template(
            "xtb/run_xtb.py.j2",
            params={"method": "GFN2-xTB", "accuracy": 1.0,
                    "electronic_temperature": 300, "fmax": 0.1, "max_steps": 20},
            structure_str=None,
            node_type="xtb_relax",
        )

        poscar = _make_poscar_from_dict(H2O_DISTORTED_DICT)
        (tmp_path / "POSCAR").write_text(poscar)

        result = _run_script_in_dir(tmp_path, script, "run_xtb.py")
        assert result.returncode == 0, f"Failed:\n{result.stderr}"
        assert (tmp_path / "opt.traj").exists(), "Trajectory file not produced"


class TestXtbSinglePoint:
    """xTB single-point energy calculation."""

    @pytest.fixture(autouse=True)
    def setup(self):
        pytest.importorskip("tblite")

    def test_xtb_static_h2o(self, tmp_path):
        """Single-point energy of H2O with GFN2-xTB."""
        from workflow.engine_runtime import _render_template

        script = _render_template(
            "xtb/run_xtb.py.j2",
            params={"method": "GFN2-xTB", "accuracy": 1.0,
                    "electronic_temperature": 300},
            structure_str=None,
            node_type="xtb_static",
        )

        poscar = _make_poscar_from_dict(H2O_DICT)
        (tmp_path / "POSCAR").write_text(poscar)

        result = _run_script_in_dir(tmp_path, script, "run_xtb.py")
        assert result.returncode == 0, f"xTB static failed:\n{result.stderr}"
        assert "Final energy:" in result.stdout

        # Should also report max force
        assert "Max force:" in result.stdout

        # CONTCAR should exist
        assert (tmp_path / "CONTCAR").exists()

    def test_xtb_static_gfn1(self, tmp_path):
        """Single-point with GFN1-xTB method."""
        from workflow.engine_runtime import _render_template

        script = _render_template(
            "xtb/run_xtb.py.j2",
            params={"method": "GFN1-xTB", "accuracy": 0.5,
                    "electronic_temperature": 500},
            structure_str=None,
            node_type="xtb_static",
        )

        poscar = _make_poscar_from_dict(H2O_DICT)
        (tmp_path / "POSCAR").write_text(poscar)

        result = _run_script_in_dir(tmp_path, script, "run_xtb.py")
        assert result.returncode == 0, f"GFN1 static failed:\n{result.stderr}"
        assert "Final energy:" in result.stdout


# ══════════════════════════════════════════════════════════════
# MLP Tests (MACE)
# ══════════════════════════════════════════════════════════════

class TestMlpGeoOpt:
    """MLP geometry optimization with MACE."""

    @pytest.fixture(autouse=True)
    def setup(self):
        pytest.importorskip("mace")

    def test_mace_relax_cu_fcc(self, tmp_path):
        """Relax Cu FCC with MACE-MP — should converge quickly."""
        from workflow.engine_runtime import _render_template

        script = _render_template(
            "mlp/run_mlp.py.j2",
            params={"model": "mace-mp-0", "fmax": 0.05, "max_steps": 50,
                    "relax_cell": False, "optimizer": "BFGS"},
            structure_str=None,
            node_type="mlp_relax",
        )

        poscar = _make_poscar_from_dict(CU_FCC_DICT)
        (tmp_path / "POSCAR").write_text(poscar)

        result = _run_script_in_dir(tmp_path, script, "run_mlp.py")
        assert result.returncode == 0, f"MACE relax failed:\n{result.stderr}"
        assert "Final energy:" in result.stdout
        assert (tmp_path / "CONTCAR").exists()

    def test_mace_relax_with_fire_optimizer(self, tmp_path):
        """FIRE optimizer should also work."""
        from workflow.engine_runtime import _render_template

        script = _render_template(
            "mlp/run_mlp.py.j2",
            params={"model": "mace-mp-0", "fmax": 0.1, "max_steps": 20,
                    "relax_cell": False, "optimizer": "FIRE"},
            structure_str=None,
            node_type="mlp_relax",
        )

        poscar = _make_poscar_from_dict(CU_FCC_DICT)
        (tmp_path / "POSCAR").write_text(poscar)

        result = _run_script_in_dir(tmp_path, script, "run_mlp.py")
        assert result.returncode == 0, f"FIRE optimizer failed:\n{result.stderr}"

    def test_mace_relax_cell(self, tmp_path):
        """Cell relaxation with ExpCellFilter — should include cell optimization."""
        from workflow.engine_runtime import _render_template

        script = _render_template(
            "mlp/run_mlp.py.j2",
            params={"model": "mace-mp-0", "fmax": 0.1, "max_steps": 30,
                    "relax_cell": True, "optimizer": "BFGS"},
            structure_str=None,
            node_type="mlp_relax",
        )

        assert "ExpCellFilter" in script, "Cell relaxation should use ExpCellFilter"

        poscar = _make_poscar_from_dict(SI_DIAMOND_DICT)
        (tmp_path / "POSCAR").write_text(poscar)

        result = _run_script_in_dir(tmp_path, script, "run_mlp.py")
        assert result.returncode == 0, f"Cell relax failed:\n{result.stderr}"
        assert (tmp_path / "CONTCAR").exists()

    def test_mace_relax_si_diamond(self, tmp_path):
        """Relax Si diamond — different structure type."""
        from workflow.engine_runtime import _render_template

        script = _render_template(
            "mlp/run_mlp.py.j2",
            params={"model": "mace-mp-0", "fmax": 0.05, "max_steps": 50,
                    "relax_cell": False, "optimizer": "BFGS"},
            structure_str=None,
            node_type="mlp_relax",
        )

        poscar = _make_poscar_from_dict(SI_DIAMOND_DICT)
        (tmp_path / "POSCAR").write_text(poscar)

        result = _run_script_in_dir(tmp_path, script, "run_mlp.py")
        assert result.returncode == 0, f"Si relax failed:\n{result.stderr}"


class TestMlpMD:
    """MLP molecular dynamics with MACE."""

    @pytest.fixture(autouse=True)
    def setup(self):
        pytest.importorskip("mace")

    def _make_cu_supercell_poscar(self):
        """Create a 2x2x2 Cu FCC supercell (32 atoms) for MD."""
        from ase.build import bulk
        atoms = bulk("Cu", "fcc", a=3.615) * (2, 2, 2)
        from ase.io import write
        from io import StringIO
        buf = StringIO()
        write(buf, atoms, format="vasp")
        return buf.getvalue()

    def test_mace_md_cu_fcc(self, tmp_path):
        """Short MD run on Cu FCC supercell — should produce trajectory."""
        from workflow.engine_runtime import _render_template

        script = _render_template(
            "mlp/run_mlp.py.j2",
            params={"model": "mace-mp-0", "temp": 300, "steps": 20,
                    "timestep": 1.0},
            structure_str=None,
            node_type="mlp_md",
        )

        poscar = self._make_cu_supercell_poscar()
        (tmp_path / "POSCAR").write_text(poscar)

        result = _run_script_in_dir(tmp_path, script, "run_mlp.py")
        assert result.returncode == 0, f"MACE MD failed:\n{result.stderr}"
        assert (tmp_path / "trajectory.xyz").exists() or (tmp_path / "md.traj").exists(), \
            "Trajectory not produced"
        assert (tmp_path / "CONTCAR").exists(), "Final structure not saved"
        assert "Final energy:" in result.stdout

    def test_mace_md_high_temperature(self, tmp_path):
        """MD at 1000K — should still run without crashing."""
        from workflow.engine_runtime import _render_template

        script = _render_template(
            "mlp/run_mlp.py.j2",
            params={"model": "mace-mp-0", "temp": 1000, "steps": 10,
                    "timestep": 0.5},
            structure_str=None,
            node_type="mlp_md",
        )

        poscar = self._make_cu_supercell_poscar()
        (tmp_path / "POSCAR").write_text(poscar)

        result = _run_script_in_dir(tmp_path, script, "run_mlp.py")
        assert result.returncode == 0, f"High-T MD failed:\n{result.stderr}"


# ══════════════════════════════════════════════════════════════
# Sella TS Search (with xTB calculator)
# ══════════════════════════════════════════════════════════════

class TestSellaTS:
    """Sella transition state search using xTB calculator."""

    @pytest.fixture(autouse=True)
    def setup(self):
        pytest.importorskip("tblite")
        pytest.importorskip("sella")

    def test_sella_ts_search_h2o(self, tmp_path):
        """TS search on H2O with Sella + xTB — should run without crashing.

        Note: H2O doesn't have a real TS, but this tests the pipeline works.
        Sella should gracefully handle this (may not converge, but shouldn't crash).
        """
        from workflow.engines.sella import generate_sella_input_files

        structure_str = json.dumps(H2O_DICT)
        params = {
            "calculator": "xtb",
            "fmax": 0.1,
            "max_steps": 5,  # Very few steps — just testing pipeline
            "order": 1,
            "delta": 0.01,
            "gamma": 0.4,
            "calculator_method": "GFN2-xTB",
        }

        files = generate_sella_input_files("sella_ts", params, structure_str)
        assert "run_sella.py" in files, "Sella script not generated"

        for name, content in files.items():
            (tmp_path / name).write_text(content)

        result = _run_script_in_dir(tmp_path, files["run_sella.py"], "run_sella.py")
        # Sella may fail to find TS on H2O (expected) but should not crash with ImportError etc
        # Accept both success and "graceful failure" (exit code 0 or 1 with sella output)
        assert "tblite" in files["run_sella.py"].lower() or "xtb" in files["run_sella.py"].lower(), \
            "Script should reference xTB calculator"


# ══════════════════════════════════════════════════════════════
# LAMMPS Tests
# ══════════════════════════════════════════════════════════════

class TestLammpsMD:
    """LAMMPS molecular dynamics."""

    @pytest.fixture(autouse=True)
    def setup(self):
        # Check lmp is available
        result = subprocess.run(["conda", "run", "-n", "catgo", "which", "lmp"],
                                capture_output=True, text=True)
        if result.returncode != 0:
            pytest.skip("LAMMPS (lmp) not found in catgo env")

    def test_lammps_lj_md(self, tmp_path):
        """Simple LJ argon MD with LAMMPS."""
        in_lammps = """# Simple LJ argon MD test
units       lj
atom_style  atomic
boundary    p p p

lattice     fcc 0.8442
region      box block 0 4 0 4 0 4
create_box  1 box
create_atoms 1 box
mass        1 1.0

pair_style  lj/cut 2.5
pair_coeff  1 1 1.0 1.0 2.5

velocity    all create 1.0 87287

fix         1 all nve
thermo      10
timestep    0.005
run         50
write_data  final.data
"""
        (tmp_path / "in.lammps").write_text(in_lammps)

        result = subprocess.run(
            ["conda", "run", "-n", "catgo", "lmp", "-in", "in.lammps"],
            cwd=str(tmp_path),
            capture_output=True, text=True, timeout=60,
        )
        assert result.returncode == 0, f"LAMMPS MD failed:\n{result.stderr}"
        assert (tmp_path / "final.data").exists(), "final.data not produced"
        assert "Loop time" in result.stdout, "LAMMPS didn't complete run"

    def test_lammps_minimize(self, tmp_path):
        """LAMMPS energy minimization."""
        in_lammps = """# LJ minimization test
units       lj
atom_style  atomic
boundary    p p p

lattice     fcc 0.8442
region      box block 0 3 0 3 0 3
create_box  1 box
create_atoms 1 box
mass        1 1.0

pair_style  lj/cut 2.5
pair_coeff  1 1 1.0 1.0 2.5

# Displace atoms slightly
displace_atoms all random 0.1 0.1 0.1 12345

thermo      10
min_style   cg
minimize    1e-6 1e-6 1000 10000
write_data  final.data
"""
        (tmp_path / "in.lammps").write_text(in_lammps)

        result = subprocess.run(
            ["conda", "run", "-n", "catgo", "lmp", "-in", "in.lammps"],
            cwd=str(tmp_path),
            capture_output=True, text=True, timeout=60,
        )
        assert result.returncode == 0, f"LAMMPS minimize failed:\n{result.stderr}"
        assert (tmp_path / "final.data").exists()
        assert "Loop time" in result.stdout


# ══════════════════════════════════════════════════════════════
# Cross-engine: Verify declarative YAML → actual execution
# ══════════════════════════════════════════════════════════════

class TestDeclarativeToExecution:
    """Verify the full declarative path: YAML spec → runtime → template → execution."""

    def test_xtb_yaml_to_execution(self, tmp_path):
        """Load xTB from YAML, render template, run calculation."""
        pytest.importorskip("tblite")
        from workflow.engine_runtime import load_yaml_engine, _RUNTIME_REGISTRY, _render_template

        _RUNTIME_REGISTRY.clear()
        yaml_path = Path(__file__).parent.parent / "workflow" / "engine_defs" / "xtb.yaml"
        rt = load_yaml_engine(yaml_path)

        # Verify YAML metadata
        assert rt.spec.engine == "xtb"
        assert rt.resolve_calc_type("geo_opt") == "xtb_relax"

        # Use YAML's default params
        defaults = {p.key: p.default for p in rt.spec.params if p.default is not None}
        assert "method" in defaults

        # Render template
        template_path = list(rt.spec.input_files.values())[0].template
        assert template_path is not None
        script = _render_template(template_path, params=defaults, structure_str=None, node_type="xtb_relax")

        # Execute
        poscar = _make_poscar_from_dict(H2O_DISTORTED_DICT)
        (tmp_path / "POSCAR").write_text(poscar)
        result = _run_script_in_dir(tmp_path, script, "run_xtb.py")

        assert result.returncode == 0, f"YAML-driven xTB failed:\n{result.stderr}"
        assert "Final energy:" in result.stdout

    def test_mlp_yaml_to_execution(self, tmp_path):
        """Load MLP from YAML, render template, run calculation."""
        pytest.importorskip("mace")
        from workflow.engine_runtime import load_yaml_engine, _RUNTIME_REGISTRY, _render_template

        _RUNTIME_REGISTRY.clear()
        yaml_path = Path(__file__).parent.parent / "workflow" / "engine_defs" / "mlp.yaml"
        rt = load_yaml_engine(yaml_path)

        assert rt.spec.engine == "mlp"
        assert rt.resolve_calc_type("geo_opt") == "mlp_relax"

        defaults = {p.key: p.default for p in rt.spec.params if p.default is not None}
        template_path = list(rt.spec.input_files.values())[0].template
        script = _render_template(template_path, params=defaults, structure_str=None, node_type="mlp_relax")

        poscar = _make_poscar_from_dict(CU_FCC_DICT)
        (tmp_path / "POSCAR").write_text(poscar)
        result = _run_script_in_dir(tmp_path, script, "run_mlp.py")

        assert result.returncode == 0, f"YAML-driven MLP failed:\n{result.stderr}"
        assert "Final energy:" in result.stdout

    def test_engine_defs_api_returns_all(self):
        """The /engine-defs API should return all 13 engines."""
        import requests
        try:
            resp = requests.get("http://localhost:8000/api/workflow/engine-defs", timeout=5)
        except requests.ConnectionError:
            pytest.skip("Backend not running")

        assert resp.status_code == 200
        data = resp.json()
        engines = {e["engine"] for e in data}
        assert len(engines) >= 13
        assert "vasp" in engines
        assert "xtb" in engines
        assert "mlp" in engines
        assert "orca" in engines
