#!/usr/bin/env python3
"""Test script for LAMMPS input file generation API."""

import requests
import json

# NaCl structure in pymatgen format
nacl_structure = {
    "lattice": {
        "matrix": [
            [5.6903014761756712, 0.0, 0.0],
            [0.0, 5.6903014761756712, 0.0],
            [0.0, 0.0, 5.6903014761756712]
        ],
        "a": 5.6903014761756712,
        "b": 5.6903014761756712,
        "c": 5.6903014761756712,
        "alpha": 90.0,
        "beta": 90.0,
        "gamma": 90.0
    },
    "sites": [
        {"xyz": [0.0, 0.0, 0.0], "species": [{"element": "Na", "occu": 1.0}]},
        {"xyz": [0.0, 2.8456507380878356, 2.8456507380878356], "species": [{"element": "Na", "occu": 1.0}]},
        {"xyz": [2.8456507380878356, 0.0, 2.8456507380878356], "species": [{"element": "Na", "occu": 1.0}]},
        {"xyz": [2.8456507380878356, 2.8456507380878356, 0.0], "species": [{"element": "Na", "occu": 1.0}]},
        {"xyz": [2.8456507380878356, 2.8456507380878356, 2.8456507380878356], "species": [{"element": "Cl", "occu": 1.0}]},
        {"xyz": [2.8456507380878356, 0.0, 0.0], "species": [{"element": "Cl", "occu": 1.0}]},
        {"xyz": [0.0, 2.8456507380878356, 0.0], "species": [{"element": "Cl", "occu": 1.0}]},
        {"xyz": [0.0, 0.0, 2.8456507380878356], "species": [{"element": "Cl", "occu": 1.0}]}
    ]
}

# Silicon slab with selective dynamics (fixed atoms at bottom)
si_slab_structure = {
    "lattice": {
        "matrix": [
            [5.4689999999999999, 0.0, 0.0],
            [0.0, 5.4689999999999999, 0.0],
            [0.0, 0.0, 20.0000000000000000]
        ],
        "a": 5.4689999999999999,
        "b": 5.4689999999999999,
        "c": 20.0000000000000000,
        "alpha": 90.0,
        "beta": 90.0,
        "gamma": 90.0
    },
    "sites": [
        {
            "xyz": [0.0, 0.0, 2.0],
            "species": [{"element": "Si", "occu": 1.0}],
            "properties": {"selective_dynamics": [False, False, False]}
        },
        {
            "xyz": [2.7345, 0.0, 2.0],
            "species": [{"element": "Si", "occu": 1.0}],
            "properties": {"selective_dynamics": [False, False, False]}
        },
        {
            "xyz": [0.0, 2.7345, 2.0],
            "species": [{"element": "Si", "occu": 1.0}],
            "properties": {"selective_dynamics": [False, False, False]}
        },
        {
            "xyz": [2.7345, 2.7345, 2.0],
            "species": [{"element": "Si", "occu": 1.0}],
            "properties": {"selective_dynamics": [False, False, False]}
        },
        {
            "xyz": [1.36725, 1.36725, 3.0],
            "species": [{"element": "Si", "occu": 1.0}],
            "properties": {"selective_dynamics": [True, True, True]}
        },
        {
            "xyz": [4.10175, 1.36725, 3.0],
            "species": [{"element": "Si", "occu": 1.0}],
            "properties": {"selective_dynamics": [True, True, True]}
        },
        {
            "xyz": [1.36725, 4.10175, 3.0],
            "species": [{"element": "Si", "occu": 1.0}],
            "properties": {"selective_dynamics": [True, True, True]}
        },
        {
            "xyz": [4.10175, 4.10175, 3.0],
            "species": [{"element": "Si", "occu": 1.0}],
            "properties": {"selective_dynamics": [True, True, True]}
        }
    ]
}

def test_lammps_generation(structure, test_name, params=None):
    """Test LAMMPS input generation with the given structure."""
    print(f"\n{'='*60}")
    print(f"Test: {test_name}")
    print(f"{'='*60}")

    url = "http://localhost:8000/api/lammps/input"

    # Default parameters
    if params is None:
        params = {
            "prefix": "system",
            "units": "metal",
            "atom_style": "atomic",
            "boundary": "p p p",
            "simulation_type": "minimize",
            "pair_style": "lj/cut 10.0",
            "min_style": "cg",
            "etol": 1e-8,
            "ftol": 1e-8,
            "maxiter": 1000,
            "maxeval": 10000,
        }

    payload = {
        "structure": structure,
        **params
    }

    print(f"Request parameters:")
    for k, v in params.items():
        print(f"  {k}: {v}")

    try:
        response = requests.post(url, json=payload, timeout=10)
        response.raise_for_status()
        result = response.json()

        print(f"\nResponse: SUCCESS")
        print(f"  Elements: {result['elements']}")
        print(f"  Atoms: {result['n_atoms']}")
        print(f"  Types: {result['n_types']}")
        print(f"  Message: {result['message']}")

        print(f"\n--- Input Script ({params['prefix']}.in) ---")
        print(result['input_script'])

        print(f"\n--- Data File ({params['prefix']}.data) ---")
        print(result['data_file'])

        return result

    except Exception as e:
        print(f"\nResponse: ERROR - {e}")
        return None


# Run tests
if __name__ == "__main__":
    # Test 1: NaCl minimization
    test_lammps_generation(
        nacl_structure,
        "NaCl Energy Minimization",
        {
            "prefix": "nacl",
            "units": "metal",
            "simulation_type": "minimize",
            "pair_style": "lj/cut 10.0",
            "min_style": "cg"
        }
    )

    # Test 2: NaCl NVT MD
    test_lammps_generation(
        nacl_structure,
        "NaCl NVT Molecular Dynamics",
        {
            "prefix": "nacl_nvt",
            "units": "metal",
            "simulation_type": "nvt",
            "pair_style": "lj/cut 10.0",
            "temperature": 300.0,
            "timestep": 0.001,
            "run_steps": 1000
        }
    )

    # Test 3: Si slab with fixed atoms
    test_lammps_generation(
        si_slab_structure,
        "Si Slab with Fixed Atoms (Selective Dynamics)",
        {
            "prefix": "si_slab",
            "units": "metal",
            "simulation_type": "nvt",
            "pair_style": "tersoff",
            "temperature": 300.0,
            "timestep": 0.0005,
            "run_steps": 500
        }
    )

    # Test 4: Si slab with z-based fixing
    test_lammps_generation(
        si_slab_structure,
        "Si Slab with Z < 2.5 Fixed",
        {
            "prefix": "si_slab_zfix",
            "units": "metal",
            "simulation_type": "minimize",
            "pair_style": "tersoff",
            "fixed_z_below": 2.5
        }
    )

    print(f"\n{'='*60}")
    print("All tests completed!")
    print(f"{'='*60}")
