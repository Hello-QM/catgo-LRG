"""Catalysis analysis + VASP preset tools."""

__all__ = ["TOOLS"]

TOOLS: list[dict] = [
    # ─── Catalysis Analysis ───
    {
        "name": "catgo_catalysis_oer",
        "description": (
            "Compute OER (oxygen evolution) overpotential using CHE model. "
            "Input: adsorption Gibbs free energies (NOT raw DFT energies) "
            "\u0394G_OH, \u0394G_O, \u0394G_OOH in eV, computed from "
            "geo_opt \u2192 freq \u2192 gibbs_energy chain. "
            "Optionally specify pH for Nernst correction (-0.059*pH eV per "
            "proton-transfer step at 298 K). "
            "Returns overpotential, limiting step, and step energies."
        ),
        "endpoint": "__direct__/catalysis_oer",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "dG_OH": {
                    "type": "number",
                    "description": (
                        "\u0394G_OH in eV. Must be Gibbs free energy: "
                        "G(*OH) - G(*) - G(H2O) + 0.5*G(H2)"
                    ),
                },
                "dG_O": {
                    "type": "number",
                    "description": (
                        "\u0394G_O in eV. Must be Gibbs free energy: "
                        "G(*O) - G(*) - G(H2O) + G(H2)"
                    ),
                },
                "dG_OOH": {
                    "type": "number",
                    "description": (
                        "\u0394G_OOH in eV. Must be Gibbs free energy: "
                        "G(*OOH) - G(*) - 2*G(H2O) + 1.5*G(H2)"
                    ),
                },
                "pH": {
                    "type": "number",
                    "description": (
                        "Solution pH for Nernst correction. Each proton-transfer "
                        "step is shifted by -0.059*pH eV at 298 K. Default: 0"
                    ),
                },
            },
            "required": ["dG_OH", "dG_O", "dG_OOH"],
        },
    },
    {
        "name": "catgo_catalysis_free_energy",
        "description": "Compute Gibbs free energy: G = E_DFT + ZPE - TS. Input DFT energy (eV) and vibrational frequencies (cm\u207b\u00b9).",
        "endpoint": "__direct__/catalysis_free_energy",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "e_dft": {"type": "number", "description": "DFT total energy in eV"},
                "frequencies_cm": {"type": "array", "items": {"type": "number"}, "description": "Frequencies in cm\u207b\u00b9"},
                "temperature": {"type": "number", "description": "Temperature in K (default 298.15)"},
            },
            "required": ["e_dft"],
        },
    },
    {
        "name": "catgo_catalysis_volcano",
        "description": "Generate volcano plot data for catalyst screening. Input list of catalyst results with descriptors.",
        "endpoint": "__direct__/catalysis_volcano",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "results": {"type": "array", "description": "List of {name, dG_OH, overpotential, ...}"},
                "reaction": {"type": "string", "enum": ["OER", "HER", "CO2RR", "NRR"], "description": "Reaction type"},
                "descriptor_x": {"type": "string", "description": "X-axis descriptor key (default dG_OH)"},
            },
            "required": ["results"],
        },
    },
    {
        "name": "catgo_cn_coupling_network",
        "description": (
            "Generate C-N coupling reaction network for electrocatalysis on metal surfaces. "
            "Enumerates all possible C-N coupling pairs from C-species (CO2, COOH, CO, CHO, CH2O) "
            "and N-species (NO2, NO, NOH, NHOH, HNO, N, NH, NH2), filters by chemical feasibility, "
            "and provides ICONST/INCREM templates for VASP slow-growth AIMD simulations. "
            "Returns coupling paths with product formula, coupling type, distance ranges, and VASP constraints."
        ),
        "endpoint": "__direct__/cn_coupling_network",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "c_species": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "C-species list, e.g. ['CO', 'CHO']. Default: all 5 (CO2, COOH, CO, CHO, CH2O)",
                },
                "n_species": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "N-species list, e.g. ['NH2', 'NO']. Default: all 8 (NO2, NO, NOH, NHOH, HNO, N, NH, NH2)",
                },
                "include_infeasible": {
                    "type": "boolean",
                    "description": "Include infeasible paths in output (default false)",
                },
            },
        },
    },
    {
        "name": "catgo_kmc_simulate",
        "description": (
            "Run KMC (kinetic Monte Carlo) or mean-field microkinetic simulation for surface catalysis. "
            "Input: JSON model with species, rate expressions, and lattice definition. "
            "Supports single-point simulation, potential scan, and temperature scan. "
            "Returns coverages, turnover frequencies (TOF), and trajectory data."
        ),
        "endpoint": "kmc/simulate",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "model": {
                    "type": "object",
                    "description": "KMC model JSON with meta, species, parameters, processes, lattice",
                },
                "temperature": {"type": "number", "description": "Temperature in K (default 300)"},
                "potential": {"type": "number", "description": "Potential in V vs RHE (default 0)"},
                "lattice_size": {"type": "integer", "description": "2D lattice side length (default 20)"},
                "steps": {"type": "integer", "description": "KMC steps (default 100000)"},
            },
            "required": ["model"],
        },
    },
    {
        "name": "catgo_kmc_scan",
        "description": (
            "Run KMC/MKM potential or temperature scan. Sweeps across a range of potentials or temperatures "
            "and collects TOF and coverage at each point. Returns scan results for plotting activity vs conditions."
        ),
        "endpoint": "kmc/scan-potential",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "model": {
                    "type": "object",
                    "description": "KMC model JSON with meta, species, parameters, processes, lattice",
                },
                "temperature": {"type": "number", "description": "Temperature in K (for potential scan)"},
                "u_min": {"type": "number", "description": "Start potential (V vs RHE)"},
                "u_max": {"type": "number", "description": "End potential (V vs RHE)"},
                "u_steps": {"type": "integer", "description": "Number of scan points (default 20)"},
                "method": {"type": "string", "enum": ["mkm", "kmc"], "description": "Solver: mkm (fast) or kmc"},
            },
            "required": ["model"],
        },
    },
    {
        "name": "catgo_catalysis_energy_diagram",
        "description": (
            "Generate Plotly-compatible energy diagram from reaction pathway data. "
            "Input: list of pathways, each with name, color, and steps (label + energy in eV). "
            "Transition-state steps must have is_ts: true. "
            "Returns traces, layout, and annotations for Plotly rendering."
        ),
        "endpoint": "__direct__/catalysis_energy_diagram",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "pathways": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Pathway display name"},
                            "color": {"type": "string", "description": "Line color (e.g. '#ff0000')"},
                            "steps": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label": {"type": "string"},
                                        "energy": {"type": "number", "description": "Energy in eV"},
                                        "is_ts": {"type": "boolean", "description": "True if transition state"},
                                    },
                                    "required": ["label", "energy"],
                                },
                                "description": "Ordered list of intermediates and transition states",
                            },
                        },
                        "required": ["steps"],
                    },
                    "description": "Reaction pathways to plot",
                },
                "config": {
                    "type": "object",
                    "description": "Optional overrides: base_spacing, hline_ratio, ts_spacing_ratio, vline_ratio, line_width, energy_format, height, y_label, x_label",
                },
            },
            "required": ["pathways"],
        },
    },
    {
        "name": "catgo_vasp_presets",
        "description": "Get VASP INCAR preset parameters for common calculation types: relax, static, slab_relax, freq, band, md.",
        "endpoint": "__direct__/vasp_presets",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "preset_name": {"type": "string", "enum": ["relax", "static", "slab_relax", "freq", "band", "md"]},
            },
            "required": ["preset_name"],
        },
    },
]
