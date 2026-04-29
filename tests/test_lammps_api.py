"""Test script for LAMMPS API endpoints.

This is a standalone test script, not designed for pytest auto-discovery.
Run directly:  python tests/test_lammps_api.py
"""

import asyncio
import time

import pytest

# Skip entire module when collected by pytest — this is a standalone script
pytestmark = pytest.mark.skip(reason="Standalone LAMMPS API test script, not a pytest module")

import requests

API_BASE = "http://localhost:8000"

# Simple LAMMPS input for testing - 2D Lennard-Jones system
LAMMPS_INPUT = """# LAMMPS input for simple LJ system test

units           metal
atom_style      atomic
boundary        p p p

# Read structure
read_data       system.data

# Pair potential
pair_style      lj/cut 2.5
pair_coeff      * * 1.0 1.0

# Neighbor settings
neighbor        2.0 bin
neigh_modify    every 1 delay 0 check yes

# Thermodynamic output
thermo_style    custom step temp pe ke etotal press vol
thermo          100

# Velocity initialization
velocity        all create 300.0 12345

# NVT ensemble
fix             1 all nvt temp 300.0 300.0 0.1

# Trajectory output
dump            1 all custom 100 system.dump id type x y z
dump_modify     1 sort id

# Run
timestep        0.001
run             1000

# Write final configuration
write_data      final.data
"""

# Simple data file for 8 Argon atoms in a cubic box
LAMMPS_DATA = """# LAMMPS data file for simple LJ test

8 atoms
1 atom types

0.0 20.0 xlo xhi
0.0 20.0 ylo yhi
0.0 20.0 zlo zhi

Masses

1 39.948

Atoms

1 1 5.0 5.0 5.0
2 1 10.0 5.0 5.0
3 1 15.0 5.0 5.0
4 1 5.0 10.0 5.0
5 1 10.0 10.0 5.0
6 1 15.0 10.0 5.0
7 1 5.0 15.0 5.0
8 1 10.0 15.0 5.0
"""


def test_lammps_run_local():
    """Test running LAMMPS locally."""
    print("=" * 60)
    print("Test 1: Run LAMMPS locally")
    print("=" * 60)

    response = requests.post(
        f"{API_BASE}/api/api/lammps/run",
        json={
            "input_script": LAMMPS_INPUT,
            "data_file": LAMMPS_DATA,
            "execution_mode": "local",
            "lmp_command": "lmp_serial",  # or "lmp_mpi"
        }
    )

    print(f"Status Code: {response.status_code}")
    if response.status_code == 200:
        data = response.json()
        print(f"Job ID: {data['job_id']}")
        print(f"Status: {data['status']}")
        print(f"Message: {data['message']}")
        return data['job_id']
    else:
        print(f"Error: {response.text}")
        return None


def test_lammps_status(job_id: str):
    """Test checking LAMMPS job status."""
    print("\n" + "=" * 60)
    print(f"Test 2: Check job status for {job_id}")
    print("=" * 60)

    response = requests.get(f"{API_BASE}/api/lammps/status/{job_id}")
    print(f"Status Code: {response.status_code}")

    if response.status_code == 200:
        data = response.json()
        print(f"Job ID: {data['job_id']}")
        print(f"Status: {data['status']}")
        print(f"Message: {data.get('message', '')}")
        print(f"Started: {data.get('started_at', 'N/A')}")
        return data['status']
    else:
        print(f"Error: {response.text}")
        return None


def wait_for_completion(job_id: str, timeout: int = 60):
    """Wait for LAMMPS job to complete."""
    print("\n" + "=" * 60)
    print(f"Waiting for job {job_id} to complete...")
    print("=" * 60)

    start_time = time.time()
    last_status = None

    while time.time() - start_time < timeout:
        response = requests.get(f"{API_BASE}/api/lammps/status/{job_id}")
        if response.status_code == 200:
            data = response.json()
            status = data['status']

            if status != last_status:
                print(f"[{time.time() - start_time:.1f}s] Status: {status}")
                last_status = status

            if status in ('completed', 'failed', 'cancelled'):
                print(f"\nJob finished with status: {status}")
                return status
        else:
            print(f"Error checking status: {response.text}")
            break

        time.sleep(2)

    print("Timeout waiting for job")
    return None


def test_lammps_results(job_id: str):
    """Test getting LAMMPS results."""
    print("\n" + "=" * 60)
    print(f"Test 3: Get results for {job_id}")
    print("=" * 60)

    response = requests.get(f"{API_BASE}/api/lammps/results/{job_id}")
    print(f"Status Code: {response.status_code}")

    if response.status_code == 200:
        data = response.json()
        print(f"Job ID: {data['job_id']}")
        print(f"Status: {data['status']}")
        print(f"Success: {data['success']}")
        print(f"Message: {data.get('message', '')}")

        # Thermodynamic data
        if data['thermo_data']:
            print(f"\nThermodynamic data points: {len(data['thermo_data'])}")
            print("First 5 points:")
            for i, point in enumerate(data['thermo_data'][:5]):
                print(f"  Step {point['step']}: T={point.get('temp', 'N/A'):.2f}K, "
                      f"PE={point.get('pe', 'N/A'):.4f}eV, "
                      f"P={point.get('press', 'N/A'):.2f}atm")
            if len(data['thermo_data']) > 5:
                last = data['thermo_data'][-1]
                print(f"  ...\n  Last: Step {last['step']}: T={last.get('temp', 'N/A'):.2f}K, "
                      f"PE={last.get('pe', 'N/A'):.4f}eV")

        # Output files
        if data['output_files']:
            print(f"\nOutput files: {', '.join(data['output_files'])}")

        # Log file preview
        if data.get('log_file'):
            log_lines = data['log_file'].split('\n')
            print(f"\nLog file preview ({len(log_lines)} lines):")
            print("  " + "\n  ".join(log_lines[:10]))
            if len(log_lines) > 10:
                print(f"  ... ({len(log_lines) - 10} more lines)")

        # Error output
        if data.get('error_output'):
            print(f"\nError output:\n{data['error_output'][:500]}")

        return data
    else:
        print(f"Error: {response.text}")
        return None


def test_list_jobs():
    """Test listing all LAMMPS jobs."""
    print("\n" + "=" * 60)
    print("Test 4: List all LAMMPS jobs")
    print("=" * 60)

    response = requests.get(f"{API_BASE}/api/lammps/jobs")
    print(f"Status Code: {response.status_code}")

    if response.status_code == 200:
        data = response.json()
        print(f"Total jobs: {len(data['jobs'])}")
        for job in data['jobs']:
            print(f"  - {job['job_id']}: {job['status']} ({job['execution_mode']})")
        return data['jobs']
    else:
        print(f"Error: {response.text}")
        return None


def main():
    """Run all tests."""
    print("LAMMPS API Test Suite")
    print("=" * 60)

    # Check if LAMMPS is available
    print("\nChecking LAMMPS installation...")
    import subprocess
    try:
        result = subprocess.run(['which', 'lmp_serial'], capture_output=True, text=True)
        if result.returncode == 0:
            print(f"  LAMMPS found: {result.stdout.strip()}")
        else:
            print("  WARNING: lmp_serial not found. Trying lmp_mpi...")
            result = subprocess.run(['which', 'lmp_mpi'], capture_output=True, text=True)
            if result.returncode == 0:
                print(f"  LAMMPS found: {result.stdout.strip()}")
            else:
                print("  WARNING: LAMMPS not found! Tests will fail.")
                print("  Install LAMMPS or update lmp_command in the test.")
    except Exception as e:
        print(f"  Error checking LAMMPS: {e}")

    # Test 1: Submit job
    job_id = test_lammps_run_local()

    if job_id:
        # Test 2: Check status immediately
        test_lammps_status(job_id)

        # Wait for completion
        final_status = wait_for_completion(job_id, timeout=120)

        if final_status:
            # Test 3: Get results
            test_lammps_results(job_id)

        # Test 4: List all jobs
        test_list_jobs()
    else:
        print("\nFailed to submit job. Skipping remaining tests.")

    print("\n" + "=" * 60)
    print("Test suite complete!")
    print("=" * 60)


if __name__ == "__main__":
    main()
