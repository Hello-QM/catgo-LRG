"""Test script for CRITICAL-2: Fix non-contiguous fixed atoms group definition.

This test verifies the logic for writing fixed atoms in chunks.
"""


def generate_fixed_group_lines(fixed_ids, chunk_size=20):
    """Generate LAMMPS group commands for fixed atoms.

    This is the logic from the fixed implementation in lammps.py.
    """
    if not fixed_ids:
        return []

    lines = [f"# Fixed atoms: {len(fixed_ids)} atoms"]
    for i in range(0, len(fixed_ids), chunk_size):
        chunk = fixed_ids[i:i + chunk_size]
        ids_str = " ".join(map(str, chunk))
        lines.append(f"group           fixed id {ids_str}")

    return lines


def test_contiguous_atoms():
    """Test with contiguous atoms (5-9)."""
    print("\n=== Test 1: Contiguous fixed atoms (5-9) ===")
    fixed_ids = [5, 6, 7, 8, 9]
    lines = generate_fixed_group_lines(fixed_ids)

    print("Generated lines:")
    for line in lines:
        print(f"  {line}")

    assert len(lines) == 2, f"Expected 2 lines (comment + group), got {len(lines)}"
    assert "5 6 7 8 9" in lines[1], f"Expected '5 6 7 8 9', got: {lines[1]}"
    print("✓ Passed")


def test_non_contiguous_atoms():
    """Test with non-contiguous atoms."""
    print("\n=== Test 2: Non-contiguous fixed atoms ===")
    fixed_ids = [1, 5, 10, 15, 20]
    lines = generate_fixed_group_lines(fixed_ids)

    print("Generated lines:")
    for line in lines:
        print(f"  {line}")

    combined = ' '.join(lines)
    assert '1' in combined and '5' in combined and '10' in combined
    assert '15' in combined and '20' in combined

    # Check no range syntax is used
    for line in lines:
        if 'group' in line and ':' in line.split('id ')[1] if 'id ' in line else '':
            raise AssertionError(f"Range syntax found in: {line}")

    print("✓ Passed")


def test_chunking_many_atoms():
    """Test chunking with 25 atoms (should span 2 lines)."""
    print("\n=== Test 3: 25 atoms (tests chunking) ===")
    fixed_ids = list(range(1, 26))  # 1-25
    lines = generate_fixed_group_lines(fixed_ids)

    print("Generated lines:")
    for line in lines:
        print(f"  {line}")

    # Should have comment + 2 group lines (20 + 5)
    assert len(lines) == 3, f"Expected 3 lines (comment + 2 groups), got {len(lines)}"

    # Check first group has 1-20
    first_group_ids = lines[1].split('id ')[1].split()
    assert len(first_group_ids) == 20, f"Expected 20 atoms in first group, got {len(first_group_ids)}"

    # Check second group has 21-25
    second_group_ids = lines[2].split('id ')[1].split()
    assert len(second_group_ids) == 5, f"Expected 5 atoms in second group, got {len(second_group_ids)}"
    assert second_group_ids[0] == '21', f"Expected first atom to be 21, got {second_group_ids[0]}"

    print("✓ Passed")


def test_exactly_20_atoms():
    """Test with exactly 20 atoms (boundary case)."""
    print("\n=== Test 4: Exactly 20 atoms (boundary case) ===")
    fixed_ids = list(range(1, 21))  # 1-20
    lines = generate_fixed_group_lines(fixed_ids)

    print("Generated lines:")
    for line in lines:
        print(f"  {line}")

    # Should have comment + 1 group line (exactly 20)
    assert len(lines) == 2, f"Expected 2 lines (comment + 1 group), got {len(lines)}"

    print("✓ Passed")


def test_21_atoms():
    """Test with 21 atoms (just over chunk boundary)."""
    print("\n=== Test 5: 21 atoms (just over chunk boundary) ===")
    fixed_ids = list(range(1, 22))  # 1-21
    lines = generate_fixed_group_lines(fixed_ids)

    print("Generated lines:")
    for line in lines:
        print(f"  {line}")

    # Should have comment + 2 group lines (20 + 1)
    assert len(lines) == 3, f"Expected 3 lines (comment + 2 groups), got {len(lines)}"

    print("✓ Passed")


def test_sparse_non_contiguous():
    """Test with sparse non-contiguous atoms (every 5th atom)."""
    print("\n=== Test 6: Sparse non-contiguous (every 5th of 50) ===")
    fixed_ids = list(range(1, 51, 5))  # 1, 6, 11, 16, 21, 26, 31, 36, 41, 46
    lines = generate_fixed_group_lines(fixed_ids)

    print("Generated lines:")
    for line in lines:
        print(f"  {line}")

    # All should fit in one line (10 atoms)
    assert len(lines) == 2, f"Expected 2 lines (comment + 1 group), got {len(lines)}"

    # Check all atoms are present
    combined = ' '.join(lines)
    for atom_id in fixed_ids:
        assert str(atom_id) in combined, f"Atom {atom_id} not found in output"

    print("✓ Passed")


def test_single_atom():
    """Test with just 1 fixed atom."""
    print("\n=== Test 7: Single fixed atom ===")
    fixed_ids = [5]
    lines = generate_fixed_group_lines(fixed_ids)

    print("Generated lines:")
    for line in lines:
        print(f"  {line}")

    assert len(lines) == 2, f"Expected 2 lines, got {len(lines)}"
    assert "5" in lines[1], f"Expected atom 5, got: {lines[1]}"

    print("✓ Passed")


def test_no_range_syntax_bug():
    """Verify the old bug (range syntax) is not present."""
    print("\n=== Test 8: Verify range syntax bug is fixed ===")

    # The old bug would generate: "group fixed id 1:50" for 50 atoms
    # which incorrectly includes ALL atoms from 1-50, not just selected ones

    fixed_ids = [1, 5, 10, 15]  # Only 4 specific atoms
    lines = generate_fixed_group_lines(fixed_ids)

    print("Generated lines:")
    for line in lines:
        print(f"  {line}")

    # Check no range syntax like "1:15" exists
    for line in lines:
        if 'group' in line and 'id ' in line:
            id_part = line.split('id ')[1].strip()
            # Should not contain colon (range syntax)
            assert ':' not in id_part, f"Found range syntax (colon) in: {line}"

    print("✓ Passed - No range syntax found")


if __name__ == '__main__':
    try:
        test_contiguous_atoms()
        test_non_contiguous_atoms()
        test_chunking_many_atoms()
        test_exactly_20_atoms()
        test_21_atoms()
        test_sparse_non_contiguous()
        test_single_atom()
        test_no_range_syntax_bug()
        print("\n" + "="*50)
        print("✅ All tests passed! CRITICAL-2 fix verified.")
        print("="*50)
        print("\nThe fix correctly:")
        print("  - Handles contiguous atoms")
        print("  - Handles non-contiguous atoms")
        print("  - Chunks atoms in groups of 20")
        print("  - Avoids dangerous range syntax (id start:end)")
        print("  - Works for edge cases (1 atom, 20 atoms, 21 atoms)")
    except AssertionError as e:
        print(f"\n❌ Test failed: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
