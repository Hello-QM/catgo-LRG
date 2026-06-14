"""vasp_sanity — pre-submission scientific-config checks for campaign calcs.

These encode the scientific-config errors the Pt(111) ORR campaign caught
*reactively* (see that campaign's LESSONS.md): closed-shell H2 dissociating
under ISPIN=2, freq ISPIN not matching geo_opt, plus the textbook physics
checks (ENCUT vs ENMAX, k-mesh density, ISMEAR/SIGMA, magnetic ISPIN).
"""
import vasp_sanity as vs


# ---- INCAR parsing ----

def test_parse_incar_basic_and_uppercases_keys():
    inc = vs.parse_incar("ENCUT = 450\nIspin = 2\n")
    assert inc["ENCUT"] == "450"
    assert inc["ISPIN"] == "2"


def test_parse_incar_strips_hash_and_bang_comments():
    inc = vs.parse_incar("ENCUT = 450  # plane-wave cutoff\nISMEAR = 1 ! metal\n")
    assert inc["ENCUT"] == "450"
    assert inc["ISMEAR"] == "1"


def test_parse_incar_semicolon_multiple_per_line():
    inc = vs.parse_incar("ISMEAR = 1 ; SIGMA = 0.2\n")
    assert inc["ISMEAR"] == "1"
    assert inc["SIGMA"] == "0.2"


def test_parse_incar_ignores_blank_and_section_lines():
    inc = vs.parse_incar("\nElectronic:\nENCUT = 400\n")
    assert inc.get("ENCUT") == "400"
    assert "ELECTRONIC" not in inc  # no '=', not a key


# ---- POTCAR ENMAX / elements ----

def test_potcar_max_enmax_picks_largest():
    txt = (
        "  PAW_PBE Pt 05Jan2001\n   ENMAX  =  230.283; EATOM=  -96.7\n"
        "  PAW_PBE O 08Apr2002\n   ENMAX  =  400.000; EATOM= -432.0\n"
    )
    assert vs.potcar_max_enmax(txt) == 400.0


def test_potcar_max_enmax_none_when_absent():
    assert vs.potcar_max_enmax("garbage with no enmax") is None


def test_potcar_elements_from_titel_in_order():
    txt = (
        "  PAW_PBE Pt 05Jan2001\n   ENMAX = 230.0; EATOM\n"
        "  PAW_PBE O 08Apr2002\n   ENMAX = 400.0; EATOM\n"
    )
    assert vs.potcar_elements(txt) == ["Pt", "O"]


# ---- KPOINTS ----

def test_kpoints_gamma_only_true_for_1x1x1():
    assert vs.kpoints_is_gamma_only("auto\n0\nGamma\n1 1 1\n0 0 0\n") is True


def test_kpoints_gamma_only_false_for_real_mesh():
    assert vs.kpoints_is_gamma_only("auto\n0\nMonkhorst\n4 4 1\n0 0 0\n") is False


# ---- POSCAR elements ----

def test_poscar_elements_line6():
    poscar = (
        "Pt slab\n1.0\n3 0 0\n0 3 0\n0 0 20\nPt O\n9 1\nSelective dynamics\n"
    )
    assert vs.poscar_elements(poscar) == ["Pt", "O"]


# ---- ENCUT vs ENMAX check ----

def _by_name(checks, name):
    return next(c for c in checks if c.name == name)


def test_encut_below_enmax_is_error():
    checks = vs.check_config({"ENCUT": "200"}, max_enmax=400.0,
                             gamma_only=False, elements=["Pt", "O"], is_gas=False)
    c = _by_name(checks, "ENCUT")
    assert c.ok is False and c.severity == "error"


def test_encut_below_1p3_enmax_is_warn():
    checks = vs.check_config({"ENCUT": "450"}, max_enmax=400.0,
                             gamma_only=False, elements=["Pt", "O"], is_gas=False)
    c = _by_name(checks, "ENCUT")
    assert c.ok is False and c.severity == "warn"
    assert "520" in c.detail  # recommends 1.3*400


def test_encut_at_or_above_1p3_enmax_ok():
    checks = vs.check_config({"ENCUT": "520"}, max_enmax=400.0,
                             gamma_only=False, elements=["Pt", "O"], is_gas=False)
    assert _by_name(checks, "ENCUT").ok is True


def test_encut_missing_is_error():
    checks = vs.check_config({}, max_enmax=400.0,
                             gamma_only=False, elements=["Pt"], is_gas=False)
    c = _by_name(checks, "ENCUT")
    assert c.ok is False and c.severity == "error"


# ---- k-mesh check ----

def test_gamma_only_on_metal_slab_warns():
    checks = vs.check_config({"ENCUT": "999"}, max_enmax=400.0,
                             gamma_only=True, elements=["Pt", "O"], is_gas=False)
    assert _by_name(checks, "k-mesh").severity == "warn"
    assert _by_name(checks, "k-mesh").ok is False


def test_gamma_only_on_gas_is_ok():
    checks = vs.check_config({"ENCUT": "999"}, max_enmax=400.0,
                             gamma_only=True, elements=["H", "O"], is_gas=True)
    assert _by_name(checks, "k-mesh").ok is True


# ---- ISMEAR/SIGMA check ----

def test_tetrahedron_ismear_on_metal_warns():
    checks = vs.check_config({"ENCUT": "999", "ISMEAR": "-5"}, max_enmax=400.0,
                             gamma_only=False, elements=["Pt"], is_gas=False)
    assert _by_name(checks, "ISMEAR/SIGMA").ok is False


def test_mp_ismear_on_nonmetal_gas_warns():
    checks = vs.check_config({"ENCUT": "999", "ISMEAR": "1", "SIGMA": "0.2"},
                             max_enmax=400.0, gamma_only=True,
                             elements=["H", "O"], is_gas=True)
    assert _by_name(checks, "ISMEAR/SIGMA").ok is False


def test_metal_ismear1_small_sigma_ok():
    checks = vs.check_config({"ENCUT": "999", "ISMEAR": "1", "SIGMA": "0.1"},
                             max_enmax=400.0, gamma_only=False,
                             elements=["Pt"], is_gas=False)
    assert _by_name(checks, "ISMEAR/SIGMA").ok is True


# ---- magnetic ISPIN check ----

def test_magnetic_metal_without_ispin2_warns():
    checks = vs.check_config({"ENCUT": "999", "ISPIN": "1"}, max_enmax=400.0,
                             gamma_only=False, elements=["Ni", "C"], is_gas=False)
    assert _by_name(checks, "magnetic ISPIN").ok is False


def test_magnetic_metal_with_ispin2_ok():
    checks = vs.check_config({"ENCUT": "999", "ISPIN": "2"}, max_enmax=400.0,
                             gamma_only=False, elements=["Ni", "C"], is_gas=False)
    assert _by_name(checks, "magnetic ISPIN").ok is True


def test_nonmagnetic_no_ispin_required_ok():
    checks = vs.check_config({"ENCUT": "999", "ISPIN": "1"}, max_enmax=400.0,
                             gamma_only=False, elements=["Pt", "O"], is_gas=False)
    assert _by_name(checks, "magnetic ISPIN").ok is True


# ---- closed-shell gas ISPIN check (the H2-dissociation lesson) ----

def test_closed_shell_gas_with_ispin2_warns():
    checks = vs.check_config({"ENCUT": "999", "ISPIN": "2"}, max_enmax=400.0,
                             gamma_only=True, elements=["H"], is_gas=True)
    c = _by_name(checks, "gas ISPIN")
    assert c.ok is False and c.severity == "warn"


def test_gas_with_ispin1_ok():
    checks = vs.check_config({"ENCUT": "999", "ISPIN": "1"}, max_enmax=400.0,
                             gamma_only=True, elements=["H", "O"], is_gas=True)
    assert _by_name(checks, "gas ISPIN").ok is True


def test_slab_ispin2_not_flagged_by_gas_check():
    checks = vs.check_config({"ENCUT": "999", "ISPIN": "2"}, max_enmax=400.0,
                             gamma_only=False, elements=["Pt"], is_gas=False)
    assert _by_name(checks, "gas ISPIN").ok is True


# ---- freq <-> geo_opt ISPIN match (the freq-mismatch lesson) ----

def test_freq_ispin_mismatch_warns():
    c = vs.check_freq_ispin_match(freq_incar={"ISPIN": "2"},
                                  source_incar={"ISPIN": "1"})
    assert c.ok is False and c.severity == "warn"


def test_freq_ispin_match_ok():
    c = vs.check_freq_ispin_match(freq_incar={"ISPIN": "1"},
                                  source_incar={"ISPIN": "1"})
    assert c.ok is True


# ---- enforce / summarize gate ----

def test_enforce_raises_on_error_without_force():
    checks = [vs.Check("ENCUT", False, "error", "ENCUT 200 < ENMAX 400")]
    try:
        vs.enforce(checks, force=False)
        assert False, "expected an error to be raised"
    except vs.SanityError:
        pass


def test_enforce_passes_with_force():
    checks = [vs.Check("ENCUT", False, "error", "bad")]
    vs.enforce(checks, force=True)  # must not raise


def test_enforce_ignores_warnings():
    checks = [vs.Check("k-mesh", False, "warn", "sparse")]
    vs.enforce(checks, force=False)  # warnings never block


# ---- validate_calc_dir (reads files from a dir) ----

def test_validate_calc_dir_reads_and_flags(tmp_path):
    (tmp_path / "INCAR").write_text("ENCUT = 200\nISMEAR = 1\nSIGMA = 0.1\n")
    (tmp_path / "POTCAR").write_text(
        "  PAW_PBE Pt\n   ENMAX = 230.0; EATOM\n  PAW_PBE O\n   ENMAX = 400.0; EATOM\n")
    (tmp_path / "KPOINTS").write_text("a\n0\nMonkhorst\n4 4 1\n0 0 0\n")
    (tmp_path / "POSCAR").write_text("c\n1\n1 0 0\n0 1 0\n0 0 1\nPt O\n9 1\n")
    checks = vs.validate_calc_dir(tmp_path)
    assert _by_name(checks, "ENCUT").severity == "error"  # 200 < 400


def test_validate_calc_dir_no_incar_returns_empty(tmp_path):
    assert vs.validate_calc_dir(tmp_path) == []


# ---- default ENMAX table (campaigns generate POTCAR remotely; no local file) ----

def test_default_enmax_picks_max_over_elements():
    assert vs.default_enmax(["Pt", "O"]) == 400.0  # O 400 > Pt ~230


def test_default_enmax_none_when_all_unknown():
    assert vs.default_enmax(["Xx"]) is None


def test_validate_calc_dir_uses_default_enmax_without_potcar(tmp_path):
    # the real campaign case: INCAR + POSCAR present, POTCAR built on the cluster
    (tmp_path / "INCAR").write_text("ENCUT = 450\nISMEAR = 1\nSIGMA = 0.1\n")
    (tmp_path / "POSCAR").write_text("c\n1\n1 0 0\n0 1 0\n0 0 1\nPt O\n9 1\n")
    (tmp_path / "KPOINTS").write_text("a\n0\nMonkhorst\n4 4 1\n0 0 0\n")
    c = _by_name(vs.validate_calc_dir(tmp_path), "ENCUT")
    assert c.ok is False and c.severity == "warn" and "520" in c.detail


# ---- is_gas auto-detection (all-nonmetal cell = molecule/gas) ----

def test_detect_is_gas_true_for_all_nonmetal(tmp_path):
    (tmp_path / "POSCAR").write_text("c\n1\n8 0 0\n0 8 0\n0 0 8\nH O\n2 1\n")
    assert vs.detect_is_gas(tmp_path) is True


def test_detect_is_gas_false_for_metal_slab(tmp_path):
    (tmp_path / "POSCAR").write_text("c\n1\n3 0 0\n0 3 0\n0 0 20\nPt O\n9 1\n")
    assert vs.detect_is_gas(tmp_path) is False


def test_detect_is_gas_false_when_unknown(tmp_path):
    assert vs.detect_is_gas(tmp_path) is False
