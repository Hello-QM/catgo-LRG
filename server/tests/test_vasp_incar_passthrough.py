"""Regression: arbitrary VASP INCAR tags must reach the generated INCAR.

Bug (2026-06-05): generate_vasp_input_files only copied a fixed param_mapping
(ENCUT, ISMEAR, LWAVE, LCHARG, ...) into the VASPInputRequest; any other INCAR
tag the user set (e.g. LH5 to disable HDF5 output on a build whose parallel-HDF5
is broken) was silently dropped, and an explicit ``custom_incar`` dict was
ignored. Now uppercase-and-unmapped keys + ``custom_incar`` pass through.
"""

from workflow.engines.vasp import generate_vasp_input_files

_PT_POSCAR = """Pt
1.0
0.0 1.96 1.96
1.96 0.0 1.96
1.96 1.96 0.0
Pt
1
Direct
0.0 0.0 0.0
"""


def _incar(params):
    files, _, _ = generate_vasp_input_files("single_point", params, _PT_POSCAR)
    return files["INCAR"]


def test_uppercase_incar_tag_passes_through():
    incar = _incar({"software": "vasp", "system_type": "periodic", "ENCUT": 300,
                    "kpoints": "5 5 5", "LH5": False})
    assert "LH5" in incar  # previously silently dropped
    # value written as a false logical (VASP reads the leading char, so either form works)
    lh5_val = incar.split("LH5", 1)[1].split("\n", 1)[0]
    assert "F" in lh5_val.upper()


def test_explicit_custom_incar_passes_through():
    incar = _incar({"software": "vasp", "system_type": "periodic", "ENCUT": 300,
                    "kpoints": "5 5 5", "custom_incar": {"ICHARG": 1, "MAGMOM": "1*0.6"}})
    assert "ICHARG" in incar
    assert "MAGMOM" in incar


def test_lowercase_control_keys_not_leaked_as_incar_tags():
    # control keys must NOT appear as INCAR tags
    incar = _incar({"software": "vasp", "system_type": "periodic", "ENCUT": 300,
                    "kpoints": "5 5 5"})
    assert "software" not in incar
    assert "system_type" not in incar
    assert "kpoints" not in incar.lower().replace("kpoints =", "")  # no stray 'kpoints' tag
