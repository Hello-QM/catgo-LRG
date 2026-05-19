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
