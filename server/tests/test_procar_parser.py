from catgo.cli._extpath import ensure_extension


def test_procar_parser_splits_adjacent_signed_floats():
    mod = ensure_extension("dos-analysis", "catgo_dos.io")

    values = mod._parse_float_fields("0.00000000-0.00000000 0.30000000-0.10000000 1.25E-03-2.50E+01")

    assert values == [0.0, -0.0, 0.3, -0.1, 1.25e-3, -25.0]


def test_procar_normalizer_preserves_exponent_signs():
    mod = ensure_extension("dos-analysis", "catgo_dos.io")

    text = "0.30000000-0.10000000 1.25E-03-2.50E+01 3.0e+02+4.0"

    assert mod._normalize_adjacent_signed_floats(text) == (
        "0.30000000 -0.10000000 1.25E-03 -2.50E+01 3.0e+02 +4.0"
    )
