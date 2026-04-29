#!/usr/bin/env python3
"""Comprehensive test for LAMMPS input file generation."""

import requests
import json

API_URL = "http://localhost:8000/api/lammps/input"

# Test 1: Simple FCC Copper
test_cu = {
    "structure": {
        "lattice": {
            "matrix": [[3.615, 0.0, 0.0], [0.0, 3.615, 0.0], [0.0, 0.0, 3.615]],
            "a": 3.615, "b": 3.615, "c": 3.615,
            "alpha": 90.0, "beta": 90.0, "gamma": 90.0
        },
        "sites": [
            {"abc": [0.0, 0.0, 0.0], "xyz": [0.0, 0.0, 0.0],
             "species": [{"element": "Cu", "occu": 1.0}]},
            {"abc": [0.5, 0.5, 0.5], "xyz": [1.8075, 1.8075, 1.8075],
             "species": [{"element": "Cu", "occu": 1.0}]},
            {"abc": [0.5, 0.0, 0.5], "xyz": [1.8075, 0.0, 1.8075],
             "species": [{"element": "Cu", "occu": 1.0}]},
            {"abc": [0.0, 0.5, 0.5], "xyz": [0.0, 1.8075, 1.8075],
             "species": [{"element": "Cu", "occu": 1.0}]}
        ]
    },
    "prefix": "cu_fcc",
    "units": "metal",
    "simulation_type": "minimize",
    "pair_style": "eam/alloy",
    "min_style": "cg"
}

# Test 2: NaCl (ionic)
test_nacl = {
    "structure": {
        "lattice": {
            "matrix": [[5.64, 0.0, 0.0], [0.0, 5.64, 0.0], [0.0, 0.0, 5.64]],
            "a": 5.64, "b": 5.64, "c": 5.64,
            "alpha": 90.0, "beta": 90.0, "gamma": 90.0
        },
        "sites": [
            {"abc": [0.0, 0.0, 0.0], "xyz": [0.0, 0.0, 0.0],
             "species": [{"element": "Na", "occu": 1.0}]},
            {"abc": [0.5, 0.5, 0.0], "xyz": [2.82, 2.82, 0.0],
             "species": [{"element": "Na", "occu": 1.0}]},
            {"abc": [0.5, 0.0, 0.5], "xyz": [2.82, 0.0, 2.82],
             "species": [{"element": "Na", "occu": 1.0}]},
            {"abc": [0.0, 0.5, 0.5], "xyz": [0.0, 2.82, 2.82],
             "species": [{"element": "Na", "occu": 1.0}]},
            {"abc": [0.5, 0.5, 0.5], "xyz": [2.82, 2.82, 2.82],
             "species": [{"element": "Cl", "occu": 1.0}]},
            {"abc": [0.0, 0.0, 0.5], "xyz": [0.0, 0.0, 2.82],
             "species": [{"element": "Cl", "occu": 1.0}]},
            {"abc": [0.0, 0.5, 0.0], "xyz": [0.0, 2.82, 0.0],
             "species": [{"element": "Cl", "occu": 1.0}]},
            {"abc": [0.5, 0.0, 0.0], "xyz": [2.82, 0.0, 0.0],
             "species": [{"element": "Cl", "occu": 1.0}]}
        ]
    },
    "prefix": "nacl_rock_salt",
    "units": "metal",
    "atom_style": "charge",
    "simulation_type": "nvt",
    "pair_style": "buck",
    "temperature": 300.0,
    "timestep": 0.001,
    "run_steps": 5000
}

# Test 3: Si slab with fixed atoms (surface science)
test_si_slab = {
    "structure": {
        "lattice": {
            "matrix": [[5.43, 0.0, 0.0], [0.0, 5.43, 0.0], [0.0, 0.0, 15.0]],
            "a": 5.43, "b": 5.43, "c": 15.0,
            "alpha": 90.0, "beta": 90.0, "gamma": 90.0
        },
        "sites": [
            # Bottom layer - fixed
            {"abc": [0.0, 0.0, 0.1], "xyz": [0.0, 0.0, 1.5],
             "species": [{"element": "Si", "occu": 1.0}],
             "properties": {"selective_dynamics": [False, False, False]}},
            {"abc": [0.5, 0.0, 0.1], "xyz": [2.715, 0.0, 1.5],
             "species": [{"element": "Si", "occu": 1.0}],
             "properties": {"selective_dynamics": [False, False, False]}},
            {"abc": [0.0, 0.5, 0.1], "xyz": [0.0, 2.715, 1.5],
             "species": [{"element": "Si", "occu": 1.0}],
             "properties": {"selective_dynamics": [False, False, False]}},
            {"abc": [0.5, 0.5, 0.1], "xyz": [2.715, 2.715, 1.5],
             "species": [{"element": "Si", "occu": 1.0}],
             "properties": {"selective_dynamics": [False, False, False]}},
            # Top layer - mobile
            {"abc": [0.25, 0.25, 0.2], "xyz": [1.3575, 1.3575, 3.0],
             "species": [{"element": "Si", "occu": 1.0}]},
            {"abc": [0.75, 0.25, 0.2], "xyz": [4.0725, 1.3575, 3.0],
             "species": [{"element": "Si", "occu": 1.0}]},
            {"abc": [0.25, 0.75, 0.2], "xyz": [1.3575, 4.0725, 3.0],
             "species": [{"element": "Si", "occu": 1.0}]},
            {"abc": [0.75, 0.75, 0.2], "xyz": [4.0725, 4.0725, 3.0],
             "species": [{"element": "Si", "occu": 1.0}]}
        ]
    },
    "prefix": "si_slab_111",
    "units": "metal",
    "simulation_type": "nvt",
    "pair_style": "tersoff",
    "temperature": 300.0,
    "timestep": 0.0005,
    "run_steps": 1000,
    "tdamp": 0.1
}

# Test 4: Ni-Al alloy (EAM)
test_nial = {
    "structure": {
        "lattice": {
            "matrix": [[3.52, 0.0, 0.0], [0.0, 3.52, 0.0], [0.0, 0.0, 3.52]],
            "a": 3.52, "b": 3.52, "c": 3.52,
            "alpha": 90.0, "beta": 90.0, "gamma": 90.0
        },
        "sites": [
            {"abc": [0.0, 0.0, 0.0], "xyz": [0.0, 0.0, 0.0],
             "species": [{"element": "Ni", "occu": 1.0}]},
            {"abc": [0.5, 0.5, 0.0], "xyz": [1.76, 1.76, 0.0],
             "species": [{"element": "Al", "occu": 1.0}]},
            {"abc": [0.5, 0.0, 0.5], "xyz": [1.76, 0.0, 1.76],
             "species": [{"element": "Ni", "occu": 1.0}]},
            {"abc": [0.0, 0.5, 0.5], "xyz": [0.0, 1.76, 1.76],
             "species": [{"element": "Al", "occu": 1.0}]}
        ]
    },
    "prefix": "ni3al",
    "units": "metal",
    "simulation_type": "minimize",
    "pair_style": "eam/alloy",
    "min_style": "cg"
}

def print_section(title):
    print(f"\n{'='*70}")
    print(f"  {title}")
    print(f"{'='*70}")

def run_test(name, test_data):
    print_section(name)

    # Print test parameters
    print(f"Parameters:")
    for key in ['prefix', 'units', 'simulation_type', 'pair_style']:
        if key in test_data:
            print(f"  {key}: {test_data[key]}")

    try:
        response = requests.post(API_URL, json=test_data, timeout=10)
        response.raise_for_status()
        result = response.json()

        if result.get('success'):
            print(f"\nResult: SUCCESS")
            print(f"  Atoms: {result['n_atoms']}")
            print(f"  Types: {result['n_types']}")
            print(f"  Elements: {', '.join(result['elements'])}")

            # Write output files
            prefix = test_data['prefix']
            with open(f"{prefix}.in", 'w') as f:
                f.write(result['input_script'])
            with open(f"{prefix}.data", 'w') as f:
                f.write(result['data_file'])

            print(f"\nGenerated files: {prefix}.in, {prefix}.data")

            # Show key parts of input script
            print(f"\nKey LAMMPS commands:")
            for line in result['input_script'].split('\n'):
                line = line.strip()
                if line and not line.startswith('#'):
                    print(f"  {line}")

        else:
            print(f"\nResult: FAILED - {result.get('message', 'Unknown error')}")
            return False

    except Exception as e:
        print(f"\nResult: ERROR - {e}")
        return False

    return True

# Run all tests
if __name__ == "__main__":
    print_section("LAMMPS Input File Generation - Test Suite")
    print("Testing API endpoint:", API_URL)

    tests = [
        ("Test 1: FCC Copper (Energy Minimization + EAM)", test_cu),
        ("Test 2: NaCl Rock Salt (NVT + Buckingham + Charges)", test_nacl),
        ("Test 3: Si Slab with Fixed Bottom Layer (NVT + Tersoff)", test_si_slab),
        ("Test 4: Ni3Al Alloy (EAM/Alloy)", test_nial),
    ]

    results = []
    for name, test_data in tests:
        results.append(run_test(name, test_data))

    print_section("Summary")
    print(f"Passed: {sum(results)}/{len(results)}")
    print("\nGenerated files can be used directly with LAMMPS:")
    print("  lammps -in <prefix>.in")
    print("\nNote: You need to provide appropriate potential files for pair_coeff")
