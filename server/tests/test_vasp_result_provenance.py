"""Regression tests for realized VASP result provenance."""

import subprocess
import hashlib
import json

import pytest

from catgo.workflow.engine.result_collector import (
    _parse_vasp_metadata,
    _vasp_metadata_command,
)
from catgo.workflow.engine.vasp_submission import (
    build_vasp_input_manifest_command,
    resolve_vasp_command,
)
from catgo.mcp_tools import provenance
from catgo.mcp_tools import verify_gates


def _payload(
    *,
    incar="",
    poscar="",
    kpoints="",
    manifest="",
    input_hashes="",
    outcar="",
    forces="",
    fmax="",
):
    return "\n".join([
        "__CATGO_INCAR__",
        incar,
        "__CATGO_POSCAR__",
        poscar,
        "__CATGO_KPOINTS__",
        kpoints,
        "__CATGO_INPUT_MANIFEST__",
        manifest,
        "__CATGO_INPUT_HASHES__",
        input_hashes,
        "__CATGO_OUTCAR_META__",
        outcar,
        "__CATGO_FORCES__",
        forces,
        "__CATGO_FMAX__",
        fmax,
    ])


def _write_complete_vasp_run(work_dir):
    contents = {
        "INCAR": "GGA = PE\nEDIFFG = -0.02\n",
        "POSCAR": (
            "test\n1\n1 0 0\n0 1 0\n0 0 1\nH\n2\nDirect\n"
            "0 0 0\n0 0 0.5\n"
        ),
        "POTCAR": "PAW_PBE H\n",
        "KPOINTS": "mesh\n0\nGamma\n2 2 1\n0 0 0\n",
    }
    for name, text in contents.items():
        (work_dir / name).write_text(text, encoding="utf-8")
    (work_dir / "OUTCAR").write_text(
        "NIONS = 2\nNELECT = 2\nGGA = PE\n"
        "POTCAR: PAW_PBE H\nfree  energy   TOTEN = -2.1 eV\n",
        encoding="utf-8",
    )
    command = build_vasp_input_manifest_command(
        str(work_dir),
        resolve_vasp_command({"run_command": "srun vasp_std"}, {}),
    )
    completed = subprocess.run(
        ["/bin/sh", "-c", command],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr


def test_parse_realized_fields_and_sources():
    parsed = _parse_vasp_metadata(_payload(
        incar="GGA = PE\nEDIFFG = -0.02",
        kpoints="mesh\n0\nGamma\n3 3 1\n0 0 0",
        outcar="""
 POTCAR: PAW_PBE Fe 06Sep2000
 POTCAR: PAW_PBE O 08Apr2002
 POTCAR: PAW_PBE Fe 06Sep2000
 NIONS = 4
 EDIFFG = -0.200000D-01
 IBRION = 2
 NSW = 100
 NELECT = 32.0000
 GGA = PE
 LEXCH = 8
 free  energy   TOTEN = -123.45600000 eV
""",
        fmax="0.015 4",
    ))

    assert parsed["energy"] == pytest.approx(-123.456)
    assert parsed["n_atoms"] == 4
    assert parsed["fmax"] == pytest.approx(0.015)
    assert parsed["ediffg"] == pytest.approx(-0.02)
    assert parsed["ibrion"] == 2
    assert parsed["nsw"] == 100
    assert parsed["potcar_titels"] == [
        "PAW_PBE Fe 06Sep2000",
        "PAW_PBE O 08Apr2002",
    ]
    assert parsed["nelect"] == pytest.approx(32.0)
    assert parsed["kgrid"] == [3, 3, 1]
    assert parsed["xc_tags"] == {"GGA": "PE", "LEXCH": "8"}
    assert parsed["xc_functional"] == "GGA=PE;LEXCH=8"
    assert "ionic_converged" not in parsed
    assert set(parsed["field_sources"]) >= {
        "energy", "n_atoms", "fmax", "ediffg",
        "potcar_titels", "nelect", "kgrid",
    }


def test_manifest_is_bound_to_live_inputs_and_result(tmp_path):
    _write_complete_vasp_run(tmp_path)
    proc = subprocess.run(
        ["bash", "-c", _vasp_metadata_command(str(tmp_path))],
        check=True,
        capture_output=True,
        text=True,
    )
    parsed = _parse_vasp_metadata(proc.stdout)
    manifest = json.loads(
        (tmp_path / "catgo_vasp_input_manifest.json").read_text(encoding="utf-8")
    )
    canonical = json.dumps(
        manifest,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")

    assert parsed["input_manifest_validated"] is True
    assert parsed["submission_manifest_digest"] == (
        f"sha256:{hashlib.sha256(canonical).hexdigest()}"
    )
    assert parsed["input_hashes"] == {
        name: manifest["inputs"][name]["sha256"]
        for name in ("INCAR", "POSCAR", "POTCAR", "KPOINTS")
    }
    assert parsed["vasp_binary"] == "vasp_std"
    assert parsed["resolved_run_command"] == "srun vasp_std"
    assert parsed["input_policy"] == manifest["input_policy"]
    assert parsed["field_sources"]["input_policy"] == (
        "catgo_vasp_input_manifest.json:input_policy"
    )
    assert parsed["metadata_parser"].endswith("@6")

    wrapped = json.loads(provenance.wrap_payload(
        json.dumps(parsed),
        tool="catgo_energy",
        action="collect",
        inputs={"workflow_id": "wf-1"},
    ))
    assert wrapped["claim"] == "vasp_energy"
    assert "unverifiable_without" not in wrapped
    flat, claims, conflicts = provenance.verification_view(wrapped)
    assert conflicts == {}
    assert claims == ["vasp_energy"]
    assert verify_gates.verifiability(flat, claims)[0]["status"] == "VERIFIABLE"


def test_post_manifest_input_change_fails_closed(tmp_path):
    _write_complete_vasp_run(tmp_path)
    (tmp_path / "INCAR").write_text(
        "GGA = PE\nEDIFFG = -0.02\nENCUT = 400\n",
        encoding="utf-8",
    )
    proc = subprocess.run(
        ["bash", "-c", _vasp_metadata_command(str(tmp_path))],
        check=True,
        capture_output=True,
        text=True,
    )
    parsed = _parse_vasp_metadata(proc.stdout)

    assert parsed["input_manifest_validated"] is False
    assert "inputs.INCAR.live_hash" in parsed["input_manifest_errors"]
    for field in (
        "submission_manifest_digest",
        "input_hashes",
        "vasp_binary",
        "resolved_run_command",
    ):
        assert field not in parsed

    wrapped = json.loads(provenance.wrap_payload(
        json.dumps(parsed),
        tool="catgo_energy",
        action="collect",
        inputs={"workflow_id": "wf-1"},
    ))
    assert wrapped["claim"] == "vasp_energy"
    assert set(wrapped["unverifiable_without"]) >= {
        "submission_manifest_digest",
        "input_hashes",
        "vasp_binary",
        "resolved_run_command",
    }
    flat, claims, conflicts = provenance.verification_view(wrapped)
    assert conflicts == {}
    assert verify_gates.verifiability(flat, claims)[0]["status"] == "UNVERIFIABLE"


def test_constant_potential_keeps_initial_and_final_nelect():
    parsed = _parse_vasp_metadata(_payload(
        outcar="NELECT = 32.0\nNELECT = 32.25\nNELECT = 32.50",
    ))

    assert parsed["nelect"] == pytest.approx(32.5)
    assert parsed["nelect_initial"] == pytest.approx(32.0)
    assert parsed["nelect_final"] == pytest.approx(32.5)
    assert parsed["field_sources"]["nelect"] == "OUTCAR:last_NELECT"


@pytest.mark.parametrize(
    ("incar", "kpoints"),
    [
        ("", "line path\n20\nLine-mode\nReciprocal\n0 0 0\n0.5 0 0"),
        ("", "malformed"),
    ],
)
def test_does_not_infer_kgrid_when_mesh_is_not_authoritative(incar, kpoints):
    parsed = _parse_vasp_metadata(_payload(
        incar=incar,
        kpoints=kpoints,
        outcar="free  energy   TOTEN = -1.0 eV",
    ))
    assert "kgrid" not in parsed


def test_explicit_kpoints_mesh_wins_over_kspacing():
    parsed = _parse_vasp_metadata(_payload(
        incar="KSPACING = 0.25",
        kpoints="mesh\n0\nGamma\n3 3 1\n0 0 0",
        outcar="free  energy   TOTEN = -1.0 eV",
    ))
    assert parsed["kgrid"] == [3, 3, 1]
    assert parsed["kpoint_source"] == "KPOINTS"


def test_kspacing_without_kpoints_is_verifiable_end_to_end(tmp_path):
    contents = {
        "INCAR": "GGA = PE\nEDIFFG = -0.02\nKSPACING = 0.25\n",
        "POSCAR": (
            "test\n1\n1 0 0\n0 1 0\n0 0 1\nH\n2\nDirect\n"
            "0 0 0\n0 0 0.5\n"
        ),
        "POTCAR": "PAW_PBE H\n",
    }
    for name, text in contents.items():
        (tmp_path / name).write_text(text, encoding="utf-8")
    (tmp_path / "OUTCAR").write_text(
        "NIONS = 2\nNELECT = 2\nGGA = PE\n"
        "POTCAR: PAW_PBE H\n"
        "generate k-points for:   10   9   1\n"
        "free  energy   TOTEN = -2.1 eV\n",
        encoding="utf-8",
    )
    command = build_vasp_input_manifest_command(
        str(tmp_path),
        resolve_vasp_command({"run_command": "srun vasp_std"}, {}),
    )
    completed = subprocess.run(
        ["/bin/sh", "-c", command],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr

    proc = subprocess.run(
        ["bash", "-c", _vasp_metadata_command(str(tmp_path))],
        check=True,
        capture_output=True,
        text=True,
    )
    assert "KPOINTS ABSENT" in proc.stdout
    parsed = _parse_vasp_metadata(proc.stdout)
    assert parsed["input_manifest_validated"] is True
    assert parsed["input_hashes"]["KPOINTS"] is None
    assert parsed["kpoint_source"] == "INCAR:KSPACING"
    assert parsed["kspacing"] == pytest.approx(0.25)
    assert parsed["kgrid"] == [10, 9, 1]

    wrapped = json.loads(provenance.wrap_payload(
        json.dumps(parsed),
        tool="catgo_energy",
        action="collect",
        inputs={"workflow_id": "wf-kspacing"},
    ))
    assert "unverifiable_without" not in wrapped
    flat, claims, conflicts = provenance.verification_view(wrapped)
    assert conflicts == {}
    assert claims == ["vasp_energy"]
    assert verify_gates.verifiability(flat, claims)[0]["status"] == "VERIFIABLE"


def test_last_outcar_generated_mesh_wins_for_kspacing():
    parsed = _parse_vasp_metadata(_payload(
        incar="KSPACING = 0.25",
        outcar=(
            "generate k-points for: 2 2 1\n"
            "generate k-points for: 4 3 1\n"
        ),
    ))
    assert parsed["kgrid"] == [4, 3, 1]


def test_line_mode_kpoints_does_not_borrow_generated_mesh():
    parsed = _parse_vasp_metadata(_payload(
        incar="KSPACING = 0.25",
        kpoints="path\n20\nLine-mode\nReciprocal\n0 0 0\n0.5 0 0",
        outcar="generate k-points for: 4 3 1",
    ))
    assert parsed["kpoint_source"] == "KPOINTS"
    assert "kgrid" not in parsed


@pytest.mark.parametrize(
    "hashes",
    [
        {"INCAR": "a" * 64, "POSCAR": "b" * 64,
         "POTCAR": "c" * 64, "KPOINTS": None},
        {"INCAR": "a" * 64, "POSCAR": "b" * 64,
         "POTCAR": "c" * 64, "KPOINTS": "d" * 64},
    ],
)
def test_input_hash_validators_accept_present_or_declared_absent_kpoints(hashes):
    assert provenance._valid_provenance_value("input_hashes", hashes)
    assert verify_gates._provenance_value_present("input_hashes", hashes)


@pytest.mark.parametrize("name", ["INCAR", "POSCAR", "POTCAR"])
def test_input_hash_validators_reject_missing_core_hash(name):
    hashes = {
        "INCAR": "a" * 64,
        "POSCAR": "b" * 64,
        "POTCAR": "c" * 64,
        "KPOINTS": None,
    }
    hashes[name] = None
    assert not provenance._valid_provenance_value("input_hashes", hashes)
    assert not verify_gates._provenance_value_present("input_hashes", hashes)


@pytest.mark.parametrize(
    ("kpoints_hash", "source", "kspacing"),
    [
        (None, "KPOINTS", 0.25),
        (None, "INCAR:KSPACING", None),
        (None, "INCAR:KSPACING", 0.0),
        ("d" * 64, "INCAR:KSPACING", 0.25),
    ],
)
def test_vasp_verifiability_rejects_inconsistent_kpoint_provenance(
    kpoints_hash, source, kspacing,
):
    result = {
        "energy": -1.0,
        "n_atoms": 1,
        "xc_functional": "GGA=PE",
        "potcar_titels": ["PAW_PBE H"],
        "nelect": 1.0,
        "kgrid": [1, 1, 1],
        "submission_manifest_digest": "sha256:" + "e" * 64,
        "input_hashes": {
            "INCAR": "a" * 64,
            "POSCAR": "b" * 64,
            "POTCAR": "c" * 64,
            "KPOINTS": kpoints_hash,
        },
        "vasp_binary": "vasp_std",
        "resolved_run_command": "srun vasp_std",
        "kpoint_source": source,
        "kspacing": kspacing,
    }
    verdict = verify_gates.verifiability(result, ["vasp_energy"])[0]
    assert verdict["status"] == "UNVERIFIABLE"


def test_missing_fields_stay_missing():
    parsed = _parse_vasp_metadata(_payload(
        outcar="free  energy   TOTEN = -1.0 eV",
    ))
    assert parsed["energy"] == pytest.approx(-1.0)
    for field in (
        "n_atoms", "fmax", "ediffg", "potcar_titels", "nelect",
        "kgrid", "solvation", "ionic_converged", "xc_functional",
    ):
        assert field not in parsed


def test_shell_command_quotes_path_and_uses_last_force_block(tmp_path):
    work_dir = tmp_path / "run with space's"
    work_dir.mkdir()
    (work_dir / "INCAR").write_text("EDIFFG = -0.02\n", encoding="utf-8")
    (work_dir / "KPOINTS").write_text(
        "mesh\n0\nGamma\n2 2 1\n0 0 0\n", encoding="utf-8"
    )
    (work_dir / "POSCAR").write_text(
        "test\n1\n1 0 0\n0 1 0\n0 0 1\nH\n2\nDirect\n"
        "0 0 0\n0 0 0.5\n",
        encoding="utf-8",
    )
    (work_dir / "OUTCAR").write_text(
        """
 NIONS = 2
 NELECT = 12
 free  energy   TOTEN = -2.0 eV
 POSITION                                       TOTAL-FORCE (eV/Angst)
 -----------------------------------------------------------------------------------
 0 0 0  3.0 4.0 0.0
 0 0 1  0.0 0.0 1.0
 -----------------------------------------------------------------------------------
 free  energy   TOTEN = -2.1 eV
 POSITION                                       TOTAL-FORCE (eV/Angst)
 -----------------------------------------------------------------------------------
 0 0 0  0.3 0.4 0.0
 0 0 1  0.0 0.0 0.2
 -----------------------------------------------------------------------------------
""",
        encoding="utf-8",
    )

    proc = subprocess.run(
        ["bash", "-c", _vasp_metadata_command(str(work_dir))],
        check=True,
        capture_output=True,
        text=True,
    )
    parsed = _parse_vasp_metadata(proc.stdout)

    assert parsed["fmax"] == pytest.approx(0.5)
    assert parsed["energy"] == pytest.approx(-2.1)
    assert parsed["kgrid"] == [2, 2, 1]


def test_partial_latest_force_block_does_not_reuse_stale_fmax(tmp_path):
    work_dir = tmp_path / "restart"
    work_dir.mkdir()
    (work_dir / "INCAR").write_text("EDIFFG = -0.02\n", encoding="utf-8")
    (work_dir / "KPOINTS").write_text(
        "mesh\n0\nGamma\n2 2 1\n0 0 0\n", encoding="utf-8"
    )
    (work_dir / "POSCAR").write_text(
        "test\n1\n1 0 0\n0 1 0\n0 0 1\nH\n2\nDirect\n"
        "0 0 0\n0 0 0.5\n",
        encoding="utf-8",
    )
    (work_dir / "OUTCAR").write_text(
        """
 vasp.6.4.0
 NIONS = 2
 IBRION = 2
 NSW = 50
 free  energy   TOTEN = -2.0 eV
 POSITION                                       TOTAL-FORCE (eV/Angst)
 -----------------------------------------------------------------------------------
 0 0 0  0.3 0.4 0.0
 0 0 1  0.0 0.0 0.2
 -----------------------------------------------------------------------------------
 reached required accuracy - stopping structural energy minimisation
 vasp.6.4.0
 NIONS = 2
 IBRION = 2
 NSW = 50
 free  energy   TOTEN = -1.0 eV
 POSITION                                       TOTAL-FORCE (eV/Angst)
 -----------------------------------------------------------------------------------
 0 0 0  9.0 0.0 0.0
""",
        encoding="utf-8",
    )

    proc = subprocess.run(
        ["bash", "-c", _vasp_metadata_command(str(work_dir))],
        check=True,
        capture_output=True,
        text=True,
    )
    parsed = _parse_vasp_metadata(proc.stdout)

    assert parsed["energy"] == pytest.approx(-1.0)
    assert "fmax" not in parsed
    assert "ionic_converged" not in parsed


def test_fmax_requires_nions_rows():
    parsed = _parse_vasp_metadata(_payload(
        outcar="NIONS = 4\nfree  energy   TOTEN = -1.0 eV",
        fmax="0.015 3",
    ))
    assert "fmax" not in parsed


def test_static_high_force_is_not_mislabeled_failed_relaxation():
    from catgo.mcp_tools.verify_gates import audit

    parsed = _parse_vasp_metadata(_payload(
        outcar=(
            "NIONS = 2\nIBRION = -1\nNSW = 0\nEDIFFG = -0.02\n"
            "free  energy   TOTEN = -1.0 eV"
        ),
        fmax="0.5 2",
    ))
    status = {
        verdict["gate"]: verdict["status"]
        for verdict in audit(parsed)["verdicts"]
    }
    assert parsed["ibrion"] == -1
    assert parsed["nsw"] == 0
    assert status["force_convergence"] == "SKIP"


def test_overflow_force_token_invalidates_complete_block(tmp_path):
    work_dir = tmp_path / "overflow"
    work_dir.mkdir()
    (work_dir / "INCAR").write_text("EDIFFG = -0.02\n", encoding="utf-8")
    (work_dir / "KPOINTS").write_text(
        "mesh\n0\nGamma\n2 2 1\n0 0 0\n", encoding="utf-8"
    )
    (work_dir / "POSCAR").write_text(
        "test\n1\n1 0 0\n0 1 0\n0 0 1\nH\n2\nDirect\n"
        "0 0 0\n0 0 0.5\n",
        encoding="utf-8",
    )
    (work_dir / "OUTCAR").write_text(
        """
 NIONS = 2
 free  energy   TOTEN = -1.0 eV
 POSITION                                       TOTAL-FORCE (eV/Angst)
 -----------------------------------------------------------------------------------
 0 0 0  0.1 0.0 0.0
 0 0 1  ******** ******** ********
 -----------------------------------------------------------------------------------
""",
        encoding="utf-8",
    )

    proc = subprocess.run(
        ["bash", "-c", _vasp_metadata_command(str(work_dir))],
        check=True,
        capture_output=True,
        text=True,
    )
    parsed = _parse_vasp_metadata(proc.stdout)

    assert parsed["energy"] == pytest.approx(-1.0)
    assert "fmax" not in parsed


def test_mixed_selective_dynamics_omits_fmax_without_lattice_projection():
    parsed = _parse_vasp_metadata(_payload(
        poscar=(
            "test\n1\n1 0 0\n0 1 0\n0 0 1\nH\n2\n"
            "Selective dynamics\nDirect\n"
            "0 0 0 F F F\n"
            "0 0 0.5 T T F"
        ),
        outcar="NIONS = 2\nfree  energy   TOTEN = -1.0 eV",
        forces="N 2\n10 10 10\n0.3 0.4 9.0",
    ))

    assert "fmax" not in parsed


def test_malformed_selective_mask_omits_fmax():
    parsed = _parse_vasp_metadata(_payload(
        poscar=(
            "test\n1\n1 0 0\n0 1 0\n0 0 1\nH\n2\n"
            "Selective dynamics\nDirect\n"
            "0 0 0 F F F\n"
            "0 0 0.5 MAYBE T F"
        ),
        outcar="NIONS = 2\nfree  energy   TOTEN = -1.0 eV",
        forces="N 2\n10 10 10\n0.3 0.4 9.0",
    ))

    assert "fmax" not in parsed
