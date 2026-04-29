#!/usr/bin/env python3
"""Simple test script to generate VASP input files."""

import requests
import json

# Server URL
BASE_URL = "http://localhost:8000"

def test_vasp_generation():
    """Test VASP input file generation."""

    # Example structure: Silicon diamond structure
    structure_data = {
        "lattice": {
            "matrix": [
                [0.0, 2.715, 2.715],
                [2.715, 0.0, 2.715],
                [2.715, 2.715, 0.0]
            ],
            "a": 3.84,
            "b": 3.84,
            "c": 3.84,
            "alpha": 60.0,
            "beta": 60.0,
            "gamma": 60.0,
            "volume": 45.0,
            "pbc": [True, True, True]
        },
        "sites": [
            {
                "species": [{"element": "Si", "occu": 1.0}],
                "abc": [0.0, 0.0, 0.0],
                "xyz": [0.0, 0.0, 0.0]
            },
            {
                "species": [{"element": "Si", "occu": 1.0}],
                "abc": [0.25, 0.25, 0.25],
                "xyz": [1.3575, 1.3575, 1.3575]
            }
        ]
    }

    # Test different calculation types
    calc_types = ["scf", "opt", "dos"]

    print("=" * 60)
    print("VASP Input File Generation Test")
    print("=" * 60)
    print()

    # Check server health
    try:
        response = requests.get(f"{BASE_URL}/health")
        print(f"✅ Server health: {response.json()}")
    except Exception as e:
        print(f"❌ Cannot connect to server: {e}")
        print("Make sure the server is running: python main.py")
        return

    print()

    # List calculation types
    try:
        response = requests.get(f"{BASE_URL}/api/vasp/calculation-types")
        types = response.json()
        print("Available calculation types:")
        for calc_type, info in types["calculation_types"].items():
            print(f"  - {calc_type}: {info['description']}")
    except Exception as e:
        print(f"❌ Error getting calculation types: {e}")
        return

    print()
    print("-" * 60)
    print()

    # Generate VASP inputs for each calculation type
    for calc_type in calc_types:
        print(f"Generating {calc_type.upper()} calculation inputs...")

        request_data = {
            "structure": structure_data,
            "calculation_type": calc_type,
            "encut": 520.0,
        }

        # Add calculation-specific parameters
        if calc_type == "opt":
            request_data["nsw"] = 100
            request_data["isif"] = 3
        elif calc_type == "dos":
            request_data["nbands"] = 20

        try:
            response = requests.post(
                f"{BASE_URL}/api/vasp/generate",
                json=request_data
            )
            response.raise_for_status()
            result = response.json()

            print(f"✅ Successfully generated {calc_type.upper()} inputs")
            print(f"   Calculation type: {result['calculation_type']}")
            print(f"   Elements: {', '.join(result['potcar_info']['elements'])}")
            print()
            print("   INCAR preview (first 5 lines):")
            incar_lines = result["incar"].split("\n")[:5]
            for line in incar_lines:
                print(f"   {line}")
            print()
            print("   POSCAR preview (first 8 lines):")
            poscar_lines = result["poscar"].split("\n")[:8]
            for line in poscar_lines:
                print(f"   {line}")
            print()
            print("   KPOINTS preview:")
            kpoints_lines = result["kpoints"].split("\n")[:6]
            for line in kpoints_lines:
                print(f"   {line}")
            print()

            # Optionally save to files
            save_files = input(f"Save {calc_type.upper()} files to disk? (y/n): ").lower() == 'y'
            if save_files:
                with open(f"INCAR_{calc_type}", "w") as f:
                    f.write(result["incar"])
                with open(f"POSCAR_{calc_type}", "w") as f:
                    f.write(result["poscar"])
                with open(f"KPOINTS_{calc_type}", "w") as f:
                    f.write(result["kpoints"])
                print(f"   ✅ Saved INCAR_{calc_type}, POSCAR_{calc_type}, KPOINTS_{calc_type}")

        except requests.exceptions.HTTPError as e:
            print(f"❌ HTTP Error: {e}")
            if e.response.status_code == 500:
                print(f"   Response: {e.response.text}")
        except Exception as e:
            print(f"❌ Error: {e}")

        print()
        print("-" * 60)
        print()

if __name__ == "__main__":
    test_vasp_generation()
