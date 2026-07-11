"""Tests for CP2K vibrational-output parsers (Molden .mol + main .out)."""

from catgo.services.cp2k_freq import parse_molden_vibrations

# Trimmed from a real CP2K *-VIBRATIONS-1.mol (169-atom partial Hessian sample,
# cut to 3 atoms / 3 modes; one negative frequency added to cover imaginary).
MOLDEN_SAMPLE = """ [Molden Format]
 [Atoms] AU
 C        1       6       1.000000       0.000000       0.000000
 O        2       8       0.000000       2.000000       0.000000
 H        3       1       0.000000       0.000000       3.000000
 [FREQ]
     -199.412720
      244.475827
     3479.433284
 [FR-COORD]
 C        1.000000       0.000000       0.000000
 O        0.000000       2.000000       0.000000
 H        0.000000       0.000000       3.000000
 [FR-NORM-COORD]
 vibration      1
     0.100000       0.000000       0.000000
     0.000000       0.000000       0.000000
     0.000000       0.000000      -0.200000
 vibration      2
     0.000000       0.300000       0.000000
     0.000000       0.000000       0.000000
     0.000000       0.000000       0.000000
 vibration      3
     0.000000       0.000000       0.000000
     0.000000       0.000000       0.400000
     0.500000       0.000000       0.000000
 [INT]
            34.759821
           775.381512
             9.909605
"""


def test_molden_frequencies_split_by_sign():
    res = parse_molden_vibrations(MOLDEN_SAMPLE)
    assert res["success"] is True
    assert res["source_format"] == "cp2k-molden"
    assert [f["frequency_cm"] for f in res["imag_freqs"]] == [199.412720]
    assert [f["frequency_cm"] for f in res["real_freqs"]] == [244.475827, 3479.433284]
    assert res["num_imaginary"] == 1
    # 1-based original mode indices preserved
    assert res["imag_freqs"][0]["index"] == 1
    assert [f["index"] for f in res["real_freqs"]] == [2, 3]


def test_molden_positions_converted_bohr_to_angstrom():
    res = parse_molden_vibrations(MOLDEN_SAMPLE)
    assert res["total_atoms"] == 3
    assert res["elements"] == ["C", "O", "H"]
    assert abs(res["positions"][0][0] - 0.52917721067) < 1e-9
    assert abs(res["positions"][1][1] - 2 * 0.52917721067) < 1e-9


def test_molden_eigenvectors_imag_first_aligned_with_intensities():
    res = parse_molden_vibrations(MOLDEN_SAMPLE)
    assert len(res["eigenvectors"]) == 3
    # mode 1 is the imaginary one -> first eigenvector, first intensity
    assert res["eigenvectors"][0][0] == [0.1, 0.0, 0.0]
    assert res["intensities_km_mol"][0] == 34.759821
    # real modes follow in original order
    assert res["eigenvectors"][1][0] == [0.0, 0.3, 0.0]
    assert res["intensities_km_mol"][2] == 9.909605


def test_molden_masses_from_elements():
    res = parse_molden_vibrations(MOLDEN_SAMPLE)
    assert len(res["masses"]) == 3
    assert abs(res["masses"][0] - 12.011) < 0.1   # C
    assert abs(res["masses"][2] - 1.008) < 0.01   # H
    assert res["atom_types"] == [0, 1, 2]


def test_molden_missing_norm_coord_degrades_to_table_only():
    trimmed = MOLDEN_SAMPLE.split("[FR-NORM-COORD]")[0]
    res = parse_molden_vibrations(trimmed)
    assert res["success"] is True
    assert res["eigenvectors"] == []
    assert res["intensities_km_mol"] is None


def test_molden_no_freq_section_fails():
    res = parse_molden_vibrations("[Molden Format]\n[Atoms] AU\n")
    assert res["success"] is False
    assert "FREQ" in res["message"]
