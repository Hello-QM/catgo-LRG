import textwrap
import pytest
from catgo.cli.session import Session
from catgo.cli import ops_analyze
from catgo.cli.adapter import OpError

_OUTCAR = textwrap.dedent("""\
   ions per type =               1 1
  POMASS =   1.00 16.00
      direct lattice vectors                 reciprocal lattice vectors
     5.000000  0.000000  0.000000     0.200000  0.000000  0.000000
     0.000000  5.000000  0.000000     0.000000  0.200000  0.000000
     0.000000  0.000000  8.000000     0.000000  0.000000  0.125000
 position of ions in cartesian coordinates  (Angst):
   0.0000000  0.0000000  0.0000000
   0.0000000  0.0000000  1.1000000

 Eigenvectors and eigenvalues of the dynamical matrix
 ----------------------------------------------------

   1 f  =    5.000000 THz    31.4159 2PiTHz  166.7800 cm-1    20.6789 meV
             X         Y         Z           dx          dy          dz
      0.000000  0.000000  0.000000     0.000000  0.000000  0.700000
      0.000000  0.000000  1.100000     0.000000  0.000000 -0.700000

   2 f/i =    1.000000 THz     6.2832 2PiTHz   33.3560 cm-1     4.1358 meV
             X         Y         Z           dx          dy          dz
      0.000000  0.000000  0.000000     0.100000  0.000000  0.000000
      0.000000  0.000000  1.100000    -0.100000  0.000000  0.000000
""")


def _outcar(tmp_path):
    p = tmp_path / "OUTCAR"; p.write_text(_OUTCAR); return p


def test_freq_adsorbed_gibbs_and_anim(tmp_path):
    src = _outcar(tmp_path); out = tmp_path / "ts.xyz"
    s = Session()
    r = ops_analyze.freq(s, {"input": str(src), "mode": "adsorbed",
                             "out": str(out), "symbols": "H,O"})
    assert r.ok
    assert "G_corr" in r.message and "imaginary=1" in r.message
    assert out.exists()                       # 1 imaginary -> animation written
    assert r.artifact == out


def test_freq_gibbs_matches_library(tmp_path):
    from catgo.utils.gibbs_calculator import calc_adsorbed
    src = _outcar(tmp_path)
    s = Session()
    r = ops_analyze.freq(s, {"input": str(src), "mode": "adsorbed",
                             "no_anim": True})
    direct = calc_adsorbed([166.78], [33.356], 298.15, 50.0)
    assert f"{direct['g_corr_ev']:.4f}" in r.message  # anti-drift


def test_freq_no_anim_skips_xyz(tmp_path):
    src = _outcar(tmp_path)
    r = ops_analyze.freq(Session(), {"input": str(src), "mode": "adsorbed",
                                     "no_anim": True})
    assert r.ok and r.artifact is None


def test_freq_bad_input_errors(tmp_path):
    with pytest.raises(OpError):
        ops_analyze.freq(Session(), {"input": str(tmp_path / "nope"),
                                     "mode": "adsorbed"})


import os


def _find_fixture(*names):
    base = os.path.join(os.path.dirname(__file__), "fixtures")
    for n in names:
        p = os.path.join(base, n)
        if os.path.exists(p):
            return p
    return None


def test_dos_handler(tmp_path):
    h5 = _find_fixture("dos.h5", "vaspout.h5")
    if h5 is None:
        pytest.skip("no vaspout.h5 fixture in tests/cli/fixtures/ — supply one")
    out = tmp_path / "dos.png"
    r = ops_analyze.dos(Session(), {"input": h5, "out": str(out),
                                    "atoms": "all"})
    assert r.ok and out.exists()
    assert "d-band" in r.message.lower()


def test_dos_wrong_format_errors(tmp_path):
    bad = tmp_path / "x.xml"; bad.write_text("<xml/>")
    with pytest.raises(OpError):
        ops_analyze.dos(Session(), {"input": str(bad), "out": str(tmp_path/"o.png")})


def test_dos_missing_file_clean_error(tmp_path):
    with pytest.raises(OpError) as ei:
        ops_analyze.dos(Session(), {"input": str(tmp_path / "nope.h5"),
                                    "out": str(tmp_path / "o.png")})
    assert "not found" in str(ei.value)


def test_dos_bad_atoms_clean_error(tmp_path, monkeypatch):
    import sys, types
    fake_root = types.ModuleType("catgo_dos")
    fake_io = types.ModuleType("catgo_dos.io")
    class _V:
        nions = 1
    fake_io.read_vaspout_h5 = lambda p: _V()
    fake_pdos = types.ModuleType("catgo_dos.pdos")
    fake_pdos.compute_pdos = lambda *a, **k: None
    fake_dband = types.ModuleType("catgo_dos.dband")
    fake_dband.compute_d_center = lambda *a, **k: None
    monkeypatch.setitem(sys.modules, "catgo_dos", fake_root)
    monkeypatch.setitem(sys.modules, "catgo_dos.io", fake_io)
    monkeypatch.setitem(sys.modules, "catgo_dos.pdos", fake_pdos)
    monkeypatch.setitem(sys.modules, "catgo_dos.dband", fake_dband)
    h5 = tmp_path / "x.h5"; h5.write_bytes(b"\x89HDF")
    with pytest.raises(OpError) as ei:
        ops_analyze.dos(Session(), {"input": str(h5),
                                    "atoms": "abc,xyz",
                                    "out": str(tmp_path / "o.png")})
    assert "comma-separated integers" in str(ei.value)


def test_dos_happy_path_monkeypatched(tmp_path, monkeypatch):
    import sys, types
    import numpy as np

    class _V:
        nions = 2
    class _PDOS:
        grid = np.linspace(-5.0, 5.0, 11)
        pdos = np.ones((1, 11))      # (nspin, ngrid)
    class _DB:
        eps_rel = -1.234

    fake_root = types.ModuleType("catgo_dos")
    fake_io = types.ModuleType("catgo_dos.io")
    fake_io.read_vaspout_h5 = lambda p: _V()
    fake_pdos = types.ModuleType("catgo_dos.pdos")
    fake_pdos.compute_pdos = lambda vd, atoms, channels: _PDOS()
    fake_dband = types.ModuleType("catgo_dos.dband")
    fake_dband.compute_d_center = lambda vd, atoms: _DB()
    monkeypatch.setitem(sys.modules, "catgo_dos", fake_root)
    monkeypatch.setitem(sys.modules, "catgo_dos.io", fake_io)
    monkeypatch.setitem(sys.modules, "catgo_dos.pdos", fake_pdos)
    monkeypatch.setitem(sys.modules, "catgo_dos.dband", fake_dband)

    h5 = tmp_path / "x.h5"; h5.write_bytes(b"\x89HDF")
    out = tmp_path / "dos.png"
    dump = tmp_path / "dos.json"
    r = ops_analyze.dos(Session(),
                        {"input": str(h5), "out": str(out),
                         "atoms": "all", "channels": "d",
                         "dump": str(dump)})
    assert r.ok and out.exists()
    import re
    assert re.search(r"d-band center = -?\d+\.\d{4} eV", r.message)
    assert "-1.2340" in r.message
    import json
    payload = json.loads(dump.read_text())
    assert payload["d_band_center_eV"] == -1.234
    assert len(payload["energy"]) == 11
    assert len(payload["pdos"]) == 11


def test_cohp_handler(tmp_path):
    cc = _find_fixture("COHPCAR.lobster", "cohpcar.lobster")
    if cc is None:
        pytest.skip("no COHPCAR.lobster fixture — supply one")
    out = tmp_path / "cohp.png"
    r = ops_analyze.cohp(Session(), {"input": cc, "out": str(out)})
    assert r.ok and out.exists()
    assert "icohp" in r.message.lower()


def test_cohp_wrong_format_errors(tmp_path):
    bad = tmp_path / "x.h5"; bad.write_text("nope")
    with pytest.raises(OpError):
        ops_analyze.cohp(Session(), {"input": str(bad),
                                     "out": str(tmp_path / "o.png")})


def test_cohp_missing_file_clean_error(tmp_path):
    with pytest.raises(OpError) as ei:
        ops_analyze.cohp(Session(), {"input": str(tmp_path / "COHPCAR.lobster")})
    assert "not found" in str(ei.value)


def test_cohp_happy_path_monkeypatched(tmp_path, monkeypatch):
    import sys, types
    import numpy as np

    class _CD:
        energies = np.linspace(-5.0, 5.0, 11)
        # real shape (nspin=1, ncols=2, npoints=11); col 0 = Average, col 1 = a bond
        cohp = np.ones((1, 2, 11)) * 0.5
        icohp = -np.tile(np.linspace(0.0, 1.0, 11), (1, 2, 1))
        efermi = 0.0

    fake_root = types.ModuleType("catgo_cohp")
    fake_io = types.ModuleType("catgo_cohp.io")
    fake_io.parse_cohpcar = lambda p: _CD()
    monkeypatch.setitem(sys.modules, "catgo_cohp", fake_root)
    monkeypatch.setitem(sys.modules, "catgo_cohp.io", fake_io)

    cc = tmp_path / "COHPCAR.lobster"; cc.write_text("stub")
    out = tmp_path / "cohp.png"
    dump = tmp_path / "cohp.json"
    r = ops_analyze.cohp(Session(),
                         {"input": str(cc), "out": str(out), "dump": str(dump)})
    assert r.ok and out.exists()
    import re
    assert re.search(r"ICOHP at E_f = -?\d+\.\d{4}", r.message)
    import json
    payload = json.loads(dump.read_text())
    assert "icohp_at_Ef" in payload
    assert len(payload["energy"]) == 11


def test_band_handler(tmp_path):
    vr = _find_fixture("band_vasprun.xml", "vasprun.xml")
    if vr is None:
        pytest.skip("no band vasprun.xml fixture — supply one")
    out = tmp_path / "band.png"
    r = ops_analyze.band(Session(), {"input": vr, "out": str(out)})
    assert r.ok and out.exists()
    assert "gap" in r.message.lower()


def test_band_missing_input_errors():
    with pytest.raises(OpError):
        ops_analyze.band(Session(), {"input": None})


def test_band_missing_file_clean_error(tmp_path):
    with pytest.raises(OpError) as ei:
        ops_analyze.band(Session(), {"input": str(tmp_path / "vasprun.xml")})
    assert "not found" in str(ei.value)


def test_band_happy_path_monkeypatched(tmp_path, monkeypatch):
    import sys, types
    import numpy as np

    class _BS:
        distance = [0.0, 0.5, 1.0]
        bands = {"Spin.up": np.array([[0.0, 0.5, 1.0]])}
        def get_band_gap(self):
            return {"energy": 1.234, "direct": True}

    class _VR:
        def __init__(self, *a, **kw): pass
        def get_band_structure(self, line_mode=True): return _BS()

    fake_outputs = types.ModuleType("pymatgen.io.vasp.outputs")
    fake_outputs.Vasprun = _VR
    monkeypatch.setitem(sys.modules, "pymatgen.io.vasp.outputs", fake_outputs)

    vr = tmp_path / "vasprun.xml"; vr.write_text("<?xml?>")
    out = tmp_path / "band.png"
    dump = tmp_path / "band.json"
    r = ops_analyze.band(Session(),
                         {"input": str(vr), "out": str(out),
                          "dump": str(dump)})
    assert r.ok and out.exists()
    import re
    assert re.search(r"band gap = -?\d+\.\d{4} eV \((direct|indirect)\)", r.message)
    assert "1.2340" in r.message
    import json
    payload = json.loads(dump.read_text())
    assert payload["band_gap_eV"] == 1.234
    assert payload["kind"] == "direct"
    assert len(payload["distance"]) == 3
