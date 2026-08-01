"""Compact trajectory position packets avoid JSON/site-object playback churn."""

import struct

import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient

from catgo.routers.trajectory_stream import router


def test_positions_endpoint_returns_contiguous_float32_frames(tmp_path):
    traj = tmp_path / "tiny.xyz"
    traj.write_text(
        "\n".join(
            [
                "2",
                "frame=0",
                "H 0 0 0",
                "O 1 2 3",
                "2",
                "frame=1",
                "H 4 5 6",
                "O 7 8 9",
            ]
        )
    )
    app = FastAPI()
    app.include_router(router)

    response = TestClient(app).get(
        "/trajectory/positions",
        params={"path": str(traj), "start": 0, "count": 2},
    )

    assert response.status_code == 200
    magic, version, frame_count, n_atoms = struct.unpack_from(
        "<4sIII", response.content, 0
    )
    assert (magic, version, frame_count, n_atoms) == (b"CGTP", 2, 2, 2)

    offset = 16
    frames = []
    for expected_idx in range(2):
        frame_idx, frame_n_atoms, flags, *_lattice = struct.unpack_from(
            "<III9d", response.content, offset
        )
        offset += struct.calcsize("<III9d")
        positions = np.frombuffer(
            response.content, dtype="<f4", count=frame_n_atoms * 3, offset=offset
        ).copy()
        offset += positions.nbytes
        assert frame_idx == expected_idx
        assert frame_n_atoms == n_atoms
        assert flags == 0
        frames.append(positions)

    assert np.allclose(frames[0], [0, 0, 0, 1, 2, 3])
    assert np.allclose(frames[1], [4, 5, 6, 7, 8, 9])
    assert offset == len(response.content)


def test_positions_packet_carries_per_frame_atom_counts(tmp_path):
    traj = tmp_path / "variable.extxyz"
    traj.write_text(
        "\n".join(
            [
                "2", "frame=0", "H 0 0 0", "O 1 0 0",
                "1", "frame=1", "He 2 0 0",
            ]
        )
    )
    app = FastAPI()
    app.include_router(router)

    response = TestClient(app).get(
        "/trajectory/positions",
        params={"path": str(traj), "start": 0, "count": 2},
    )

    assert response.status_code == 200
    _magic, version, frame_count, reference_atoms = struct.unpack_from(
        "<4sIII", response.content, 0
    )
    assert (version, frame_count, reference_atoms) == (2, 2, 2)
    offset = 16
    atom_counts = []
    flags = []
    for _ in range(frame_count):
        _frame, n_atoms, frame_flags, *_ = struct.unpack_from(
            "<III9d", response.content, offset
        )
        offset += struct.calcsize("<III9d")
        atom_counts.append(n_atoms)
        flags.append(frame_flags)
        offset += n_atoms * 3 * 4
    assert atom_counts == [2, 1]
    assert flags[0] & 2 == 0
    assert flags[1] & 2 == 2
    assert offset == len(response.content)
