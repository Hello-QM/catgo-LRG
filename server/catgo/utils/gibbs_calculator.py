"""Gibbs free energy correction calculator.

Ported from gibbs_adsorbed.py — two modes:
  adsorbed: all real frequencies → vibrational partition function (low-freq cutoff)
  gas:      translation + rotation + vibration + electronic (ideal gas + harmonic approx)
"""

from __future__ import annotations

import math

# ==================== Physical constants (2018 CODATA) ====================
h_planck = 6.62607015e-34      # J·s
kB       = 1.380649e-23        # J/K
c_light  = 2.99792458e10       # cm/s
eV_J     = 1.602176634e-19     # eV -> J
NA       = 6.02214076e23       # mol^-1
amu_kg   = 1.66053906660e-27   # amu -> kg

eV_to_kcal = 23.0605           # eV -> kcal/mol


def vib_contributions(freqs_cm: list[float], T: float) -> tuple[float, float, float]:
    """Vibrational ZPE, thermal correction dU, and entropy S.

    Args:
        freqs_cm: Frequencies in cm⁻¹.
        T: Temperature in K.

    Returns:
        (ZPE_eV, dU_vib_eV, S_vib_eV_per_K)
    """
    if not freqs_cm or T <= 0:
        return 0.0, 0.0, 0.0

    zpe = 0.0
    du = 0.0
    s = 0.0

    for freq in freqs_cm:
        freq_eV = freq * h_planck * c_light / eV_J
        x = freq_eV * eV_J / (kB * T)
        zpe += 0.5 * freq_eV

        if x > 500:
            # Avoid overflow — negligible thermal population
            continue
        exp_x = math.exp(x)
        du += freq_eV / (exp_x - 1)
        s += (kB / eV_J) * (x / (exp_x - 1) - math.log(1 - math.exp(-x)))

    return zpe, du, s


def calc_adsorbed(
    real_freqs_cm: list[float],
    imag_freqs_cm: list[float],
    T: float = 298.15,
    freq_cutoff: float = 50.0,
) -> dict:
    """Gibbs correction for adsorbed species (vibrations only).

    Low frequencies below freq_cutoff are replaced by freq_cutoff
    to avoid divergence in the harmonic approximation.

    Returns dict with: zpe_ev, du_vib_ev, ts_vib_ev, h_corr_ev, g_corr_ev,
                       freq_processed (list of processed freqs)
    """
    # Apply low-freq cutoff
    freq_processed = [max(f, freq_cutoff) for f in real_freqs_cm]

    zpe, du_vib, s_vib = vib_contributions(freq_processed, T)
    ts_vib = T * s_vib
    h_corr = zpe + du_vib
    g_corr = h_corr - ts_vib

    return {
        "mode": "adsorbed",
        "temperature": T,
        "freq_cutoff": freq_cutoff,
        "n_real": len(real_freqs_cm),
        "n_imag": len(imag_freqs_cm),
        "zpe_ev": zpe,
        "du_vib_ev": du_vib,
        "ts_vib_ev": ts_vib,
        "h_corr_ev": h_corr,
        "g_corr_ev": g_corr,
        "zpe_kcal": zpe * eV_to_kcal,
        "du_vib_kcal": du_vib * eV_to_kcal,
        "ts_vib_kcal": ts_vib * eV_to_kcal,
        "h_corr_kcal": h_corr * eV_to_kcal,
        "g_corr_kcal": g_corr * eV_to_kcal,
        "freq_processed": freq_processed,
    }


def compute_molecular_properties(
    positions: list[list[float]], masses_amu: list[float]
) -> tuple[float, list[float]]:
    """Compute total mass and principal moments of inertia.

    Args:
        positions: Cartesian positions in Å, shape [N][3].
        masses_amu: Atomic masses in amu, length N.

    Returns:
        (total_mass_kg, [I_A, I_B, I_C] in kg·m²)
    """
    n = len(masses_amu)
    # Convert to SI
    mass_kg = [m * amu_kg for m in masses_amu]
    total_mass = sum(mass_kg)

    # Center of mass
    com = [0.0, 0.0, 0.0]
    for k in range(n):
        for d in range(3):
            com[d] += mass_kg[k] * positions[k][d] * 1e-10
    com = [c / total_mass for c in com]

    # Relative positions in meters
    r = [[positions[k][d] * 1e-10 - com[d] for d in range(3)] for k in range(n)]

    # Inertia tensor
    I = [[0.0] * 3 for _ in range(3)]
    for k in range(n):
        x, y, z = r[k]
        mk = mass_kg[k]
        I[0][0] += mk * (y*y + z*z)
        I[1][1] += mk * (x*x + z*z)
        I[2][2] += mk * (x*x + y*y)
        I[0][1] -= mk * x * y
        I[0][2] -= mk * x * z
        I[1][2] -= mk * y * z
    I[1][0] = I[0][1]
    I[2][0] = I[0][2]
    I[2][1] = I[1][2]

    # Diagonalize (simple 3x3 eigenvalue via numpy-free approach)
    eigvals = _eigvalsh_3x3(I)
    eigvals.sort()

    return total_mass, eigvals


def _eigvalsh_3x3(A: list[list[float]]) -> list[float]:
    """Eigenvalues of a 3x3 symmetric matrix (analytical Cardano's method)."""
    a11, a12, a13 = A[0]
    _, a22, a23 = A[1]
    _, _, a33 = A[2]

    p1 = a12**2 + a13**2 + a23**2
    if p1 < 1e-40:
        # Already diagonal
        return [a11, a22, a33]

    q = (a11 + a22 + a33) / 3.0
    p2 = (a11 - q)**2 + (a22 - q)**2 + (a33 - q)**2 + 2 * p1
    p = math.sqrt(p2 / 6.0)

    # B = (1/p) * (A - q*I)
    B = [
        [(A[i][j] - (q if i == j else 0)) / p for j in range(3)]
        for i in range(3)
    ]
    det_B = (
        B[0][0] * (B[1][1] * B[2][2] - B[1][2] * B[2][1])
        - B[0][1] * (B[1][0] * B[2][2] - B[1][2] * B[2][0])
        + B[0][2] * (B[1][0] * B[2][1] - B[1][1] * B[2][0])
    )
    r = det_B / 2.0

    # Clamp for acos
    r = max(-1.0, min(1.0, r))
    phi = math.acos(r) / 3.0

    eig1 = q + 2 * p * math.cos(phi)
    eig3 = q + 2 * p * math.cos(phi + 2 * math.pi / 3)
    eig2 = 3 * q - eig1 - eig3

    return [eig1, eig2, eig3]


def detect_symmetry(
    positions: list[list[float]],
    atom_types: list[int],
    masses_amu: list[float],
) -> tuple[bool, int]:
    """Auto-detect molecular linearity and rotational symmetry number sigma.

    Returns: (is_linear, sigma)
    """
    n = len(positions)
    if n <= 1:
        return False, 1
    if n == 2:
        return True, (2 if atom_types[0] == atom_types[1] else 1)

    # Center of mass
    mass_kg = [m * amu_kg for m in masses_amu]
    total = sum(mass_kg)
    com = [0.0, 0.0, 0.0]
    for k in range(n):
        for d in range(3):
            com[d] += mass_kg[k] * positions[k][d]
    com = [c / total for c in com]

    pos = [[positions[k][d] - com[d] for d in range(3)] for k in range(n)]

    # Inertia tensor (for finding principal axes)
    It = [[0.0] * 3 for _ in range(3)]
    for k in range(n):
        x, y, z = pos[k]
        It[0][0] += y*y + z*z
        It[1][1] += x*x + z*z
        It[2][2] += x*x + y*y
        It[0][1] -= x * y
        It[0][2] -= x * z
        It[1][2] -= y * z
    It[1][0] = It[0][1]
    It[2][0] = It[0][2]
    It[2][1] = It[1][2]

    eigvals = _eigvalsh_3x3(It)
    eigvals.sort()

    # Linear if smallest I << largest I
    is_linear = (eigvals[0] / max(eigvals[2], 1e-30) < 1e-3)

    # For symmetry number detection we need eigenvectors — use power iteration
    # This is a simplified approach; for the server we'll use a heuristic
    # based on known molecular symmetries
    eigvecs = _eigvecs_3x3(It)

    # Tolerance: 30% of min same-type distance, capped at 0.5 Å
    min_d = float("inf")
    for i in range(n):
        for j in range(i + 1, n):
            if atom_types[i] == atom_types[j]:
                d = math.sqrt(sum((pos[i][d2] - pos[j][d2])**2 for d2 in range(3)))
                min_d = min(min_d, d)
    tol = min(0.3 * min_d, 0.5) if min_d < float("inf") else 0.3

    # Generate candidate axes
    axes: list[list[float]] = []
    for i in range(3):
        axes.append(eigvecs[i])
    for i in range(n):
        r = math.sqrt(sum(c**2 for c in pos[i]))
        if r > 0.05:
            axes.append([c / r for c in pos[i]])

    types_set = set(atom_types)
    for t in types_set:
        idx = [i for i in range(n) if atom_types[i] == t]
        for a in range(len(idx)):
            for b in range(a + 1, len(idx)):
                # Midpoint and difference vectors
                for vec in [
                    [(pos[idx[a]][d2] + pos[idx[b]][d2]) / 2 for d2 in range(3)],
                    [pos[idx[a]][d2] - pos[idx[b]][d2] for d2 in range(3)],
                ]:
                    r = math.sqrt(sum(c**2 for c in vec))
                    if r > 0.05:
                        axes.append([c / r for c in vec])

        if len(idx) >= 3:
            for a in range(min(len(idx), 5)):
                for b in range(a + 1, min(len(idx), 5)):
                    for c in range(b + 1, min(len(idx), 5)):
                        # Cross product for face normal
                        v1 = [pos[idx[b]][d2] - pos[idx[a]][d2] for d2 in range(3)]
                        v2 = [pos[idx[c]][d2] - pos[idx[a]][d2] for d2 in range(3)]
                        normal = [
                            v1[1]*v2[2] - v1[2]*v2[1],
                            v1[2]*v2[0] - v1[0]*v2[2],
                            v1[0]*v2[1] - v1[1]*v2[0],
                        ]
                        r = math.sqrt(sum(x**2 for x in normal))
                        if r > 0.01:
                            axes.append([x / r for x in normal])

    # Search for rotation symmetry operations
    identity = tuple(range(n))
    ops = {identity}
    for axis in axes:
        for n_fold in [2, 3, 4, 5, 6]:
            for k in range(1, n_fold):
                perm = _find_perm(pos, atom_types, axis, 2 * math.pi * k / n_fold, tol)
                if perm is not None:
                    ops.add(perm)

    return is_linear, len(ops)


def _rot_matrix(axis: list[float], angle: float) -> list[list[float]]:
    """Rodrigues' rotation formula — returns 3x3 rotation matrix."""
    norm = math.sqrt(sum(c**2 for c in axis))
    a = [c / norm for c in axis]
    K = [
        [0, -a[2], a[1]],
        [a[2], 0, -a[0]],
        [-a[1], a[0], 0],
    ]
    sa = math.sin(angle)
    ca = 1 - math.cos(angle)
    # R = I + sin(θ)*K + (1-cos(θ))*K²
    KK = _mat_mul(K, K)
    R = [[0.0] * 3 for _ in range(3)]
    for i in range(3):
        for j in range(3):
            R[i][j] = (1.0 if i == j else 0.0) + sa * K[i][j] + ca * KK[i][j]
    return R


def _mat_mul(A: list[list[float]], B: list[list[float]]) -> list[list[float]]:
    """3x3 matrix multiply."""
    C = [[0.0] * 3 for _ in range(3)]
    for i in range(3):
        for j in range(3):
            C[i][j] = sum(A[i][k] * B[k][j] for k in range(3))
    return C


def _find_perm(
    pos: list[list[float]], types: list[int],
    axis: list[float], angle: float, tol: float,
) -> tuple[int, ...] | None:
    """Check if rotating by angle around axis gives a valid permutation."""
    R = _rot_matrix(axis, angle)
    n = len(pos)

    # Apply rotation: rotated = pos @ R^T  (each row is a point)
    rotated = [[sum(pos[i][k] * R[j][k] for k in range(3)) for j in range(3)] for i in range(n)]

    perm = [-1] * n
    used = [False] * n
    for i in range(n):
        best_j = -1
        best_d = tol
        for j in range(n):
            if used[j] or types[i] != types[j]:
                continue
            d = math.sqrt(sum((rotated[i][d2] - pos[j][d2])**2 for d2 in range(3)))
            if d < best_d:
                best_d = d
                best_j = j
        if best_j == -1:
            return None
        perm[i] = best_j
        used[best_j] = True
    return tuple(perm)


def _eigvecs_3x3(A: list[list[float]]) -> list[list[float]]:
    """Approximate eigenvectors for a 3x3 symmetric matrix using Jacobi iteration."""
    import copy
    M = copy.deepcopy(A)
    V = [[1 if i == j else 0 for j in range(3)] for i in range(3)]

    for _ in range(30):
        # Find largest off-diagonal
        p, q = 0, 1
        mx = abs(M[0][1])
        for i in range(3):
            for j in range(i + 1, 3):
                if abs(M[i][j]) > mx:
                    mx = abs(M[i][j])
                    p, q = i, j
        if mx < 1e-15:
            break

        if abs(M[p][p] - M[q][q]) < 1e-30:
            theta = math.pi / 4
        else:
            theta = 0.5 * math.atan2(2 * M[p][q], M[p][p] - M[q][q])

        c = math.cos(theta)
        s = math.sin(theta)

        # Givens rotation
        Mp = [M[i][p] * c + M[i][q] * s for i in range(3)]
        Mq = [-M[i][p] * s + M[i][q] * c for i in range(3)]
        for i in range(3):
            M[i][p] = Mp[i]
            M[i][q] = Mq[i]
        Mp = [M[p][j] * c + M[q][j] * s for j in range(3)]
        Mq = [-M[p][j] * s + M[q][j] * c for j in range(3)]
        for j in range(3):
            M[p][j] = Mp[j]
            M[q][j] = Mq[j]

        Vp = [V[i][p] * c + V[i][q] * s for i in range(3)]
        Vq = [-V[i][p] * s + V[i][q] * c for i in range(3)]
        for i in range(3):
            V[i][p] = Vp[i]
            V[i][q] = Vq[i]

    # Return column vectors (eigenvectors)
    return [[V[i][j] for i in range(3)] for j in range(3)]


def calc_gas(
    real_freqs_cm: list[float],
    imag_freqs_cm: list[float],
    positions: list[list[float]],
    masses_amu: list[float],
    atom_types: list[int],
    T: float = 298.15,
    P: float = 101325.0,
    n_unpaired: int = 0,
    free_indices: list[int] | None = None,
) -> dict:
    """Gibbs correction for gas-phase molecule.

    Uses ideal gas + rigid rotor + harmonic oscillator approximation.

    Args:
        real_freqs_cm: Real vibrational frequencies in cm⁻¹.
        imag_freqs_cm: Imaginary frequencies in cm⁻¹.
        positions: Cartesian coords in Å, shape [N][3].
        masses_amu: Atomic masses in amu, length N.
        atom_types: Type index per atom, length N.
        T: Temperature in K.
        P: Pressure in Pa.
        n_unpaired: Number of unpaired electrons.
        free_indices: Indices of free atoms (from selective dynamics), or None for all.

    Returns dict with detailed thermodynamic breakdown.
    """
    kBT_eV = kB * T / eV_J
    g0 = n_unpaired + 1

    # If no positions/masses provided, fall back to vibration-only (adsorbed mode)
    # This handles cases where the gas-phase gibbs_energy task doesn't receive
    # molecular geometry from the freq task (missing graph links).
    if not positions or not masses_amu:
        result = calc_adsorbed(real_freqs_cm, imag_freqs_cm, T=T, freq_cutoff=0.0)
        result["mode"] = "gas_vib_only"
        result["warning"] = "No positions/masses provided; used vibration-only (missing trans+rot)"
        return result

    # Determine molecular atoms (selective dynamics or all)
    if free_indices is not None:
        mol_pos = [positions[i] for i in free_indices]
        mol_masses = [masses_amu[i] for i in free_indices]
        mol_types = [atom_types[i] for i in free_indices]
    else:
        mol_pos = positions
        mol_masses = masses_amu
        mol_types = atom_types

    n_mol = len(mol_pos)

    # Molecular properties
    total_mass, inertia = compute_molecular_properties(mol_pos, mol_masses)

    # Auto-detect symmetry
    is_linear, sigma = detect_symmetry(mol_pos, mol_types, mol_masses)
    n_rot = 2 if is_linear else 3
    n_vib_expected = 3 * n_mol - 3 - n_rot

    # Select vibrational frequencies (highest n_vib_expected real freqs)
    freq_sorted = sorted(real_freqs_cm, reverse=True)
    if len(freq_sorted) < n_vib_expected:
        freq_vib = freq_sorted
        n_vib_expected = len(freq_sorted)
    else:
        freq_vib = freq_sorted[:n_vib_expected]
    freq_vib = sorted(freq_vib)
    freq_excluded = freq_sorted[n_vib_expected:] if len(freq_sorted) > n_vib_expected else []

    # === 1. Translation ===
    qt = (2 * math.pi * total_mass * kB * T / h_planck**2)**1.5 * kB * T / P
    u_trans = 1.5 * kBT_eV
    s_trans = (kB / eV_J) * (math.log(qt) + 2.5) if qt > 0 else 0.0

    # === 2. Rotation ===
    if is_linear:
        I_lin = max(inertia)
        qr = 8 * math.pi**2 * I_lin * kB * T / (sigma * h_planck**2) if I_lin > 0 else 1.0
        u_rot = kBT_eV
        s_rot = (kB / eV_J) * (math.log(qr) + 1.0) if qr > 0 else 0.0
    else:
        I_A, I_B, I_C = inertia
        product = I_A * I_B * I_C
        if product > 0:
            qr = (math.sqrt(math.pi) / sigma
                  * (8 * math.pi**2 * kB * T)**1.5
                  * math.sqrt(product) / h_planck**3)
        else:
            qr = 1.0
        u_rot = 1.5 * kBT_eV
        s_rot = (kB / eV_J) * (math.log(qr) + 1.5) if qr > 0 else 0.0

    # === 3. Vibration ===
    zpe, du_vib, s_vib = vib_contributions(freq_vib, T)

    # === 4. Electronic ===
    s_elec = (kB / eV_J) * math.log(g0) if g0 > 1 else 0.0

    # === 5. PV = kBT (ideal gas) ===
    pv = kBT_eV

    # === Summary ===
    h_corr = zpe + du_vib + u_trans + u_rot + pv
    s_total = s_trans + s_rot + s_vib + s_elec
    ts_total = T * s_total
    g_corr = h_corr - ts_total

    return {
        "mode": "gas",
        "temperature": T,
        "pressure_pa": P,
        "pressure_atm": P / 101325.0,
        "n_unpaired": n_unpaired,
        "n_mol_atoms": n_mol,
        "molecular_mass_amu": total_mass / amu_kg,
        "is_linear": is_linear,
        "sigma": sigma,
        "n_vib_modes": len(freq_vib),
        "n_vib_expected": n_vib_expected,
        "freq_vib": freq_vib,
        "freq_excluded": freq_excluded,
        "n_real": len(real_freqs_cm),
        "n_imag": len(imag_freqs_cm),
        # Enthalpy contributions (eV)
        "zpe_ev": zpe,
        "du_vib_ev": du_vib,
        "u_trans_ev": u_trans,
        "u_rot_ev": u_rot,
        "pv_ev": pv,
        "h_corr_ev": h_corr,
        # Entropy contributions (eV/K)
        "s_trans": s_trans,
        "s_rot": s_rot,
        "s_vib": s_vib,
        "s_elec": s_elec,
        "s_total": s_total,
        # TS contributions (eV)
        "ts_trans_ev": T * s_trans,
        "ts_rot_ev": T * s_rot,
        "ts_vib_ev": T * s_vib,
        "ts_elec_ev": T * s_elec,
        "ts_total_ev": ts_total,
        # Final result
        "g_corr_ev": g_corr,
        # kcal/mol conversions
        "zpe_kcal": zpe * eV_to_kcal,
        "h_corr_kcal": h_corr * eV_to_kcal,
        "ts_total_kcal": ts_total * eV_to_kcal,
        "g_corr_kcal": g_corr * eV_to_kcal,
    }
