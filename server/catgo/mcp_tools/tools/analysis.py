"""DOS + Band Structure + COHP + all MD Analysis tools."""

__all__ = ["TOOLS"]

TOOLS: list[dict] = [
    # ─── DOS Analysis ───
    {
        "name": "catgo_dos_compute",
        "description": "Compute projected density of states (PDOS) for atom groups. "
        "Requires a session_id from a prior file upload. "
        "Each group specifies atom indices, orbital channels, and a label.",
        "endpoint": "/dos/compute",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string", "description": "Session ID from file upload"},
                "groups": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "atoms": {"type": "array", "items": {"type": "integer"}, "description": "0-based atom indices"},
                            "channels": {"type": "string", "default": "d", "description": "Orbital spec: 'd', 's,p', 'dxy,dz2'"},
                            "label": {"type": "string"},
                            "normalize": {"type": "boolean", "default": False},
                        },
                        "required": ["atoms"],
                    },
                },
                "sigma": {"type": "number", "default": 0.05},
                "emin": {"type": "number", "default": -8.0},
                "emax": {"type": "number", "default": 6.0},
                "ngrid": {"type": "integer", "default": 2000},
            },
            "required": ["session_id", "groups"],
        },
    },
    {
        "name": "catgo_dos_total",
        "description": "Compute total density of states. Requires session_id from upload.",
        "endpoint": "/dos/total",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "sigma": {"type": "number", "default": 0.05},
                "emin": {"type": "number", "default": -8.0},
                "emax": {"type": "number", "default": 6.0},
                "ngrid": {"type": "integer", "default": 2000},
            },
            "required": ["session_id"],
        },
    },
    {
        "name": "catgo_dos_dband",
        "description": "Compute d-band center, width, filling, and upper/lower edges for selected atoms. "
        "Useful for catalysis studies (d-band theory).",
        "endpoint": "/dos/dband",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "atoms": {"type": "array", "items": {"type": "integer"}, "description": "0-based atom indices"},
                "sigma": {"type": "number", "default": 0.05},
                "occupied_only_center": {"type": "boolean", "default": True},
                "emin": {"type": "number", "default": -8.0},
                "emax": {"type": "number", "default": 6.0},
            },
            "required": ["session_id", "atoms"],
        },
    },
    {
        "name": "catgo_dos_from_dir",
        "description": "Load DOS data from a remote directory (HPC via SSH). "
        "Looks for vaspout.h5 or vasprun.xml in the specified path.",
        "endpoint": "/dos/from-directory",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string", "description": "Existing session ID (or empty for new)"},
                "remote_path": {"type": "string", "description": "Remote directory path on HPC"},
            },
            "required": ["remote_path"],
        },
    },

    # ─── Band Structure Analysis ───
    {
        "name": "catgo_bands_data",
        "description": "Get band structure data for plotting. Returns band energies, k-path, "
        "high-symmetry labels, and band gap info. Requires session_id from upload.",
        "endpoint": "/bands/data",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "emin": {"type": "number", "default": -8.0},
                "emax": {"type": "number", "default": 6.0},
            },
            "required": ["session_id"],
        },
    },
    {
        "name": "catgo_bands_projections",
        "description": "Get projected (fat) band structure with orbital weights for atom groups. "
        "Requires session_id from upload.",
        "endpoint": "/bands/projections",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "groups": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "atoms": {"type": "array", "items": {"type": "integer"}},
                            "channels": {"type": "string", "default": "d"},
                            "label": {"type": "string"},
                        },
                        "required": ["atoms"],
                    },
                },
                "emin": {"type": "number", "default": -8.0},
                "emax": {"type": "number", "default": 6.0},
            },
            "required": ["session_id", "groups"],
        },
    },
    {
        "name": "catgo_bands_from_dir",
        "description": "Load band structure data from a remote directory (HPC via SSH). "
        "Looks for vasprun.xml in the specified path.",
        "endpoint": "/bands/from-directory",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "remote_path": {"type": "string", "description": "Remote directory path on HPC"},
            },
            "required": ["remote_path"],
        },
    },

    # ─── COHP Analysis ───
    {
        "name": "catgo_cohp_data",
        "description": "Get COHP (Crystal Orbital Hamilton Population) data for specific bonds. "
        "Requires session_id from COHPCAR upload. Useful for bonding analysis.",
        "endpoint": "/cohp/data",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "bond_indices": {"type": "array", "items": {"type": "integer"}, "description": "1-based bond numbers"},
                "include_orbitals": {"type": "boolean", "default": False},
                "orbital_filter": {"type": "array", "items": {"type": "string"}, "description": "e.g. ['p-d', 's-d']"},
                "aggregate_orbitals": {"type": "boolean", "default": False},
            },
            "required": ["session_id", "bond_indices"],
        },
    },

    # ─── MD Analysis: Distances & RDF ───
    {
        "name": "catgo_md_rdf",
        "description": "Compute radial distribution function g(r) from an MD trajectory. "
        "Accepts base64-encoded trajectory file.",
        "endpoint": "/md/distances/rdf",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "trajectory_b64": {"type": "string", "description": "Base64-encoded trajectory file"},
                "format": {"type": "string", "description": "File format (pdb, xyz, extxyz, lammpstrj)"},
                "pairs": {
                    "type": "array",
                    "items": {"type": "array", "items": {"type": "string"}},
                    "description": "Element pairs for RDF, e.g. [['O','H'], ['Fe','O']]",
                },
                "r_range": {"type": "array", "items": {"type": "number"}, "description": "[r_min, r_max] in Å"},
                "n_bins": {"type": "integer", "default": 200},
                "periodic": {"type": "boolean", "default": True},
            },
            "required": ["trajectory_b64", "format"],
        },
    },

    # ─── MD Analysis: RMSD ───
    {
        "name": "catgo_md_rmsd",
        "description": "Compute RMSD (root-mean-square deviation) over an MD trajectory "
        "relative to a reference frame.",
        "endpoint": "/md/rmsd/rmsd",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "trajectory_b64": {"type": "string"},
                "format": {"type": "string"},
                "ref_frame": {"type": "integer", "default": 0, "description": "Reference frame index"},
                "atom_indices": {"type": "array", "items": {"type": "integer"}, "description": "Atom subset (all if omitted)"},
            },
            "required": ["trajectory_b64", "format"],
        },
    },

    # ─── MD Analysis: Hydrogen Bonds ───
    {
        "name": "catgo_md_hbonds",
        "description": "Detect hydrogen bonds across an MD trajectory. "
        "Methods: 'baker_hubbard' or 'wernet_nilsson'.",
        "endpoint": "/md/hbonds/detect",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "trajectory_b64": {"type": "string"},
                "format": {"type": "string"},
                "method": {"type": "string", "default": "baker_hubbard"},
                "distance_cutoff": {"type": "number", "default": 3.5, "description": "D-A distance cutoff (Å)"},
                "angle_cutoff": {"type": "number", "default": 150.0, "description": "D-H-A angle cutoff (degrees)"},
            },
            "required": ["trajectory_b64", "format"],
        },
    },

    # ─── MD Analysis: Clustering ───
    {
        "name": "catgo_md_clustering",
        "description": "Cluster MD trajectory frames by structural similarity (RMSD-based). "
        "Methods: 'kmeans', 'dbscan', 'agglomerative'. "
        "Returns cluster labels, representative frames, and optional 2D embedding.",
        "endpoint": "/md/clustering/rmsd-cluster",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "trajectory_b64": {"type": "string"},
                "format": {"type": "string"},
                "method": {"type": "string", "default": "kmeans", "enum": ["kmeans", "dbscan", "agglomerative"]},
                "n_clusters": {"type": "integer", "default": 5, "description": "Number of clusters (kmeans/agglomerative)"},
                "atom_indices": {"type": "array", "items": {"type": "integer"}},
                "stride": {"type": "integer", "default": 1},
                "embed": {"type": "boolean", "default": True, "description": "Compute 2D embedding for visualization"},
            },
            "required": ["trajectory_b64", "format"],
        },
    },

    # ─── MD Analysis: Dimensionality Reduction ───
    {
        "name": "catgo_md_dimreduce",
        "description": "Dimensionality reduction (PCA, t-SNE, UMAP) on MD trajectory frames. "
        "Useful for visualizing structural transitions and conformational basins.",
        "endpoint": "/md/clustering/dimreduce",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "trajectory_b64": {"type": "string"},
                "format": {"type": "string"},
                "method": {"type": "string", "default": "pca", "enum": ["pca", "tsne", "umap"]},
                "n_components": {"type": "integer", "default": 2},
                "atom_indices": {"type": "array", "items": {"type": "integer"}},
                "stride": {"type": "integer", "default": 1},
            },
            "required": ["trajectory_b64", "format"],
        },
    },

    # ─── MD Analysis: RMSF ───
    {
        "name": "catgo_md_rmsf",
        "description": "Compute per-atom RMSF (Root Mean Square Fluctuation) over an MD trajectory. "
        "Shows which atoms fluctuate most relative to a reference (average or specific frame).",
        "endpoint": "/md/rmsd/rmsf",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "trajectory_b64": {"type": "string"},
                "format": {"type": "string"},
                "atom_indices": {"type": "array", "items": {"type": "integer"}, "description": "Atom indices (0-based). Omit for all atoms."},
                "ref_frame": {"type": "integer", "description": "Reference frame index. Omit to use average structure."},
            },
            "required": ["trajectory_b64", "format"],
        },
    },

    # ─── MD Analysis: Dihedrals ───
    {
        "name": "catgo_md_dihedrals",
        "description": "Compute dihedral (torsion) angles over an MD trajectory for specified atom quartets.",
        "endpoint": "/md/angles/dihedrals",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "trajectory_b64": {"type": "string"},
                "format": {"type": "string"},
                "atom_quartets": {"type": "array", "items": {"type": "array", "items": {"type": "integer"}}, "description": "[[i,j,k,l],...] where dihedral is angle between planes (i,j,k) and (j,k,l)"},
            },
            "required": ["trajectory_b64", "format", "atom_quartets"],
        },
    },

    # ─── MD Analysis: H-bond Lifetime ───
    {
        "name": "catgo_md_hbond_lifetime",
        "description": "Compute hydrogen bond lifetime autocorrelation from an MD trajectory. "
        "Returns average H-bond lifetime in picoseconds.",
        "endpoint": "/md/hbonds/lifetime",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "trajectory_b64": {"type": "string"},
                "format": {"type": "string"},
                "distance_cutoff": {"type": "number", "default": 3.5, "description": "D-A distance cutoff (Å)"},
                "angle_cutoff": {"type": "number", "default": 150.0, "description": "D-H-A angle cutoff (degrees)"},
                "time_step": {"type": "number", "default": 1.0, "description": "Time between frames in ps"},
            },
            "required": ["trajectory_b64", "format"],
        },
    },

    # ─── MD Analysis: MSD / Diffusion ───
    {
        "name": "catgo_md_msd",
        "description": "Compute mean squared displacement MSD(tau) and self-diffusion "
        "coefficient D via the Einstein relation (MSD = 2dDtau). Supports element "
        "selection (e.g., 'O' for water oxygens), PBC unwrapping, and custom fit window.",
        "endpoint": "/md/dynamics/msd",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "trajectory_b64": {"type": "string"},
                "format": {"type": "string"},
                "element": {"type": "string", "description": "Element symbol (e.g., 'O'). Overrides atom_indices."},
                "atom_indices": {"type": "array", "items": {"type": "integer"}},
                "timestep_ps": {"type": "number", "default": 1.0},
                "max_tau_frames": {"type": "integer", "description": "Max lag (frames). Default n_frames/2."},
                "directions": {"type": "string", "enum": ["xyz", "xy", "z", "x", "y"], "default": "xyz"},
                "unwrap_pbc": {"type": "boolean", "default": True},
                "fit_range_ps": {"type": "array", "items": {"type": "number"}, "description": "[tau_min, tau_max] in ps for D fit."},
            },
            "required": ["trajectory_b64", "format"],
        },
    },

    # ─── MD Analysis: Water Orientation Order Parameter ───
    {
        "name": "catgo_md_water_orientation",
        "description": "Compute the water dipole orientation order parameter "
        "<cos phi>(z) (and optionally <P2>) as a function of distance along the "
        "surface normal. Identifies water molecules automatically from O-H bonds.",
        "endpoint": "/md/orientation/water",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "trajectory_b64": {"type": "string"},
                "format": {"type": "string"},
                "axis": {"type": "string", "enum": ["x", "y", "z"], "default": "z"},
                "n_bins": {"type": "integer", "default": 100},
                "z_range": {"type": "array", "items": {"type": "number"}, "description": "[z_min, z_max] in Angstroms"},
                "oh_cutoff_angstrom": {"type": "number", "default": 1.25},
                "compute_p2": {"type": "boolean", "default": True},
                "periodic": {"type": "boolean", "default": True},
            },
            "required": ["trajectory_b64", "format"],
        },
    },

    # ─── MD Analysis: LCW Cavitation Free Energy ───
    {
        "name": "catgo_md_cavitation",
        "description": "Compute the cavitation free energy profile "
        "ΔG_cav(R, z) = -k_B T ln P0(R, z) via Lum-Chandler-Weeks theory. "
        "Returns P0, ΔG_cav for every (radius, z) bin, optional LCW V-linear "
        "fit in IHP / Stern windows, and the migration descriptor ΔG_cav(R) = "
        "ΔG_IHP - ΔG_Stern. Requires a periodic cell.",
        "endpoint": "/md/cavitation/profile",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "trajectory_b64": {"type": "string"},
                "format": {"type": "string"},
                "solvent_element": {"type": "string", "default": "O"},
                "probe_radii_angstrom": {
                    "type": "array",
                    "items": {"type": "number"},
                    "default": [1.25, 1.5, 1.75, 2.0, 2.25, 2.5],
                },
                "axis": {"type": "string", "enum": ["x", "y", "z"], "default": "z"},
                "n_z_bins": {"type": "integer", "default": 60},
                "z_range": {"type": "array", "items": {"type": "number"}},
                "grid_spacing_angstrom": {"type": "number", "default": 0.8},
                "frame_stride": {"type": "integer", "default": 1},
                "temperature_K": {"type": "number", "default": 300.0},
                "ihp_z_range": {"type": "array", "items": {"type": "number"}, "description": "Optional [z_min, z_max] for LCW fit / migration"},
                "stern_z_range": {"type": "array", "items": {"type": "number"}},
                "periodic": {"type": "boolean", "default": True},
            },
            "required": ["trajectory_b64", "format"],
        },
    },

    # ─── MD Analysis: 2D Planar Density ───
    {
        "name": "catgo_md_planar_density",
        "description": "Compute a 2D planar density map from an MD trajectory. "
        "Projects atom positions onto a plane (xy, xz, or yz) for diffusion analysis.",
        "endpoint": "/md/density/planar",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "trajectory_b64": {"type": "string"},
                "format": {"type": "string"},
                "plane": {"type": "string", "enum": ["xy", "xz", "yz"], "description": "Projection plane"},
                "n_bins": {"type": "array", "items": {"type": "integer"}, "default": [50, 50]},
                "z_range": {"type": "array", "items": {"type": "number"}, "description": "[min, max] along perpendicular axis (Å)"},
            },
            "required": ["trajectory_b64", "format", "plane"],
        },
    },
]
