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


from catgo.services.cp2k_freq import parse_cp2k_out_vibrations

# Trimmed from a real CP2K .out: 3-per-row VIB| summary lines, one row with
# Fortran overflow stars, one negative (imaginary) frequency added.
CP2K_OUT_SAMPLE = """
 GLOBAL| Run type                                           VIBRATIONAL_ANALYSIS
 VIB|Frequency (cm^-1)  -347.256704           353.503943           542.181388
 VIB|IR int (KM/Mole)  ************         ************          1935.829219
 VIB|Frequency (cm^-1)   692.540224           779.864096          1504.859758
 VIB|IR int (KM/Mole)  40017.567601          4362.977226           554.745415
"""


def test_cp2k_out_frequencies_and_overflow_intensities():
    res = parse_cp2k_out_vibrations(CP2K_OUT_SAMPLE)
    assert res["success"] is True
    assert res["source_format"] == "cp2k-out"
    assert res["num_imaginary"] == 1
    assert res["imag_freqs"][0]["frequency_cm"] == 347.256704
    assert len(res["real_freqs"]) == 5
    # imag-first alignment: first intensity belongs to the imaginary mode
    assert res["intensities_km_mol"][0] is None
    assert res["intensities_km_mol"][2] == 1935.829219
    assert res["intensities_km_mol"][3] == 40017.567601
    # no animation data from .out
    assert res["eigenvectors"] == []
    assert res["positions"] == []


def test_cp2k_out_without_vib_section_fails():
    res = parse_cp2k_out_vibrations("GLOBAL| Run type ENERGY\n")
    assert res["success"] is False
    assert "VIB|" in res["message"]


def test_cp2k_out_intensity_count_mismatch_drops_intensities():
    text = " VIB|Frequency (cm^-1)   100.0  200.0  300.0\n VIB|IR int (KM/Mole)  1.0  2.0\n"
    res = parse_cp2k_out_vibrations(text)
    assert res["success"] is True
    assert res["intensities_km_mol"] is None


from catgo.services.cp2k_freq import parse_freq_content

OUTCAR_SAMPLE = """ POMASS =   12.011; ZVAL   =     4.000
   ions per type =               1
   1 f  =   50.000000 THz   314.159265 2PiTHz 1667.850457 cm-1   206.786314 meV
"""


def test_sniff_molden():
    assert parse_freq_content(MOLDEN_SAMPLE)["source_format"] == "cp2k-molden"


def test_sniff_cp2k_out():
    assert parse_freq_content(CP2K_OUT_SAMPLE)["source_format"] == "cp2k-out"


def test_sniff_outcar_fallthrough():
    res = parse_freq_content(OUTCAR_SAMPLE)
    assert res["success"] is True
    assert res["real_freqs"][0]["frequency_cm"] == 1667.850457
