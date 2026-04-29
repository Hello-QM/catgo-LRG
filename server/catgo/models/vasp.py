"""Pydantic models for VASP calculation requests."""

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field

from .structure import PymatgenStructure


class VASPCalculationType(str, Enum):
    """VASP calculation types."""

    OPT = "opt"  # Structure optimization
    SCF = "scf"  # Single-point energy calculation
    FREQ = "freq"  # Frequency/vibrational analysis
    BADER = "bader"  # Bader charge analysis
    DOS = "dos"  # Density of states
    DDEC = "ddec"  # DDEC charge analysis
    ELF = "elf"  # Electron localization function
    MD = "md"  # Molecular dynamics (NVT/NVE/NPT)
    SLOW_GROWTH = "slow_growth"  # Slow-growth MD (thermodynamic integration)


class ConstantPotentialMethod(str, Enum):
    """Constant-potential method overlay for any VASP calculation."""

    NONE = "none"
    TPOT = "tpot"  # TPOT patch (comet-group/tpot)
    CPVASP = "cpvasp"  # CP-VASP patch (yuanyue-liu-group/CP-VASP) + VASPsol++


class VASPOptimizerType(str, Enum):
    """VASP optimizer types/presets."""

    STANDARD = "standard"  # Standard VASP optimizer (IBRION=2)
    VTST_FIRE = "vtst_fire"  # VTST FIRE optimizer (IBRION=3, IOPT=7)
    QUASI_NEWTON = "quasi_newton"  # Quasi-Newton (IBRION=1)


class VASPInputRequest(BaseModel):
    """Request for VASP input file generation."""

    structure: PymatgenStructure
    calculation_type: VASPCalculationType = Field(
        default=VASPCalculationType.SCF,
        description="Type of VASP calculation",
    )

    # Constant-potential method (overlays on any calculation type)
    constant_potential: ConstantPotentialMethod = Field(
        default=ConstantPotentialMethod.NONE,
        description="Constant-potential method: none, tpot, or cpvasp",
    )

    # Optimizer preset
    optimizer: Optional[VASPOptimizerType] = Field(
        default=None,
        description="Optimizer preset (standard=IBRION=2 CG, vtst_fire=VTST FIRE requires VTST library, quasi_newton=IBRION=1). If None, defaults to standard (no VTST required)",
    )

    # Basic parameters
    encut: float = Field(default=450.0, description="Plane wave cutoff energy (eV)")
    prec: str = Field(default="Accurate", description="Precision (Normal, Accurate, Single)")
    gga: str = Field(default="PE", description="GGA functional (PE=PBE, PS=PBEsol, etc.)")

    # Electronic convergence
    ediff: float = Field(default=1e-5, description="Electronic convergence (eV)")
    nelm: Optional[int] = Field(default=None, description="Max electronic steps")
    nelmin: Optional[int] = Field(default=None, description="Min electronic steps")
    nelmdl: Optional[int] = Field(default=None, description="NELMDL parameter")
    algo: Optional[str] = Field(default=None, description="Electronic algorithm (F, VeryFast, etc.)")

    # Smearing
    ismear: Optional[int] = Field(
        default=None, description="Smearing method (-1=Fermi, 0=Gaussian, 1=MP, -5=Tetrahedron)"
    )
    sigma: Optional[float] = Field(
        default=None, description="Smearing width (eV)"
    )

    # Spin
    ispin: Optional[int] = Field(default=None, description="Spin polarization (1=no, 2=yes)")
    magmom: Optional[str] = Field(
        default=None,
        description="Initial magnetic moments (e.g., '2*0.2 58*0.2 1*1.811')"
    )

    # Ionic relaxation
    isif: Optional[int] = Field(
        default=None,
        description="Ionic relaxation flag (2=ions, 3=ions+cell, 4=ions+volume)",
    )
    ibrion: Optional[int] = Field(
        default=None,
        description="Ionic relaxation algorithm (2=CG, 3=MD, 5=quasi-Newton, -1=static)",
    )
    nsw: Optional[int] = Field(
        default=None, description="Number of ionic steps (0=static, >0=relaxation)"
    )
    ediffg: Optional[float] = Field(
        default=None, description="Ionic convergence (eV/Angstrom)"
    )
    potim: Optional[float] = Field(default=None, description="Ionic time step")

    # VTST-specific
    iopt: Optional[int] = Field(default=None, description="VTST optimizer type (7=FIRE)")
    lvtst: Optional[bool] = Field(default=None, description="Enable VTST optimizer")

    # Symmetry
    isym: Optional[int] = Field(default=None, description="Symmetry (-1=off, 0=off, 1-3=on)")

    # vdW correction
    ivdw: Optional[int] = Field(
        default=None,
        description="vdW correction (11=D3, 12=D3 with zero-damping, etc.)"
    )

    # Real space projection
    lreal: Optional[str] = Field(
        default=None, description="Real space projection (Auto, False, True)"
    )

    # Output control
    lwave: Optional[bool] = Field(default=None, description="Write WAVECAR")
    lcharg: Optional[bool] = Field(default=None, description="Write CHGCAR")
    lorbit: Optional[int] = Field(default=None, description="Write PROCAR (11=full)")
    lelf: Optional[bool] = Field(default=None, description="Calculate ELF")
    laechg: Optional[bool] = Field(default=None, description="Write AECCAR files")

    # Parallelization
    ncore: Optional[int] = Field(default=None, description="NCORE parameter")
    npar: Optional[int] = Field(default=None, description="NPAR parameter")

    # DOS-specific
    nedos: Optional[int] = Field(default=None, description="Number of DOS points")
    nbands: Optional[int] = Field(default=None, description="Number of bands")

    # Frequency-specific
    nfree: Optional[int] = Field(default=None, description="NFREE for frequency calculations")

    # Other common parameters
    icharg: Optional[int] = Field(default=None, description="ICHARG (1=read CHGCAR, 2=atomic)")
    idipol: Optional[int] = Field(default=None, description="IDIPOL for dipole corrections")
    lmaxmix: Optional[int] = Field(default=None, description="LMAXMIX for mixing")
    addgrid: Optional[bool] = Field(default=None, description="ADDGRID")
    amix: Optional[float] = Field(default=None, description="AMIX mixing parameter")
    bmix: Optional[float] = Field(default=None, description="BMIX mixing parameter")
    amix_mag: Optional[float] = Field(default=None, description="AMIX_MAG")
    bmix_mag: Optional[float] = Field(default=None, description="BMIX_MAG")

    # K-points
    kpoints: Optional[list[list[float]]] = Field(
        default=None,
        description="K-points mesh or path (e.g., [[3,3,3]] for mesh, or path for band structure)",
    )
    kspacing: Optional[float] = Field(
        default=None, description="K-point spacing (1/Angstrom)"
    )

    # Selective dynamics (frozen atoms)
    fixed_indices: Optional[list[int]] = Field(
        default=None,
        description="Indices of atoms to freeze (0-indexed). These atoms will have F F F in POSCAR.",
    )
    fixed_z_below: Optional[float] = Field(
        default=None,
        description="Freeze all atoms with z coordinate below this value (Angstrom).",
    )

    # Slow-growth MD parameters
    mdalgo: Optional[int] = Field(default=None, description="MD algorithm (2=Nose-Hoover, 3=Langevin)")
    smass: Optional[float] = Field(default=None, description="SMASS for Nose-Hoover thermostat")
    tebeg: Optional[float] = Field(default=None, description="Start temperature (K)")
    teend: Optional[float] = Field(default=None, description="End temperature (K)")
    nblock: Optional[int] = Field(default=None, description="NBLOCK parameter")
    lblueout: Optional[bool] = Field(default=None, description="Write free energy gradient to REPORT")
    increm: Optional[str] = Field(
        default=None,
        description="INCREM values: CV change rate per step for each constraint (space-separated)"
    )
    iconst_content: Optional[str] = Field(
        default=None,
        description="Content of the ICONST file defining geometric constraints"
    )

    # TPOT (constant potential MD) parameters
    tpot_vtarget: Optional[float] = Field(default=None, description="Target potential (V, vacuum scale)")
    tpot_vdiff: Optional[float] = Field(default=None, description="Potential convergence threshold (V)")
    tpot_vrate: Optional[float] = Field(default=None, description="Initial rate of NELECT change (V/electron)")
    tpot_vratelim: Optional[float] = Field(default=None, description="Lower limit for TPOTVRATE magnitude")
    tpot_vratedamp: Optional[float] = Field(default=None, description="Damping factor for TPOTVRATE updates")
    tpot_vediff: Optional[float] = Field(default=None, description="Energy convergence before NELECT update (eV)")
    tpot_electstep: Optional[float] = Field(default=None, description="Max electron change per step")
    tpot_dynvrate: Optional[bool] = Field(default=None, description="Dynamic TPOTVRATE adjustment")
    tpot_truevaclevel: Optional[bool] = Field(default=None, description="Use true vacuum level for potential")
    tpot_gcenergy: Optional[bool] = Field(default=None, description="Calculate grand canonical energy")
    tpot_gcionic: Optional[bool] = Field(default=None, description="GC energy only at end of ionic step")
    # TPOT VASPsol solvation
    tpot_eb_k: Optional[float] = Field(default=None, description="Bulk dielectric constant (78.4 for water)")
    tpot_lambda_d_k: Optional[float] = Field(default=None, description="Debye screening length (Angstrom)")
    tpot_core_c: Optional[float] = Field(default=None, description="Number of core electrons")
    tpot_tau: Optional[float] = Field(default=None, description="Cavity parameter (0 = default)")

    # CP-VASP (constant potential with VASPsol) parameters
    cpvasp_targetmu: Optional[float] = Field(default=None, description="Target chemical potential (eV, e.g. -4.57 for 0V vs SHE)")
    cpvasp_nescheme: Optional[int] = Field(default=None, description="Electron update scheme (2=exact, 5=exact+eta)")
    cpvasp_neadjust: Optional[int] = Field(default=None, description="Electron adjustment frequency (ionic steps)")
    cpvasp_fermiconverge: Optional[float] = Field(default=None, description="Fermi level convergence threshold (eV)")
    cpvasp_cap_max: Optional[float] = Field(default=None, description="Maximum capacitance for electron update")
    cpvasp_t_eta: Optional[float] = Field(default=None, description="Electronic temperature for grand canonical (K)")
    cpvasp_eta_length: Optional[int] = Field(default=None, description="Eta parameter length")
    # VASPsol++ solvation
    cpvasp_lsol: Optional[bool] = Field(default=None, description="Enable implicit solvation (VASPsol)")
    cpvasp_isol: Optional[int] = Field(default=None, description="Solvation model (2=VASPsol++)")
    cpvasp_c_molar: Optional[float] = Field(default=None, description="Molar concentration of electrolyte (mol/L)")
    cpvasp_r_ion: Optional[float] = Field(default=None, description="Ion radius for solvation (Angstrom)")

    # NELECT (number of electrons — needed for constant-potential step 2)
    nelect: Optional[float] = Field(default=None, description="Number of electrons (from constant-potential step 1)")

    # Custom INCAR parameters (for anything not covered above)
    custom_incar: Optional[dict[str, str | int | float | bool]] = Field(
        default=None,
        description="Additional custom INCAR parameters (will override defaults)"
    )

    # System title/comment
    system_title: Optional[str] = Field(
        default=None,
        description="SYSTEM title for INCAR (comment line)"
    )


class VASPInputFiles(BaseModel):
    """Generated VASP input files."""

    incar: str
    poscar: str
    kpoints: str
    iconst: Optional[str] = None  # ICONST file for slow-growth / constrained MD
    incar_nelect: Optional[str] = None  # INCAR for NELECT determination (TPOT step 1)
    potcar_info: dict  # Information about POTCAR (not generated, user must provide)
    calculation_type: VASPCalculationType
    notes: Optional[str] = None


# --- Slow-growth REPORT post-processing models ---


class SlowGrowthUploadResponse(BaseModel):
    """Response after uploading a REPORT file."""
    session_id: str
    total_steps: int
    num_constraints: int
    constraints: list[int]  # list of b_cnt values
    has_blue_moon: bool = False  # True if Blue Moon b_m> data found


class SlowGrowthConstraintData(BaseModel):
    """Time-series data for one constraint."""
    b_cnt: int
    step: list[int]
    cv: list[float]
    dcv: list[float]
    dA_dxsi: list[float]
    delta_F: list[float]
    # Blue Moon specific fields
    cv_target: list[float] = []
    cv_actual: list[float] = []
    cv_diff: list[float] = []
    lambda_val: list[float] = []
    z_inv_sqrt: list[float] = []
    GkT: list[float] = []
    mean_force: list[float] = []


class SlowGrowthBarrierAnalysis(BaseModel):
    """Free energy barrier analysis results."""
    total_delta_F: float = 0.0
    total_delta_F_kcal: float = 0.0
    max_F: float = 0.0
    max_F_cv: float = 0.0
    min_F: float = 0.0
    min_F_cv: float = 0.0
    barrier_forward: float = 0.0
    barrier_forward_kcal: float = 0.0
    barrier_reverse: float = 0.0
    barrier_reverse_kcal: float = 0.0
    cv_start: float = 0.0
    cv_end: float = 0.0
    num_steps: int = 0


class SlowGrowthAnalysisResponse(BaseModel):
    """Full analysis response for slow-growth post-processing."""
    session_id: str
    total_steps: int
    num_constraints: int
    has_blue_moon: bool = False
    constraints: list[SlowGrowthConstraintData]
    barriers: list[SlowGrowthBarrierAnalysis] = []
