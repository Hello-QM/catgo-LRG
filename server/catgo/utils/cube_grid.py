"""Minimal Gaussian cube reader/writer on numpy arrays."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

BOHR_TO_ANGSTROM = 0.529177210903


@dataclass
class Cube:
    comments: tuple[str, str]
    origin: np.ndarray          # (3,) Bohr
    axes: np.ndarray            # (3, 3) voxel step vectors, Bohr
    atoms: list[tuple[int, float, np.ndarray]]  # (Z, charge, xyz Bohr)
    data: np.ndarray            # (n1, n2, n3)
    extra: list[str] = field(default_factory=list)

    @property
    def shape(self) -> tuple[int, int, int]:
        return tuple(self.data.shape)  # type: ignore[return-value]


def read_cube(text: str) -> Cube:
    lines = text.splitlines()
    if len(lines) < 7:
        raise ValueError("not a cube file: too short")
    head = lines[2].split()
    natoms_signed = int(head[0])
    natoms = abs(natoms_signed)
    origin = np.array([float(v) for v in head[1:4]])
    dims = []
    axes = []
    for k in range(3):
        parts = lines[3 + k].split()
        n = int(parts[0])
        vec = np.array([float(v) for v in parts[1:4]])
        if n < 0:  # negative count: axis vectors in Angstrom
            n = -n
            vec = vec / BOHR_TO_ANGSTROM
        dims.append(n)
        axes.append(vec)
    atoms = []
    for k in range(natoms):
        parts = lines[6 + k].split()
        atoms.append((int(float(parts[0])), float(parts[1]), np.array([float(v) for v in parts[2:5]])))
    start = 6 + natoms
    extra: list[str] = []
    if natoms_signed < 0:
        # orbital cubes: one extra line listing the orbitals
        extra.append(lines[start])
        start += 1
    values = np.array(" ".join(lines[start:]).split(), dtype=float)
    expected = dims[0] * dims[1] * dims[2]
    if values.size < expected:
        raise ValueError(f"cube has {values.size} values, expected {expected}")
    data = values[-expected:].reshape(dims) if values.size > expected else values.reshape(dims)
    return Cube(
        comments=(lines[0], lines[1]),
        origin=origin,
        axes=np.array(axes),
        atoms=atoms,
        data=data,
        extra=extra,
    )


def write_cube(template: Cube, data: np.ndarray, comment: str | None = None) -> str:
    """Cube text with ``template``'s header and atoms and new ``data``."""
    if data.shape != template.data.shape:
        raise ValueError("data shape does not match the template grid")
    n1, n2, n3 = data.shape
    out = [comment or template.comments[0], template.comments[1]]
    out.append(f"{len(template.atoms):5d}" + "".join(f"{v:12.6f}" for v in template.origin))
    for n, vec in zip(data.shape, template.axes):
        out.append(f"{n:5d}" + "".join(f"{v:12.6f}" for v in vec))
    for z, charge, xyz in template.atoms:
        out.append(f"{z:5d}{charge:12.6f}" + "".join(f"{v:12.6f}" for v in xyz))
    flat = data.reshape(n1 * n2, n3)
    for row in flat:
        for k in range(0, n3, 6):
            out.append("".join(f"{v:13.5E}" for v in row[k:k + 6]))
    return "\n".join(out) + "\n"
