"""VASP REPORT file parser for slow-growth thermodynamic integration.

Parses the REPORT file produced by VASP slow-growth MD calculations
(LBLUEOUT=.TRUE.) to extract:
- cc> lines: CV values (collective variable, typically distance R)
- b_m> lines: Blue Moon sampling data
    - lambda: Lagrange multiplier (constraint force)
    - |z|^(-1/2): metric factor
    - GkT: geometric correction term
    - |z|^(-1/2)*(lambda+GkT): mean force for free energy integration

Thermodynamic integration formula:
    ΔF = ∫ <|Z|^(-1/2) * (λ + GkT)>_ξ dξ
    where ξ is the collective variable (CV)
"""

import re
from dataclasses import dataclass, field

# Unit conversion constants
EV_TO_KCAL_MOL = 23.0605


@dataclass
class SlowGrowthStep:
    """Data from one MD step."""
    step: int
    b_cnt: int = 1  # constraint index
    # cc> fields
    cv_target: float = 0.0  # target CV value
    cv_actual: float = 0.0  # actual CV value
    cv_diff: float = 0.0  # difference (target - actual)
    # b_m> fields (Blue Moon ensemble)
    lambda_val: float = 0.0  # Lagrange multiplier (constraint force)
    z_inv_sqrt: float = 0.0  # |z|^(-1/2) metric factor
    GkT: float = 0.0  # geometric correction term
    mean_force: float = 0.0  # |z|^(-1/2)*(lambda+GkT) — for TI
    # Legacy cc> fields (dA/dxsi format)
    cv: float = 0.0  # collective variable (from legacy format)
    dcv: float = 0.0  # CV change per step
    dA_dxsi: float = 0.0  # free energy gradient
    has_blue_moon: bool = False  # whether b_m> data is present


@dataclass
class BarrierAnalysis:
    """Free energy barrier analysis results."""
    total_delta_F: float = 0.0  # Total free energy change (eV)
    total_delta_F_kcal: float = 0.0  # Total free energy change (kcal/mol)
    max_F: float = 0.0  # Maximum free energy (eV)
    max_F_cv: float = 0.0  # CV at maximum free energy
    min_F: float = 0.0  # Minimum free energy (eV)
    min_F_cv: float = 0.0  # CV at minimum free energy
    barrier_forward: float = 0.0  # Forward barrier: max - start (eV)
    barrier_forward_kcal: float = 0.0
    barrier_reverse: float = 0.0  # Reverse barrier: max - end (eV)
    barrier_reverse_kcal: float = 0.0
    cv_start: float = 0.0
    cv_end: float = 0.0
    num_steps: int = 0


@dataclass
class SlowGrowthData:
    """Parsed slow-growth REPORT data."""
    steps: list[SlowGrowthStep] = field(default_factory=list)
    num_constraints: int = 0
    total_steps: int = 0
    has_blue_moon: bool = False  # True if b_m> lines were found

    def get_constraint_data(self, b_cnt: int = 1) -> dict:
        """Get time series for a specific constraint.

        Returns dict with arrays for plotting and analysis.
        Uses Blue Moon mean_force for integration when available,
        falls back to dA/dxsi * dcv for legacy format.
        """
        filtered = [s for s in self.steps if s.b_cnt == b_cnt]
        if not filtered:
            return {
                "step": [], "cv_target": [], "cv_actual": [], "cv_diff": [],
                "lambda_val": [], "z_inv_sqrt": [], "GkT": [], "mean_force": [],
                "cv": [], "dcv": [], "dA_dxsi": [], "delta_F": [],
            }

        step_nums = [s.step for s in filtered]

        if self.has_blue_moon:
            # Blue Moon format: use cv_actual and mean_force
            cv_target = [s.cv_target for s in filtered]
            cv_actual = [s.cv_actual for s in filtered]
            cv_diff = [s.cv_diff for s in filtered]
            lambda_vals = [s.lambda_val for s in filtered]
            z_inv_sqrt = [s.z_inv_sqrt for s in filtered]
            GkT_vals = [s.GkT for s in filtered]
            mean_forces = [s.mean_force for s in filtered]

            # Trapezoidal integration: ΔF = ∫ mean_force dCV
            delta_F = [0.0]
            for i in range(1, len(filtered)):
                dCV = cv_actual[i] - cv_actual[i - 1]
                trap = 0.5 * (mean_forces[i] + mean_forces[i - 1]) * dCV
                delta_F.append(delta_F[-1] + trap)

            return {
                "step": step_nums,
                "cv_target": cv_target,
                "cv_actual": cv_actual,
                "cv_diff": cv_diff,
                "lambda_val": lambda_vals,
                "z_inv_sqrt": z_inv_sqrt,
                "GkT": GkT_vals,
                "mean_force": mean_forces,
                # For backward compatibility
                "cv": cv_actual,
                "dcv": cv_diff,
                "dA_dxsi": mean_forces,  # mean_force is the integrand
                "delta_F": delta_F,
            }
        else:
            # Legacy dA/dxsi format
            cv_vals = [s.cv for s in filtered]
            dcv_vals = [s.dcv for s in filtered]
            dA_vals = [s.dA_dxsi for s in filtered]

            # Simple cumulative sum: ΔF = Σ dA/dxsi * dcv
            delta_F = []
            cumulative = 0.0
            for s in filtered:
                cumulative += s.dA_dxsi * s.dcv
                delta_F.append(cumulative)

            return {
                "step": step_nums,
                "cv_target": cv_vals,
                "cv_actual": cv_vals,
                "cv_diff": dcv_vals,
                "lambda_val": [0.0] * len(filtered),
                "z_inv_sqrt": [0.0] * len(filtered),
                "GkT": [0.0] * len(filtered),
                "mean_force": dA_vals,
                "cv": cv_vals,
                "dcv": dcv_vals,
                "dA_dxsi": dA_vals,
                "delta_F": delta_F,
            }

    def get_all_constraints(self) -> list[int]:
        """Return sorted list of unique constraint indices."""
        return sorted(set(s.b_cnt for s in self.steps))

    def get_barrier_analysis(self, b_cnt: int = 1) -> BarrierAnalysis:
        """Analyze free energy barrier for a specific constraint."""
        cd = self.get_constraint_data(b_cnt)
        cv_vals = cd["cv_actual"] if self.has_blue_moon else cd["cv"]
        delta_F = cd["delta_F"]

        if not delta_F:
            return BarrierAnalysis()

        # Find max and min
        max_idx = 0
        min_idx = 0
        for i in range(len(delta_F)):
            if delta_F[i] > delta_F[max_idx]:
                max_idx = i
            if delta_F[i] < delta_F[min_idx]:
                min_idx = i

        total = delta_F[-1]
        barrier_fwd = delta_F[max_idx] - delta_F[0]
        barrier_rev = delta_F[max_idx] - delta_F[-1]

        return BarrierAnalysis(
            total_delta_F=total,
            total_delta_F_kcal=total * EV_TO_KCAL_MOL,
            max_F=delta_F[max_idx],
            max_F_cv=cv_vals[max_idx],
            min_F=delta_F[min_idx],
            min_F_cv=cv_vals[min_idx],
            barrier_forward=barrier_fwd,
            barrier_forward_kcal=barrier_fwd * EV_TO_KCAL_MOL,
            barrier_reverse=barrier_rev,
            barrier_reverse_kcal=barrier_rev * EV_TO_KCAL_MOL,
            cv_start=cv_vals[0],
            cv_end=cv_vals[-1],
            num_steps=len(delta_F),
        )


# --- Regex patterns ---

# Blue Moon format: cc> R  target  actual  diff
_CC_BM_PATTERN = re.compile(
    r"cc>\s+R\s+([\d.Ee+-]+)\s+([\d.Ee+-]+)\s+([\d.Ee+-]+)"
)

# Blue Moon b_m> line: lambda  |z|^(-1/2)  GkT  |z|^(-1/2)*(lambda+GkT)
_BM_PATTERN = re.compile(
    r"b_m>\s+([\d.Ee+-]+)\s+([\d.Ee+-]+)\s+([\d.Ee+-]+)\s+([\d.Ee+-]+)"
)

# Legacy format: cc> Step N b_cnt=N cv=X dcv=X dA/dxsi=X
_CC_LEGACY_PATTERN = re.compile(
    r"cc>\s+Step\s+(\d+)\s+"
    r"b_cnt=\s*(\d+)\s+"
    r"cv=\s*([-\d.Ee+]+)\s+"
    r"dcv=\s*([-\d.Ee+]+)\s+"
    r"dA/dxsi=\s*([-\d.Ee+]+)"
)

# MD step number
_STEP_PATTERN = re.compile(r"MD step No\.\s+(\d+)")


def parse_report(content: str) -> SlowGrowthData:
    """Parse VASP REPORT file content.

    Supports two formats:
    1. Blue Moon sampling format (cc> R + b_m> lines, split by MD step blocks)
    2. Legacy slow-growth format (cc> Step N b_cnt=N cv=X dcv=X dA/dxsi=X)

    Auto-detects format based on content.
    """
    data = SlowGrowthData()

    # Try Blue Moon format first (check for b_m> lines)
    if "b_m>" in content:
        data = _parse_blue_moon_format(content)
        if data.steps:
            return data

    # Fall back to legacy format
    data = _parse_legacy_format(content)
    return data


def _parse_blue_moon_format(content: str) -> SlowGrowthData:
    """Parse Blue Moon sampling format (cc> R + b_m> blocks)."""
    data = SlowGrowthData()
    data.has_blue_moon = True
    seen_b_cnts = set()

    # Split by MD step blocks (separated by === lines)
    step_blocks = re.split(r"={40,}\s+MD step No\.", content)

    for block in step_blocks[1:]:  # skip first empty block
        step_match = re.match(r"\s*(\d+)", block)
        if not step_match:
            continue
        step_num = int(step_match.group(1))

        # Extract cc> R values
        cc_match = _CC_BM_PATTERN.search(block)
        if not cc_match:
            continue
        cv_target = float(cc_match.group(1))
        cv_actual = float(cc_match.group(2))
        cv_diff = float(cc_match.group(3))

        # Extract b_m> values
        bm_match = _BM_PATTERN.search(block)
        if not bm_match:
            continue
        lambda_val = float(bm_match.group(1))
        z_inv_sqrt = float(bm_match.group(2))
        GkT = float(bm_match.group(3))
        mean_force = float(bm_match.group(4))

        step = SlowGrowthStep(
            step=step_num,
            b_cnt=1,  # Blue Moon format typically has one constraint
            cv_target=cv_target,
            cv_actual=cv_actual,
            cv_diff=cv_diff,
            lambda_val=lambda_val,
            z_inv_sqrt=z_inv_sqrt,
            GkT=GkT,
            mean_force=mean_force,
            cv=cv_actual,
            dcv=cv_diff,
            dA_dxsi=mean_force,
            has_blue_moon=True,
        )
        data.steps.append(step)
        seen_b_cnts.add(1)

    data.num_constraints = len(seen_b_cnts)
    if data.steps:
        data.total_steps = max(s.step for s in data.steps)

    return data


def _parse_legacy_format(content: str) -> SlowGrowthData:
    """Parse legacy slow-growth format (cc> Step N b_cnt=N ...)."""
    data = SlowGrowthData()
    data.has_blue_moon = False
    seen_b_cnts = set()

    for line in content.splitlines():
        m = _CC_LEGACY_PATTERN.search(line)
        if m:
            step = SlowGrowthStep(
                step=int(m.group(1)),
                b_cnt=int(m.group(2)),
                cv=float(m.group(3)),
                dcv=float(m.group(4)),
                dA_dxsi=float(m.group(5)),
                cv_actual=float(m.group(3)),
                cv_target=float(m.group(3)),
            )
            data.steps.append(step)
            seen_b_cnts.add(step.b_cnt)

    data.num_constraints = len(seen_b_cnts)
    if data.steps:
        data.total_steps = max(s.step for s in data.steps)

    return data
