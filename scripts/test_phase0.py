"""
Phase 0 验证脚本 — 测试 Calculator 插件断路修复

用法:
    conda activate catgo
    cd server
    python ../scripts/test_phase0.py

测试内容:
    1. PluginManager 能否发现并注册 lennard-jones 插件
    2. get_calculator() 能否 fallback 到插件 calculator
    3. /api/optimize/calculators 是否包含插件 calculator
    4. /api/optimize/structure 能否用插件 calculator 优化结构

前置条件:
    - plugins/lennard-jones-calculator/ 目录存在
    - conda 环境有 ase 包
"""

import asyncio
import sys
from pathlib import Path

# 确保 server/ 在 sys.path 中
server_dir = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(server_dir))


def header(title: str):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")


async def test_1_plugin_discovery():
    """测试 1: PluginManager 发现 + 注册"""
    header("Test 1: Plugin Discovery & Registration")

    from plugins import plugin_manager

    await plugin_manager.initialize()

    # 检查插件是否被发现
    all_plugins = plugin_manager.get_all_plugins()
    plugin_names = [p.name for p in all_plugins]
    print(f"  Discovered plugins: {plugin_names}")

    # 检查 calculator 是否注册
    has_lj = plugin_manager.has_calculator("lennard_jones")
    print(f"  has_calculator('lennard_jones'): {has_lj}")

    if not has_lj:
        print("  FAIL: lennard_jones calculator not registered!")
        return False

    # 检查 calculator 信息
    info = plugin_manager.get_calculator_info("lennard_jones")
    print(f"  Calculator info: {info}")

    print("  PASS")
    return True


def test_2_get_calculator_fallback():
    """测试 2: get_calculator() 插件 fallback"""
    header("Test 2: get_calculator() Plugin Fallback")

    from calculators.base import get_calculator

    # 内置 calculator 应该正常工作
    try:
        emt_calc = get_calculator("emt")
        print(f"  get_calculator('emt'): {type(emt_calc).__name__} OK")
    except Exception as e:
        print(f"  get_calculator('emt'): FAIL - {e}")

    # 插件 calculator 应该通过 fallback 工作
    try:
        lj_calc = get_calculator("lennard_jones")
        print(f"  get_calculator('lennard_jones'): {type(lj_calc).__name__} OK")
    except Exception as e:
        print(f"  get_calculator('lennard_jones'): FAIL - {e}")
        return False

    # 不存在的 calculator 应该报错
    try:
        get_calculator("nonexistent_calc_xyz")
        print("  get_calculator('nonexistent'): FAIL - should have raised!")
        return False
    except Exception as e:
        print(f"  get_calculator('nonexistent'): correctly raised {type(e).__name__}")

    print("  PASS")
    return True


def test_3_lj_optimization():
    """测试 3: 用 LJ calculator 实际优化一个 Ar 团簇"""
    header("Test 3: LJ Calculator Optimization")

    from ase import Atoms
    from ase.optimize import BFGS
    from calculators.base import get_calculator
    import io

    # 创建一个 Ar 四面体 (略微扰动)
    atoms = Atoms(
        "Ar4",
        positions=[
            [0.0, 0.0, 0.0],
            [3.5, 0.0, 0.0],
            [1.75, 3.03, 0.0],
            [1.75, 1.01, 2.86],
        ],
    )

    lj = get_calculator("lennard_jones")
    atoms.calc = lj.get_ase_calculator()

    e_before = atoms.get_potential_energy()
    f_max_before = max(abs(atoms.get_forces()).max(axis=1))

    print(f"  Before optimization:")
    print(f"    Energy: {e_before:.4f} eV")
    print(f"    Max force: {f_max_before:.4f} eV/A")

    # 优化
    log = io.StringIO()
    opt = BFGS(atoms, logfile=log)
    opt.run(fmax=0.01, steps=50)

    e_after = atoms.get_potential_energy()
    f_max_after = max(abs(atoms.get_forces()).max(axis=1))

    print(f"  After optimization ({opt.nsteps} steps):")
    print(f"    Energy: {e_after:.4f} eV")
    print(f"    Max force: {f_max_after:.4f} eV/A")

    if e_after < e_before:
        print("  PASS (energy decreased)")
        return True
    else:
        print("  FAIL (energy did not decrease)")
        return False


def test_4_api_calculators_list():
    """测试 4: /api/optimize/calculators 端点逻辑"""
    header("Test 4: Calculator List API (offline)")

    from calculators.base import CalculatorType
    from plugins import plugin_manager

    # 模拟 list_calculators 的逻辑
    calculators = []

    # 内置 calculators
    for ct in CalculatorType:
        calculators.append({
            "id": ct.value,
            "name": ct.value.upper(),
            "is_plugin": False,
        })

    # 插件 calculators
    for calc_info in plugin_manager.get_all_calculators():
        calculators.append({
            "id": calc_info["id"],
            "name": calc_info["display_name"],
            "is_plugin": True,
        })

    print(f"  Total calculators: {len(calculators)}")
    for c in calculators:
        tag = " [PLUGIN]" if c["is_plugin"] else ""
        print(f"    - {c['id']}: {c['name']}{tag}")

    # 验证 lennard_jones 在列表中
    plugin_ids = [c["id"] for c in calculators if c["is_plugin"]]
    if "lennard_jones" in plugin_ids:
        print("  PASS (lennard_jones in calculator list)")
        return True
    else:
        print("  FAIL (lennard_jones not in calculator list)")
        return False


def test_5_request_validation():
    """测试 5: OptimizationRequest 接受任意 calculator 字符串"""
    header("Test 5: Request Validation (str instead of enum)")

    from models.structure import OptimizationRequest

    # 内置 calculator 名应该通过
    req1 = OptimizationRequest(
        structure={"lattice": {"matrix": [[3, 0, 0], [0, 3, 0], [0, 0, 3]]},
                   "sites": [{"species": [{"element": "Cu"}], "abc": [0, 0, 0]}]},
        calculator="emt",
    )
    print(f"  calculator='emt': {req1.calculator} OK")

    # 插件 calculator 名也应该通过 (Phase 0 的核心修复)
    req2 = OptimizationRequest(
        structure={"lattice": {"matrix": [[3, 0, 0], [0, 3, 0], [0, 0, 3]]},
                   "sites": [{"species": [{"element": "Ar"}], "abc": [0, 0, 0]}]},
        calculator="lennard_jones",
    )
    print(f"  calculator='lennard_jones': {req2.calculator} OK")

    # 任意字符串都应通过 (Pydantic 不再用枚举校验)
    req3 = OptimizationRequest(
        structure={"lattice": {"matrix": [[3, 0, 0], [0, 3, 0], [0, 0, 3]]},
                   "sites": [{"species": [{"element": "H"}], "abc": [0, 0, 0]}]},
        calculator="some_future_plugin",
    )
    print(f"  calculator='some_future_plugin': {req3.calculator} OK")

    print("  PASS")
    return True


async def main():
    print("Phase 0 Verification: Calculator Plugin Circuit Break Fix")
    print("=" * 60)

    results = {}

    # Test 1: Plugin discovery
    results["discovery"] = await test_1_plugin_discovery()

    # Test 2: get_calculator fallback
    results["fallback"] = test_2_get_calculator_fallback()

    # Test 3: Actual optimization
    try:
        results["optimization"] = test_3_lj_optimization()
    except Exception as e:
        print(f"  ERROR: {e}")
        results["optimization"] = False

    # Test 4: API calculator list
    results["api_list"] = test_4_api_calculators_list()

    # Test 5: Request validation
    try:
        results["validation"] = test_5_request_validation()
    except Exception as e:
        print(f"  ERROR: {e}")
        results["validation"] = False

    # Summary
    header("Summary")
    all_pass = True
    for name, passed in results.items():
        status = "PASS" if passed else "FAIL"
        print(f"  {name}: {status}")
        if not passed:
            all_pass = False

    print()
    if all_pass:
        print("  ALL TESTS PASSED! Phase 0 is working correctly.")
    else:
        print("  SOME TESTS FAILED. Check output above.")

    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
