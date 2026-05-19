import textwrap

from catgo.cli.vib import parse_outcar_freqs

# 2-atom system, 1 real + 1 imaginary mode. Mirrors VASP OUTCAR layout:
# "ions per type", a POSITION/mass block, and the f= / f/i= mode blocks
# each followed by an "X Y Z dx dy dz" eigenvector table.
_OUTCAR = textwrap.dedent("""\
   ions per type =               2
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
    assert len(r.positions) == 2
