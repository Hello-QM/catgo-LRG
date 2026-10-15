"""Tests for cube I/O, IRI/IGMH/ESP/AIM recipes and the NBO parser."""

import json
import stat
import sys
import textwrap

import numpy as np
import pytest

from catgo.utils.cube_grid import read_cube, write_cube
from catgo.utils.wavefunction_analysis import (
    iri_grid,
    pair_bond_paths,
    parse_cpprop,
    parse_nbo,
    scatter_plot,
)

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shebang script")


def _cube_text(values, natoms=1, comment="test"):
    """3x3x3 cube on a 0.5 Bohr grid at the origin with one O atom."""
    lines = [comment, "generated"]
    lines.append(f"{natoms:5d}{0.0:12.6f}{0.0:12.6f}{0.0:12.6f}")
    for k in range(3):
        vec = [0.0, 0.0, 0.0]
        vec[k] = 0.5
        lines.append(f"{3:5d}" + "".join(f"{v:12.6f}" for v in vec))
    lines.append(f"{8:5d}{8.0:12.6f}{0.5:12.6f}{0.5:12.6f}{0.5:12.6f}")
    flat = list(values)
    for i in range(0, len(flat), 6):
        lines.append("".join(f"{v:13.5E}" for v in flat[i:i + 6]))
    return "\n".join(lines) + "\n"


# ── cube I/O ──

def test_cube_roundtrip():
    values = np.arange(27, dtype=float) / 10
    cube = read_cube(_cube_text(values))
    assert cube.shape == (3, 3, 3)
    assert cube.data[0, 0, 2] == pytest.approx(0.2)
    assert cube.data[2, 2, 2] == pytest.approx(2.6)
    again = read_cube(write_cube(cube, cube.data * 2, "doubled"))
    assert again.comments[0] == "doubled"
    np.testing.assert_allclose(again.data, cube.data * 2, rtol=1e-5)
    assert again.atoms[0][0] == 8


def test_orbital_cube_with_negative_atom_count():
    text = _cube_text(np.ones(27)).splitlines()
    text[2] = text[2].replace("    1", "   -1", 1)
    text.insert(7, "    1    5")  # orbital list line of MO cubes
    cube = read_cube("\n".join(text))
    assert cube.extra == ["    1    5"]
    assert cube.data.sum() == pytest.approx(27)


# ── IRI and scatter ──

def test_iri_definition_and_scatter():
    rho = np.array([0.01, 0.1, 1e-40])
    grad = np.array([0.02, 0.05, 0.0])
    iri = iri_grid(rho, grad)
    assert iri[0] == pytest.approx(0.02 / 0.01 ** 1.1)
    assert np.isfinite(iri).all()

    x = np.array([-0.03, 0.0, 0.01, 0.2])
    y = np.array([0.5, 1.0, 3.0, 0.5])
    plot = scatter_plot(x, y, "IRI", 1.5)
    assert plot["n_points"] == 2  # third point exceeds y_max, last is out of x range
    assert plot["traces"][0]["x"] == [-0.03, 0.0]


# ── AIM ──

CPPROP = textwrap.dedent("""\
     ----------------    CP     1,     Type (3,-3)     ----------------
     Corresponding nucleus:     1(O )
     Position (Bohr):         0.000000000000      0.000000000000      0.000000000000
     Position (Angstrom):     0.000000000000      0.000000000000      0.000000000000
     Density of all electrons:  0.2918106400E+03
     Laplacian of electron density: -0.1000000000E+07

     ----------------    CP     4,     Type (3,-1)     ----------------
     Position (Bohr):         0.000000000000      1.400000000000      1.000000000000
     Position (Angstrom):     0.000000000000      0.740848095264      0.529177210903
     Density of all electrons:  0.3570000000E+00
     Lagrangian kinetic energy G(r):  0.6000000000E-01
     Potential energy density V(r): -0.6000000000E+00
     Energy density E(r) or H(r): -0.5400000000E+00
     Laplacian of electron density: -0.1920000000E+01
     Ellipticity of electron density:  0.2100000000E-01
""")

WATER_ATOMS = [
    {"Z": 8, "symbol": "O", "xyz": [0.0, 0.0, 0.0]},
    {"Z": 1, "symbol": "H", "xyz": [0.0, 1.48, 1.06]},
    {"Z": 1, "symbol": "H", "xyz": [0.0, -1.48, 1.06]},
]


def test_parse_cpprop_and_bond_paths():
    cps = parse_cpprop(CPPROP)
    assert [cp["kind"] for cp in cps] == ["NCP", "BCP"]
    assert cps[0]["nucleus"] == 1 and cps[0]["element"] == "O"
    bcp = cps[1]
    assert bcp["rho"] == pytest.approx(0.357)
    assert bcp["laplacian"] == pytest.approx(-1.92)
    assert bcp["H"] == pytest.approx(-0.54)
    assert bcp["ellipticity"] == pytest.approx(0.021)
    assert bcp["position"][1] == pytest.approx(0.740848095264)

    paths = pair_bond_paths(cps, WATER_ATOMS)
    assert len(paths) == 1
    assert paths[0]["atoms"] == [1, 2]  # O–H1, not H1–H2
    assert paths[0]["points"][1] == bcp["position"]


# ── NBO ──

NBO3 = textwrap.dedent("""\
 Summary of Natural Population Analysis:

                                       Natural Population
                Natural  -----------------------------------------------
    Atom  No    Charge         Core      Valence    Rydberg      Total
 -----------------------------------------------------------------------
      O    1   -0.91466      1.99986     6.90546    0.00934     8.91466
      H    2    0.45733      0.00000     0.54024    0.00243     0.54267
      H    3    0.45733      0.00000     0.54024    0.00243     0.54267
 =======================================================================
   * Total *    0.00000      1.99986     7.98593    0.01421    10.00000

 Wiberg bond index matrix in the NAO basis:

     Atom    1       2       3
     ---- ------  ------  ------
   1.  O  0.0000  0.8763  0.8763
   2.  H  0.8763  0.0000  0.0043
   3.  H  0.8763  0.0043  0.0000

 Wiberg bond index, Totals by atom:

 SECOND ORDER PERTURBATION THEORY ANALYSIS OF FOCK MATRIX IN NBO BASIS

     Threshold for printing:   0.50 kcal/mol
                                                          E(2)  E(j)-E(i) F(i,j)
         Donor NBO (i)                     Acceptor NBO (j)       kcal/mol   a.u.    a.u.
 ===================================================================================================

 within unit  1
   3. LP (   1) O   1                / 21. RY*(   1) H   2                    0.96    1.71    0.036
   4. LP (   2) O   1                /  8. BD*(   1) O   1 - H   2            5.12    0.88    0.060

 NATURAL BOND ORBITALS (Summary):
""")


def test_parse_nbo3():
    r = parse_nbo(NBO3)
    assert [c["charge"] for c in r["charges"]] == [-0.91466, 0.45733, 0.45733]
    assert r["charges"][0]["symbol"] == "O"
    assert r["wiberg"][0][1] == pytest.approx(0.8763)
    assert r["bonds"] == [
        {"atoms": [1, 2], "wbi": 0.8763},
        {"atoms": [1, 3], "wbi": 0.8763},
    ]
    assert r["n_e2"] == 2
    top = r["e2"][0]
    assert top["e2"] == pytest.approx(5.12)
    assert top["donor"] == "LP ( 2) O 1"
    assert top["acceptor"] == "BD*( 1) O 1 - H 2"
    assert top["acceptor_index"] == 8


def test_parse_nbo_wiberg_blocks_and_spin():
    cols = "".join(f"{c:8d}" for c in range(1, 10))
    block1 = ["     Atom" + cols, "     ---- " + "  ------" * 9]
    block1 += [f"  {i:2d}.  C" + "".join(f"{(0.0 if i == j else 1.0):8.4f}" for j in range(1, 10))
               for i in range(1, 11)]
    block2 = ["     Atom      10", "     ---- ------"]
    block2 += [f"  {i:2d}.  C{(0.0 if i == 10 else 0.5):8.4f}" for i in range(1, 11)]
    text = "\n".join(
        [" Wiberg bond index matrix in the NAO basis:", ""] + block1 + [""] + block2
        + ["", " Wiberg bond index, Totals by atom:", "",
           " Alpha spin orbitals", " SECOND ORDER PERTURBATION THEORY ANALYSIS",
           "   1. BD (   1) C   1 - C   2     / 12. BD*(   1) C   3 - C   4    2.50    1.20    0.049",
           " NATURAL BOND ORBITALS (Summary):"]
    )
    r = parse_nbo(text)
    assert len(r["wiberg"]) == 10
    assert r["wiberg"][0][9] == pytest.approx(0.5)
    assert r["wiberg"][9][9] == 0.0
    assert r["e2"][0]["spin"] == "alpha"


def test_parse_nbo_rejects_other_files():
    with pytest.raises(ValueError):
        parse_nbo("SCF Done: E(RB3LYP) = -76.4\n")


# ── recipes with a fake Multiwfn ──

FAKE = r'''#!{python}
import json, sys
keys = sys.stdin.read().split()
open("{log}", "a").write(json.dumps(keys) + "\n")

def cube(name, fn):
    lines = ["fake", "cube", "    1    0.000000    0.000000    0.000000"]
    for k in range(3):
        v = ["0.000000"] * 3
        v[k] = "0.500000"
        lines.append("    3    " + "    ".join(v))
    lines.append("    8    8.000000    0.500000    0.500000    0.500000")
    vals = [fn(i) for i in range(27)]
    for i in range(0, 27, 6):
        lines.append(" ".join("%13.5E" % x for x in vals[i:i + 6]))
    open(name, "w").write("\n".join(lines) + "\n")

if keys[0] == "5":
    func = keys[1]
    fn = {{"1": lambda i: 0.01 * (i + 1), "2": lambda i: 0.02, "15": lambda i: -0.01,
           "12": lambda i: 0.001 * i}}.get(func, lambda i: 1.0)
    cube({{"1": "density.cub", "2": "gradnorm.cub", "15": "sl2r.cub",
           "12": "totesp.cub"}}.get(func, "MOvalue.cub"), fn)
elif keys[:2] == ["20", "11"]:
    cube("dg_inter.cub", lambda i: 0.02)
    cube("sl2r.cub", lambda i: -0.02)
    cube("dg.cub", lambda i: 0.03)
elif keys[0] == "2":
    open("CPprop.txt", "w").write({cpprop!r})
# Multiwfn aborts at end of input when menus are left open
sys.exit(2)
'''


@pytest.fixture
def fake(tmp_path, monkeypatch):
    exe = tmp_path / "bin" / "Multiwfn"
    exe.parent.mkdir()
    log = tmp_path / "calls.jsonl"
    exe.write_text(FAKE.format(python=sys.executable, log=log, cpprop=CPPROP))
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("CATGO_MULTIWFN_RECIPES", str(tmp_path / "none.json"))

    def calls():
        return [json.loads(line) for line in log.read_text().splitlines()]

    return exe, calls


@posix_only
def test_grid_function_tolerates_eof_abort(fake, tmp_path):
    from catgo.utils.multiwfn import grid_function_cube

    exe, calls = fake
    text = grid_function_cube(tmp_path / "w.fchk", "esp", "low", str(exe))
    assert read_cube(text).data[0, 0, 1] == pytest.approx(0.001)
    assert calls()[-1] == ["5", "12", "1", "2", "0", "q"]


@posix_only
def test_igmh_fragment_specs(fake, tmp_path):
    from catgo.utils.multiwfn import igmh_cubes

    exe, calls = fake
    out = igmh_cubes(tmp_path / "w.fchk", [[1, 2, 3, 7], [4, 5, 6]], "medium", str(exe))
    assert {"dg_inter.cub", "sl2r.cub"} <= set(out)
    assert calls()[-1] == ["20", "11", "2", "1-3,7", "4-6", "2", "3", "0", "0", "q"]


@posix_only
def test_recipe_override_file(fake, tmp_path, monkeypatch):
    from catgo.utils.multiwfn import grid_function_cube, load_recipes

    exe, calls = fake
    override = tmp_path / "recipes.json"
    override.write_text(json.dumps({
        "grid_function": ["5", "{function}", "{grid}", "2"],
        "grid_function_codes": {"esp": 1},
    }))
    monkeypatch.setenv("CATGO_MULTIWFN_RECIPES", str(override))
    recipes, codes = load_recipes()
    assert codes["esp"] == 1 and recipes["aim"][0] == "2"
    grid_function_cube(tmp_path / "w.fchk", "esp", "high", str(exe))
    assert calls()[-1] == ["5", "1", "3", "2"]


@posix_only
def test_missing_output_reports_keystrokes(tmp_path, monkeypatch):
    from catgo.utils.multiwfn import MultiwfnError, aim_cpprop

    exe = tmp_path / "Multiwfn"
    exe.write_text(f"#!{sys.executable}\nimport sys; sys.stdin.read(); print('menu shown')\n")
    exe.chmod(0o755)
    monkeypatch.setenv("CATGO_MULTIWFN_RECIPES", str(tmp_path / "none.json"))
    with pytest.raises(MultiwfnError, match="Keystrokes: 2 2 3 4 5 7 0 -10 q"):
        aim_cpprop(tmp_path / "w.fchk", str(exe))


# ── router ──

WATER_FCHK_ATOMS = textwrap.dedent("""\
    water
    SP        RHF                                                         STO-3G
    Number of alpha electrons                  I                5
    Number of beta electrons                   I                5
    Atomic numbers                             I   N=           3
               8           1           1
    Current cartesian coordinates              R   N=           9
      0.00000000E+00  0.00000000E+00  0.00000000E+00  0.00000000E+00  2.79679000E+00
      2.00310000E+00  0.00000000E+00 -2.79679000E+00  2.00310000E+00
""")


@pytest.fixture
def client(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from catgo.routers import wavefunction

    monkeypatch.setattr(wavefunction, "CACHE_DIR", tmp_path / "cache")
    app = FastAPI()
    app.include_router(wavefunction.router, prefix="/api")
    return TestClient(app)


def _session(client):
    r = client.post("/api/wavefunction/load", files={"file": ("water.fchk", WATER_FCHK_ATOMS)})
    assert r.status_code == 200, r.text
    return r.json()["session_id"]


@posix_only
def test_router_iri_igmh_esp_aim(client, fake):
    exe, calls = fake
    session = _session(client)
    base = {"session_id": session, "grid": "low", "multiwfn_path": str(exe)}

    iri = client.post("/api/wavefunction/iri", json=base).json()
    iri_cube = read_cube(iri["iri_cube"])
    assert iri_cube.data[0, 0, 0] == pytest.approx(0.02 / 0.01 ** 1.1, rel=1e-4)
    assert iri["scatter"]["n_points"] > 0
    assert [c[1] for c in calls()[-3:]] == ["1", "2", "15"]

    igmh = client.post("/api/wavefunction/igmh", json={**base, "fragments": [[1], [2, 3]]})
    assert igmh.status_code == 200, igmh.text
    assert igmh.json()["scatter"]["n_points"] == 27

    esp = client.post("/api/wavefunction/esp", json=base).json()
    assert read_cube(esp["esp_cube"]).data[0, 0, 2] == pytest.approx(0.002)

    aim = client.post("/api/wavefunction/aim", json=base).json()
    assert aim["counts"] == {"NCP": 1, "BCP": 1}
    assert aim["bond_paths"][0]["atoms"] == [1, 2]

    bad = client.post("/api/wavefunction/igmh", json={**base, "fragments": [[1]]})
    assert bad.status_code == 400


def test_router_nbo(client):
    r = client.post("/api/wavefunction/nbo", files={"file": ("water.log", NBO3)})
    assert r.status_code == 200
    assert r.json()["bonds"][0]["wbi"] == pytest.approx(0.8763)
    assert client.post(
        "/api/wavefunction/nbo", files={"file": ("x.log", "nothing here")}
    ).status_code == 400
