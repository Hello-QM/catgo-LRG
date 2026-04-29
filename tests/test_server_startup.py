"""Quick test: verify plugin system initializes correctly in catgo conda env."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "server"))

import asyncio
from plugins import plugin_manager


async def main():
    await plugin_manager.initialize()
    print(f"Plugins: {len(plugin_manager._plugins)}")
    print(f"Calculators: {list(plugin_manager._calculator_plugins.keys())}")
    print(f"Readers: {list(plugin_manager._reader_plugins.keys())}")
    print(f"Analyzers: {list(plugin_manager._analyzer_plugins.keys())}")
    print(f"Workflow Nodes: {list(plugin_manager._workflow_node_plugins.keys())}")

    # Quick smoke test: run bond-histogram with a real pymatgen structure
    if plugin_manager.has_analyzer("bond_histogram"):
        from pymatgen.core import Lattice, Structure

        lattice = Lattice.cubic(3.61)  # Cu FCC
        structure = Structure(lattice, ["Cu"], [[0, 0, 0]])
        struct_dict = structure.as_dict()

        analyzer = plugin_manager.get_analyzer("bond_histogram")
        result = await analyzer.analyze({
            "structure": struct_dict,
            "n_bins": 20,
            "max_distance": 4.0,
        })
        print(f"\nBond histogram result: {len(result.get('series', []))} series")
        if result.get("series"):
            s = result["series"][0]
            print(f"  Label: {s['label']}")
            print(f"  Bins: {len(s['x'])}")
            total_bonds = sum(s['y'])
            print(f"  Total bond count: {total_bonds}")
        print("\nBond histogram smoke test PASSED")
    else:
        print("\nWARNING: bond_histogram not available, skipping smoke test")


if __name__ == "__main__":
    asyncio.run(main())
