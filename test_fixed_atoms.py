"""Test script for CRITICAL-2: Fix non-contiguous fixed atoms group definition.

This test verifies that fixed atoms are correctly written to LAMMPS input
for both contiguous and non-contiguous selections.
"""

import sys
sys.path.insert(0, 'server')

from models.structure import PymatgenStructure, Lattice, Site, Species
import numpy as np

# Import the function directly to avoid ASE dependency
import importlib.util
spec = importlib.util.spec_from_file_location("lammps", "server/routers/lammps.py")
lammps_module = importlib.util.module_from_spec(spec)

# Mock the numpy import in lammps.py to avoid issues
sys.modules['numpy'] = np

spec.loader.exec_module(lammps_module)
generate_input_script = lammps_module.generate_input_script


def create_test_structure(n_atoms=20):
    """Create a simple test structure with n_atoms."""
    # Simple cubic lattice
    a = 5.0
    matrix = [[a, 0, 0], [0, a, 0], [0, 0, a]]
    lattice = Lattice(matrix=matrix)

    sites = []
    for i in range(n_atoms):
        x = (i % 4) * 1.25
        y = ((i // 4) % 4) * 1.25
        z = (i // 16) * 1.25
        sites.append(Site(
            species=[Species(element='Cu', occu=1.0)],
            abc=[x/a, y/a, z/a],
            xyz=[x, y, z]
        ))

    return PymatgenStructure(lattice=lattice, sites=sites)


class LammpsInputRequest:
    """Minimal request object for testing."""
    def __init__(self):
        self.structure = None
        self.prefix = "test"
        self.units = "metal"
        self.atom_style = "atomic"
        self.boundary = "p p p"
        self.simulation_type = "minimize"
        self.pair_style = "eam/alloy"
        self.pair_coeff = None
        self.potential_file = None
        self.min_style = "cg"
        self.etol = 1e-8
        self.ftol = 1e-8
        self.maxiter = 100
        self.maxeval = 1000
        self.timestep = 0.001
        self.temperature = 300.0
        self.pressure = 0.0
        self.run_steps = 1000
        self.tdamp = 0.1
        self.pdamp = 1.0
        self.thermo_freq = 100
        self.dump_freq = 1000
        self.dump_format = "custom"
        self.fixed_indices = None
        self.fixed_z_below = None


def test_contiguous_fixed_atoms():
    """Test with contiguous fixed atoms (e.g., atoms 5-9)."""
    print("\n=== Test 1: Contiguous fixed atoms ===")
    structure = create_test_structure(20)
    request = LammpsInputRequest()
    request.structure = structure
    request.fixed_indices = [4, 5, 6, 7, 8]  # Atoms 5-9 (1-indexed)

    info = {
        "cell": np.array(structure.lattice.matrix),
        "elements": ["Cu"] * 20,
        "unique_elements": ["Cu"],
        "element_to_type": {"Cu": 1},
        "atom_types": [1] * 20,
        "cart_coords": np.array([[i*1.25, 0, 0] for i in range(20)]),
        "charges": [0.0] * 20,
        "n_atoms": 20,
        "n_types": 1,
    }

    script = generate_input_script(request, info)
    lines = script.split('\n')

    # Check that fixed group is defined correctly
    fixed_lines = [l for l in lines if l.strip().startswith('group fixed')]
    print(f"Fixed group lines: {fixed_lines}")

    # Should have exactly one line with contiguous atoms
    assert len(fixed_lines) == 1, f"Expected 1 fixed group line, got {len(fixed_lines)}"
    assert '5 6 7 8 9' in fixed_lines[0], f"Expected '5 6 7 8 9', got: {fixed_lines[0]}"

    # Check that mobile group is defined
    mobile_lines = [l for l in lines if 'group mobile' in l]
    assert len(mobile_lines) == 1, "Mobile group not defined"

    print("✓ Contiguous fixed atoms test passed")


def test_non_contiguous_fixed_atoms():
    """Test with non-contiguous fixed atoms."""
    print("\n=== Test 2: Non-contiguous fixed atoms ===")
    structure = create_test_structure(20)
    request = LammpsInputRequest()
    request.structure = structure
    # Non-contiguous: atoms 1, 5, 10, 15, 20 (0-indexed: 0, 4, 9, 14, 19)
    request.fixed_indices = [0, 4, 9, 14, 19]

    info = {
        "cell": np.array(structure.lattice.matrix),
        "elements": ["Cu"] * 20,
        "unique_elements": ["Cu"],
        "element_to_type": {"Cu": 1},
        "atom_types": [1] * 20,
        "cart_coords": np.array([[i*1.25, 0, 0] for i in range(20)]),
        "charges": [0.0] * 20,
        "n_atoms": 20,
        "n_types": 1,
    }

    script = generate_input_script(request, info)
    lines = script.split('\n')

    # Check that fixed group is defined correctly
    fixed_lines = [l for l in lines if l.strip().startswith('group fixed')]
    print(f"Fixed group lines: {fixed_lines}")

    # Should have the exact atoms we specified (1-indexed: 1, 5, 10, 15, 20)
    combined = ' '.join(fixed_lines)
    assert '1' in combined and '5' in combined and '10' in combined, \
        f"Expected atoms 1, 5, 10 in: {combined}"
    assert '15' in combined and '20' in combined, \
        f"Expected atoms 15, 20 in: {combined}"

    # Should NOT contain range syntax that would include unintended atoms
    for line in fixed_lines:
        # Check for invalid range syntax
        if ':' in line:
            # If range is used, it should be a comment or valid chunk
            # But the old bug was: "group fixed id 1:20" which is wrong
            parts = line.split()
            for i, part in enumerate(parts):
                if ':' in part:
                    # This shouldn't happen with the fix
                    raise AssertionError(f"Found range syntax in fixed group: {line}")

    print("✓ Non-contiguous fixed atoms test passed")


def test_many_non_contiguous_fixed_atoms():
    """Test with many non-contiguous fixed atoms (>10, >20)."""
    print("\n=== Test 3: Many non-contiguous fixed atoms ===")
    structure = create_test_structure(50)
    request = LammpsInputRequest()
    request.structure = structure
    # Every 3rd atom: 0, 3, 6, 9, ... (about 17 atoms)
    request.fixed_indices = list(range(0, 50, 3))

    info = {
        "cell": np.array(structure.lattice.matrix),
        "elements": ["Cu"] * 50,
        "unique_elements": ["Cu"],
        "element_to_type": {"Cu": 1},
        "atom_types": [1] * 50,
        "cart_coords": np.array([[i*1.0, 0, 0] for i in range(50)]),
        "charges": [0.0] * 50,
        "n_atoms": 50,
        "n_types": 1,
    }

    script = generate_input_script(request, info)
    lines = script.split('\n')

    # Check that fixed group is defined correctly
    fixed_lines = [l for l in lines if l.strip().startswith('group fixed')]
    print(f"Number of fixed group lines: {len(fixed_lines)}")

    # Should be split into chunks of 20
    # 17 atoms should fit in 1 line
    assert len(fixed_lines) >= 1, "Should have at least one fixed group line"

    # All specified atoms should be present (1-indexed)
    combined = ' '.join(fixed_lines)
    for i in [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34, 37, 40, 43, 46, 49]:
        assert str(i) in combined, f"Expected atom {i} in fixed group"

    # No range syntax should be used
    for line in fixed_lines:
        if ':' in line and 'id' in line:
            # Check if it's a range definition like "id 1:20"
            if 'id ' in line and ':' in line.split('id ')[1].split()[0]:
                raise AssertionError(f"Found range syntax in fixed group: {line}")

    print("✓ Many non-contiguous fixed atoms test passed")


def test_chunking_with_25_atoms():
    """Test that chunking works correctly with exactly 25 atoms (needs 2 lines)."""
    print("\n=== Test 4: Chunking with 25 fixed atoms ===")
    structure = create_test_structure(30)
    request = LammpsInputRequest()
    request.structure = structure
    # First 25 atoms fixed
    request.fixed_indices = list(range(25))

    info = {
        "cell": np.array(structure.lattice.matrix),
        "elements": ["Cu"] * 30,
        "unique_elements": ["Cu"],
        "element_to_type": {"Cu": 1},
        "atom_types": [1] * 30,
        "cart_coords": np.array([[i*1.0, 0, 0] for i in range(30)]),
        "charges": [0.0] * 30,
        "n_atoms": 30,
        "n_types": 1,
    }

    script = generate_input_script(request, info)
    lines = script.split('\n')

    fixed_lines = [l for l in lines if l.strip().startswith('group fixed')]
    print(f"Number of fixed group lines: {len(fixed_lines)}")

    # With 25 atoms and chunk_size=20, should have 2 lines
    assert len(fixed_lines) == 2, f"Expected 2 lines for 25 atoms, got {len(fixed_lines)}"

    # First line should have atoms 1-20
    assert '1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20' in fixed_lines[0] or \
           ' 20' in fixed_lines[0], f"First line should end with atom 20: {fixed_lines[0]}"

    # Second line should have atoms 21-25
    assert '21 22 23 24 25' in fixed_lines[1], f"Second line should have 21-25: {fixed_lines[1]}"

    print("✓ Chunking test passed")


if __name__ == '__main__':
    try:
        test_contiguous_fixed_atoms()
        test_non_contiguous_fixed_atoms()
        test_many_non_contiguous_fixed_atoms()
        test_chunking_with_25_atoms()
        print("\n✅ All tests passed! CRITICAL-2 fix verified.")
    except AssertionError as e:
        print(f"\n❌ Test failed: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
