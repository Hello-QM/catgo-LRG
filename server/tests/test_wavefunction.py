"""Tests for wavefunction file parsing, the Multiwfn runner and its router."""

import os
import stat
import sys
import textwrap

import pytest

from catgo.utils.wavefunction_parser import (
    BOHR_TO_ANGSTROM,
    WavefunctionParseError,
    parse_wavefunction,
)


def _fchk_scalar(label, kind, value):
    return f"{label:<40}   {kind}     {value:>12}"


def _fchk_array(label, kind, values):
    fmt = (lambda v: f"{v:12d}") if kind == "I" else (lambda v: f"{v:16.8E}")
    per_line = 6 if kind == "I" else 5
    lines = [f"{label:<40}   {kind}   N={len(values):>12}"]
    for k in range(0, len(values), per_line):
        lines.append("".join(fmt(v) for v in values[k:k + per_line]))
    return lines


def _fchk(title, scalars, arrays):
    lines = [title, "SP        RHF                                                         STO-3G"]
    lines += [_fchk_scalar(*s) for s in scalars]
    for a in arrays:
        lines += _fchk_array(*a)
    return "\n".join(lines) + "\n"


WATER_FCHK = _fchk(
    "water",
    [
        ("Number of atoms", "I", 3),
        ("Charge", "I", 0),
        ("Multiplicity", "I", 1),
        ("Number of alpha electrons", "I", 5),
        ("Number of beta electrons", "I", 5),
        ("Total Energy", "R", "-7.495929232844363E+01"),
    ],
    [
        ("Atomic numbers", "I", [8, 1, 1]),
        ("Current cartesian coordinates", "R",
         [0.0, 0.0, 0.0, 0.0, 0.0, 1.79523983, 1.69257101, 0.0, -0.598406347]),
        ("Alpha Orbital Energies", "R",
         [-20.25, -1.26, -0.59, -0.46, -0.39, 0.58, 0.69]),
    ],
)

CH3_UHF_FCHK = _fchk(
    "ch3",
    [
        ("Charge", "I", 0),
        ("Multiplicity", "I", 2),
        ("Number of alpha electrons", "I", 5),
        ("Number of beta electrons", "I", 4),
    ],
    [
        ("Atomic numbers", "I", [6, 1, 1, 1]),
        ("Current cartesian coordinates", "R", [0.0] * 3 + [2.0, 0, 0] + [0, 2.0, 0] + [0, 0, 2.0]),
        ("Alpha Orbital Energies", "R", [-11.0, -0.9, -0.5, -0.5, -0.3, 0.6, 0.7, 0.8]),
        ("Beta Orbital Energies", "R", [-11.0, -0.8, -0.5, -0.5, 0.2, 0.6, 0.7, 0.8]),
    ],
)


def test_fchk_restricted():
    r = parse_wavefunction(WATER_FCHK, "water.fchk")
    assert r["format"] == "fchk"
    assert [a["symbol"] for a in r["atoms"]] == ["O", "H", "H"]
    assert r["atoms"][1]["xyz"][2] == pytest.approx(1.79523983 * BOHR_TO_ANGSTROM)
    assert (r["charge"], r["multiplicity"]) == (0, 1)
    assert r["energy"] == pytest.approx(-74.95929232844363)
    assert not r["unrestricted"]
    assert [o["occupation"] for o in r["orbitals"]] == [2, 2, 2, 2, 2, 0, 0]
    assert r["frontier"]["restricted"]["homo"] == 5
    assert r["frontier"]["restricted"]["lumo"] == 6
    assert r["frontier"]["restricted"]["gap"] == pytest.approx(0.58 + 0.39)
    assert r["xyz"].splitlines()[0] == "3"


def test_fchk_unrestricted_indices_follow_multiwfn():
    r = parse_wavefunction(CH3_UHF_FCHK, "ch3.fch")
    assert r["unrestricted"]
    beta = [o for o in r["orbitals"] if o["spin"] == "beta"]
    assert beta[0]["index"] == 9  # beta orbitals come after all 8 alpha ones
    assert r["frontier"]["alpha"]["homo"] == 5
    assert r["frontier"]["beta"]["homo"] == 12
    assert r["frontier"]["beta"]["lumo"] == 13
    # number of atoms comes from the atomic-number array when the header lacks it
    assert len(r["atoms"]) == 4


def test_fchk_rohf_occupations():
    text = CH3_UHF_FCHK.split("Beta Orbital Energies")[0]
    r = parse_wavefunction(text, "ch3_rohf.fchk")
    assert not r["unrestricted"]
    occ = [o["occupation"] for o in r["orbitals"]]
    assert occ[:6] == [2, 2, 2, 2, 1, 0]


MOLDEN = textwrap.dedent("""\
    [Molden Format]
    [Title]
     h2 test
    [Atoms] (AU)
    H     1    1   0.0  0.0  0.0
    H     2    1   0.0  0.0  1.4
    [GTO]
      1 0
    s   1 1.0
          1.0  1.0

    [MO]
     Sym=     1a
     Ene= -0.59
     Spin= Alpha
     Occup= 2.0
        1   0.5
        2   0.5
     Sym=     2a
     Ene=  0.67
     Spin= Alpha
     Occup= 0.0
        1   0.5
        2  -0.5
""")


def test_molden_atomic_units_and_orbitals():
    r = parse_wavefunction(MOLDEN, "h2.molden.input")
    assert r["atoms"][1]["xyz"][2] == pytest.approx(1.4 * BOHR_TO_ANGSTROM)
    assert [o["energy"] for o in r["orbitals"]] == [-0.59, 0.67]
    assert r["charge"] == 0
    assert r["frontier"]["restricted"]["homo"] == 1


def test_molden_angstrom_default():
    text = MOLDEN.replace("[Atoms] (AU)", "[Atoms] Angs")
    r = parse_wavefunction(text, "h2.molden")
    assert r["atoms"][1]["xyz"][2] == pytest.approx(1.4)


WFN_UHF = textwrap.dedent("""\
    test
    GAUSSIAN              4 MOL ORBITALS      2 PRIMITIVES        2 NUCLEI
      Li   1    (CENTRE  1)   0.00000000  0.00000000100.15548504  CHARGE =  3.0
      H    2    (CENTRE  2)   0.00000000-94.48630664  0.00000000  CHARGE =  1.0
    CENTRE ASSIGNMENTS    1  2
    TYPE ASSIGNMENTS      1  1
    EXPONENTS  0.1000000D+01 0.1000000D+01
    MO    1     MO 0.0        OCC NO =    1.0000000  ORB. ENERGY =   -2.797
      0.1D+01 0.1D+01
    MO    2     MO 0.0        OCC NO =    1.0000000  ORB. ENERGY =   -0.829
      0.1D+01 0.1D+01
    MO    3     MO 0.0        OCC NO =    1.0000000  ORB. ENERGY =   -2.790
      0.1D+01 0.1D+01
    MO    4     MO 0.0        OCC NO =    0.0000000  ORB. ENERGY =    0.100
      0.1D+01 0.1D+01
    END DATA
     THE  HF ENERGY =     -7.700000000000 THE VIRIAL(-V/T)=   2.00000000
""")


def test_wfn_glued_coordinates_and_spin_split():
    r = parse_wavefunction(WFN_UHF, "lih.wfn")
    assert [a["symbol"] for a in r["atoms"]] == ["Li", "H"]
    assert r["atoms"][0]["xyz"][2] == pytest.approx(100.15548504 * BOHR_TO_ANGSTROM)
    assert r["atoms"][1]["xyz"][1] == pytest.approx(-94.48630664 * BOHR_TO_ANGSTROM)
    assert r["unrestricted"]
    assert [o["spin"] for o in r["orbitals"]] == ["alpha", "alpha", "beta", "beta"]
    assert r["energy"] == pytest.approx(-7.7)
    assert r["charge"] == 1


WFX = textwrap.dedent("""\
    <Title>
    h2
    </Title>
    <Net Charge>
    0
    </Net Charge>
    <Electronic Spin Multiplicity>
    1
    </Electronic Spin Multiplicity>
    <Atomic Numbers>
    1
    1
    </Atomic Numbers>
    <Nuclear Cartesian Coordinates>
    0.0 0.0 0.0
    0.0 0.0 1.4
    </Nuclear Cartesian Coordinates>
    <Molecular Orbital Occupation Numbers>
    1.0
    0.0
    1.0
    0.0
    </Molecular Orbital Occupation Numbers>
    <Molecular Orbital Energies>
    -0.6
    0.1
    -0.6
    0.1
    </Molecular Orbital Energies>
    <Molecular Orbital Spin Types>
    Alpha
    Alpha
    Beta
    Beta
    </Molecular Orbital Spin Types>
    <Energy = T + Vne + Vee + Vnn>
    -1.17
    </Energy = T + Vne + Vee + Vnn>
""")


def test_wfx():
    r = parse_wavefunction(WFX, "h2.wfx")
    assert r["unrestricted"]
    assert r["energy"] == pytest.approx(-1.17)
    assert r["frontier"]["beta"] == pytest.approx(
        {"homo": 3, "lumo": 4, "gap": 0.7, "gap_ev": 0.7 * 27.211386245988}
    )


@pytest.mark.parametrize("text, name", [
    (WATER_FCHK, "water.xyz"),
    ("not an fchk\n", "broken.fchk"),
])
def test_parse_errors(text, name):
    with pytest.raises(WavefunctionParseError):
        parse_wavefunction(text, name)


# ── Multiwfn runner ──

FAKE_MULTIWFN = """#!{python}
import sys
keys = sys.stdin.read().split()
open("keys.log", "w").write(" ".join(keys))
open("{log}", "w").write(" ".join([sys.argv[1]] + keys))
if keys[:2] == ["5", "4"]:
    open("MOvalue.cub", "w").write("fake cube for orbital " + keys[2] + " grid " + keys[3])
"""

pytestmark_posix = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shebang script")


@pytest.fixture
def fake_multiwfn(tmp_path):
    folder = tmp_path / "multiwfn_bin"
    folder.mkdir()
    exe = folder / "Multiwfn"
    log = tmp_path / "call.log"
    exe.write_text(FAKE_MULTIWFN.format(python=sys.executable, log=log))
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    return exe, log


@pytestmark_posix
def test_find_multiwfn_explicit_and_env(fake_multiwfn, tmp_path, monkeypatch):
    from catgo.utils.multiwfn import find_multiwfn

    exe, _ = fake_multiwfn
    assert find_multiwfn(str(exe)) == (str(exe), "setting")
    assert find_multiwfn(str(exe.parent)) == (str(exe), "setting")
    # Only programs named Multiwfn* are accepted
    other = tmp_path / "evil"
    other.write_text("#!/bin/sh\n")
    other.chmod(0o755)
    assert find_multiwfn(str(other)) == (None, None)

    monkeypatch.setenv("CATGO_MULTIWFN", str(exe.parent))
    assert find_multiwfn() == (str(exe), "CATGO_MULTIWFN")


@pytestmark_posix
def test_orbital_cube_keystrokes(fake_multiwfn, tmp_path):
    from catgo.utils.multiwfn import orbital_cube

    exe, log = fake_multiwfn
    wfn = tmp_path / "water.fchk"
    wfn.write_text(WATER_FCHK)
    cube = orbital_cube(wfn, 5, grid="high", executable=str(exe))
    assert cube == "fake cube for orbital 5 grid 3"
    assert log.read_text() == f"{wfn} 5 4 5 3 2 0 q"


@pytestmark_posix
def test_orbital_cube_reports_missing_output(tmp_path):
    from catgo.utils.multiwfn import MultiwfnError, orbital_cube

    exe = tmp_path / "Multiwfn"
    exe.write_text(f"#!{sys.executable}\nimport sys; sys.stdin.read(); print('menu')\n")
    exe.chmod(0o755)
    with pytest.raises(MultiwfnError, match="without writing a cube"):
        orbital_cube(tmp_path / "x.fchk", 1, executable=str(exe))


# ── Router ──

@pytest.fixture
def client(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from catgo.routers import wavefunction

    monkeypatch.setattr(wavefunction, "CACHE_DIR", tmp_path / "cache")
    app = FastAPI()
    app.include_router(wavefunction.router, prefix="/api")
    return TestClient(app)


def test_router_load_and_validation(client):
    r = client.post("/api/wavefunction/load", files={"file": ("water.fchk", WATER_FCHK)})
    assert r.status_code == 200
    body = r.json()
    assert len(body["session_id"]) == 32
    assert body["frontier"]["restricted"]["homo"] == 5

    assert client.post(
        "/api/wavefunction/load", files={"file": ("water.txt", "x")}
    ).status_code == 400
    assert client.post("/api/wavefunction/orbital-cube", json={
        "session_id": "../etc", "orbital_index": 1,
    }).status_code == 400
    assert client.post("/api/wavefunction/orbital-cube", json={
        "session_id": "0" * 32, "orbital_index": 1,
    }).status_code == 404


@pytestmark_posix
def test_router_orbital_cube(client, fake_multiwfn, monkeypatch):
    exe, _ = fake_multiwfn
    monkeypatch.delenv("CATGO_MULTIWFN", raising=False)
    session = client.post(
        "/api/wavefunction/load", files={"file": ("water.fchk", WATER_FCHK)}
    ).json()["session_id"]

    status = client.get("/api/wavefunction/multiwfn-status", params={"path": str(exe)}).json()
    assert status == {"found": True, "path": str(exe), "source": "setting"}

    r = client.post("/api/wavefunction/orbital-cube", json={
        "session_id": session, "orbital_index": 6, "grid": "low", "multiwfn_path": str(exe),
    })
    assert r.status_code == 200
    assert r.text == "fake cube for orbital 6 grid 1"


def test_router_orbital_cube_without_multiwfn(client, monkeypatch, tmp_path):
    monkeypatch.delenv("CATGO_MULTIWFN", raising=False)
    monkeypatch.delenv("Multiwfnpath", raising=False)
    monkeypatch.setenv("PATH", str(tmp_path))
    session = client.post(
        "/api/wavefunction/load", files={"file": ("water.fchk", WATER_FCHK)}
    ).json()["session_id"]
    r = client.post("/api/wavefunction/orbital-cube", json={"session_id": session, "orbital_index": 1})
    assert r.status_code == 424
    assert "Multiwfn not found" in r.json()["detail"]
    assert os.environ["PATH"] == str(tmp_path)
