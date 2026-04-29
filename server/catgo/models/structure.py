"""Pydantic models for structure data - compatible with CatGo frontend."""

import math
from enum import Enum
from typing import Literal, Optional

import numpy as np
from pydantic import BaseModel, Field, model_validator


class CalculatorType(str, Enum):
    """Available calculators for structure optimization."""

    EMT = "emt"  # Effective Medium Theory - fast, for metals only
    XTB = "xtb"  # xTB semi-empirical tight-binding - fast, accurate for organics
    MACE = "mace"  # MACE universal potential
    CHGNET = "chgnet"  # CHGNet universal potential
    M3GNET = "m3gnet"  # M3GNet universal potential


class OptimizerType(str, Enum):
    """Available optimizer algorithms."""

    BFGS = "bfgs"  # ASE BFGS - standard local minimizer (default)
    SELLA_MIN = "sella_min"  # Sella order=0 - alternative minimizer
    SELLA_TS = "sella_ts"  # Sella order=1 - transition state (saddle point) search
    IRC = "irc"  # Sella IRC - intrinsic reaction coordinate from a TS


class SellaParams(BaseModel):
    """Sella optimizer parameters."""

    delta0: Optional[float] = Field(default=None, description="Initial trust radius")
    sigma_inc: Optional[float] = Field(default=None, description="Trust radius increase factor")
    sigma_dec: Optional[float] = Field(default=None, description="Trust radius decrease factor")
    rho_inc: Optional[float] = Field(default=None, description="Step quality threshold for increase")
    rho_dec: Optional[float] = Field(default=None, description="Step quality threshold for decrease")


class IRCParams(BaseModel):
    """Sella IRC (Intrinsic Reaction Coordinate) parameters."""

    dx: Optional[float] = Field(default=None, description="IRC step size (Angstrom)")
    eta: Optional[float] = Field(default=None, description="Finite difference step for Hessian")
    gamma: Optional[float] = Field(default=None, description="Damping parameter")


class Species(BaseModel):
    """Atomic species with occupancy."""

    element: str
    occu: float = 1.0
    oxidation_state: Optional[float] = None


class Site(BaseModel):
    """Atomic site in a structure."""

    species: list[Species]
    abc: Optional[list[float]] = Field(default=None, min_length=3, max_length=3)
    xyz: list[float] = Field(..., min_length=3, max_length=3)
    label: Optional[str] = None
    properties: Optional[dict] = None


class Lattice(BaseModel):
    """Lattice parameters and matrix.

    If only matrix is provided, lattice parameters (a, b, c, alpha, beta, gamma, volume)
    will be computed automatically.
    """

    matrix: list[list[float]] = Field(..., min_length=3, max_length=3)
    a: Optional[float] = None
    b: Optional[float] = None
    c: Optional[float] = None
    alpha: Optional[float] = None
    beta: Optional[float] = None
    gamma: Optional[float] = None
    volume: Optional[float] = None
    pbc: Optional[list[bool]] = [True, True, True]

    @model_validator(mode="after")
    def compute_lattice_params_from_matrix(self):
        """Compute lattice parameters from matrix if not provided."""
        matrix = np.array(self.matrix)

        # Compute lattice vector lengths
        if self.a is None:
            self.a = float(np.linalg.norm(matrix[0]))
        if self.b is None:
            self.b = float(np.linalg.norm(matrix[1]))
        if self.c is None:
            self.c = float(np.linalg.norm(matrix[2]))

        # Compute angles (in degrees)
        if self.alpha is None:
            # Angle between b and c vectors
            cos_alpha = np.dot(matrix[1], matrix[2]) / (self.b * self.c)
            self.alpha = float(math.degrees(math.acos(np.clip(cos_alpha, -1.0, 1.0))))
        if self.beta is None:
            # Angle between a and c vectors
            cos_beta = np.dot(matrix[0], matrix[2]) / (self.a * self.c)
            self.beta = float(math.degrees(math.acos(np.clip(cos_beta, -1.0, 1.0))))
        if self.gamma is None:
            # Angle between a and b vectors
            cos_gamma = np.dot(matrix[0], matrix[1]) / (self.a * self.b)
            self.gamma = float(math.degrees(math.acos(np.clip(cos_gamma, -1.0, 1.0))))

        # Compute volume
        if self.volume is None:
            self.volume = float(abs(np.linalg.det(matrix)))

        return self


class PymatgenStructure(BaseModel):
    """Pymatgen-compatible structure format used by CatGo frontend.

    For molecules (XYZ files without PBC), lattice may be None.
    """

    lattice: Optional[Lattice] = None  # None for isolated molecules without PBC
    sites: list[Site]
    charge: Optional[float] = None

    class Config:
        extra = "allow"  # Allow additional fields from frontend


class OptimizationStep(BaseModel):
    """Single step in optimization trajectory."""

    step: int
    energy: float  # eV
    fmax: float  # eV/Angstrom
    structure: PymatgenStructure


class XTBMethod(str, Enum):
    """Available xTB methods."""

    GFN2 = "GFN2-xTB"  # Most accurate, default
    GFN1 = "GFN1-xTB"  # Faster, slightly less accurate
    GFN0 = "GFN0-xTB"  # Fastest TB method
    GFNFF = "GFN-FF"  # Force field, very fast
    IPEA1 = "IPEA1-xTB"  # For ionization potentials/electron affinities


class XTBParams(BaseModel):
    """xTB calculator parameters."""

    method: XTBMethod = Field(default=XTBMethod.GFN2, description="xTB method")
    accuracy: float = Field(default=1.0, ge=0.1, le=10.0, description="Numerical accuracy")
    electronic_temperature: float = Field(
        default=300.0, ge=0, le=10000, description="Electronic temperature (K)"
    )
    max_iterations: int = Field(default=250, ge=1, le=1000, description="Max SCF iterations")


class MACEParams(BaseModel):
    """MACE calculator parameters."""

    model: str = Field(default="medium", description="Model size: small, medium, large (or 'custom' to use model_path)")
    model_path: Optional[str] = Field(default=None, description="Path to custom MACE model file (.model)")
    device: str = Field(default="cpu", description="Compute device: cpu or cuda")


class CalculatorParams(BaseModel):
    """Calculator-specific parameters."""

    xtb: Optional[XTBParams] = None
    mace: Optional[MACEParams] = None


class OptimizationRequest(BaseModel):
    """Request for structure optimization."""

    structure: PymatgenStructure
    calculator: str = Field(
        default="emt",
        description="Calculator ID: built-in (emt, xtb, mace, chgnet, m3gnet) or plugin calculator_id",
    )
    calculator_params: Optional[CalculatorParams] = Field(
        default=None, description="Calculator-specific parameters"
    )
    optimizer: OptimizerType = Field(
        default=OptimizerType.BFGS, description="Optimizer algorithm"
    )
    sella_params: Optional[SellaParams] = Field(
        default=None, description="Sella optimizer parameters (for sella_min/sella_ts)"
    )
    irc_params: Optional[IRCParams] = Field(
        default=None, description="IRC parameters (for irc optimizer)"
    )
    fmax: float = Field(default=0.05, gt=0, description="Force convergence criterion (eV/A)")
    steps: int = Field(default=100, gt=0, le=1000, description="Maximum optimization steps")
    optimize_cell: bool = Field(default=False, description="Also optimize lattice parameters")
    return_trajectory: bool = Field(default=False, description="Return full trajectory")
    mobile_indices: Optional[list[int]] = Field(
        default=None,
        description="Indices of atoms allowed to move. If None, all atoms move.",
    )
    extract_fragment: bool = Field(
        default=False,
        description="If True with mobile_indices, extract selected atoms as fragment and optimize separately.",
    )


class OptimizationResult(BaseModel):
    """Result of structure optimization."""

    success: bool
    message: str
    initial_energy: Optional[float] = None  # eV
    final_energy: Optional[float] = None  # eV
    energy_change: Optional[float] = None  # eV
    initial_fmax: Optional[float] = None  # eV/A
    final_fmax: Optional[float] = None  # eV/A
    steps_taken: int = 0
    structure: Optional[PymatgenStructure] = None
    trajectory: Optional[list[OptimizationStep]] = None


# WebSocket message types


class WSMessageType(str, Enum):
    """WebSocket message types."""

    PROGRESS = "progress"
    COMPLETE = "complete"
    ERROR = "error"
    CANCELLED = "cancelled"


class WSProgressMessage(BaseModel):
    """WebSocket progress update message."""

    type: WSMessageType
    step: int
    total_steps: int
    energy: float  # eV
    fmax: float  # eV/Angstrom
    converged: bool = False
    message: str = ""
    structure: Optional[PymatgenStructure] = None  # Only sent on complete


class WSOptimizationRequest(BaseModel):
    """WebSocket optimization request."""

    structure: PymatgenStructure
    calculator: str = "emt"
    calculator_params: Optional[CalculatorParams] = None
    optimizer: OptimizerType = OptimizerType.BFGS
    sella_params: Optional[SellaParams] = None
    irc_params: Optional[IRCParams] = None
    fmax: float = Field(default=0.05, gt=0)
    steps: int = Field(default=100, gt=0, le=1000)
    optimize_cell: bool = False
    mobile_indices: Optional[list[int]] = None  # Indices of atoms allowed to move
    extract_fragment: bool = False  # Extract selected atoms as fragment
    request_id: str  # Client-generated ID for tracking


# ===== LAMMPS Sequential Simulation Models =====


class SimulationStageType(str, Enum):
    """Types of simulation stages."""

    MINIMIZE = "minimize"  # Energy minimization
    NVE = "nve"  # Constant volume/energy dynamics
    NVT = "nvt"  # Constant temperature dynamics
    NPT = "npt"  # Constant temperature/pressure dynamics
    TEMP = "temp"  # Temperature ramp
    DEFORM = "deform"  # Box deformation
    PRESS = "press"  # Apply pressure
    VAC = "vac"  # Create vacancy


class SimulationStage(BaseModel):
    """Single stage of a sequential LAMMPS simulation."""

    stage_type: SimulationStageType = Field(
        ..., description="Type of simulation stage"
    )
    run_steps: int = Field(
        default=1000, gt=0, le=10000000, description="Number of timesteps to run"
    )

    # Common parameters
    temperature: Optional[float] = Field(
        default=None, description="Temperature in K"
    )
    pressure: Optional[float] = Field(
        default=None, description="Pressure in atm"
    )
    tdamp: Optional[float] = Field(
        default=100.0, description="Thermostat damping parameter (timesteps)"
    )
    pdamp: Optional[float] = Field(
        default=1000.0, description="Barostat damping parameter (timesteps)"
    )

    # Temperature ramp specific
    temp_start: Optional[float] = Field(
        default=None, description="Starting temperature for ramp (K)"
    )
    temp_end: Optional[float] = Field(
        default=None, description="Ending temperature for ramp (K)"
    )

    # Deformation specific
    deform_rate: Optional[list[float]] = Field(
        default=None, min_length=3, max_length=3,
        description="Deformation rate (dx, dy, dz)"
    )

    # Pressure specific
    target_pressure: Optional[float] = Field(
        default=None, description="Target pressure (atm)"
    )

    # Vacancy specific
    vacancy_index: Optional[int] = Field(
        default=None, ge=-1, description="Atom index to delete (-1 for random)"
    )


class SequentialLammpsRequest(BaseModel):
    """Request for sequential LAMMPS simulation with multiple stages."""

    structure: PymatgenStructure
    prefix: str = Field(default="system", description="Prefix for output files")
    stages: list[SimulationStage] = Field(
        ..., min_length=1, max_length=50,
        description="List of simulation stages to run sequentially"
    )

    # LAMMPS input parameters (same as single simulation)
    units: str = Field(default="metal", description="LAMMPS units style")
    atom_style: str = Field(default="atomic", description="LAMMPS atom style")
    pair_style: str = Field(default="lj/cut 2.5", description="Pair potential style")
    pair_coeff: str = Field(default="* * 1.0 1.0", description="Pair coefficients")
    boundary: str = Field(default="p p p", description="Boundary conditions")

    # Output options
    dump_interval: int = Field(default=100, gt=0, description="Dump output frequency")
    thermo_interval: int = Field(default=100, gt=0, description="Thermo output frequency")

    # Fixed atoms (optional)
    fixed_indices: Optional[list[int]] = Field(
        default=None, description="Indices of atoms to fix (1-indexed)"
    )


class SequentialLammpsResponse(BaseModel):
    """Response from sequential LAMMPS simulation generation."""

    success: bool
    message: str
    stages: list[dict] = Field(
        default_factory=list, description="Generated LAMMPS input for each stage"
    )
    combined_input: str = Field(
        default="", description="Combined LAMMPS input script for all stages"
    )
    data_file: str = Field(
        default="", description="LAMMPS data file (shared by all stages)"
    )
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
