"""Test LAMMPS polymer workflow endpoint with Kremer-Grest model."""

import requests
import json

API_BASE = "http://localhost:8000"


def create_test_structure():
    """Create a simple test structure (10 beads, 1 chain in reduced units)."""
    return {
        "sites": [
            {
                "species": [{"element": "C", "occu": 1}],
                "xyz": [i * 0.97, 0.0, 0.0]  # beads along x-axis
            }
            for i in range(10)
        ],
        "lattice": {
            "matrix": [
                [10.0, 0.0, 0.0],
                [0.0, 10.0, 0.0],
                [0.0, 0.0, 10.0]
            ]
        }
    }


def test_polymer_workflow():
    """Test the polymer workflow endpoint."""
    print("=" * 70)
    print("Testing Polymer Workflow Endpoint")
    print("=" * 70)

    # Create test structure
    structure = create_test_structure()

    # Test Kremer-Grest workflow
    print("\n1. Testing Kremer-Grest workflow...")
    response = requests.post(
        f"{API_BASE}/api/lammps/polymer/workflow",
        json={
            "structure": structure,
            "prefix": "kg_polymer",
            "workflow_mode": "polymer_kg",
            "pair_style": "lj/cut 2.5",
            "pair_coeff": "* * 1.0 1.0 2.5",
            "bond_style": "fene",
            "bond_coeff": "1 30.0 1.5 1.0 1.0",
            "temperature": 1.0,
            "pressure": 0.0,
            "timestep": 0.01,
            "gen_steps_nvt": 1000,
            "gen_steps_npt": 5000,
            "equil_steps": 10000,
            "prod_steps": 20000,
            "prod_dump_freq": 500,
            "units": "lj",
            "atom_style": "molecular"
        }
    )

    if response.status_code == 200:
        result = response.json()
        print(f"   Success: {result['success']}")
        print(f"   Message: {result['message']}")
        print(f"   Stages: {len(result['stages'])}")
        for stage in result['stages']:
            print(f"     - {stage['name']}: {stage['ensemble']}, {stage['steps']} steps")

        # Show first few lines of input script
        print(f"\n   Input Script Preview:")
        lines = result['input_script'].split('\n')
        for line in lines[:20]:
            print(f"     {line}")
        print("     ...")

        # Save the input script for inspection
        with open('/tmp/kg_polymer.in', 'w') as f:
            f.write(result['input_script'])
        with open('/tmp/kg_polymer.data', 'w') as f:
            f.write(result['data_file'])
        print(f"\n   Files saved to /tmp/kg_polymer.in and /tmp/kg_polymer.data")

        return result
    else:
        print(f"   ERROR: {response.status_code}")
        print(f"   {response.text}")
        return None


def test_single_stage_workflow():
    """Test single stage workflow."""
    print("\n" + "=" * 70)
    print("Testing Single Stage Workflow")
    print("=" * 70)

    structure = create_test_structure()

    response = requests.post(
        f"{API_BASE}/api/lammps/polymer/workflow",
        json={
            "structure": structure,
            "prefix": "single_test",
            "workflow_mode": "single",
            "pair_style": "lj/cut 2.5",
            "pair_coeff": "* * 1.0 1.0",
            "bond_style": "none",
            "temperature": 300,
            "pressure": 1.0,
            "timestep": 0.001,
            "prod_steps": 5000,
            "prod_dump_freq": 100,
            "units": "metal",
            "atom_style": "atomic"
        }
    )

    if response.status_code == 200:
        result = response.json()
        print(f"   Success: {result['success']}")
        print(f"   Stages: {len(result['stages'])}")
        for stage in result['stages']:
            print(f"     - {stage['name']}: {stage['ensemble']}, {stage['steps']} steps")
        return result
    else:
        print(f"   ERROR: {response.status_code}")
        print(f"   {response.text}")
        return None


def test_lj_units_fene():
    """Test LJ units with FENE bonds (Kremer-Grest model)."""
    print("\n" + "=" * 70)
    print("Testing Kremer-Grest Model (LJ units + FENE)")
    print("=" * 70)

    # Create a 20-bead chain
    structure = {
        "sites": [
            {
                "species": [{"element": "C", "occu": 1}],
                "xyz": [
                    i * 0.97,  # x
                    0.0,      # y
                    0.0       # z
                ]
            }
            for i in range(20)
        ],
        "lattice": {
            "matrix": [
                [20.0, 0.0, 0.0],
                [0.0, 20.0, 0.0],
                [0.0, 0.0, 20.0]
            ]
        }
    }

    response = requests.post(
        f"{API_BASE}/api/lammps/polymer/workflow",
        json={
            "structure": structure,
            "prefix": "kremer_grest_20bead",
            "workflow_mode": "polymer_kg",
            "pair_style": "lj/cut 2.5",
            "pair_coeff": "* * 1.0 1.0 2.5",
            "bond_style": "fene",
            "bond_coeff": "1 30.0 1.5 1.0 1.0",
            "temperature": 1.0,
            "pressure": 0.0,
            "timestep": 0.005,
            "gen_steps_nvt": 5000,
            "gen_steps_npt": 20000,
            "equil_steps": 50000,
            "prod_steps": 50000,
            "prod_dump_freq": 1000,
            "units": "lj",
            "atom_style": "molecular"
        }
    )

    if response.status_code == 200:
        result = response.json()
        print(f"   Generated Kremer-Grest workflow for 20-bead chain")
        print(f"   Stages: {len(result['stages'])}")
        for stage in result['stages']:
            print(f"     - {stage['name']}: {stage['steps']} steps")

        # Count total steps
        total_steps = sum(s['steps'] for s in result['stages'])
        print(f"   Total steps: {total_steps}")

        # Show FENE bond section
        lines = result['input_script'].split('\n')
        print(f"\n   Force Field Section:")
        for i, line in enumerate(lines):
            if 'bond_style' in line or 'bond_coeff' in line or 'pair_style' in line:
                print(f"     {line}")

        # Save files
        with open('/tmp/kremer_grest.in', 'w') as f:
            f.write(result['input_script'])
        with open('/tmp/kremer_grest.data', 'w') as f:
            f.write(result['data_file'])
        print(f"\n   Files saved to /tmp/kremer_grest.in and /tmp/kremer_grest.data")

        return result
    else:
        print(f"   ERROR: {response.status_code}")
        print(f"   {response.text}")
        return None


def run_simulation_with_workflow():
    """Run actual LAMMPS simulation with generated workflow."""
    print("\n" + "=" * 70)
    print("Running LAMMPS Simulation (if lmp_serial available)")
    print("=" * 70)

    import subprocess
    import os

    # Check if LAMMPS is available
    try:
        result = subprocess.run(['which', 'lmp_serial'], capture_output=True, text=True)
        if result.returncode != 0:
            print("   lmp_serial not found, skipping simulation")
            return None
        print(f"   Found LAMMPS: {result.stdout.strip()}")
    except Exception as e:
        print(f"   Error checking LAMMPS: {e}")
        return None

    # Read the generated input files
    try:
        with open('/tmp/kremer_grest.in', 'r') as f:
            input_script = f.read()
        with open('/tmp/kremer_grest.data', 'r') as f:
            data_file = f.read()
    except FileNotFoundError:
        print("   Run test_lj_units_fene() first to generate input files")
        return None

    # Run LAMMPS
    print("\n   Running LAMMPS (this may take a minute)...")
    response = requests.post(
        f"{API_BASE}/api/lammps/run",
        json={
            "input_script": input_script,
            "data_file": data_file,
            "execution_mode": "local",
            "lmp_command": "lmp_serial"
        }
    )

    if response.status_code == 200:
        job_data = response.json()
        job_id = job_data['job_id']
        print(f"   Job ID: {job_id}")

        # Poll for completion (simplified)
        import time
        for _ in range(60):  # Wait up to 2 minutes
            status_resp = requests.get(f"{API_BASE}/api/lammps/status/{job_id}")
            if status_resp.status_code == 200:
                status = status_resp.json()['status']
                if status in ('completed', 'failed'):
                    break
            time.sleep(2)

        # Get results
        results_resp = requests.get(f"{API_BASE}/api/lammps/results/{job_id}")
        if results_resp.status_code == 200:
            results = results_resp.json()
            print(f"   Status: {results['status']}")
            print(f"   Success: {results['success']}")
            if results['thermo_data']:
                print(f"   Thermo points: {len(results['thermo_data'])}")
            return results
    else:
        print(f"   ERROR: {response.status_code}")

    return None


if __name__ == "__main__":
    print("\n" + "=" * 70)
    print("LAMMPS Polymer Workflow Tests")
    print("=" * 70)

    # Run tests
    test_single_stage_workflow()
    test_polymer_workflow()
    test_lj_units_fene()

    # Optionally run actual simulation
    print("\n" + "=" * 70)
    print("Run actual simulation? (This requires LAMMPS)")
    print("The generated files are in /tmp/kremer_grest.in and /tmp/kremer_grest.data")
    print("You can run manually: lmp_serial -in /tmp/kremer_grest.in")
    print("=" * 70)
