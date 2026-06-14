import textwrap

from catgo.cli.vib import parse_outcar_freqs

# 2-atom system, 1 real + 1 imaginary mode. Mirrors VASP OUTCAR layout:
# "ions per type", a POSITION/mass block, and the f= / f/i= mode blocks
# each followed by an "X Y Z dx dy dz" eigenvector table.
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
    assert r.lattice == [[5.0, 0.0, 0.0], [0.0, 5.0, 0.0], [0.0, 0.0, 8.0]]
    assert r.imag_mode_indices == [1]        # eigenvectors[1] is the imag mode


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


# Real VASP fixed-width SUMMARY POMASS line GLUES adjacent masses when one
# needs >6 chars: e.g. O (16.00) + Pt (195.08) -> "16.00195.08", which
# .split() cannot tokenise. The clean per-POTCAR "; ZVAL" lines must be used
# as the fallback. (Live bug: Pt(111)-ORR *OOH freq, masses H/O/Pt.)
_OUTCAR_GLUED_POMASS = textwrap.dedent("""\
   ions per type =               1 1 2
  POMASS =    1.000; ZVAL   =    1.000    mass and valenz
  POMASS =   16.000; ZVAL   =    6.000    mass and valenz
  POMASS =  195.080; ZVAL   =   10.000    mass and valenz
 position of ions in cartesian coordinates  (Angst):
   0.0000000  0.0000000  0.0000000
   0.0000000  0.0000000  1.1000000
   0.0000000  0.0000000  2.2000000
   0.0000000  0.0000000  3.3000000
  POMASS =   1.00 16.00195.08
""")


def test_glued_summary_pomass_falls_back_to_header_masses(tmp_path):
    p = tmp_path / "OUTCAR"
    p.write_text(_OUTCAR_GLUED_POMASS)
    r = parse_outcar_freqs(p)
    # 3 element types (H, O, Pt) with counts 1,1,2 -> masses per atom
    assert r.masses_amu == [1.0, 16.0, 195.08, 195.08]
    assert r.atom_types == [0, 1, 2, 2]
    assert r.total_atoms == 4


def test_eigenvectors_for_real_excludes_imag(tmp_path):
    """E1 — IR spectrum (real modes only) needs an explicit getter.
    Don't slice by len(real_freqs_cm) — imag_mode_indices is the
    source of truth (the same boundary-bug guard P2 already documented)."""
    p = tmp_path / "OUTCAR"
    p.write_text(_OUTCAR)
    r = parse_outcar_freqs(p)
    # 1 real + 1 imag mode; eigenvectors[0] real, eigenvectors[1] imag.
    real_vecs = r.eigenvectors_for_real()
    assert len(real_vecs) == 1
    # The single real eigenvector should be the first eigenvector in
    # OUTCAR order (a 2-atom Z-displacement +0.7, -0.7).
    assert real_vecs[0] == r.eigenvectors[0]


def test_eigenvectors_for_real_pure_real_fixture(tmp_path):
    """3 real, 0 imag fixture: full eigenvector list returned in order."""
    p = tmp_path / "OUTCAR"
    p.write_text(_OUTCAR_DEDUP)
    r = parse_outcar_freqs(p)
    assert len(r.eigenvectors_for_real()) == 3
    assert r.eigenvectors_for_real() == r.eigenvectors
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


import math
from catgo.cli.vib import write_mode_animation


def test_write_mode_animation(tmp_path):
    p = tmp_path / "OUTCAR"; p.write_text(_OUTCAR)
    data = parse_outcar_freqs(p)
    out = tmp_path / "ts.xyz"
    n_frames = 10
    n = write_mode_animation(
        data, mode_index=1, out=out, frames=n_frames, amplitude=0.5,
        symbols=["H", "O"])
    assert n == n_frames
    txt = out.read_text().splitlines()
    stride = 2 + data.total_atoms                     # count + comment + N
    for k in range(n_frames):
        assert txt[k * stride].strip() == str(data.total_atoms)
    assert "Lattice=" in txt[1]
    assert "Properties=species:S:1:pos:R:3" in txt[1]
    atom_lines = [l for l in txt if l.startswith(("H ", "O "))]
    assert len(atom_lines) == n_frames * data.total_atoms
    f0_h = atom_lines[0].split()
    assert float(f0_h[1]) == 0.0 and float(f0_h[2]) == 0.0
    assert float(f0_h[3]) == 0.0
    qk = n_frames // 4
    f_qk_h = atom_lines[qk * data.total_atoms].split()
    expected_x = 0.0 + 0.5 * math.sin(2.0 * math.pi * qk / n_frames) * 0.1
    assert abs(float(f_qk_h[1]) - expected_x) < 1e-6


def test_write_mode_animation_bad_mode_index_raises(tmp_path):
    p = tmp_path / "OUTCAR"; p.write_text(_OUTCAR)
    data = parse_outcar_freqs(p)
    with pytest.raises(OpError):
        write_mode_animation(data, mode_index=99, out=tmp_path / "x.xyz",
                              frames=5, amplitude=0.1, symbols=["H", "O"])


def test_write_mode_animation_symbols_len_mismatch_raises(tmp_path):
    p = tmp_path / "OUTCAR"; p.write_text(_OUTCAR)
    data = parse_outcar_freqs(p)
    with pytest.raises(OpError):
        write_mode_animation(data, mode_index=0, out=tmp_path / "x.xyz",
                              frames=5, amplitude=0.1, symbols=["H"])  # 1 != 2
