"""Simple LAMMPS test to verify installation and basic functionality.

This is a manual/standalone test script, not designed for pytest auto-discovery.
Run directly:  python tests/test_lammps_simple.py
"""

import requests
import shutil
import subprocess
import time

import pytest

# Skip entire module when collected by pytest — this is a standalone script
pytestmark = pytest.mark.skip(reason="Standalone LAMMPS test script, not a pytest module")

API_BASE = "http://localhost:8000"

# Simple Lennard-Jones system (2 atoms)
LAMMPS_INPUT = """# Simple Lennard-Jones test
units           lj
atom_style      atomic
boundary        p p p

region          box block 0.0 5.0 0.0 5.0 0.0 5.0
create_box      1 box
create_atoms    1 single 1.0 1.0 1.0
create_atoms    1 single 3.0 3.0 3.0

mass            1 1.0

pair_style      lj/cut 2.5
pair_coeff      1 1 1.0 1.0

velocity        all create 1.0 12345
fix             1 all nvt temp 1.0 1.0 0.1

thermo          10
thermo_style    custom step temp pe ke etotal

dump            1 all custom 10 system.dump id type x y z

timestep        0.005
run             100

# Write restart file for continuation
write_restart   system.restart
"""

LAMMPS_DATA = """# Lennard-Jones test data
2 atoms
1 atom types

0.0 5.0 xlo xhi
0.0 5.0 ylo yhi
0.0 5.0 zlo zhi

Masses

1 1.0

Atoms

1 1 1.0 1.0 1.0
2 1 3.0 3.0 3.0
"""


def test_lammps_direct():
    """Test LAMMPS directly (bypassing API)."""
    print("=" * 60)
    print("Testing LAMMPS directly...")
    print("=" * 60)

    # Write input files
    import tempfile
    import os

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = os.path.join(tmpdir, "in.lj")
        data_path = os.path.join(tmpdir, "system.data")

        with open(input_path, 'w') as f:
            f.write(LAMMPS_INPUT)
        with open(data_path, 'w') as f:
            f.write(LAMMPS_DATA)

        print(f"Running LAMMPS in {tmpdir}...")

        result = subprocess.run(
            ['/opt/homebrew/bin/lmp_serial', '-in', input_path, '-log', 'none'],
            cwd=tmpdir,
            capture_output=True,
            text=True,
            timeout=30
        )

        print(f"Exit code: {result.returncode}")

        if result.returncode == 0:
            print("✓ LAMMPS ran successfully!")
            print("\nOutput:")
            print(result.stdout[:500])
        else:
            print("✗ LAMMPS failed")
            print("\nError output:")
            print(result.stdout[:500])
            print(result.stderr[:500])

        return result.returncode == 0


def test_lammps_via_api():
    """Test LAMMPS via the API."""
    print("\n" + "=" * 60)
    print("Testing LAMMPS via API...")
    print("=" * 60)

    # Wait for backend to be ready
    print("Waiting for backend...")
    for _ in range(10):
        try:
            resp = requests.get(f"{API_BASE}/api/lammps/jobs")
            if resp.status_code == 200:
                print("✓ Backend is ready")
                break
        except:
            pass
        time.sleep(1)
    else:
        print("✗ Backend not ready")
        return False

    # Submit job
    print("\nSubmitting LAMMPS job...")
    response = requests.post(
        f"{API_BASE}/api/lammps/run",
        json={
            "input_script": LAMMPS_INPUT,
            "data_file": LAMMPS_DATA,
            "execution_mode": "local",
            "lmp_command": "/opt/homebrew/bin/lmp_serial"
        }
    )

    if response.status_code != 200:
        print(f"✗ Job submission failed: {response.status_code}")
        print(response.text)
        return False

    job_data = response.json()
    job_id = job_data['job_id']
    print(f"✓ Job ID: {job_id}")

    # Poll for completion
    print("\nWaiting for job to complete...")
    start = time.time()
    while time.time() - start < 60:
        status_resp = requests.get(f"{API_BASE}/api/lammps/status/{job_id}")
        if status_resp.status_code == 200:
            status = status_resp.json()['status']
            print(f"  Status: {status}")
            if status in ('completed', 'failed'):
                break
        time.sleep(2)

    # Get results
    print("\nGetting results...")
    results_resp = requests.get(f"{API_BASE}/api/lammps/results/{job_id}")

    if results_resp.status_code == 200:
        results = results_resp.json()
        print(f"Status: {results['status']}")
        print(f"Success: {results['success']}")

        # Check for output files
        if results.get('output_files'):
            print(f"\nOutput files: {', '.join(results['output_files'])}")
        else:
            print("\nNo output files found")

        # Check for restart file
        if results.get('restart_filename'):
            size = results.get('restart_size', 0)
            print(f"✓ Restart file present: {results['restart_filename']} ({size} bytes)")
        else:
            print("✗ Restart file not found")

        if results['thermo_data']:
            print(f"\nThermodynamic data ({len(results['thermo_data'])} points):")
            for point in results['thermo_data'][:5]:
                temp = point.get('temp')
                pe = point.get('pe')
                temp_str = f"{temp:.3f}" if temp is not None else "N/A"
                pe_str = f"{pe:.3f}" if pe is not None else "N/A"
                print(f"  Step {point['step']}: T={temp_str}, PE={pe_str}")
            if len(results['thermo_data']) > 5:
                last = results['thermo_data'][-1]
                print(f"  ...")
                temp = last.get('temp')
                pe = last.get('pe')
                temp_str = f"{temp:.3f}" if temp is not None else "N/A"
                pe_str = f"{pe:.3f}" if pe is not None else "N/A"
                print(f"  Step {last['step']}: T={temp_str}, PE={pe_str}")

        return results['success'] and results.get('restart_filename') is not None
    else:
        print(f"✗ Error getting results: {results_resp.status_code}")
        return False


if __name__ == "__main__":
    print("LAMMPS Installation and Functionality Test")
    print("=" * 60)

    # Check LAMMPS installation
    try:
        result = subprocess.run(['/opt/homebrew/bin/lmp_serial', '-help'],
                               capture_output=True, text=True)
        print("✓ LAMMPS found at: /opt/homebrew/bin/lmp_serial")
    except FileNotFoundError:
        print("✗ LAMMPS not found")
        exit(1)

    # Test directly
    direct_ok = test_lammps_direct()

    # Test via API
    api_ok = test_lammps_via_api()

    print("\n" + "=" * 60)
    if direct_ok and api_ok:
        print("✓ All tests passed!")
    else:
        print("Some tests failed")
    print("=" * 60)
