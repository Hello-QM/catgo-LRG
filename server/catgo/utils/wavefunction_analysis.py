"""Post-processing of Multiwfn and NBO output for the wavefunction panel.

* IRI (interaction region indicator, Lu & Chen, Chem.-Methods 2021, 1, 231):
  IRI = |∇ρ| / ρ^1.1, computed here from Multiwfn density and gradient-norm
  cubes.
* sign(λ2)ρ scatter data for IRI and IGMH plots.
* AIM critical points from Multiwfn's CPprop.txt, with each bond critical
  point paired to the two nuclei it links (bond paths drawn as two straight
  segments; real paths curve slightly).
* NBO: natural charges, Wiberg bond indices and second-order perturbation
  (E(2)) donor→acceptor energies from Gaussian/ORCA NBO 3–7 output.
"""

from __future__ import annotations

import re
from typing import Any

import numpy as np

from catgo.utils.cube_grid import BOHR_TO_ANGSTROM, Cube

IRI_EXPONENT = 1.1
SL2R_RANGE = (-0.04, 0.02)   # Multiwfn's usual blue-green-red mapping
BGR_COLORSCALE = [[0.0, "#0000ff"], [0.04 / 0.06, "#00ff00"], [1.0, "#ff0000"]]


# ── IRI / scatter ───────────────────────────────────────────────────────────

def iri_grid(rho: np.ndarray, grad: np.ndarray, exponent: float = IRI_EXPONENT) -> np.ndarray:
    return grad / np.power(np.clip(rho, 1e-30, None), exponent)


def scatter_plot(
    x: np.ndarray,
    y: np.ndarray,
    y_label: str,
    y_max: float,
    x_range: tuple[float, float] = (-0.05, 0.05),
    max_points: int = 30000,
    seed: int = 0,
) -> dict[str, Any]:
    """Plotly data for a y vs sign(λ2)ρ scatter (IRI or δg_inter)."""
    xf, yf = x.ravel(), y.ravel()
    keep = (xf >= x_range[0]) & (xf <= x_range[1]) & (yf > 0) & (yf <= y_max)
    xs, ys = xf[keep], yf[keep]
    if xs.size > max_points:
        pick = np.random.default_rng(seed).choice(xs.size, max_points, replace=False)
        xs, ys = xs[pick], ys[pick]
    return {
        "traces": [{
            "type": "scattergl",
            "mode": "markers",
            "x": xs.round(6).tolist(),
            "y": ys.round(6).tolist(),
            "marker": {
                "size": 2,
                "color": xs.round(6).tolist(),
                "colorscale": BGR_COLORSCALE,
                "cmin": SL2R_RANGE[0],
                "cmax": SL2R_RANGE[1],
            },
            "hoverinfo": "skip",
            "showlegend": False,
        }],
        "layout": {
            "height": 320,
            "paper_bgcolor": "rgba(0,0,0,0)",
            "plot_bgcolor": "rgba(0,0,0,0)",
            "xaxis": {"title": {"text": "sign(λ₂)ρ (a.u.)"}, "range": list(x_range)},
            "yaxis": {"title": {"text": y_label}, "range": [0, y_max]},
            "margin": {"l": 60, "r": 20, "t": 20, "b": 50},
        },
        "annotations": [],
        "n_points": int(keep.sum()),
    }


def same_grid(a: Cube, b: Cube) -> bool:
    return a.shape == b.shape and np.allclose(a.origin, b.origin, atol=1e-4) and np.allclose(
        a.axes, b.axes, atol=1e-6
    )


# ── AIM ─────────────────────────────────────────────────────────────────────

CP_TYPES = {
    "(3,-3)": "NCP",
    "(3,-1)": "BCP",
    "(3,+1)": "RCP",
    "(3,+3)": "CCP",
}

_CP_HEADER = re.compile(r"CP\s+(\d+)\s*,\s*Type\s*\(\s*3\s*,\s*([-+]?\d)\s*\)", re.IGNORECASE)
_FLOAT = re.compile(r"[-+]?\d+\.\d*(?:[EeDd][-+]?\d+)?")

_CP_KEYS = {
    "density of all electrons": "rho",
    "laplacian of electron density": "laplacian",
    "lagrangian kinetic energy g(r)": "G",
    "potential energy density v(r)": "V",
    "energy density e(r) or h(r)": "H",
    "electron localization function (elf)": "ELF",
    "ellipticity of electron density": "ellipticity",
    "eta index": "eta",
}


def parse_cpprop(text: str) -> list[dict[str, Any]]:
    """Critical points from Multiwfn's CPprop.txt (atomic units)."""
    cps: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line in text.splitlines():
        m = _CP_HEADER.search(line)
        if m:
            sig = int(m.group(2))
            key = f"(3,{'+' if sig > 0 else ''}{sig})"
            current = {"index": int(m.group(1)), "type": key, "kind": CP_TYPES.get(key, key)}
            cps.append(current)
            continue
        if current is None or ":" not in line:
            continue
        label, _, rest = line.partition(":")
        label = label.strip().lower()
        nums = _FLOAT.findall(rest)
        if label == "position (angstrom)" and len(nums) >= 3:
            current["position"] = [float(v.replace("D", "E")) for v in nums[:3]]
        elif label == "position (bohr)" and len(nums) >= 3 and "position" not in current:
            current["position"] = [float(v.replace("D", "E")) * BOHR_TO_ANGSTROM for v in nums[:3]]
        elif label == "corresponding nucleus":
            m2 = re.search(r"(\d+)\s*\(\s*([A-Za-z]{1,2})", rest)
            if m2:
                current["nucleus"] = int(m2.group(1))
                current["element"] = m2.group(2)
        elif label in _CP_KEYS and nums:
            current[_CP_KEYS[label]] = float(nums[0].replace("D", "E"))
    return [cp for cp in cps if "position" in cp]


def pair_bond_paths(cps: list[dict], atoms: list[dict]) -> list[dict[str, Any]]:
    """Link every BCP to the two nuclei it most plausibly bridges.

    Picks, among the six nearest nuclei, the pair minimising
    (|p−A| + |p−B|) / |A−B| — 1 for a point on the A–B segment.
    """
    if not atoms:
        return []
    xyz = np.array([a["xyz"] for a in atoms], dtype=float)
    paths = []
    for cp in cps:
        if cp["kind"] != "BCP":
            continue
        p = np.array(cp["position"])
        d = np.linalg.norm(xyz - p, axis=1)
        near = np.argsort(d)[: min(6, len(atoms))]
        best = None
        for ii, i in enumerate(near):
            for j in near[ii + 1:]:
                ab = np.linalg.norm(xyz[i] - xyz[j])
                if ab < 1e-6:
                    continue
                score = (d[i] + d[j]) / ab
                if best is None or score < best[0]:
                    best = (score, int(i), int(j))
        if best is None:
            continue
        _, i, j = best
        i, j = min(i, j), max(i, j)
        cp["atoms"] = [i + 1, j + 1]
        paths.append({
            "cp": cp["index"],
            "atoms": [i + 1, j + 1],
            "points": [xyz[i].tolist(), p.tolist(), xyz[j].tolist()],
        })
    return paths


# ── NBO ─────────────────────────────────────────────────────────────────────

_NPA_ROW = re.compile(
    r"^\s*([A-Z][a-z]?)\s+(\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)"
)
_WBI_HEADER = re.compile(r"^\s*Atom(\s+\d+)+\s*$")
_WBI_ROW = re.compile(r"^\s*(\d+)\.\s+([A-Za-z]{1,2})((?:\s+-?\d+\.\d+)+)\s*$")
_E2_ROW = re.compile(
    r"^\s*(\d+)\.\s*(\S.*?)\s+/?\s*(\d+)\.\s*(\S.*?)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*$"
)


def _npa_charges(lines: list[str]) -> list[dict[str, Any]]:
    for k, line in enumerate(lines):
        if "Summary of Natural Population Analysis" not in line:
            continue
        rows = []
        for row in lines[k + 1:]:
            m = _NPA_ROW.match(row)
            if m:
                rows.append({
                    "atom": int(m.group(2)),
                    "symbol": m.group(1),
                    "charge": float(m.group(3)),
                    "core": float(m.group(4)),
                    "valence": float(m.group(5)),
                    "rydberg": float(m.group(6)),
                    "total": float(m.group(7)),
                })
            elif rows and ("====" in row or "Total" in row):
                break
        if rows:
            return rows
    return []


def _wiberg(lines: list[str]) -> list[list[float]]:
    for k, line in enumerate(lines):
        if "Wiberg bond index matrix" not in line:
            continue
        cols: list[int] = []
        matrix: dict[int, dict[int, float]] = {}
        for row in lines[k + 1:]:
            if not row.strip() or set(row.strip()) <= set("- "):
                continue
            if _WBI_HEADER.match(row):
                cols = [int(c) for c in row.split()[1:]]
                continue
            m = _WBI_ROW.match(row)
            if m and cols:
                vals = [float(v) for v in m.group(3).split()]
                matrix.setdefault(int(m.group(1)), {}).update(zip(cols, vals))
                continue
            break
        if matrix:
            n = max(matrix)
            return [[matrix.get(i, {}).get(j, 0.0) for j in range(1, n + 1)] for i in range(1, n + 1)]
    return []


def _e2_entries(lines: list[str]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    spin = None
    in_e2 = False
    for line in lines:
        upper = line.upper()
        if "ALPHA SPIN ORBITALS" in upper:
            spin = "alpha"
        elif "BETA SPIN ORBITALS" in upper:
            spin = "beta"
        if "SECOND ORDER PERTURBATION THEORY ANALYSIS" in upper:
            in_e2 = True
            continue
        if not in_e2:
            continue
        if "NATURAL BOND ORBITALS (SUMMARY)" in upper or "NBO SUMMARY" in upper:
            in_e2 = False
            continue
        m = _E2_ROW.match(line)
        if m:
            entries.append({
                "donor_index": int(m.group(1)),
                "donor": " ".join(m.group(2).split()),
                "acceptor_index": int(m.group(3)),
                "acceptor": " ".join(m.group(4).split()),
                "e2": float(m.group(5)),          # kcal/mol
                "gap": float(m.group(6)),         # E(j)-E(i), a.u.
                "fock": float(m.group(7)),        # F(i,j), a.u.
                "spin": spin,
            })
    return entries


def parse_nbo(text: str, max_e2: int = 300) -> dict[str, Any]:
    """Natural charges, Wiberg indices and E(2) list from NBO output."""
    lines = text.splitlines()
    charges = _npa_charges(lines)
    wiberg = _wiberg(lines)
    e2 = sorted(_e2_entries(lines), key=lambda e: -e["e2"])
    if not charges and not wiberg and not e2:
        raise ValueError("no NBO results found (expected natural population, Wiberg or E(2) sections)")
    bonds = []
    for i, row in enumerate(wiberg):
        for j in range(i + 1, len(row)):
            if row[j] >= 0.1:
                bonds.append({"atoms": [i + 1, j + 1], "wbi": row[j]})
    bonds.sort(key=lambda b: -b["wbi"])
    return {
        "charges": charges,
        "wiberg": wiberg,
        "bonds": bonds,
        "e2": e2[:max_e2],
        "n_e2": len(e2),
    }
