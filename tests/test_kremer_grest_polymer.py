"""Test LAMMPS API with Kremer-Grest bead-spring polymer model.

Reference: Kremer & Grest, J. Chem. Phys. 92, 5057 (1990)
https://aip.scitation.org/doi/10.1063/1.458541

Model:
- Bonded: FENE potential (k=30, R0=1.5)
- Non-bonded: LJ potential (sigma=1.0, epsilon=1.0, cutoff=2.5sigma)
- Polymer: 100 chains, 20 beads per chain (2000 atoms total)
"""

import time
import requests
import numpy as np

API_BASE = "http://localhost:8000"


def create_kremer_grest_system(
    n_chains: int = 10,
    beads_per_chain: int = 20,
    density: float = 0.85
) -> tuple[str, str]:
    """Create Kremer-Grest polymer system.

    Returns:
        (data_file_content, input_script_content)
    """
    # Box size calculation (reduced units)
    n_atoms = n_chains * beads_per_chain
    volume = n_atoms / density
    box_size = volume ** (1/3)

    # Generate random walk chains
    atoms = []
    atom_id = 1
    bonds = []

    for chain in range(n_chains):
        # Start position for this chain
        start_x = (chain % 3) * box_size / 3
        start_y = ((chain // 3) % 3) * box_size / 3
        start_z = (chain // 9) * box_size / 3 if n_chains > 9 else box_size / 2

        x, y, z = start_x, start_y, start_z

        for bead in range(beads_per_chain):
            atoms.append(f"{atom_id} 1 {x:.6f} {y:.6f} {z:.6f}")

            if bead > 0:
                bonds.append(f"{atom_id - 1} {atom_id}")

            # Random walk step
            if bead < beads_per_chain - 1:
                angle = np.random.uniform(0, 2 * np.pi)
                phi = np.random.uniform(0, np.pi)
                step = 0.97  # Slightly less than sigma to avoid overlap
                dx = step * np.sin(phi) * np.cos(angle)
                dy = step * np.sin(phi) * np.sin(angle)
                dz = step * np.cos(phi)
                x += dx
                y += dy
                z += dz

                # Wrap in box
                x = x % box_size
                y = y % box_size
                z = z % box_size

            atom_id += 1

    # Create LAMMPS data file
    data_file = f"""# Kremer-Grest Polymer Data File
# {n_chains} chains x {beads_per_chain} beads = {n_atoms} atoms

{n_atoms} atoms
1 atom types

{0.0:.6f} {box_size:.6f} xlo xhi
{0.0:.6f} {box_size:.6f} ylo yhi
{0.0:.6f} {box_size:.6f} zlo zhi

Masses

1 1.0

Atoms

{chr(10).join(atoms)}

Bonds

{len(bonds)} bonds
1 bond types

{chr(10).join([f"{i+1} 1 {b}" for i, b in enumerate(bonds)])}
"""

    # Create LAMMPS input script for Kremer-Grest model
    input_script = """# Kremer-Grest Bead-Spring Polymer Simulation
# LJ units: sigma=1, epsilon=1, mass=1

units           lj
atom_style      molecular
boundary        p p p

# Read structure
read_data       system.data

# Force field: FENE bonds + LJ pair potential
# FENE: k=30, R0=1.5
bond_style      fene
bond_coeff      1 30.0 1.5 1.0 1.0

# LJ potential with cutoff at 2.5sigma
# Shifted to zero at cutoff
pair_style      lj/cut 2.5
pair_coeff      1 1 1.0 1.0 2.5

# Neighbor settings
neighbor        0.3 bin
neigh_modify    every 1 delay 0 check yes

# Output settings
thermo          100
thermo_style    custom step temp pe ke etotal press vol density

# Initial velocity at T=1.0
velocity        all create 1.0 12345 dist gaussian

# Fix: NVT equilibration
fix             1 all nvt temp 1.0 1.0 0.1

# Dump trajectory
dump            1 all custom 1000 polymer.dump id type x y z

# ============ Generation Stage ============
# NVT for quick relaxation
run             5000

# ============ Equilibration Stage ============
# Switch to NPT for proper density
unfix           1
fix             1 all npt temp 1.0 1.0 0.1 iso 0.0 0.0 1.0
run             10000

# ============ Production Stage ============
# NVT production run
unfix           1
fix             1 all nvt temp 1.0 1.0 0.1
run             20000

# ============ Finalize ============
write_data      final.data
"""

    return data_file, input_script


def run_kremer_grest_simulation():
    """Run Kremer-Grest polymer simulation via LAMMPS API."""
    print("=" * 70)
    print("Kremer-Grest Polymer Simulation Test")
    print("=" * 70)

    # Create system
    print("\n1. Creating Kremer-Grest polymer system...")
    data_file, input_script = create_kremer_grest_system(
        n_chains=10,
        beads_per_chain=20,
        density=0.85
    )
    print(f"   - 10 chains × 20 beads = 200 atoms")
    print(f"   - FENE bonds + LJ pair potential")
    print(f"   - Reduced units (sigma=1, epsilon=1)")

    # Submit job
    print("\n2. Submitting LAMMPS job...")
    response = requests.post(
        f"{API_BASE}/api/lammps/run",
        json={
            "input_script": input_script,
            "data_file": data_file,
            "execution_mode": "local",
            "lmp_command": "lmp_serial"
        }
    )

    if response.status_code != 200:
        print(f"   ERROR: {response.status_code}")
        print(response.text)
        return None

    job_data = response.json()
    job_id = job_data['job_id']
    print(f"   ✓ Job ID: {job_id}")
    print(f"   Status: {job_data['status']}")

    # Poll for completion
    print("\n3. Monitoring job progress...")
    start_time = time.time()
    last_status = None

    while True:
        status_resp = requests.get(f"{API_BASE}/api/lammps/status/{job_id}")

        if status_resp.status_code == 200:
            status_data = status_resp.json()
            current_status = status_data['status']

            if current_status != last_status:
                elapsed = time.time() - start_time
                print(f"   [{elapsed:.1f}s] Status: {current_status}")
                last_status = current_status

            if current_status in ('completed', 'failed', 'cancelled'):
                break

        time.sleep(2)

        # Timeout after 5 minutes
        if time.time() - start_time > 300:
            print("   TIMEOUT: Job taking too long")
            break

    # Get results
    print("\n4. Retrieving results...")
    results_resp = requests.get(f"{API_BASE}/api/lammps/results/{job_id}")

    if results_resp.status_code == 200:
        results = results_resp.json()

        print(f"   Status: {results['status']}")
        print(f"   Success: {results['success']}")

        if results['thermo_data']:
            print(f"\n   Thermodynamic data points: {len(results['thermo_data'])}")
            print("\n   First 5 points:")
            for i, point in enumerate(results['thermo_data'][:5]):
                print(f"     Step {point['step']}: T={point.get('temp', 'N/A'):.3f}, "
                      f"PE={point.get('pe', 'N/A'):.3f}, "
                      f"Density={point.get('vol', 'N/A'):.3f}")

            if len(results['thermo_data']) > 5:
                last = results['thermo_data'][-1]
                print(f"\n   Last point:")
                print(f"     Step {last['step']}: T={last.get('temp', 'N/A'):.3f}, "
                      f"PE={last.get('pe', 'N/A'):.3f}, "
                      f"Press={last.get('press', 'N/A'):.3f}")

        if results['output_files']:
            print(f"\n   Output files: {', '.join(results['output_files'])}")

        if results.get('error_output'):
            print(f"\n   ERROR OUTPUT:\n{results['error_output'][:500]}")

        # Calculate some statistics
        if results['thermo_data']:
            temps = [p.get('temp', 0) for p in results['thermo_data'] if p.get('temp')]
            pes = [p.get('pe', 0) for p in results['thermo_data'] if p.get('pe')]
            densities = [p.get('vol', 0) for p in results['thermo_data'] if p.get('vol')]

            if temps:
                print("\n   Statistics:")
                print(f"     Temperature: {np.mean(temps):.3f} ± {np.std(temps):.3f}")
                print(f"     PE: {np.mean(pes):.3f} ± {np.std(pes):.3f}")
                if densities:
                    print(f"     Density: {np.mean(densities):.3f} ± {np.std(densities):.3f}")

        return results
    else:
        print(f"   ERROR getting results: {results_resp.status_code}")
        return None


def test_polymer_build_endpoint():
    """Test the polymer build endpoint."""
    print("\n" + "=" * 70)
    print("Testing Polymer Build Endpoint")
    print("=" * 70)

    # List available polymers
    print("\n1. Listing available polymer types...")
    response = requests.get(f"{API_BASE}/api/lammps/polymer/monomers")

    if response.status_code == 200:
        data = response.json()
        print("   Available polymers:")
        for name, info in data.get('monomers', {}).items():
            print(f"     - {name}: {info.get('repeat_unit', 'N/A')}")
        print("\n   Available force fields:")
        for name, info in data.get('force_fields', {}).items():
            print(f"     - {name}: {info.get('name', 'N/A')}")
    else:
        print(f"   ERROR: {response.status_code}")

    # Build a simple PE chain
    print("\n2. Building PE chain...")
    response = requests.post(
        f"{API_BASE}/api/lammps/polymer/build",
        json={
            "polymer_type": "PE",
            "chain_length": 50,
            "tacticity": "atactic",
            "force_field": "opls",
            "density": 0.85,
            "seed": 42
        }
    )

    if response.status_code == 200:
        result = response.json()
        print(f"   Success: {result['success']}")
        print(f"   Monomers: {result.get('n_monomers', 'N/A')}")
        print(f"   Chains: {result.get('n_chains', 'N/A')}")
        print(f"   Message: {result.get('message', 'N/A')}")
        if result.get('warnings'):
            print(f"   Warnings: {result['warnings']}")
    else:
        print(f"   ERROR: {response.status_code}")
        print(response.text)


if __name__ == "__main__":
    print("\n" + "=" * 70)
    print("LAMMPS Polymer Simulation Tests")
    print("=" * 70)

    # Check LAMMPS availability
    print("\nChecking LAMMPS installation...")
    import subprocess
    try:
        result = subprocess.run(['which', 'lmp_serial'], capture_output=True, text=True)
        if result.returncode == 0:
            print(f"   ✓ LAMMPS found: {result.stdout.strip()}")
        else:
            print("   WARNING: lmp_serial not found")
            print("   Tests will submit jobs but execution will fail")
    except Exception as e:
        print(f"   ERROR checking LAMMPS: {e}")

    # Test polymer build endpoint
    test_polymer_build_endpoint()

    # Run Kremer-Grest simulation
    print("\n" + "=" * 70)
    print("NOTE: Kremer-Grest simulation will take ~1-2 minutes")
    print("Press Ctrl+C to skip...")
    print("=" * 70)

    try:
        result = run_kremer_grest_simulation()

        if result and result.get('success'):
            print("\n" + "=" * 70)
            print("✓ Simulation completed successfully!")
            print("=" * 70)
        else:
            print("\n" + "=" * 70)
            print("✗ Simulation failed or LAMMPS not installed")
            print("=" * 70)
    except KeyboardInterrupt:
        print("\n\nTest skipped by user")
    except Exception as e:
        print(f"\n\nERROR: {e}")

    print("\n" + "=" * 70)
    print("Test complete!")
    print("=" * 70)
