"""Format-specific random access shared by desktop, web, mobile, and VS Code."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np
import pytest

from catgo.routers.trajectory_stream import _get_index, _read_frame


def _index_and_frames(path: Path):
    resolved, index = _get_index(str(path))
    return index, [_read_frame(resolved, index, n) for n in range(index.total_frames)]


def test_extxyz_variable_topology_and_gzip(tmp_path: Path):
    content = "\n".join(
        [
            "2",
            'Lattice="2 0 0 0 2 0 0 0 2" Properties=species:S:1:pos:R:3:force:R:3 energy=-1',
            "H 0 0 0 1 2 3",
            "O 1 1 1 4 5 6",
            "1",
            'Lattice="3 0 0 0 3 0 0 0 3" Properties=species:S:1:pos:R:3:force:R:3 energy=-2',
            "He 2 2 2 7 8 9",
        ]
    )
    path = tmp_path / "variable.extxyz.gz"
    with gzip.open(path, "wt") as handle:
        handle.write(content)

    index, frames = _index_and_frames(path)

    assert index.fmt == "xyz"
    assert index.aux["variable_topology"] is True
    assert [len(frame["positions"]) for frame in frames] == [2, 1]
    assert frames[0]["forces"][1] == [4.0, 5.0, 6.0]
    assert frames[1]["lattice"][0] == [3.0, 0.0, 0.0]


def test_xdatcar_npt_is_indexed_without_full_file_parse(tmp_path: Path):
    path = tmp_path / "XDATCAR"
    path.write_text(
        "\n".join(
            [
                "frame 1", "1", "2 0 0", "0 2 0", "0 0 2", "H", "1",
                "Direct configuration= 1", "0.5 0 0",
                "frame 2", "1", "3 0 0", "0 3 0", "0 0 3", "H", "1",
                "Direct configuration= 2", "0.5 0 0",
            ]
        )
    )

    index, frames = _index_and_frames(path)

    assert index.fmt == "xdatcar"
    assert index.total_frames == 2
    assert frames[0]["positions"][0] == [1.0, 0.0, 0.0]
    assert frames[1]["positions"][0] == [1.5, 0.0, 0.0]


def test_outcar_ionic_steps_are_seekable(tmp_path: Path):
    path = tmp_path / "OUTCAR"
    path.write_text(
        "\n".join(
            [
                " VRHFIN =H: s1", " ions per type = 2",
                " direct lattice vectors                 reciprocal lattice vectors",
                " 2 0 0 0 0 0", " 0 2 0 0 0 0", " 0 0 2 0 0 0",
                " POSITION                                       TOTAL-FORCE (eV/Angst)",
                " -----------------------------------------------------------------------------------",
                " 0 0 0 0.1 0.2 0.3", " 1 0 0 0.4 0.5 0.6",
                " free  energy   TOTEN  = -1.5 eV",
                " direct lattice vectors                 reciprocal lattice vectors",
                " 3 0 0 0 0 0", " 0 3 0 0 0 0", " 0 0 3 0 0 0",
                " POSITION                                       TOTAL-FORCE (eV/Angst)",
                " -----------------------------------------------------------------------------------",
                " 0 1 0 0.7 0.8 0.9", " 1 1 0 1.0 1.1 1.2",
                " energy(sigma->0) = -2.5",
            ]
        )
    )

    index, frames = _index_and_frames(path)

    assert index.fmt == "outcar"
    assert index.total_frames == 2
    assert frames[1]["lattice"][0] == [3.0, 0.0, 0.0]
    assert frames[1]["positions"][1] == [1.0, 1.0, 0.0]
    assert frames[1]["properties"]["energy"] == -2.5


def test_vasprun_calculations_are_seekable(tmp_path: Path):
    path = tmp_path / "vasprun.xml"
    atom_info = (
        '<atominfo><array name="atoms"><set>'
        '<rc><c>H</c></rc><rc><c>O</c></rc>'
        '</set></array></atominfo>'
    )
    calculations = []
    for step, energy in enumerate((-4.0, -5.0)):
        calculations.append(
            '<calculation><structure><crystal><varray name="basis">'
            '<v>2 0 0</v><v>0 2 0</v><v>0 0 2</v></varray></crystal>'
            f'<varray name="positions"><v>0 0 0</v><v>{0.5 + step * 0.1} 0 0</v></varray>'
            '</structure><varray name="forces"><v>0 0 0</v><v>1 2 3</v></varray>'
            f'<energy><i name="e_fr_energy">{energy}</i></energy></calculation>'
        )
    path.write_text(f"<modeling>{atom_info}{''.join(calculations)}</modeling>")

    index, frames = _index_and_frames(path)

    assert index.fmt == "vasprun"
    assert index.total_frames == 2
    assert frames[1]["positions"][1] == pytest.approx([1.2, 0.0, 0.0])
    assert frames[1]["forces"][1] == [1.0, 2.0, 3.0]
    assert frames[1]["properties"]["energy"] == -5.0


def test_hdf5_uses_per_frame_hyperslabs(tmp_path: Path):
    h5py = pytest.importorskip("h5py")
    path = tmp_path / "vaspout.h5"
    with h5py.File(path, "w") as handle:
        handle["positions"] = np.arange(36, dtype=float).reshape(3, 4, 3)
        handle["atomic_numbers"] = np.array([1, 6, 7, 8])
        handle["cells"] = np.repeat(np.eye(3)[None, :, :] * 5, 3, axis=0)
        handle["forces"] = np.ones((3, 4, 3))
        handle["energy"] = np.array([-1.0, -2.0, -3.0])

    index, frames = _index_and_frames(path)

    assert index.fmt == "hdf5"
    assert index.total_frames == 3
    assert frames[2]["elements"] == ["H", "C", "N", "O"]
    assert frames[2]["positions"][0] == [24.0, 25.0, 26.0]
    assert frames[2]["properties"]["energy"] == -3.0


def test_vaspout_h5_ion_dynamics_layout(tmp_path: Path):
    h5py = pytest.importorskip("h5py")
    path = tmp_path / "vaspout.h5"
    with h5py.File(path, "w") as handle:
        poscar = handle.create_group("input/poscar")
        poscar["ion_types"] = np.array([b"H", b"O"])
        poscar["number_ion_types"] = np.array([1, 1])
        dynamics = handle.create_group("intermediate/ion_dynamics")
        dynamics["position_ions"] = np.array(
            [[[0, 0, 0], [0.5, 0, 0]], [[0.25, 0, 0], [0.75, 0, 0]]]
        )
        dynamics["lattice_vectors"] = np.repeat(np.eye(3)[None, :, :] * 4, 2, axis=0)
        dynamics["forces"] = np.ones((2, 2, 3))
        dynamics["energies"] = np.array([[-1, -1.1, -1.2], [-2, -2.1, -2.2]])

    index, frames = _index_and_frames(path)

    assert index.fmt == "hdf5"
    assert index.total_frames == 2
    assert frames[1]["elements"] == ["H", "O"]
    assert frames[1]["positions"] == [[1.0, 0.0, 0.0], [3.0, 0.0, 0.0]]
    assert frames[1]["forces"][0] == [1.0, 1.0, 1.0]
    assert frames[1]["properties"]["energy"] == -2.2


def test_gaussian_orientation_frames_are_seekable(tmp_path: Path):
    path = tmp_path / "optimization.log"

    def orientation(x: float, energy: float) -> str:
        return "\n".join(
            [
                " Standard orientation:",
                " ---------------------------------------------------------------------",
                " Center     Atomic      Atomic             Coordinates (Angstroms)",
                " Number     Number       Type             X           Y           Z",
                " ---------------------------------------------------------------------",
                f" 1 6 0 {x} 0.0 0.0",
                f" 2 1 0 {x + 1.0} 0.0 0.0",
                " ---------------------------------------------------------------------",
                f" SCF Done:  E(RB3LYP) = {energy} A.U.",
            ]
        )

    path.write_text("Gaussian, Inc.\n" + orientation(0, -10) + "\n" + orientation(2, -11))

    index, frames = _index_and_frames(path)

    assert index.fmt == "gaussian"
    assert index.total_frames == 2
    assert frames[1]["elements"] == ["C", "H"]
    assert frames[1]["positions"][1] == [3.0, 0.0, 0.0]
    assert frames[1]["properties"]["energy"] == -11.0


def test_orca_output_geometries_are_seekable(tmp_path: Path):
    path = tmp_path / "orca-opt.out"

    def geometry(x: float, energy: float) -> str:
        return "\n".join(
            [
                "CARTESIAN COORDINATES (ANGSTROEM)",
                "---------------------------------",
                f"C {x} 0.0 0.0",
                f"H {x + 1.0} 0.0 0.0",
                "",
                f"FINAL SINGLE POINT ENERGY {energy}",
            ]
        )

    path.write_text("O   R   C   A\n" + geometry(0, -20) + "\n" + geometry(2, -21))

    index, frames = _index_and_frames(path)

    assert index.fmt == "orca"
    assert index.total_frames == 2
    assert frames[1]["elements"] == ["C", "H"]
    assert frames[1]["positions"][1] == [3.0, 0.0, 0.0]
    assert frames[1]["properties"]["energy"] == -21.0


def test_pymatgen_json_coordinate_frames_are_seekable(tmp_path: Path):
    path = tmp_path / "pymatgen-relax.json"
    path.write_text(
        json.dumps(
            {
                "@class": "Trajectory",
                "species": [{"element": "H"}, {"element": "O"}],
                "lattice": [[4, 0, 0], [0, 4, 0], [0, 0, 4]],
                "coords": [
                    [[0, 0, 0], [0.5, 0, 0]],
                    [[0.25, 0, 0], [0.75, 0, 0]],
                ],
            }
        )
    )

    index, frames = _index_and_frames(path)

    assert index.fmt == "json"
    assert index.total_frames == 2
    assert frames[1]["elements"] == ["H", "O"]
    assert frames[1]["positions"] == [[1.0, 0.0, 0.0], [3.0, 0.0, 0.0]]


def test_json_frame_objects_preserve_variable_topology(tmp_path: Path):
    path = tmp_path / "relax-frames.json"
    def frame(element, x):
        return {
            "structure": {
                "lattice": {"matrix": [[5, 0, 0], [0, 5, 0], [0, 0, 5]]},
                "sites": [
                    {
                        "species": [{"element": element, "occu": 1}],
                        "xyz": [x, 0, 0],
                        "abc": [x / 5, 0, 0],
                    }
                ],
            },
            "metadata": {"energy": -x},
        }

    path.write_text(json.dumps({"frames": [frame("H", 1), frame("He", 2)]}))

    index, frames = _index_and_frames(path)

    assert index.aux["variable_topology"] is True
    assert frames[1]["elements"] == ["He"]
    assert frames[1]["properties"]["energy"] == -2
