import textwrap

from catgo.cli.vib import parse_outcar_freqs

# 2-atom system, 1 real + 1 imaginary mode. Mirrors VASP OUTCAR layout:
# "ions per type", a POSITION/mass block, and the f= / f/i= mode blocks
# each followed by an "X Y Z dx dy dz" eigenvector table.
_OUTCAR = textwrap.dedent("""\
   ions per type =               1 1
  POMASS =   1.00 16.00
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


def test_parse_outcar_freqs(tmp_path):
    p = tmp_path / "OUTCAR"
    p.write_text(_OUTCAR)
    r = parse_outcar_freqs(p)
    assert r.real_freqs_cm == [166.78]
    assert r.imag_freqs_cm == [33.356]
    assert r.num_imaginary == 1
    assert r.total_atoms == 2
    assert len(r.eigenvectors) == 2          # one per mode
    assert len(r.eigenvectors[0]) == 2       # per atom
    assert r.eigenvectors[0][1] == [0.0, 0.0, -0.7]
    assert r.masses_amu == [1.0, 16.0]
    assert r.atom_types == [0, 1]            # H -> type 0, O -> type 1
    assert len(r.positions) == 2


import pytest
from catgo.cli.adapter import OpError

# real VASP prints the freq table BEFORE the eigenvector section (no vec
# rows there) and again interleaved with eigenvectors; the parser must
# dedup by "only blocks with vec rows count". 3 real modes, no imaginary.
_OUTCAR_DEDUP = textwrap.dedent("""\
   ions per type =               1 1
  POMASS =   1.00 16.00; ZVAL = 1.0
  POMASS =   1.00 16.00
 position of ions in cartesian coordinates  (Angst):
   0.0000000  0.0000000  0.0000000
   0.0000000  0.0000000  1.1000000

   1 f  =    9.0 THz   56.5 2PiTHz  300.0000 cm-1   37.2 meV
   2 f  =    6.0 THz   37.7 2PiTHz  200.0000 cm-1   24.8 meV
   3 f  =    3.0 THz   18.8 2PiTHz  100.0000 cm-1   12.4 meV

 Eigenvectors and eigenvalues of the dynamical matrix
 ----------------------------------------------------

   1 f  =    9.0 THz   56.5 2PiTHz  300.0000 cm-1   37.2 meV
             X         Y         Z           dx          dy          dz
      0.000000  0.000000  0.000000     0.000000  0.000000  0.100000
      0.000000  0.000000  1.100000     0.000000  0.000000 -0.100000

   2 f  =    6.0 THz   37.7 2PiTHz  200.0000 cm-1   24.8 meV
             X         Y         Z           dx          dy          dz
      0.000000  0.000000  0.000000     0.000000  0.200000  0.000000
      0.000000  0.000000  1.100000     0.000000 -0.200000  0.000000

   3 f  =    3.0 THz   18.8 2PiTHz  100.0000 cm-1   12.4 meV
             X         Y         Z           dx          dy          dz
      0.000000  0.000000  0.000000     0.300000  0.000000  0.000000
      0.000000  0.000000  1.100000    -0.300000  0.000000  0.000000
""")


def test_dedup_leading_freq_table_not_double_counted(tmp_path):
    p = tmp_path / "OUTCAR"
    p.write_text(_OUTCAR_DEDUP)
    r = parse_outcar_freqs(p)
    assert r.real_freqs_cm == [300.0, 200.0, 100.0]
    assert r.imag_freqs_cm == []
    assert r.num_imaginary == 0
    assert len(r.eigenvectors) == 3
    assert r.masses_amu == [1.0, 16.0]   # SUMMARY line, not the ;ZVAL one
    assert r.atom_types == [0, 1]


def test_missing_outcar_raises():
    with pytest.raises(OpError):
        parse_outcar_freqs("/no/such/OUTCAR")


def test_unparseable_ions_per_type_raises(tmp_path):
    bad = tmp_path / "OUTCAR"
    bad.write_text("garbage with no ions-per-type line\n")
    with pytest.raises(OpError):
        parse_outcar_freqs(bad)


from catgo.cli.vib import write_mode_animation


def test_write_mode_animation(tmp_path):
    p = tmp_path / "OUTCAR"; p.write_text(_OUTCAR)
    data = parse_outcar_freqs(p)
    out = tmp_path / "ts.xyz"
    n = write_mode_animation(
        data, mode_index=1, out=out, frames=10, amplitude=0.5,
        symbols=["H", "O"])
    assert n == 10
    txt = out.read_text().splitlines()
    # extxyz: each frame = 1 count line + 1 comment + N atom lines
    assert txt[0].strip() == "2"
    assert txt.count("2") == 10            # 10 frame count-lines
    assert len([l for l in txt if l.startswith(("H ", "O "))]) == 20
