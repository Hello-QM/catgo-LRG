"""
Phase 3 API test: WorkflowNodePlugin endpoints.

This is a manual/standalone test script, not designed for pytest auto-discovery.
Run directly:  python tests/manual/test_phase3_api.py [--port 8000]

Prerequisites:
    1. Copy example plugin:  cp -r examples/plugins/lammps-workflow plugins/
    2. Start backend:        python server/main.py   (or pnpm desktop:serve)
"""

import argparse
import json
import sys
import urllib.request
import urllib.error

import pytest

# Skip entire module when collected by pytest
pytestmark = pytest.mark.skip(reason="Manual standalone test script, not a pytest module")


def test(label: str, url: str, expected_check):
    """Run a single test: GET url, check response with expected_check function."""
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            ok, detail = expected_check(data)
            status = "PASS" if ok else "FAIL"
            print(f"  [{status}] {label}")
            if not ok:
                print(f"         {detail}")
                print(f"         Response: {json.dumps(data, indent=2, ensure_ascii=False)[:500]}")
            return ok
    except urllib.error.URLError as e:
        print(f"  [FAIL] {label}")
        print(f"         Connection error: {e}")
        print(f"         Is the backend running on this port?")
        return False
    except Exception as e:
        print(f"  [FAIL] {label}")
        print(f"         Error: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Phase 3 API tests")
    parser.add_argument("--port", type=int, default=8000, help="Backend port (default: 8000)")
    args = parser.parse_args()

    base = f"http://localhost:{args.port}/api"
    print(f"\nPhase 3: WorkflowNodePlugin API Tests")
    print(f"Backend: {base}\n")

    results = []

    # Test 1: GET /plugins/ — plugin should appear in list
    print("1. Plugin discovery:")
    results.append(test(
        "GET /plugins/ contains lammps-nvt-plugin",
        f"{base}/plugins/",
        lambda d: (
            any(p.get("name") == "lammps-nvt-plugin" for p in d.get("plugins", [])),
            "Plugin 'lammps-nvt-plugin' not found in plugins list"
        )
    ))
    results.append(test(
        "Plugin type is 'workflow_node'",
        f"{base}/plugins/",
        lambda d: (
            any(
                p.get("name") == "lammps-nvt-plugin" and p.get("plugin_type") == "workflow_node"
                for p in d.get("plugins", [])
            ),
            "Plugin type is not 'workflow_node'"
        )
    ))

    # Test 2: GET /plugins/workflow-nodes — dedicated endpoint
    print("\n2. Workflow nodes endpoint:")
    results.append(test(
        "GET /plugins/workflow-nodes returns nodes array",
        f"{base}/plugins/workflow-nodes",
        lambda d: (
            isinstance(d.get("nodes"), list) and d.get("total", 0) >= 0,
            "Response missing 'nodes' array or 'total' field"
        )
    ))
    results.append(test(
        "At least 1 workflow node registered",
        f"{base}/plugins/workflow-nodes",
        lambda d: (
            d.get("total", 0) >= 1,
            f"Expected total >= 1, got {d.get('total', 0)}"
        )
    ))

    # Test 3: Node definition structure
    print("\n3. Node definition validation:")
    required_keys = {"type", "label", "color", "icon", "category", "description", "inputs", "outputs"}
    results.append(test(
        "Node definition has all required keys",
        f"{base}/plugins/workflow-nodes",
        lambda d: (
            len(d.get("nodes", [])) > 0
            and required_keys.issubset(set(d["nodes"][0].keys())),
            f"Missing keys: {required_keys - set(d.get('nodes', [{}])[0].keys()) if d.get('nodes') else 'no nodes'}"
        )
    ))
    results.append(test(
        "Node type is 'lammps_nvt_plugin'",
        f"{base}/plugins/workflow-nodes",
        lambda d: (
            any(n.get("type") == "lammps_nvt_plugin" for n in d.get("nodes", [])),
            "Node type 'lammps_nvt_plugin' not found"
        )
    ))
    results.append(test(
        "Node category is 'Plugin'",
        f"{base}/plugins/workflow-nodes",
        lambda d: (
            any(n.get("category") == "Plugin" for n in d.get("nodes", [])),
            "Node category should be 'Plugin'"
        )
    ))
    results.append(test(
        "Node has param_schema with 4 params",
        f"{base}/plugins/workflow-nodes",
        lambda d: (
            any(
                len(n.get("param_schema", [])) == 4
                for n in d.get("nodes", [])
                if n.get("type") == "lammps_nvt_plugin"
            ),
            "Expected 4 param_schema entries (timestep, temperature, steps, potential)"
        )
    ))

    # Test 4: Plugin info endpoint
    print("\n4. Individual plugin info:")
    results.append(test(
        "GET /plugins/lammps-nvt-plugin returns plugin info",
        f"{base}/plugins/lammps-nvt-plugin",
        lambda d: (
            d.get("name") == "lammps-nvt-plugin"
            and d.get("plugin_type") == "workflow_node"
            and d.get("enabled") is True,
            f"Unexpected plugin info: name={d.get('name')}, type={d.get('plugin_type')}, enabled={d.get('enabled')}"
        )
    ))
    results.append(test(
        "Plugin metadata includes node_type in extra",
        f"{base}/plugins/lammps-nvt-plugin",
        lambda d: (
            d.get("extra", {}).get("node_type") == "lammps_nvt_plugin",
            f"extra.node_type should be 'lammps_nvt_plugin', got: {d.get('extra', {}).get('node_type')}"
        )
    ))

    # Summary
    passed = sum(results)
    total = len(results)
    print(f"\n{'='*50}")
    print(f"Results: {passed}/{total} tests passed")
    if passed == total:
        print("ALL TESTS PASSED")
    else:
        print(f"{total - passed} test(s) FAILED")
    print(f"{'='*50}\n")

    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
