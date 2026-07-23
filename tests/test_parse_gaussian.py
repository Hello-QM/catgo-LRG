from scripts.parse_gaussian import parse_gaussian


def _orientation_block(name, x):
    return f""" {name}:
 ---------------------------------------------------------------------
 Center     Atomic      Atomic             Coordinates (Angstroms)
 Number     Number       Type             X           Y           Z
 ---------------------------------------------------------------------
      1          6           0        {x:.6f}    0.000000    0.000000
 ---------------------------------------------------------------------
"""


def _scf_energy(energy):
    return f" SCF Done:  E(RB3LYP) =  {energy:.8f}     A.U. after 10 cycles\n"


def _point(point_number, path_number):
    return f" Point Number: {point_number} Path Number: {path_number}\n"


def test_prefers_standard_orientation_without_duplicate_geometry(tmp_path):
    output = tmp_path / "both-orientations.out"
    output.write_text(
        _orientation_block("Input orientation", 1.0)
        + _orientation_block("Standard orientation", 2.0)
    )

    *_, geometries = parse_gaussian(output)

    assert len(geometries) == 1
    assert geometries[0][0] == ("C", 2.0, 0.0, 0.0)


def test_falls_back_to_input_orientation(tmp_path):
    output = tmp_path / "input-only.out"
    output.write_text(_orientation_block("Input orientation", 1.0))

    *_, geometries = parse_gaussian(output)

    assert len(geometries) == 1
    assert geometries[0][0] == ("C", 1.0, 0.0, 0.0)


def test_orders_bidirectional_irc_and_restores_checkpoint_ts(tmp_path):
    output = tmp_path / "irc-from-checkpoint.out"
    output.write_text(
        " IRC-IRC-IRC-IRC-IRC-\n"
        " Redundant internal coordinates found in file.  (old form).\n"
        " C,0,0.000000,0.000000,0.000000\n"
        " Recover connectivity data from disk.\n"
        " Energy From Chk = -10.00000000\n"
        + _point(0, 1)
        + _orientation_block("Input orientation", 1)
        + _scf_energy(-10.1)
        + _point(1, 1)
        + _orientation_block("Input orientation", 2)
        + _scf_energy(-10.2)
        + _point(2, 1)
        + _orientation_block("Input orientation", 3)
        + _scf_energy(-10.3)
        + _point(1, 2)
        + _orientation_block("Input orientation", 4)
        + _scf_energy(-10.4)
        + _point(2, 2)
        + _orientation_block("Input orientation", 4)
    )

    energies, *_, geometries = parse_gaussian(output)

    assert [frame[0][1] for frame in geometries] == [4, 3, 0, 1, 2]
    assert energies == [-10.4, -10.3, -10.0, -10.1, -10.2]


def test_keeps_irc_ts_already_present_without_checkpoint(tmp_path):
    output = tmp_path / "irc-with-input-ts.out"
    output.write_text(
        " IRC-IRC-IRC-IRC-IRC-\n"
        + _point(0, 1)
        + _orientation_block("Input orientation", 0)
        + _scf_energy(-10.0)
        + _point(1, 1)
        + _orientation_block("Input orientation", 1)
        + _scf_energy(-10.1)
        + _point(2, 1)
        + _orientation_block("Input orientation", 2)
        + _scf_energy(-10.2)
        + _point(1, 2)
        + _orientation_block("Input orientation", 3)
        + _scf_energy(-10.3)
        + _point(2, 2)
        + _orientation_block("Input orientation", 4)
        + _scf_energy(-10.4)
        + _orientation_block("Input orientation", 4)
    )

    energies, *_, geometries = parse_gaussian(output)

    assert [frame[0][1] for frame in geometries] == [4, 3, 0, 1, 2]
    assert energies == [-10.4, -10.3, -10.0, -10.1, -10.2]
