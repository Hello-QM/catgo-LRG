"""VASP + Quantum ESPRESSO + LAMMPS input generation tools."""

__all__ = ["TOOLS"]

TOOLS: list[dict] = [
    # ─── VASP Input Generation ───
    {
        "name": "catgo_vasp_generate",
        "description": "Generate VASP input files (INCAR, POSCAR, KPOINTS) for a structure. "
        "Supports calculation types: opt, scf, freq, bader, dos, ddec, elf. "
        "Returns file contents as text strings.",
        "endpoint": "/vasp/generate",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structure": {"type": "object", "description": "Pymatgen structure dict"},
                "calculation_type": {"type": "string", "default": "scf", "enum": ["opt", "scf", "freq", "bader", "dos", "ddec", "elf"]},
                "encut": {"type": "number", "default": 450.0, "description": "Plane wave cutoff (eV)"},
                "prec": {"type": "string", "default": "Accurate"},
                "gga": {"type": "string", "default": "PE", "description": "GGA functional (PE=PBE, PS=PBEsol)"},
                "ediff": {"type": "number", "default": 1e-5, "description": "Electronic convergence (eV)"},
                "ispin": {"type": "integer", "description": "Spin polarization (1=no, 2=yes)"},
                "isif": {"type": "integer", "description": "Ionic relaxation flag (2=ions, 3=ions+cell)"},
                "nsw": {"type": "integer", "description": "Number of ionic steps"},
                "ediffg": {"type": "number", "description": "Force convergence (eV/Å, negative)"},
                "ismear": {"type": "integer", "description": "Smearing method (-5=tetra, 0=Gauss, 1=MP)"},
                "sigma": {"type": "number", "description": "Smearing width (eV)"},
                "ivdw": {"type": "integer", "description": "vdW correction (11=D3, 12=D3-BJ)"},
                "lreal": {"type": "string", "description": "Real space projection (Auto, False)"},
                "kspacing": {"type": "number", "description": "K-point spacing (1/Å)"},
                "kpoints": {"type": "array", "description": "K-points mesh or path"},
                "fixed_indices": {"type": "array", "items": {"type": "integer"}, "description": "Atom indices to freeze"},
                "fixed_z_below": {"type": "number", "description": "Freeze atoms below this z (Å)"},
                "custom_incar": {"type": "object", "description": "Additional custom INCAR parameters"},
            },
            "required": ["structure"],
        },
    },
    {
        "name": "catgo_vasp_calc_types",
        "description": "List available VASP calculation types with descriptions.",
        "endpoint": "/vasp/calculation-types",
        "method": "GET",
        "inputSchema": {"type": "object", "properties": {}},
    },

    # ─── Quantum ESPRESSO Input Generation ───
    {
        "name": "catgo_qe_generate",
        "description": "Generate Quantum ESPRESSO (pw.x) input file for a structure. "
        "Supports calculation types: scf, relax, vc-relax, nscf, bands.",
        "endpoint": "/qe/input",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structure": {"type": "object", "description": "Pymatgen structure dict"},
                "calculation": {"type": "string", "default": "scf", "description": "Calculation type"},
                "prefix": {"type": "string", "default": "pwscf"},
                "ecutwfc": {"type": "number", "default": 60.0, "description": "Wavefunction cutoff (Ry)"},
                "ecutrho": {"type": "number", "default": 480.0, "description": "Charge density cutoff (Ry)"},
                "kpoints": {"type": "array", "items": {"type": "integer"}, "description": "K-point grid [kx, ky, kz]"},
                "kspacing": {"type": "number", "default": 0.04, "description": "K-point spacing (1/Å)"},
                "occupations": {"type": "string", "default": "smearing"},
                "smearing": {"type": "string", "default": "mv"},
                "degauss": {"type": "number", "default": 0.01, "description": "Smearing width (Ry)"},
                "conv_thr": {"type": "number", "default": 1e-8},
                "nspin": {"type": "integer", "default": 1, "description": "Spin (1=unpolarized, 2=collinear)"},
                "fixed_indices": {"type": "array", "items": {"type": "integer"}, "description": "Atom indices to fix"},
                "fixed_z_below": {"type": "number", "description": "Fix atoms below this z (Å)"},
            },
            "required": ["structure"],
        },
    },
    {
        "name": "catgo_qe_templates",
        "description": "List available QE calculation templates with recommended settings.",
        "endpoint": "/qe/templates",
        "method": "GET",
        "inputSchema": {"type": "object", "properties": {}},
    },

    # ─── LAMMPS Input Generation ───
    {
        "name": "catgo_lammps_generate",
        "description": "Generate LAMMPS input script and data file for a structure. "
        "Supports simulation types: minimize, nve, nvt, npt.",
        "endpoint": "/lammps/input",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structure": {"type": "object", "description": "Pymatgen structure dict"},
                "prefix": {"type": "string", "default": "system"},
                "units": {"type": "string", "default": "metal", "description": "LAMMPS units system"},
                "atom_style": {"type": "string", "default": "atomic"},
                "boundary": {"type": "string", "default": "p p p"},
                "simulation_type": {"type": "string", "default": "minimize", "enum": ["minimize", "nve", "nvt", "npt"]},
                "pair_style": {"type": "string", "default": "eam/alloy", "description": "Pair style"},
                "pair_coeff": {"type": "string", "description": "Pair coefficients string"},
                "potential_file": {"type": "string", "description": "Path to potential file"},
                "timestep": {"type": "number", "default": 0.001},
                "temperature": {"type": "number", "default": 300.0},
                "pressure": {"type": "number", "default": 0.0},
                "run_steps": {"type": "integer", "default": 10000},
                "thermo_freq": {"type": "integer", "default": 100},
                "dump_freq": {"type": "integer", "default": 1000},
                "fixed_indices": {"type": "array", "items": {"type": "integer"}},
                "fixed_z_below": {"type": "number"},
            },
            "required": ["structure"],
        },
    },
    {
        "name": "catgo_lammps_pair_styles",
        "description": "List available LAMMPS pair styles with descriptions and required parameters.",
        "endpoint": "/lammps/pair_styles",
        "method": "GET",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "catgo_lammps_validate",
        "description": "Validate a LAMMPS input configuration before generating files.",
        "endpoint": "/lammps/validate",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structure": {"type": "object"},
                "pair_style": {"type": "string"},
                "simulation_type": {"type": "string"},
                "units": {"type": "string"},
            },
            "required": ["structure"],
        },
    },
    {
        "name": "catgo_lammps_sequential",
        "description": "Generate a multi-stage sequential LAMMPS simulation "
        "(e.g. minimize → NVT heat → NPT equilibrate → NVT production).",
        "endpoint": "/lammps/sequential",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structure": {"type": "object"},
                "stages": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "simulation_type": {"type": "string"},
                            "run_steps": {"type": "integer"},
                            "temperature": {"type": "number"},
                            "pressure": {"type": "number"},
                        },
                    },
                },
                "pair_style": {"type": "string"},
                "pair_coeff": {"type": "string"},
                "units": {"type": "string", "default": "metal"},
            },
            "required": ["structure", "stages"],
        },
    },
]
